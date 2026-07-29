/**
 * How Morpheus sounds.
 *
 * An original profile, deliberately not an impersonation. Reproducing a
 * specific film character's voice would be someone else's performance wearing
 * this system's name — a rights problem, and worse, a derivative one. What is
 * wanted is the *register*, which is describable without copying anybody:
 *
 *   A very deep, deliberate, metallic command voice with controlled bass
 *   resonance. Restrained power, dry amusement, and clean consonants rather
 *   than shouting. Short pauses before conclusions; never chirpy or rushed.
 *
 * The browser gives three levers — pitch, rate, and which installed voice —
 * so this is what is reachable without shipping an audio pipeline. Real
 * metallic timbre needs ring modulation and a Web Audio graph, and
 * `SpeechSynthesis` output cannot be routed into one. A licensed TTS provider
 * returning a buffer is the path to the signature voice; the seam for it is
 * `deliveryFor`, which any backend can honour.
 */

import type { Risk } from "./intent";

export interface Delivery {
  /** Deep, but above the floor so the engine can still shape intonation. */
  pitch: number;
  /** Below about 0.7, diction smears on most installed voices. */
  rate: number;
  /** Milliseconds of silence inserted before a concluding sentence. */
  beatMs: number;
}

export const PROFILE = {
  name: "Morpheus",
  register: "Very deep mechanical baritone",
  cadence: "Slow, deliberate, clipped",
  texture: "Dense metallic resonance with clean consonants",
  emotion: "Controlled power with occasional dry amusement",
  delivery: "Weighted openings and short pauses before conclusions",
  never: ["shouts", "sounds chirpy", "hurries a consequential sentence"],
} as const;

const BASE: Delivery = {
  // Extreme pitch shifting makes browser voices stress the wrong syllables.
  // Keep enough weight to sound grounded while leaving the voice engine room
  // to perform its own sentence melody.
  pitch: Number(process.env.NEXT_PUBLIC_MORPHEUS_VOICE_PITCH ?? 0.68),
  rate: Number(process.env.NEXT_PUBLIC_MORPHEUS_VOICE_RATE ?? 0.88),
  beatMs: 240,
};

/** Turn written UI punctuation into something browser TTS can phrase naturally. */
export function speechText(text: string): string {
  return text
    .replace(/\[source:[^\]]*\]/gi, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^\s*(?:[-*•]|\d+[.)])\s*/gm, "")
    .replace(/[*_`#]/g, "")
    .replace(/\s+[—–]\s+/g, ", ")
    .replace(/\s*;\s*/g, ", ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .trim();
}

/**
 * Split completed speech at natural boundaries for providers with short input
 * limits. The words are unchanged; only whitespace at a boundary is removed.
 */
export function speechChunks(text: string, maxLength = 165): string[] {
  const remaining = speechText(text);
  if (!remaining || maxLength < 20) return remaining ? [remaining] : [];

  const chunks: string[] = [];
  let rest = remaining;
  while (rest.length > maxLength) {
    const window = rest.slice(0, maxLength + 1);
    const sentence = Math.max(
      window.lastIndexOf(". "),
      window.lastIndexOf("? "),
      window.lastIndexOf("! "),
    );
    const comma = Math.max(window.lastIndexOf(", "), window.lastIndexOf(": "));
    const whitespace = window.lastIndexOf(" ");
    const cut =
      sentence >= Math.floor(maxLength * 0.45)
        ? sentence + 1
        : comma >= Math.floor(maxLength * 0.6)
          ? comma + 1
          : whitespace > 0
            ? whitespace
            : maxLength;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/**
 * A sound is not an interruption. Only an explicit floor-taking phrase is.
 *
 * Speech recognition commonly spells the name phonetically, so the small
 * alias set covers observed variants without turning ordinary words into
 * commands.
 */
export function isSpokenInterrupt(text: string): boolean {
  const phrase = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /^(?:morpheus|morphius|morphews|morpheous|murphy)\b|^(?:stop|wait|pause|quiet|enough|hold on)\b/.test(
    phrase,
  );
}

function spokenWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s-]/gu, " ")
    .replace(/[-']/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Remove speech-synthesis audio that recognition returns as operator speech.
 *
 * Echo cancellation is helpful, not authoritative. Chromium can deliver the
 * final recognition result after playback has technically ended, so a boolean
 * "speaking" flag alone still leaks a whole assistant sentence into the next
 * turn. This finds a substantial spoken prefix anywhere in the last playback,
 * drops it, and preserves any genuinely new words the operator appended.
 */
export function withoutPlaybackEcho(
  transcript: string,
  lastPlayback: string,
): string {
  const heard = spokenWords(transcript);
  const spoken = spokenWords(lastPlayback);
  if (heard.length < 5 || spoken.length < 5) return transcript.trim();

  const maxPrefix = Math.min(heard.length, spoken.length);
  for (let length = maxPrefix; length >= 5; length -= 1) {
    if (length < Math.ceil(spoken.length * 0.45)) continue;
    for (let start = 0; start + length <= spoken.length; start += 1) {
      let matches = 0;
      for (let index = 0; index < length; index += 1) {
        if (heard[index] === spoken[start + index]) matches += 1;
      }
      if (matches / length < 0.72) continue;
      return heard.slice(length).join(" ");
    }
  }
  return transcript.trim();
}

/**
 * Delivery shifts with risk — the one expressive rule worth having.
 *
 * Not louder. *Tighter*: fractionally quicker and a shade less resonant, the
 * way a person drops the performance when something actually matters. A voice
 * that sounds identical announcing the weather and announcing that money is
 * about to leave your account is a voice you stop listening to.
 *
 * The floor is never crossed — no risk level makes Morpheus hurried.
 */
export function deliveryFor(risk: Risk): Delivery {
  switch (risk) {
    case "high":
      return { pitch: Math.min(2, BASE.pitch + 0.15), rate: Math.min(1, BASE.rate + 0.1), beatMs: 420 };
    case "medium":
      return { pitch: Math.min(2, BASE.pitch + 0.05), rate: Math.min(1, BASE.rate + 0.05), beatMs: 340 };
    default:
      return { ...BASE };
  }
}

/**
 * Voices to look for, deepest first.
 *
 * "David" and "Mark" ship with Windows, "Daniel" and "Alex" with macOS. None
 * of them is the intended voice; they are the closest the platform offers
 * until a real TTS backend is wired in.
 */
export const PREFERRED_VOICES = [
  "guy natural",
  "andrew natural",
  "ryan natural",
  "christopher natural",
  "eric natural",
  "guy",
  "andrew",
  "ryan",
  "christopher",
  "david",
  "mark",
  "daniel",
  "alex",
  "george",
  "rishi",
];
