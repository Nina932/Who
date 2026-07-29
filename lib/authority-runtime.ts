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

import { CAPABILITY_BY_ID, DEFAULT_POLICY, decide, type Policy } from "./authority";
import { createBroker, type AuditEntry, type Binding, type Broker, type Refusal } from "./broker";
import {
  TERMINAL,
  createPending,
  hashArguments,
  statusOf,
  type Origin,
  type PendingAction,
} from "./pending";
import { id as newId, mutate, readCollection } from "./store";

const POLICY = "policy";
const AUDIT = "authority-audit";
const PENDING = "pending-actions";

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
  options: { amountMinor?: number; grantId?: string; args?: unknown } & Binding = {},
): Promise<{ ok: true; value: T } | Denied> {
  const instance = await liveBroker();

  // The binding presented at redemption. Computed from the arguments about to
  // be used — not from the ones that were approved — so a mismatch is exactly
  // what it looks like: the action changed after approval.
  const presented: Binding = {
    pendingActionId: options.pendingActionId,
    argumentsHash:
      options.argumentsHash ?? (options.args !== undefined ? await hashArguments(options.args) : undefined),
    operatorSessionId: options.operatorSessionId,
  };

  // A grant id means the operator already approved this specific thing. It is
  // redeemed rather than re-decided, because the approval *was* the decision
  // and asking twice trains people to click through.
  if (options.grantId) {
    const redeemed = instance.redeem(options.grantId, presented);
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
              : redeemed.refusal === "binding-mismatch"
                ? (redeemed.detail ?? "That approval was for a different action.")
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

  const requested = instance.request(capabilityId, {
    amountMinor: options.amountMinor,
    ...presented,
  });
  await flush(instance);

  if (!requested.ok) {
    return {
      ok: false,
      refusal: requested.refusal,
      capabilityId,
      reason: requested.decision.reason,
    };
  }

  const redeemed = instance.redeem(requested.grant.id, presented);
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


// ── Pending actions ──────────────────────────────────────────────────────

export async function allPending(): Promise<PendingAction[]> {
  return readCollection<PendingAction[]>(PENDING, []);
}

export async function openPending(now = Date.now()): Promise<PendingAction[]> {
  return (await allPending()).filter((a) => statusOf(a, now) === "awaiting-approval");
}

/**
 * Propose something that needs approval.
 *
 * The arguments are frozen here, before the operator is asked. Everything
 * downstream reads the frozen copy — so what is executed is what was read
 * back, and any later change produces a different hash that no existing
 * approval can satisfy.
 */
export async function propose(input: {
  capabilityId: string;
  requestedBy: Origin;
  actionSummary: string;
  args: unknown;
  now?: number;
}): Promise<{ ok: true; action: PendingAction } | { ok: false; reason: string }> {
  const capability = CAPABILITY_BY_ID[input.capabilityId];
  if (!capability) {
    return { ok: false, reason: `"${input.capabilityId}" is not a registered capability.` };
  }

  const policy = await currentPolicy();
  const decision = decide(input.capabilityId, policy);
  if (!decision.permitted) {
    return { ok: false, reason: decision.reason };
  }

  const action = await createPending({
    id: newId("pa"),
    capabilityId: input.capabilityId,
    requestedBy: input.requestedBy,
    actionSummary: input.actionSummary,
    consequence: capability.consequence,
    args: input.args,
    now: input.now ?? Date.now(),
  });

  await mutate<PendingAction[], null>(PENDING, [], (current) => ({
    next: [action, ...current].slice(0, 200),
    result: null,
  }));

  return { ok: true, action };
}

export async function patchPending(
  id: string,
  patch: Partial<PendingAction>,
): Promise<PendingAction | null> {
  return mutate<PendingAction[], PendingAction | null>(PENDING, [], (current) => {
    let updated: PendingAction | null = null;
    const next = current.map((action) => {
      if (action.id !== id) return action;
      // Terminal is terminal. A rejected action cannot be walked back into
      // approval by a stray call — the same guard the Loops Engine needed.
      if (TERMINAL.includes(action.status)) {
        updated = action;
        return action;
      }
      updated = { ...action, ...patch };
      return updated;
    });
    return { next, result: updated };
  });
}

/**
 * Turn an approval into a bound grant.
 *
 * The grant carries the action id, the frozen argument hash and the approving
 * session, so it authorises this action and nothing else.
 */
export async function grantFor(
  action: PendingAction,
  sessionId: string,
  approvedThrough: PendingAction["approvedThrough"],
): Promise<{ ok: true; grantId: string } | { ok: false; reason: string }> {
  const instance = await liveBroker();
  const result = instance.approve(action.capabilityId, action.actionSummary, {
    pendingActionId: action.id,
    argumentsHash: action.argumentsHash,
    operatorSessionId: sessionId,
  });
  await flush(instance);

  if (!result.ok) return { ok: false, reason: result.decision.reason };

  await patchPending(action.id, {
    status: "approved",
    approvedAt: Date.now(),
    approvedThrough,
    grantId: result.grant.id,
  });

  return { ok: true, grantId: result.grant.id };
}
