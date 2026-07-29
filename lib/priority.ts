/**
 * The attention engine.
 *
 * A one-person business always has more candidates than hours. Something
 * ranks them. Left alone, that something is whichever thing shouted loudest
 * this morning — which is a ranking function, just an unexamined one.
 *
 * This makes it explicit: candidates in, scored against factors you can see,
 * weighted by dials you control, cut to the hours you actually have. Then it
 * tells you what your own weights are optimising for, because the failure mode
 * is not picking wrong — it is picking urgently, every week, and never
 * noticing that nothing compounded.
 *
 * The shape is deliberately the same as a recommender's: candidates → factor
 * scores → weighted sum → selection under a budget. The difference is that
 * every number here is legible and yours to change.
 */

// ── Factors ──────────────────────────────────────────────────────────────

export type Polarity = 1 | -1;

export interface Factor {
  key: string;
  label: string;
  /** What a high score on this factor means, in the operator's language. */
  meaning: string;
  polarity: Polarity;
  /** Default weight. Every one of these is an opinion you can overrule. */
  weight: number;
  group: "money" | "time" | "compounding" | "cost";
}

export const FACTORS: Factor[] = [
  {
    key: "revenue",
    label: "Revenue impact",
    meaning: "Moves money this quarter, directly.",
    polarity: 1,
    weight: 3,
    group: "money",
  },
  {
    key: "obligation",
    label: "Owed to someone",
    meaning: "A person is waiting. Costs trust, not cash.",
    polarity: 1,
    weight: 2.2,
    group: "money",
  },
  {
    key: "decay",
    label: "Decays if delayed",
    meaning: "Worth measurably less next week than today.",
    polarity: 1,
    weight: 2,
    group: "time",
  },
  {
    key: "unblocks",
    label: "Unblocks other work",
    meaning: "Something else cannot start until this lands.",
    polarity: 1,
    weight: 1.8,
    group: "time",
  },
  {
    key: "leverage",
    label: "Compounds",
    meaning: "Pays again every week after this one — a system, not a task.",
    polarity: 1,
    weight: 2.6,
    group: "compounding",
  },
  {
    key: "learning",
    label: "Reduces uncertainty",
    meaning: "You find out something that changes later decisions.",
    polarity: 1,
    weight: 1.4,
    group: "compounding",
  },
  {
    key: "effort",
    label: "Effort",
    meaning: "Hours and drag. Counts against.",
    polarity: -1,
    weight: -1.2,
    group: "cost",
  },
  {
    key: "irreversible",
    label: "Hard to undo",
    meaning: "Expensive to reverse if the call was wrong. Counts against acting fast.",
    polarity: -1,
    weight: -1.6,
    group: "cost",
  },
  {
    key: "theatre",
    label: "Urgency theatre",
    meaning:
      "Feels urgent, changes nothing. The single most reliable way a week disappears.",
    polarity: -1,
    weight: -2.4,
    group: "cost",
  },
];

export type WeightMap = Record<string, number>;

export const DEFAULT_WEIGHTS: WeightMap = Object.fromEntries(
  FACTORS.map((f) => [f.key, f.weight]),
);

// ── Operator context ─────────────────────────────────────────────────────

/**
 * The situation you are ranking inside. These do not score candidates; they
 * bend the weights — the same task is worth more or less depending on whether
 * you have four months of runway or forty.
 */
export interface Context {
  /** 0 = comfortable, 1 = the money runs out soon. */
  runwayPressure: number;
  /** 0 = protect what exists, 1 = grow at any cost. */
  growthAppetite: number;
  /** Hours you will genuinely give this week. Not the hours you wish you had. */
  capacityHours: number;
}

export const DEFAULT_CONTEXT: Context = {
  runwayPressure: 0.35,
  growthAppetite: 0.6,
  capacityHours: 24,
};

/**
 * Context bends weights rather than scores.
 *
 * Under real runway pressure, revenue dominates and compounding work — which
 * is right in the abstract — stops being affordable. That is not a bug in
 * prioritisation, it is what being short of money means.
 */
export function effectiveWeights(weights: WeightMap, context: Context): WeightMap {
  const bent = { ...weights };
  bent.revenue = (bent.revenue ?? 0) * (1 + context.runwayPressure * 1.1);
  bent.leverage = (bent.leverage ?? 0) * (1 + context.growthAppetite * 0.5 - context.runwayPressure * 0.55);
  bent.learning = (bent.learning ?? 0) * (1 + context.growthAppetite * 0.4);
  bent.obligation = (bent.obligation ?? 0) * (1 + (1 - context.growthAppetite) * 0.35);
  return bent;
}

// ── Candidates ───────────────────────────────────────────────────────────

export type CandidateSource = "loop" | "pipeline" | "delivery" | "cash" | "admin" | "manual";

export interface Candidate {
  id: string;
  title: string;
  source: CandidateSource;
  /** Where it came from, in words. Shown so a ranking is never anonymous. */
  origin: string;
  /** Factor scores, 0..1. */
  factors: Record<string, number>;
  /** Honest estimate of hours. The budget is spent in these. */
  hours: number;
}

export const SOURCE_LABEL: Record<CandidateSource, string> = {
  loop: "Loop",
  pipeline: "Pipeline",
  delivery: "Delivery",
  cash: "Cash",
  admin: "Admin",
  manual: "Added by you",
};

function f(
  revenue: number,
  obligation: number,
  decay: number,
  unblocks: number,
  leverage: number,
  learning: number,
  effort: number,
  irreversible: number,
  theatre: number,
): Record<string, number> {
  return { revenue, obligation, decay, unblocks, leverage, learning, effort, irreversible, theatre };
}

/**
 * A sample week, drawn from the seven processes a solo business actually
 * repeats. Real candidates from the Loops Engine are merged on top of these —
 * see `candidatesFromRuns`.
 */
export const SAMPLE_CANDIDATES: Candidate[] = [
  {
    id: "c-invoice",
    title: "Chase the two invoices 40 days overdue",
    source: "cash",
    origin: "Cash · unpaid since last month",
    factors: f(0.95, 0.3, 0.7, 0.2, 0.1, 0.1, 0.15, 0.1, 0.05),
    hours: 1,
  },
  {
    id: "c-proposal",
    title: "Send the proposal the prospect asked for on Friday",
    source: "pipeline",
    origin: "Pipeline · asked for it, waiting",
    factors: f(0.85, 0.9, 0.85, 0.1, 0.15, 0.2, 0.3, 0.2, 0.05),
    hours: 3,
  },
  {
    id: "c-delivery",
    title: "Finish the client build due Thursday",
    source: "delivery",
    origin: "Delivery · committed date",
    factors: f(0.7, 0.95, 0.9, 0.3, 0.1, 0.1, 0.9, 0.3, 0.05),
    hours: 10,
  },
  {
    id: "c-onboarding",
    title: "Automate the client onboarding you do by hand every time",
    source: "delivery",
    origin: "Delivery · repeated manually 6 times",
    factors: f(0.2, 0.05, 0.05, 0.5, 0.95, 0.3, 0.6, 0.15, 0.02),
    hours: 6,
  },
  {
    id: "c-content",
    title: "Approve this week's three drafted posts",
    source: "loop",
    origin: "Loop · Content Engine, held at its gate",
    factors: f(0.25, 0.2, 0.6, 0.4, 0.55, 0.15, 0.1, 0.1, 0.1),
    hours: 0.5,
  },
  {
    id: "c-pricing",
    title: "Decide whether to raise prices for new clients",
    source: "manual",
    origin: "Added by you · has moved three weeks running",
    factors: f(0.8, 0.05, 0.3, 0.35, 0.85, 0.6, 0.4, 0.85, 0.05),
    hours: 2,
  },
  {
    id: "c-inbox",
    title: "Clear the inbox to zero",
    source: "admin",
    origin: "Admin · feels urgent every morning",
    factors: f(0.05, 0.25, 0.15, 0.1, 0.05, 0.05, 0.5, 0.02, 0.9),
    hours: 2,
  },
  {
    id: "c-rebrand",
    title: "Redesign the website header",
    source: "admin",
    origin: "Admin · nobody asked for this",
    factors: f(0.05, 0.02, 0.05, 0.05, 0.1, 0.05, 0.7, 0.1, 0.85),
    hours: 5,
  },
  {
    id: "c-followup",
    title: "Follow up with the four prospects who went quiet",
    source: "pipeline",
    origin: "Pipeline · no contact in 14 days",
    factors: f(0.65, 0.3, 0.8, 0.1, 0.35, 0.4, 0.2, 0.05, 0.1),
    hours: 1.5,
  },
  {
    id: "c-review",
    title: "Run the weekly business review",
    source: "loop",
    origin: "Loop · Weekly Business Review, due Monday",
    factors: f(0.15, 0.05, 0.4, 0.55, 0.7, 0.75, 0.15, 0.05, 0.15),
    hours: 1,
  },
  {
    id: "c-renewal",
    title: "Cancel the three subscriptions nobody uses",
    source: "admin",
    origin: "Admin · renews in 9 days",
    factors: f(0.3, 0.02, 0.75, 0.05, 0.2, 0.05, 0.2, 0.25, 0.15),
    hours: 0.5,
  },
  {
    id: "c-case",
    title: "Write up the case study from the project that went well",
    source: "pipeline",
    origin: "Pipeline · asset you do not have yet",
    factors: f(0.4, 0.05, 0.2, 0.15, 0.9, 0.35, 0.5, 0.05, 0.1),
    hours: 4,
  },
];

// ── Scoring ──────────────────────────────────────────────────────────────

export interface Scored {
  candidate: Candidate;
  /** Raw weighted sum before the hours budget is considered. */
  score: number;
  /** Score per hour — what the selector actually optimises. */
  density: number;
  /** Per-factor contribution, so any ranking can be taken apart. */
  contributions: Array<{ key: string; label: string; value: number }>;
  /** True when it made the cut for this week. */
  chosen: boolean;
}

export function scoreCandidate(
  candidate: Candidate,
  weights: WeightMap,
  context: Context,
): Omit<Scored, "chosen"> {
  const bent = effectiveWeights(weights, context);

  const contributions = FACTORS.map((factor) => ({
    key: factor.key,
    label: factor.label,
    value: (candidate.factors[factor.key] ?? 0) * (bent[factor.key] ?? 0),
  }));

  const score = contributions.reduce((sum, c) => sum + c.value, 0);

  return {
    candidate,
    score,
    // Guard against a zero-hour candidate dividing to Infinity.
    density: score / Math.max(candidate.hours, 0.25),
    contributions,
  };
}

/**
 * Rank, then fill the week.
 *
 * Selection is greedy by score-per-hour rather than by score, because the
 * constraint is hours. Picking the highest-scoring item first is how a single
 * ten-hour job eats a week that could have held six better ones.
 *
 * Deliberately greedy rather than optimal: an exact knapsack would reorder the
 * list in ways that are hard to explain, and a plan you do not believe is a
 * plan you do not follow.
 */
export function rankWeek(
  candidates: Candidate[],
  weights: WeightMap,
  context: Context,
): Scored[] {
  const scored = candidates
    .map((candidate) => scoreCandidate(candidate, weights, context))
    .sort((a, b) => b.density - a.density);

  let remaining = context.capacityHours;
  return scored.map((item) => {
    const fits = item.score > 0 && item.candidate.hours <= remaining;
    if (fits) remaining -= item.candidate.hours;
    return { ...item, chosen: fits };
  });
}

// ── The honest readout ───────────────────────────────────────────────────

export interface Verdict {
  /** Hours committed versus hours available. */
  committedHours: number;
  capacityHours: number;
  /** Share of the chosen week's positive score coming from each group. */
  mix: Record<Factor["group"], number>;
  /** The sentence that is actually worth reading. */
  headline: string;
}

/**
 * What your weights are optimising for.
 *
 * This is the part with teeth. Anyone can rank a list; almost nobody notices
 * that the same list, ranked the same way, has produced a year of urgent weeks
 * and no compounding. The mix is measured over the *chosen* week, because
 * intentions live in the weights and behaviour lives in what got picked.
 */
export function verdict(ranked: Scored[], context: Context): Verdict {
  const chosen = ranked.filter((r) => r.chosen);
  const committedHours = chosen.reduce((sum, r) => sum + r.candidate.hours, 0);

  const mix: Record<Factor["group"], number> = {
    money: 0,
    time: 0,
    compounding: 0,
    cost: 0,
  };

  let positive = 0;
  for (const item of chosen) {
    for (const contribution of item.contributions) {
      const group = FACTORS.find((f) => f.key === contribution.key)?.group;
      if (!group || contribution.value <= 0) continue;
      mix[group] += contribution.value;
      positive += contribution.value;
    }
  }

  if (positive > 0) {
    for (const key of Object.keys(mix) as Array<Factor["group"]>) {
      mix[key] = mix[key] / positive;
    }
  }

  const headline =
    chosen.length === 0
      ? "Nothing cleared the bar. Either the weights are too harsh or the week is genuinely empty."
      : mix.compounding < 0.15
        ? `Only ${Math.round(mix.compounding * 100)}% of this week compounds. It will pay off and leave you exactly where you started.`
        : mix.time > 0.45
          ? `${Math.round(mix.time * 100)}% of this week is driven by deadlines rather than value. That is a reactive week, whoever set the deadlines.`
          : mix.money > 0.5
            ? `This week is ${Math.round(mix.money * 100)}% money and obligation — correct under pressure, unsustainable as a habit.`
            : `A balanced week: ${Math.round(mix.compounding * 100)}% of it compounds.`;

  return { committedHours, capacityHours: context.capacityHours, mix, headline };
}

// ── Live candidates ──────────────────────────────────────────────────────

interface RunLike {
  id: string;
  loopId: string;
  status: string;
  artifacts?: unknown[];
}

/**
 * Turn real Loops Engine state into candidates.
 *
 * A loop holding at its gate is genuinely competing for the week, and it is
 * the cheapest high-value item on any list — the work is already done and it
 * decays, because approving Monday's posts on Friday is worth much less.
 */
export function candidatesFromRuns(
  runs: RunLike[],
  loopNames: Record<string, string>,
): Candidate[] {
  return runs
    .filter((run) => run.status === "awaiting-go" || run.status === "failed")
    .slice(0, 8)
    .map((run) => {
      const name = loopNames[run.loopId] ?? run.loopId;
      const gated = run.status === "awaiting-go";

      return {
        id: `run-${run.id}`,
        title: gated ? `Approve or reject: ${name}` : `Fix the failed run: ${name}`,
        source: "loop" as const,
        origin: gated
          ? `Loop · ${name}, holding at its gate`
          : `Loop · ${name}, failed and not retried`,
        factors: gated
          ? f(0.3, 0.15, 0.75, 0.5, 0.6, 0.15, 0.08, 0.1, 0.05)
          : f(0.2, 0.1, 0.5, 0.7, 0.5, 0.3, 0.3, 0.05, 0.1),
        hours: gated ? 0.25 : 1,
      };
    });
}
