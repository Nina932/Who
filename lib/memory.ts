/**
 * Durable memory.
 *
 * "It actually learns, saving durable facts to memory."
 *
 * The distinction that makes this memory rather than a transcript: after every
 * exchange, Haiku is asked what — if anything — in that exchange will still be
 * true next month. Preferences, decisions, people, constraints. Ephemera is
 * dropped on purpose. Facts are then recalled into later prompts, which is why
 * the workforce stops asking you the same question twice.
 */

import { callRole, parseJson } from "./models";
import { id, mutate, readCollection } from "./store";

export type FactKind = "preference" | "decision" | "person" | "constraint" | "goal" | "fact";

export interface Fact {
  id: string;
  text: string;
  kind: FactKind;
  /** 0..1 — how sure the extractor was that this is durable. */
  confidence: number;
  /** The utterance it came from, for auditability. */
  source: string;
  createdAt: number;
  /** Bumped whenever the fact is recalled, so stale facts are visible. */
  recalled: number;
}

const COLLECTION = "memory";

export async function allFacts(): Promise<Fact[]> {
  return readCollection<Fact[]>(COLLECTION, []);
}

const EXTRACT_SYSTEM = `You extract durable facts from a conversation between an operator and their AI co-founder.

A durable fact is still true in a month: a preference, a decision and its reason, a person and their role, a hard constraint, a standing goal.

NOT durable: pleasantries, one-off questions, anything about the current moment, anything the assistant said about itself, speculation.

Return ONLY a JSON array. Each element: {"text": string, "kind": "preference"|"decision"|"person"|"constraint"|"goal"|"fact", "confidence": number between 0 and 1}

Write each fact as a standalone sentence that makes sense with no other context. Return [] if nothing durable was said. Never invent anything.`;

/**
 * Extract durable facts from one exchange and merge them into memory.
 * Returns only the facts that were actually new.
 */
export async function learnFrom(operatorText: string, replyText: string): Promise<Fact[]> {
  const result = await callRole("extract", {
    system: EXTRACT_SYSTEM,
    messages: [
      {
        role: "user",
        content: `OPERATOR: ${operatorText}\n\nASSISTANT: ${replyText}`,
      },
    ],
    json: true,
  });

  if (!result.live || !result.text) return [];

  const parsed = parseJson<Array<{ text: string; kind: FactKind; confidence: number }>>(
    result.text,
  );
  if (!Array.isArray(parsed) || parsed.length === 0) return [];

  const candidates: Fact[] = parsed
    .filter((f) => f && typeof f.text === "string" && f.text.trim().length > 3)
    .map((f) => ({
      id: id("fact"),
      text: f.text.trim(),
      kind: (["preference", "decision", "person", "constraint", "goal", "fact"] as FactKind[])
        .includes(f.kind)
        ? f.kind
        : "fact",
      confidence: typeof f.confidence === "number" ? Math.min(1, Math.max(0, f.confidence)) : 0.6,
      source: operatorText.slice(0, 240),
      createdAt: Date.now(),
      recalled: 0,
    }))
    // A low-confidence "durable" fact is usually a hallucinated one.
    .filter((f) => f.confidence >= 0.45);

  if (candidates.length === 0) return [];

  return mutate<Fact[], Fact[]>(COLLECTION, [], (current) => {
    const fresh = candidates.filter(
      (candidate) => !current.some((existing) => similar(existing.text, candidate.text)),
    );
    return { next: [...current, ...fresh], result: fresh };
  });
}

/** Cheap near-duplicate check so memory doesn't fill with rephrasings. */
function similar(a: string, b: string): boolean {
  const norm = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .split(/\s+/)
        .filter((w) => w.length > 3),
    );
  const setA = norm(a);
  const setB = norm(b);
  if (setA.size === 0 || setB.size === 0) return false;

  let shared = 0;
  for (const word of setA) if (setB.has(word)) shared += 1;
  return shared / Math.min(setA.size, setB.size) > 0.7;
}

/**
 * Recall the facts worth putting in front of the model for this utterance.
 * Scored by term overlap, then by confidence — no embedding call, because
 * memory retrieval on every turn has to be free.
 */
export async function recall(utterance: string, limit = 8): Promise<Fact[]> {
  const facts = await allFacts();
  if (facts.length === 0) return [];

  const terms = new Set(
    utterance
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );

  const scored = facts.map((fact) => {
    const words = fact.text.toLowerCase().split(/\s+/);
    let overlap = 0;
    for (const word of words) if (terms.has(word.replace(/[^a-z0-9]/g, ""))) overlap += 1;
    // Standing context (preferences, constraints, goals) stays relevant even
    // when the words don't match.
    const standing = ["preference", "constraint", "goal"].includes(fact.kind) ? 0.8 : 0;
    return { fact, score: overlap + standing + fact.confidence * 0.5 };
  });

  const chosen = scored
    .filter((s) => s.score > 0.6)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.fact);

  if (chosen.length > 0) {
    const chosenIds = new Set(chosen.map((f) => f.id));
    void mutate<Fact[], null>(COLLECTION, [], (current) => ({
      next: current.map((f) =>
        chosenIds.has(f.id) ? { ...f, recalled: f.recalled + 1 } : f,
      ),
      result: null,
    }));
  }

  return chosen;
}

export function renderForPrompt(facts: Fact[]): string {
  if (facts.length === 0) return "";
  return [
    "What you already know about this operator (from memory — do not ask them again):",
    ...facts.map((f) => `- [${f.kind}] ${f.text}`),
  ].join("\n");
}

export async function forget(factId: string): Promise<boolean> {
  return mutate<Fact[], boolean>(COLLECTION, [], (current) => {
    const next = current.filter((f) => f.id !== factId);
    return { next, result: next.length !== current.length };
  });
}

export async function remember(text: string, kind: FactKind = "fact"): Promise<Fact> {
  const fact: Fact = {
    id: id("fact"),
    text: text.trim(),
    kind,
    confidence: 1,
    source: "stated directly by the operator",
    createdAt: Date.now(),
    recalled: 0,
  };
  return mutate<Fact[], Fact>(COLLECTION, [], (current) => ({
    next: [...current, fact],
    result: fact,
  }));
}
