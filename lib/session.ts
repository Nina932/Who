/**
 * Operator sessions, and step-up.
 *
 * `operatorSessionId` was a string the caller supplied. Anything that can
 * choose its own session id can forge one, which made the session half of the
 * grant binding decorative — a grant "not transferable" between sessions is
 * only untransferable if the session is proven.
 *
 * So a session is issued server-side, keyed by a random token the client
 * cannot guess, and the token is what arrives in a cookie. The *id* is derived
 * from the token, never sent, and never stored — so a leaked session record
 * cannot be replayed and the id in an audit log identifies a session without
 * being usable as one.
 *
 * Step-up is the second half. A boolean the caller sets is not a factor; it is
 * a field. This makes it a challenge: the server issues a nonce bound to one
 * pending action, and the response must prove possession of a secret the model
 * has never seen. That is real — it cannot be produced by anything with only
 * the transcript and the API — and it is the exact shape WebAuthn slots into,
 * where the "secret" becomes a hardware key and `verifyStepUp` becomes an
 * assertion check.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// ── Sessions ─────────────────────────────────────────────────────────────

export const SESSION_COOKIE = "morpheus_session";

/** Long enough for a working day, short enough that a stale tab is not authority. */
export const SESSION_TTL_MS = 12 * 3_600_000;

export interface Session {
  /** Derived from the token. Safe to log, useless as a credential. */
  id: string;
  issuedAt: number;
  expiresAt: number;
  /** Free-text note of how it was established. */
  origin: string;
}

/**
 * The id is `sha256(token)`, so the record never contains the token.
 *
 * A stolen session *record* is therefore not a stolen session — the same
 * reason password hashes exist. It also means the id can appear in the audit
 * log, which is where it needs to be, without the log becoming a key store.
 */
function idFor(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 32);
}

const sessions = new Map<string, Session>();

export interface Issued {
  token: string;
  session: Session;
}

export function issueSession(origin: string, now = Date.now()): Issued {
  const token = randomBytes(32).toString("base64url");
  const session: Session = {
    id: idFor(token),
    issuedAt: now,
    expiresAt: now + SESSION_TTL_MS,
    origin,
  };
  sessions.set(session.id, session);
  return { token, session };
}

/** Resolve a token to a live session, or null. Expiry is checked here. */
export function sessionFor(token: string | undefined, now = Date.now()): Session | null {
  if (!token) return null;
  const session = sessions.get(idFor(token));
  if (!session) return null;
  if (now > session.expiresAt) {
    sessions.delete(session.id);
    return null;
  }
  return session;
}

export function revokeSession(token: string): void {
  sessions.delete(idFor(token));
}

/** Test seam, and a clean slate after a restart in the same process. */
export function resetSessions(): void {
  sessions.clear();
  challenges.clear();
}

/** Read the cookie without pulling in a parser for one value. */
export function tokenFromRequest(request: { headers: { get(name: string): string | null } }): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

// ── Step-up ──────────────────────────────────────────────────────────────

/**
 * Short. A step-up is a deliberate act happening now, not a token to keep.
 */
export const STEPUP_TTL_MS = 120_000;

export interface Challenge {
  id: string;
  nonce: string;
  /** The one action this can authorise. */
  pendingActionId: string;
  /** The session that must answer it. */
  sessionId: string;
  issuedAt: number;
  expiresAt: number;
  used: boolean;
}

const challenges = new Map<string, Challenge>();

export function issueChallenge(
  pendingActionId: string,
  sessionId: string,
  now = Date.now(),
): Challenge {
  const challenge: Challenge = {
    id: `su_${randomBytes(8).toString("hex")}`,
    nonce: randomBytes(24).toString("base64url"),
    pendingActionId,
    sessionId,
    issuedAt: now,
    expiresAt: now + STEPUP_TTL_MS,
    used: false,
  };
  challenges.set(challenge.id, challenge);
  return challenge;
}

export type StepUpRefusal =
  | "unknown-challenge"
  | "expired"
  | "already-used"
  | "wrong-action"
  | "wrong-session"
  | "bad-response"
  | "not-configured";

/**
 * The secret the response must prove possession of.
 *
 * Read at verification time rather than captured at module load, so setting it
 * takes effect without a restart. Absent means step-up cannot succeed — which
 * is the correct failure: an unconfigured second factor must block the actions
 * that require one, not wave them through.
 */
function stepUpSecret(): string | undefined {
  return process.env.MORPHEUS_STEPUP_SECRET;
}

export function isStepUpConfigured(): boolean {
  return Boolean(stepUpSecret());
}

/** What a correct response looks like. Exported so a CLI or authenticator can compute it. */
export function expectedResponse(nonce: string, secret: string): string {
  return createHmac("sha256", secret).update(nonce).digest("base64url");
}

/**
 * Verify a step-up response.
 *
 * Compared in constant time, because a timing-variable comparison on an
 * authenticator is the classic way a second factor becomes a first one.
 */
export function verifyStepUp(
  challengeId: string,
  response: string,
  context: { pendingActionId: string; sessionId: string },
  now = Date.now(),
): { ok: true } | { ok: false; refusal: StepUpRefusal; reason: string } {
  const secret = stepUpSecret();
  if (!secret) {
    return {
      ok: false,
      refusal: "not-configured",
      reason:
        "No MORPHEUS_STEPUP_SECRET is set, so no second factor can be verified. Actions requiring step-up stay blocked.",
    };
  }

  const challenge = challenges.get(challengeId);
  if (!challenge) {
    return { ok: false, refusal: "unknown-challenge", reason: "That challenge is not recognised." };
  }
  if (challenge.used) {
    return { ok: false, refusal: "already-used", reason: "That challenge was already answered." };
  }
  if (now > challenge.expiresAt) {
    return { ok: false, refusal: "expired", reason: "That challenge expired. Ask again." };
  }
  if (challenge.pendingActionId !== context.pendingActionId) {
    return {
      ok: false,
      refusal: "wrong-action",
      reason: "That challenge was issued for a different action.",
    };
  }
  if (challenge.sessionId !== context.sessionId) {
    return {
      ok: false,
      refusal: "wrong-session",
      reason: "That challenge was issued to a different session.",
    };
  }

  const expected = Buffer.from(expectedResponse(challenge.nonce, secret));
  const given = Buffer.from(response);
  // Length must match before timingSafeEqual, and an early return on length is
  // not a leak worth caring about — the length of an HMAC is public.
  const correct = expected.length === given.length && timingSafeEqual(expected, given);

  if (!correct) {
    // Burned either way. Otherwise a challenge is an oracle to guess against.
    challenge.used = true;
    return { ok: false, refusal: "bad-response", reason: "That response is not correct." };
  }

  challenge.used = true;
  return { ok: true };
}
