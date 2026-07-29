import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { MECHANICAL } from "../lib/voice-chain";
import { goertzel, shiftPitch, softClip, softClipCurve, timeScale } from "../lib/voice-dsp";
import {
  centsToRatio,
  measure,
  modulationIndex,
  renderMechanical,
  resample,
  rms,
} from "../lib/voice-render";
import { decodeWav, encodeWav } from "../lib/wav";

const FUNDAMENTAL = 120;

const SAMPLE_RATE = 48_000;

/**
 * Something speech-shaped: a low fundamental with harmonics reaching into the
 * consonant range, amplitude-shaped into syllables. A pure tone would sail
 * through filters that a voice is audibly changed by, and would make the
 * compressor untestable — it never changes level.
 */
function syntheticSpeech(seconds = 1.5): Float32Array {
  const samples = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  const fundamental = FUNDAMENTAL;
  // A full harmonic series rather than a handful of tones: the chain shifts
  // every partial, and a sparse spectrum leaves gaps where a band measurement
  // reads whatever happens to have moved into them.
  const partials = Math.floor(7_000 / fundamental);
  for (let i = 0; i < samples.length; i += 1) {
    const t = i / SAMPLE_RATE;
    let harmonics = 0;
    for (let n = 1; n <= partials; n += 1) {
      harmonics += Math.sin(2 * Math.PI * fundamental * n * t) / n;
    }
    // Syllables at roughly 4Hz, with real silence between them, so the
    // compressor has something to act on.
    const syllable = Math.max(0, Math.sin(2 * Math.PI * 4 * t));
    samples[i] = 0.3 * harmonics * syllable;
  }
  return samples;
}

describe("the mechanical voice chain", () => {
  it("only ever moves the pitch downward", () => {
    assert.ok(
      MECHANICAL.detuneCents < 0,
      "a positive detune would raise the voice, not deepen it",
    );
    assert.ok(centsToRatio(MECHANICAL.detuneCents) < 1);
  });

  it("adds chest weight and keeps the consonants present", () => {
    assert.ok(MECHANICAL.bodyGainDb > 0);
    assert.ok(MECHANICAL.bodyHz < 250, "the shelf must sit under the voice, not in it");
    assert.ok(MECHANICAL.presenceGainDb > 0);
    assert.ok(MECHANICAL.presenceHz > 1_000, "steel belongs in the consonant range");
    assert.ok(
      MECHANICAL.highpassHz < MECHANICAL.bodyHz,
      "rumble must be removed below the shelf that would amplify it",
    );
  });

  it("puts a layer below the voice rather than above it", () => {
    assert.ok(MECHANICAL.subCents < 0, "a layer above the voice is not a sub");
    assert.ok(MECHANICAL.subGain > 0, "no sub gain is no size at all");
    assert.ok(
      MECHANICAL.subGain < 0.5,
      "past half the main voice it reads as two speakers, not one large one",
    );
    // A low male fundamental sits near 110Hz; the sub layer puts it an octave
    // under that, and a highpass above the result quietly deletes the layer.
    const subFundamental = 110 * centsToRatio(MECHANICAL.subCents + MECHANICAL.detuneCents);
    assert.ok(
      MECHANICAL.highpassHz < subFundamental,
      `highpass at ${MECHANICAL.highpassHz}Hz would remove a ${subFundamental.toFixed(0)}Hz sub`,
    );
  });

  it("keeps the modulation a texture rather than a novelty", () => {
    assert.ok(MECHANICAL.modulationDepth > 0, "no depth is no machine at all");
    assert.ok(
      MECHANICAL.dryGain > MECHANICAL.modulationDepth * 3,
      "a swing this close to the dry level stops sounding like a voice",
    );
    assert.ok(
      MECHANICAL.modulatorHz > 20 && MECHANICAL.modulatorHz < 90,
      "below 20Hz it is a wobble, above 90Hz it is a pitch",
    );
  });

  it("levels the signal instead of flattening it", () => {
    assert.ok(MECHANICAL.compressor.ratio > 1);
    assert.ok(MECHANICAL.compressor.ratio < 10, "beyond this it is limiting, not levelling");
    assert.ok(MECHANICAL.compressor.attackSeconds < 0.05, "a slow attack lets every plosive through");
  });

  it("is the chain the cockpit actually builds", async () => {
    const source = await readFile(new URL("../lib/useVoice.ts", import.meta.url), "utf8");
    assert.match(source, /buildMechanicalVoice\(/);
    // The inline graph is what made this untestable in the first place.
    assert.doesNotMatch(source, /createDynamicsCompressor\(/);
    assert.doesNotMatch(source, /createBiquadFilter\(/);
  });
});

describe("rendering the chain", () => {
  const speech = syntheticSpeech();
  const processed = renderMechanical(speech, SAMPLE_RATE);

  it("lowers the pitch, which lengthens the audio", () => {
    const expected = speech.length / centsToRatio(MECHANICAL.detuneCents);
    assert.ok(processed.length > speech.length, "a downward shift must take longer to play");
    assert.ok(Math.abs(processed.length - expected) <= 2);
  });

  it("shifts energy toward the low end", () => {
    const before = measure(speech, SAMPLE_RATE);
    const after = measure(processed, SAMPLE_RATE);
    assert.ok(
      after.lowToHighRatio > before.lowToHighRatio,
      `expected more low-end weight, got ${after.lowToHighRatio} from ${before.lowToHighRatio}`,
    );
  });

  it("puts a measurable machine modulation into the output", () => {
    const before = modulationIndex(speech, MECHANICAL.modulatorHz, SAMPLE_RATE);
    const after = modulationIndex(processed, MECHANICAL.modulatorHz, SAMPLE_RATE);
    assert.ok(after > before * 2, `modulation did not appear: ${before} to ${after}`);
    assert.ok(after > 0.02, `modulation is present but inaudible: ${after}`);
  });

  it("does not silence or clip the voice", () => {
    const after = measure(processed, SAMPLE_RATE);
    assert.ok(after.rms > 0.01, "the chain must not swallow the signal");
    assert.ok(after.peak <= 1.001, "the chain must not drive the output into clipping");
  });

  it("comes out at a comparable level rather than 14dB down", () => {
    const before = measure(speech, SAMPLE_RATE);
    const after = measure(processed, SAMPLE_RATE);
    // A chain that processes correctly but arrives inaudibly quiet reads as a
    // chain that never ran. Half the original level is the floor.
    assert.ok(
      after.rms > before.rms * 0.5,
      `output is too quiet to judge: ${after.rms} against ${before.rms}`,
    );
  });

  it("keeps headroom at every level the provider might send", () => {
    // Groq's output can approach full scale, and makeup gain must not turn
    // that into clipping. This is swept rather than spot-checked because a
    // single level is exactly how the problem was missed: a smooth synthetic
    // tone passed at 0.99 while real speech, which has a far higher crest
    // factor, came out above full scale from an input peaking at only 0.8.
    for (const target of [0.3, 0.6, 0.8, 0.95, 0.99]) {
      const hot = syntheticSpeech();
      const loudest = Math.max(...Array.from(hot, Math.abs));
      for (let i = 0; i < hot.length; i += 1) hot[i] = (hot[i] / loudest) * target;

      const rendered = measure(renderMechanical(hot, SAMPLE_RATE), SAMPLE_RATE);
      assert.ok(rendered.peak <= 1, `input peaking at ${target} clipped at ${rendered.peak}`);
    }
  });

  it("bounds the output by construction, not by luck of the input", () => {
    // A deliberately absurd input: the ceiling is asymptotic, so no level of
    // overdrive can push the result past full scale.
    const absurd = syntheticSpeech(0.4);
    for (let i = 0; i < absurd.length; i += 1) absurd[i] *= 40;
    assert.ok(measure(renderMechanical(absurd, SAMPLE_RATE), SAMPLE_RATE).peak <= 1);
  });

  it("leaves ordinary levels untouched by the ceiling", () => {
    // Saturation that reaches down into normal speech is distortion, not
    // protection.
    assert.ok(MECHANICAL.softClipThreshold >= 0.6);
    assert.ok(MECHANICAL.softClipThreshold < 1);
    assert.equal(softClip(0.5, MECHANICAL.softClipThreshold), 0.5);
    assert.equal(softClip(-0.5, MECHANICAL.softClipThreshold), -0.5);
    // Asymptotic to full scale, and in floating point it arrives there.
    assert.ok(Math.abs(softClip(12, MECHANICAL.softClipThreshold)) <= 1);
    assert.ok(Math.abs(softClip(-12, MECHANICAL.softClipThreshold)) <= 1);
  });

  it("leaves silence silent", () => {
    const rendered = renderMechanical(new Float32Array(SAMPLE_RATE), SAMPLE_RATE);
    assert.ok(rms(rendered) < 1e-6);
  });
});

describe("the sub-octave layer", () => {
  const speech = syntheticSpeech();

  it("moves the pitch without changing the duration", () => {
    const shifted = shiftPitch(speech, -1200, SAMPLE_RATE);
    assert.equal(shifted.length, speech.length, "a layer of a different length would drift");

    const octaveDown = goertzel(shifted, FUNDAMENTAL / 2, SAMPLE_RATE);
    const original = goertzel(speech, FUNDAMENTAL / 2, SAMPLE_RATE);
    assert.ok(
      octaveDown > original * 5,
      `no energy appeared an octave down: ${original} to ${octaveDown}`,
    );
  });

  it("survives overlap-add instead of being cancelled by it", () => {
    // The failure this guards against is specific and silent: overlap-add at a
    // fixed hop lands frames at arbitrary points in the cycle, and the
    // overlapping halves cancel the very periodicity being preserved. The
    // shifted layer must hold a real share of the original's level.
    const shifted = shiftPitch(speech, -1200, SAMPLE_RATE);
    assert.ok(
      rms(shifted) > rms(speech) * 0.4,
      `the shifted layer collapsed: ${rms(shifted)} against ${rms(speech)}`,
    );
  });

  it("reaches the output rather than being filtered away", () => {
    const withSub = renderMechanical(speech, SAMPLE_RATE);
    const withoutSub = renderMechanical(speech, SAMPLE_RATE, { ...MECHANICAL, subGain: 0 });
    const subFundamental = (FUNDAMENTAL / 2) * centsToRatio(MECHANICAL.detuneCents);

    const present = goertzel(withSub, subFundamental, SAMPLE_RATE);
    const absent = goertzel(withoutSub, subFundamental, SAMPLE_RATE);
    assert.ok(
      present > absent * 3,
      `the sub layer did not reach the output: ${absent} to ${present}`,
    );
  });

  it("stays cheap enough not to stall the render loop", () => {
    // This runs on the main thread the moment speech begins, next to a
    // sixty-frame-a-second scene. The full-detail search took roughly 180ms
    // for this much audio, which is a visible freeze.
    const long = syntheticSpeech(8);
    const started = performance.now();
    shiftPitch(long, MECHANICAL.subCents, SAMPLE_RATE);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 120, `building the sub layer took ${elapsed.toFixed(0)}ms`);
  });
});

describe("the saturation curve", () => {
  it("covers the full range the makeup stage can reach", () => {
    // The browser clamps anything outside the curve's domain to its endpoints,
    // so a curve built only over [-1, 1] would flat-top every sample the
    // makeup gain pushed beyond full scale — the exact hard clipping it exists
    // to avoid.
    const curve = softClipCurve(MECHANICAL.softClipThreshold, 2);
    assert.ok(curve.length > 256);
    assert.ok(curve[0] < -0.9 && curve[0] > -1);
    assert.ok(curve[curve.length - 1] > 0.9 && curve[curve.length - 1] < 1);
    assert.ok(Math.abs(curve[Math.floor(curve.length / 2)]) < 1e-6, "must pass zero through");
  });

  it("rises monotonically, so it shapes rather than folds", () => {
    const curve = softClipCurve(MECHANICAL.softClipThreshold, 2);
    for (let i = 1; i < curve.length; i += 1) {
      assert.ok(curve[i] >= curve[i - 1], `curve reverses at ${i}`);
    }
  });
});

describe("time scaling", () => {
  it("returns exactly the requested length", () => {
    const speech = syntheticSpeech(0.5);
    assert.equal(timeScale(speech, 12_000).length, 12_000);
    assert.equal(timeScale(speech, 40_000).length, 40_000);
  });

  it("refuses a length that cannot hold anything", () => {
    assert.throws(() => timeScale(new Float32Array(64), 0), /positive/);
  });
});

describe("wav round-tripping", () => {
  it("survives encode and decode without drifting", () => {
    const speech = syntheticSpeech(0.25);
    const decoded = decodeWav(encodeWav({ sampleRate: SAMPLE_RATE, channels: [speech] }));

    assert.equal(decoded.sampleRate, SAMPLE_RATE);
    assert.equal(decoded.channels.length, 1);
    assert.equal(decoded.channels[0].length, speech.length);
    for (let i = 0; i < speech.length; i += 1) {
      // One 16-bit step of tolerance, which is all quantisation may cost.
      assert.ok(Math.abs(decoded.channels[0][i] - speech[i]) < 1 / 32_000);
    }
  });

  it("finds the data chunk behind a chunk it does not know", () => {
    const speech = syntheticSpeech(0.05);
    const plain = encodeWav({ sampleRate: SAMPLE_RATE, channels: [speech] });

    // Splice a LIST chunk between `fmt ` and `data`, as real encoders do.
    const extra = new Uint8Array(12);
    extra.set([0x4c, 0x49, 0x53, 0x54]); // "LIST"
    new DataView(extra.buffer).setUint32(4, 4, true);
    const spliced = new Uint8Array(plain.length + extra.length);
    spliced.set(plain.subarray(0, 36), 0);
    spliced.set(extra, 36);
    spliced.set(plain.subarray(36), 36 + extra.length);
    new DataView(spliced.buffer).setUint32(4, spliced.length - 8, true);

    const decoded = decodeWav(spliced);
    assert.equal(decoded.channels[0].length, speech.length);
  });

  it("refuses something that is not a wave file", () => {
    assert.throws(() => decodeWav(new Uint8Array(64)), /RIFF/);
  });
});

describe("the speech probe", () => {
  it("names the terms refusal rather than reporting a generic failure", async () => {
    const provider = await readFile(
      new URL("../lib/speech-provider.ts", import.meta.url),
      "utf8",
    );
    assert.match(provider, /model_terms_required/);

    const probe = await readFile(new URL("../scripts/probe-speech.ts", import.meta.url), "utf8");
    // The probe drives the same provider chain the cockpit uses, so a pass
    // here means the cockpit works rather than that the script works.
    assert.match(probe, /synthesizeSpeech\(/);
    assert.match(probe, /GROQ_API_KEY/);
    assert.doesNotMatch(probe, /NEXT_PUBLIC_GROQ/);
  });

  it("reports a fallback to the operator instead of failing silently", async () => {
    const hook = await readFile(new URL("../lib/useVoice.ts", import.meta.url), "utf8");
    assert.match(hook, /Groq has not accepted the Orpheus model terms/);
    assert.match(hook, /engine: "browser"/);

    const status = await readFile(
      new URL("../components/VoiceStatus.tsx", import.meta.url),
      "utf8",
    );
    assert.match(status, /voicePath\.engine === "browser"/);
  });
});

describe("resampling", () => {
  it("interpolates rather than dropping samples", () => {
    const ramp = Float32Array.from({ length: 8 }, (_, i) => i);
    const stretched = resample(ramp, 0.5);
    assert.equal(stretched.length, 16);
    assert.ok(Math.abs(stretched[2] - 1) < 1e-6);
    assert.ok(Math.abs(stretched[3] - 1.5) < 1e-6);
  });

  it("rejects a ratio that would produce nothing", () => {
    assert.throws(() => resample(new Float32Array(4), 0), /positive/);
  });
});
