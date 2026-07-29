import { NextResponse } from "next/server";
import { guardMutation } from "@/lib/guard";
import { WORKFLOWS } from "@/lib/cases";
import {
  appendEvent,
  caseViews,
  clearExamples,
  openCase,
  proposeEvent,
  seedExamples,
} from "@/lib/case-store";

/**
 * The case ledger.
 *
 * Reads project the event log at request time, so the turn a case is on is
 * never stale — it is computed against the clock on every call rather than
 * recalculated by a background job that might not have run.
 *
 * There is no update action. Every write is an appended event.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const views = await caseViews();
  return NextResponse.json({ cases: views, workflows: Object.values(WORKFLOWS) });
}

interface Body {
  action?: unknown;
  caseId?: unknown;
  type?: unknown;
  note?: unknown;
  title?: unknown;
  counterparty?: unknown;
  value?: unknown;
  dueAt?: unknown;
  message?: unknown;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export async function POST(request: Request) {
  const blocked = guardMutation(request);
  if (blocked) return blocked.response;

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Malformed body." }, { status: 400 });
  }

  try {
    switch (str(body.action)) {
      case "open": {
        const title = str(body.title);
        const counterparty = str(body.counterparty);
        if (!title || !counterparty) {
          return NextResponse.json(
            { error: "A case needs a title and a counterparty — it is somebody's commitment." },
            { status: 400 },
          );
        }
        await openCase({ title, counterparty, value: num(body.value), note: str(body.note) });
        return NextResponse.json({ cases: await caseViews() });
      }

      case "event": {
        const caseId = str(body.caseId);
        const type = str(body.type);
        if (!caseId || !type) {
          return NextResponse.json({ error: "caseId and type required." }, { status: 400 });
        }

        const data: Record<string, unknown> = {};
        if (num(body.value) !== undefined) data.value = num(body.value);
        if (num(body.dueAt) !== undefined) data.dueAt = num(body.dueAt);

        const updated = await appendEvent(caseId, {
          type,
          note: str(body.note),
          data: Object.keys(data).length > 0 ? data : undefined,
        });
        if (!updated) return NextResponse.json({ error: "Unknown case." }, { status: 404 });

        return NextResponse.json({ cases: await caseViews() });
      }

      case "interpret": {
        // Layer three. Returns a proposal; committing it is a separate call,
        // which is the only thing that keeps a model out of the business record.
        const caseId = str(body.caseId);
        const message = str(body.message);
        if (!caseId || !message) {
          return NextResponse.json({ error: "caseId and message required." }, { status: 400 });
        }
        const view = (await caseViews()).find((candidate) => candidate.id === caseId);
        if (!view) return NextResponse.json({ error: "Unknown case." }, { status: 404 });

        return NextResponse.json({ proposal: await proposeEvent(view, message) });
      }

      case "seed-examples": {
        const added = await seedExamples();
        return NextResponse.json({ added, cases: await caseViews() });
      }

      case "clear-examples": {
        const removed = await clearExamples();
        return NextResponse.json({ removed, cases: await caseViews() });
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${String(body.action)}` }, { status: 400 });
    }
  } catch (error) {
    console.error("cases route failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Case action failed." },
      { status: 500 },
    );
  }
}
