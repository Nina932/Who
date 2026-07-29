import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { groundedInOperator, trustedForRecall } from "../lib/memory";

describe("memory grounding", () => {
  it("does not turn a question about the assistant into operator memory", () => {
    assert.equal(
      groundedInOperator(
        "The assistant is the chief of staff at Morpheus.",
        "Tell me about yourself",
      ),
      false,
    );
  });

  it("does not invent constraints from a topic-only request", () => {
    assert.equal(
      groundedInOperator(
        "Engineering capacity is squeezed with a thin ten percent contingency.",
        "Compare our launch strategy, engineering constraints, and budget risk",
      ),
      false,
    );
  });

  it("quarantines an ungrounded legacy extractor claim during recall", () => {
    assert.equal(
      trustedForRecall({
        id: "old",
        text: "The budget includes a thin 10% contingency.",
        kind: "constraint",
        confidence: 0.97,
        source: "Compare our launch strategy, engineering constraints, and budget risk",
        createdAt: 1,
        recalled: 87,
      }),
      false,
    );
  });

  it("keeps an explicit durable operator preference", () => {
    assert.equal(
      groundedInOperator(
        "The operator prefers concise development briefings.",
        "I prefer concise development briefings with only important information",
      ),
      true,
    );
  });
});
