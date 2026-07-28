import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * Style learning is the one "it learns" claim that works with no API key at
 * all, so it is fully testable — and worth testing, because a wrong profile
 * silently poisons every draft the Content Engine writes.
 */

let tmp: string;
let style: typeof import("../lib/style");

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "thor-style-"));
  process.env.THOR_DATA_DIR = tmp;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GEMINI_API_KEY;
  style = await import("../lib/style");
});

after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("recordEdit", () => {
  it("ignores a non-edit", async () => {
    const profile = await style.recordEdit("same text", "same text");
    assert.equal(profile.metrics.samples, 0);
  });

  it("learns length, punctuation and vocabulary from real diffs", async () => {
    const pairs: Array<[string, string]> = [
      [
        "We are absolutely thrilled to announce that we leveraged cutting-edge AI! 🚀 #AI #Growth",
        "Rebuilt the voice system. It works now.",
      ],
      [
        "I am absolutely thrilled to share we leveraged our revolutionary platform! 🎉 #Tech",
        "Shipped Specialist Attendance today.",
      ],
      [
        "Thrilled to unveil our revolutionary approach that will absolutely transform everything! 🔥",
        "The loops engine learns from rejections.",
      ],
    ];

    let profile = await style.getProfile();
    for (const [draft, edited] of pairs) {
      profile = await style.recordEdit(draft, edited);
    }

    const m = profile.metrics;
    assert.equal(m.samples, 3);
    assert.ok(m.lengthDelta > 0.4, `expected heavy cutting, got ${m.lengthDelta}`);
    assert.equal(m.emojiPerPost, 0);
    assert.equal(m.exclamationPerPost, 0);
    assert.equal(m.hashtagPerPost, 0);

    // Words cut in every single sample are a preference, not noise.
    for (const word of ["absolutely", "thrilled", "leveraged"]) {
      assert.ok(m.avoids.includes(word), `expected "${word}" in avoids`);
    }
  });

  it("renders the profile as instructions a model can follow", async () => {
    const rendered = style.renderForPrompt(await style.getProfile());
    assert.match(rendered, /No emoji/);
    assert.match(rendered, /No exclamation marks/);
    assert.match(rendered, /repeatedly delete/);
    // Numbers are useless to a model; the text must be imperative.
    assert.doesNotMatch(rendered, /lengthDelta/);
  });
});

describe("moreMyStyle", () => {
  it("returns the text untouched, and says why, when no model is reachable", async () => {
    // With a profile learned but no key, the honest outcome is the original
    // text plus the reason — never a silent no-op, and never a fabrication.
    const result = await style.moreMyStyle("Absolutely thrilled to share this!");
    assert.equal(result.text, "Absolutely thrilled to share this!");
    assert.equal(result.live, false);
    assert.ok(result.note && result.note.length > 0, "must explain itself");
  });
});
