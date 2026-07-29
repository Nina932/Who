import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideAttendance, draftReply, scoreAgents } from "../lib/orchestrator";

/**
 * Specialist Attendance is the product's headline claim, so its routing gets
 * the most direct tests: the right seat, for a reason the operator can see.
 */

describe("scoreAgents", () => {
  it("scores only agents whose vocabulary actually matched", () => {
    const scores = scoreAgents("check the invoice and the runway");
    assert.ok(scores.has("finance"), "finance should match on invoice/runway");
    assert.ok(!scores.has("design"), "design has no matching terms here");
  });

  it("weights multi-word terms above single words", () => {
    // "post about" is a two-word term; "post" alone is one. The longer, more
    // specific phrase has to win, or every noun drags in a specialist.
    const single = scoreAgents("post")?.get("social")?.score ?? 0;
    const multi = scoreAgents("post about the launch")?.get("social")?.score ?? 0;
    assert.ok(multi > single, `expected ${multi} > ${single}`);
  });

  it("returns an empty map when nothing is in any domain", () => {
    assert.equal(scoreAgents("mmm").size, 0);
  });
});

describe("decideAttendance", () => {
  it("keeps ordinary conversation with Morpheus instead of inventing a staff handoff", () => {
    const decision = decideAttendance("hello there");
    assert.equal(decision.primaryId, null);
    assert.deepEqual(decision.triggers, []);
    assert.ok(decision.confidence > 0.8, "a direct greeting should be recognized confidently");
  });

  it("names the specialist and the words that summoned them", () => {
    const decision = decideAttendance("what is our runway looking like");
    assert.equal(decision.primaryId, "finance");
    assert.ok(
      decision.triggers.includes("runway"),
      "the trigger has to be surfaced or the routing is unauditable",
    );
  });

  it("only consults near-scorers, not the whole roster", () => {
    // One stray keyword must not pull half the company into the room.
    const decision = decideAttendance(
      "write the code, plan the campaign, check the invoice, book a meeting",
    );
    assert.ok(
      decision.supportingIds.length <= 2,
      `expected at most 2 supporting, got ${decision.supportingIds.length}`,
    );
    assert.ok(!decision.supportingIds.includes(decision.primaryId as string));
  });

  it("never returns an integration as the attending seat", () => {
    // Integrations are reached through agents; they cannot hold the floor.
    const decision = decideAttendance("check my drive for the file");
    assert.notEqual(decision.primaryId, "drive");
  });
});

describe("offline replies", () => {
  it("answers a greeting instead of reciting the chief of staff charter", () => {
    const decision = decideAttendance("hello");
    const reply = draftReply("hello", decision);
    assert.match(reply, /^Hello, Nino\./);
    assert.doesNotMatch(reply, /Holds the operator's week|Taking this one directly/);
  });

  it("does not route a social use of 'today' to the chief of staff", () => {
    const decision = decideAttendance("hello Morpheus how are you doing today");
    assert.equal(decision.primaryId, null);
    assert.deepEqual(decision.triggers, []);
  });

  it("names the actually supported free-key paths", () => {
    const decision = decideAttendance("check the sales pipeline");
    const reply = draftReply("check the sales pipeline", decision);
    assert.match(reply, /GROQ_API_KEY or GOOGLE_API_KEY/);
    assert.doesNotMatch(reply, /ANTHROPIC_API_KEY/);
  });
});
