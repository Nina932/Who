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
const LEDGER = "execution-ledger";

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

/**
 * Move newly recorded entries into the durable log.
 *
 * `drainAudit` rather than `audit`: the latter returns the entire in-memory
 * log every time, so flushing after each operation persisted the same rows
 * over and over. Three events became six stored rows. An audit log that
 * repeats itself is worse than none — it looks like more happened than did.
 */
async function flush(instance: Broker): Promise<void> {
  const entries = instance.drainAudit();
  if (entries.length > 0) await appendAudit(entries);
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


// ── Execution ────────────────────────────────────────────────────────────

/**
 * The idempotency key for one action, stable across retries.
 *
 * Derived from the action id, so a retry of the same approved action carries
 * the same key and a *different* action never collides with it. This is what
 * an external service would be handed to deduplicate on its side; here it
 * also backs the local ledger.
 */
export function idempotencyKey(action: PendingAction): string {
  return `${action.capabilityId}:${action.id}`;
}

/**
 * Claim an approved action for execution, atomically.
 *
 * Without this, two requests arriving together both read `approved`, both
 * pass the check, and both execute — sending the same email twice. Reading
 * then writing is not a check; it is a race with a comment on it.
 *
 * The claim is a compare-and-swap inside a single `mutate`, which is
 * serialised per collection and, on the Redis driver, guarded by a
 * server-side compare-and-set. Exactly one caller can observe `approved` and
 * write `executing`; every other caller sees the already-moved status.
 *
 * The ledger is the second line: a key already present means this action ran,
 * even if the status was lost to a crash between claiming and completing.
 */
async function claimForExecution(
  actionId: string,
  now: number,
): Promise<
  | { ok: true; action: PendingAction }
  | { ok: false; reason: string; action: PendingAction | null }
> {
  const claimed = await mutate<PendingAction[], { ok: boolean; reason?: string; action: PendingAction | null }>(
    PENDING,
    [],
    (current) => {
      const action = current.find((a) => a.id === actionId);
      if (!action) return { next: current, result: { ok: false, reason: "No such action.", action: null } };

      if (action.status !== "approved" || !action.grantId) {
        return {
          next: current,
          result: {
            ok: false,
            // `executing` here means somebody else won the claim a moment ago.
            reason:
              action.status === "executing"
                ? `${action.reference} is already being executed.`
                : `${action.reference} is ${statusOf(action, now)}, not approved.`,
            action,
          },
        };
      }

      const moved: PendingAction = { ...action, status: "executing" };
      return {
        next: current.map((a) => (a.id === actionId ? moved : a)),
        result: { ok: true, action: moved },
      };
    },
  );

  if (!claimed.ok || !claimed.action) {
    return { ok: false, reason: claimed.reason ?? "Could not claim.", action: claimed.action };
  }

  // Second line: has this exact action already run to completion?
  const key = idempotencyKey(claimed.action);
  const fresh = await mutate<Record<string, number>, boolean>(LEDGER, {}, (current) =>
    current[key] === undefined
      ? { next: { ...current, [key]: now }, result: true }
      : { next: current, result: false },
  );

  if (!fresh) {
    await patchPending(actionId, { status: "completed" });
    return {
      ok: false,
      reason: `${claimed.action.reference} has already been executed. Nothing was done a second time.`,
      action: claimed.action,
    };
  }

  return { ok: true, action: claimed.action };
}

/**
 * Run an approved action.
 *
 * The missing link: a grant that nothing redeemed was a grant nothing could
 * use. This takes the approved pending action, finds the tool that declared
 * its capability, and runs it against the **frozen** arguments — not against
 * anything supplied now. The binding is presented at redemption, so if the
 * action was amended since approval the hash no longer matches and the call
 * is refused rather than quietly running the new version.
 */
export async function executeApproved(
  actionId: string,
  sessionId: string,
): Promise<{ ok: boolean; summary: string; action: PendingAction | null }> {
  const now = Date.now();

  // Claimed before anything else happens. Every check after this point is
  // running on state only this caller owns.
  const claim = await claimForExecution(actionId, now);
  if (!claim.ok) return { ok: false, summary: claim.reason, action: claim.action };
  const action = claim.action;

  const { TOOLS, runTool } = await import("./tools");
  const tool = Object.values(TOOLS).find((t) => t.capabilityId === action.capabilityId);
  if (!tool) {
    // Release the claim and the ledger entry: nothing ran, so a later attempt
    // — once a tool exists — must not be refused as a duplicate.
    await releaseClaim(action);
    return {
      ok: false,
      summary: `Nothing is wired to perform ${action.capabilityId}. The approval stands unused.`,
      action,
    };
  }

  const result = await runTool(tool, action.immutableArguments, {
    grantId: action.grantId,
    pendingActionId: action.id,
    operatorSessionId: sessionId,
    proposeOnRefusal: false,
  });

  // A refused call did not reach the world, so the ledger entry would
  // otherwise block a legitimate retry after the reason is fixed.
  if (!result.ok) await releaseClaim(action);

  const updated = await patchPending(actionId, {
    status: result.ok ? "completed" : "failed",
    // The receipt: what happened, with evidence. Never "Done."
    executionEvidence: result.ok ? result.summary : undefined,
    failure: result.ok ? undefined : result.summary,
  });

  return { ok: result.ok, summary: result.summary, action: updated };
}


/** Undo a claim that turned out not to have run anything. */
async function releaseClaim(action: PendingAction): Promise<void> {
  const key = idempotencyKey(action);
  await mutate<Record<string, number>, null>(LEDGER, {}, (current) => {
    const next = { ...current };
    delete next[key];
    return { next, result: null };
  });
}

/** Test seam: has this action been recorded as executed? */
export async function hasExecuted(action: PendingAction): Promise<boolean> {
  const ledger = await readCollection<Record<string, number>>(LEDGER, {});
  return ledger[idempotencyKey(action)] !== undefined;
}
