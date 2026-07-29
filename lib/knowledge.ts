/**
 * Typed memory.
 *
 * The assistant is only trustworthy because the layer under it knows the
 * difference between a fact, a decision, a hypothesis and a guess. A store
 * that flattens those into "notes" produces advice that sounds identical
 * whether it rests on an observation or on something the operator wondered
 * aloud six weeks ago — and there is no way to tell which from the output.
 *
 * So the distinction is not a label here. It is enforced:
 *
 *   - A **hypothesis can never be evidence.** Not for a fact, not for a
 *     recommendation. Only for another hypothesis, which is what a chain of
 *     reasoning looks like before anything is tested.
 *   - A **recommendation can never be evidence.** Advice built on advice is
 *     how a system talks itself into a position nobody checked.
 *   - **Confidence is capped by the weakest link.** A recommendation resting
 *     on inferred facts cannot claim high confidence, whatever it says about
 *     itself.
 *   - **Everything goes stale.** A fact about a moving codebase is not a fact
 *     three weeks later; it is a memory of one. Staleness is per kind and is
 *     visible rather than silently trusted.
 *
 * `validate` returns the violations. It is run in tests and by the API, so a
 * malformed chain cannot reach the operator wearing the same face as a sound
 * one.
 */

// ── Kinds ────────────────────────────────────────────────────────────────

export type Kind =
  /** Observably true. "G8's production worker is not deployed." */
  | "fact"
  /** A choice that was made. "Broad UI expansion is paused." */
  | "decision"
  /** A belief not yet tested. "Petroleum distribution may be the wedge." */
  | "hypothesis"
  /** How the operator wants to work. Constrains; never justifies. */
  | "preference"
  /** A promise with a date attached. */
  | "commitment"
  /** Output of the advisory layer. Never an input to it. */
  | "recommendation";

export const KIND_LABEL: Record<Kind, string> = {
  fact: "Fact",
  decision: "Decision",
  hypothesis: "Hypothesis",
  preference: "Preference",
  commitment: "Commitment",
  recommendation: "Recommendation",
};

/** Spelled out rather than suffixed, because "hypothesiss" is not a word. */
export const KIND_PLURAL: Record<Kind, string> = {
  fact: "Facts",
  decision: "Decisions",
  hypothesis: "Hypotheses",
  preference: "Preferences",
  commitment: "Commitments",
  recommendation: "Recommendations",
};

/**
 * How the entry came to be known. Ordered — `strength` below depends on it.
 *
 * `guessed` exists so that a guess can be *recorded* rather than laundered
 * into a fact by having nowhere else to put it.
 */
export type Provenance = "observed" | "stated" | "inferred" | "guessed";

export const STRENGTH: Record<Provenance, number> = {
  observed: 3,
  stated: 2,
  inferred: 1,
  guessed: 0,
};

export type Confidence = "high" | "medium" | "low" | "none";

/** How long an entry of each kind stays current, in days. */
export const SHELF_LIFE: Record<Kind, number> = {
  // Software moves. A three-week-old observation about a build is history.
  fact: 21,
  decision: 90,
  // An untested hypothesis past a month is itself a finding.
  hypothesis: 30,
  preference: 365,
  // Commitments expire on their own date; this is the fallback.
  commitment: 30,
  recommendation: 7,
};

export interface Entry {
  id: string;
  kind: Kind;
  /** Product id, case id, or "business". Scopes every question asked of it. */
  subject: string;
  text: string;
  at: number;
  provenance: Provenance;
  /** Ids of entries this rests on. Validated against the mixing rules. */
  evidence?: string[];
  /** Commitments and dated hypotheses. */
  dueAt?: number;
  /** Set when a later entry replaces this one. Nothing is ever deleted. */
  supersededBy?: string;
  /** Free-form origin: a URL, a person, a commit, a conversation. */
  origin?: string;
}

// ── The mixing rules ─────────────────────────────────────────────────────

/**
 * What each kind is allowed to rest on.
 *
 * Read the empty arrays as the load-bearing part: a hypothesis supports
 * nothing but further hypotheses, and a recommendation supports nothing at
 * all. Everything else in this file follows from those two rows.
 */
export const MAY_CITE: Record<Kind, Kind[]> = {
  fact: ["fact"],
  decision: ["fact", "decision", "preference", "commitment"],
  hypothesis: ["fact", "decision", "hypothesis", "commitment"],
  preference: [],
  commitment: ["fact", "decision"],
  recommendation: ["fact", "decision", "commitment", "preference"],
};

export interface Problem {
  entryId: string;
  message: string;
}

export function validate(entries: Entry[]): Problem[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const problems: Problem[] = [];

  for (const entry of entries) {
    for (const ref of entry.evidence ?? []) {
      const cited = byId.get(ref);
      if (!cited) {
        problems.push({ entryId: entry.id, message: `cites ${ref}, which does not exist` });
        continue;
      }
      if (cited.id === entry.id) {
        problems.push({ entryId: entry.id, message: "cites itself" });
        continue;
      }
      if (!MAY_CITE[entry.kind].includes(cited.kind)) {
        problems.push({
          entryId: entry.id,
          message: `a ${entry.kind} may not rest on a ${cited.kind} — "${cited.text.slice(0, 60)}"`,
        });
      }
    }

    if (entry.kind === "commitment" && entry.dueAt === undefined) {
      // A promise with no date is a wish, and gets treated like one elsewhere.
      problems.push({ entryId: entry.id, message: "a commitment with no date is not a commitment" });
    }
  }

  // Cycles would make confidence non-terminating and, more importantly, mean
  // the reasoning is circular.
  for (const entry of entries) {
    const seen = new Set<string>();
    const walk = (id: string): boolean => {
      if (seen.has(id)) return true;
      seen.add(id);
      return (byId.get(id)?.evidence ?? []).some(walk);
    };
    if ((entry.evidence ?? []).some(walk)) {
      problems.push({ entryId: entry.id, message: "its evidence chain is circular" });
    }
  }

  return problems;
}

// ── Currency and confidence ──────────────────────────────────────────────

const DAY = 86_400_000;

export function isStale(entry: Entry, now: number): boolean {
  if (entry.supersededBy) return true;
  const limit = entry.dueAt ?? entry.at + SHELF_LIFE[entry.kind] * DAY;
  return now > limit;
}

export function ageDays(entry: Entry, now: number): number {
  return Math.max(0, (now - entry.at) / DAY);
}

/**
 * Confidence, derived rather than declared.
 *
 * Two things drag it down and neither can be argued with: how the entry was
 * come by, and how strong the weakest thing under it is. A stale entry drops
 * a level regardless, because age is not neutral.
 */
export function confidenceOf(entry: Entry, entries: Entry[], now: number): Confidence {
  const byId = new Map(entries.map((e) => [e.id, e]));

  const strengthOf = (target: Entry, depth = 0): number => {
    if (depth > 6) return 0;
    let score = STRENGTH[target.provenance];
    for (const ref of target.evidence ?? []) {
      const cited = byId.get(ref);
      if (!cited) return 0;
      score = Math.min(score, strengthOf(cited, depth + 1));
    }
    return score;
  };

  let score = strengthOf(entry);
  if (isStale(entry, now)) score -= 1;
  // Advice resting on nothing is a hunch with a template around it.
  if (entry.kind === "recommendation" && (entry.evidence ?? []).length === 0) score -= 1;

  if (score >= 3) return "high";
  if (score === 2) return "medium";
  if (score >= 0) return "low";
  return "none";
}

// ── Reading ──────────────────────────────────────────────────────────────

export interface Query {
  subject?: string;
  kind?: Kind | Kind[];
  /** Drop stale and superseded entries. Default true. */
  current?: boolean;
}

export function select(entries: Entry[], query: Query, now: number): Entry[] {
  const kinds = query.kind === undefined ? null : ([] as Kind[]).concat(query.kind);
  return entries
    .filter((e) => (query.subject ? e.subject === query.subject : true))
    .filter((e) => (kinds ? kinds.includes(e.kind) : true))
    .filter((e) => (query.current === false ? true : !isStale(e, now)))
    .sort((a, b) => b.at - a.at);
}

/** Commitments that have not been met and are close, or past, their date. */
export function commitmentsAtRisk(
  entries: Entry[],
  now: number,
  withinDays = 3,
): Array<{ entry: Entry; overdueDays: number }> {
  return entries
    .filter((e) => e.kind === "commitment" && !e.supersededBy && e.dueAt !== undefined)
    .map((entry) => ({ entry, overdueDays: (now - (entry.dueAt as number)) / DAY }))
    .filter((row) => row.overdueDays > -withinDays)
    .sort((a, b) => b.overdueDays - a.overdueDays);
}

/**
 * Hypotheses that have sat untested past their shelf life.
 *
 * Worth surfacing on its own: a business running on month-old untested
 * assumptions is not short of ideas, it is short of contact with reality.
 */
export function untestedHypotheses(entries: Entry[], now: number): Entry[] {
  return entries
    .filter((e) => e.kind === "hypothesis" && !e.supersededBy && isStale(e, now))
    .sort((a, b) => a.at - b.at);
}

// ── Rendering for a model ────────────────────────────────────────────────

/**
 * The block handed to a model when one is asked to phrase something.
 *
 * Kinds are labelled and kept apart, and confidence is stated per line, so
 * the model cannot flatten a hypothesis into a fact simply because both
 * arrived as sentences.
 */
export function renderForPrompt(entries: Entry[], now: number): string {
  if (entries.length === 0) return "";
  const groups: Kind[] = ["fact", "decision", "commitment", "preference", "hypothesis"];

  const sections = groups
    .map((kind) => {
      const rows = entries.filter((e) => e.kind === kind && !isStale(e, now));
      if (rows.length === 0) return "";
      const lines = rows.map(
        (e) => `- ${e.text} [${confidenceOf(e, entries, now)}, ${e.provenance}]`,
      );
      return [
        `${KIND_PLURAL[kind].toUpperCase()} — treat as ${kind}, not as anything else:`,
        ...lines,
      ].join("\n");
    })
    .filter(Boolean);

  if (sections.length === 0) return "";

  return [
    "WHAT IS KNOWN. These categories are not interchangeable.",
    "A hypothesis is not a fact. Never state one as the other, and never invent an entry that is not below.",
    "",
    ...sections,
  ].join("\n");
}
