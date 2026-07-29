/**
 * Specialist Attendance.
 *
 * The behaviour the Reznikov post describes: you talk to Morpheus, and Morpheus
 * decides — mid-conversation — which expert belongs in the room. The operator
 * never picks an agent from a menu. That routing decision is this file.
 *
 * Scoring is deliberately transparent (term hits, not embeddings) so the
 * cockpit can show *why* a specialist was called in. An LLM sits on top of
 * this in `app/api/morpheus/route.ts`, but it inherits the same roster and the
 * same attendance decision rather than re-deciding on its own.
 */

import { AGENTS, AGENTS_BY_ID, SUMMONABLE, type Agent } from "./agents";

export type TurnRole = "operator" | "apex" | "specialist" | "system";

export interface Turn {
  id: string;
  role: TurnRole;
  /** Present when role is "specialist". */
  agentId?: string;
  text: string;
  at: number;
}

export interface AttendanceDecision {
  /** The specialist pulled into the room, if any. */
  primaryId: string | null;
  /** Agents consulted in the background. */
  supportingIds: string[];
  /** Terms that triggered the call — surfaced in the UI. */
  triggers: string[];
  /** Confidence 0..1, used for the ring intensity on the node. */
  confidence: number;
}

/**
 * Low-information phrases that must not earn the multi-word bonus.
 *
 * The bonus exists to reward *specificity* — "pull request" really is a
 * stronger signal than "test". But generic interrogative stems are long and
 * multi-word while carrying almost no domain information, so they were
 * outscoring the actual subject: "what is our runway looking like" routed to
 * the Researcher on "what is" instead of to Finance on "runway".
 */
const GENERIC = new Set([
  "what is", "who is", "find out", "look up", "should we", "should i",
  "how many", "data on", "build it", "note that", "you said", "last time",
]);

/**
 * Score every summonable agent against an utterance.
 * Longer domain terms count for more — "pull request" is a stronger signal
 * than "test".
 */
export function scoreAgents(utterance: string): Map<string, { score: number; hits: string[] }> {
  const text = ` ${utterance.toLowerCase()} `;
  const scores = new Map<string, { score: number; hits: string[] }>();

  for (const agent of AGENTS) {
    if (!SUMMONABLE.includes(agent.family)) continue;

    let score = 0;
    const hits: string[] = [];

    for (const term of agent.domains) {
      if (text.includes(term)) {
        if (GENERIC.has(term)) {
          // Enough to break a tie, never enough to beat a domain term.
          score += 0.4;
        } else {
          // Multi-word and longer terms are more specific, so weight them up.
          score += 1 + term.length / 12 + (term.includes(" ") ? 0.75 : 0);
        }
        hits.push(term);
      }
    }

    if (score > 0) scores.set(agent.id, { score, hits });
  }

  return scores;
}

/**
 * Decide who attends. Returns the primary specialist plus anyone worth
 * consulting in the background.
 */
export function decideAttendance(utterance: string): AttendanceDecision {
  const casual = utterance
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (
    /^(?:hi|hello|hey|good\s+(?:morning|afternoon|evening))\b/.test(casual) ||
    /^(?:morpheus\s+)?how are you(?: doing)?(?: today)?$/.test(casual)
  ) {
    return {
      primaryId: null,
      supportingIds: [],
      triggers: [],
      confidence: 0.95,
    };
  }

  const scores = scoreAgents(utterance);

  if (scores.size === 0) {
    // Nothing domain-specific means Morpheus answers directly. Assigning the
    // chief-of-staff seat to every greeting made ordinary conversation look
    // like a department had been summoned and encouraged the model to invent
    // calendar/week-management theatre the operator never asked for.
    return {
      primaryId: null,
      supportingIds: [],
      triggers: [],
      confidence: 0.25,
    };
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1].score - a[1].score);
  const [topId, top] = ranked[0];
  const total = ranked.reduce((sum, [, v]) => sum + v.score, 0);

  // Supporting agents need to be genuinely close to the leader, otherwise a
  // single stray keyword drags half the roster into every conversation.
  const supportingIds = ranked
    .slice(1)
    .filter(([, v]) => v.score >= top.score * 0.55)
    .slice(0, 2)
    .map(([id]) => id);

  return {
    primaryId: topId,
    supportingIds,
    triggers: top.hits,
    confidence: Math.min(0.95, 0.4 + (top.score / total) * 0.6),
  };
}

/**
 * Offline reply generation.
 *
 * Morpheus is useless without a model behind it, but the cockpit must still be
 * demonstrable with no key present — so every specialist can answer in
 * character from its own charter. This is explicitly a stand-in: the shape of
 * the response (who spoke, what they own, what they'd do next) matches what
 * the live path returns.
 */
export function draftReply(utterance: string, decision: AttendanceDecision): string {
  const agent: Agent | undefined = decision.primaryId
    ? AGENTS_BY_ID[decision.primaryId]
    : undefined;

  if (!agent) {
    const ask = utterance.trim().replace(/[.?!]+$/, "");
    if (
      /^(?:hi|hello|hey|good\s+(?:morning|afternoon|evening)|what'?s up|whello)\b[\s!.?]*$/i.test(
        ask,
      )
    ) {
      return "Hello, Nino. I’m here.";
    }
    return "I’m here. Tell me what you need, and I’ll answer directly.";
  }

  const ask = utterance.trim().replace(/[.?!]+$/, "");
  if (
    /^(?:hi|hello|hey|good\s+(?:morning|afternoon|evening)|what'?s up|whello)\b[\s!.?]*$/i.test(
      ask,
    )
  ) {
    return "Hello, Nino. I’m here. Local mode is active, so voice and routing work, but live answers need a Groq or Google model key.";
  }

  return `I routed that to ${agent.name}, but no live model is configured, so I won’t fabricate an answer. Add GROQ_API_KEY or GOOGLE_API_KEY to enable live replies.`;
}

/** Stable id generator that does not depend on a random seed at render time. */
let seq = 0;
export function turnId(prefix = "t"): string {
  seq += 1;
  return `${prefix}-${seq}`;
}
