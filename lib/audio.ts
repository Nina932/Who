/**
 * Real microphone analysis.
 *
 * Speech recognition tells you *what* was said, eventually. It tells you
 * nothing about the sound while it is happening — so an interface driven by
 * recognition alone is dead until a sentence finishes, then jumps. That is why
 * the orb looked inert: nothing was ever measuring the audio.
 *
 * This is a Web Audio `AnalyserNode` reading the same stream, every frame:
 * loudness, and how that loudness divides across bass, mids and treble.
 *
 * Two decisions that matter more than the maths.
 *
 * **Nothing here touches React state.** Sixty renders a second would make the
 * whole page stutter and would do nothing a shader uniform cannot do
 * directly. Values live in a ref that the render loop reads.
 *
 * **The analyser is never connected to the destination.** Routing microphone
 * input to the speakers is how you build a feedback loop and deafen somebody
 * wearing headphones.
 */

export interface VoiceLevels {
  /** 0..1 loudness, from RMS of the time-domain signal. */
  volume: number;
  /** 0..1 energy in the low band — drives slow, large deformation. */
  bass: number;
  /** 0..1 mid band — surface turbulence, and most of speech. */
  mids: number;
  /** 0..1 high band — sparkle, sibilance, fine detail. */
  treble: number;
  /** True while the level is above the speech floor. */
  speaking: boolean;
  /** Milliseconds since the level last crossed the floor. */
  quietFor: number;
  /** Rises on a sharp attack — a stressed word, a hard consonant. */
  emphasis: number;
}

export const SILENT: VoiceLevels = {
  volume: 0,
  bass: 0,
  mids: 0,
  treble: 0,
  speaking: false,
  quietFor: 0,
  emphasis: 0,
};

/**
 * Above this counts as speech.
 *
 * Deliberately not near zero: a laptop microphone in a quiet room still reads
 * around 0.01–0.03, and a threshold under that makes the orb twitch at nothing
 * and makes "hearing you" a lie.
 */
const SPEECH_FLOOR = 0.055;

/** Per-band easing. Treble is allowed to move fastest; bass is heaviest. */
const EASE = { volume: 0.15, bass: 0.1, mids: 0.12, treble: 0.18 } as const;

// ── The pure core ────────────────────────────────────────────────────────
//
// Everything below this line is arithmetic over two byte arrays, separated
// from the Web Audio graph on purpose. `AnalyserNode` cannot be constructed
// outside a browser, so anything tangled up with it is untestable — and the
// maths is exactly the part that can be silently wrong while the orb still
// moves convincingly.

/** One frame's raw measurements, before any smoothing. */
export interface Reading {
  volume: number;
  bass: number;
  mids: number;
  treble: number;
}

/** Carried between frames: what smoothing alone cannot express. */
export interface Motion {
  lastLoudAt: number;
  previousVolume: number;
}

export const createMotion = (): Motion => ({ lastLoudAt: 0, previousVolume: 0 });

export function bandAverage(data: Uint8Array, from: number, to: number): number {
  let sum = 0;
  const end = Math.min(to, data.length);
  for (let i = from; i < end; i += 1) sum += data[i];
  return end > from ? sum / (end - from) / 255 : 0;
}

/**
 * Loudness as RMS of the time-domain signal, which tracks what an ear hears
 * far better than a peak or an average of the spectrum: a single click and a
 * sustained vowel can share a peak and sound nothing alike.
 *
 * The ×4 puts ordinary speech at roughly 0.3–0.7 rather than 0.1, so the
 * shader does not need a magic multiplier of its own.
 */
export function readingFrom(frequency: Uint8Array, time: Uint8Array): Reading {
  let sum = 0;
  for (let i = 0; i < time.length; i += 1) {
    const normalised = (time[i] - 128) / 128;
    sum += normalised * normalised;
  }
  const rms = time.length > 0 ? Math.sqrt(sum / time.length) : 0;

  return {
    volume: Math.min(1, rms * 4),
    // Roughly 0–450 Hz, 450–2 kHz, 2–5 kHz at 44.1 kHz with 512 bins.
    bass: bandAverage(frequency, 0, 20),
    mids: bandAverage(frequency, 20, 90),
    treble: bandAverage(frequency, 90, 220),
  };
}

/** Fold one raw reading into the smoothed levels. Mutates both arguments. */
export function integrate(
  levels: VoiceLevels,
  reading: Reading,
  now: number,
  motion: Motion,
): void {
  // A sharp rise is a stressed word. Measured against the *raw* previous
  // volume, because smoothing is exactly what would erase it.
  const attack = Math.max(0, reading.volume - motion.previousVolume);
  motion.previousVolume = reading.volume;
  levels.emphasis = Math.max(levels.emphasis * 0.86, Math.min(1, attack * 6));

  levels.volume += (reading.volume - levels.volume) * EASE.volume;
  levels.bass += (reading.bass - levels.bass) * EASE.bass;
  levels.mids += (reading.mids - levels.mids) * EASE.mids;
  levels.treble += (reading.treble - levels.treble) * EASE.treble;

  // `speaking` is deliberately taken from the smoothed value and `quietFor`
  // from the raw one: the first should not flicker between two syllables, the
  // second should not claim silence that a decay curve invented.
  if (reading.volume > SPEECH_FLOOR) motion.lastLoudAt = now;
  levels.speaking = levels.volume > SPEECH_FLOOR;
  levels.quietFor = motion.lastLoudAt === 0 ? 0 : now - motion.lastLoudAt;
}

/**
 * The muted path: ease to silence rather than snapping, so the orb settles
 * instead of collapsing the instant Morpheus starts speaking.
 */
export function decay(levels: VoiceLevels): void {
  levels.volume += (0 - levels.volume) * EASE.volume;
  levels.bass += (0 - levels.bass) * EASE.bass;
  levels.mids += (0 - levels.mids) * EASE.mids;
  levels.treble += (0 - levels.treble) * EASE.treble;
  levels.emphasis *= 0.85;
  levels.speaking = false;
}

export interface Analyser {
  /** Live values. Read from a render loop; never put in React state. */
  levels: VoiceLevels;
  /** Advance one frame. Call from the single rAF loop that already exists. */
  sample(now: number): void;
  /** True while Morpheus is speaking — input is ignored, not just muted. */
  setMuted(muted: boolean): void;
  stop(): void;
}

/**
 * Open the microphone and start measuring.
 *
 * Returns null when the browser has no Web Audio, or permission is refused.
 * A refused microphone is a normal outcome, not an error worth throwing — the
 * cockpit falls back to the typed path and the orb keeps breathing.
 */
export async function createAnalyser(): Promise<Analyser | null> {
  if (typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia) return null;

  const AudioCtx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return null;

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // Echo cancellation is the browser's half of stopping Morpheus from
        // hearing itself. `setMuted` is ours, and both are needed.
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch {
    return null;
  }

  const context = new AudioCtx();
  // Constructed after `getUserMedia` resolves, which puts it outside the click
  // that started all this — so autoplay policy can hand back a suspended
  // context that reads as perfect silence forever. Resume explicitly.
  if (context.state === "suspended") await context.resume().catch(() => undefined);

  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();

  // 1024 is enough resolution for three bands and cheap enough to run every
  // frame on a laptop. The smoothing is the analyser's own, on top of ours.
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.75;
  source.connect(analyser);

  const frequency = new Uint8Array(analyser.frequencyBinCount);
  const time = new Uint8Array(analyser.fftSize);

  const levels: VoiceLevels = { ...SILENT };
  const motion = createMotion();
  let muted = false;

  return {
    levels,

    sample(now: number) {
      if (muted || context.state === "closed") {
        decay(levels);
        return;
      }

      analyser.getByteFrequencyData(frequency);
      analyser.getByteTimeDomainData(time);
      integrate(levels, readingFrom(frequency, time), now, motion);
    },

    setMuted(next: boolean) {
      muted = next;
    },

    stop() {
      // Tracks are stopped explicitly: leaving them live keeps the browser's
      // recording indicator on, which is both rude and alarming.
      for (const track of stream.getTracks()) track.stop();
      void context.close().catch(() => undefined);
    },
  };
}

// ── Colour ───────────────────────────────────────────────────────────────

/**
 * Hue from the spectrum, in the Morpheus range and nowhere else.
 *
 * Cyan at rest, bluer as mids rise, violet on treble. Bounded deliberately:
 * a hue that can wander anywhere stops reading as one system reacting and
 * starts reading as a colour cycler.
 */
export function hueFor(levels: VoiceLevels): number {
  return 185 + levels.mids * 25 + levels.treble * 35;
}

/** Hue and saturation to an RGB triple, for a shader uniform. */
export function hueToRgb(hue: number, saturation = 0.85, lightness = 0.55): [number, number, number] {
  const h = ((hue % 360) + 360) % 360 / 360;
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = c * (1 - Math.abs(((h * 6) % 2) - 1));
  const m = lightness - c / 2;

  const [r, g, b] =
    h < 1 / 6
      ? [c, x, 0]
      : h < 2 / 6
        ? [x, c, 0]
        : h < 3 / 6
          ? [0, c, x]
          : h < 4 / 6
            ? [0, x, c]
            : h < 5 / 6
              ? [x, 0, c]
              : [c, 0, x];

  return [r + m, g + m, b + m];
}
