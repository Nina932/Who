import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  SILENT,
  bandAverage,
  createMotion,
  decay,
  hueFor,
  hueToRgb,
  integrate,
  readingFrom,
  type VoiceLevels,
} from "../lib/audio";

/**
 * The microphone, without a microphone.
 *
 * `AnalyserNode` does not exist outside a browser, so the maths was pulled out
 * from under it. That matters more than tidiness: an orb that moves is not
 * evidence that anything is being measured correctly — it is evidence that
 * something is changing. These tests drive the same arithmetic the browser
 * drives, with signals whose answers are known in advance.
 */

const ROOT = path.resolve(import.meta.dirname, "..");

/** A sine at a given amplitude, as `getByteTimeDomainData` would report it. */
function sine(amplitude: number, samples = 1024): Uint8Array {
  const data = new Uint8Array(samples);
  for (let i = 0; i < samples; i += 1) {
    data[i] = Math.round(128 + Math.sin((i / samples) * Math.PI * 32) * 127 * amplitude);
  }
  return data;
}

function silence(samples = 1024): Uint8Array {
  return new Uint8Array(samples).fill(128);
}

/** A spectrum with all its energy in one bin range. */
function spectrum(from: number, to: number, level = 255, bins = 512): Uint8Array {
  const data = new Uint8Array(bins);
  for (let i = from; i < Math.min(to, bins); i += 1) data[i] = level;
  return data;
}

// ── Loudness ─────────────────────────────────────────────────────────────

describe("loudness comes from the waveform", () => {
  it("reads a flat 128 as silence", () => {
    assert.equal(readingFrom(silence(), silence()).volume, 0);
  });

  it("rises with amplitude", () => {
    const quiet = readingFrom(silence(), sine(0.05)).volume;
    const loud = readingFrom(silence(), sine(0.8)).volume;
    assert.ok(quiet < loud, `${quiet} should be under ${loud}`);
    assert.ok(loud > 0.5, `a loud signal read as ${loud}`);
  });

  it("matches the RMS of a sine to within rounding", () => {
    // RMS of a full-scale sine is 1/√2 ≈ 0.707; the ×4 gain then saturates it.
    // At 0.2 amplitude: 0.2 × 0.707 × 4 ≈ 0.566.
    const volume = readingFrom(silence(), sine(0.2)).volume;
    assert.ok(Math.abs(volume - 0.566) < 0.02, `expected ~0.566, got ${volume}`);
  });

  it("never exceeds one, whatever arrives", () => {
    assert.equal(readingFrom(silence(), sine(1)).volume, 1);
  });

  it("survives an empty buffer rather than returning NaN", () => {
    const reading = readingFrom(new Uint8Array(0), new Uint8Array(0));
    assert.equal(reading.volume, 0);
    assert.equal(reading.bass, 0);
  });
});

// ── Bands ────────────────────────────────────────────────────────────────

describe("the three bands separate", () => {
  it("puts low-bin energy in bass and nowhere else", () => {
    const reading = readingFrom(spectrum(0, 20), silence());
    assert.equal(reading.bass, 1);
    assert.equal(reading.mids, 0);
    assert.equal(reading.treble, 0);
  });

  it("puts mid-bin energy in mids and nowhere else", () => {
    const reading = readingFrom(spectrum(20, 90), silence());
    assert.equal(reading.bass, 0);
    assert.equal(reading.mids, 1);
    assert.equal(reading.treble, 0);
  });

  it("puts high-bin energy in treble and nowhere else", () => {
    const reading = readingFrom(spectrum(90, 220), silence());
    assert.equal(reading.bass, 0);
    assert.equal(reading.mids, 0);
    assert.equal(reading.treble, 1);
  });

  it("normalises to 0..1 rather than 0..255", () => {
    assert.equal(bandAverage(spectrum(0, 20, 128), 0, 20), 128 / 255);
  });

  it("does not read past the end of the array", () => {
    // 220 bins are requested from a 128-bin spectrum when fftSize is small.
    assert.equal(bandAverage(spectrum(90, 128, 255, 128), 90, 220), 1);
  });
});

// ── The speech floor ─────────────────────────────────────────────────────

const fresh = (): VoiceLevels => ({ ...SILENT });

/** Run n frames of a steady signal, 16 ms apart. */
function hold(levels: VoiceLevels, motion: ReturnType<typeof createMotion>, amplitude: number, frames: number, from = 1000) {
  let now = from;
  for (let i = 0; i < frames; i += 1) {
    now += 16;
    integrate(levels, readingFrom(silence(), sine(amplitude)), now, motion);
  }
  return now;
}

describe("speech is distinguished from a quiet room", () => {
  it("does not call room noise speech", () => {
    const levels = fresh();
    const motion = createMotion();
    // A laptop mic in a quiet room sits around 0.01–0.03 after the gain.
    hold(levels, motion, 0.008, 120);
    assert.equal(levels.speaking, false, `room noise read as ${levels.volume}`);
  });

  it("calls an ordinary speaking level speech", () => {
    const levels = fresh();
    const motion = createMotion();
    hold(levels, motion, 0.15, 60);
    assert.equal(levels.speaking, true, `speech read as only ${levels.volume}`);
  });

  it("reports how long it has been quiet", () => {
    const levels = fresh();
    const motion = createMotion();
    let now = hold(levels, motion, 0.3, 40);

    // Then the room goes quiet.
    for (let i = 0; i < 50; i += 1) {
      now += 16;
      integrate(levels, readingFrom(silence(), silence()), now, motion);
    }

    assert.ok(levels.quietFor >= 700, `quietFor was only ${levels.quietFor}`);
    assert.equal(levels.speaking, false);
  });

  it("keeps quietFor at zero before anyone has ever spoken", () => {
    // Otherwise the first frame reports "quiet for 1,772,000,000 ms", which is
    // the epoch, not a silence.
    const levels = fresh();
    const motion = createMotion();
    integrate(levels, readingFrom(silence(), silence()), 1_772_000_000, motion);
    assert.equal(levels.quietFor, 0);
  });

  it("holds through the gap between two words", () => {
    // Smoothing exists for this: a 32 ms pause mid-sentence must not read as
    // the operator having finished.
    const levels = fresh();
    const motion = createMotion();
    let now = hold(levels, motion, 0.3, 40);
    for (let i = 0; i < 2; i += 1) {
      now += 16;
      integrate(levels, readingFrom(silence(), silence()), now, motion);
    }
    assert.equal(levels.speaking, true, "a two-frame gap ended the utterance");
  });
});

// ── Emphasis ─────────────────────────────────────────────────────────────

describe("emphasis catches a stressed word", () => {
  it("spikes on a sharp attack", () => {
    const levels = fresh();
    const motion = createMotion();
    hold(levels, motion, 0.05, 10);
    const before = levels.emphasis;
    integrate(levels, readingFrom(silence(), sine(0.7)), 2000, motion);
    assert.ok(levels.emphasis > before + 0.3, `emphasis only reached ${levels.emphasis}`);
  });

  it("ignores a slow swell", () => {
    // A crescendo is not a stressed syllable, and must not flash the orb.
    const levels = fresh();
    const motion = createMotion();
    let now = 1000;
    for (let i = 0; i < 60; i += 1) {
      now += 16;
      integrate(levels, readingFrom(silence(), sine(i / 100)), now, motion);
    }
    assert.ok(levels.emphasis < 0.35, `a slow swell spiked to ${levels.emphasis}`);
  });

  it("decays rather than latching on", () => {
    const levels = fresh();
    const motion = createMotion();
    integrate(levels, readingFrom(silence(), sine(0.9)), 1000, motion);
    const peak = levels.emphasis;
    let now = 1000;
    for (let i = 0; i < 40; i += 1) {
      now += 16;
      integrate(levels, readingFrom(silence(), silence()), now, motion);
    }
    assert.ok(levels.emphasis < peak * 0.1, `emphasis stuck at ${levels.emphasis}`);
  });
});

// ── Muting ───────────────────────────────────────────────────────────────

describe("the muted path settles rather than snapping", () => {
  it("takes several frames to reach silence", () => {
    const levels = fresh();
    const motion = createMotion();
    hold(levels, motion, 0.5, 60);
    const loud = levels.volume;

    decay(levels);
    assert.ok(levels.volume < loud, "the level did not fall");
    assert.ok(levels.volume > loud * 0.5, "the level snapped to zero in one frame");
  });

  it("stops reporting speech immediately, however loud it was", () => {
    // This is the self-hearing guard. The *level* may ease down; the claim
    // that the operator is speaking must not survive a single frame.
    const levels = fresh();
    const motion = createMotion();
    hold(levels, motion, 0.9, 60);
    assert.equal(levels.speaking, true);
    decay(levels);
    assert.equal(levels.speaking, false);
  });

  it("converges to zero", () => {
    const levels = fresh();
    const motion = createMotion();
    hold(levels, motion, 0.9, 60);
    for (let i = 0; i < 400; i += 1) decay(levels);
    assert.ok(levels.volume < 0.001);
    assert.ok(levels.bass < 0.001);
    assert.ok(levels.emphasis < 0.001);
  });
});

// ── Colour ───────────────────────────────────────────────────────────────

describe("hue stays inside the Morpheus range", () => {
  it("is cyan at rest", () => {
    assert.equal(hueFor(SILENT), 185);
  });

  it("never leaves cyan-to-violet, whatever the spectrum does", () => {
    const loudest: VoiceLevels = {
      ...SILENT,
      volume: 1,
      bass: 1,
      mids: 1,
      treble: 1,
    };
    const hue = hueFor(loudest);
    assert.ok(hue >= 185 && hue <= 250, `hue wandered to ${hue}`);
  });

  it("converts to channels inside 0..1", () => {
    for (let hue = 0; hue < 360; hue += 7) {
      for (const channel of hueToRgb(hue)) {
        assert.ok(channel >= 0 && channel <= 1, `channel ${channel} at hue ${hue}`);
      }
    }
  });

  it("puts the resting hue in the blue-green corner", () => {
    const [r, g, b] = hueToRgb(hueFor(SILENT));
    assert.ok(g > r && b > r, `expected cyan, got ${[r, g, b].join(", ")}`);
  });
});

// ── Drift between the shader and the scene ───────────────────────────────

describe("the shader and the scene agree on their uniforms", () => {
  /**
   * A uniform declared in GLSL but never supplied reads as zero, and a uniform
   * supplied but never declared is dropped. Both fail silently: the orb keeps
   * rendering, it simply stops reacting. Nothing else in the suite would catch
   * that, so the two lists are compared directly.
   */
  it("declares every voice uniform the scene sets", async () => {
    const shaders = await fs.readFile(path.join(ROOT, "components/morpheus/shaders.ts"), "utf8");
    const scene = await fs.readFile(path.join(ROOT, "components/morpheus/CockpitScene.tsx"), "utf8");

    const declared = new Set(
      [...shaders.matchAll(/uniform\s+\w+\s+(u\w+);/g)].map((m) => m[1]),
    );
    const supplied = new Set(
      [...scene.matchAll(/\b(u[A-Z]\w*):\s*\{\s*value:/g)].map((m) => m[1]),
    );

    assert.ok(supplied.size >= 8, `only found ${[...supplied].join(", ")} in the scene`);
    for (const name of ["uVoiceVolume", "uBass", "uMids", "uTreble"]) {
      assert.ok(declared.has(name), `${name} is not declared in any shader`);
      assert.ok(supplied.has(name), `${name} is never given a value`);
    }
    for (const name of supplied) {
      assert.ok(declared.has(name), `the scene sets ${name}, which no shader declares`);
    }
  });

  it("assigns the voice uniforms every frame rather than at render", async () => {
    // Reading levels during render freezes them at whatever they were at the
    // last React update — which, for audio, is approximately always zero.
    //
    // The assignment lives in `drive()` rather than inline in each `useFrame`,
    // so this checks both halves: that `drive` does the assigning, and that
    // every caller reaches it from inside a frame callback.
    const scene = await fs.readFile(path.join(ROOT, "components/morpheus/CockpitScene.tsx"), "utf8");

    const drive = scene.slice(scene.indexOf("function drive("), scene.indexOf("function agentPosition"));
    assert.match(drive, /uVoiceVolume\.value\s*=/, "drive() does not assign the voice uniforms");

    const frames = scene.split("useFrame(").slice(1).join("");
    assert.match(frames, /drive\(/, "no frame callback calls drive()");
    assert.match(frames, /levelsRef\?\.current/, "levels are not read inside a frame callback");

    // And nowhere reads them during render, which is the actual bug this
    // guards against.
    const renderOnly = scene.split("useFrame(").filter((_, i) => i === 0).join("");
    assert.ok(
      !/levelsRef\.current\./.test(renderOnly),
      "levels are dereferenced during render, which freezes them",
    );
  });
});

// ── The state machine ────────────────────────────────────────────────────

describe("hearing is a measured state, not an inferred one", () => {
  it("exists as a distinct voice state", async () => {
    const source = await fs.readFile(path.join(ROOT, "lib/useVoice.ts"), "utf8");
    assert.match(source, /"idle" \| "listening" \| "hearing" \| "thinking" \| "speaking"/);
  });

  it("is only ever entered from listening", async () => {
    // A sound arriving while Morpheus is talking is not the operator taking a
    // turn. If `hearing` could be entered from `speaking`, the interface would
    // report Morpheus's own voice as the operator's.
    const source = await fs.readFile(path.join(ROOT, "lib/useVoice.ts"), "utf8");
    assert.match(source, /current === "listening" && levels\.speaking/);
    const enters = [...source.matchAll(/setState\("hearing"\)/g)];
    assert.equal(enters.length, 1, "hearing is entered from more than one place");
  });

  it("mutes the analyser for the whole time synthesis is playing", async () => {
    const source = await fs.readFile(path.join(ROOT, "lib/useVoice.ts"), "utf8");
    assert.match(source, /utterance\.onstart = \(\) => \{\s*setDeaf\(true\);/);
    // Unmuting mid-queue would let the tail of one sentence be measured.
    assert.match(source, /if \(pendingRef\.current === 0\) setDeaf\(false\);/);
  });
});
