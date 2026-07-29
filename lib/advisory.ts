/**
 * The shape every recommendation must take.
 *
 * Advice you cannot argue with is advice you cannot check. So nothing in this
 * system may recommend anything without also stating what would make the
 * recommendation wrong — that last field is the one that turns a suggestion
 * into a claim, and it is required rather than optional.
 *
 * `rule` names the code that fired. Any advisory can therefore be traced back
 * to a specific, readable condition rather than to a model's mood.
 */

import { confidenceOf, type Confidence, type Entry } from "./knowledge";

export interface Advisory {
  id: string;
  /** Product id, or "business" for advice about the portfolio as a whole. */
  subject: string;
  /** Which rule produced this. Auditable, and how duplicates are detected. */
  rule: string;
  recommendation: string;
  reason: string;
  /** Entry ids. Facts, decisions and commitments only — never hypotheses. */
  evidence: string[];
  expectedBenefit: string;
  tradeOff: string;
  /** The falsifier. Required: advice with no falsifier is an opinion. */
  wouldChangeIf: string;
  confidence: Confidence;
  /** Higher sorts first. Set by the rule, not by the model. */
  weight: number;
}

/**
 * Confidence from the evidence, not from the rule's self-assessment.
 *
 * Capped by the weakest cited entry and by how much there is: one supporting
 * fact is a coincidence away from being wrong, so a lone citation cannot buy
 * high confidence however solid it is.
 */
export function advisoryConfidence(
  evidence: string[],
  entries: Entry[],
  now: number,
): Confidence {
  if (evidence.length === 0) return "low";

  const order: Confidence[] = ["none", "low", "medium", "high"];
  const byId = new Map(entries.map((e) => [e.id, e]));

  let floor = order.length - 1;
  for (const ref of evidence) {
    const entry = byId.get(ref);
    if (!entry) return "low";
    floor = Math.min(floor, order.indexOf(confidenceOf(entry, entries, now)));
  }

  if (evidence.length < 2) floor = Math.min(floor, order.indexOf("medium"));
  return order[Math.max(0, floor)];
}

/** Sort as the operator should read them: strongest claim, heaviest first. */
export function rank(advisories: Advisory[]): Advisory[] {
  const rankOf: Record<Confidence, number> = { high: 3, medium: 2, low: 1, none: 0 };
  return [...advisories].sort(
    (a, b) => b.weight - a.weight || rankOf[b.confidence] - rankOf[a.confidence],
  );
}
