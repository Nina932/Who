import { NextResponse } from "next/server";
import { getProfile, getSamples, moreMyStyle, recordEdit } from "@/lib/style";

/**
 * Style learning.
 *
 * `edit` is the important endpoint: it is called when the operator ships a
 * changed version of a draft, and the diff is the training signal.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [profile, samples] = await Promise.all([getProfile(), getSamples()]);
  return NextResponse.json({
    profile,
    sampleCount: samples.length,
  });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    action?: unknown;
    draft?: unknown;
    edited?: unknown;
    surface?: unknown;
    text?: unknown;
  };

  const str = (v: unknown) => (typeof v === "string" ? v : undefined);

  if (body.action === "more-my-style") {
    const text = str(body.text);
    if (!text) return NextResponse.json({ error: "text required." }, { status: 400 });
    return NextResponse.json(await moreMyStyle(text));
  }

  const draft = str(body.draft);
  const edited = str(body.edited);
  if (!draft || !edited) {
    return NextResponse.json({ error: "draft and edited required." }, { status: 400 });
  }

  const profile = await recordEdit(draft, edited, str(body.surface) ?? "post");
  return NextResponse.json({ profile });
}
