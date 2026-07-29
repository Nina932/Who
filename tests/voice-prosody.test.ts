import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deliveryFor,
  isSpokenInterrupt,
  speechChunks,
  speechText,
} from "../lib/voice";

describe("browser voice prosody", () => {
  it("keeps pitch above the floor so intonation survives", () => {
    const delivery = deliveryFor("none");
    assert.ok(delivery.pitch >= 0.65);
    assert.ok(delivery.rate >= 0.85);
    assert.ok(delivery.rate < 0.95);
  });

  it("removes visual syntax that TTS pauses on in the wrong places", () => {
    assert.equal(
      speechText("1. **Kimi K3** — released today. [source: https://example.test]"),
      "Kimi K3, released today.",
    );
  });

  it("speaks a completed answer as one coherent utterance", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    );
    assert.match(source, /if \(reply\.trim\(\)\) speak\(reply\)/);
    assert.doesNotMatch(source, /speakChunk\(unspoken/);
  });

  it("splits provider speech only at readable boundaries", () => {
    const source =
      "The signal is clear. We move when the calendar is protected, the risks are named, and the next action has an owner. Then we close the loop without ceremony.";
    const chunks = speechChunks(source, 70);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((chunk) => chunk.length <= 70));
    assert.equal(chunks.join(" ").replace(/\s+/g, " "), source);
  });

  it("takes the floor only for deliberate wake and stop phrases", () => {
    for (const phrase of [
      "Morpheus",
      "Morpheus, listen",
      "stop talking",
      "wait",
      "pause please",
      "hold on",
      "Murphy, stop",
    ]) {
      assert.equal(isSpokenInterrupt(phrase), true, phrase);
    }
    for (const noise of [
      "hello",
      "ahem",
      "waiting for the result",
      "unstoppable",
      "background music",
    ]) {
      assert.equal(isSpokenInterrupt(noise), false, noise);
    }
  });
});
