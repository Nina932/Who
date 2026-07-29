import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  requestsSystemStatus,
  systemStatusReply,
} from "../lib/system-status";

describe("measured system status", () => {
  it("recognises system and CI/CD health questions", () => {
    assert.equal(requestsSystemStatus("how our system is running"), true);
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
});
