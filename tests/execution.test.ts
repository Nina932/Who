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

  it("does not skip an entry when the log is trimmed", () => {
    // Trimming moves the drain cursor with it; otherwise a busy broker would
    // silently drop un-persisted rows off the front.
    const broker = createBroker(policy({ ceiling: 2 }));
    for (let i = 0; i < 2100; i += 1) broker.request("mail.send", { now: i });
    const drained = broker.drainAudit();
    assert.ok(drained.length > 0);
    assert.ok(drained.length <= 2000);
    assert.deepEqual(broker.drainAudit(), []);
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

  it("says so plainly for an action that does not exist", async () => {
    const result = await runtime.executeApproved("pa_missing", "session-1");
    assert.ok(!result.ok);
    assert.match(result.summary, /No such action/);
  });
});
