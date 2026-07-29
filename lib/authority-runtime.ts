/**
 * The live broker, and the wrapper every tool goes through.
 *
 * `lib/broker.ts` is pure so it can be tested exhaustively. This is the part
 * that has to survive between requests, because a grant issued by an approval
 * and redeemed by the request that follows it is the entire point — a broker
 * rebuilt per request issues grants nothing can ever use.
 *
 * The broker is rebuilt whenever the policy changes, which is deliberate:
 * tightening the policy invalidates outstanding authority immediately rather
 * than letting it coast until expiry.
 *
 * Grants are in-memory and die with the process. That is a property, not a
 * limitation — a restart should not preserve authority somebody granted an
 * hour ago for one specific thing.
 */

import { DEFAULT_POLICY, type Policy } from "./authority";
import { createBroker, type AuditEntry, type Broker, type Refusal } from "./broker";
import { mutate, readCollection } from "./store";

const POLICY = "policy";
const AUDIT = "authority-audit";

let broker: Broker | null = null;
let signature = "";

export async function currentPolicy(): Promise<Policy> {
  return readCollection<Policy>(POLICY, DEFAULT_POLICY);
}

export async function savePolicy(next: Policy): Promise<Policy> {
  return mutate<Policy, Policy>(POLICY, DEFAULT_POLICY, () => ({ next, result: next }));
}

/** Persisted separately from the grants, because the log is what you keep. */
export async function appendAudit(entries: AuditEntry[]): Promise<void> {
  if (entries.length === 0) return;
  await mutate<AuditEntry[], null>(AUDIT, [], (current) => ({
    next: [...entries, ...current].slice(0, 500),
    result: null,
  }));
}

export async function auditLog(): Promise<AuditEntry[]> {
  return readCollection<AuditEntry[]>(AUDIT, []);
}

/**
 * The broker for the policy as it stands.
 *
 * Rebuilt on any policy change, which drops every outstanding grant. Adding a
 * `deny` should take effect now, not in ninety seconds.
 */
export async function liveBroker(): Promise<Broker> {
  const policy = await currentPolicy();
  const next = JSON.stringify(policy);
  if (!broker || next !== signature) {
    broker = createBroker(policy);
    signature = next;
  }
  return broker;
}

/** Drain whatever the broker recorded into the durable log. */
async function flush(instance: Broker): Promise<void> {
  const entries = instance.audit();
  if (entries.length > 0) await appendAudit(entries.slice(0, 50));
}

export interface Denied {
  ok: false;
  refusal: Refusal;
  /** What to tell the operator. Never a stack trace. */
  reason: string;
  capabilityId: string;
}

/**
 * Run something only if the policy permits it.
 *
 * This is the seam. A tool does not check its own permission — it declares
 * which capability it is, and the answer comes from here. A tool that decided
 * for itself would be a tool that could be argued with.
 *
 * The scopes are handed to the action rather than looked up inside it, so the
 * authorised set is visible at the call site and cannot silently widen.
 */
export async function withAuthority<T>(
  capabilityId: string,
  action: (scopes: string[]) => Promise<T>,
  options: { amountMinor?: number; grantId?: string } = {},
): Promise<{ ok: true; value: T } | Denied> {
  const instance = await liveBroker();

  // A grant id means the operator already approved this specific thing. It is
  // redeemed rather than re-decided, because the approval *was* the decision
  // and asking twice trains people to click through.
  if (options.grantId) {
    const redeemed = instance.redeem(options.grantId);
    await flush(instance);
    if (!redeemed.ok) {
      return {
        ok: false,
        refusal: redeemed.refusal,
        capabilityId,
        reason:
          redeemed.refusal === "expired"
            ? "That approval has expired. Approvals are deliberately short-lived; ask again."
            : redeemed.refusal === "spent"
              ? "That approval was already used. A grant is not a subscription."
              : "That approval is not recognised.",
      };
    }
    if (redeemed.capabilityId !== capabilityId) {
      // An approval for one thing must never authorise another.
      return {
        ok: false,
        refusal: "not-permitted",
        capabilityId,
        reason: `That approval was for ${redeemed.capabilityId}, not ${capabilityId}.`,
      };
    }
    return { ok: true, value: await action(redeemed.scopes) };
  }

  const requested = instance.request(capabilityId, { amountMinor: options.amountMinor });
  await flush(instance);

  if (!requested.ok) {
    return {
      ok: false,
      refusal: requested.refusal,
      capabilityId,
      reason: requested.decision.reason,
    };
  }

  const redeemed = instance.redeem(requested.grant.id);
  await flush(instance);
  if (!redeemed.ok) {
    return { ok: false, refusal: redeemed.refusal, capabilityId, reason: "Grant could not be redeemed." };
  }

  return { ok: true, value: await action(redeemed.scopes) };
}

/** For tests and for a clean slate after a policy edit in the same process. */
export function resetBroker(): void {
  broker = null;
  signature = "";
}
