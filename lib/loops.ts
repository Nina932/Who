/**
 * The Loops Engine.
 *
 * "It enables Thor to run semi-autonomous workflows (with a human review
 * stage), observe results, learn from feedback, and constantly refine its
 * approach."
 *
 * This is a real executor, not a diagram of one. A run walks its steps, calls
 * the model assigned to each, writes every artefact to disk, and *stops dead*
 * at a gate until a human says GO. After the outcome is recorded, the engine
 * derives learnings from what happened and injects them into the next run of
 * the same loop — which is the only thing that makes the word "loop" honest.
 *
 * The gate is the load-bearing part. Autonomy without a stopping rule is just
 * an unattended script.
 */

import { callRole, parseJson, type ModelRole } from "./models";
import { TOOLS, toolInstruction } from "./tools";
import { postToSlack } from "./connectors";
import { recall, renderForPrompt as renderMemory } from "./memory";
import { getProfile, renderForPrompt as renderStyle } from "./style";
import { id, mutate, readCollection } from "./store";

export type StepKind = "generate" | "gate" | "act" | "observe" | "tool";

export interface LoopStep {
  id: string;
  name: string;
  kind: StepKind;
  role: ModelRole;
  /** What this step asks the model to do. Receives prior artefacts. */
  instruction: string;
  /** For `tool` steps: the key in TOOLS this step executes. */
  tool?: string;
}

export interface LoopDefinition {
  id: string;
  name: string;
  objective: string;
  cadence: string;
  ownerAgentId: string;
  steps: LoopStep[];
}

export type RunStatus =
  | "running"
  | "awaiting-go"
  | "completed"
  | "rejected"
  | "failed";

export interface Artifact {
  stepId: string;
  stepName: string;
  text: string;
  model: string;
  live: boolean;
  at: number;
}

export interface LoopRun {
  id: string;
  loopId: string;
  status: RunStatus;
  stepIndex: number;
  artifacts: Artifact[];
  /** Feedback from the human at the gate. */
  note?: string;
  /** What actually happened after it shipped. */
  outcome?: string;
  startedAt: number;
  endedAt?: number;
  error?: string;
}

export interface Learning {
  id: string;
  loopId: string;
  text: string;
  fromRunId: string;
  at: number;
}

const RUNS = "loop-runs";
const LEARNINGS = "loop-learnings";

// ── Seeded loops ─────────────────────────────────────────────────────────
// The two Reznikov names explicitly: Weekly Business Review and the Content
// Engine, plus the inbound-lead loop the Social screen refers to.

export const LOOPS: LoopDefinition[] = [
  {
    id: "weekly-business-review",
    name: "Weekly Business Review",
    objective:
      "Every Monday, tell the operator the truth about last week and what to do about it this week.",
    cadence: "Mondays, 07:00",
    ownerAgentId: "chief-of-staff",
    steps: [
      {
        id: "gather",
        name: "Gather",
        kind: "generate",
        role: "quick",
        instruction:
          "List what you would need to review the business week: the specific metrics, decisions and open threads. Be concrete about what you do and do not have access to. Do not invent numbers.",
      },
      {
        id: "analyse",
        name: "Analyse",
        kind: "generate",
        role: "hard",
        instruction:
          "From the gathered material, write the review: what moved, what stalled, and what the operator is avoiding. Be direct. Flag anything you are inferring rather than observing.",
      },
      {
        id: "recommend",
        name: "Recommend",
        kind: "generate",
        role: "judgment",
        instruction:
          "Give at most three recommendations for the coming week, each with the reason and the cost of being wrong. Rank them. This is consequential judgment — say plainly if you lack the evidence to recommend anything.",
      },
      {
        id: "go",
        name: "Review",
        kind: "gate",
        role: "quick",
        instruction: "Hold for the operator's GO before anything is acted on.",
      },
      {
        id: "act",
        name: "Act",
        kind: "act",
        role: "quick",
        instruction:
          "Turn the approved recommendations into a concrete task list with owners and dates.",
      },
      {
        id: "log",
        name: "Log",
        kind: "tool",
        role: "quick",
        tool: "sheets.log",
        instruction:
          "Append this week's review to the running log so the numbers live somewhere they can be compared.",
      },
    ],
  },
  {
    id: "content-engine",
    name: "Content Engine",
    objective:
      "Three build-in-public posts a week, in the operator's own voice, published only on approval.",
    cadence: "Mondays, 07:00",
    ownerAgentId: "social",
    steps: [
      {
        id: "mine",
        name: "Mine",
        kind: "generate",
        role: "quick",
        instruction:
          "Propose 5 post angles drawn from what actually happened in the operator's work. Each angle in one line. No generic advice-post angles.",
      },
      {
        id: "draft",
        name: "Draft",
        kind: "generate",
        role: "hard",
        instruction:
          "Write the three strongest angles as finished posts in the operator's voice. Follow the learned style rules exactly. No hashtags unless the style says otherwise.",
      },
      {
        id: "go",
        name: "Review",
        kind: "gate",
        role: "quick",
        instruction: "Hold for the operator's GO. Nothing publishes without it.",
      },
      {
        id: "schedule",
        name: "Schedule",
        kind: "act",
        role: "quick",
        instruction:
          "Lay the approved posts across the week with an explicit publish date and time for each (include the year) and a one-line reason for the ordering.",
      },
      {
        id: "place",
        name: "Place on calendar",
        kind: "tool",
        role: "quick",
        tool: "calendar.schedule",
        instruction:
          "Put each scheduled post on the operator's calendar at its publish time.",
      },
    ],
  },
  {
    id: "inbound-to-pipeline",
    name: "Inbound to pipeline",
    objective:
      "Turn a DM that smells like work into a qualified lead with a next step.",
    cadence: "On arrival",
    ownerAgentId: "sales",
    steps: [
      {
        id: "qualify",
        name: "Qualify",
        kind: "generate",
        role: "quick",
        instruction:
          "Judge whether this inbound message is real work. State the signals for and against, then a verdict.",
      },
      {
        id: "reply",
        name: "Draft reply",
        kind: "generate",
        role: "hard",
        instruction:
          "Draft the reply in the operator's voice. One clear next step. No pitch.",
      },
      {
        id: "go",
        name: "Review",
        kind: "gate",
        role: "quick",
        instruction: "Hold for the operator's GO before anything is saved.",
      },
      {
        id: "draft",
        name: "Save draft",
        kind: "tool",
        role: "quick",
        tool: "gmail.draft",
        instruction:
          "Save the approved reply as a Gmail draft. It is never sent automatically.",
      },
    ],
  },
];

export const LOOPS_BY_ID: Record<string, LoopDefinition> = Object.fromEntries(
  LOOPS.map((l) => [l.id, l]),
);

// ── State ────────────────────────────────────────────────────────────────

export async function allRuns(): Promise<LoopRun[]> {
  return readCollection<LoopRun[]>(RUNS, []);
}

export async function getRun(runId: string): Promise<LoopRun | undefined> {
  return (await allRuns()).find((r) => r.id === runId);
}

export async function allLearnings(loopId?: string): Promise<Learning[]> {
  const learnings = await readCollection<Learning[]>(LEARNINGS, []);
  return loopId ? learnings.filter((l) => l.loopId === loopId) : learnings;
}

async function patchRun(runId: string, patch: Partial<LoopRun>): Promise<LoopRun | null> {
  return mutate<LoopRun[], LoopRun | null>(RUNS, [], (current) => {
    let updated: LoopRun | null = null;
    const next = current.map((run) => {
      if (run.id !== runId) return run;
      updated = { ...run, ...patch };
      return updated;
    });
    return { next, result: updated };
  });
}

// ── Execution ────────────────────────────────────────────────────────────

/**
 * The context a step is executed with: the loop's objective, everything
 * produced earlier in this run, what Thor remembers, the operator's voice, and
 * — critically — what previous runs of this loop learned.
 */
async function buildSystemPrompt(
  loop: LoopDefinition,
  run: LoopRun,
  step: LoopStep,
): Promise<string> {
  const learnings = await allLearnings(loop.id);
  const memory = await recall(`${loop.objective} ${step.instruction}`, 6);
  const style = await getProfile();

  const sections = [
    `You are executing one step of "${loop.name}", a standing loop inside Thor — an autonomous AI co-founder running a solo operator's business.`,
    `Loop objective: ${loop.objective}`,
    `Current step: ${step.name} — ${step.instruction}`,
    "",
    "Rules:",
    "- Produce the step's output and nothing else. No preamble, no sign-off.",
    "- Never invent facts, metrics, names or dates. If you need something you do not have, say so explicitly.",
    "- Anything beyond this step's scope is not yours to do.",
  ];

  const memoryBlock = renderMemory(memory);
  if (memoryBlock) sections.push("", memoryBlock);

  const styleBlock = renderStyle(style);
  if (styleBlock) sections.push("", styleBlock);

  if (learnings.length > 0) {
    sections.push(
      "",
      "What previous runs of this loop learned. These are corrections — apply them:",
      ...learnings.slice(-8).map((l) => `- ${l.text}`),
    );
  }

  if (run.note) {
    sections.push("", `The operator's feedback at the last gate: "${run.note}"`);
  }

  return sections.join("\n");
}

function priorWork(run: LoopRun): string {
  if (run.artifacts.length === 0) return "This is the first step. Begin.";
  return run.artifacts
    .map((a) => `### ${a.stepName}\n${a.text}`)
    .join("\n\n");
}

export async function startRun(loopId: string, input?: string): Promise<LoopRun> {
  const loop = LOOPS_BY_ID[loopId];
  if (!loop) throw new Error(`Unknown loop: ${loopId}`);

  const run: LoopRun = {
    id: id("run"),
    loopId,
    status: "running",
    stepIndex: 0,
    artifacts: input
      ? [
          {
            stepId: "input",
            stepName: "Input",
            text: input,
            model: "operator",
            live: true,
            at: Date.now(),
          },
        ]
      : [],
    startedAt: Date.now(),
  };

  await mutate<LoopRun[], null>(RUNS, [], (current) => ({
    next: [run, ...current].slice(0, 200),
    result: null,
  }));

  return advance(run.id);
}

/**
 * Run steps until the loop hits a gate, finishes, or fails.
 *
 * A gate does not "pause politely" — it sets `awaiting-go` and returns. Nothing
 * downstream of a gate can execute until `approve` is called.
 */
/** A human's "no" — and a finished run — cannot be walked back by `advance`. */
const TERMINAL: RunStatus[] = ["completed", "rejected"];

export async function advance(runId: string): Promise<LoopRun> {
  let run = await getRun(runId);
  if (!run) throw new Error(`Unknown run: ${runId}`);

  // Without this guard, POSTing `advance` on a rejected run resumed it at the
  // gate — an operator's rejection could be undone by a stray call.
  if (TERMINAL.includes(run.status)) return run;

  const loop = LOOPS_BY_ID[run.loopId];
  if (!loop) throw new Error(`Unknown loop: ${run.loopId}`);

  while (run.stepIndex < loop.steps.length) {
    const step = loop.steps[run.stepIndex];

    if (step.kind === "gate") {
      const updated = await patchRun(runId, { status: "awaiting-go" });
      // A gate nobody knows about is just a stall. Fire-and-forget: a chat
      // outage must never hold up the engine or fail the run.
      void notifyGate(loop, updated ?? run).catch((error) =>
        console.error("loops: gate notification failed", error),
      );
      return updated ?? run;
    }

    // ── Tool steps ─────────────────────────────────────────────────────
    // Two beats: the model turns the approved work into structured arguments,
    // then those arguments are validated and executed against a real
    // connector. The model never calls the API itself.
    if (step.kind === "tool") {
      const tool = step.tool ? TOOLS[step.tool] : undefined;
      if (!tool) {
        const failed = await patchRun(runId, {
          status: "failed",
          error: `Step "${step.name}" names an unknown tool: ${step.tool}`,
          endedAt: Date.now(),
        });
        return failed ?? run;
      }

      const args = await callRole(step.role, {
        system: toolInstruction(tool),
        messages: [{ role: "user", content: priorWork(run) }],
        json: true,
      });

      if (!args.live) {
        const failed = await patchRun(runId, {
          status: "failed",
          error: args.error ?? "Model unavailable",
          endedAt: Date.now(),
        });
        return failed ?? run;
      }

      const parsed = parseJson<unknown>(args.text) ?? {};
      const outcome = await tool.run(parsed);

      const artifact: Artifact = {
        stepId: step.id,
        stepName: step.name,
        text: outcome.summary,
        model: `${args.spec.label} → ${tool.name}`,
        live: outcome.ok,
        at: Date.now(),
      };

      // A tool that could not act does not fail the run — the work upstream
      // is still valid and the artefact records exactly what went wrong.
      const updatedRun = await patchRun(runId, {
        artifacts: [...run.artifacts, artifact],
        stepIndex: run.stepIndex + 1,
      });
      if (!updatedRun) break;
      run = updatedRun;
      continue;
    }

    const system = await buildSystemPrompt(loop, run, step);
    const result = await callRole(step.role, {
      system,
      messages: [{ role: "user", content: priorWork(run) }],
    });

    if (!result.live) {
      const updated = await patchRun(runId, {
        status: "failed",
        error: result.error ?? "Model unavailable",
        endedAt: Date.now(),
      });
      return updated ?? run;
    }

    const artifact: Artifact = {
      stepId: step.id,
      stepName: step.name,
      text: result.text,
      model: result.spec.label,
      live: result.live,
      at: Date.now(),
    };

    const updated = await patchRun(runId, {
      artifacts: [...run.artifacts, artifact],
      stepIndex: run.stepIndex + 1,
    });
    if (!updated) break;
    run = updated;
  }

  const finished = await patchRun(runId, { status: "completed", endedAt: Date.now() });
  return finished ?? run;
}

/**
 * Tell the operator a loop is holding.
 *
 * This is the whole reason a Chat connector earns its place: semi-autonomous
 * work is only useful if you find out it needs you without going to look.
 */
async function notifyGate(loop: LoopDefinition, run: LoopRun): Promise<void> {
  const base = process.env.THOR_BASE_URL ?? "http://localhost:3000";
  const preview = run.artifacts.at(-1)?.text.slice(0, 280) ?? "";

  const message = [
    `*${loop.name}* is holding at its review gate.`,
    run.artifacts.length
      ? `Produced ${run.artifacts.length} step${run.artifacts.length === 1 ? "" : "s"}. Last one:`
      : "",
    preview ? `> ${preview.replace(/\n/g, "\n> ")}` : "",
    `Approve or reject: ${base}/loops`,
  ]
    .filter(Boolean)
    .join("\n");

  const result = await postToSlack(message);
  // Not connected is the normal case, not an error worth shouting about.
  if (!result.ok && !result.needsConnection) {
    console.error("loops: gate notification rejected —", result.error);
  }
}

/** The human GO. Records the note as feedback and resumes past the gate. */
export async function approve(runId: string, note?: string): Promise<LoopRun> {
  const run = await getRun(runId);
  if (!run) throw new Error(`Unknown run: ${runId}`);
  if (run.status !== "awaiting-go") return run;

  await patchRun(runId, {
    status: "running",
    stepIndex: run.stepIndex + 1,
    note: note?.trim() || undefined,
  });
  return advance(runId);
}

/**
 * Rejection is more valuable than approval — it is the only signal that says
 * what *not* to do, so the note is turned into a learning immediately.
 */
export async function reject(runId: string, note: string): Promise<LoopRun> {
  const run = await getRun(runId);
  if (!run) throw new Error(`Unknown run: ${runId}`);

  const updated = await patchRun(runId, {
    status: "rejected",
    note,
    endedAt: Date.now(),
  });

  if (note.trim()) {
    await deriveLearnings(runId, `The operator rejected this at the gate, saying: "${note}"`);
  }

  return updated ?? run;
}

/** Record what actually happened after the work shipped, then learn from it. */
export async function observe(runId: string, outcome: string): Promise<Learning[]> {
  await patchRun(runId, { outcome });
  return deriveLearnings(runId, `Observed outcome: ${outcome}`);
}

const LEARN_SYSTEM = `You extract lessons from one execution of a recurring workflow, so the next execution goes better.

You are given the workflow's objective, what it produced, and what happened afterwards (the operator's rejection note, or the observed outcome).

Return ONLY a JSON array of at most 3 short imperative rules for future runs. Each rule must be specific enough to change the next output.

Good: "Lead the review with the metric that moved, not with a summary." "Do not propose posts about tooling — they were rejected twice."
Bad: "Do better." "Be more helpful." Anything not supported by what you were given.

Return [] if there is no transferable lesson.`;

async function deriveLearnings(runId: string, signal: string): Promise<Learning[]> {
  const run = await getRun(runId);
  if (!run) return [];
  const loop = LOOPS_BY_ID[run.loopId];
  if (!loop) return [];

  const result = await callRole("judgment", {
    system: LEARN_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          `WORKFLOW: ${loop.name}`,
          `OBJECTIVE: ${loop.objective}`,
          "",
          "WHAT IT PRODUCED:",
          run.artifacts.map((a) => `### ${a.stepName}\n${a.text}`).join("\n\n"),
          "",
          `WHAT HAPPENED: ${signal}`,
        ].join("\n"),
      },
    ],
    json: true,
  });

  if (!result.live || !result.text) return [];

  const parsed = parseJson<string[]>(result.text);
  if (!Array.isArray(parsed) || parsed.length === 0) return [];

  const learnings: Learning[] = parsed
    .filter((t) => typeof t === "string" && t.trim().length > 5)
    .slice(0, 3)
    .map((text) => ({
      id: id("learn"),
      loopId: loop.id,
      text: text.trim(),
      fromRunId: runId,
      at: Date.now(),
    }));

  if (learnings.length === 0) return [];

  return mutate<Learning[], Learning[]>(LEARNINGS, [], (current) => ({
    next: [...current, ...learnings],
    result: learnings,
  }));
}
