import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { withoutPlaybackEcho } from "../lib/voice";

describe("speech playback echo guard", () => {
  const playback =
    "Hey, I'm good, thanks for asking. Ready to keep the week on track. What's on your mind?";

  it("drops a complete assistant playback transcript", () => {
    assert.equal(
      withoutPlaybackEcho(
        "hey I'm good thanks for asking ready to keep the week on track what's on your mind",
        playback,
      ),
      "",
    );
  });

  it("preserves a real question appended after playback echo", () => {
    assert.equal(
      withoutPlaybackEcho(
        "hey I'm good thanks for asking ready to keep the week on track what's on your mind how is our system running",
        playback,
      ),
      "how is our system running",
    );
  });

  it("removes a delayed partial echo while preserving the operator's own ending", () => {
    assert.equal(
      withoutPlaybackEcho(
        "thanks ready to keep the week on track how's your day shaping up might be better",
        "Hey! I'm good, thanks—ready to keep the week on track. How's your day shaping up?",
      ),
      "might be better",
    );
  });

  it("does not suppress unrelated operator speech", () => {
    assert.equal(
      withoutPlaybackEcho("tell me about Facebook and yourself", playback),
      "tell me about Facebook and yourself",
    );
  });
});
