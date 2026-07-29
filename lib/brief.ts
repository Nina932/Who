/**
 * The morning brief.
 *
 * This is the assistant, and it is deliberately *derived* rather than
 * generated. Every line comes from a case's turn, a product's blocker, or a
 * dated commitment. A model may be asked to phrase it; a model is never asked
 * what is true, because an assistant that composes a plausible day is worse
 * than no assistant — it is a confident one.
 *
 * Four things a task list does not do, and this does:
 *
 *   **Capacity honesty.** Hours you planned versus hours you actually have.
 *   When the calendar is not connected it says so rather than assuming the
 *   day is empty.
 *
 *   **A reason per item.** Why it matters, why it matters *now*, what it
 *   costs to delay. An item that cannot answer those does not belong at the
 *   top, whatever its score.
 *
 *   **An explicit cut.** What was moved out of today and on what test — the
 *   rule being that work touching no customer, no release blocker and no
 *   commitment is not today's work, however appealing it looks.
 *
 *   **Avoidance.** Anything that has appeared in several briefs and never
 *   been done is surfaced as its own finding. A thing you keep not doing is
 *   information about you, not about the thing.
 */

import { greeting } from "./ambient";
import { rank, type Advisory } from "./advisory";
import { candidatesFromCases, type CaseView } from "./cases";
import {
  commitmentsAtRisk,
  confidenceOf,
  select,
  untestedHypotheses,
  type Entry,
} from "./knowledge";
import { advise, view as productView, type Product, type ProductView } from "./products";
import {
  DEFAULT_CONTEXT,
  DEFAULT_WEIGHTS,
  rankWeek,
  type Candidate,
  type Context,
  type WeightMap,
} from "./priority";

const DAY = 86_400_000;

// ── Inputs ───────────────────────────────────────────────────────────────

export interface Capacity {
  /** Hours the operator intends to give today. */
  plannedHours: number;
  /**
   * Hours already committed elsewhere, from a calendar. `null` means no
   * calendar is connected — reported as unknown rather than assumed zero.
   */
  bookedHours: number | null;
}

/**
 * One previous brief, reduced to what it was about.
 *
 * Kept so avoidance is measurable. Without history the assistant cannot tell
 * the difference between a new task and the same task for the ninth day.
 */
export interface BriefRecord {
  at: number;
  itemKeys: string[];
}

export interface BriefInput {
  now: number;
  operator: string;
  /**
   * The operator's local hour, 0-23.
   *
   * Passed in rather than read from `now`, because the brief is derived
   * server-side and `new Date(now).getHours()` is the hour wherever the
   * process runs. A UTC host greeting a UTC+4 operator with "Good evening"
   * over breakfast is the kind of small wrongness that makes everything else
   * on the page feel guessed at.
   */
  localHour?: number;
  cases: CaseView[];
  products: Product[];
  entries: Entry[];
  capacity: Capacity;
  /**
   * Where the capacity numbers came from. Supplied by the caller because only
   * the caller knows whether the calendar answered, failed, or was never
   * connected — three states the brief must not collapse into one sentence.
   */
  capacityNote?: string;
  history: BriefRecord[];
  weights?: WeightMap;
  context?: Context;
}

// ── Output ───────────────────────────────────────────────────────────────

export interface BriefItem {
  key: string;
  title: string;
  minutes: number;
  /** Why it matters at all. */
  matters: string;
  /** Why it matters *today* specifically. */
  now: string;
  /** What it costs to leave it. */
  ifDelayed: string;
  source: "case" | "commitment" | "blocker";
  subject: string;
  /** How many consecutive briefs this has appeared in without moving. */
  appearances: number;
}

export interface Deferred {
  key: string;
  title: string;
  reason: string;
}

/** Today's work placed inside the longer arcs it is supposed to serve. */
export interface HorizonLink {
  today: string;
  week: string;
  phase: string;
}

export interface Brief {
  at: number;
  greeting: string;
  capacity: {
    plannedHours: number;
    realisticHours: number;
    /** Stated plainly when the calendar cannot be read. */
    note: string;
  };
  items: BriefItem[];
  committedMinutes: number;
  deferred: Deferred[];
  waitingCount: number;
  /** Things you keep not doing. */
  avoided: BriefItem[];
  advisories: Advisory[];
  horizons: HorizonLink[];
  productViews: ProductView[];
  /** Which product got today's blocker time, and which did not. */
  focus: { productName: string; note: string } | null;
}

// ── Derivation ───────────────────────────────────────────────────────────

function greetingFor(hour: number, operator: string): string {
  const time = greeting(hour);
  return operator ? `${time}, ${operator}.` : `${time}.`;
}

/**
 * The test that decides what today is for.
 *
 * Work earns a place by touching a live customer commitment, a release
 * blocker, or a dated promise. Everything else is real work that is not
 * today's work — and saying which of the three it failed is what makes the
 * cut arguable rather than arbitrary.
 */
function qualifies(
  candidate: Candidate,
  caseById: Map<string, CaseView>,
  products: ProductView[],
): { ok: true } | { ok: false; reason: string } {
  const view = caseById.get(candidate.id.replace(/^case-/, ""));

  if (view) {
    // A case action is by construction a commitment to a counterparty.
    if (view.value && view.value > 0) return { ok: true };
    if (view.action?.derivedBy === "policy") return { ok: true };
    return { ok: true };
  }

  if (candidate.id.startsWith("blocker-")) {
    const blocked = products.some((p) => p.releaseBlockers.length > 0);
    return blocked
      ? { ok: true }
      : { ok: false, reason: "the blocker it clears no longer gates a release" };
  }

  if (candidate.id.startsWith("commit-")) return { ok: true };

  return {
    ok: false,
    reason: "it does not affect a customer, a release blocker, or a current commitment",
  };
}

/**
 * Which product gets today's blocker time.
 *
 * Exactly one, and this is not a simplification. A brief that schedules
 * blocker work on two products at once contradicts the advice the same system
 * gives about running too many things — and a day split across two stuck
 * products reliably unsticks neither. The one carrying its blockers longest
 * wins, because that is the one whose phase label has been wrong longest.
 */
export function focusProduct(products: ProductView[]): ProductView | null {
  const blocked = products.filter((p) => p.active && p.releaseBlockers.length > 0);
  if (blocked.length === 0) return null;
  return [...blocked].sort(
    (a, b) => b.oldestBlockerDays - a.oldestBlockerDays || b.releaseBlockers.length - a.releaseBlockers.length,
  )[0];
}

/** Release blockers become work in their own right, ranked with everything else. */
function blockerCandidates(products: ProductView[], now: number): Candidate[] {
  const focus = focusProduct(products);
  return (focus ? [focus] : [])
    .flatMap((product) =>
      product.releaseBlockers.map((blocker) => {
        const days = (now - blocker.openedAt) / DAY;
        return {
          id: `blocker-${product.id}-${blocker.id}`,
          title: `Clear "${blocker.name}" on ${product.name}`,
          source: "delivery" as const,
          origin: `${product.name} · release blocker, open ${Math.round(days)} days`,
          // One protected hour, not an estimate. Nobody knows what a blocker
          // costs until they sit with it — which is part of why it is still
          // open — and inventing a figure would make the day's arithmetic a
          // fiction dressed as a plan.
          hours: 1,
          factors: {
            revenue: 0.3,
            obligation: 0.2,
            // A blocker does not decay; it compounds. Age raises the cost of
            // continuing to route around it.
            decay: Math.min(1, 0.3 + days / 40),
            unblocks: 0.95,
            leverage: 0.4,
            learning: 0.2,
            effort: 0.35,
            irreversible: 0.05,
            theatre: 0,
          },
        };
      }),
    );
}

/** Dated promises become work as their date approaches. */
function commitmentCandidates(entries: Entry[], now: number): Candidate[] {
  return commitmentsAtRisk(entries, now, 3).map(({ entry, overdueDays }) => ({
    id: `commit-${entry.id}`,
    title: entry.text,
    source: "manual" as const,
    origin:
      overdueDays >= 0
        ? `Commitment · ${Math.round(overdueDays)} days past its date`
        : `Commitment · due in ${Math.ceil(-overdueDays)} day${Math.ceil(-overdueDays) === 1 ? "" : "s"}`,
    hours: 1.5,
    factors: {
      revenue: 0.5,
      obligation: 0.95,
      decay: Math.min(1, 0.6 + Math.max(0, overdueDays) / 10),
      unblocks: 0.3,
      leverage: 0.1,
      learning: 0.1,
      effort: 0.2,
      irreversible: 0.05,
      theatre: 0,
    },
  }));
}

function explain(
  candidate: Candidate,
  caseById: Map<string, CaseView>,
  products: ProductView[],
  entries: Entry[],
  now: number,
): Pick<BriefItem, "matters" | "now" | "ifDelayed" | "source" | "subject"> {
  const view = caseById.get(candidate.id.replace(/^case-/, ""));
  if (view) {
    return {
      source: "case",
      subject: view.counterparty,
      matters: view.value
        ? `${view.currency}${view.value.toLocaleString("en-GB")} with ${view.counterparty}, at "${view.stage.label}".`
        : `A live commitment to ${view.counterparty}.`,
      now: view.action?.why ?? "The stage needs it.",
      ifDelayed:
        view.overdueDays > 0
          ? `Already ${Math.round(view.overdueDays)} days past what this stage tolerates; the cost is the relationship, then the money.`
          : "It moves from your turn to overdue, and the counterparty notices before you do.",
    };
  }

  if (candidate.id.startsWith("blocker-")) {
    const product = products.find((p) => candidate.id.includes(p.id));
    const days = product?.oldestBlockerDays ?? 0;
    return {
      source: "blocker",
      subject: product?.name ?? "product",
      matters: `Release of ${product?.name ?? "the product"} is gated on it. Nothing downstream ships until it clears.`,
      now: `Open ${Math.round(days)} days. One protected hour — the blocker is not estimated, which is part of why it is still open.`,
      ifDelayed: `The milestone "${product?.milestone.name ?? ""}" slips again, and the phase label stops being true.`,
    };
  }

  const entry = entries.find((e) => candidate.id === `commit-${e.id}`);
  const dueIn = entry?.dueAt === undefined ? 0 : (entry.dueAt - now) / DAY;
  return {
    source: "commitment",
    subject: "you said you would",
    matters: "You promised it, with a date.",
    // "The date has passed" on something due tomorrow is the kind of small
    // lie that costs an assistant its credibility permanently.
    // Rounded rather than floored: a commitment due in 23 hours and 59
    // minutes is due tomorrow, and an assistant that calls it "today" is
    // wrong in the direction that erodes trust fastest.
    now:
      Math.round(dueIn) >= 1
        ? `Due in ${Math.round(dueIn)} day${Math.round(dueIn) === 1 ? "" : "s"} — today is the last day it can be done unhurried.`
        : dueIn >= 0
          ? "Due today."
          : `${Math.max(1, Math.round(-dueIn))} day${Math.max(1, Math.round(-dueIn)) === 1 ? "" : "s"} past the date you gave.`,
    ifDelayed: "A missed commitment is the cheapest possible way to lose trust.",
  };
}

/** How many recent briefs listed this and were followed by no resolution. */
function appearancesOf(key: string, history: BriefRecord[]): number {
  let count = 0;
  for (const record of [...history].sort((a, b) => b.at - a.at)) {
    if (!record.itemKeys.includes(key)) break;
    count += 1;
  }
  return count;
}

export function buildBrief(input: BriefInput): Brief {
  const { now, cases, entries, capacity, history } = input;

  const products = input.products.map((p) => productView(p, entries, now));
  const caseById = new Map(cases.map((c) => [c.id, c]));

  // Realistic capacity: what is left after the calendar, when there is one.
  const realisticHours =
    capacity.bookedHours === null
      ? capacity.plannedHours
      : Math.max(0, capacity.plannedHours - capacity.bookedHours);

  const note =
    input.capacityNote ??
    (capacity.bookedHours === null
      ? "No calendar connected, so this is the time you said you had — not time anyone has checked against your day."
      : capacity.bookedHours > capacity.plannedHours * 0.5
        ? `Your calendar already holds ${capacity.bookedHours}h of the ${capacity.plannedHours}h you planned. Most of today is already spoken for.`
        : `${capacity.bookedHours}h already booked, leaving ${realisticHours}h.`);

  const context: Context = {
    ...DEFAULT_CONTEXT,
    ...input.context,
    capacityHours: realisticHours,
  };
  const weights = input.weights ?? DEFAULT_WEIGHTS;

  const candidates = [
    ...candidatesFromCases(cases),
    ...blockerCandidates(products, now),
    ...commitmentCandidates(entries, now),
  ];

  const ranked = rankWeek(candidates, weights, context);

  const items: BriefItem[] = [];
  const deferred: Deferred[] = [];
  let committedMinutes = 0;

  for (const scored of ranked) {
    const candidate = scored.candidate;
    const test = qualifies(candidate, caseById, products);

    if (!test.ok) {
      deferred.push({ key: candidate.id, title: candidate.title, reason: test.reason });
      continue;
    }
    if (!scored.chosen) {
      deferred.push({
        key: candidate.id,
        title: candidate.title,
        reason:
          scored.score <= 0
            ? "it scored negative — it feels like work and changes nothing"
            : `there is no room left today: it needs ${candidate.hours}h`,
      });
      continue;
    }

    committedMinutes += candidate.hours * 60;
    items.push({
      key: candidate.id,
      title: candidate.title,
      minutes: Math.round(candidate.hours * 60),
      appearances: appearancesOf(candidate.id, history),
      ...explain(candidate, caseById, products, entries, now),
    });
  }

  // ── Advisories ───────────────────────────────────────────────────────
  const advisories = advise(products, entries, now);

  // An untested hypothesis past its shelf life is its own finding: the
  // business is running on an assumption nobody has been near.
  for (const hypothesis of untestedHypotheses(entries, now).slice(0, 2)) {
    advisories.push({
      id: `adv-${hypothesis.id}-untested`,
      subject: hypothesis.subject,
      rule: "untested-hypothesis",
      recommendation: `Design the cheapest test of: "${hypothesis.text}"`,
      reason: `It has been carried ${Math.round((now - hypothesis.at) / DAY)} days without being tested, and work has been planned around it.`,
      evidence: (hypothesis.evidence ?? []).filter((ref) => {
        const cited = entries.find((e) => e.id === ref);
        return cited !== undefined && cited.kind !== "hypothesis";
      }),
      expectedBenefit: "Either the assumption becomes a fact or it stops steering the roadmap.",
      tradeOff: "Testing it may invalidate work already done on its basis.",
      wouldChangeIf: "The hypothesis is tested, or is explicitly retired.",
      confidence: confidenceOf(hypothesis, entries, now),
      weight: 3.5,
    });
  }

  // ── Horizons ─────────────────────────────────────────────────────────
  // Today is only meaningful if it connects upward. One line per active
  // product, drawn from the top item that belongs to it.
  const horizons: HorizonLink[] = products
    .filter((p) => p.active)
    .map((product) => {
      const item = items.find((i) => i.subject === product.name);
      return {
        today: item ? item.title : `Nothing today moves ${product.name}.`,
        week: product.objective,
        phase: `${product.milestone.name} — ${product.metConditions}/${product.totalConditions} conditions evidenced`,
      };
    });

  // Say out loud which product today's blocker hour went to. Silently
  // choosing one and showing the result would look like an oversight rather
  // than the deliberate refusal to split a day that it is.
  const focus = focusProduct(products);
  const alsoBlocked = products.filter(
    (p) => p.active && p.releaseBlockers.length > 0 && p.id !== focus?.id,
  );

  return {
    at: now,
    focus: focus
      ? {
          productName: focus.name,
          note: alsoBlocked.length
            ? `${focus.name} gets today's blocker time — it has carried its blockers longest. ${alsoBlocked
                .map((p) => p.name)
                .join(" and ")} ${alsoBlocked.length === 1 ? "is" : "are"} also blocked, and splitting a day across both reliably unsticks neither.`
            : `${focus.name} is the only product with a release blocker open.`,
        }
      : null,
    greeting: greetingFor(input.localHour ?? new Date(now).getHours(), input.operator),
    capacity: { plannedHours: capacity.plannedHours, realisticHours, note },
    items,
    committedMinutes: Math.round(committedMinutes),
    deferred,
    waitingCount: cases.filter((c) => c.turn === "theirs" || c.turn === "scheduled").length,
    // Three briefs is a pattern; two is a busy week.
    avoided: items.filter((i) => i.appearances >= 3),
    advisories: rank(advisories),
    horizons,
    productViews: products,
  };
}

// ── Notification relevance ───────────────────────────────────────────────

export interface Notifiable {
  requiresDecision: boolean;
  requiresAction: boolean;
  changesPlan: boolean;
  createsRisk: boolean;
  timeSensitive: boolean;
}

/**
 * The gate between an alert and a digest line.
 *
 * An assistant that interrupts for everything is a notification service, and
 * gets muted within a week — at which point it stops working for the things
 * that did matter. Two of the five tests must pass to earn an interruption;
 * everything else waits for the digest, where it is still not lost.
 */
export function shouldInterrupt(signal: Notifiable): boolean {
  const passed = [
    signal.requiresDecision,
    signal.requiresAction,
    signal.changesPlan,
    signal.createsRisk,
    signal.timeSensitive,
  ].filter(Boolean).length;
  return passed >= 2;
}

/** What the assistant knows about a product, in one block, for a model. */
export function renderProductForPrompt(product: ProductView, entries: Entry[], now: number): string {
  const known = select(entries, { subject: product.id }, now);
  return [
    `PRODUCT: ${product.name}`,
    `Phase: ${product.phase} (${Math.round(product.phaseDays)} days)`,
    `Objective: ${product.objective}`,
    `Working: ${product.working.map((c) => c.name).join(", ") || "nothing recorded"}`,
    `Blocked: ${product.openBlockers.map((b) => b.name).join(", ") || "nothing open"}`,
    `Milestone: ${product.milestone.name} — ${product.metConditions}/${product.totalConditions} conditions evidenced`,
    known.length ? `Known: ${known.map((e) => `[${e.kind}] ${e.text}`).join(" | ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
