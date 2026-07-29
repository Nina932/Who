import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { MECHANICAL } from "../lib/voice-chain";

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

  it("takes command when orchestration is explicitly requested", async () => {
    const source = await fs.readFile(
      path.join(ROOT, "app/api/morpheus/route.ts"),
      "utf8",
    );
    assert.match(source, /ORCHESTRATION MODE IS EXPLICITLY REQUESTED/);
    assert.match(source, /state the objective/);
    assert.match(source, /separate what can be done now/);
    assert.match(source, /Never promise an invisible handoff/);
    assert.match(source, /Never invent capacity percentages/);
    assert.match(source, /do not claim a kickoff was scheduled/);
  });

  it("keeps the browser voice weighted without flattening prosody", async () => {
    const source = await fs.readFile(path.join(ROOT, "lib/voice.ts"), "utf8");
    assert.match(source, /Very deep mechanical baritone/);
    assert.match(source, /MORPHEUS_VOICE_RATE \?\? 0\.88/);
    assert.match(source, /MORPHEUS_VOICE_PITCH \?\? 0\.68/);
    assert.match(source, /guy natural/);
    // The provider path's character lives in the chain spec rather than in the
    // hook, so it is asserted against the values themselves — a graph rebuilt
    // in a different file would still have to satisfy these.
    assert.equal(MECHANICAL.modulatorHz, 46);
    assert.equal(MECHANICAL.bodyGainDb, 7);
    const hook = await fs.readFile(path.join(ROOT, "lib/useVoice.ts"), "utf8");
    assert.match(hook, /buildMechanicalVoice\(/);
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
