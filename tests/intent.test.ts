import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ANSWERS, capabilitiesMentioned, classify, renderForPrompt } from "../lib/intent";
import { deliveryFor } from "../lib/voice";

/**
 * The classifier decides whether a sentence is answered from the model, from
 * the ledger, or not answered at all until someone approves something. Getting
 * the order wrong is how an assistant answers helpfully *and* sends the email.
 */

describe("ordinary questions", () => {
  it("answers general knowledge from the model", () => {
    const result = classify("what is the capital of Peru");
    assert.equal(result.answer, "direct");
    assert.equal(result.risk, "none");
    assert.equal(result.role, "quick");
  });

  it("uses the reasoning tier for a long, involved question", () => {
    const long = `Explain the difference between optimistic and pessimistic concurrency control, ${"and when each one is appropriate ".repeat(8)}`;
    assert.equal(classify(long).role, "hard");
  });

  it("flags a question whose answer changes", () => {
    for (const q of ["what is the latest version", "what happened at the summit"]) {
      assert.equal(classify(q).answer, "current", q);
    }
  });
});

describe("questions about this business", () => {
  it("routes to the ledger rather than to recall", () => {
    const result = classify("what state is FinAI in");
    assert.equal(result.answer, "business");
    assert.match(ANSWERS[result.answer].rule, /Never from recall/);
  });

  it("catches the ones phrased casually", () => {
    for (const q of ["is that invoice still overdue", "who am I waiting on"]) {
      assert.equal(classify(q).answer, "business", q);
    }
  });
});

describe("questions about code", () => {
  it("insists on inspecting before answering", () => {
    const result = classify("why is the build failing");
    assert.equal(result.answer, "code");
    assert.match(result.because, /remembered codebase/);
  });

  it("beats the business classifier — code questions are not state questions", () => {
    // "the test" is code even in a sentence that also mentions a client.
    assert.equal(classify("the test for the client importer is failing").answer, "code");
  });
});

describe("requests to act", () => {
  it("is checked before anything else", () => {
    // "Send the invoice to Halden" is a request to act that happens to be
    // phrased as a sentence about the business. If the business branch wins,
    // the assistant answers helpfully and also sends the invoice.
    const result = classify("send the invoice to Halden & Co");
    assert.equal(result.answer, "action");
  });

  it("takes its risk from what it reaches for, not from its tone", () => {
    const polite = classify("could you just deploy that to production for me");
    assert.equal(polite.answer, "action");
    assert.equal(polite.risk, "high");
    assert.equal(polite.role, "judgment");
  });

  it("keeps a reversible action off the judgment tier", () => {
    const result = classify("create a branch for the fix");
    assert.equal(result.answer, "action");
    assert.notEqual(result.risk, "high");
  });

  it("names the phrase that decided it", () => {
    assert.match(classify("delete the old records").because, /delete/);
  });
});

describe("decisions", () => {
  it("escalates a decision even when it is phrased as a question", () => {
    for (const q of ["should we raise prices", "is it worth it to hire someone"]) {
      const result = classify(q);
      assert.equal(result.answer, "consequential", q);
      assert.equal(result.role, "judgment", q);
    }
  });
});

describe("capabilitiesMentioned", () => {
  it("proposes without granting", () => {
    const hits = capabilitiesMentioned("send an email to the client");
    assert.ok(hits.some((c) => c.id === "mail.send"));
    // A proposal carries the level so the caller can see what it would need.
    assert.ok(hits.every((c) => c.level >= 1 && c.level <= 4));
  });

  it("finds nothing in an ordinary question", () => {
    assert.deepEqual(capabilitiesMentioned("what is the capital of Peru"), []);
  });
});

describe("what the model is told", () => {
  it("states the rule for the classification it was given", () => {
    const rendered = renderForPrompt(classify("what state is G8 in"));
    assert.match(rendered, /Retrieve from state/);
  });

  it("lists the consequence of anything it would need authority for", () => {
    const rendered = renderForPrompt(classify("send the invoice"));
    assert.match(rendered, /level 4/);
    assert.match(rendered, /Do not claim to have done it/);
  });
});

describe("voice delivery", () => {
  it("tightens on risk rather than getting louder", () => {
    const calm = deliveryFor("none");
    const urgent = deliveryFor("high");
    assert.ok(urgent.rate > calm.rate, "a risky sentence is delivered tighter");
    assert.ok(urgent.beatMs > calm.beatMs, "and lands after a longer pause");
  });

  it("never becomes hurried, whatever the risk", () => {
    for (const risk of ["none", "low", "medium", "high"] as const) {
      const delivery = deliveryFor(risk);
      assert.ok(delivery.rate <= 1, "rate stays within the deliberate register");
      assert.ok(delivery.pitch <= 2 && delivery.pitch >= 0);
    }
  });
});
