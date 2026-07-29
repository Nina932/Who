/**
 * Pending actions — the thing an approval is actually *for*.
 *
 * The gap this closes: a grant bound only to a capability authorises a
 * *category*. Approve "send an email to David about the G8 deployment" and,
 * until that grant expires, the same grant would satisfy any `mail.send` —
 * different recipient, different body. The operator approved a sentence they
 * heard; the system authorised a permission.
 *
 * So the arguments are frozen *before* approval and hashed, and the hash is
 * bound into the grant. Changing anything material — recipient, amount, commit
 * — produces a different hash, which no existing grant can satisfy. The
 * previous approval does not "still apply"; it becomes unredeemable.
 *
 * Three properties follow, and each is tested:
 *
 *   - **What you approve is what runs.** The arguments cannot be edited
 *     between approval and execution, because editing them invalidates the
 *     approval.
 *   - **An approval is single-purpose.** It names one pending action, and a
 *     grant for one cannot execute another.
 *   - **Approvals expire.** A pending action nobody answered is not a standing
 *     offer.
 */

// ── Canonical form ───────────────────────────────────────────────────────

/**
 * Stable serialisation, so `{a:1,b:2}` and `{b:2,a:1}` hash identically.
 *
 * Without this the hash depends on key insertion order and an approval could
 * be invalidated by a JSON round-trip rather than by a real change — which
 * would train people to re-approve reflexively, which is worse than not
 * asking.
 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    // `undefined` is absent, not a value. Including it would make a hash
    // depend on whether an optional field was explicitly set to undefined.
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

/**
 * SHA-256 of the canonical form, via Web Crypto so it works in both runtimes.
 *
 * A cheap non-cryptographic hash would be a mistake here: the hash is what
 * stops one approved action being swapped for another, so collisions must not
 * be constructible by anything that can influence the arguments.
 */
export async function hashArguments(args: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(args));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── The record ───────────────────────────────────────────────────────────

export type Origin = "voice" | "text" | "ui" | "loop";

export type PendingStatus =
  | "awaiting-approval"
  | "approved"
  | "rejected"
  | "expired"
  | "executing"
  | "completed"
  | "failed"
  | "cancelled";

/** Statuses from which nothing further can happen. */
export const TERMINAL: PendingStatus[] = [
  "rejected",
  "expired",
  "completed",
  "failed",
  "cancelled",
];

export interface PendingAction {
  id: string;
  /** Short, spoken aloud, and what the approval phrase must contain. */
  reference: string;
  capabilityId: string;
  requestedBy: Origin;
  requestedAt: number;
  /** One sentence, in the operator's language. Read back before approval. */
  actionSummary: string;
  /** What cannot be undone. Read back before approval, verbatim. */
  consequence: string;
  /** The frozen arguments. Never edited — a change creates a new action. */
  immutableArguments: unknown;
  argumentsHash: string;
  status: PendingStatus;
  expiresAt: number;
  approvedAt?: number;
  approvedThrough?: ApprovalChannel;
  grantId?: string;
  /** What actually happened, after the fact. Not a promise — a record. */
  executionEvidence?: string;
  failure?: string;
}

export type ApprovalChannel = "voice" | "ui" | "security-key";

/**
 * Long enough to read it, short enough that it is not a standing offer.
 *
 * Deliberately longer than a grant's ninety seconds: you may want to read a
 * draft before approving. The grant clock starts at approval, not at proposal.
 */
export const PENDING_TTL_MS = 10 * 60_000;

let sequence = 1000;

/** Human-sized and spoken aloud, so it must be readable over a bad connection. */
export function nextReference(): string {
  sequence += 1;
  return String(sequence);
}

export async function createPending(input: {
  id: string;
  capabilityId: string;
  requestedBy: Origin;
  actionSummary: string;
  consequence: string;
  args: unknown;
  now: number;
  ttlMs?: number;
  reference?: string;
}): Promise<PendingAction> {
  return {
    id: input.id,
    reference: input.reference ?? nextReference(),
    capabilityId: input.capabilityId,
    requestedBy: input.requestedBy,
    requestedAt: input.now,
    actionSummary: input.actionSummary,
    consequence: input.consequence,
    // Frozen at creation. Everything downstream reads this, never a fresh copy.
    immutableArguments: JSON.parse(JSON.stringify(input.args ?? null)) as unknown,
    argumentsHash: await hashArguments(input.args ?? null),
    status: "awaiting-approval",
    expiresAt: input.now + (input.ttlMs ?? PENDING_TTL_MS),
  };
}

/** Status with the clock applied. Expiry is derived, never a background job. */
export function statusOf(action: PendingAction, now: number): PendingStatus {
  if (action.status === "awaiting-approval" && now > action.expiresAt) return "expired";
  return action.status;
}

export function isOpen(action: PendingAction, now: number): boolean {
  return statusOf(action, now) === "awaiting-approval";
}

/**
 * Amending an action does not edit it — it supersedes it.
 *
 * "Change the recipient to Maria" must not mutate something already approved.
 * The old action is cancelled and a new one, with a new reference and a new
 * hash, takes its place. Any grant against the old hash is now unredeemable,
 * which is the entire mechanism.
 */
export async function amend(
  action: PendingAction,
  args: unknown,
  now: number,
  summary?: string,
): Promise<{ cancelled: PendingAction; replacement: PendingAction }> {
  return {
    cancelled: { ...action, status: "cancelled" },
    replacement: await createPending({
      id: `${action.id}-a${now.toString(36)}`,
      capabilityId: action.capabilityId,
      requestedBy: action.requestedBy,
      actionSummary: summary ?? action.actionSummary,
      consequence: action.consequence,
      args,
      now,
    }),
  };
}

/**
 * What Morpheus says before asking for approval.
 *
 * Never "do you approve?" — the consequence, then the exact phrase. A prompt
 * that does not say what will happen is a prompt that trains people to say yes.
 */
export function readBack(action: PendingAction, channel: ApprovalChannel): string {
  const phrase = challengePhrase(action);
  const how =
    channel === "voice"
      ? `Say: "${phrase}".`
      : channel === "security-key"
        ? `This one needs your security key as well as the phrase "${phrase}".`
        : `Confirm on the Authority screen.`;

  return `${action.actionSummary} ${action.consequence} ${how}`;
}

/**
 * The exact phrase that approves this action and nothing else.
 *
 * Built from the capability and the reference, so it cannot be satisfied by a
 * stray "yes" from a television, a recording, or Morpheus's own speaker. A
 * generic affirmative must never approve anything.
 */
export function challengePhrase(action: PendingAction): string {
  const verb = action.capabilityId.split(".")[1] ?? action.capabilityId;
  return `approve ${verb} ${action.reference}`;
}

/**
 * Does a transcript approve this action?
 *
 * Deliberately strict. Punctuation and case are forgiven because a transcript
 * has neither reliably; the *words* are not. A missing or wrong reference
 * fails, which is what makes the phrase action-specific rather than a
 * differently-worded "yes".
 */
export function matchesChallenge(action: PendingAction, transcript: string): boolean {
  const normalise = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const spoken = normalise(transcript);
  const required = normalise(challengePhrase(action));

  // The reference must appear as its own token — "742" must not approve
  // "7421", and a number embedded in an unrelated word must not count.
  const hasReference = new RegExp(`(^|\\s)${action.reference}($|\\s)`).test(spoken);
  return hasReference && spoken.includes(required);
}
