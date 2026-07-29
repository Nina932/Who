/**
 * The case ledger's server side.
 *
 * Split from `lib/cases.ts` deliberately: the projection, the workflow and the
 * turn model are pure and run in the browser, while anything that touches the
 * filesystem, Redis or a model provider lives here and never crosses that
 * line. Bundling the store into a client page is how a Node built-in ends up
 * in a webpack graph, and the split makes that impossible rather than careful.
 */

import { callRole, parseJson } from "./models";
import { id, mutate, readCollection } from "./store";
import {
  LEAD_TO_CASH,
  UNIVERSAL_EVENTS,
  availableEvents,
  exampleCases,
  project,
  type Actor,
  type CaseEvent,
  type CaseView,
  type StoredCase,
} from "./cases";

const CASES = "cases";

export async function allCases(): Promise<StoredCase[]> {
  return readCollection<StoredCase[]>(CASES, []);
}

export async function caseViews(now: number = Date.now()): Promise<CaseView[]> {
  const records = await allCases();
  return records.map((record) => project(record, now));
}

export interface OpenCaseInput {
  title: string;
  counterparty: string;
  process?: string;
  value?: number;
  currency?: string;
  note?: string;
  demo?: boolean;
  openedAt?: number;
}

export async function openCase(input: OpenCaseInput): Promise<StoredCase> {
  const openedAt = input.openedAt ?? Date.now();
  const record: StoredCase = {
    id: id("case"),
    title: input.title,
    counterparty: input.counterparty,
    process: input.process ?? LEAD_TO_CASH.id,
    value: input.value,
    currency: input.currency,
    openedAt,
    demo: input.demo,
    events: [
      {
        id: id("ev"),
        type: UNIVERSAL_EVENTS.opened,
        at: openedAt,
        actor: input.demo ? "system" : "operator",
        note: input.note,
      },
    ],
  };

  await mutate<StoredCase[], null>(CASES, [], (current) => ({
    next: [record, ...current].slice(0, 500),
    result: null,
  }));

  return record;
}

export interface AppendInput {
  type: string;
  actor?: Actor;
  note?: string;
  data?: Record<string, unknown>;
  at?: number;
}

/**
 * Append an event. Nothing else ever writes to a case.
 *
 * There is no `updateCase`, and there will not be one. Every change to a
 * case's position is an event with an actor and a timestamp, which is what
 * makes the history a record rather than a changelog of overwrites.
 */
export async function appendEvent(
  caseId: string,
  input: AppendInput,
): Promise<StoredCase | null> {
  const event: CaseEvent = {
    id: id("ev"),
    type: input.type,
    at: input.at ?? Date.now(),
    actor: input.actor ?? "operator",
    note: input.note?.trim() || undefined,
    data: input.data,
  };

  return mutate<StoredCase[], StoredCase | null>(CASES, [], (current) => {
    let updated: StoredCase | null = null;
    const next = current.map((record) => {
      if (record.id !== caseId) return record;
      updated = { ...record, events: [...record.events, event] };
      return updated;
    });
    return { next, result: updated };
  });
}

// ── Layer three: interpretation ──────────────────────────────────────────

export interface EventProposal {
  ok: boolean;
  /** One of the current stage's transitions, or null if none fit. */
  type: string | null;
  reason: string;
  /** Never applied automatically. The operator commits it, or nobody does. */
  requiresApproval: true;
  error?: string;
}

const INTERPRET_SYSTEM = `You read one message about a piece of ongoing work and decide which single event it represents.

You are given the case, the stage it is at, and the exact list of event types that stage accepts. Return ONLY JSON:

{"type": "<one of the listed types, or null>", "reason": "<one sentence, quoting the words that decided it>"}

Rules:
- The type MUST be one of the listed types, or null. Never invent one.
- Return null when the message is chatter, a question, or anything that does not move the work. Most messages are null.
- Ambiguity is null. A wrong transition corrupts a business record.`;

/**
 * Turn a real message into a *proposed* event.
 *
 * The layer that must never be trusted, so it is built not to be: the model
 * chooses from a closed list, the choice is validated against that list in
 * code, and the result is a proposal that a human commits. An unreachable
 * model returns a stated failure rather than a guess.
 */
export async function proposeEvent(
  view: CaseView,
  message: string,
): Promise<EventProposal> {
  const allowed = availableEvents(view);
  if (allowed.length === 0) {
    return {
      ok: true,
      type: null,
      reason: "This case is closed. Nothing can move it.",
      requiresApproval: true,
    };
  }

  const result = await callRole("quick", {
    system: INTERPRET_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          `CASE: ${view.title} (${view.counterparty})`,
          `STAGE: ${view.stage.label}`,
          `ACCEPTED EVENT TYPES: ${allowed.join(", ")}`,
          "",
          "MESSAGE:",
          message,
        ].join("\n"),
      },
    ],
    json: true,
  });

  if (!result.live) {
    return {
      ok: false,
      type: null,
      reason: "",
      requiresApproval: true,
      error: result.error ?? "No model available to read this.",
    };
  }

  const parsed = parseJson<{ type?: unknown; reason?: unknown }>(result.text);
  const proposed = typeof parsed?.type === "string" ? parsed.type : null;

  // The validation that makes the layer safe: a type the stage does not accept
  // is discarded, not coerced into the nearest match.
  if (proposed !== null && !allowed.includes(proposed)) {
    return {
      ok: true,
      type: null,
      reason: `Read it as "${proposed}", which this stage does not accept. Discarded.`,
      requiresApproval: true,
    };
  }

  return {
    ok: true,
    type: proposed,
    reason: typeof parsed?.reason === "string" ? parsed.reason : "No reason given.",
    requiresApproval: true,
  };
}

/** Load the examples, but only into an empty store. */
export async function seedExamples(now: number = Date.now()): Promise<number> {
  return mutate<StoredCase[], number>(CASES, [], (current) => {
    if (current.length > 0) return { next: current, result: 0 };
    const seeded = exampleCases(now);
    return { next: seeded, result: seeded.length };
  });
}

/** Remove every example, leaving real cases untouched. */
export async function clearExamples(): Promise<number> {
  return mutate<StoredCase[], number>(CASES, [], (current) => {
    const next = current.filter((record) => record.demo !== true);
    return { next, result: current.length - next.length };
  });
}
