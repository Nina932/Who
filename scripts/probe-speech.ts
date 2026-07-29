/**
 * Prove the voice, end to end.
 *
 *   npm run probe:speech
 *   npm run probe:speech -- "Say this instead."
 *
 * Two things had been taken on faith. Whether Groq would actually return
 * Orpheus audio once the model terms were accepted, and whether the mechanical
 * processing was doing anything to the result. Neither is visible from the
 * cockpit: when the provider refuses, playback quietly falls back to the
 * ordinary system voice, which sounds like the work was never done.
 *
 * So this asks the provider directly, reports exactly why it refused when it
 * does, and — on success — writes two files: what the provider sent, and the
 * same audio through the mechanical chain. The measurements printed alongside
 * are the answer to "is the processing actually playing"; the files are there
 * because a number is not a voice and the ear is the real judge.
 *
 * Nothing here is used by the running application. It reads a key and writes
 * audio to a scratch directory, and is meant to be run by hand.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { speechCandidates, synthesizeSpeech } from "../lib/speech-provider";
import { MECHANICAL } from "../lib/voice-chain";
import { bandEnergy } from "../lib/voice-dsp";
import { measure, renderMechanical, toMono, type VoiceMeasurement } from "../lib/voice-render";
import { decodeWav, encodeWav } from "../lib/wav";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENDPOINT = "https://api.groq.com/openai/v1/audio/speech";
const TERMS_URL = "https://console.groq.com/playground?model=canopylabs/orpheus-v1-english";

const DEFAULT_LINE = "The calendar is protected. Two decisions are waiting on you.";

/**
 * The launcher loads `.env.local` before starting the cockpit; running this
 * script by hand does not go through the launcher, so it loads the same file
 * itself. Real environment variables win — an exported key is a deliberate
 * override.
 */
async function loadLocalEnvironment(): Promise<void> {
  let contents: string;
  try {
    contents = await readFile(join(ROOT, ".env.local"), "utf8");
  } catch {
    return;
  }
  for (const line of contents.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const [, name, rawValue] = match;
    if (process.env[name]) continue;
    const value =
      (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'"))
        ? rawValue.slice(1, -1)
        : rawValue;
    process.env[name] = value;
  }
}

interface ModelListing {
  data?: { id?: unknown; owned_by?: unknown }[];
}

/**
 * Say what this key can actually reach.
 *
 * A refusal names one model and stops there, which leaves the obvious next
 * question — *then what can I use* — unanswered and only findable by clicking
 * around a console. The model list is readable with the same key, so the probe
 * answers it directly. Names are matched loosely because Groq's speech models
 * have not shared a prefix.
 */
async function reportSpeechModels(apiKey: string): Promise<void> {
  let listing: ModelListing;
  try {
    const response = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      console.error(`Could not list models: HTTP ${response.status}.`);
      return;
    }
    listing = (await response.json()) as ModelListing;
  } catch (error) {
    console.error(`Could not list models: ${error instanceof Error ? error.message : error}`);
    return;
  }

  const ids = (listing.data ?? [])
    .map((entry) => (typeof entry.id === "string" ? entry.id : ""))
    .filter(Boolean)
    .sort();
  const speech = ids.filter((id) => /tts|speech|orpheus|playai|voice|audio/i.test(id));

  if (speech.length === 0) {
    console.error(
      `The key is valid — ${ids.length} models are visible — but none of them look\n` +
        `like text-to-speech, so this org has no speech model available yet.\n`,
    );
    return;
  }

  console.error(
    `The key is valid. Speech-capable models visible to this org:\n` +
      speech.map((id) => `  ${id}`).join("\n") +
      `\n\nAny of these can be tried without waiting, by setting it in .env.local:\n` +
      `  MORPHEUS_TTS_MODEL=<id>\n` +
      `and running the probe again. Voices differ per model, so MORPHEUS_TTS_VOICE\n` +
      `may need changing too if the model rejects "troy".\n`,
  );
}

const format = (measurement: VoiceMeasurement) =>
  [
    `    duration          ${measurement.seconds.toFixed(2)}s`,
    `    rms               ${measurement.rms.toFixed(4)}`,
    `    peak              ${measurement.peak.toFixed(4)}`,
    `    low/high energy   ${measurement.lowToHighRatio.toFixed(2)}`,
    `    ${MECHANICAL.modulatorHz}Hz modulation  ${measurement.modulationIndex.toFixed(4)}`,
  ].join("\n");

async function main(): Promise<number> {
  await loadLocalEnvironment();

  const candidates = speechCandidates();
  if (candidates.length === 0) {
    console.error(
      "No speech provider is configured. Set GROQ_API_KEY or GOOGLE_API_KEY in\n" +
        ".env.local, then run again.",
    );
    return 2;
  }

  const text = process.argv.slice(2).join(" ").trim() || DEFAULT_LINE;
  console.log(
    `Asking for speech, in order: ${candidates.map((entry) => entry.id).join(" then ")}.\n` +
      `  text  "${text}"\n`,
  );

  // The same call the cockpit makes, so a pass here means the cockpit works
  // rather than meaning this script works.
  const outcome = await synthesizeSpeech(text);

  for (const failure of outcome.failures) {
    console.error(`${failure.provider} did not answer: ${failure.reason}`);
    if (/terms/i.test(failure.reason)) {
      console.error(
        `\nTerms are accepted per *organization*, not per user, and only an admin\n` +
          `of that organization can accept them. If you have already clicked\n` +
          `accept, the usual cause is that it happened on a different org than\n` +
          `the one this GROQ_API_KEY belongs to — check the org switcher at the\n` +
          `top left of the console against Settings > API Keys.\n\n  ${TERMS_URL}\n`,
      );
    }
    if (failure.detail) console.error(`${failure.detail}\n`);
  }

  if (!outcome.ok) {
    // A dead end is not useful on its own. What the org *can* reach is,
    // because any of it can be dropped straight into MORPHEUS_TTS_MODEL.
    const groqKey = process.env.GROQ_API_KEY;
    if (groqKey) await reportSpeechModels(groqKey);
    return 3;
  }

  const raw = outcome.audio.wav;
  const decoded = decodeWav(raw);
  const mono = toMono(decoded.channels);
  const processed = renderMechanical(mono, decoded.sampleRate);

  const outputDirectory = join(ROOT, ".morpheus", "speech-probe");
  await mkdir(outputDirectory, { recursive: true });
  const rawPath = join(outputDirectory, "provider.wav");
  const processedPath = join(outputDirectory, "mechanical.wav");
  await writeFile(rawPath, raw);
  await writeFile(
    processedPath,
    encodeWav({ sampleRate: decoded.sampleRate, channels: [processed] }),
  );

  const before = measure(mono, decoded.sampleRate);
  const after = measure(processed, decoded.sampleRate);

  console.log(
    `${outcome.audio.provider} answered with ${raw.byteLength} bytes at ` +
      `${decoded.sampleRate}Hz.\n  model ${outcome.audio.model}\n` +
      `  voice ${outcome.audio.voice}\n`,
  );
  console.log("  as provided\n" + format(before) + "\n");
  console.log("  through the mechanical chain\n" + format(after) + "\n");
  // The band a sub-octave layer lands in for any adult male voice. If this
  // does not move, the layer was built and then filtered away.
  const subBefore = bandEnergy(mono, 40, 95, decoded.sampleRate);
  const subAfter = bandEnergy(processed, 40, 95, decoded.sampleRate);

  console.log(
    `  pitch      ${(after.seconds / Math.max(before.seconds, 1e-9)).toFixed(3)}x longer ` +
      `(${MECHANICAL.detuneCents} cents down)\n` +
      `  weight     low/high energy ${(after.lowToHighRatio / Math.max(before.lowToHighRatio, 1e-9)).toFixed(2)}x\n` +
      `  sub-octave 40-95Hz energy ${(subAfter / Math.max(subBefore, 1e-15)).toFixed(2)}x\n` +
      `  modulation ${before.modulationIndex.toFixed(4)} to ${after.modulationIndex.toFixed(4)}\n`,
  );
  console.log(`Listen and compare:\n  ${rawPath}\n  ${processedPath}`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
