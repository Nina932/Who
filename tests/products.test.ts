import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { advisoryConfidence, rank } from "../lib/advisory";
import { validate, type Entry } from "../lib/knowledge";
import {
  CONCURRENT_LIMIT,
  PHASE_PATIENCE_DAYS,
  advise,
  exampleKnowledge,
  exampleProducts,
  view,
  type Product,
} from "../lib/products";

/**
 * These rules exist to catch the failure that is invisible day to day: a
 * product where every week looks productive and no week moves it. So the tests
 * are about time, not state — and about the rules staying quiet when there is
 * nothing to say, which is the harder half.
 */

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const ago = (days: number) => NOW - days * DAY;

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: "p1",
    name: "Test Product",
    phase: "build",
    phaseSince: ago(5),
    objective: "Ship something",
    working: [],
    blockers: [],
    milestone: { name: "First release", exit: [] },
    ...overrides,
  };
}

const views = (products: Product[], entries: Entry[] = []) =>
  products.map((p) => view(p, entries, NOW));

const rules = (products: Product[], entries: Entry[] = []) =>
  advise(views(products, entries), entries, NOW).map((a) => a.rule);

describe("advisory shape", () => {
  it("every advisory says what would make it wrong", () => {
    // The field that turns a suggestion into a claim. Without it there is
    // nothing to check and nothing to disagree with.
    const entries = exampleKnowledge(NOW);
    const all = advise(views(exampleProducts(NOW), entries), entries, NOW);
    assert.ok(all.length > 0);
    for (const advisory of all) {
      assert.ok(advisory.wouldChangeIf.trim().length > 10, `${advisory.rule} has no falsifier`);
      assert.ok(advisory.tradeOff.trim().length > 10, `${advisory.rule} claims no cost`);
      assert.ok(advisory.reason.trim().length > 10);
      assert.ok(advisory.rule.trim().length > 0, "an advisory must name the rule that fired");
    }
  });

  it("never cites a hypothesis as evidence, even accidentally", () => {
    const entries = exampleKnowledge(NOW);
    const byId = new Map(entries.map((e) => [e.id, e]));
    for (const advisory of advise(views(exampleProducts(NOW), entries), entries, NOW)) {
      for (const ref of advisory.evidence) {
        assert.notEqual(
          byId.get(ref)?.kind,
          "hypothesis",
          `${advisory.rule} rests on a hypothesis`,
        );
      }
    }
  });

  it("caps confidence at the weakest evidence", () => {
    const entries: Entry[] = [
      { id: "a", kind: "fact", subject: "p1", text: "solid", at: ago(1), provenance: "observed" },
      { id: "b", kind: "fact", subject: "p1", text: "shaky", at: ago(1), provenance: "guessed" },
    ];
    assert.equal(advisoryConfidence(["a", "a"], entries, NOW), "high");
    assert.equal(advisoryConfidence(["a", "b"], entries, NOW), "low");
  });

  it("will not call a single-source claim high confidence", () => {
    const entries: Entry[] = [
      { id: "a", kind: "fact", subject: "p1", text: "solid", at: ago(1), provenance: "observed" },
    ];
    assert.equal(advisoryConfidence(["a"], entries, NOW), "medium");
  });

  it("sorts the heaviest first", () => {
    const ranked = rank(advise(views(exampleProducts(NOW), exampleKnowledge(NOW)), exampleKnowledge(NOW), NOW));
    for (let i = 1; i < ranked.length; i += 1) {
      assert.ok(ranked[i - 1].weight >= ranked[i].weight);
    }
  });
});

describe("the rules stay quiet when there is nothing to say", () => {
  it("says nothing about a young, unblocked product", () => {
    assert.deepEqual(rules([product()]), []);
  });

  it("says nothing about a paused product, however stale", () => {
    assert.deepEqual(rules([product({ phase: "paused", phaseSince: ago(400) })]), []);
  });

  it("says nothing about an archived product", () => {
    assert.deepEqual(rules([product({ archived: true, phaseSince: ago(400) })]), []);
  });
});

describe("phase-stalled", () => {
  it("fires once a phase outlives what that phase reasonably takes", () => {
    const held = PHASE_PATIENCE_DAYS.build + 10;
    assert.ok(rules([product({ phaseSince: ago(held) })]).includes("phase-stalled"));
  });

  it("does not fire a day early", () => {
    const held = PHASE_PATIENCE_DAYS.build - 1;
    assert.ok(!rules([product({ phaseSince: ago(held) })]).includes("phase-stalled"));
  });

  it("weighs a phase held twice as long more heavily", () => {
    const one = advise(views([product({ phaseSince: ago(70) })]), [], NOW)[0];
    const worse = advise(views([product({ phaseSince: ago(200) })]), [], NOW)[0];
    assert.ok(worse.weight > one.weight);
  });
});

describe("carried-blocker", () => {
  it("fires on a blocker open longer than two weeks", () => {
    const p = product({ blockers: [{ id: "b", name: "Worker deploy", openedAt: ago(24) }] });
    assert.ok(rules([p]).includes("carried-blocker"));
  });

  it("stays quiet on a blocker opened this week", () => {
    const p = product({ blockers: [{ id: "b", name: "Worker deploy", openedAt: ago(4) }] });
    assert.ok(!rules([p]).includes("carried-blocker"));
  });

  it("ignores a blocker that was resolved", () => {
    const p = product({
      blockers: [{ id: "b", name: "Worker deploy", openedAt: ago(60), resolvedAt: ago(2) }],
    });
    assert.ok(!rules([p]).includes("carried-blocker"));
  });

  it("names the specific blocker, so the advice is actionable", () => {
    const p = product({ blockers: [{ id: "b", name: "Worker deploy", openedAt: ago(24) }] });
    const advisory = advise(views([p]), [], NOW).find((a) => a.rule === "carried-blocker");
    assert.match(advisory?.recommendation ?? "", /Worker deploy/);
    assert.match(advisory?.wouldChangeIf ?? "", /Worker deploy/);
  });
});

describe("expansion-under-blocker", () => {
  it("fires when surfaces shipped after the blocker opened", () => {
    // The most reliable tell that the hard thing is being avoided while the
    // week still looks productive.
    const p = product({
      blockers: [{ id: "b", name: "Worker deploy", openedAt: ago(30) }],
      working: [
        { name: "Run history", at: ago(20) },
        { name: "Settings", at: ago(10) },
      ],
    });
    assert.ok(rules([p]).includes("expansion-under-blocker"));
  });

  it("does not fire for work that predates the blocker", () => {
    const p = product({
      blockers: [{ id: "b", name: "Worker deploy", openedAt: ago(5) }],
      working: [
        { name: "Run history", at: ago(40) },
        { name: "Settings", at: ago(30) },
      ],
    });
    assert.ok(!rules([p]).includes("expansion-under-blocker"));
  });

  it("does not fire on a single addition — one is not a pattern", () => {
    const p = product({
      blockers: [{ id: "b", name: "Worker deploy", openedAt: ago(30) }],
      working: [{ name: "Run history", at: ago(20) }],
    });
    assert.ok(!rules([p]).includes("expansion-under-blocker"));
  });
});

describe("milestone-unevidenced", () => {
  it("fires when no exit condition has evidence after three weeks", () => {
    const p = product({
      phaseSince: ago(30),
      milestone: { name: "Ship", exit: [{ id: "x", text: "It runs", evidence: [] }] },
    });
    assert.ok(rules([p]).includes("milestone-unevidenced"));
  });

  it("stops firing as soon as one condition is evidenced", () => {
    const entries: Entry[] = [
      { id: "f1", kind: "fact", subject: "p1", text: "It ran", at: ago(2), provenance: "observed" },
    ];
    const p = product({
      phaseSince: ago(30),
      milestone: { name: "Ship", exit: [{ id: "x", text: "It runs", evidence: ["f1"] }] },
    });
    assert.ok(!rules([p], entries).includes("milestone-unevidenced"));
  });

  it("does not accept stale evidence as proof", () => {
    // A proof from two months ago about a system that has changed since is a
    // memory of a proof.
    const entries: Entry[] = [
      { id: "f1", kind: "fact", subject: "p1", text: "It ran", at: ago(60), provenance: "observed" },
    ];
    const p = product({
      phaseSince: ago(30),
      milestone: { name: "Ship", exit: [{ id: "x", text: "It runs", evidence: ["f1"] }] },
    });
    assert.ok(rules([p], entries).includes("milestone-unevidenced"));
    assert.equal(views([p], entries)[0].metConditions, 0);
  });
});

describe("no-commercial-motion", () => {
  it("fires when everything recent is internal machinery", () => {
    const p = product({
      working: [
        { name: "Metering", at: ago(10) },
        { name: "Isolation", at: ago(20) },
        { name: "Durable execution", at: ago(30) },
      ],
    });
    assert.ok(rules([p]).includes("no-commercial-motion"));
  });

  it("stays quiet when something recent reaches a customer", () => {
    const p = product({
      working: [
        { name: "Metering", at: ago(10) },
        { name: "Isolation", at: ago(20) },
        { name: "Public demo", at: ago(30), customerFacing: true },
      ],
    });
    assert.ok(!rules([p]).includes("no-commercial-motion"));
  });
});

describe("too-many-active", () => {
  it("fires past the limit one person can genuinely carry", () => {
    const many = Array.from({ length: CONCURRENT_LIMIT + 1 }, (_, i) =>
      product({ id: `p${i}`, name: `P${i}` }),
    );
    assert.ok(rules(many).includes("too-many-active"));
  });

  it("does not count paused products against the limit", () => {
    const some = [
      ...Array.from({ length: CONCURRENT_LIMIT }, (_, i) => product({ id: `p${i}`, name: `P${i}` })),
      product({ id: "px", name: "Parked", phase: "paused" }),
    ];
    assert.ok(!rules(some).includes("too-many-active"));
  });
});

describe("the example products", () => {
  const entries = exampleKnowledge(NOW);

  it("carry a sound knowledge base — no mixed evidence", () => {
    assert.deepEqual(validate(entries), []);
  });

  it("reproduce the operator's own read of G8", () => {
    // Three surfaces added while the worker blocker stayed open. If the rules
    // are right, they should reach the conclusion the operator already did.
    const fired = rules(exampleProducts(NOW), entries);
    assert.ok(fired.includes("expansion-under-blocker"));
    assert.ok(fired.includes("carried-blocker"));
  });

  it("notice that neither product has shown a buyer anything", () => {
    const fired = rules(exampleProducts(NOW), entries);
    assert.ok(fired.includes("milestone-unevidenced"));
  });

  it("count exit conditions honestly — none is not some", () => {
    for (const v of views(exampleProducts(NOW), entries)) {
      assert.equal(v.metConditions, 0);
      assert.equal(v.totalConditions, 3);
    }
  });
});
