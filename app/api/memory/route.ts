import { NextResponse } from "next/server";
import { allFacts, forget, remember, type FactKind } from "@/lib/memory";

/** Memory is auditable by design: read it, add to it, delete from it. */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ facts: await allFacts() });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    text?: unknown;
    kind?: unknown;
  };
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return NextResponse.json({ error: "text required." }, { status: 400 });

  const kinds: FactKind[] = ["preference", "decision", "person", "constraint", "goal", "fact"];
  const kind = kinds.includes(body.kind as FactKind) ? (body.kind as FactKind) : "fact";

  return NextResponse.json({ fact: await remember(text, kind) });
}

export async function DELETE(request: Request) {
  const factId = new URL(request.url).searchParams.get("id");
  if (!factId) return NextResponse.json({ error: "id required." }, { status: 400 });
  return NextResponse.json({ forgotten: await forget(factId) });
}
