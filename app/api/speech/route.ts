import { NextResponse } from "next/server";

import { guardMutation } from "@/lib/guard";
import { MAX_TEXT, speechCandidates, synthesizeSpeech } from "@/lib/speech-provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SpeechBody {
  text?: unknown;
}

export async function POST(request: Request) {
  const blocked = guardMutation(request);
  if (blocked) return blocked.response;

  if (speechCandidates().length === 0) {
    return NextResponse.json(
      { error: "No speech provider is configured. Set GROQ_API_KEY or GOOGLE_API_KEY." },
      { status: 503 },
    );
  }

  let body: SpeechBody;
  try {
    body = (await request.json()) as SpeechBody;
  } catch {
    return NextResponse.json({ error: "Malformed body." }, { status: 400 });
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text || text.length > MAX_TEXT) {
    return NextResponse.json(
      { error: `text must contain 1-${MAX_TEXT} characters.` },
      { status: 400 },
    );
  }

  const outcome = await synthesizeSpeech(text);

  if (!outcome.ok) {
    const [first] = outcome.failures;
    return NextResponse.json(
      {
        error: "Speech was unavailable.",
        // The reason belongs in the response because the browser fallback is
        // otherwise indistinguishable from the provider working badly.
        detail: outcome.failures.map((failure) => failure.reason).join(" "),
        upstream: first?.detail,
      },
      { status: first?.status && first.status >= 400 ? first.status : 502 },
    );
  }

  const headers = new Headers({
    "content-type": "audio/wav",
    "cache-control": "no-store",
    "x-voice-provider": outcome.audio.provider,
    "x-voice-model": outcome.audio.model,
  });
  // A provider answered, but not the first choice. The cockpit shows this so a
  // substituted voice is never mistaken for the intended one.
  if (outcome.failures.length > 0) {
    headers.set("x-voice-fallback-reason", outcome.failures[0].reason);
  }

  return new NextResponse(outcome.audio.wav as unknown as BodyInit, { headers });
}
