import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { groundedInOperator } from "../lib/memory";

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
