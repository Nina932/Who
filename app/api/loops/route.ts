import { NextResponse } from "next/server";
import {
  LOOPS,
  advance,
  allLearnings,
  allRuns,
  approve,
  observe,
  reject,
  startRun,
} from "@/lib/loops";

/** The Loops Engine's control surface. Every action here mutates real state. */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [runs, learnings] = await Promise.all([allRuns(), allLearnings()]);
  return NextResponse.json({ loops: LOOPS, runs, learnings });
}

interface Body {
  action?: unknown;
  loopId?: unknown;
  runId?: unknown;
  input?: unknown;
  note?: unknown;
  outcome?: unknown;
}

export async function POST(request: Request) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Malformed body." }, { status: 400 });
  }

  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const action = str(body.action);
  const runId = str(body.runId);

  try {
    switch (action) {
      case "start": {
        const loopId = str(body.loopId);
        if (!loopId) return NextResponse.json({ error: "loopId required." }, { status: 400 });
        return NextResponse.json({ run: await startRun(loopId, str(body.input)) });
      }
      case "advance": {
        if (!runId) return NextResponse.json({ error: "runId required." }, { status: 400 });
        return NextResponse.json({ run: await advance(runId) });
      }
      case "approve": {
        if (!runId) return NextResponse.json({ error: "runId required." }, { status: 400 });
        return NextResponse.json({ run: await approve(runId, str(body.note)) });
      }
      case "reject": {
        const note = str(body.note);
        if (!runId || !note) {
          return NextResponse.json(
            { error: "runId and note required — a rejection without a reason teaches nothing." },
            { status: 400 },
          );
        }
        return NextResponse.json({ run: await reject(runId, note) });
      }
      case "observe": {
        const outcome = str(body.outcome);
        if (!runId || !outcome) {
          return NextResponse.json({ error: "runId and outcome required." }, { status: 400 });
        }
        return NextResponse.json({ learnings: await observe(runId, outcome) });
      }
      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (error) {
    console.error("loops route failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Loop action failed." },
      { status: 500 },
    );
  }
}
