/**
 * Cases — the unit of operational continuity.
 *
 * A task is a line someone typed. A **case** is a commitment that exists
 * whether or not anyone typed anything: a lead that arrived, work that was
 * promised, money that is owed. It has a counterparty, a position in a
 * process, and — the part every task manager throws away — a *turn*.
 *
 * Three rules hold this together:
 *
 *   1. **Events are the source of truth.** A case's state is never stored; it
 *      is projected from its event log, every time, by `project`. Rewind the
 *      log and you get the past state exactly. Nothing can be edited into an
 *      inconsistent position, because there is no position to edit.
 *
 *   2. **Somebody's turn, always.** Mine, theirs, the system's, the calendar's,
 *      blocked, or done. "Their turn" is not idle — it is a live obligation
 *      with a clock on it, and when that clock runs out the turn comes back to
 *      me. That single rule is the difference between a system that tracks
 *      work and one that maintains continuity.
 *
 *   3. **The next action is derived, never authored.** Layer one is the
 *      workflow: a stage knows what it needs. Layer two is policy: silence
 *      past a patience threshold flips the turn. Layer three is
 *      interpretation, which only ever *proposes* (see `proposeEvent`). Layer
 *      four is you, through the authority model.
 *
 * `/week` sits downstream of all of this. It allocates hours across actions
 * that were derived here; it does not invent them.
 */

import { callRole, parseJson } from "./models";
import { id, mutate, readCollection } from "./store";
import type { Candidate, CandidateSource } from "./priority";

// ── Vocabulary ───────────────────────────────────────────────────────────

/** The six operational loops a one-person business actually repeats. */
export type LoopDomain =
  | "inbound"
  | "pipeline"
  | "delivery"
  | "cash"
  | "content"
  | "admin";

/**
 * Whose turn it is. The most important field in the system.
 *
 * `theirs` and `scheduled` are the two states every task list collapses into
 * "not done", which is how a proposal sits unanswered for three weeks and
 * nobody notices that the silence itself was the event.
 */
export type Turn = "mine" | "theirs" | "system" | "scheduled" | "blocked" | "complete";

export const TURN_LABEL: Record<Turn, string> = {
  mine: "My turn",
  theirs: "Their turn",
  system: "System turn",
  scheduled: "Scheduled",
  blocked: "Blocked",
  complete: "Complete",
};

/**
 * How far Thor may go without you, per action.
 *
 * Escalating is a decision you make once per action type, not a global switch,
 * because "draft the invoice" and "send the invoice" are not the same risk.
 */
export type Authority =
  /** Say what should happen. Nothing is produced. */
  | "recommend"
  /** Produce the artefact — draft, document, event — and stop. */
  | "prepare"
  /** Do it, and tell you afterwards. */
  | "execute";

export const AUTHORITY_LABEL: Record<Authority, string> = {
  recommend: "Recommends",
  prepare: "Prepares, you send",
  execute: "Acts, then tells you",
};

/** Who caused an event. */
export type Actor = "operator" | "counterparty" | "system" | "thor";

// ── Events ───────────────────────────────────────────────────────────────

export interface CaseEvent {
  id: string;
  type: string;
  at: number;
  actor: Actor;
  /** What happened, in words. Kept verbatim; never summarised away. */
  note?: string;
  /** Structured detail a stage may read: `value`, `dueAt`. */
  data?: Record<string, unknown>;
}

/** Events every workflow understands, on top of its own transitions. */
export const UNIVERSAL_EVENTS = {
  opened: "opened",
  /** Something outside the process stopped this. Overrides the turn. */
  blocked: "blocked",
  unblocked: "unblocked",
  /** Context with no state change. Kept in history, changes nothing. */
  note: "note",
} as const;

// ── Workflow definition ──────────────────────────────────────────────────

export interface StageAction {
  /** `{counterparty}` and `{value}` are substituted at projection time. */
  title: string;
  /** Honest hours. This is what `/week` spends its budget in. */
  hours: number;
  authority: Authority;
  /** What Thor produces before handing it back, when authority allows. */
  prepares?: string;
  /** Base factor scores for `/week`. Risk and value adjust them upward. */
  factors: Partial<Record<FactorKey, number>>;
}

type FactorKey =
  | "revenue"
  | "obligation"
  | "decay"
  | "unblocks"
  | "leverage"
  | "learning"
  | "effort"
  | "irreversible"
  | "theatre";

export interface Waiting {
  /** Who or what is holding this. Shown verbatim on `/waiting`. */
  on: string;
  /**
   * How long that is reasonable for. Past this, the turn comes back to me —
   * the policy layer, and the reason nothing can rot quietly.
   */
  patienceDays: number;
  /**
   * `lastEvent` measures silence. `date` measures against `dueAt` on the case,
   * where patienceDays is instead how early the work becomes mine.
   */
  from?: "lastEvent" | "date";
  /** What I do when patience runs out. */
  escalation: StageAction;
}

export interface Stage {
  id: string;
  label: string;
  loop: LoopDomain;
  turn: Turn;
  /** What the stage needs, when the turn is mine. */
  action?: StageAction;
  /** What the stage is waiting for, when it is not. */
  waiting?: Waiting;
  /** event type → next stage id. The whole state machine. */
  on: Record<string, string>;
  terminal?: boolean;
}

export interface Workflow {
  id: string;
  name: string;
  purpose: string;
  initialStage: string;
  stages: Stage[];
}

/**
 * Lead to cash — the first vertical slice.
 *
 * Deliberately one process end to end rather than six processes half-built.
 * A lead that arrives, is qualified, quoted, won, delivered, accepted,
 * invoiced and paid crosses the commercial, delivery and financial loops in a
 * single unbroken chain. If continuity survives that, it survives anything;
 * if it does not, no number of extra loops would have helped.
 */
export const LEAD_TO_CASH: Workflow = {
  id: "lead-to-cash",
  name: "Lead to cash",
  purpose:
    "Carry one commitment from the first message to the money landing, without a stage where it can go quiet.",
  initialStage: "inbound",
  stages: [
    {
      id: "inbound",
      label: "New enquiry",
      loop: "inbound",
      // Thor's turn: reading an enquiry and judging whether it is real work is
      // exactly the job a model should do first.
      turn: "system",
      waiting: {
        on: "Thor, qualifying",
        patienceDays: 1,
        escalation: {
          title: "Qualify {counterparty} yourself — Thor did not",
          hours: 0.25,
          authority: "recommend",
          factors: { revenue: 0.5, decay: 0.8, unblocks: 0.9, effort: 0.1 },
        },
      },
      on: {
        qualified: "proposal-due",
        disqualified: "closed-lost",
        "needs-review": "qualify-review",
      },
    },
    {
      id: "qualify-review",
      label: "Qualification needs you",
      loop: "inbound",
      turn: "mine",
      action: {
        title: "Decide whether {counterparty} is real work",
        hours: 0.25,
        authority: "recommend",
        prepares: "The signals for and against, already gathered",
        factors: { revenue: 0.5, decay: 0.8, unblocks: 0.9, effort: 0.1 },
      },
      on: { qualified: "proposal-due", disqualified: "closed-lost" },
    },
    {
      id: "proposal-due",
      label: "Proposal owed",
      loop: "pipeline",
      turn: "mine",
      action: {
        title: "Send {counterparty} the proposal",
        hours: 2,
        authority: "prepare",
        prepares: "A drafted proposal in your voice, ready to read and send",
        factors: {
          revenue: 0.85,
          obligation: 0.9,
          decay: 0.85,
          unblocks: 0.4,
          learning: 0.2,
          effort: 0.25,
        },
      },
      on: { "proposal-sent": "awaiting-decision", lost: "closed-lost" },
    },
    {
      id: "awaiting-decision",
      label: "Proposal with them",
      loop: "pipeline",
      turn: "theirs",
      waiting: {
        on: "{counterparty}, to answer the proposal",
        patienceDays: 5,
        escalation: {
          title: "Follow up — {counterparty} has had the proposal {days} days",
          hours: 0.25,
          authority: "prepare",
          prepares: "A follow-up that does not read as a nag",
          factors: { revenue: 0.7, decay: 0.85, obligation: 0.2, effort: 0.05 },
        },
      },
      on: { won: "delivery-due", lost: "closed-lost", "proposal-sent": "awaiting-decision" },
    },
    {
      id: "delivery-due",
      label: "Work to start",
      loop: "delivery",
      turn: "mine",
      action: {
        title: "Start the work for {counterparty}",
        hours: 2,
        authority: "recommend",
        factors: { obligation: 0.8, decay: 0.4, unblocks: 0.8, revenue: 0.4, effort: 0.2 },
      },
      on: { scheduled: "delivery-scheduled", started: "delivery-active" },
    },
    {
      id: "delivery-scheduled",
      label: "Booked in",
      loop: "delivery",
      turn: "scheduled",
      waiting: {
        on: "the date it is booked for",
        // Counted against `dueAt`: it becomes mine two days before, not two
        // days after — a booking is the one thing that must not surprise you.
        patienceDays: 2,
        from: "date",
        escalation: {
          title: "Deliver for {counterparty} — the booked date is here",
          hours: 8,
          authority: "recommend",
          factors: { obligation: 0.95, decay: 0.9, revenue: 0.6, effort: 0.9 },
        },
      },
      on: { started: "delivery-active", rescheduled: "delivery-scheduled" },
    },
    {
      id: "delivery-active",
      label: "In delivery",
      loop: "delivery",
      turn: "mine",
      action: {
        title: "Finish the work for {counterparty}",
        hours: 8,
        authority: "recommend",
        factors: {
          obligation: 0.95,
          revenue: 0.6,
          decay: 0.6,
          unblocks: 0.5,
          effort: 0.9,
          learning: 0.15,
        },
      },
      on: { delivered: "awaiting-acceptance", blocked: "delivery-active" },
    },
    {
      id: "awaiting-acceptance",
      label: "With them to sign off",
      loop: "delivery",
      turn: "theirs",
      waiting: {
        on: "{counterparty}, to accept the work",
        patienceDays: 4,
        escalation: {
          title: "Ask {counterparty} to sign off — delivered {days} days ago",
          hours: 0.25,
          authority: "prepare",
          prepares: "The sign-off request, with what was delivered attached",
          // Unacceptance is the quietest way an invoice never gets sent.
          factors: { revenue: 0.8, obligation: 0.4, decay: 0.9, unblocks: 0.95, effort: 0.05 },
        },
      },
      on: { accepted: "invoice-due", "changes-requested": "delivery-active" },
    },
    {
      id: "invoice-due",
      label: "Invoice owed",
      loop: "cash",
      turn: "mine",
      action: {
        title: "Invoice {counterparty} for {value}",
        hours: 0.25,
        authority: "prepare",
        prepares: "The invoice, filled in from the case — you press send",
        factors: { revenue: 0.95, decay: 0.7, unblocks: 0.6, effort: 0.05, irreversible: 0.1 },
      },
      on: { invoiced: "awaiting-payment", "written-off": "closed-lost" },
    },
    {
      id: "awaiting-payment",
      label: "Awaiting payment",
      loop: "cash",
      turn: "theirs",
      waiting: {
        on: "{counterparty}, to pay",
        patienceDays: 30,
        escalation: {
          title: "Chase {value} from {counterparty} — {days} days out",
          hours: 0.5,
          authority: "prepare",
          prepares: "The chase, escalating in tone with each one sent",
          factors: { revenue: 0.95, decay: 0.75, obligation: 0.3, effort: 0.1 },
        },
      },
      on: { paid: "closed-won", "written-off": "closed-lost" },
    },
    {
      id: "closed-won",
      label: "Paid",
      loop: "cash",
      turn: "complete",
      terminal: true,
      on: {},
    },
    {
      id: "closed-lost",
      label: "Closed, no money",
      loop: "pipeline",
      turn: "complete",
      terminal: true,
      on: {},
    },
  ],
};

export const WORKFLOWS: Record<string, Workflow> = {
  [LEAD_TO_CASH.id]: LEAD_TO_CASH,
};

export function stageOf(workflow: Workflow, stageId: string): Stage | undefined {
  return workflow.stages.find((s) => s.id === stageId);
}

// ── The stored case ──────────────────────────────────────────────────────

export interface StoredCase {
  id: string;
  title: string;
  counterparty: string;
  /** Workflow id. */
  process: string;
  /** Money at stake, if known. Drives risk, not ranking on its own. */
  value?: number;
  currency?: string;
  openedAt: number;
  /** Seeded example rather than something that happened. Never hidden. */
  demo?: boolean;
  /** The source of truth. Everything below is projected from this. */
  events: CaseEvent[];
}

// ── Projection ───────────────────────────────────────────────────────────

export type RiskLevel = "none" | "watch" | "at-risk" | "critical";

export interface Risk {
  level: RiskLevel;
  reason: string;
}

export interface NextAction {
  caseId: string;
  caseTitle: string;
  counterparty: string;
  loop: LoopDomain;
  title: string;
  hours: number;
  authority: Authority;
  prepares?: string;
  factors: Record<string, number>;
  /** Why this is the next action — shown so no action is ever anonymous. */
  why: string;
  /**
   * Which layer produced it. `workflow` is the stage asking for what it needs;
   * `policy` is a patience threshold firing and taking the turn back.
   */
  derivedBy: "workflow" | "policy";
}

export interface CaseView {
  id: string;
  title: string;
  counterparty: string;
  process: string;
  workflowName: string;
  value?: number;
  currency: string;
  openedAt: number;
  demo: boolean;

  stage: Stage;
  turn: Turn;
  /** Set only when the turn is not mine. Rendered verbatim on `/waiting`. */
  waitingOn: string | null;
  /** Milliseconds since the last event of any kind. */
  quietFor: number;
  /** Days past the stage's patience. Zero or negative means still in time. */
  overdueDays: number;
  /** Committed date, when the case carries one. */
  dueAt: number | null;
  blockedBy: string | null;
  risk: Risk;
  action: NextAction | null;
  events: CaseEvent[];
  /**
   * Events the workflow had no transition for. Kept and surfaced rather than
   * dropped — an event nobody could apply is a gap in the process, and a
   * system that swallows it is lying about its coverage.
   */
  unapplied: Array<{ type: string; at: number }>;
}

const DAY = 86_400_000;

function money(value: number | undefined, currency: string): string {
  if (value === undefined) return "the agreed amount";
  return `${currency}${value.toLocaleString("en-GB")}`;
}

function fill(
  template: string,
  record: StoredCase,
  currency: string,
  days: number,
): string {
  return template
    .replace(/\{counterparty\}/g, record.counterparty)
    .replace(/\{value\}/g, money(record.value, currency))
    .replace(/\{days\}/g, String(Math.max(0, Math.round(days))));
}

/**
 * Replay the log.
 *
 * Deliberately a pure fold over events with an explicit `now`, so a case's
 * state at any past moment is `project(record, thatMoment)` and every test can
 * pin time instead of racing it.
 */
export function project(record: StoredCase, now: number): CaseView {
  const workflow = WORKFLOWS[record.process] ?? LEAD_TO_CASH;
  const currency = record.currency ?? "£";

  let stageId = workflow.initialStage;
  let value = record.value;
  let dueAt: number | null = null;
  let blockedBy: string | null = null;
  let enteredStageAt = record.openedAt;
  let lastEventAt = record.openedAt;
  const unapplied: Array<{ type: string; at: number }> = [];

  // Events after `now` are not yet part of history. Without this the fold
  // applies the whole log whatever moment you ask about, and "the state last
  // Tuesday" quietly returns today's state — which would make the log a
  // changelog rather than a record.
  const ordered = [...record.events]
    .filter((event) => event.at <= now)
    .sort((a, b) => a.at - b.at);

  for (const event of ordered) {
    lastEventAt = Math.max(lastEventAt, event.at);

    if (typeof event.data?.value === "number") value = event.data.value;
    if (typeof event.data?.dueAt === "number") dueAt = event.data.dueAt;

    if (event.type === UNIVERSAL_EVENTS.blocked) {
      blockedBy = event.note?.trim() || "something outside this process";
      continue;
    }
    if (event.type === UNIVERSAL_EVENTS.unblocked) {
      blockedBy = null;
      continue;
    }
    if (event.type === UNIVERSAL_EVENTS.note || event.type === UNIVERSAL_EVENTS.opened) {
      continue;
    }

    const stage = stageOf(workflow, stageId);
    const target = stage?.on[event.type];
    if (!target) {
      unapplied.push({ type: event.type, at: event.at });
      continue;
    }

    // A self-transition (a re-sent proposal, a reschedule) restarts the clock
    // without moving the case — which is the entire point of recording it.
    stageId = target;
    enteredStageAt = event.at;
    // A reschedule that carries no new date must not keep the old one.
    if (event.type === "rescheduled" && typeof event.data?.dueAt !== "number") {
      dueAt = null;
    }
  }

  const stage = stageOf(workflow, stageId) ?? workflow.stages[0];
  const withValue: StoredCase = { ...record, value };

  // ── Turn, and the policy that can take it back ─────────────────────────

  let turn: Turn = stage.turn;
  let waitingOn: string | null = null;
  let overdueDays = 0;
  let action: NextAction | null = null;

  const build = (
    spec: StageAction,
    why: string,
    derivedBy: NextAction["derivedBy"],
    days: number,
  ): NextAction => ({
    caseId: record.id,
    caseTitle: record.title,
    counterparty: record.counterparty,
    loop: stage.loop,
    title: fill(spec.title, withValue, currency, days),
    hours: spec.hours,
    authority: spec.authority,
    prepares: spec.prepares,
    factors: { ...spec.factors } as Record<string, number>,
    why,
    derivedBy,
  });

  if (blockedBy && !stage.terminal) {
    turn = "blocked";
    waitingOn = blockedBy;
  } else if (stage.waiting) {
    const { on, patienceDays, from = "lastEvent", escalation } = stage.waiting;
    waitingOn = fill(on, withValue, currency, 0);

    if (from === "date") {
      // Counted forward to the booked date: patience is how early it lands on
      // you, so a booking never arrives as a surprise.
      const dueDays = dueAt === null ? 0 : (dueAt - now) / DAY;
      overdueDays = dueAt === null ? 0 : patienceDays - dueDays;
      if (dueAt === null || dueDays <= patienceDays) {
        if (dueAt === null || dueDays <= 0) {
          turn = "mine";
          action = build(
            escalation,
            dueAt === null
              ? "Booked, but with no date on the case."
              : "The booked date has arrived.",
            "policy",
            Math.abs(dueDays),
          );
        } else {
          // Inside the lead time: still scheduled, but it is now yours to plan.
          action = build(
            escalation,
            `Booked in ${Math.ceil(dueDays)} day${Math.ceil(dueDays) === 1 ? "" : "s"}.`,
            "policy",
            dueDays,
          );
        }
      }
    } else {
      const quietDays = (now - enteredStageAt) / DAY;
      overdueDays = quietDays - patienceDays;
      if (overdueDays > 0) {
        turn = "mine";
        action = build(
          escalation,
          stage.turn === "system"
            ? `Thor has held this for ${Math.round(quietDays)} days without moving it. It is yours now.`
            : `Silent for ${Math.round(quietDays)} days — past the ${patienceDays}-day mark for this stage.`,
          "policy",
          quietDays,
        );
      }
    }
  }

  if (!action && stage.action && turn === "mine") {
    action = build(
      stage.action,
      `The case is at "${stage.label}" and this is what that stage needs.`,
      "workflow",
      (now - enteredStageAt) / DAY,
    );
  }

  return {
    id: record.id,
    title: record.title,
    counterparty: record.counterparty,
    process: workflow.id,
    workflowName: workflow.name,
    value,
    currency,
    openedAt: record.openedAt,
    demo: record.demo === true,
    stage,
    turn,
    waitingOn: turn === "mine" || turn === "complete" ? null : waitingOn,
    quietFor: Math.max(0, now - lastEventAt),
    overdueDays,
    dueAt,
    blockedBy,
    risk: assessRisk(stage, turn, overdueDays, value, blockedBy),
    action,
    events: ordered,
    unapplied,
  };
}

/**
 * Risk is about *money that may not arrive*, not about lateness in the
 * abstract. A proposal going quiet is a worry; an accepted job that was never
 * invoiced is a hole in the floor.
 */
export function assessRisk(
  stage: Stage,
  turn: Turn,
  overdueDays: number,
  value: number | undefined,
  blockedBy: string | null,
): Risk {
  if (stage.terminal) return { level: "none", reason: "Closed." };
  if (blockedBy) {
    return { level: "at-risk", reason: `Blocked by ${blockedBy} — nothing moves until that does.` };
  }

  const patience = stage.waiting?.patienceDays ?? 0;
  const cashStage = stage.loop === "cash";

  if (overdueDays > patience) {
    // Twice the patience is not "a bit late". It is the stage failing.
    return {
      level: "critical",
      reason: cashStage
        ? `Money owed and ${Math.round(overdueDays)} days past the point anyone should have to ask.`
        : `${Math.round(overdueDays)} days past the point this stage tolerates.`,
    };
  }
  if (overdueDays > 0) {
    return {
      level: "at-risk",
      reason: `${Math.round(overdueDays)} day${Math.round(overdueDays) === 1 ? "" : "s"} past this stage's patience.`,
    };
  }
  if (turn === "theirs" && overdueDays > -1) {
    return { level: "watch", reason: "Patience nearly spent." };
  }
  if (turn === "mine" && (value ?? 0) > 0 && cashStage) {
    return { level: "watch", reason: "Money is waiting on an action of yours." };
  }
  return { level: "none", reason: turn === "mine" ? "Yours, and in time." : "In time." };
}

// ── Feeding the week ─────────────────────────────────────────────────────

const LOOP_SOURCE: Record<LoopDomain, CandidateSource> = {
  inbound: "inbound",
  pipeline: "pipeline",
  delivery: "delivery",
  cash: "cash",
  content: "content",
  admin: "admin",
};

const ALL_FACTORS: FactorKey[] = [
  "revenue",
  "obligation",
  "decay",
  "unblocks",
  "leverage",
  "learning",
  "effort",
  "irreversible",
  "theatre",
];

/**
 * Actions the operator actually has to take, as candidates for `/week`.
 *
 * Two things it deliberately does *not* do. It does not emit anything for a
 * case whose turn is theirs, the system's, or a future date — those are
 * tracked, and tracking is not doing. And it does not invent effort: hours
 * come from the stage definition, so a week's committed hours are the sum of
 * real commitments rather than a guess made at ranking time.
 *
 * Overdue-ness raises `decay`, because the whole claim of this system is that
 * silence is information.
 */
export function candidatesFromCases(views: CaseView[]): Candidate[] {
  return views
    .filter((view) => view.action !== null)
    .map((view) => {
      const action = view.action as NextAction;

      const factors: Record<string, number> = {};
      for (const key of ALL_FACTORS) factors[key] = action.factors[key] ?? 0;

      if (view.overdueDays > 0) {
        // Bounded: decay is a factor, not a licence to dominate the ranking.
        const pressure = Math.min(1, view.overdueDays / 14);
        factors.decay = Math.min(1, factors.decay + pressure * 0.35);
        factors.obligation = Math.min(1, factors.obligation + pressure * 0.2);
      }

      return {
        id: `case-${view.id}`,
        title: action.title,
        source: LOOP_SOURCE[action.loop],
        origin: `${view.stage.label} · ${view.counterparty}${
          view.value ? ` · ${money(view.value, view.currency)}` : ""
        }`,
        factors,
        hours: action.hours,
      };
    });
}

/** The transitions available from where a case currently stands. */
export function availableEvents(view: CaseView): string[] {
  return Object.keys(view.stage.on);
}

// ── Examples ─────────────────────────────────────────────────────────────

/**
 * One case per turn state, because the turn model is the claim and a demo
 * where everything is "my turn" demonstrates nothing. Money quietly overdue,
 * a proposal genuinely still with them, work awaiting a signature, a booking
 * ahead, an enquiry Thor is reading, one blocked on somebody else, and one
 * finished.
 *
 * Marked `demo` everywhere they appear and removable in one click — invented
 * data that pretends to be yours is worse than no data at all.
 */
export function exampleCases(now: number): StoredCase[] {
  const ago = (days: number) => now - days * DAY;
  const ev = (type: string, days: number, actor: Actor, note?: string, data?: Record<string, unknown>): CaseEvent => ({
    id: `ev-${type}-${days}`,
    type,
    at: ago(days),
    actor,
    note,
    data,
  });

  const demo = (
    idSuffix: string,
    title: string,
    counterparty: string,
    value: number,
    openedDaysAgo: number,
    events: CaseEvent[],
  ): StoredCase => ({
    id: `case-demo-${idSuffix}`,
    title,
    counterparty,
    process: LEAD_TO_CASH.id,
    value,
    currency: "£",
    openedAt: ago(openedDaysAgo),
    demo: true,
    events,
  });

  return [
    // My turn, by policy: 38 days past 30-day terms is not "still waiting".
    demo("invoice", "Brand refresh, phase one", "Halden & Co", 4200, 110, [
      ev("opened", 110, "counterparty", "Enquiry through the site."),
      ev("qualified", 109, "thor", "Budget stated, timeline realistic."),
      ev("proposal-sent", 106, "operator"),
      ev("won", 98, "counterparty", "Signed."),
      ev("started", 96, "operator"),
      ev("delivered", 74, "operator"),
      ev("accepted", 70, "counterparty", "Happy with it."),
      ev("invoiced", 68, "operator", undefined, { value: 4200 }),
    ]),

    // Their turn, and genuinely so — three days is not yet a chase.
    demo("proposal", "Website rebuild", "Ridgeway Labs", 9000, 12, [
      ev("opened", 12, "counterparty", "Intro call went well."),
      ev("qualified", 11, "thor"),
      ev("proposal-sent", 3, "operator", "Sent the scoped version."),
    ]),

    // Their turn: delivered, unsigned, and the clock has two days left on it.
    demo("signoff", "Onboarding automation", "Verity Group", 2800, 40, [
      ev("opened", 40, "counterparty"),
      ev("qualified", 39, "thor"),
      ev("proposal-sent", 36, "operator"),
      ev("won", 30, "counterparty"),
      ev("started", 28, "operator"),
      ev("delivered", 2, "operator", "Handed over the working version."),
    ]),

    // My turn, straight from the workflow: the stage owes a proposal.
    demo("fresh", "Data pipeline audit", "Ostara", 6500, 2, [
      ev("opened", 2, "counterparty", "Referred by a past client."),
      ev("qualified", 1, "thor", "Clear scope, decision-maker in the thread."),
    ]),

    // Scheduled: booked, far enough out to be nobody's problem yet.
    demo("booked", "Migration weekend", "Calder Institute", 11000, 26, [
      ev("opened", 26, "counterparty"),
      ev("qualified", 25, "thor"),
      ev("proposal-sent", 22, "operator"),
      ev("won", 14, "counterparty"),
      ev("scheduled", 13, "operator", "Booked for the 14th.", {
        dueAt: now + 9 * DAY,
      }),
    ]),

    // System turn: arrived this morning, Thor is reading it.
    demo("arriving", "Unspecified — enquiry in progress", "Marrow Studio", 0, 0.2, [
      ev("opened", 0.2, "counterparty", "Long message, budget not stated."),
    ]),

    // Blocked: moving is not possible, and the reason is named.
    demo("blocked", "Reporting rebuild", "Ashgrove Partners", 7400, 55, [
      ev("opened", 55, "counterparty"),
      ev("qualified", 54, "thor"),
      ev("proposal-sent", 50, "operator"),
      ev("won", 44, "counterparty"),
      ev("started", 42, "operator"),
      ev("blocked", 16, "operator", "their IT has not issued the API credentials"),
    ]),

    // Complete, kept visible: a closed case is evidence, not clutter.
    demo("paid", "Launch campaign", "Tessellate", 3300, 150, [
      ev("opened", 150, "counterparty"),
      ev("qualified", 149, "thor"),
      ev("proposal-sent", 146, "operator"),
      ev("won", 140, "counterparty"),
      ev("started", 138, "operator"),
      ev("delivered", 120, "operator"),
      ev("accepted", 118, "counterparty"),
      ev("invoiced", 117, "operator"),
      ev("paid", 96, "counterparty", "Paid on terms."),
    ]),
  ];
}
