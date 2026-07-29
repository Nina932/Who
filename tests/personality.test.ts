import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");

describe("spoken personality", () => {
  it("treats obvious exaggeration as humor instead of a work order", async () => {
    const source = await fs.readFile(
      path.join(ROOT, "app/api/morpheus/route.ts"),
      "utf8",
    );
    assert.match(source, /mock drama, and obvious overstatement are usually humor/);
    assert.match(source, /do not operationalize the absurd premise/);
    assert.match(source, /Dry humor and a little bite are welcome/);
    assert.match(source, /stop after the humorous line/);
  });

  it("rejects the corporate-assistant register", async () => {
    const source = await fs.readFile(
      path.join(ROOT, "app/api/morpheus/route.ts"),
      "utf8",
    );
    assert.match(source, /not a corporate assistant/);
    assert.match(source, /Never recite your title, charter, routing logic/);
    assert.match(source, /A greeting gets a greeting/);
    assert.match(source, /never perform it as a staff persona/);
    assert.match(source, /Do not invent activity such as calendars humming/);
    assert.match(source, /Do not turn casual conversation into a weekly-priority question/);
  });

  it("keeps the browser voice weighted without flattening prosody", async () => {
    const source = await fs.readFile(path.join(ROOT, "lib/voice.ts"), "utf8");
    assert.match(source, /Very deep mechanical baritone/);
    assert.match(source, /MORPHEUS_VOICE_RATE \?\? 0\.88/);
    assert.match(source, /MORPHEUS_VOICE_PITCH \?\? 0\.68/);
    assert.match(source, /guy natural/);
  });

  it("keeps one Morpheus identity in the visible transcript", async () => {
    const source = await fs.readFile(
      path.join(ROOT, "components/TranscriptRail.tsx"),
      "utf8",
    );
    assert.match(source, /\{isOperator \? "You" : "Morpheus"\}/);
    assert.doesNotMatch(source, /AGENTS_BY_ID/);
  });
});
