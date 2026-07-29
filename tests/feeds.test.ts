import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  configuredSources,
  deriveTags,
  detectNature,
  merge,
  parseFeed,
  poll,
  vocabularyOf,
} from "../lib/feeds";
import { exampleKnowledge, exampleProducts, view } from "../lib/products";
import { classify, type Signal } from "../lib/signals";

/**
 * The feed's job is to throw almost everything away. So these test the
 * discarding: that a generic word cannot drag in every article ever written,
 * that a dead source is named rather than swallowed, and that re-polling
 * cannot duplicate what is already stored.
 */

const NOW = 1_800_000_000_000;
const entries = exampleKnowledge(NOW);
const products = exampleProducts(NOW).map((p) => view(p, entries, NOW));

describe("parseFeed", () => {
  it("reads RSS", () => {
    const items = parseFeed(
      `<rss><channel>
        <item>
          <title>PostgreSQL 19 released</title>
          <description>Adds partitioned logical replication.</description>
          <link>https://example.com/pg19</link>
          <pubDate>Tue, 01 Jul 2025 10:00:00 GMT</pubDate>
        </item>
      </channel></rss>`,
      NOW,
    );
    assert.equal(items.length, 1);
    assert.equal(items[0].title, "PostgreSQL 19 released");
    assert.equal(items[0].link, "https://example.com/pg19");
    assert.equal(items[0].at, Date.parse("Tue, 01 Jul 2025 10:00:00 GMT"));
  });

  it("reads Atom, where the link is an attribute", () => {
    const items = parseFeed(
      `<feed>
        <entry>
          <title>Sandbox API deprecated</title>
          <summary>Six month window.</summary>
          <link rel="alternate" href="https://example.com/dep"/>
          <updated>2025-07-01T10:00:00Z</updated>
        </entry>
      </feed>`,
      NOW,
    );
    assert.equal(items[0].link, "https://example.com/dep");
    assert.equal(items[0].title, "Sandbox API deprecated");
  });

  it("unwraps CDATA and strips markup", () => {
    const items = parseFeed(
      `<rss><item><title><![CDATA[Bold <b>news</b> & more]]></title><link>x</link></item></rss>`,
      NOW,
    );
    assert.equal(items[0].title, "Bold news & more");
  });

  it("never lets markup through into the text", () => {
    // Tags are stripped before entities are decoded, so an escaped tag in a
    // feed cannot be decoded back into live markup on the way through.
    const items = parseFeed(
      `<rss><item><title>a &lt;script&gt;alert(1)&lt;/script&gt; b</title><link>x</link></item></rss>`,
      NOW,
    );
    assert.ok(!/<script>/.test(items[0].title));
  });

  it("falls back to the poll time when a feed gives no date", () => {
    const items = parseFeed(`<rss><item><title>Undated</title><link>x</link></item></rss>`, NOW);
    assert.equal(items[0].at, NOW);
  });

  it("returns nothing for a page that is not a feed", () => {
    assert.deepEqual(parseFeed("<html><body>not a feed</body></html>", NOW), []);
  });
});

describe("vocabulary", () => {
  it("is drawn from the products themselves, not from a fixed list", () => {
    const vocab = vocabularyOf(products);
    assert.ok(vocab.includes("Production worker deployment"));
    assert.ok(vocab.some((t) => /postgresql/i.test(t)));
  });

  it("drops words too generic to mean anything", () => {
    // "data" appears in FinAI's "Data lineage" and would otherwise match
    // roughly every technology article ever published.
    const lower = vocabularyOf(products).map((t) => t.toLowerCase());
    for (const generic of ["data", "core", "tools", "engine", "production"]) {
      assert.ok(!lower.includes(generic), `"${generic}" survived the stoplist`);
    }
  });

  it("ignores products that are not active", () => {
    const paused = exampleProducts(NOW).map((p) => view({ ...p, phase: "paused" }, entries, NOW));
    assert.deepEqual(vocabularyOf(paused), []);
  });
});

describe("deriveTags", () => {
  it("matches an article on the operator's own words, with no model", () => {
    const tags = deriveTags(
      "PostgreSQL adds native append-only partitioned logs for event stores",
      products,
    );
    assert.ok(tags.length > 0);
  });

  it("returns nothing for an article about something else entirely", () => {
    assert.deepEqual(deriveTags("A new pasta recipe from Bologna", products), []);
  });

  it("feeds straight into the classifier without a model in between", () => {
    // The end-to-end claim: relevance with no API key at all.
    const text = "Container runtime deprecates the Sandbox isolation API";
    const signal: Signal = {
      id: "s",
      headline: text,
      summary: "",
      nature: detectNature(text),
      tags: deriveTags(text, products),
      source: "test",
      at: NOW,
    };
    assert.equal(classify(signal, products).verdict, "act-now");
  });
});

describe("detectNature", () => {
  it("spots a deprecation", () => {
    assert.equal(detectNature("This API is deprecated and will be removed"), "deprecation");
  });

  it("spots a vulnerability, and ranks it above a deprecation", () => {
    // A security advisory about a deprecated API is a vulnerability first —
    // that is the one with a clock on it.
    assert.equal(
      detectNature("CVE-2025-1234 in the deprecated auth endpoint"),
      "vulnerability",
    );
  });

  it("spots a pricing change", () => {
    assert.equal(detectNature("Pricing update for compute instances"), "pricing");
  });

  it("falls back to what the source usually publishes", () => {
    assert.equal(detectNature("Something happened", "capability"), "capability");
  });
});

describe("poll", () => {
  it("names a dead source rather than pretending the week was quiet", async () => {
    const { results, signals } = await poll(products, NOW, [
      { id: "dead", name: "Dead feed", url: "https://127.0.0.1:9/nothing.xml" },
    ]);
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, false);
    assert.ok(results[0].error);
    assert.deepEqual(signals, []);
  });

  it("keeps one dead source from sinking the others", async () => {
    const { results } = await poll(products, NOW, [
      { id: "dead", name: "Dead", url: "https://127.0.0.1:9/a.xml" },
      { id: "dead2", name: "Also dead", url: "https://127.0.0.1:9/b.xml" },
    ]);
    assert.equal(results.length, 2);
    assert.ok(results.every((r) => !r.ok));
  });
});

describe("merge", () => {
  const signal = (id: string, at: number): Signal => ({
    id,
    headline: id,
    summary: "",
    nature: "capability",
    tags: [],
    source: "test",
    at,
  });

  it("does not duplicate what is already stored", () => {
    const existing = [signal("a", NOW)];
    assert.equal(merge(existing, [signal("a", NOW)]).length, 1);
  });

  it("puts the newest first", () => {
    const merged = merge([signal("old", NOW - 1000)], [signal("new", NOW)]);
    assert.equal(merged[0].id, "new");
  });

  it("caps the store so a feed cannot grow without bound", () => {
    const many = Array.from({ length: 500 }, (_, i) => signal(`s${i}`, NOW - i));
    assert.equal(merge([], many, 200).length, 200);
  });
});

describe("configuredSources", () => {
  it("ships defaults so it works before anything is configured", () => {
    assert.ok(configuredSources().length > 0);
    assert.ok(configuredSources().every((s) => /^https?:\/\//.test(s.url)));
  });
});
