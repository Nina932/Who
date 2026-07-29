import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * Cadence parsing decides when work happens without a human present, so the
 * arithmetic gets pinned — an off-by-one weekday means a Monday review fires
 * on Sunday night, unattended.
 */

let tmp: string;
let scheduler: typeof import("../lib/scheduler");

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "morpheus-sched-"));
  process.env.MORPHEUS_DATA_DIR = tmp;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  scheduler = await import("../lib/scheduler");
});

after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

// A Wednesday, 12:00 local.
const WED_NOON = new Date(2026, 6, 29, 12, 0, 0, 0);

describe("nextDue", () => {
  it("finds the next occurrence of a named weekday", () => {
    const next = scheduler.nextDue("Mondays, 07:00", WED_NOON);
    assert.ok(next);
    const date = new Date(next);
    assert.equal(date.getDay(), 1, "must land on a Monday");
    assert.equal(date.getHours(), 7);
    assert.equal(date.getMinutes(), 0);
    assert.ok(date.getTime() > WED_NOON.getTime());
  });

  it("rolls to next week when today is the day but the time has passed", () => {
    // Wednesday 12:00, asking for Wednesday 07:00 — already gone.
    const next = scheduler.nextDue("Wednesdays, 07:00", WED_NOON);
    assert.ok(next);
    const date = new Date(next);
    assert.equal(date.getDay(), 3);
    assert.ok(
      date.getTime() - WED_NOON.getTime() > 6 * 24 * 3600_000,
      "should be a week out, not earlier today",
    );
  });

  it("schedules hourly on the next hour boundary", () => {
    const next = scheduler.nextDue("Hourly", WED_NOON);
    assert.ok(next);
    const date = new Date(next);
    assert.equal(date.getMinutes(), 0);
    assert.equal(date.getHours(), 13);
  });

  it("handles interval cadences", () => {
    const next = scheduler.nextDue("Every 15 minutes", WED_NOON);
    assert.equal(next, WED_NOON.getTime() + 15 * 60_000);
  });

  it("rolls a daily cadence to tomorrow once the time has passed", () => {
    const next = scheduler.nextDue("Daily, 09:00", WED_NOON);
    assert.ok(next);
    const date = new Date(next);
    assert.equal(date.getDate(), WED_NOON.getDate() + 1);
    assert.equal(date.getHours(), 9);
  });

  it("never schedules an event-driven loop", () => {
    assert.equal(scheduler.nextDue("On arrival", WED_NOON), null);
  });

  it("fails safe on an unrecognised cadence", () => {
    // Returning null means "never auto-fire", which is the safe direction.
    assert.equal(scheduler.nextDue("whenever I feel like it", WED_NOON), null);
  });
});

describe("getSchedule", () => {
  it("seeds an entry for every loop", async () => {
    const schedule = await scheduler.getSchedule();
    const { LOOPS } = await import("../lib/loops");
    assert.equal(schedule.length, LOOPS.length);
    assert.ok(schedule.every((e) => e.enabled));
  });

  it("persists a pause", async () => {
    await scheduler.setEnabled("content-engine", false);
    const schedule = await scheduler.getSchedule();
    assert.equal(schedule.find((e) => e.loopId === "content-engine")?.enabled, false);
    await scheduler.setEnabled("content-engine", true);
  });
});

describe("tick", () => {
  it("fires nothing when nothing is due", async () => {
    const result = await scheduler.tick(WED_NOON);
    assert.equal(result.fired.length, 0);
    assert.ok(result.checked > 0);
  });

  it("fires a due loop and advances it past the current time", async () => {
    // Far enough in the future that every scheduled loop is overdue.
    const later = new Date(WED_NOON.getTime() + 30 * 24 * 3600_000);
    const result = await scheduler.tick(later);
    assert.ok(result.fired.length > 0, "overdue loops must fire");

    const schedule = await scheduler.getSchedule();
    for (const entry of schedule.filter((e) => e.nextRunAt > 0)) {
      assert.ok(
        entry.nextRunAt > later.getTime(),
        `${entry.loopId} must be rescheduled ahead of now`,
      );
    }
  });

  it("does not re-fire the same slot on a second tick", async () => {
    const later = new Date(WED_NOON.getTime() + 30 * 24 * 3600_000);
    const again = await scheduler.tick(later);
    assert.equal(again.fired.length, 0, "a fired slot must not repeat");
  });

  it("records the failure without stalling the loop", async () => {
    // With no keys the run fails immediately; the loop must still advance.
    const schedule = await scheduler.getSchedule();
    const fired = schedule.find((e) => e.lastRunAt > 0);
    assert.ok(fired, "something should have fired by now");
    assert.ok(fired?.lastError, "the failure reason must be recorded");
  });
});
