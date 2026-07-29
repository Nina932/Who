import { NextResponse } from "next/server";

import { guardMutation } from "@/lib/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ENDPOINT = "https://api.groq.com/openai/v1/audio/speech";
const DIRECTIONS = "[menacing] [deliberately]";
const MAX_TEXT = 165;

interface SpeechBody {
  text?: unknown;
}

export async function POST(request: Request) {
  const blocked = guardMutation(request);
  if (blocked) return blocked.response;

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Groq speech is not configured." },
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

  const speed = Number(process.env.MORPHEUS_TTS_SPEED ?? 1.02);
  const upstream = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model:
        process.env.MORPHEUS_TTS_MODEL ??
        "canopylabs/orpheus-v1-english",
      voice: process.env.MORPHEUS_TTS_VOICE ?? "troy",
      input: `${DIRECTIONS} ${text}`,
      response_format: "wav",
      sample_rate: 48_000,
      speed: Number.isFinite(speed) ? Math.min(1.2, Math.max(0.7, speed)) : 1.02,
    }),
    cache: "no-store",
  });

  if (!upstream.ok) {
    const detail = (await upstream.text()).slice(0, 400);
    return NextResponse.json(
      { error: "Groq speech was unavailable.", detail },
      { status: upstream.status },
    );
  }

  return new NextResponse(await upstream.arrayBuffer(), {
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "audio/wav",
      "cache-control": "no-store",
    },
  });
}
