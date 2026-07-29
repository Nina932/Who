import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, describe, it } from "node:test";

import { speechCandidates, synthesizeSpeech } from "../lib/speech-provider";
import { decodeWav } from "../lib/wav";

const KEYS = ["GROQ_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY"] as const;
const realFetch = globalThis.fetch;

function withKeys(keys: Partial<Record<(typeof KEYS)[number], string>>): void {
  for (const name of KEYS) {
    if (keys[name]) process.env[name] = keys[name];
    else delete process.env[name];
  }
}

/** A WAV the decoder will accept, so a "success" is a real one. */
function wavBytes(frames = 240): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(44 + frames * 2);
  const view = new DataView(bytes.buffer);
  const tag = (at: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(at + i, text.charCodeAt(i));
  };
  tag(0, "RIFF");
  view.setUint32(4, 36 + frames * 2, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 48_000, true);
  view.setUint32(28, 96_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, frames * 2, true);
  return bytes;
}

const TERMS_BODY = JSON.stringify({
  error: {
    message: "The model `canopylabs/orpheus-v1-english` requires terms acceptance.",
    code: "model_terms_required",
  },
});

interface Call {
  url: string;
  body: string;
}

/** Route each request by host, and record what was asked for. */
function stubFetch(
  handlers: { groq?: () => Response; gemini?: () => Response },
): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: typeof init?.body === "string" ? init.body : "" });
    const handler = url.includes("groq.com") ? handlers.groq : handlers.gemini;
    if (!handler) throw new Error(`unexpected request to ${url}`);
    return handler();
  }) as typeof globalThis.fetch;
  return calls;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  withKeys({});
});

describe("speech providers", () => {
  it("offers nothing when no key is configured", () => {
    withKeys({});
    assert.deepEqual(speechCandidates(), []);
  });

  it("prefers Groq, so Orpheus takes back over the moment its terms clear", () => {
    withKeys({ GROQ_API_KEY: "g", GOOGLE_API_KEY: "k" });
    assert.deepEqual(
      speechCandidates().map((candidate) => candidate.id),
      ["groq", "gemini"],
    );
  });

  it("never reaches the second provider when the first answers", async () => {
    withKeys({ GROQ_API_KEY: "g", GOOGLE_API_KEY: "k" });
    const calls = stubFetch({
      groq: () => new Response(wavBytes(), { status: 200 }),
    });

    const outcome = await synthesizeSpeech("The calendar is protected.");
    assert.equal(outcome.ok, true);
    assert.equal(calls.length, 1);
    if (outcome.ok) {
      assert.equal(outcome.audio.provider, "groq");
      assert.deepEqual(outcome.failures, []);
    }
  });

  it("falls through to Gemini when Orpheus terms are missing", async () => {
    withKeys({ GROQ_API_KEY: "g", GOOGLE_API_KEY: "k" });
    stubFetch({
      groq: () => new Response(TERMS_BODY, { status: 400 }),
      gemini: () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      inlineData: {
                        mimeType: "audio/L16;codec=pcm;rate=24000",
                        data: Buffer.from(new Uint8Array(480)).toString("base64"),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });

    const outcome = await synthesizeSpeech("The calendar is protected.");
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;

    assert.equal(outcome.audio.provider, "gemini");
    // The substitution must be reported, not swallowed — an unexplained
    // change of voice is exactly what made this hard to diagnose.
    assert.equal(outcome.failures.length, 1);
    assert.match(outcome.failures[0].reason, /terms/i);
  });

  it("wraps Gemini's bare PCM into audio a browser can decode", async () => {
    withKeys({ GOOGLE_API_KEY: "k" });
    // A recognisable ramp, so the samples can be checked for survival.
    const pcm = new Uint8Array(400);
    for (let i = 0; i < pcm.length; i += 1) pcm[i] = i % 256;
    stubFetch({
      gemini: () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      inlineData: {
                        mimeType: "audio/L16;codec=pcm;rate=24000",
                        data: Buffer.from(pcm).toString("base64"),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        ),
    });

    const outcome = await synthesizeSpeech("Two decisions are waiting.");
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;

    const decoded = decodeWav(outcome.audio.wav);
    assert.equal(decoded.sampleRate, 24_000, "the rate is only stated in the MIME type");
    assert.equal(decoded.channels.length, 1);
    assert.equal(decoded.channels[0].length, pcm.length / 2);
  });

  it("reports every refusal when nothing answers", async () => {
    withKeys({ GROQ_API_KEY: "g", GOOGLE_API_KEY: "k" });
    stubFetch({
      groq: () => new Response(TERMS_BODY, { status: 400 }),
      gemini: () => new Response("nope", { status: 401 }),
    });

    const outcome = await synthesizeSpeech("Anything.");
    assert.equal(outcome.ok, false);
    assert.equal(outcome.failures.length, 2);
    assert.match(outcome.failures[1].reason, /key/i);
  });

  it("asks a named performer for nothing", async () => {
    const source = await readFile(new URL("../lib/speech-provider.ts", import.meta.url), "utf8");
    // The register comes from the processing chain. Requesting an
    // impersonation would be both a rights problem and a worse result.
    assert.doesNotMatch(source, /Optimus|Megatron|Peter Cullen|Hugo Weaving/i);
    assert.match(source, /\[menacing\] \[deliberately\]/);
  });

  it("keeps every credential server-side", async () => {
    const provider = await readFile(
      new URL("../lib/speech-provider.ts", import.meta.url),
      "utf8",
    );
    assert.match(provider, /process\.env\.GROQ_API_KEY/);
    assert.match(provider, /process\.env\.GOOGLE_API_KEY/);
    assert.doesNotMatch(provider, /NEXT_PUBLIC/);

    const route = await readFile(new URL("../app/api/speech/route.ts", import.meta.url), "utf8");
    assert.match(route, /guardMutation\(request\)/);
    assert.doesNotMatch(route, /NEXT_PUBLIC/);
    // The route may *name* the variables to configure — that is useful
    // guidance — but must not read them; selecting a provider is not its job.
    assert.doesNotMatch(route, /process\.env\.\w*API_KEY/);
    assert.match(route, /Set GROQ_API_KEY or GOOGLE_API_KEY/);
  });
});
