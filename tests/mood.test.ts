import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { MOODS, hueWindow, moodFor, toRgb, type Mood } from "../lib/mood";

/**
 * Mood is the slow channel: it follows the state machine and owns the palette,
 * while the microphone owns motion and may only shift hue *within* the window
 * the mood allows. These tests are about that separation holding — the failure
 * mode is not an ugly colour, it is an orb that looks the same whether it is
 * thinking or waiting, which is the one thing it exists to distinguish.
 */

const ROOT = path.resolve(import.meta.dirname, "..");

const STATES = [
  "idle",
  "listening",
  "hearing",
  "thinking",
  "executing",
  "speaking",
  "completed",
  "failed",
  "outcome-uncertain",
] as const;

describe("every voice state has a distinct look", () => {
  it("maps all five states", () => {
    for (const state of STATES) {
      assert.ok(moodFor(state), `${state} has no mood`);
    }
  });

  it("gives no two states the same palette", () => {
    // If two states share a colour the operator cannot tell them apart, which
    // is the entire job.
    const seen = new Map<string, Mood>();
    for (const profile of Object.values(MOODS)) {
      const key = `${profile.palette.base}|${profile.palette.hot}`;
      assert.equal(seen.get(key), undefined, `${profile.mood} duplicates ${seen.get(key)}`);
      seen.set(key, profile.mood);
    }
    assert.equal(seen.size, 9);
  });

  it("makes thinking visibly not-listening", () => {
    // The pair most likely to be confused: both are "Morpheus is busy and it
    // is not your turn". Violet against cyan is the whole distinction.
    const thinking = hueWindow(moodFor("thinking"));
    const listening = hueWindow(moodFor("listening"));
    assert.ok(
      Math.abs(thinking.centre - listening.centre) > 60,
      `only ${Math.abs(thinking.centre - listening.centre)}° apart`,
    );
  });

  it("makes speaking the loudest and standing by the quietest", () => {
    const energies = STATES.map((s) => moodFor(s).energy);
    assert.equal(Math.max(...energies), moodFor("speaking").energy);
    assert.equal(Math.min(...energies), moodFor("idle").energy);
  });

  it("puts hearing above listening", () => {
    // `hearing` is the only state entered from a measurement rather than from
    // a transition, and it should look like the difference.
    assert.ok(moodFor("hearing").energy > moodFor("listening").energy);
    assert.ok(moodFor("hearing").pulse > moodFor("listening").pulse);
  });
});

describe("the voice may modulate the palette but not replace it", () => {
  it("keeps every hue window inside its own mood", () => {
    // A window wide enough to reach another mood's centre means a loud
    // consonant can make a thinking orb look like a listening one.
    for (const profile of Object.values(MOODS)) {
      assert.ok(profile.hueRange > 0, `${profile.mood} cannot react at all`);
      assert.ok(profile.hueRange <= 90, `${profile.mood} can wander ${profile.hueRange}°`);
    }
  });

  it("gives thinking the narrowest window of all", () => {
    const ranges = Object.values(MOODS).map((m) => m.hueRange);
    assert.equal(Math.min(...ranges), moodFor("thinking").hueRange);
  });

  it("never lets a window carry thinking into the cyan band", () => {
    const { centre, range } = hueWindow(moodFor("thinking"));
    const listening = hueWindow(moodFor("listening")).centre;
    assert.ok(
      Math.abs(centre - range - listening) > 20 && Math.abs(centre + range - listening) > 20,
      "a loud word could turn the thinking orb the listening colour",
    );
  });
});

describe("colour conversion", () => {
  it("reads a hex triple into 0..1 channels", () => {
    assert.deepEqual(toRgb("#000000"), [0, 0, 0]);
    assert.deepEqual(toRgb("#ffffff"), [1, 1, 1]);
    const [r, g, b] = toRgb("#3fe0f0");
    assert.ok(Math.abs(r - 0x3f / 255) < 1e-9);
    assert.ok(g > r && b > g, "cyan should be blue-green dominant");
  });

  it("survives a hex with no leading hash", () => {
    assert.deepEqual(toRgb("ffffff"), [1, 1, 1]);
  });

  it("derives a hue in degrees", () => {
    const cyan = hueWindow({ ...moodFor("listening") });
    assert.ok(cyan.centre > 150 && cyan.centre < 220, `cyan came out at ${cyan.centre}°`);
    const violet = hueWindow(moodFor("thinking"));
    assert.ok(violet.centre > 220 && violet.centre < 290, `violet came out at ${violet.centre}°`);
  });
});

describe("mood and voice stay separate all the way to the shader", () => {
  it("drives colour by easing and the scalars outright", async () => {
    // Easing the scalars would add lag to the one channel that has to feel
    // instant; snapping the colour would make a mood change a jump cut.
    const scene = await fs.readFile(path.join(ROOT, "components/morpheus/CockpitScene.tsx"), "utf8");
    const drive = scene.slice(scene.indexOf("function drive("), scene.indexOf("function agentPosition"));
    assert.match(drive, /u\.uVoiceVolume\.value = v\.volume \* gain;/);
    assert.match(drive, /u\.uColor\.value\.lerp\(/);
    assert.match(drive, /u\.uEnergy\.value \+=/);
  });

  it("bounds the hue shift by the mood's range, not by the volume alone", async () => {
    const scene = await fs.readFile(path.join(ROOT, "components/morpheus/CockpitScene.tsx"), "utf8");
    assert.match(scene, /tint\.centre \+ \([^)]*\) \* tint\.range/);
  });

  it("gives the floor and the core the same driver", async () => {
    // Two surfaces disagreeing about what Morpheus is doing is worse than
    // either of them being wrong.
    const scene = await fs.readFile(path.join(ROOT, "components/morpheus/CockpitScene.tsx"), "utf8");
    const calls = [...scene.matchAll(/drive\(\s*u?n?i?f?o?r?m?s?/g)];
    assert.ok(calls.length >= 2, "only one surface is driven by the voice");
    assert.match(scene, /function WaveFloor\(/);
    assert.match(scene, /function RisingStreams\(/);
  });

  it("flows the surface instead of rhythmically scaling the whole orb", async () => {
    const scene = await fs.readFile(path.join(ROOT, "components/morpheus/CockpitScene.tsx"), "utf8");
    const shaders = await fs.readFile(path.join(ROOT, "components/morpheus/shaders.ts"), "utf8");

    assert.doesNotMatch(
      scene,
      /const breath = 1 \+ Math\.sin/,
      "the entire orb still expands and contracts on a timer",
    );
    assert.match(shaders, /vec3 currentA =/);
    assert.match(shaders, /vec3 currentB =/);
    assert.match(shaders, /float warp = fbm/);
    assert.match(shaders, /float bassFlow = sin/);
    assert.match(scene, /const breathX = Math\.sin/);
    assert.match(scene, /const breathY =/);
    assert.match(scene, /const breathZ =/);
    assert.doesNotMatch(
      scene,
      /setScalar\([^)]*breath/,
      "ambient breathing must not become uniform whole-body pulsing",
    );
  });

  it("electrifies only attending task links and scales traffic with task load", async () => {
    const scene = await fs.readFile(path.join(ROOT, "components/morpheus/CockpitScene.tsx"), "utf8");
    assert.match(scene, /const electrical = attend \* stateDrive/);
    assert.match(scene, /const sparkCount = primary \? Math\.min\(3, 1 \+ taskLoad\) : 1/);
    assert.match(scene, /voiceState === "thinking"/);
    assert.match(scene, /voiceState === "executing"/);
  });
});
