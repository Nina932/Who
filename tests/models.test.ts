import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseJson, routeTurn } from "../lib/models";

/**
 * Routing decides how much a turn costs and how good the answer is. The
 * escalation rule in particular is a money-and-judgment decision, so it is
 * pinned here rather than left to inspection.
 */

describe("routeTurn", () => {
  it("sends a throwaway turn to the cheap model", () => {
    const route = routeTurn("what time is it");
    assert.equal(route.role, "quick");
    assert.equal(route.spec.provider, "google");
  });

  it("escalates consequential judgment to Opus", () => {
    for (const utterance of [
      "should we raise our pricing next quarter?",
      "is it worth it to hire someone",
      "do we sign this contract",
    ]) {
      const route = routeTurn(utterance);
      assert.equal(route.role, "judgment", `"${utterance}" must escalate`);
      assert.equal(route.spec.provider, "anthropic");
      assert.match(route.reason, /Consequential/);
    }
  });

  it("escalation beats the reasoning tier, not the other way round", () => {
    // Contains both a HARD term ("strategy") and a CONSEQUENTIAL one
    // ("should we"). Being fast and wrong here is the expensive failure.
    const route = routeTurn("should we change the pricing strategy");
    assert.equal(route.role, "judgment");
  });

  it("routes reasoning-shaped turns to Pro", () => {
    const route = routeTurn("compare the two approaches for me");
    assert.equal(route.role, "hard");
  });

  it("treats a very long turn as needing reasoning", () => {
    const route = routeTurn("a".repeat(300));
    assert.equal(route.role, "hard");
    assert.match(route.reason, /Long/);
  });

  it("an attachment always wins — vision is the only role that can read it", () => {
    const route = routeTurn("should we sign this contract", true);
    assert.equal(route.role, "vision");
  });
});

describe("parseJson", () => {
  it("parses plain JSON", () => {
    assert.deepEqual(parseJson<string[]>('["a","b"]'), ["a", "b"]);
  });

  it("survives a fenced block, which models emit despite instructions", () => {
    assert.deepEqual(parseJson<string[]>('```json\n["a"]\n```'), ["a"]);
  });

  it("recovers an object buried in prose", () => {
    assert.deepEqual(
      parseJson<{ a: number }>('Sure! Here you go: {"a": 1} — hope that helps'),
      { a: 1 },
    );
  });

  it("returns null rather than throwing on junk", () => {
    assert.equal(parseJson("not json at all"), null);
  });
});
