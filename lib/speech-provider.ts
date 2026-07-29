/**
 * Where spoken audio comes from.
 *
 * There was one provider and no seam, so when Groq refused Orpheus for want of
 * an organisation-level terms acceptance, the cockpit had nowhere to go but
 * the operating system's own narrator — losing the mechanical processing
 * entirely, because `SpeechSynthesis` output cannot be routed into a Web Audio
 * graph. An approval nobody in the room can grant should not be able to take
 * the voice away.
 *
 * So providers are a list, tried in order. Groq stays first: Orpheus is the
 * intended voice and takes back over by itself the moment its terms clear,
 * with no code change. Gemini sits behind it and returns real audio today.
 *
 * Both return a WAV buffer, whatever they emit natively — the chain downstream
 * takes a buffer and does not care who produced it.
 */

import { sampleRateFromMimeType, wavFromPcm16 } from "./wav";

export type SpeechProviderId = "groq" | "gemini" | "local";

export interface SpeechAudio {
  wav: Uint8Array;
  provider: SpeechProviderId;
  model: string;
  voice: string;
}

export interface SpeechFailure {
  provider: SpeechProviderId;
  /** HTTP status, or 0 when the request never completed. */
  status: number;
  /** One line, safe to show an operator, saying what to actually do. */
  reason: string;
  /** Upstream body, truncated. For logs, not for the interface. */
  detail: string;
}

export type SpeechOutcome =
  | { ok: true; audio: SpeechAudio; failures: SpeechFailure[] }
  | { ok: false; failures: SpeechFailure[] };

const GROQ_BASE = process.env.GROQ_BASE_URL ?? "https://api.groq.com";
const GOOGLE_BASE =
  process.env.GOOGLE_API_BASE_URL ?? "https://generativelanguage.googleapis.com";

/**
 * Vocal directions, kept generic on purpose.
 *
 * The register is reached by the processing in `lib/voice-chain.ts`, not by
 * asking a model to sound like somebody. No performer is named here, and none
 * should be: an impersonation is a rights problem, and a slightly-wrong one
 * sounds cheaper than an original voice built to the same spec.
 */
const DIRECTIONS = "[menacing] [deliberately]";

export const MAX_TEXT = 165;

const truncate = (text: string) => text.slice(0, 400);

/**
 * Turn a refusal into an instruction.
 *
 * The terms case is the only one that is both common and invisible: it looks
 * exactly like an outage from the cockpit, and it is fixed in a browser by an
 * organisation admin rather than anywhere in this codebase.
 */
function reasonFor(provider: SpeechProviderId, status: number, detail: string): string {
  if (/model_terms_required|requires terms acceptance/i.test(detail)) {
    return "Groq has not accepted the Orpheus model terms.";
  }
  if (status === 401 || status === 403) return `${provider} rejected the API key.`;
  if (status === 429) return `${provider} rate limit reached.`;
  return `${provider} returned ${status}.`;
}

async function synthesizeGroq(text: string, apiKey: string): Promise<SpeechAudio> {
  const model = process.env.MORPHEUS_TTS_MODEL ?? "canopylabs/orpheus-v1-english";
  const voice = process.env.MORPHEUS_TTS_VOICE ?? "troy";
  // The chain detunes the result, which also lengthens it by about twelve
  // percent, so slightly quicker delivery lands at a deliberate pace.
  const speed = Number(process.env.MORPHEUS_TTS_SPEED ?? 1.1);

  const response = await fetch(`${GROQ_BASE}/openai/v1/audio/speech`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      voice,
      input: `${DIRECTIONS} ${text}`,
      response_format: "wav",
      sample_rate: 48_000,
      speed: Number.isFinite(speed) ? Math.min(1.2, Math.max(0.7, speed)) : 1.1,
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    throw Object.assign(new Error("groq speech failed"), {
      status: response.status,
      detail: truncate(await response.text()),
    });
  }

  return { wav: new Uint8Array(await response.arrayBuffer()), provider: "groq", model, voice };
}

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { inlineData?: { mimeType?: unknown; data?: unknown } }[] };
  }[];
}

async function synthesizeGemini(text: string, apiKey: string): Promise<SpeechAudio> {
  const model = process.env.MORPHEUS_GEMINI_TTS_MODEL ?? "gemini-3.1-flash-tts-preview";
  // Deep and even rather than bright. The chain supplies the weight and the
  // metal; what it needs underneath is clear diction, because a voice pitched
  // this far down turns any mushiness into mud.
  const voice = process.env.MORPHEUS_GEMINI_TTS_VOICE ?? "Charon";

  const response = await fetch(
    `${GOOGLE_BASE}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        // No style direction, deliberately.
        //
        // Gemini takes direction as plain language, and every phrasing tried
        // slowed it down — "slowly, low and deliberate" to 1.13 words/second,
        // and even tone-only wording like "with calm authority" to 1.85. The
        // chain then detunes the result, which costs a further twelve percent,
        // so a direction that sounds right in isolation compounds into a drag.
        // Undirected text measures 2.31 words/second and lands near 2.06 after
        // processing, which is unhurried without dragging. The register is the
        // chain's job; the model's job is clear diction at a normal pace.
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
      }),
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw Object.assign(new Error("gemini speech failed"), {
      status: response.status,
      detail: truncate(await response.text()),
    });
  }

  const body = (await response.json()) as GeminiResponse;
  const part = body.candidates?.[0]?.content?.parts?.find((entry) => entry.inlineData);
  const encoded = part?.inlineData?.data;
  if (typeof encoded !== "string" || encoded.length === 0) {
    throw Object.assign(new Error("gemini returned no audio"), {
      status: 502,
      detail: truncate(JSON.stringify(body)),
    });
  }

  // Bare PCM, with the rate carried in the MIME type and nowhere else.
  const mimeType = typeof part?.inlineData?.mimeType === "string" ? part.inlineData.mimeType : "";
  const pcm = Uint8Array.from(Buffer.from(encoded, "base64"));
  return {
    wav: wavFromPcm16(pcm, sampleRateFromMimeType(mimeType)),
    provider: "gemini",
    model,
    voice,
  };
}

/**
 * The offline voice.
 *
 * Both hosted providers can be taken away by something outside this codebase —
 * Orpheus by an organisation terms acceptance only a Groq admin can give,
 * Gemini by a free-tier quota of ten requests a day. When they are, the
 * cockpit was left with the operating system's narrator, which cannot carry
 * any of the processing.
 *
 * eSpeak-NG compiled to WebAssembly has none of those dependencies: no key, no
 * quota, no terms, no network, and nothing to install on Windows. On its own
 * it sounds like a 1980s speech synthesiser, which for once is the right
 * starting material — the chain is trying to build a machine that talks, and
 * a flat robotic source pitched down with a sub-octave layer under it gets
 * there more convincingly than a smooth human voice does.
 *
 * Last in the order, so it is what remains rather than what is preferred.
 */
async function synthesizeLocal(text: string): Promise<SpeechAudio> {
  const voice = process.env.MORPHEUS_LOCAL_TTS_VOICE ?? "en-us+m3";
  const speed = Number(process.env.MORPHEUS_LOCAL_TTS_SPEED ?? 145);
  const pitch = Number(process.env.MORPHEUS_LOCAL_TTS_PITCH ?? 25);

  const { default: text2wav } = await import("text2wav");
  // `amplitude` is deliberately not passed: this build returns a structurally
  // valid WAV of pure silence when it is set, which is indistinguishable from
  // working until someone tries to listen. Level is the chain's job anyway.
  const wav = await text2wav(text, {
    voice,
    speed: Number.isFinite(speed) ? speed : 145,
    pitch: Number.isFinite(pitch) ? pitch : 25,
  });

  return { wav: new Uint8Array(wav), provider: "local", model: "espeak-ng", voice };
}

interface Candidate {
  id: SpeechProviderId;
  key?: string;
  run: (text: string, key: string) => Promise<SpeechAudio>;
}

/**
 * Providers in preference order.
 *
 * Groq is first because Orpheus is the intended voice; the ordering is what
 * makes the eventual terms acceptance a no-op rather than a migration. The
 * local synthesiser is always last and always present — it needs no key, so
 * there is no configuration under which the cockpit has no voice at all.
 *
 * Set MORPHEUS_LOCAL_TTS=off to drop it and fall back to the browser instead.
 */
export function speechCandidates(): Candidate[] {
  const hosted: Candidate[] = [
    { id: "groq", key: process.env.GROQ_API_KEY, run: synthesizeGroq },
    {
      id: "gemini",
      key: process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY,
      run: synthesizeGemini,
    },
  ];
  const configured = hosted.filter((candidate) => Boolean(candidate.key));

  if (process.env.MORPHEUS_LOCAL_TTS === "off") return configured;
  return [...configured, { id: "local", key: "built-in", run: (text) => synthesizeLocal(text) }];
}

/**
 * Ask each configured provider in turn until one returns audio.
 *
 * Failures are collected rather than discarded: when the primary is refused
 * and a later one succeeds, the reason the *intended* voice was unavailable is
 * still the thing worth telling the operator. A silent substitution is what
 * made this hard to diagnose in the first place.
 */
export async function synthesizeSpeech(text: string): Promise<SpeechOutcome> {
  const failures: SpeechFailure[] = [];

  for (const candidate of speechCandidates()) {
    try {
      const audio = await candidate.run(text, candidate.key as string);
      return { ok: true, audio, failures };
    } catch (error) {
      const status =
        typeof (error as { status?: unknown }).status === "number"
          ? (error as { status: number }).status
          : 0;
      const detail =
        typeof (error as { detail?: unknown }).detail === "string"
          ? (error as { detail: string }).detail
          : error instanceof Error
            ? error.message
            : String(error);
      failures.push({
        provider: candidate.id,
        status,
        reason: reasonFor(candidate.id, status, detail),
        detail,
      });
    }
  }

  return { ok: false, failures };
}
