/**
 * Signal-processing primitives.
 *
 * Deliberately knows nothing about the voice profile. The chain spec and the
 * offline renderer both need these, and if either owned them the other would
 * have to import a module that imports it back. Everything here is a pure
 * function over sample arrays, which is also what makes the chain testable at
 * all — `AudioContext` does not exist outside a browser.
 *
 * The filter designs are the RBJ cookbook forms that `BiquadFilterNode`
 * implements, so an offline render of a filter matches what the browser does
 * with the same parameters.
 */

// ── Filters ──────────────────────────────────────────────────────────────

export interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

const normalise = (
  b0: number,
  b1: number,
  b2: number,
  a0: number,
  a1: number,
  a2: number,
): Biquad => ({ b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 });

/** `BiquadFilterNode` defaults to Q = 1 for highpass, which is what this uses. */
export function highpassCoefficients(frequency: number, sampleRate: number, q = 1): Biquad {
  const w0 = (2 * Math.PI * frequency) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  return normalise((1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha);
}

export function lowpassCoefficients(frequency: number, sampleRate: number, q = 1): Biquad {
  const w0 = (2 * Math.PI * Math.min(frequency, sampleRate / 2 - 1)) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  return normalise((1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + alpha, -2 * cos, 1 - alpha);
}

export function lowShelfCoefficients(
  frequency: number,
  gainDb: number,
  sampleRate: number,
): Biquad {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * frequency) / sampleRate;
  const cos = Math.cos(w0);
  // Shelf slope S = 1, the Web Audio default, reduces alpha to this form.
  const alpha = (Math.sin(w0) / 2) * Math.SQRT2;
  const edge = 2 * Math.sqrt(A) * alpha;
  return normalise(
    A * (A + 1 - (A - 1) * cos + edge),
    2 * A * (A - 1 - (A + 1) * cos),
    A * (A + 1 - (A - 1) * cos - edge),
    A + 1 + (A - 1) * cos + edge,
    -2 * (A - 1 + (A + 1) * cos),
    A + 1 + (A - 1) * cos - edge,
  );
}

export function peakingCoefficients(
  frequency: number,
  gainDb: number,
  q: number,
  sampleRate: number,
): Biquad {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * frequency) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  return normalise(1 + alpha * A, -2 * cos, 1 - alpha * A, 1 + alpha / A, -2 * cos, 1 - alpha / A);
}

/** Direct form I, matching the difference equation Web Audio specifies. */
export function applyBiquad(input: Float32Array, coefficients: Biquad): Float32Array {
  const output = new Float32Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < input.length; i += 1) {
    const x0 = input[i];
    const y0 =
      coefficients.b0 * x0 +
      coefficients.b1 * x1 +
      coefficients.b2 * x2 -
      coefficients.a1 * y1 -
      coefficients.a2 * y2;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    output[i] = y0;
  }
  return output;
}

// ── Pitch and time ───────────────────────────────────────────────────────

export const centsToRatio = (cents: number): number => Math.pow(2, cents / 1200);

/**
 * Resample by `ratio`, the way `AudioBufferSourceNode.detune` behaves: the
 * buffer is read faster or slower, so pitch and duration move together. A
 * downward shift therefore returns a *longer* array.
 */
export function resample(input: Float32Array, ratio: number): Float32Array {
  if (ratio <= 0) throw new Error("Resample ratio must be positive.");
  const frames = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    const position = i * ratio;
    const index = Math.floor(position);
    const fraction = position - index;
    const a = input[index] ?? 0;
    const b = input[index + 1] ?? a;
    output[i] = a + (b - a) * fraction;
  }
  return output;
}

/** Window length for overlap-add. Holds two periods of a very low voice. */
const WINDOW = 2048;
/**
 * How far a frame may slide to find alignment: one period of a ~55Hz
 * fundamental at 48kHz, which is the lowest thing the sub-octave layer
 * produces.
 */
const SEARCH = 880;
/**
 * Correlation is computed on a subset of samples. Alignment is decided by the
 * strong low-frequency periodicity, which survives decimation easily, and a
 * full-rate search costs many times more for the same answer.
 *
 * The search runs coarse then fine. Scoring every offset at full detail is
 * around 180ms for an eight-second utterance — enough of a main-thread stall
 * to visibly freeze the cockpit's render loop at the exact moment speech
 * begins. Scanning in strides of `COARSE_STEP` and then refining around the
 * winner reaches the same sample-accurate offset for a fraction of the work.
 */
const COARSE_STRIDE = 32;
const COARSE_STEP = 8;
const FINE_STRIDE = 8;

/**
 * Find where in `input` the next frame best continues `reference`.
 *
 * This is the whole difference between a working octave-down layer and a
 * silent one. Overlap-add at a fixed hop lands successive frames at arbitrary
 * points in the waveform's cycle, so the overlapping halves fight each other
 * and cancel precisely the periodic component being preserved — measured on a
 * 120Hz test signal, the fixed-hop version left *less* energy at the
 * sub-octave than not layering at all. Sliding each frame to the offset whose
 * waveform best matches the previous frame's natural continuation keeps the
 * cycles in step, and the fundamental survives.
 */
function bestOffset(input: Float32Array, nominal: number, reference: Float32Array): number {
  const from = Math.max(0, nominal - SEARCH);
  const to = Math.min(input.length - reference.length, nominal + SEARCH);
  if (to <= from) return Math.max(0, Math.min(nominal, Math.max(0, input.length - reference.length)));

  const scan = (start: number, end: number, step: number, stride: number): number => {
    let best = start;
    let bestScore = -Infinity;
    for (let offset = start; offset <= end; offset += step) {
      let dot = 0;
      let energy = 0;
      for (let i = 0; i < reference.length; i += stride) {
        const sample = input[offset + i];
        dot += sample * reference[i];
        energy += sample * sample;
      }
      // Normalised, so a loud passage does not win purely by being loud.
      const score = dot / Math.sqrt(energy + 1e-9);
      if (score > bestScore) {
        bestScore = score;
        best = offset;
      }
    }
    return best;
  };

  const coarse = scan(from, to, COARSE_STEP, COARSE_STRIDE);
  return scan(
    Math.max(from, coarse - COARSE_STEP),
    Math.min(to, coarse + COARSE_STEP),
    1,
    FINE_STRIDE,
  );
}

/**
 * Stretch or compress duration without moving pitch, by waveform-similarity
 * overlap-add.
 *
 * Hann windows at fifty percent overlap sum to unity, so the running window
 * sum is divided out rather than assumed — that is what keeps the edges of the
 * utterance from fading, and costs one array.
 */
export function timeScale(input: Float32Array, targetLength: number): Float32Array {
  if (targetLength <= 0) throw new Error("Target length must be positive.");
  if (input.length === 0) return new Float32Array(targetLength);

  const output = new Float32Array(targetLength);
  const weight = new Float32Array(targetLength);
  const synthesisHop = WINDOW / 2;
  const analysisHop = synthesisHop * (input.length / targetLength);
  let reference: Float32Array | null = null;

  for (let frame = 0; frame * synthesisHop < targetLength; frame += 1) {
    const nominal = Math.round(frame * analysisHop);
    const readAt: number = reference ? bestOffset(input, nominal, reference) : nominal;
    const writeAt = frame * synthesisHop;

    for (let i = 0; i < WINDOW; i += 1) {
      const read = readAt + i;
      const write = writeAt + i;
      if (write >= targetLength) break;
      if (read >= input.length) continue;
      const window = 0.5 * (1 - Math.cos((2 * Math.PI * i) / WINDOW));
      output[write] += input[read] * window;
      weight[write] += window;
    }

    // What the waveform would have done next had it not been cut: the next
    // frame is chosen to match this.
    const continuation: number = readAt + synthesisHop;
    reference =
      continuation + synthesisHop <= input.length
        ? input.subarray(continuation, continuation + synthesisHop)
        : null;
  }

  for (let i = 0; i < targetLength; i += 1) {
    if (weight[i] > 1e-4) output[i] /= weight[i];
  }
  return output;
}

/**
 * Move pitch while leaving duration alone.
 *
 * Resampling changes both, so the duration is then put back. This is what
 * makes a sub-octave layer possible at all: a layer produced by detuning a
 * second playback would run at a different speed and drift out of the words
 * within a sentence.
 */
export function shiftPitch(input: Float32Array, cents: number, _sampleRate?: number): Float32Array {
  if (cents === 0) return Float32Array.from(input);
  const resampled = resample(input, centsToRatio(cents));
  return timeScale(resampled, input.length);
}

// ── Dynamics ─────────────────────────────────────────────────────────────

export interface CompressorSettings {
  thresholdDb: number;
  kneeDb: number;
  ratio: number;
  attackSeconds: number;
  releaseSeconds: number;
}

/**
 * Soft-knee compression with an attack/release follower in the gain domain.
 *
 * Smoothing is applied to the *reduction*, not the level: smoothing the level
 * first and then computing reduction lets a transient through at full height
 * before the follower catches up, which is audibly a different effect.
 */
export function compress(
  input: Float32Array,
  sampleRate: number,
  settings: CompressorSettings,
): Float32Array {
  const output = new Float32Array(input.length);
  const attack = Math.exp(-1 / Math.max(1, settings.attackSeconds * sampleRate));
  const release = Math.exp(-1 / Math.max(1, settings.releaseSeconds * sampleRate));
  const slope = 1 / settings.ratio - 1;
  const halfKnee = settings.kneeDb / 2;
  let reduction = 0;

  for (let i = 0; i < input.length; i += 1) {
    const levelDb = 20 * Math.log10(Math.abs(input[i]) + 1e-9);
    const over = levelDb - settings.thresholdDb;

    let target: number;
    if (over <= -halfKnee) target = 0;
    else if (over >= halfKnee) target = slope * over;
    else {
      const knee = over + halfKnee;
      target = (slope * knee * knee) / (2 * settings.kneeDb);
    }

    // More reduction is a louder signal arriving: that is the attack edge.
    reduction = target + (reduction - target) * (target < reduction ? attack : release);
    output[i] = input[i] * Math.pow(10, reduction / 20);
  }

  return output;
}

// ── Saturation ───────────────────────────────────────────────────────────

/**
 * A soft ceiling: transparent below `threshold`, asymptotic to full scale
 * above it.
 *
 * Makeup gain is set for the level a voice spends most of its time at, so
 * loud syllables can still overshoot — measured on real speech, a buffer
 * peaking at 0.8 came out of the chain above 1.0 and would have clipped into
 * a hard digital edge on every stressed word. Bounding it here means the
 * output *cannot* exceed full scale by construction rather than by luck of
 * the input level, and the curve's gentle harmonic distortion is the right
 * kind of dirt for a voice that is meant to sound like machinery anyway.
 */
export function softClip(sample: number, threshold: number): number {
  const magnitude = Math.abs(sample);
  if (magnitude <= threshold) return sample;
  const headroom = 1 - threshold;
  const excess = (magnitude - threshold) / headroom;
  return Math.sign(sample) * (threshold + headroom * Math.tanh(excess));
}

export function softClipAll(input: Float32Array, threshold: number): Float32Array {
  const output = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += 1) output[i] = softClip(input[i], threshold);
  return output;
}

/**
 * The same curve as a `WaveShaperNode` table.
 *
 * The node maps its input range [-1, 1] onto the curve and clamps anything
 * outside, so the curve is built over a wider `domain` and the signal is
 * scaled down by the same factor first. Without that, every sample the makeup
 * gain pushed past 1.0 would land on the final table entry and flat-top —
 * reintroducing exactly the hard clipping this exists to prevent.
 */
export function softClipCurve(
  threshold: number,
  domain: number,
  // Odd, so the table has an exact centre point and silence maps to silence
  // rather than to a fractional offset.
  points = 2_049,
  // `WaveShaperNode.curve` requires a plainly-backed buffer, which is what the
  // constructor below produces; the default `Float32Array` type is wider.
): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(points);
  for (let i = 0; i < points; i += 1) {
    curve[i] = softClip(domain * ((2 * i) / (points - 1) - 1), threshold);
  }
  return curve;
}

// ── Measurement ──────────────────────────────────────────────────────────

export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

export function peak(samples: Float32Array): number {
  let highest = 0;
  for (let i = 0; i < samples.length; i += 1) highest = Math.max(highest, Math.abs(samples[i]));
  return highest;
}

/**
 * Energy at one frequency, by the Goertzel algorithm — a single-bin DFT, which
 * is all any question here needs and a fraction of the cost of a transform.
 */
export function goertzel(samples: Float32Array, frequency: number, sampleRate: number): number {
  const coefficient = 2 * Math.cos((2 * Math.PI * frequency) / sampleRate);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const s0 = samples[i] + coefficient * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const magnitude = Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coefficient * s1 * s2));
  return samples.length > 0 ? (2 * magnitude) / samples.length : 0;
}

/**
 * Mean power inside a band, by filtering rather than probing.
 *
 * Sampling a handful of discrete frequencies looks equivalent and is not: a
 * voice is a line spectrum, so whether a probe lands on a harmonic or between
 * two of them changes the answer by orders of magnitude — and the chain
 * *moves* every harmonic when it detunes, so one probe set measures different
 * things before and after. Band-passing integrates whatever is in the band,
 * wherever it sits.
 */
export function bandEnergy(
  samples: Float32Array,
  fromHz: number,
  toHz: number,
  sampleRate: number,
): number {
  const highpass = highpassCoefficients(fromHz, sampleRate, Math.SQRT1_2);
  const lowpass = lowpassCoefficients(toHz, sampleRate, Math.SQRT1_2);
  let signal = applyBiquad(samples, highpass);
  signal = applyBiquad(signal, highpass);
  signal = applyBiquad(signal, lowpass);
  signal = applyBiquad(signal, lowpass);

  let sum = 0;
  for (let i = 0; i < signal.length; i += 1) sum += signal[i] * signal[i];
  return signal.length > 0 ? sum / signal.length : 0;
}

/**
 * How strongly the amplitude envelope swings at `frequency`.
 *
 * This answers the question the ear cannot settle on its own — whether the
 * machine modulation is present in the *output*, rather than configured on a
 * node that was never reached. Normalised by the mean envelope, so it does not
 * move with volume.
 */
export function modulationIndex(
  samples: Float32Array,
  frequency: number,
  sampleRate: number,
): number {
  if (samples.length === 0) return 0;
  // Well above the modulation rate, well below speech: passes the swing, not
  // the waveform carrying it.
  const cutoff = Math.min(400, sampleRate / 8);
  const coefficient = Math.exp((-2 * Math.PI * cutoff) / sampleRate);
  const envelope = new Float32Array(samples.length);
  let state = 0;
  for (let i = 0; i < samples.length; i += 1) {
    state = Math.abs(samples[i]) * (1 - coefficient) + state * coefficient;
    envelope[i] = state;
  }

  let mean = 0;
  for (let i = 0; i < envelope.length; i += 1) mean += envelope[i];
  mean /= envelope.length;
  if (mean < 1e-7) return 0;

  for (let i = 0; i < envelope.length; i += 1) envelope[i] -= mean;
  return goertzel(envelope, frequency, sampleRate) / mean;
}

/** Average the channels to mono. The chain is applied per-signal, not per-ear. */
export function toMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0];
  const frames = channels[0].length;
  const mono = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (const channel of channels) sum += channel[frame] ?? 0;
    mono[frame] = sum / channels.length;
  }
  return mono;
}
