/**
 * What Morpheus looks like it is feeling.
 *
 * The orb already reacted to *sound* — loudness, bands, emphasis, measured
 * every frame. That answers "is it hearing me". It does not answer "what is it
 * doing", which is a different question the same surface should be able to
 * settle at a glance from across a room.
 *
 * So there are two independent channels, and keeping them independent is the
 * whole design:
 *
 *   **Mood** is the slow one. It follows the state machine, changes maybe
 *   twice a minute, and owns the palette. Deliberating is violet because
 *   thinking is not the same act as listening and should not look like it.
 *
 *   **Voice** is the fast one, in `lib/audio.ts`. It runs at frame rate, owns
 *   displacement and brightness, and shifts hue only *within* whatever the
 *   mood has set.
 *
 * Collapse them into one number and you get an orb that either ignores what
 * you said or forgets what it was doing. Emotion, here, is the slow channel
 * having its own vocabulary.
 *
 * None of this is decoration. An operator glancing over should be able to tell
 * "it is thinking" from "it is talking" from "it is waiting on me" without
 * reading a word, which is the only reason a cockpit has a mood at all.
 */

import type { VoiceState } from "./useVoice";

export type Mood = "calm" | "attentive" | "engaged" | "deliberating" | "declaring";

export interface Palette {
  /** The body of the orb. */
  base: string;
  /** Highlights, filaments, the fresnel rim. */
  hot: string;
  /** Rings, links, the floor's wave crests. */
  accent: string;
}

export interface MoodProfile {
  mood: Mood;
  /** Shown in the cockpit. Present tense, no adjectives. */
  label: string;
  palette: Palette;
  /** Baseline energy before any voice is added. 0..1 */
  energy: number;
  /** Breaths per second of the slow ambient pulse. */
  pulse: number;
  /**
   * How far the spectrum is allowed to move the hue, in degrees. Deliberating
   * is deliberately narrow: a thinking orb that flickers through colours reads
   * as broken rather than as considering something.
   */
  hueRange: number;
}

export const MOODS: Record<Mood, MoodProfile> = {
  calm: {
    mood: "calm",
    label: "Standing by",
    // Deep and unsaturated. Nothing is happening and the interface should not
    // pretend otherwise by glowing at full brightness into an empty room.
    palette: { base: "#1f7fa8", hot: "#7fd4e8", accent: "#2c6f8c" },
    energy: 0.25,
    pulse: 0.16,
    hueRange: 20,
  },
  attentive: {
    mood: "attentive",
    label: "Listening",
    // The resting cockpit cyan: awake, waiting, not yet doing anything.
    palette: { base: "#3fe0f0", hot: "#b9fbff", accent: "#3ec2ff" },
    energy: 0.55,
    pulse: 0.28,
    hueRange: 45,
  },
  engaged: {
    mood: "engaged",
    label: "Hearing you",
    // Brightest of the five. This is the only state entered from a real
    // measurement rather than from a state transition, and it should look
    // like the difference.
    palette: { base: "#5df0ff", hot: "#e6ffff", accent: "#6ad8ff" },
    energy: 0.72,
    pulse: 0.5,
    hueRange: 60,
  },
  deliberating: {
    mood: "deliberating",
    label: "Thinking",
    // Violet, and slower than listening. Work is happening that the operator
    // is not part of yet.
    palette: { base: "#7a6cf0", hot: "#c9c0ff", accent: "#8f7dff" },
    energy: 0.45,
    pulse: 0.2,
    hueRange: 15,
  },
  declaring: {
    mood: "declaring",
    label: "Speaking",
    // Warm, because it is the one state where the floor belongs to Morpheus.
    // Amber against an otherwise entirely cold interface is unmistakable.
    palette: { base: "#4fd8e8", hot: "#ffe3a8", accent: "#f2c14e" },
    energy: 1,
    pulse: 0.62,
    hueRange: 35,
  },
};

const BY_STATE: Record<VoiceState, Mood> = {
  idle: "calm",
  listening: "attentive",
  hearing: "engaged",
  thinking: "deliberating",
  speaking: "declaring",
};

export function moodFor(state: VoiceState): MoodProfile {
  return MOODS[BY_STATE[state]];
}

// ── Colour ───────────────────────────────────────────────────────────────

/** `#rrggbb` to a 0..1 triple. */
export function toRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const n = parseInt(clean, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * Where the voice hue is allowed to sit, given the mood.
 *
 * The mood sets the centre; the spectrum moves it within `hueRange` and no
 * further. This is what stops a loud consonant from turning a thinking orb
 * cyan — the palette is the mood's to own, and the voice only modulates it.
 */
export function hueWindow(profile: MoodProfile): { centre: number; range: number } {
  const [r, g, b] = toRgb(profile.palette.base);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;

  let hue = 0;
  if (d !== 0) {
    if (max === r) hue = ((g - b) / d) % 6;
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
  }
  hue = (hue * 60 + 360) % 360;

  return { centre: hue, range: profile.hueRange };
}
