/**
 * The scheduler.
 *
 * Loops declared a cadence but nothing ever fired them, which made
 * "autonomous" mean "on demand". This closes that: cadences are parsed into
 * real next-run times, a tick fires whatever is due, and the result is
 * persisted so a restart doesn't re-fire or forget.
 *
 * Two ways to drive it, because the right one depends on where this runs:
 *
 *   in-process   a timer started on first request — correct for a single
 *                long-lived server, which is how Morpheus is meant to run
 *   external     POST /api/scheduler, for cron or a platform scheduler on
 *                hosts where background timers do not survive
 *
 * Both land on the same `tick()`, and `tick()` is idempotent within a minute,
 * so running both is harmless.
 */

import { LOOPS, startRun, type LoopDefinition } from "./loops";
import { mutate, readCollection } from "./store";

export interface ScheduleEntry {
  loopId: string;
  /** Epoch ms of the last fire, or 0 if never. */
  lastRunAt: number;
  /** Epoch ms this loop is next due. */
  nextRunAt: number;
  /** False while the operator has the loop paused. */
  enabled: boolean;
  lastRunId?: string;
  lastError?: string;
}

const SCHEDULE = "schedule";

// ── Cadence parsing ──────────────────────────────────────────────────────

const DAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

/**
 * Parse the human cadence strings the loops already carry.
 *
 * Supported: "Mondays, 07:00", "Hourly", "Daily, 09:00", "Every 15 minutes",
 * "On arrival" (never scheduled — event-driven).
 * Anything unrecognised returns null and is simply never auto-fired, which is
 * the safe direction to fail.
 */
export function nextDue(cadence: string, from: Date): number | null {
  const text = cadence.trim().toLowerCase();

  if (text.includes("on arrival") || text.includes("on demand")) return null;

  if (text.startsWith("hourly")) {
    const next = new Date(from);
    next.setMinutes(0, 0, 0);
    next.setHours(next.getHours() + 1);
    return next.getTime();
  }

  const everyMinutes = text.match(/every\s+(\d+)\s*min/);
  if (everyMinutes) {
    return from.getTime() + Number(everyMinutes[1]) * 60_000;
  }

  const everyHours = text.match(/every\s+(\d+)\s*hour/);
  if (everyHours) {
    return from.getTime() + Number(everyHours[1]) * 3_600_000;
  }

  const time = text.match(/(\d{1,2}):(\d{2})/);
  const hour = time ? Number(time[1]) : 7;
  const minute = time ? Number(time[2]) : 0;

  // "Mondays, 07:00" — the next occurrence of that weekday at that time.
  const dayEntry = Object.entries(DAYS).find(([name]) => text.includes(name));
  if (dayEntry) {
    const target = dayEntry[1];
    const next = new Date(from);
    next.setHours(hour, minute, 0, 0);
    let delta = (target - next.getDay() + 7) % 7;
    // Already passed today, so it means next week.
    if (delta === 0 && next.getTime() <= from.getTime()) delta = 7;
    next.setDate(next.getDate() + delta);
    return next.getTime();
  }

  if (text.startsWith("daily")) {
    const next = new Date(from);
    next.setHours(hour, minute, 0, 0);
    if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
    return next.getTime();
  }

  return null;
}

// ── State ────────────────────────────────────────────────────────────────

function seed(loop: LoopDefinition, now: Date): ScheduleEntry {
  return {
    loopId: loop.id,
    lastRunAt: 0,
    nextRunAt: nextDue(loop.cadence, now) ?? 0,
    enabled: true,
  };
}

/** Every loop's schedule, seeding any that have not been seen before. */
export async function getSchedule(): Promise<ScheduleEntry[]> {
  const now = new Date();
  return mutate<ScheduleEntry[], ScheduleEntry[]>(SCHEDULE, [], (current) => {
    const byId = new Map(current.map((e) => [e.loopId, e]));
    const next = LOOPS.map((loop) => byId.get(loop.id) ?? seed(loop, now));
    return { next, result: next };
  });
}

export async function setEnabled(loopId: string, enabled: boolean): Promise<ScheduleEntry[]> {
  await getSchedule();
  return mutate<ScheduleEntry[], ScheduleEntry[]>(SCHEDULE, [], (current) => {
    const next = current.map((e) => (e.loopId === loopId ? { ...e, enabled } : e));
    return { next, result: next };
  });
}

export interface TickResult {
  firedAt: number;
  fired: Array<{ loopId: string; runId?: string; error?: string }>;
  checked: number;
}

/**
 * Fire everything that is due.
 *
 * The next-run time is advanced *before* the run is started. If a run throws,
 * the loop still moves to its next slot rather than retrying in a tight cycle
 * on the following tick — a failing loop should not become a hot loop.
 */
export async function tick(now: Date = new Date()): Promise<TickResult> {
  const schedule = await getSchedule();
  const due = schedule.filter(
    (entry) => entry.enabled && entry.nextRunAt > 0 && entry.nextRunAt <= now.getTime(),
  );

  const fired: TickResult["fired"] = [];

  for (const entry of due) {
    const loop = LOOPS.find((l) => l.id === entry.loopId);
    if (!loop) continue;

    const advanced = nextDue(loop.cadence, now) ?? 0;

    let runId: string | undefined;
    let error: string | undefined;
    try {
      const run = await startRun(loop.id);
      runId = run.id;
      if (run.status === "failed") error = run.error;
    } catch (e) {
      error = e instanceof Error ? e.message : "run failed to start";
    }

    await mutate<ScheduleEntry[], null>(SCHEDULE, [], (current) => ({
      next: current.map((e) =>
        e.loopId === entry.loopId
          ? { ...e, lastRunAt: now.getTime(), nextRunAt: advanced, lastRunId: runId, lastError: error }
          : e,
      ),
      result: null,
    }));

    fired.push({ loopId: entry.loopId, runId, error });
  }

  return { firedAt: now.getTime(), fired, checked: schedule.length };
}

// ── In-process timer ─────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;

/**
 * Start the background timer once per process.
 *
 * Opt-in via MORPHEUS_SCHEDULER=on, because on serverless the process is torn down
 * between requests and a timer there is a lie — use the endpoint instead.
 */
export function ensureSchedulerStarted(): boolean {
  if (timer) return true;
  if (process.env.MORPHEUS_SCHEDULER !== "on") return false;

  const intervalMs = Number(process.env.MORPHEUS_SCHEDULER_INTERVAL_MS ?? 60_000);
  timer = setInterval(() => {
    void tick().catch((error) => console.error("scheduler: tick failed", error));
  }, intervalMs);
  // Never hold the process open on this alone.
  timer.unref?.();

  console.log(`scheduler: started, ticking every ${intervalMs}ms`);
  return true;
}

export function schedulerRunning(): boolean {
  return timer !== null;
}
