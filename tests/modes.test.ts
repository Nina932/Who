import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildBrief } from "../lib/brief";
import { exampleCases, project } from "../lib/cases";
import { MODES, MODES_BY_ID, contextFor, systemPromptFor, unphrasedAnswer, type TruthInput } from "../lib/modes";
import { exampleKnowledge, exampleProducts, view } from "../lib/products";
import { classify, exampleSignals, partition } from "../lib/signals";

/**
 * The claim modes make is that they cannot disagree, because they are
 * selections over one derived state rather than six sources of truth. These
 * pin that: no mode invents anything, each is handed a genuinely different
 * slice, and none of them is handed everything.
 */

const NOW = 1_800_000_000_000;

const entries = exampleKnowledge(NOW);
const products = exampleProducts(NOW).map((p) => view(p, entries, NOW));
const cases = exampleCases(NOW).map((r) => project(r, NOW));
const classified = exampleSignals(NOW).map((s) => classify(s, products));
const { alerts, digest } = partition(classified);

const brief = buildBrief({
  now: NOW,
  operator: "Nino",
  localHour: 9,
  cases,
  products: exampleProducts(NOW),
  entries,
  capacity: { plannedHours: 6, bookedHours: null },
  history: [],
});

const truth: TruthInput = { brief, products, entries, alerts, digest, now: NOW };

describe("the modes", () => {
  it("each answer a distinct question and state what they refuse", () => {
    const questions = new Set(MODES.map((m) => m.question));
    assert.equal(questions.size, MODES.length, "two modes answer the same question");
    for (const mode of MODES) {
      assert.ok(mode.refuses.length > 20, `${mode.id} refuses nothing`);
    }
  });

  it("every mode gets a non-empty slice of the state", () => {
    for (const mode of MODES) {
      assert.ok(contextFor(mode.id, truth).length > 50, `${mode.id} was handed nothing`);
    }
  });

  it("no two modes are handed the same slice", () => {
    // If two contexts are identical the modes are decorative.
    const contexts = MODES.map((m) => contextFor(m.id, truth));
    assert.equal(new Set(contexts).size, contexts.length);
  });
});

describe("what each mode is and is not shown", () => {
  it("the Daily Operator is not shown product phases or the market", () => {
    // Otherwise it starts opining on positioning, and the operator can no
    // longer predict what any given mode will say.
    const context = contextFor("daily-operator", truth);
    assert.ok(context.includes("CAPACITY"));
    assert.ok(context.includes("TODAY"));
    assert.ok(!context.includes("execution-hardening"));
    assert.ok(!context.includes("[watch]"));
  });

  it("the Chief of Staff sees products and blockers but not the day's ordering", () => {
    const context = contextFor("chief-of-staff", truth);
    assert.ok(context.includes("PRODUCTS"));
    assert.ok(/blocks release/.test(context));
    assert.ok(!context.includes("CAPACITY"));
  });

  it("Technical Intelligence sees the constraints alongside the signals", () => {
    // Relevance is meaningless without knowing what is currently blocking.
    const context = contextFor("technical-intelligence", truth);
    assert.ok(context.includes("CONSTRAINTS"));
    assert.ok(context.includes("act-now") || context.includes("NOTHING WORTH INTERRUPTING"));
  });

  it("Market Intelligence is handed hypotheses, labelled as hypotheses", () => {
    const context = contextFor("market-intelligence", truth);
    assert.ok(context.includes("HYPOTHESES"));
  });

  it("the Weekly Review sees what fired and what was avoided, not today's list", () => {
    const context = contextFor("weekly-review", truth);
    assert.ok(context.includes("RULES THAT FIRED") || context.includes("NO RULES FIRED"));
    assert.ok(!context.includes("CAPACITY"));
  });

  it("the Strategic Advisor is the only one shown everything", () => {
    const context = contextFor("strategic-advisor", truth);
    assert.ok(context.includes("PRODUCTS"));
    assert.ok(context.includes("HYPOTHESES"));
    assert.ok(context.includes("PREFERENCES"));
  });
});

describe("the prompts", () => {
  it("every mode inherits the rule that a hypothesis is not a fact", () => {
    // The store enforces this; one fluent paragraph could undo it.
    for (const mode of MODES) {
      const prompt = systemPromptFor(mode.id);
      assert.match(prompt, /A hypothesis is not a fact/);
      assert.match(prompt, /Never state anything not derivable/);
      assert.match(prompt, /Never invent/);
    }
  });

  it("gives each mode its own instruction, not a shared one", () => {
    const prompts = MODES.map((m) => systemPromptFor(m.id));
    assert.equal(new Set(prompts).size, prompts.length);
  });

  it("makes the Strategic Advisor carry a falsifier", () => {
    assert.match(systemPromptFor("strategic-advisor"), /what would change your mind/);
  });

  it("stops the Weekly Review congratulating activity", () => {
    assert.match(systemPromptFor("weekly-review"), /Activity is not movement/);
  });
});

describe("with no model configured", () => {
  it("returns the state itself rather than an error or a guess", () => {
    const context = contextFor("daily-operator", truth);
    const answer = unphrasedAnswer("daily-operator", context, "No GOOGLE_API_KEY configured");
    assert.match(answer, /No model is configured/);
    assert.match(answer, /No GOOGLE_API_KEY configured/);
    // Degrades to less fluent, never to made up: the whole context survives.
    assert.ok(answer.includes(context));
  });

  it("names the mode, so it is clear which slice is being shown", () => {
    const answer = unphrasedAnswer("strategic-advisor", "x", "no key");
    assert.match(answer, new RegExp(MODES_BY_ID["strategic-advisor"].name));
  });
});

describe("no mode context invents anything", () => {
  it("mentions only products that exist", () => {
    for (const mode of MODES) {
      const context = contextFor(mode.id, truth);
      const named = context.match(/^(\w[\w ]*) — (exploration|build|execution-hardening|pre-release-productization|commercial-validation|scaling)/gm) ?? [];
      for (const line of named) {
        const name = line.split(" — ")[0];
        assert.ok(products.some((p) => p.name === name), `invented a product: ${name}`);
      }
    }
  });

  it("carries entry ids, so any claim can be traced back", () => {
    const context = contextFor("strategic-advisor", truth);
    const ids = context.match(/\[(k-[a-z0-9-]+)\]/g) ?? [];
    assert.ok(ids.length > 0, "nothing is citable");
    for (const wrapped of ids) {
      const id = wrapped.slice(1, -1);
      assert.ok(entries.some((e) => e.id === id), `cited a missing entry: ${id}`);
    }
  });
});
