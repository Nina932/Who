/**
 * What kind of question is this, and what does answering it cost?
 *
 * Morpheus should answer anything — general knowledge, code, writing, the
 * business, personal planning. But *how* it answers has to change, because the
 * failure modes are different and one of them is expensive.
 *
 * Answering "what's the capital of Peru" from the model is correct. Answering
 * "what state is G8 in?" from the model is a fabrication wearing the same
 * confident tone. Answering "send the invoice" *at all* without an approval is
 * a commercial act taken by a machine.
 *
 * So this classifies before anything else runs:
 *
 *   direct        answer from the model, no retrieval
 *   current       needs live information — say so, or fetch and cite
 *   business      retrieve from Phoenix state; never answer from the model
 *   code          inspect the repository before speaking
 *   action        identify capability, level, and risk
 *   consequential a decision worth escalating and evidencing
 *
 * Deterministic and offline. Sending the classification itself through a model
 * would put the "is this dangerous?" question inside the thing being guarded,
 * which is exactly backwards.
 */

import { CAPABILITIES, type Capability } from "./authority";
import type { ModelRole } from "./models";

export type Answer =
  | "direct"
  | "current"
  | "business"
  | "code"
  | "action"
  | "consequential";

export interface AnswerSpec {
  id: Answer;
  name: string;
  /** How the answer must be produced. */
  rule: string;
}

export const ANSWERS: Record<Answer, AnswerSpec> = {
  direct: {
    id: "direct",
    name: "Answer directly",
    rule: "Ordinary knowledge. Answer from the model, and say when you are unsure.",
  },
  current: {
    id: "current",
    name: "Needs live information",
    rule: "Depends on facts that change. Fetch and cite, or state plainly that you cannot check.",
  },
  business: {
    id: "business",
    name: "Retrieve from state",
    rule: "Answer only from the case ledger, product state and knowledge base. Never from recall.",
  },
  code: {
    id: "code",
    name: "Inspect first",
    rule: "Read the repository before answering. A remembered codebase is a different codebase.",
  },
  action: {
    id: "action",
    name: "Identify authority",
    rule: "Name the capability, its level and its consequence. Do not act before the level allows it.",
  },
  consequential: {
    id: "consequential",
    name: "Escalate and evidence",
    rule: "Route to the judgment model. Carry evidence, a trade-off and a falsifier.",
  },
};

export type Risk = "none" | "low" | "medium" | "high";

export interface Classification {
  answer: Answer;
  risk: Risk;
  /** The model tier this implies. */
  role: ModelRole;
  /** Capabilities the request appears to want. Proposed, never granted. */
  capabilities: Capability[];
  /** The phrase that decided it, so a routing decision is never anonymous. */
  because: string;
}

// ── Signals ──────────────────────────────────────────────────────────────

/** Verbs that mean "do something", not "tell me something". */
const ACTION_VERBS = [
  "send", "publish", "post ", "deploy", "merge", "delete", "remove", "buy",
  "purchase", "pay", "transfer", "refund", "invite", "schedule", "book",
  "commit", "push", "rotate", "revoke", "migrate", "drop table", "run the",
  "open a pr", "open a pull", "file an issue", "create a branch",
];

/** Phrases that make a question about *this business*, not about the world. */
const BUSINESS = [
  "my case", "our case", "the case", "invoice", "client", "customer",
  "pipeline", "proposal", "blocker", "milestone", "phase", "runway",
  "finai", "g8", "waiting on", "overdue", "my week", "my day", "commitment",
  "what state is", "where are we", "what changed",
];

/** Phrases about code, where recall is worse than useless. */
const CODE = [
  "the repo", "repository", "this file", "the test", "the build", "stack trace",
  "the error", "compile", "typecheck", "the branch", "the commit", "the diff",
  "why does it fail", "why is it failing", "the function", "the module",
];

/** Things whose answer changed since any training cut-off. */
const CURRENT = [
  "latest", "current price", "today", "this week", "news", "just released",
  "recently", "right now", "who won", "what happened", "is it still",
  "version", "changelog", "release notes",
];

/** Consequential — reused deliberately from the model router's vocabulary. */
const CONSEQUENTIAL = [
  "should i", "should we", "worth it", "pivot", "shut down", "fire ",
  "hire ", "raise prices", "pricing", "contract", "equity", "lawsuit",
  "sign the", "invest", "acquire", "terminate",
];

function found(text: string, terms: string[]): string | null {
  return terms.find((term) => text.includes(term)) ?? null;
}

/**
 * Which registered capabilities a sentence appears to reach for.
 *
 * Proposed only. Matching a verb against a capability is a hint that
 * authority will be needed; whether it is granted is `decide`'s answer and
 * nothing here can pre-empt it.
 */
export function capabilitiesMentioned(utterance: string): Capability[] {
  const text = ` ${utterance.toLowerCase()} `;
  const hits = new Set<Capability>();

  for (const capability of CAPABILITIES) {
    // Match on the capability's own words rather than a hand-written table,
    // so a capability added later is matchable without touching this file.
    const words = capability.label.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    const noun = capability.id.split(".")[1] ?? "";
    if (words.filter((w) => text.includes(w)).length >= 2 || (noun.length > 4 && text.includes(noun))) {
      hits.add(capability);
    }
  }

  return [...hits];
}

/**
 * Classify a turn.
 *
 * Order matters and encodes the priority: an action is checked before a
 * question, because "send the invoice to Halden" is a request to act that
 * happens to be phrased as a sentence about the business. Getting that order
 * backwards is how an assistant answers helpfully and also sends the email.
 */
export function classify(utterance: string): Classification {
  const text = ` ${utterance.toLowerCase()} `;
  const capabilities = capabilitiesMentioned(utterance);

  const verb = found(text, ACTION_VERBS);
  if (verb) {
    const highest = capabilities.reduce((max, c) => Math.max(max, c.level), 0);
    return {
      answer: "action",
      // Risk follows the level of what it reaches for, not the tone of the ask.
      risk: highest >= 4 ? "high" : highest === 3 ? "medium" : "low",
      role: highest >= 4 ? "judgment" : "hard",
      capabilities,
      because: `"${verb.trim()}" asks for something to happen.`,
    };
  }

  const consequential = found(text, CONSEQUENTIAL);
  if (consequential) {
    return {
      answer: "consequential",
      risk: "medium",
      role: "judgment",
      capabilities,
      because: `"${consequential.trim()}" is a decision, not a question.`,
    };
  }

  const code = found(text, CODE);
  if (code) {
    return {
      answer: "code",
      risk: "low",
      role: "hard",
      capabilities,
      because: `"${code.trim()}" is about code — a remembered codebase is a different codebase.`,
    };
  }

  const business = found(text, BUSINESS);
  if (business) {
    return {
      answer: "business",
      risk: "low",
      role: "hard",
      capabilities,
      because: `"${business.trim()}" is about your business, so it comes from the ledger, not from recall.`,
    };
  }

  const current = found(text, CURRENT);
  if (current) {
    return {
      answer: "current",
      risk: "none",
      role: "quick",
      capabilities,
      because: `"${current.trim()}" depends on something that changes.`,
    };
  }

  return {
    answer: "direct",
    risk: "none",
    role: utterance.length > 240 ? "hard" : "quick",
    capabilities,
    because: "Ordinary question, answerable from general knowledge.",
  };
}

/**
 * The instruction that goes with a classification.
 *
 * Descriptive: it makes the model behave *usefully* within the boundary. The
 * boundary itself is `decide` and the broker, neither of which a prompt can
 * move.
 */
export function renderForPrompt(classification: Classification): string {
  const spec = ANSWERS[classification.answer];
  const lines = [`HOW TO ANSWER THIS ONE — ${spec.name}: ${spec.rule}`];

  if (classification.capabilities.length > 0) {
    lines.push(
      "",
      "It appears to want: " +
        classification.capabilities
          .map((c) => `${c.id} (level ${c.level} — ${c.consequence})`)
          .join("; "),
      "Propose, with the consequence. Do not claim to have done it.",
    );
  }

  return lines.join("\n");
}
