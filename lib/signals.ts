/**
 * Technology and market intelligence, filtered rather than forwarded.
 *
 * A feed that tells you everything has added work, not removed it. The whole
 * value is in the *discarding*, and the rule that makes discarding safe is
 * this one:
 *
 *   **Relevance is measured against your current blocker first, your stack
 *   second, and your phase third.**
 *
 * A model with better tool-calling is genuinely interesting and is *not* act-
 * now when the thing stopping your release is worker deployment. That is not
 * a judgement about the model; it is arithmetic about where the constraint
 * is. Rank things by novelty and you get trend-chasing with extra steps.
 *
 * Three verdicts are reachable without any model at all, because they come
 * from matching a signal's tags against recorded product state. `interpret`
 * exists to phrase the *because*, and reports a missing key rather than
 * inventing relevance when it has none.
 */

import { callRole, parseJson } from "./models";
import type { ProductView } from "./products";

export type Verdict = "act-now" | "evaluate-soon" | "watch" | "ignore-for-now";

export const VERDICT_LABEL: Record<Verdict, string> = {
  "act-now": "Act now",
  "evaluate-soon": "Evaluate soon",
  watch: "Watch",
  "ignore-for-now": "Ignore for now",
};

export const VERDICT_MEANING: Record<Verdict, string> = {
  "act-now": "This materially changes a decision you have already made.",
  "evaluate-soon": "Likely useful in the phase you are heading into, not this one.",
  watch: "Real, but not yet mature or not yet yours.",
  "ignore-for-now": "Interesting. Unrelated to your constraint or your buyer.",
};

/** What kind of change a signal is. Forces `act-now` when it is a threat. */
export type Nature =
  /** Something you depend on is going away or has a hole in it. */
  | "deprecation"
  | "vulnerability"
  | "pricing"
  /** A capability now exists that you had planned to build. */
  | "replaces-planned-work"
  | "capability"
  | "market"
  | "commentary";

/** Natures that are never merely interesting. */
const FORCING: Nature[] = ["deprecation", "vulnerability", "pricing"];

export interface Signal {
  id: string;
  headline: string;
  summary: string;
  nature: Nature;
  /** Free tags matched against product stack and blockers, case-insensitively. */
  tags: string[];
  source: string;
  at: number;
  demo?: boolean;
}

export interface Classified {
  signal: Signal;
  verdict: Verdict;
  /** Why this verdict, in the operator's own terms. Never generic. */
  because: string;
  /** Product ids this touches. */
  affects: string[];
  /** Present when the signal collides with something currently blocking. */
  touchesBlocker: string | null;
}

// ── Matching ─────────────────────────────────────────────────────────────

const norm = (value: string) => value.toLowerCase();

function mentions(haystack: string, tags: string[]): boolean {
  const text = norm(haystack);
  return tags.some((tag) => text.includes(norm(tag)));
}

/**
 * Everything about a product a signal could plausibly collide with, split so
 * a blocker hit and a stack hit can be told apart. They mean different things.
 */
function surfaceOf(product: ProductView) {
  return {
    blockers: product.openBlockers.map((b) => b.name),
    stack: product.working.map((c) => c.name),
    objective: product.objective,
  };
}

export function classify(signal: Signal, products: ProductView[]): Classified {
  const affects: string[] = [];
  let touchesBlocker: string | null = null;
  let touchesStack = false;
  let touchesObjective = false;

  for (const product of products) {
    if (!product.active) continue;
    const surface = surfaceOf(product);

    const blockerHit = surface.blockers.find((name) => mentions(name, signal.tags));
    const stackHit = surface.stack.some((name) => mentions(name, signal.tags));
    const objectiveHit = mentions(surface.objective, signal.tags);

    if (blockerHit || stackHit || objectiveHit) affects.push(product.id);
    if (blockerHit && !touchesBlocker) touchesBlocker = `${product.name}: ${blockerHit}`;
    touchesStack = touchesStack || stackHit;
    touchesObjective = touchesObjective || objectiveHit;
  }

  // A threat to something you depend on is act-now whatever your phase is —
  // a deprecated dependency does not wait for a convenient moment.
  if (FORCING.includes(signal.nature) && affects.length > 0) {
    return {
      signal,
      verdict: "act-now",
      because: `A ${signal.nature} affecting ${affects.join(", ")}. This does not wait for the right phase.`,
      affects,
      touchesBlocker,
    };
  }

  if (touchesBlocker) {
    return {
      signal,
      verdict: "act-now",
      because: `It lands directly on ${touchesBlocker}, which is what is currently stopping the release.`,
      affects,
      touchesBlocker,
    };
  }

  if (signal.nature === "replaces-planned-work" && affects.length > 0) {
    return {
      signal,
      verdict: "act-now",
      because:
        "It covers work you had planned to build yourself. Re-evaluate the custom implementation before writing more of it.",
      affects,
      touchesBlocker,
    };
  }

  // The rule that stops this becoming a news feed: relevant to your stack but
  // not to your constraint is next phase's problem, and saying so is the
  // service being performed.
  if (touchesStack || touchesObjective) {
    const blocked = products.filter((p) => p.active && p.releaseBlockers.length > 0);
    if (blocked.length > 0) {
      return {
        signal,
        verdict: "evaluate-soon",
        because: `Relevant to ${affects.join(", ")}, but your current blocker is ${blocked[0].releaseBlockers[0].name} — not this. Worth a look once that clears.`,
        affects,
        touchesBlocker,
      };
    }
    return {
      signal,
      verdict: "evaluate-soon",
      because: `It touches ${affects.join(", ")} and nothing is currently gating you, so it can be assessed on its merits.`,
      affects,
      touchesBlocker,
    };
  }

  if (signal.nature === "market") {
    return {
      signal,
      verdict: "watch",
      because:
        "A market movement with no direct line to your current products. It may change an assumption before it changes a plan.",
      affects,
      touchesBlocker,
    };
  }

  return {
    signal,
    verdict: "ignore-for-now",
    because: "Nothing in it touches your stack, your blockers or your objective.",
    affects,
    touchesBlocker,
  };
}

/** Alerts versus a digest. Only `act-now` earns an interruption. */
export function partition(classified: Classified[]): {
  alerts: Classified[];
  digest: Classified[];
} {
  const order: Verdict[] = ["act-now", "evaluate-soon", "watch", "ignore-for-now"];
  const sorted = [...classified].sort(
    (a, b) => order.indexOf(a.verdict) - order.indexOf(b.verdict) || b.signal.at - a.signal.at,
  );
  return {
    alerts: sorted.filter((c) => c.verdict === "act-now"),
    digest: sorted.filter((c) => c.verdict !== "act-now"),
  };
}

// ── Optional model pass ──────────────────────────────────────────────────

const TAG_SYSTEM = `You extract matching keys from one technology or market development so it can be tested against a specific business's stack.

Return ONLY JSON:
{"tags": ["..."], "nature": "deprecation|vulnerability|pricing|replaces-planned-work|capability|market|commentary"}

Rules:
- Tags are concrete nouns a codebase or roadmap would contain: product names, service names, protocols, database engines, deployment concepts. At most 8.
- No generic tags. "AI", "cloud", "software" and "technology" match everything and are therefore worthless.
- Choose the nature conservatively. "commentary" is the correct answer for most articles.`;

export interface TagResult {
  ok: boolean;
  tags: string[];
  nature: Nature;
  error?: string;
}

/**
 * Turn raw text into something `classify` can match on.
 *
 * The model's only job is extracting keys. It is never asked whether
 * something matters — that is decided by matching those keys against recorded
 * product state, which is inspectable and cannot flatter anybody. With no key
 * configured this returns the failure rather than a guess, and the signal
 * stays unclassified rather than being quietly filed as irrelevant.
 */
export async function extractTags(text: string): Promise<TagResult> {
  const result = await callRole("quick", {
    system: TAG_SYSTEM,
    messages: [{ role: "user", content: text.slice(0, 4000) }],
    json: true,
  });

  if (!result.live) {
    return { ok: false, tags: [], nature: "commentary", error: result.error ?? "No model available." };
  }

  const parsed = parseJson<{ tags?: unknown; nature?: unknown }>(result.text);
  const tags = Array.isArray(parsed?.tags)
    ? parsed.tags.filter((t): t is string => typeof t === "string").slice(0, 8)
    : [];

  const natures: Nature[] = [
    "deprecation",
    "vulnerability",
    "pricing",
    "replaces-planned-work",
    "capability",
    "market",
    "commentary",
  ];
  const nature = natures.includes(parsed?.nature as Nature)
    ? (parsed?.nature as Nature)
    : "commentary";

  return { ok: true, tags, nature };
}

// ── Examples ─────────────────────────────────────────────────────────────

/**
 * Signals chosen to exercise every branch, including the one that matters
 * most: a genuinely impressive development that is correctly told to wait.
 */
export function exampleSignals(now: number): Signal[] {
  const ago = (hours: number) => now - hours * 3_600_000;

  return [
    {
      id: "sig-model",
      headline: "New frontier model with stronger structured output and lower tool-call latency",
      summary:
        "Improved reliability on constrained JSON and a measurable drop in tool-call round trips.",
      nature: "capability",
      tags: ["coding tools", "durable execution", "tool call", "orchestration"],
      source: "provider release notes",
      at: ago(6),
      demo: true,
    },
    {
      id: "sig-postgres",
      headline: "PostgreSQL adds native support for append-only partitioned logs",
      summary:
        "Simplifies event-store design: retention and partition pruning without an external compaction job.",
      nature: "capability",
      tags: ["postgresql", "live postgresql deployment proof", "event store", "data lineage"],
      source: "release announcement",
      at: ago(20),
      demo: true,
    },
    {
      id: "sig-deprecation",
      headline: "Container runtime deprecates the sandbox isolation API used for per-run jailing",
      summary: "Six-month deprecation window, replacement API is not drop-in.",
      nature: "deprecation",
      tags: ["sandbox isolation", "production worker deployment"],
      source: "platform changelog",
      at: ago(31),
      demo: true,
    },
    {
      id: "sig-market",
      headline: "Enterprise buyers shifting budget from AI chat interfaces to governed execution",
      summary:
        "Procurement increasingly requires traceability, audit trails and domain-specific workflows over general assistants.",
      nature: "market",
      tags: ["governance", "audit", "traceability"],
      source: "analyst survey",
      at: ago(50),
      demo: true,
    },
    {
      id: "sig-noise",
      headline: "A JavaScript framework releases its version 6 rewrite",
      summary: "Faster hydration, new router.",
      nature: "commentary",
      tags: ["javascript framework", "hydration", "router"],
      source: "aggregator",
      at: ago(9),
      demo: true,
    },
  ];
}
