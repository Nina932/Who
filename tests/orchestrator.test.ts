import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideAttendance, scoreAgents } from "../lib/orchestrator";

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
  it("falls back to the chief of staff rather than guessing", () => {
    const decision = decideAttendance("hello there");
    assert.equal(decision.primaryId, "chief-of-staff");
    assert.deepEqual(decision.triggers, []);
    assert.ok(decision.confidence < 0.5, "an unmatched turn must not look confident");
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
