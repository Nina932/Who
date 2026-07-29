/**
 * The conversational modes.
 *
 * Six framings, one truth system. The whole point is that they cannot
 * disagree: each mode is a different *selection* over the same derived state,
 * never a different source of it. A "Strategic Advisor" that reasons from its
 * own impression of the business rather than from the same facts the Daily
 * Operator reads is two assistants, and one of them is wrong.
 *
 * So a mode is exactly two things: which slice of truth it is handed, and what
 * it is forbidden from doing with it. There is no per-mode knowledge.
 *
 * The context is assembled here, deterministically, and is worth reading on
 * its own — with no API key the answer is the assembled context plus an honest
 * statement that nothing phrased it. That degrades to *less fluent*, not to
 * *made up*.
 */

import type { Brief } from "./brief";
import { KIND_PLURAL, isStale, type Entry, type Kind } from "./knowledge";
import type { ProductView } from "./products";
import type { Classified } from "./signals";

export type ModeId =
  | "daily-operator"
  | "chief-of-staff"
  | "technical-intelligence"
  | "market-intelligence"
  | "weekly-review"
  | "strategic-advisor";

export interface Mode {
  id: ModeId;
  name: string;
  /** The question this mode exists to answer, in the operator's words. */
  question: string;
  /** What it may not do. Enforced in the prompt, and stated in the UI. */
  refuses: string;
}

export const MODES: Mode[] = [
  {
    id: "daily-operator",
    name: "Daily Operator",
    question: "What should I do today?",
    refuses: "Will not discuss strategy or the market. Today only.",
  },
  {
    id: "chief-of-staff",
    name: "Product Chief of Staff",
    question: "Where are my products, what changed, and what is blocked?",
    refuses: "Will not schedule your day or recommend which product to back.",
  },
  {
    id: "technical-intelligence",
    name: "Technical Intelligence",
    question: "What happened in AI and infrastructure that touches my stack?",
    refuses: "Will not report developments that touch nothing you have.",
  },
  {
    id: "market-intelligence",
    name: "Market Intelligence",
    question: "What is in demand, and what is becoming commoditised?",
    refuses: "Will not report trends without relating them to a product of yours.",
  },
  {
    id: "weekly-review",
    name: "Weekly Review",
    question: "What moved, what stalled, and what should I change?",
    refuses: "Will not congratulate you on activity that moved no phase.",
  },
  {
    id: "strategic-advisor",
    name: "Strategic Advisor",
    question: "Which product or initiative deserves my capacity?",
    refuses: "Will not recommend anything it cannot evidence.",
  },
];

export const MODES_BY_ID: Record<ModeId, Mode> = Object.fromEntries(
  MODES.map((m) => [m.id, m]),
) as Record<ModeId, Mode>;

// ── Context assembly ─────────────────────────────────────────────────────

export interface TruthInput {
  brief: Brief;
  products: ProductView[];
  entries: Entry[];
  alerts: Classified[];
  digest: Classified[];
  now: number;
}

function knowledgeBlock(entries: Entry[], now: number, kinds: Kind[]): string {
  const sections = kinds
    .map((kind) => {
      const rows = entries.filter((e) => e.kind === kind && !isStale(e, now));
      if (rows.length === 0) return "";
      return [
        `${KIND_PLURAL[kind].toUpperCase()}:`,
        ...rows.map((e) => `- [${e.id}] ${e.text} (${e.provenance}, ${e.subject})`),
      ].join("\n");
    })
    .filter(Boolean);
  return sections.join("\n\n");
}

function productBlock(products: ProductView[]): string {
  return products
    .filter((p) => p.active)
    .map((p) =>
      [
        `${p.name} — ${p.phase}, ${Math.round(p.phaseDays)} days in phase`,
        `  objective: ${p.objective}`,
        `  working: ${p.working.map((c) => c.name).join(", ") || "nothing recorded"}`,
        `  blocked: ${p.openBlockers.map((b) => `${b.name} (${Math.round((Date.now() - b.openedAt) / 86_400_000)}d${b.release ? ", blocks release" : ""})`).join("; ") || "nothing open"}`,
        `  milestone: ${p.milestone.name} — ${p.metConditions}/${p.totalConditions} conditions evidenced`,
      ].join("\n"),
    )
    .join("\n\n");
}

function signalBlock(rows: Classified[]): string {
  if (rows.length === 0) return "";
  return rows
    .map((r) => `- [${r.verdict}] ${r.signal.headline}\n  because: ${r.because}\n  source: ${r.signal.source}`)
    .join("\n");
}

/**
 * The slice of truth a mode is handed.
 *
 * Narrow on purpose. Handing every mode everything is how a "Daily Operator"
 * starts opining on market positioning — and the moment it does, the operator
 * stops being able to predict what any mode will say, which is the whole
 * value of having modes.
 */
export function contextFor(mode: ModeId, input: TruthInput): string {
  const { brief, products, entries, alerts, digest, now } = input;

  const today = [
    `CAPACITY: ${brief.capacity.realisticHours}h realistic of ${brief.capacity.plannedHours}h planned. ${brief.capacity.note}`,
    "",
    "TODAY, already derived and ordered:",
    ...brief.items.map(
      (i, n) => `${n + 1}. ${i.title} (${i.minutes}m) — ${i.matters} ${i.now}`,
    ),
    brief.deferred.length
      ? `\nMOVED OUT OF TODAY:\n${brief.deferred.map((d) => `- ${d.title}: ${d.reason}`).join("\n")}`
      : "",
    brief.avoided.length
      ? `\nAVOIDED (appeared in 3+ consecutive briefs):\n${brief.avoided.map((i) => `- ${i.title}`).join("\n")}`
      : "",
    brief.focus ? `\nFOCUS: ${brief.focus.note}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const advice = brief.advisories
    .map(
      (a) =>
        `- [${a.rule}, ${a.confidence}] ${a.recommendation}\n  reason: ${a.reason}\n  trade-off: ${a.tradeOff}\n  changes if: ${a.wouldChangeIf}`,
    )
    .join("\n");

  switch (mode) {
    case "daily-operator":
      return [today, "", knowledgeBlock(entries, now, ["commitment", "preference"])]
        .filter(Boolean)
        .join("\n");

    case "chief-of-staff":
      return [
        "PRODUCTS:",
        productBlock(products),
        "",
        knowledgeBlock(entries, now, ["fact", "decision", "commitment"]),
        advice ? `\nRULES THAT FIRED:\n${advice}` : "",
      ]
        .filter(Boolean)
        .join("\n");

    case "technical-intelligence":
      return [
        "PRODUCTS AND THEIR CONSTRAINTS:",
        productBlock(products),
        "",
        alerts.length ? `WORTH INTERRUPTING FOR:\n${signalBlock(alerts)}` : "NOTHING WORTH INTERRUPTING FOR.",
        digest.length ? `\nDIGEST:\n${signalBlock(digest)}` : "",
      ]
        .filter(Boolean)
        .join("\n");

    case "market-intelligence":
      return [
        "PRODUCTS:",
        productBlock(products),
        "",
        knowledgeBlock(entries, now, ["hypothesis"]),
        "",
        signalBlock([...alerts, ...digest].filter((r) => r.signal.nature === "market")) ||
          "NO MARKET SIGNALS IN THE FEED.",
      ]
        .filter(Boolean)
        .join("\n");

    case "weekly-review":
      return [
        "PRODUCTS:",
        productBlock(products),
        "",
        advice ? `RULES THAT FIRED:\n${advice}` : "NO RULES FIRED.",
        "",
        brief.avoided.length
          ? `REPEATEDLY AVOIDED:\n${brief.avoided.map((i) => `- ${i.title}`).join("\n")}`
          : "",
        knowledgeBlock(entries, now, ["fact", "decision", "commitment", "hypothesis"]),
      ]
        .filter(Boolean)
        .join("\n");

    case "strategic-advisor":
      return [
        "PRODUCTS:",
        productBlock(products),
        "",
        knowledgeBlock(entries, now, ["fact", "decision", "hypothesis", "preference", "commitment"]),
        "",
        advice ? `RULES THAT FIRED:\n${advice}` : "",
        alerts.length ? `\nMARKET AND TECHNICAL PRESSURE:\n${signalBlock(alerts)}` : "",
      ]
        .filter(Boolean)
        .join("\n");
  }
}

// ── Prompts ──────────────────────────────────────────────────────────────

/**
 * The rules every mode inherits.
 *
 * The typed-memory distinction has to survive the trip through a model, or
 * everything the store enforces is undone by one fluent paragraph.
 */
const COMMON = `You are Thor, a business operating assistant for a solo operator.

You are given the CURRENT STATE below. It is the only thing you know.

Rules, in order of importance:
1. Never state anything not derivable from the state below. If the answer is not there, say exactly what is missing.
2. FACTS, DECISIONS, HYPOTHESES and COMMITMENTS are different things. A hypothesis is not a fact and must never be phrased as one. If you rely on a hypothesis, say that you are.
3. Never invent a number, a date, a product, a person or a blocker.
4. Be specific and short. No preamble, no summary of what you were asked, no offer to help further.
5. If the state contradicts the question's premise, say so first.`;

const MODE_PROMPT: Record<ModeId, string> = {
  "daily-operator": `Your job is today, and only today. Answer about what to do now, in what order, and what to leave.
Do not discuss strategy, the market, or which product deserves investment — say that is another mode's question.
The ordering below was already derived. Do not re-rank it; explain it, or say plainly where you think it is wrong and why.`,

  "chief-of-staff": `Your job is the state of the products: where each one is, what changed, what is blocked, and whether the milestone has evidence behind it.
Do not schedule the operator's day and do not recommend which product to back.
When a milestone has zero evidenced conditions, say so directly. "Nearly ready" is the phrase this mode exists to prevent.`,

  "technical-intelligence": `Your job is technical developments that touch this specific stack.
Relevance is measured against the current blocker first, the stack second, the phase third. A genuinely impressive development that does not touch the constraint is "evaluate soon", not "act now" — and saying so is the service.
Never report something that touches nothing the operator has.`,

  "market-intelligence": `Your job is demand: what buyers are paying for, what is becoming commoditised, what is becoming a baseline expectation.
Every observation must be tied to one of the operator's products or explicitly marked as not applicable to any of them.
Market beliefs in the state are HYPOTHESES. Say so every time you use one.`,

  "weekly-review": `Your job is what moved and what did not.
Activity is not movement. If capabilities shipped but no phase advanced and no milestone gained evidence, say that plainly rather than listing the activity approvingly.
End with one change to make, not several.`,

  "strategic-advisor": `Your job is where the operator's capacity should go.
Every recommendation must carry: the reason, the evidence from the state, the trade-off, and what would change your mind. Omit any of those and the recommendation is worthless.
Where the evidence is thin, recommend the cheapest test rather than the bolder move.`,
};

export function systemPromptFor(mode: ModeId): string {
  return `${COMMON}\n\n${MODE_PROMPT[mode]}`;
}

/**
 * What to show when no model is configured.
 *
 * The context is genuinely useful on its own — it is the derived state, laid
 * out. Saying so and showing it beats an error, and beats far more the
 * temptation to answer from the model's general knowledge of businesses.
 */
export function unphrasedAnswer(mode: ModeId, context: string, reason: string): string {
  return [
    `No model is configured, so nothing has phrased this. ${reason}`,
    "",
    `Below is exactly what ${MODES_BY_ID[mode].name} would have been given to answer from — the derived state, unedited. It is the whole basis of any answer, so it is worth reading directly.`,
    "",
    "───",
    "",
    context,
  ].join("\n");
}
