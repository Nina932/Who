import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  audioUnderstandingReply,
  requestsAudioUnderstanding,
  requestsSystemStatus,
  systemStatusReply,
} from "../lib/system-status";

describe("measured system status", () => {
  it("recognises system and CI/CD health questions", () => {
    assert.equal(requestsSystemStatus("how our system is running"), true);
    assert.equal(requestsSystemStatus("I'd like to know how systems are running"), true);
    assert.equal(requestsSystemStatus("show me the CI/CD pipeline status"), true);
    assert.equal(requestsSystemStatus("tell me about yourself"), false);
  });

  it("never turns unqueried infrastructure into an all-green claim", () => {
    const reply = systemStatusReply(
      [
        {
          role: "quick",
          spec: { label: "Groq" },
          ready: true,
          protected: false,
        },
      ],
      { configured: true, verified: true, workerActive: true, paired: false },
    );
    assert.match(reply, /request path is responding/i);
    assert.match(reply, /not queried GitHub Actions/i);
    assert.doesNotMatch(reply, /all systems are green/i);
  });

  it("states the microphone boundary instead of pretending to understand a dog", () => {
    assert.equal(requestsAudioUnderstanding("can you hear my dog"), true);
    assert.match(audioUnderstandingReply(), /detect microphone energy/i);
    assert.match(audioUnderstandingReply(), /cannot classify a bark/i);
  });
});
