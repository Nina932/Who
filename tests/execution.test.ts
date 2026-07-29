import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { DEFAULT_POLICY, type Policy } from "../lib/authority";
import { createBroker } from "../lib/broker";
import { createPending, type PendingAction } from "../lib/pending";

/**
 * Two failures a sequential test cannot see.
 *
 * The audit log persisted the same rows repeatedly, because `audit()` returns
 * the whole in-memory log and the caller flushed after every operation. Three
 * events became six stored rows. Security evidence that repeats itself is
 * evidence of nothing.
 *
 * And execution read the status, then wrote it — which is not a check, it is a
 * race with a comment on it. Two requests arriving together both saw
 * `approved` and both would have run.
 */

let runtime: typeof import("../lib/authority-runtime");
let dir: string;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "morpheus-exec-"));
  process.env.MORPHEUS_DATA_DIR = dir;
  runtime = await import("../lib/authority-runtime");
});

after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const policy = (over: Partial<Policy> = {}): Policy => ({ ...DEFAULT_POLICY, ...over });

// ── The audit log ────────────────────────────────────────────────────────

describe("the audit log records each event once", () => {
  it("drains rather than re-reading the whole log", () => {
    const broker = createBroker(policy({ ceiling: 2 }));
    const persisted: string[] = [];
    const flush = () => {
      for (const entry of broker.drainAudit()) persisted.push(`${entry.outcome}:${entry.capabilityId}`);
    };

    const issued = broker.request("mail.draft", { now: 1 });
    flush();
    assert.ok(issued.ok);
    broker.redeem(issued.grant.id, {}, 2);
    flush();
    broker.request("mail.send", { now: 3 });
    flush();

    // Three things happened. Three rows. The bug produced six, with the first
    // written three times.
    assert.equal(persisted.length, 3);
    assert.deepEqual(persisted, [
      "issued:mail.draft",
      "redeemed:mail.draft",
      "refused:mail.send",
    ]);
  });

  it("returns nothing on a second drain with nothing new", () => {
    const broker = createBroker(policy({ ceiling: 2 }));
    broker.request("mail.draft", { now: 1 });
    assert.equal(broker.drainAudit().length, 1);
    assert.deepEqual(broker.drainAudit(), []);
  });

  it("still exposes the whole log for reading", () => {
    // `audit()` is for display; draining is for persistence. Reading must not
    // consume, or the UI would empty the log by looking at it.
    const broker = createBroker(policy({ ceiling: 2 }));
    broker.request("mail.draft", { now: 1 });
    broker.drainAudit();
    assert.equal(broker.audit().length, 1);
    assert.equal(broker.audit().length, 1);
  });

  it("loses nothing, however far behind the persister falls", () => {
    // The earlier version trimmed the oldest entries past 2000 and moved the
    // cursor down with them, silently destroying un-persisted rows: 2100
    // events in, 2000 out, 100 gone. The assertion here used to be
    // `<= 2000`, which accommodated the bug rather than catching it.
    const broker = createBroker(policy({ ceiling: 2 }));
    const EVENTS = 10_000;
    for (let i = 0; i < EVENTS; i += 1) broker.request("mail.send", { now: i });

    const drained = broker.drainAudit();
    const real = drained.filter((e) => e.capabilityId !== "audit");
    assert.equal(real.length, EVENTS, `${EVENTS - real.length} security events were lost`);
    assert.deepEqual(broker.drainAudit(), []);
  });

  it("numbers entries so a missing one is visible", () => {
    // A gap is invisible in a list of timestamps and obvious in a sequence.
    const broker = createBroker(policy({ ceiling: 2 }));
    for (let i = 0; i < 500; i += 1) broker.request("mail.send", { now: i });
    const seqs = broker
      .drainAudit()
      .map((e) => e.seq)
      .sort((a, b) => a - b);
    assert.equal(seqs.length, 500);
    assert.ok(seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1), "sequence has a gap");
  });

  it("only reclaims memory from entries already handed over", () => {
    const broker = createBroker(policy({ ceiling: 2 }));
    for (let i = 0; i < 3000; i += 1) broker.request("mail.send", { now: i });
    // Nothing drained yet, so nothing may be discarded.
    assert.equal(broker.auditBacklog(), 3000);

    broker.drainAudit();
    for (let i = 0; i < 3000; i += 1) broker.request("mail.send", { now: i });
    // Now the drained prefix can be trimmed, and the new events survive.
    assert.equal(broker.drainAudit().length, 3000);
  });

  it("records the backlog itself as an event when flushing stops", () => {
    const broker = createBroker(policy({ ceiling: 2 }));
    for (let i = 0; i < 10_050; i += 1) broker.request("mail.send", { now: i });
    const drained = broker.drainAudit();
    assert.ok(
      drained.some((e) => e.capabilityId === "audit" && /unpersisted/.test(e.detail)),
      "a stopped persister should be visible in the log, not a quiet period",
    );
  });
});

// ── Exactly once ─────────────────────────────────────────────────────────

async function approvedAction(reference: string): Promise<PendingAction> {
  const proposed = await runtime.propose({
    capabilityId: "calendar.propose",
    requestedBy: "voice",
    actionSummary: `Book ${reference}.`,
    args: { events: [{ summary: reference, startsAt: "2030-01-01T10:00:00Z" }] },
  });
  assert.ok(proposed.ok);
  const granted = await runtime.grantFor(proposed.action, "session-1", "ui");
  assert.ok(granted.ok);
  const all = await runtime.allPending();
  return all.find((a) => a.id === proposed.action.id) as PendingAction;
}

describe("execution happens at most once", () => {
  it("lets exactly one of two simultaneous callers claim it", async () => {
    const action = await approvedAction("concurrent");

    // Fired together, deliberately without awaiting between them.
    const [first, second] = await Promise.all([
      runtime.executeApproved(action.id, "session-1"),
      runtime.executeApproved(action.id, "session-1"),
    ]);

    const claimed = [first, second].filter((r) => !/already|not approved/.test(r.summary));
    assert.equal(claimed.length, 1, "both callers claimed the same action");

    const loser = [first, second].find((r) => /already|not approved/.test(r.summary));
    assert.ok(loser, "the second caller should have been turned away");
  });

  it("refuses a retry of something that already ran", async () => {
    const action = await approvedAction("retry");
    await runtime.executeApproved(action.id, "session-1");

    const again = await runtime.executeApproved(action.id, "session-1");
    assert.ok(!again.ok);
    assert.match(again.summary, /already|not approved/);
  });

  it("keys the ledger on the action, so two actions never collide", async () => {
    const a = await approvedAction("first");
    const b = await approvedAction("second");
    assert.notEqual(runtime.idempotencyKey(a), runtime.idempotencyKey(b));
    assert.ok(runtime.idempotencyKey(a).startsWith("calendar.propose:"));
  });

  it("releases the ledger entry when nothing actually ran", async () => {
    // The connector is unconfigured here, so the call is refused and reaches
    // nothing. A legitimate retry after fixing that must not be turned away
    // as a duplicate.
    const action = await approvedAction("released");
    const result = await runtime.executeApproved(action.id, "session-1");
    assert.ok(!result.ok, "the connector is not configured in tests");
    assert.equal(
      await runtime.hasExecuted(action),
      false,
      "a call that reached nothing must not be recorded as executed",
    );
  });

  it("reports the status rather than pretending, when it is not approved", async () => {
    const proposed = await runtime.propose({
      capabilityId: "calendar.propose",
      requestedBy: "ui",
      actionSummary: "Never approved.",
      args: { events: [] },
    });
    assert.ok(proposed.ok);
    const result = await runtime.executeApproved(proposed.action.id, "session-1");
    assert.ok(!result.ok);
    assert.match(result.summary, /not approved/);
  });

  it("never calls an ambiguous provider failure 'nothing happened'", async () => {
    // A timeout is not a failure — the provider can receive a request, perform
    // it, and lose the response. Treating that as failure and retrying is how
    // an email gets sent twice.
    const { TERMINAL } = await import("../lib/pending");
    assert.ok(
      TERMINAL.includes("outcome-uncertain"),
      "an uncertain outcome must not be retried automatically",
    );
  });

  it("keeps the ledger entry when the outcome is unknown", async () => {
    // The whole point of the distinction: a released ledger means "safe to
    // retry", and after a timeout that is exactly what it is not.
    const action = await approvedAction("uncertain");
    const runtimeModule = runtime as unknown as {
      executeApproved: typeof runtime.executeApproved;
    };

    // The connector is unconfigured, so this path is before-effect and does
    // release. The assertion that matters is the inverse condition: a result
    // carrying `uncertain` must not release.
    await runtimeModule.executeApproved(action.id, "session-1");
    assert.equal(await runtime.hasExecuted(action), false);

    const uncertainAction = await approvedAction("uncertain-2");
    await runtime.markUncertain(uncertainAction.id, "connection dropped mid-request");
    assert.equal(
      await runtime.hasExecuted(uncertainAction),
      true,
      "an uncertain outcome must leave the ledger entry in place",
    );
  });

  it("says so plainly for an action that does not exist", async () => {
    const result = await runtime.executeApproved("pa_missing", "session-1");
    assert.ok(!result.ok);
    assert.match(result.summary, /No such action/);
  });
});
