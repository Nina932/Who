import { NextResponse } from "next/server";
import { guardMutation } from "@/lib/guard";
import { getOperatorContext, saveOperatorContext } from "@/lib/operator-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ context: await getOperatorContext() });
}

export async function POST(request: Request) {
  const blocked = guardMutation(request);
  if (blocked) return blocked.response;

  const body = (await request.json().catch(() => ({}))) as {
    description?: unknown;
    projectNotes?: unknown;
  };
  if (typeof body.description !== "string" || typeof body.projectNotes !== "string") {
    return NextResponse.json(
      { error: "description and projectNotes must be strings" },
      { status: 400 },
    );
  }

  return NextResponse.json({
    context: await saveOperatorContext({
      description: body.description,
      projectNotes: body.projectNotes,
    }),
  });
}
