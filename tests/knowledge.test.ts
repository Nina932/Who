import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAY_CITE,
  commitmentsAtRisk,
  confidenceOf,
  isStale,
  renderForPrompt,
  select,
  untestedHypotheses,
  validate,
  type Entry,
} from "../lib/knowledge";

/**
 * The whole trustworthiness claim rests here. If a hypothesis can be laundered
 * into evidence for a recommendation, every downstream surface is confidently
 * wrong and looks exactly the same as when it is right.
 */

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const ago = (days: number) => NOW - days * DAY;

function e(partial: Partial<Entry> & Pick<Entry, "id" | "kind">): Entry {
  return {
    subject: "finai",
    text: `${partial.kind} ${partial.id}`,
    at: ago(1),
    provenance: "observed",
    ...partial,
  };
}

describe("the mixing rules", () => {
  it("never lets a hypothesis be evidence for anything but a hypothesis", () => {
    for (const [kind, allowed] of Object.entries(MAY_CITE)) {
      if (kind === "hypothesis") continue;
      assert.ok(
        !allowed.includes("hypothesis"),
        `a ${kind} may cite a hypothesis, which is the entire failure this prevents`,
      );
    }
  });

  it("never lets a recommendation be evidence for anything at all", () => {
    for (const allowed of Object.values(MAY_CITE)) {
      assert.ok(!allowed.includes("recommendation"));
    }
  });

  it("catches a recommendation resting on a hunch", () => {
    const entries = [
      e({ id: "h1", kind: "hypothesis", provenance: "inferred" }),
      e({ id: "r1", kind: "recommendation", evidence: ["h1"] }),
    ];
    const problems = validate(entries);
    assert.equal(problems.length, 1);
    assert.match(problems[0].message, /a recommendation may not rest on a hypothesis/);
  });

  it("allows a hypothesis to rest on a fact — that is what a hypothesis is", () => {
    const entries = [
      e({ id: "f1", kind: "fact" }),
      e({ id: "h1", kind: "hypothesis", evidence: ["f1"] }),
    ];
    assert.deepEqual(validate(entries), []);
  });

  it("catches evidence that does not exist", () => {
    const problems = validate([e({ id: "r1", kind: "recommendation", evidence: ["ghost"] })]);
    assert.match(problems[0].message, /does not exist/);
  });

  it("catches a circular chain", () => {
    const entries = [
      e({ id: "f1", kind: "fact", evidence: ["f2"] }),
      e({ id: "f2", kind: "fact", evidence: ["f1"] }),
    ];
    assert.ok(validate(entries).some((p) => /circular/.test(p.message)));
  });

  it("refuses a commitment with no date", () => {
    const problems = validate([e({ id: "c1", kind: "commitment" })]);
    assert.match(problems[0].message, /not a commitment/);
  });
});

describe("confidence", () => {
  it("is capped by the weakest thing underneath it", () => {
    const entries = [
      e({ id: "f1", kind: "fact", provenance: "guessed" }),
      e({ id: "r1", kind: "recommendation", evidence: ["f1"] }),
    ];
    // The recommendation itself is "observed", but it stands on a guess.
    assert.equal(confidenceOf(entries[1], entries, NOW), "low");
  });

  it("does not let a well-sourced recommendation inherit high from thin air", () => {
    const alone = e({ id: "r1", kind: "recommendation", evidence: [] });
    assert.notEqual(confidenceOf(alone, [alone], NOW), "high");
  });

  it("drops a level once the entry is stale", () => {
    const fresh = e({ id: "f1", kind: "fact", at: ago(1) });
    const old = e({ id: "f2", kind: "fact", at: ago(60) });
    assert.equal(confidenceOf(fresh, [fresh], NOW), "high");
    assert.equal(confidenceOf(old, [old], NOW), "medium");
  });

  it("rates a stated thing below an observed one", () => {
    const observed = e({ id: "a", kind: "fact", provenance: "observed" });
    const stated = e({ id: "b", kind: "fact", provenance: "stated" });
    assert.equal(confidenceOf(observed, [observed], NOW), "high");
    assert.equal(confidenceOf(stated, [stated], NOW), "medium");
  });
});

describe("staleness", () => {
  it("expires a three-week-old observation about a moving system", () => {
    assert.ok(isStale(e({ id: "f", kind: "fact", at: ago(22) }), NOW));
    assert.ok(!isStale(e({ id: "f", kind: "fact", at: ago(20) }), NOW));
  });

  it("keeps a decision current far longer than an observation", () => {
    assert.ok(!isStale(e({ id: "d", kind: "decision", at: ago(60) }), NOW));
  });

  it("treats a superseded entry as stale whatever its age", () => {
    assert.ok(isStale(e({ id: "f", kind: "fact", at: NOW, supersededBy: "f2" }), NOW));
  });

  it("uses a commitment's own date rather than the default shelf life", () => {
    const soon = e({ id: "c", kind: "commitment", at: ago(1), dueAt: NOW - DAY });
    assert.ok(isStale(soon, NOW), "a commitment past its date is not current");
  });
});

describe("select", () => {
  const entries = [
    e({ id: "f1", kind: "fact", subject: "finai", at: ago(1) }),
    e({ id: "f2", kind: "fact", subject: "g8", at: ago(2) }),
    e({ id: "f3", kind: "fact", subject: "finai", at: ago(60) }),
    e({ id: "h1", kind: "hypothesis", subject: "finai", at: ago(1) }),
  ];

  it("scopes to a subject", () => {
    assert.deepEqual(
      select(entries, { subject: "g8" }, NOW).map((x) => x.id),
      ["f2"],
    );
  });

  it("drops stale entries unless asked not to", () => {
    assert.ok(!select(entries, { subject: "finai" }, NOW).some((x) => x.id === "f3"));
    assert.ok(
      select(entries, { subject: "finai", current: false }, NOW).some((x) => x.id === "f3"),
    );
  });

  it("returns newest first", () => {
    const got = select(entries, {}, NOW);
    for (let i = 1; i < got.length; i += 1) assert.ok(got[i - 1].at >= got[i].at);
  });
});

describe("commitments", () => {
  it("surfaces one that is close before it is late", () => {
    const c = e({ id: "c", kind: "commitment", at: ago(5), dueAt: NOW + 2 * DAY });
    const [row] = commitmentsAtRisk([c], NOW);
    assert.ok(row);
    assert.ok(row.overdueDays < 0, "not yet late");
  });

  it("ignores one comfortably in the future", () => {
    const c = e({ id: "c", kind: "commitment", at: ago(1), dueAt: NOW + 30 * DAY });
    assert.deepEqual(commitmentsAtRisk([c], NOW), []);
  });

  it("puts the most overdue first", () => {
    const rows = commitmentsAtRisk(
      [
        e({ id: "a", kind: "commitment", at: ago(20), dueAt: NOW - 2 * DAY }),
        e({ id: "b", kind: "commitment", at: ago(20), dueAt: NOW - 9 * DAY }),
      ],
      NOW,
    );
    assert.equal(rows[0].entry.id, "b");
  });
});

describe("untested hypotheses", () => {
  it("finds one carried past its shelf life", () => {
    const old = e({ id: "h", kind: "hypothesis", at: ago(45) });
    const fresh = e({ id: "h2", kind: "hypothesis", at: ago(3) });
    assert.deepEqual(
      untestedHypotheses([old, fresh], NOW).map((x) => x.id),
      ["h"],
    );
  });
});

describe("renderForPrompt", () => {
  it("keeps the kinds apart and says so", () => {
    const entries = [
      e({ id: "f1", kind: "fact", text: "The worker is not deployed." }),
      e({ id: "h1", kind: "hypothesis", text: "Petroleum may be the wedge." }),
    ];
    const rendered = renderForPrompt(entries, NOW);
    assert.match(rendered, /A hypothesis is not a fact/);
    // Separate, labelled sections — and facts before hypotheses, so a model
    // reading top-down meets the solid ground first.
    assert.ok(rendered.includes("FACTS —"));
    assert.ok(rendered.includes("HYPOTHESES —"));
    assert.ok(rendered.indexOf("FACTS —") < rendered.indexOf("HYPOTHESES —"));
    assert.match(rendered, /The worker is not deployed\./);
    assert.match(rendered, /\[high, observed\]/);
  });

  it("omits stale entries rather than passing history off as current", () => {
    const entries = [e({ id: "f1", kind: "fact", at: ago(90), text: "Was true once." })];
    assert.equal(renderForPrompt(entries, NOW), "");
  });
});
