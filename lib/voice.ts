/**
 * How Morpheus sounds.
 *
 * An original profile, deliberately not an impersonation. Reproducing a
 * specific film character's voice would be someone else's performance wearing
 * this system's name — a rights problem, and worse, a derivative one. What is
 * wanted is the *register*, which is describable without copying anybody:
 *
 *   A deep, deliberate, faintly metallic voice with controlled bass
 *   resonance. Calm authority rather than menace. Short pauses before
 *   conclusions. Never cheerful without reason, never raised.
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
  /** 0 is the floor the spec allows, and where this sits by default. */
  pitch: number;
  /** Below about 0.7, diction smears on most installed voices. */
  rate: number;
  /** Milliseconds of silence inserted before a concluding sentence. */
  beatMs: number;
}

export const PROFILE = {
  name: "Morpheus",
  register: "Very deep baritone",
  cadence: "Slow, deliberate, concise",
  texture: "Subtle metallic resonance",
  emotion: "Calm authority rather than aggression",
  delivery: "Short pauses before important conclusions",
  never: ["shouts", "sounds cheerful without reason", "hurries a consequential sentence"],
} as const;

const BASE: Delivery = {
  pitch: Number(process.env.NEXT_PUBLIC_MORPHEUS_VOICE_PITCH ?? 0),
  rate: Number(process.env.NEXT_PUBLIC_MORPHEUS_VOICE_RATE ?? 0.78),
  beatMs: 260,
};

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
export const PREFERRED_VOICES = ["david", "mark", "daniel", "alex", "george", "rishi"];
