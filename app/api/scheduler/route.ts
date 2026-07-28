import { NextResponse } from "next/server";
import { guardMutation } from "@/lib/guard";
import {
  ensureSchedulerStarted,
  getSchedule,
  schedulerRunning,
  setEnabled,
  tick,
} from "@/lib/scheduler";

/**
 * The scheduler's control surface.
 *
 * GET starts the in-process timer if it is enabled and reports the schedule.
 * POST {action:"tick"} is the external-cron entry point, so this works on
 * hosts where a background timer would not survive between requests.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  // Next has no startup hook for route handlers, so the first read of this
  // endpoint is where the timer gets a chance to come up.
  const started = ensureSchedulerStarted();
  return NextResponse.json({
    running: schedulerRunning(),
    started,
    mode: process.env.THOR_SCHEDULER === "on" ? "in-process" : "external",
    schedule: await getSchedule(),
  });
}

export async function POST(request: Request) {
  const blocked = guardMutation(request);
  if (blocked) return blocked.response;

  const body = (await request.json().catch(() => ({}))) as {
    action?: unknown;
    loopId?: unknown;
    enabled?: unknown;
  };

  if (body.action === "tick") {
    return NextResponse.json(await tick());
  }

  if (body.action === "set-enabled") {
    if (typeof body.loopId !== "string" || typeof body.enabled !== "boolean") {
      return NextResponse.json(
        { error: "loopId and enabled required." },
        { status: 400 },
      );
    }
    return NextResponse.json({ schedule: await setEnabled(body.loopId, body.enabled) });
  }

  return NextResponse.json({ error: `Unknown action: ${String(body.action)}` }, { status: 400 });
}
