/**
 * The mechanical chain, rendered offline.
 *
 * `lib/voice-chain.ts` describes the processing and builds it out of Web Audio
 * nodes, which only exist in a browser. That left the important question —
 * *does this actually change the voice, and by how much* — answerable only by
 * listening. This is the same spec driven through the primitives in
 * `lib/voice-dsp.ts`, so the chain can be run in a test, measured, and written
 * to a file the operator can play without opening the cockpit.
 *
 * It approximates rather than reproduces the browser. The filters are exact —
 * the same designs `BiquadFilterNode` uses — while the compressor is a
 * conventional soft-knee follower rather than Chromium's specific detector,
 * and resampling is linear rather than the browser's higher-order kernel. That
 * is the right trade: these measurements exist to prove the processing is
 * present and of the intended character, not to certify identical output.
 */

import { MECHANICAL, type ChainSpec } from "./voice-chain";
import {
  applyBiquad,
  bandEnergy,
  centsToRatio,
  compress,
  highpassCoefficients,
  lowShelfCoefficients,
  modulationIndex,
  peak,
  peakingCoefficients,
  resample,
  rms,
  shiftPitch,
  softClip,
} from "./voice-dsp";

/**
 * Run one mono channel through the whole mechanical chain.
 *
 * Order matches the Web Audio graph exactly: the sub layer is built and mixed
 * in, the pair is detuned together, then highpass, low shelf, presence bell,
 * compressor, the summed dry and modulated paths, and makeup gain.
 */
export function renderMechanical(
  input: Float32Array,
  sampleRate: number,
  spec: ChainSpec = MECHANICAL,
): Float32Array {
  const sub = shiftPitch(input, spec.subCents, sampleRate);
  const layered = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    layered[i] = input[i] + (sub[i] ?? 0) * spec.subGain;
  }

  const detuned = resample(layered, centsToRatio(spec.detuneCents));
  let signal = applyBiquad(detuned, highpassCoefficients(spec.highpassHz, sampleRate));
  signal = applyBiquad(signal, lowShelfCoefficients(spec.bodyHz, spec.bodyGainDb, sampleRate));
  signal = applyBiquad(
    signal,
    peakingCoefficients(spec.presenceHz, spec.presenceGainDb, spec.presenceQ, sampleRate),
  );
  signal = compress(signal, sampleRate, spec.compressor);

  const output = new Float32Array(signal.length);
  const step = (2 * Math.PI * spec.modulatorHz) / sampleRate;
  for (let i = 0; i < signal.length; i += 1) {
    // Dry gain plus the oscillator's swing — the summed gain of the two paths,
    // then makeup for what the compressor took, then the soft ceiling.
    const summed =
      signal[i] * (spec.dryGain + spec.modulationDepth * Math.sin(step * i)) * spec.outputGain;
    output[i] = softClip(summed, spec.softClipThreshold);
  }
  return output;
}

export interface VoiceMeasurement {
  seconds: number;
  rms: number;
  peak: number;
  /** Low-band energy over high-band energy. Rises as the voice gains weight. */
  lowToHighRatio: number;
  /** Envelope swing at the chain's modulation rate. */
  modulationIndex: number;
}

export function measure(
  samples: Float32Array,
  sampleRate: number,
  spec: ChainSpec = MECHANICAL,
): VoiceMeasurement {
  const low = bandEnergy(samples, 80, 320, sampleRate);
  const high = bandEnergy(samples, 2_400, 6_000, sampleRate);
  return {
    seconds: samples.length / sampleRate,
    rms: rms(samples),
    peak: peak(samples),
    lowToHighRatio: high > 1e-12 ? low / high : Infinity,
    modulationIndex: modulationIndex(samples, spec.modulatorHz, sampleRate),
  };
}

export { centsToRatio, resample, rms, shiftPitch, modulationIndex, toMono } from "./voice-dsp";
