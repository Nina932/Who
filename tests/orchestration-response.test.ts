import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { orchestrationReply } from "../lib/orchestration-response";

describe("explicit orchestration response", () => {
  it("leads with a grounded command brief instead of staff theatre", () => {
    const reply = orchestrationReply(
      "Morpheus, take the lead and orchestrate the launch across engineering, design, and marketing",
    );

    assert.match(reply, /^Objective:/);
    assert.match(reply, /Engineering:/);
    assert.match(reply, /Design:/);
    assert.match(reply, /Marketing:/);
    assert.match(reply, /Chief of staff:/);
    assert.match(reply, /Immediate next move:/);
    assert.match(reply, /Nothing was scheduled, sent, published, or started/);
    assert.doesNotMatch(reply, /10\s*%|will schedule|kickoff today/i);
  });

  it("still has a lead when no domain was named", () => {
    const reply = orchestrationReply("Morpheus, orchestrate this");
    assert.match(reply, /Chief of staff:/);
    assert.match(reply, /the requested work/);
  });
});
