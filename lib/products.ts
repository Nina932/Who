/**
 * Product state, and the rules that notice when it stops moving.
 *
 * A case is one commitment. A product is a longer object: a thing being built
 * over months, which can appear busy every single week and still be in exactly
 * the same place. That is the failure this file exists to catch, because it is
 * invisible from any daily view — the days all look productive.
 *
 * So the drift rules are all comparisons across time rather than snapshots:
 * how long has this phase held, how long has this blocker been carried, was
 * surface added *after* the blocker opened, did the recent work map to the
 * milestone anyone agreed to. Each one is a readable condition that produces a
 * falsifiable advisory, never a vibe.
 */

import { advisoryConfidence, type Advisory } from "./advisory";
import { isStale, select, type Entry } from "./knowledge";

const DAY = 86_400_000;

// ── Shape ────────────────────────────────────────────────────────────────

/**
 * Where a product is in its life. Ordered — `PHASES.indexOf` is used to spot a
 * product that has gone backwards, which is legitimate but worth saying aloud.
 */
export const PHASES = [
  "exploration",
  "build",
  "execution-hardening",
  "pre-release-productization",
  "commercial-validation",
  "scaling",
  "paused",
] as const;

export type Phase = (typeof PHASES)[number];

export const PHASE_LABEL: Record<Phase, string> = {
  exploration: "Exploration",
  build: "Build",
  "execution-hardening": "Execution hardening",
  "pre-release-productization": "Pre-release productization",
  "commercial-validation": "Commercial validation",
  scaling: "Scaling",
  paused: "Paused",
};

/** How long a phase can reasonably hold before the holding is the story. */
export const PHASE_PATIENCE_DAYS: Record<Phase, number> = {
  exploration: 30,
  build: 60,
  "execution-hardening": 35,
  "pre-release-productization": 35,
  "commercial-validation": 45,
  scaling: 120,
  paused: 9999,
};

export interface Capability {
  name: string;
  /** When it started working. Used to spot expansion under a blocker. */
  at: number;
  /** Does a customer ever see this? Drives the commercial-motion rule. */
  customerFacing?: boolean;
}

export interface Blocker {
  id: string;
  name: string;
  openedAt: number;
  resolvedAt?: number;
  /** True when it stops a release rather than merely slowing work. */
  release?: boolean;
}

/**
 * What must be true to leave the current phase.
 *
 * Written down in advance, and each one either has evidence behind it or does
 * not. This is what makes "are we still working toward the milestone?" a
 * question with an answer rather than a conversation.
 */
export interface ExitCondition {
  id: string;
  text: string;
  /** Entry ids that demonstrate it. An empty list means claimed, not shown. */
  evidence: string[];
}

export interface Milestone {
  name: string;
  dueAt?: number;
  exit: ExitCondition[];
}

export interface Product {
  id: string;
  name: string;
  phase: Phase;
  /** When the product entered this phase. The clock for `phase-stalled`. */
  phaseSince: number;
  objective: string;
  working: Capability[];
  blockers: Blocker[];
  milestone: Milestone;
  /** Set when the operator has deliberately parked it. */
  archived?: boolean;
  demo?: boolean;
}

// ── Derived state ────────────────────────────────────────────────────────

export interface ProductView extends Product {
  phaseDays: number;
  openBlockers: Blocker[];
  releaseBlockers: Blocker[];
  /** Age of the longest-carried open blocker, in days. */
  oldestBlockerDays: number;
  /** Exit conditions with at least one piece of live evidence behind them. */
  metConditions: number;
  totalConditions: number;
  /** True when the product is being actively worked. */
  active: boolean;
  advisories: Advisory[];
}

export function view(product: Product, entries: Entry[], now: number): ProductView {
  const openBlockers = product.blockers.filter((b) => !b.resolvedAt);
  const releaseBlockers = openBlockers.filter((b) => b.release);
  const byId = new Map(entries.map((e) => [e.id, e]));

  const met = product.milestone.exit.filter((condition) =>
    condition.evidence.some((ref) => {
      const entry = byId.get(ref);
      // Stale evidence does not demonstrate anything. A proof from six weeks
      // ago about a system that has changed since is not a proof.
      return entry !== undefined && !isStale(entry, now);
    }),
  ).length;

  return {
    ...product,
    phaseDays: (now - product.phaseSince) / DAY,
    openBlockers,
    releaseBlockers,
    oldestBlockerDays: openBlockers.length
      ? Math.max(...openBlockers.map((b) => (now - b.openedAt) / DAY))
      : 0,
    metConditions: met,
    totalConditions: product.milestone.exit.length,
    active: !product.archived && product.phase !== "paused",
    advisories: [],
  };
}

// ── Drift rules ──────────────────────────────────────────────────────────

/** How many products one person can genuinely carry at once. */
export const CONCURRENT_LIMIT = 2;

function facts(entries: Entry[], subject: string, now: number): Entry[] {
  return select(entries, { subject, kind: ["fact", "decision", "commitment"] }, now);
}

/**
 * Every rule takes the same shape: a readable condition, and an advisory that
 * says what would make it wrong. None of them consult a model.
 */
export function advise(
  products: ProductView[],
  entries: Entry[],
  now: number,
): Advisory[] {
  const out: Advisory[] = [];

  const push = (a: Omit<Advisory, "id" | "confidence">) =>
    out.push({
      ...a,
      id: `adv-${a.subject}-${a.rule}`,
      confidence: advisoryConfidence(a.evidence, entries, now),
    });

  for (const product of products) {
    if (!product.active) continue;
    const supporting = facts(entries, product.id, now).map((e) => e.id);

    // 1. A phase that has held longer than that phase reasonably holds.
    const patience = PHASE_PATIENCE_DAYS[product.phase];
    if (product.phaseDays > patience) {
      push({
        subject: product.id,
        rule: "phase-stalled",
        recommendation: `Either exit ${PHASE_LABEL[product.phase].toLowerCase()} on ${product.name} or restate the phase honestly.`,
        reason: `It has held this phase for ${Math.round(product.phaseDays)} days against a ${patience}-day expectation, with ${product.metConditions} of ${product.totalConditions} exit conditions evidenced.`,
        evidence: supporting.slice(0, 4),
        expectedBenefit: "The phase label starts describing reality again, so every plan built on it stops being wrong.",
        tradeOff: "Admitting the phase has not been left may mean re-scoping work already announced as nearly done.",
        wouldChangeIf: `${product.totalConditions - product.metConditions} remaining exit condition(s) gain evidence.`,
        weight: 3 + Math.min(3, (product.phaseDays - patience) / patience),
      });
    }

    // 2. A blocker carried rather than cleared. Three weeks is not a snag.
    const stubborn = product.openBlockers
      .map((b) => ({ b, days: (now - b.openedAt) / DAY }))
      .filter((row) => row.days > 14)
      .sort((a, b) => b.days - a.days)[0];

    if (stubborn) {
      push({
        subject: product.id,
        rule: "carried-blocker",
        recommendation: `Protect a repair block for "${stubborn.b.name}", or formally drop the claim it blocks.`,
        reason: `It has been open ${Math.round(stubborn.days)} days. A blocker carried this long is not being worked on; it is being worked around.`,
        evidence: supporting.slice(0, 4),
        expectedBenefit: "Either the blocker clears or the roadmap stops depending on something that is not happening.",
        tradeOff: "A protected repair block costs a day that feels less productive than shipping something visible.",
        wouldChangeIf: `"${stubborn.b.name}" is resolved, or is reclassified as not blocking the release.`,
        weight: 4 + Math.min(3, stubborn.days / 14),
      });
    }

    // 3. Surface added *after* a blocker opened. The most reliable tell that a
    //    team is avoiding the hard thing while remaining visibly busy.
    const blockerOpened = product.openBlockers.length
      ? Math.min(...product.openBlockers.map((b) => b.openedAt))
      : Infinity;
    const since = product.working.filter((c) => c.at > blockerOpened);

    if (product.openBlockers.length > 0 && since.length >= 2) {
      push({
        subject: product.id,
        rule: "expansion-under-blocker",
        recommendation: `Freeze new ${product.name} surfaces until "${product.openBlockers[0].name}" is cleared.`,
        reason: `${since.length} capabilities have shipped since that blocker opened — ${since.map((c) => c.name).join(", ")}. Breadth is growing while the thing that stops release is not.`,
        evidence: supporting.slice(0, 4),
        expectedBenefit: "Capacity concentrates on the one thing standing between the product and a release.",
        tradeOff: "Delays interface breadth, which is the visible kind of progress.",
        wouldChangeIf: "The blocker is cleared, or is shown not to gate anything a buyer needs.",
        weight: 5,
      });
    }

    // 4. A milestone nobody is actually working toward.
    if (product.totalConditions > 0 && product.metConditions === 0 && product.phaseDays > 21) {
      push({
        subject: product.id,
        rule: "milestone-unevidenced",
        recommendation: `Pick one exit condition for "${product.milestone.name}" and evidence it this week.`,
        reason: `Not one of the ${product.totalConditions} conditions has live evidence behind it after ${Math.round(product.phaseDays)} days in phase. The milestone is stated, not pursued.`,
        evidence: supporting.slice(0, 4),
        expectedBenefit: "One condition moving turns the milestone from a label into a position.",
        tradeOff: "Narrowing to one condition means openly deprioritising the others.",
        wouldChangeIf: "Any exit condition gains evidence that is not stale.",
        weight: 4,
      });
    }

    // 5. Technically moving, commercially stationary. Everything shipped is
    //    machinery nobody outside has ever touched.
    const recent = product.working.filter((c) => now - c.at < 45 * DAY);
    if (recent.length >= 3 && recent.every((c) => !c.customerFacing)) {
      push({
        subject: product.id,
        rule: "no-commercial-motion",
        recommendation: `Put one ${product.name} capability in front of a buyer before building the next one.`,
        reason: `All ${recent.length} capabilities shipped in the last six weeks are internal. The product is progressing technically and standing still commercially.`,
        evidence: supporting.slice(0, 4),
        expectedBenefit: "The primary uncertainty stops being technical and starts being answerable.",
        tradeOff: "Showing something unfinished risks a weaker first impression than waiting would.",
        wouldChangeIf: "A customer-facing capability ships, or a buyer conversation is recorded against this product.",
        weight: 4.5,
      });
    }
  }

  // 6. Too many live at once — a portfolio rule, not a product one.
  const live = products.filter((p) => p.active);
  if (live.length > CONCURRENT_LIMIT) {
    const ranked = [...live].sort((a, b) => b.releaseBlockers.length - a.releaseBlockers.length);
    push({
      subject: "business",
      rule: "too-many-active",
      recommendation: `Cut from ${live.length} active products to ${CONCURRENT_LIMIT} for the next two weeks. ${ranked[ranked.length - 1].name} is the candidate to park.`,
      reason: `One person cannot hold ${live.length} products in a phase that requires attention. The cost is not slower delivery on each; it is that none of them exits its phase.`,
      evidence: select(entries, { kind: ["fact", "decision"] }, now).slice(0, 3).map((e) => e.id),
      expectedBenefit: "The best available productivity gain, and the only one that does not require building anything.",
      tradeOff: "A parked product loses momentum and any context you were holding in your head.",
      wouldChangeIf: `A product reaches its milestone, or one is formally paused so it stops competing.`,
      weight: 6,
    });
  }

  return out;
}

// ── Examples ─────────────────────────────────────────────────────────────

/**
 * FinAI and G8, transcribed from the operator's own description rather than
 * invented. Marked `demo` because the dates are reconstructed — the states are
 * theirs, the timestamps are mine, and conflating those would be exactly the
 * kind of quiet fiction this system is built to refuse.
 */
export function exampleProducts(now: number): Product[] {
  const ago = (days: number) => now - days * DAY;

  return [
    {
      id: "finai",
      name: "FinAI",
      phase: "pre-release-productization",
      phaseSince: ago(48),
      objective: "Produce a buyer-ready paid-pilot slice.",
      demo: true,
      working: [
        { name: "Deterministic finance engine", at: ago(150) },
        { name: "Data lineage", at: ago(120) },
        { name: "Petroleum domain logic", at: ago(90) },
        { name: "Core reasoning workflow", at: ago(40) },
      ],
      blockers: [
        { id: "finai-pg", name: "Live PostgreSQL deployment proof", openedAt: ago(38), release: true },
        { id: "finai-auth", name: "Systemic aumorpheusity resolution", openedAt: ago(30) },
        { id: "finai-demo", name: "Commercial demo definition", openedAt: ago(26), release: true },
      ],
      milestone: {
        name: "One repeatable petroleum CFO demo",
        exit: [
          { id: "finai-x1", text: "A demo that runs end to end without intervention", evidence: [] },
          { id: "finai-x2", text: "Deployment proven against a live database", evidence: [] },
          { id: "finai-x3", text: "One buyer conversation held against the demo", evidence: [] },
        ],
      },
    },
    {
      id: "g8",
      name: "G8",
      phase: "execution-hardening",
      phaseSince: ago(41),
      objective: "Prove reliable production execution.",
      demo: true,
      working: [
        { name: "Durable execution", at: ago(110) },
        { name: "Sandbox isolation", at: ago(95) },
        { name: "Usage metering", at: ago(70) },
        { name: "Coding tools", at: ago(60) },
        // Three surfaces added after the worker blocker opened — the exact
        // pattern rule 3 is looking for.
        { name: "Run history surface", at: ago(20) },
        { name: "Settings surface", at: ago(12) },
        { name: "Templates surface", at: ago(5) },
      ],
      blockers: [
        { id: "g8-worker", name: "Production worker deployment", openedAt: ago(24), release: true },
        { id: "g8-pr", name: "Non-atomic PR publishing", openedAt: ago(18) },
        { id: "g8-quota", name: "Incomplete quota enforcement", openedAt: ago(16) },
      ],
      milestone: {
        name: "One public end-to-end execution journey",
        exit: [
          { id: "g8-x1", text: "A run completes on a deployed production worker", evidence: [] },
          { id: "g8-x2", text: "PR publishing is atomic", evidence: [] },
          { id: "g8-x3", text: "Quotas enforced end to end", evidence: [] },
        ],
      },
    },
  ];
}

/** The knowledge entries that go with the example products. */
export function exampleKnowledge(now: number): Entry[] {
  const ago = (days: number) => now - days * DAY;

  return [
    {
      id: "k-g8-worker",
      kind: "fact",
      subject: "g8",
      text: "G8's production worker is not deployed.",
      at: ago(3),
      provenance: "observed",
      origin: "deployment check",
    },
    {
      id: "k-g8-surfaces",
      kind: "fact",
      subject: "g8",
      text: "Three new surfaces shipped since the worker blocker opened.",
      at: ago(5),
      provenance: "observed",
    },
    {
      id: "k-g8-pause",
      kind: "decision",
      subject: "g8",
      text: "Broad UI expansion is paused until production execution is proven.",
      at: ago(2),
      provenance: "stated",
      evidence: ["k-g8-worker", "k-g8-surfaces"],
    },
    {
      id: "k-finai-nodb",
      kind: "fact",
      subject: "finai",
      text: "FinAI has no deployment proof against a live PostgreSQL instance.",
      at: ago(4),
      provenance: "observed",
    },
    {
      id: "k-finai-nobuyer",
      kind: "fact",
      subject: "finai",
      text: "No buyer conversation has been held against a FinAI demo.",
      at: ago(6),
      provenance: "observed",
    },
    {
      id: "k-finai-wedge",
      kind: "hypothesis",
      subject: "finai",
      // Deliberately old: it trips the untested-hypothesis rule, which is the
      // point of keeping hypotheses in a separate category at all.
      text: "Petroleum distribution is FinAI's strongest commercial wedge.",
      at: ago(44),
      provenance: "inferred",
      evidence: ["k-finai-nobuyer"],
    },
    {
      id: "k-finai-pilot",
      kind: "commitment",
      subject: "finai",
      text: "Prepare a buyer-ready paid-pilot offer.",
      at: ago(9),
      dueAt: now + 1 * DAY,
      provenance: "stated",
    },
    {
      id: "k-pref-no-taskman",
      kind: "preference",
      subject: "business",
      text: "No generic coding task manager. Advice must be specific to the product state.",
      at: ago(30),
      provenance: "stated",
    },
    {
      id: "k-market-governed",
      kind: "hypothesis",
      subject: "business",
      text: "Enterprise interest is moving from generic AI chat toward governed, traceable, domain-specific execution.",
      at: ago(12),
      provenance: "inferred",
    },
  ];
}
