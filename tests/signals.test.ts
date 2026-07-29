import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exampleKnowledge, exampleProducts, view } from "../lib/products";
import { ALERT_CAP, classify, exampleSignals, partition, type Signal } from "../lib/signals";

/**
 * The value of an intelligence layer is entirely in what it throws away, so
 * these test the discarding. The one that matters most is the third: a
 * genuinely impressive development, relevant to the stack, correctly told to
 * wait because it is not where the constraint is.
 */

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const entries = exampleKnowledge(NOW);
const products = exampleProducts(NOW).map((p) => view(p, entries, NOW));

const signal = (overrides: Partial<Signal> = {}): Signal => ({
  id: "s1",
  headline: "Something happened",
  summary: "Details",
  nature: "capability",
  tags: [],
  source: "test",
  at: NOW - DAY,
  ...overrides,
});

describe("relevance is measured against the constraint", () => {
  it("acts now when a signal lands on the thing blocking the release", () => {
    const hit = classify(
      signal({ tags: ["production worker deployment"] }),
      products,
    );
    assert.equal(hit.verdict, "act-now");
    assert.match(hit.because, /stopping the release/);
    assert.ok(hit.touchesBlocker?.includes("G8"));
  });

  it("tells a genuinely good development to wait when it is not the constraint", () => {
    // The whole point. Better tool-calling is real and is not the problem.
    const model = classify(
      signal({ headline: "Better tool calling", tags: ["coding tools", "durable execution"] }),
      products,
    );
    assert.equal(model.verdict, "evaluate-soon");
    assert.match(model.because, /your current blocker is/);
  });

  it("ignores something that touches nothing", () => {
    const noise = classify(signal({ tags: ["javascript framework", "hydration"] }), products);
    assert.equal(noise.verdict, "ignore-for-now");
    assert.deepEqual(noise.affects, []);
  });

  it("never invents a product to be relevant to", () => {
    for (const classified of exampleSignals(NOW).map((s) => classify(s, products))) {
      for (const id of classified.affects) {
        assert.ok(products.some((p) => p.id === id), `invented a product: ${id}`);
      }
    }
  });
});

describe("forcing natures", () => {
  it("acts now on a deprecation of something in the stack, whatever the phase", () => {
    const dep = classify(
      signal({ nature: "deprecation", tags: ["sandbox isolation"] }),
      products,
    );
    assert.equal(dep.verdict, "act-now");
    assert.match(dep.because, /does not wait/);
  });

  it("acts now on a vulnerability in the stack", () => {
    const vuln = classify(signal({ nature: "vulnerability", tags: ["data lineage"] }), products);
    assert.equal(vuln.verdict, "act-now");
  });

  it("does not act now on a deprecation of something you do not use", () => {
    const irrelevant = classify(
      signal({ nature: "deprecation", tags: ["some other runtime"] }),
      products,
    );
    assert.equal(irrelevant.verdict, "ignore-for-now");
  });

  it("acts now when a capability replaces work you planned to build", () => {
    const replaces = classify(
      signal({ nature: "replaces-planned-work", tags: ["data lineage"] }),
      products,
    );
    assert.equal(replaces.verdict, "act-now");
    assert.match(replaces.because, /before writing more of it/);
  });
});

describe("market signals", () => {
  it("watches rather than acts when nothing connects to a product", () => {
    const market = classify(
      signal({ nature: "market", tags: ["governance", "audit"] }),
      products,
    );
    assert.equal(market.verdict, "watch");
    assert.match(market.because, /assumption before it changes a plan/);
  });
});

describe("partition", () => {
  it("only act-now earns an interruption", () => {
    const { alerts, digest } = partition(exampleSignals(NOW).map((s) => classify(s, products)));
    assert.ok(alerts.every((a) => a.verdict === "act-now"));
    assert.ok(digest.every((d) => d.verdict !== "act-now"));
  });

  it("loses nothing between the two", () => {
    const all = exampleSignals(NOW).map((s) => classify(s, products));
    const { alerts, digest } = partition(all);
    assert.equal(alerts.length + digest.length, all.length);
  });

  it("caps interruptions, because attention does not scale", () => {
    // A day with eleven urgent items has no urgent items.
    const many = Array.from({ length: 9 }, (_, i) =>
      classify(
        signal({ id: `m${i}`, nature: "vulnerability", tags: ["data lineage"], at: NOW - i }),
        products,
      ),
    );
    const { alerts, pushedDown } = partition(many);
    assert.equal(alerts.length, ALERT_CAP);
    assert.equal(pushedDown, 9 - ALERT_CAP);
  });

  it("keeps the over-cap items urgent rather than downgrading them", () => {
    // They move into the digest; they do not stop being act-now. Rewriting
    // the verdict to fit the cap would be lying to make a list fit.
    const many = Array.from({ length: 5 }, (_, i) =>
      classify(signal({ id: `m${i}`, nature: "vulnerability", tags: ["data lineage"] }), products),
    );
    const { digest } = partition(many);
    assert.ok(digest.some((d) => d.verdict === "act-now"));
  });

  it("reports nothing pushed down when nothing was", () => {
    const { pushedDown } = partition(exampleSignals(NOW).map((s) => classify(s, products)));
    assert.equal(pushedDown, 0);
  });
});

describe("the operator reads names, not ids", () => {
  it("never leaks a product id into a reason", () => {
    // "affecting g8" is the kind of leak that tells you a sentence was
    // assembled rather than written.
    for (const classified of exampleSignals(NOW).map((s) => classify(s, products))) {
      for (const product of products) {
        assert.ok(
          !classified.because.includes(` ${product.id}`),
          `leaked "${product.id}": ${classified.because}`,
        );
      }
    }
  });

  it("names the product in a forcing-nature reason", () => {
    const dep = classify(signal({ nature: "deprecation", tags: ["sandbox isolation"] }), products);
    assert.match(dep.because, /G8/);
  });
});

describe("the example signals", () => {
  it("cover every verdict, so the filter can be judged rather than trusted", () => {
    const verdicts = new Set(exampleSignals(NOW).map((s) => classify(s, products).verdict));
    for (const verdict of ["act-now", "evaluate-soon", "watch", "ignore-for-now"] as const) {
      assert.ok(verdicts.has(verdict), `nothing demonstrates "${verdict}"`);
    }
  });

  it("give a specific reason every time, never a generic one", () => {
    for (const classified of exampleSignals(NOW).map((s) => classify(s, products))) {
      assert.ok(classified.because.length > 30);
      assert.ok(!/may be relevant|could be useful/i.test(classified.because));
    }
  });
});
