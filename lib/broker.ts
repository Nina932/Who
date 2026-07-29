/**
 * The credential broker.
 *
 * The rule this exists to enforce: **the model never holds a credential.**
 * Not in a prompt, not in context, not in a tool argument. What it can hold is
 * a *grant* — an opaque id naming one capability, valid for a short time and a
 * small number of uses. Redeeming a grant is what resolves the actual token,
 * server-side, at the moment of the call.
 *
 * That indirection buys three things a long-lived token cannot:
 *
 *   - **Blast radius is a duration.** A leaked grant is worth ninety seconds
 *     and one call, not the lifetime of an OAuth refresh token.
 *   - **Every use is a decision.** `redeem` re-checks expiry and remaining
 *     uses, so a grant issued under a policy that has since tightened stops
 *     working rather than coasting on the old answer.
 *   - **Everything is audited, including the refusals.** A rejected redemption
 *     is more interesting than a successful one — it is the only evidence you
 *     will get that something tried.
 *
 * Pure and in-memory by design: the audit log is the artefact worth keeping,
 * and it is persisted by the caller. Grants are deliberately not durable —
 * a restart should invalidate outstanding authority, not preserve it.
 */

import { decide, type Decision, type Policy } from "./authority";

// ── Grants ───────────────────────────────────────────────────────────────

export interface Grant {
  id: string;
  capabilityId: string;
  /** Permission names the tool needs. Never a token, never a secret. */
  scopes: string[];
  issuedAt: number;
  expiresAt: number;
  /** Redemptions left. One, unless a caller had a reason for more. */
  usesLeft: number;
  /** How the grant was authorised. `operator` means a human said yes. */
  approvedBy: "policy" | "operator";
  /** What the operator was told when they approved it, kept verbatim. */
  approvedFor?: string;
}

/** Short enough that a leaked grant is worth almost nothing. */
export const DEFAULT_TTL_MS = 90_000;

export type Refusal =
  | "not-permitted"
  | "needs-approval"
  | "expired"
  | "spent"
  | "unknown-grant";

export interface AuditEntry {
  at: number;
  capabilityId: string;
  grantId?: string;
  outcome: "issued" | "redeemed" | "refused";
  refusal?: Refusal;
  /** Plain language, so the log is readable a year later without the code. */
  detail: string;
}

export interface Broker {
  request(
    capabilityId: string,
    options?: { amountMinor?: number; uses?: number; ttlMs?: number; now?: number },
  ): { ok: true; grant: Grant } | { ok: false; refusal: Refusal; decision: Decision };
  approve(
    capabilityId: string,
    approvedFor: string,
    options?: { uses?: number; ttlMs?: number; now?: number },
  ): { ok: true; grant: Grant } | { ok: false; refusal: Refusal; decision: Decision };
  redeem(
    grantId: string,
    now?: number,
  ): { ok: true; scopes: string[]; capabilityId: string } | { ok: false; refusal: Refusal };
  audit(): AuditEntry[];
  outstanding(now?: number): Grant[];
}

let counter = 0;

export function createBroker(policy: Policy, seed = "g"): Broker {
  const grants = new Map<string, Grant>();
  const log: AuditEntry[] = [];

  const record = (entry: AuditEntry) => {
    log.push(entry);
    // Bounded: the audit log is evidence, not a database. The caller persists
    // what it wants to keep.
    if (log.length > 2000) log.splice(0, log.length - 2000);
  };

  const mint = (
    capabilityId: string,
    scopes: string[],
    approvedBy: Grant["approvedBy"],
    approvedFor: string | undefined,
    uses: number,
    ttlMs: number,
    now: number,
  ): Grant => {
    counter += 1;
    const grant: Grant = {
      id: `${seed}_${now.toString(36)}${counter.toString(36)}`,
      capabilityId,
      scopes,
      issuedAt: now,
      expiresAt: now + ttlMs,
      usesLeft: uses,
      approvedBy,
      approvedFor,
    };
    grants.set(grant.id, grant);
    record({
      at: now,
      capabilityId,
      grantId: grant.id,
      outcome: "issued",
      detail: `${approvedBy === "operator" ? "Approved by you" : "Permitted by policy"}; ${uses} use${uses === 1 ? "" : "s"}, expires in ${Math.round(ttlMs / 1000)}s.`,
    });
    return grant;
  };

  return {
    /**
     * Ask for authority. Refused unless the policy grants it outright.
     *
     * A capability needing approval is refused *here* with `needs-approval`
     * rather than being issued a provisional grant, so there is no state that
     * looks like authority and is not.
     */
    request(capabilityId, options = {}) {
      const now = options.now ?? Date.now();
      const decision = decide(capabilityId, policy, { amountMinor: options.amountMinor });

      if (!decision.permitted) {
        record({
          at: now,
          capabilityId,
          outcome: "refused",
          refusal: "not-permitted",
          detail: decision.reason,
        });
        return { ok: false, refusal: "not-permitted", decision };
      }

      if (decision.requiresApproval) {
        record({
          at: now,
          capabilityId,
          outcome: "refused",
          refusal: "needs-approval",
          detail: decision.reason,
        });
        return { ok: false, refusal: "needs-approval", decision };
      }

      return {
        ok: true,
        grant: mint(
          capabilityId,
          decision.capability.scopes,
          "policy",
          undefined,
          options.uses ?? 1,
          options.ttlMs ?? DEFAULT_TTL_MS,
          now,
        ),
      };
    },

    /**
     * The operator said yes. `approvedFor` is what they were shown.
     *
     * Still runs `decide`, because an explicit `deny` must survive a human
     * clicking approve on a stale prompt — the two disagree only when
     * something has changed since the prompt was rendered, and the deny is
     * the more recent intent.
     */
    approve(capabilityId, approvedFor, options = {}) {
      const now = options.now ?? Date.now();
      const decision = decide(capabilityId, policy);

      if (!decision.permitted) {
        record({
          at: now,
          capabilityId,
          outcome: "refused",
          refusal: "not-permitted",
          detail: `Approval offered, but ${decision.reason}`,
        });
        return { ok: false, refusal: "not-permitted", decision };
      }

      return {
        ok: true,
        grant: mint(
          capabilityId,
          decision.capability.scopes,
          "operator",
          approvedFor,
          options.uses ?? 1,
          options.ttlMs ?? DEFAULT_TTL_MS,
          now,
        ),
      };
    },

    /**
     * Spend one use and return the scopes the tool may act with.
     *
     * The only place a grant turns into permission, and the only place the
     * clock is checked. Returns scopes — never a token; resolving those into
     * a credential is the connector's job and happens after this.
     */
    redeem(grantId, now = Date.now()) {
      const grant = grants.get(grantId);

      if (!grant) {
        record({
          at: now,
          capabilityId: "unknown",
          grantId,
          outcome: "refused",
          refusal: "unknown-grant",
          detail: "No such grant. Either forged, or issued before a restart.",
        });
        return { ok: false, refusal: "unknown-grant" };
      }

      if (now > grant.expiresAt) {
        record({
          at: now,
          capabilityId: grant.capabilityId,
          grantId,
          outcome: "refused",
          refusal: "expired",
          detail: `Expired ${Math.round((now - grant.expiresAt) / 1000)}s ago.`,
        });
        return { ok: false, refusal: "expired" };
      }

      if (grant.usesLeft <= 0) {
        record({
          at: now,
          capabilityId: grant.capabilityId,
          grantId,
          outcome: "refused",
          refusal: "spent",
          detail: "Already used. A grant is not a subscription.",
        });
        return { ok: false, refusal: "spent" };
      }

      grant.usesLeft -= 1;
      record({
        at: now,
        capabilityId: grant.capabilityId,
        grantId,
        outcome: "redeemed",
        detail: `Scopes released: ${grant.scopes.join(", ") || "none"}. ${grant.usesLeft} use${grant.usesLeft === 1 ? "" : "s"} left.`,
      });

      return { ok: true, scopes: grant.scopes, capabilityId: grant.capabilityId };
    },

    audit() {
      return [...log].reverse();
    },

    outstanding(now = Date.now()) {
      return [...grants.values()].filter((g) => g.usesLeft > 0 && now <= g.expiresAt);
    },
  };
}

/**
 * A one-line summary of an audit entry, for a log a person reads.
 *
 * Refusals lead with why, because the refusals are the interesting rows —
 * a successful redemption is the system working, and a refused one is the
 * only evidence you will get that something tried.
 */
export function describe(entry: AuditEntry): string {
  const time = new Date(entry.at).toISOString().slice(11, 19);
  if (entry.outcome === "refused") {
    return `${time}  REFUSED  ${entry.capabilityId} — ${entry.refusal}: ${entry.detail}`;
  }
  return `${time}  ${entry.outcome.toUpperCase().padEnd(8)} ${entry.capabilityId} — ${entry.detail}`;
}
