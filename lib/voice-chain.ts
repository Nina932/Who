/**
 * The mechanical voice chain.
 *
 * Provider speech arrives as a plain spoken buffer. What makes it *this*
 * system's voice rather than a neutral narrator is everything that happens
 * after: a sub-octave layer is built under it, it is pitched down, given chest
 * weight, has steel put into its consonants, is levelled, and is finally
 * amplitude-modulated so a low machine buzz rides beneath the words.
 *
 * The register being aimed at is the one everyone recognises from a heavy
 * machine that speaks — enormous, deliberate, metallic, unhurried. It is
 * deliberately reached by *processing*, not by asking a model to imitate a
 * named performer: the directions sent to the provider stay generic, and the
 * character comes from this graph. A specific actor's voice is that person's
 * livelihood, and cloning it would be both a rights problem and a worse
 * result — an impersonation that is slightly wrong sounds far cheaper than an
 * original voice built to the same spec.
 *
 * The numbers live apart from the Web Audio wiring because the one thing worth
 * checking — *is the processing actually applied* — could otherwise only be
 * confirmed by listening and hoping. `lib/voice-render.ts` renders exactly this
 * spec offline so it can be measured, and `scripts/probe-speech.ts` writes the
 * result to a file that can be played.
 */

import { shiftPitch, softClipCurve, toMono, type CompressorSettings } from "./voice-dsp";

export type CompressorSpec = CompressorSettings;

export interface ChainSpec {
  /**
   * Cents of downward pitch shift on the main voice. Negative by definition —
   * a positive value would raise it, which is the opposite of the intent.
   *
   * This also slows delivery, because a detuned buffer plays longer. That is
   * wanted here, and the provider's own speed setting compensates for the part
   * of it that would drag.
   */
  detuneCents: number;
  /**
   * The sub-octave layer: the single ingredient that reads as *size* rather
   * than merely as a deep voice. Pitch-shifted with duration preserved, so it
   * stays locked to the words instead of drifting out of them.
   */
  subCents: number;
  /** How much of the sub layer sits under the voice. */
  subGain: number;
  /** Removes rumble the low shelf would otherwise amplify into mud. */
  highpassHz: number;
  /** Low shelf: the chest weight. */
  bodyHz: number;
  bodyGainDb: number;
  /**
   * Peaking bell in the consonant range: the steel, and the reason a voice
   * this low stays intelligible. Depth without it sounds like a slowed-down
   * recording.
   */
  presenceHz: number;
  presenceQ: number;
  presenceGainDb: number;
  compressor: CompressorSpec;
  /** Unmodulated share of the signal. Kept dominant so words stay words. */
  dryGain: number;
  /** Amplitude modulation rate. Low enough to read as a machine, not a pitch. */
  modulatorHz: number;
  /** Modulation swing around the dry level. */
  modulationDepth: number;
  /**
   * Makeup gain, applied last.
   *
   * `DynamicsCompressorNode` has no makeup stage, so the chain arrives at the
   * speakers well below what the provider sent — a voice that is *processed*
   * but sounds weak, which is easy to mistake for processing that never ran.
   * Because compression is level-dependent it is self-limiting: louder input is
   * reduced harder before this multiplies it, so the headroom holds.
   */
  outputGain: number;
  /**
   * Level above which the output saturates rather than clipping. Below this
   * the signal is untouched, and full scale can never be exceeded.
   */
  softClipThreshold: number;
}

/**
 * Headroom the saturation curve is built to cover.
 *
 * The makeup stage can push a loud syllable to roughly twice full scale before
 * the ceiling acts, and the curve has to be defined that far out or those
 * samples flat-top instead of bending.
 */
const SATURATION_DOMAIN = 2;

/**
 * A heavy machine that speaks.
 *
 * Two numbers carry most of the character. `subGain` is what makes it large:
 * past roughly half the main voice it stops sounding like one speaker and
 * starts sounding like two people talking in unison. `modulationDepth` is what
 * makes it mechanical: past about a quarter of the dry gain it stops being a
 * machine and becomes a broken speaker.
 */
export const MECHANICAL: ChainSpec = {
  detuneCents: -200,
  subCents: -1200,
  subGain: 0.34,
  // Low enough to leave the sub layer's fundamental intact.
  highpassHz: 35,
  bodyHz: 155,
  bodyGainDb: 7,
  presenceHz: 1_850,
  presenceQ: 1.1,
  presenceGainDb: 3.2,
  compressor: {
    thresholdDb: -22,
    kneeDb: 9,
    ratio: 3.4,
    attackSeconds: 0.006,
    releaseSeconds: 0.22,
  },
  dryGain: 0.86,
  modulatorHz: 46,
  modulationDepth: 0.2,
  outputGain: 2.4,
  softClipThreshold: 0.7,
};

export interface MechanicalVoice {
  /** Exposed so a caller can hold it for an explicit interrupt. */
  source: AudioBufferSourceNode;
  /** Begin modulation and playback together. */
  start(): void;
  /** Stop playback and modulation. Safe to call more than once. */
  stop(): void;
}

/**
 * Build the sub-octave layer as a buffer of the *same length* as the original.
 *
 * Length matters more than it looks. Both layers are played through source
 * nodes carrying the same detune, so identical lengths mean identical
 * playback duration and the two stay locked together for the whole utterance.
 * A layer made by simply detuning a second playback further would run slower
 * and be a syllable adrift by the end of a sentence.
 */
function buildSubLayer(context: BaseAudioContext, buffer: AudioBuffer, cents: number): AudioBuffer {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) =>
    buffer.getChannelData(index),
  );
  const shifted = shiftPitch(toMono(channels), cents, buffer.sampleRate);
  const layer = context.createBuffer(1, buffer.length, buffer.sampleRate);
  layer.getChannelData(0).set(shifted.subarray(0, buffer.length));
  return layer;
}

/**
 * Wire one buffer through the chain and into `destination`.
 *
 * The modulator drives a *gain* node rather than the signal directly: summing
 * a strong dry path with a swinging one is amplitude modulation with a floor,
 * so the voice never drops to silence at the bottom of the cycle the way a
 * bare ring modulator would.
 */
export function buildMechanicalVoice(
  context: BaseAudioContext,
  buffer: AudioBuffer,
  destination: AudioNode,
  spec: ChainSpec = MECHANICAL,
): MechanicalVoice {
  const source = context.createBufferSource();
  const sub = context.createBufferSource();
  const subLevel = context.createGain();
  const highpass = context.createBiquadFilter();
  const body = context.createBiquadFilter();
  const presence = context.createBiquadFilter();
  const compressor = context.createDynamicsCompressor();
  const dry = context.createGain();
  const machine = context.createGain();
  const modulator = context.createOscillator();
  const modulationDepth = context.createGain();
  const output = context.createGain();
  const trim = context.createGain();
  const ceiling = context.createWaveShaper();

  source.buffer = buffer;
  source.detune.value = spec.detuneCents;
  sub.buffer = buildSubLayer(context, buffer, spec.subCents);
  sub.detune.value = spec.detuneCents;
  subLevel.gain.value = spec.subGain;

  highpass.type = "highpass";
  highpass.frequency.value = spec.highpassHz;
  body.type = "lowshelf";
  body.frequency.value = spec.bodyHz;
  body.gain.value = spec.bodyGainDb;
  presence.type = "peaking";
  presence.frequency.value = spec.presenceHz;
  presence.Q.value = spec.presenceQ;
  presence.gain.value = spec.presenceGainDb;

  compressor.threshold.value = spec.compressor.thresholdDb;
  compressor.knee.value = spec.compressor.kneeDb;
  compressor.ratio.value = spec.compressor.ratio;
  compressor.attack.value = spec.compressor.attackSeconds;
  compressor.release.value = spec.compressor.releaseSeconds;

  dry.gain.value = spec.dryGain;
  // Starts at zero and is *offset* by the modulator, so the summed gain swings
  // around the dry level rather than on top of it.
  machine.gain.value = 0;
  modulator.type = "sine";
  modulator.frequency.value = spec.modulatorHz;
  modulationDepth.gain.value = spec.modulationDepth;
  modulator.connect(modulationDepth).connect(machine.gain);
  output.gain.value = spec.outputGain;
  // Scaled into the curve's domain, then shaped. The curve already returns a
  // signal bounded by full scale, so nothing is scaled back afterwards.
  trim.gain.value = 1 / SATURATION_DOMAIN;
  ceiling.curve = softClipCurve(spec.softClipThreshold, SATURATION_DOMAIN);
  ceiling.oversample = "4x";

  // Both layers meet before the filters, so the shelf and the compressor treat
  // them as one voice rather than gluing two separately-shaped signals.
  source.connect(highpass);
  sub.connect(subLevel).connect(highpass);
  highpass.connect(body).connect(presence).connect(compressor);
  compressor.connect(dry).connect(output);
  compressor.connect(machine).connect(output);
  output.connect(trim).connect(ceiling).connect(destination);

  let stopped = false;
  return {
    source,
    start() {
      modulator.start();
      // Started at the same timestamp rather than back to back, so the layers
      // cannot begin a scheduling quantum apart.
      const at = context.currentTime;
      source.start(at);
      sub.start(at);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      for (const node of [modulator, sub]) {
        try {
          node.stop();
        } catch {
          /* already stopped */
        }
      }
    },
  };
}
