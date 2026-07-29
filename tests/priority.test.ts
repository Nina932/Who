import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_CONTEXT,
  DEFAULT_WEIGHTS,
  FACTORS,
  SAMPLE_CANDIDATES,
  candidatesFromRuns,
  effectiveWeights,
  rankWeek,
  scoreCandidate,
  verdict,
} from "../lib/priority";

/**
 * The attention engine decides what a week is spent on, so its failure modes
 * are expensive and quiet. These pin the properties that make its output
 * trustworthy: that busywork loses, that the hours budget is real, and that
 * the readout tells the truth about what was chosen.
 */

const find = (id: string) => SAMPLE_CANDIDATES.find((c) => c.id === id)!;

describe("factors", () => {
  it("keeps a cost side, so nothing can score by being big alone", () => {
    assert.ok(FACTORS.some((f) => f.polarity === -1));
    assert.ok(FACTORS.filter((f) => f.polarity === -1).every((f) => f.weight < 0));
  });

  it("has a factor for compounding — the one most weeks quietly lack", () => {
    assert.ok(FACTORS.some((f) => f.key === "leverage" && f.group === "compounding"));
  });
});

describe("scoreCandidate", () => {
  it("ranks an overdue invoice above clearing the inbox", () => {
    const invoice = scoreCandidate(find("c-invoice"), DEFAULT_WEIGHTS, DEFAULT_CONTEXT);
    const inbox = scoreCandidate(find("c-inbox"), DEFAULT_WEIGHTS, DEFAULT_CONTEXT);
    assert.ok(invoice.score > inbox.score, `${invoice.score} should beat ${inbox.score}`);
  });

  it("pushes urgency theatre below zero", () => {
    // Work that feels urgent and changes nothing should not merely rank low —
    // it should be actively negative, or it creeps back in on a quiet week.
    const noise = scoreCandidate(find("c-rebrand"), DEFAULT_WEIGHTS, DEFAULT_CONTEXT);
    assert.ok(noise.score < 0, `expected a negative score, got ${noise.score}`);
  });

  it("explains itself — every contribution is attributable to a factor", () => {
    const scored = scoreCandidate(find("c-proposal"), DEFAULT_WEIGHTS, DEFAULT_CONTEXT);
    assert.equal(scored.contributions.length, FACTORS.length);
    const summed = scored.contributions.reduce((s, c) => s + c.value, 0);
    assert.ok(Math.abs(summed - scored.score) < 1e-9);
  });

  it("uses density, not score, so a long job cannot look cheap", () => {
    const scored = scoreCandidate(find("c-delivery"), DEFAULT_WEIGHTS, DEFAULT_CONTEXT);
    assert.ok(Math.abs(scored.density - scored.score / scored.candidate.hours) < 1e-9);
  });
});

describe("effectiveWeights", () => {
  it("raises revenue as runway tightens", () => {
    const calm = effectiveWeights(DEFAULT_WEIGHTS, { ...DEFAULT_CONTEXT, runwayPressure: 0 });
    const tight = effectiveWeights(DEFAULT_WEIGHTS, { ...DEFAULT_CONTEXT, runwayPressure: 1 });
    assert.ok(tight.revenue > calm.revenue);
  });

  it("makes compounding work less affordable under pressure", () => {
    // Not a moral judgement — it is what being short of money means.
    const calm = effectiveWeights(DEFAULT_WEIGHTS, { ...DEFAULT_CONTEXT, runwayPressure: 0 });
    const tight = effectiveWeights(DEFAULT_WEIGHTS, { ...DEFAULT_CONTEXT, runwayPressure: 1 });
    assert.ok(tight.leverage < calm.leverage);
  });
});

describe("rankWeek", () => {
  it("never commits more hours than the operator has", () => {
    for (const capacityHours of [4, 12, 24, 60]) {
      const context = { ...DEFAULT_CONTEXT, capacityHours };
      const ranked = rankWeek(SAMPLE_CANDIDATES, DEFAULT_WEIGHTS, context);
      const committed = ranked
        .filter((r) => r.chosen)
        .reduce((sum, r) => sum + r.candidate.hours, 0);
      assert.ok(
        committed <= capacityHours,
        `committed ${committed}h against ${capacityHours}h`,
      );
    }
  });

  it("never selects negative-scoring work, however much room is left", () => {
    const ranked = rankWeek(SAMPLE_CANDIDATES, DEFAULT_WEIGHTS, {
      ...DEFAULT_CONTEXT,
      capacityHours: 500,
    });
    assert.ok(ranked.filter((r) => r.chosen).every((r) => r.score > 0));
  });

  it("returns every candidate, chosen or not, so nothing vanishes silently", () => {
    const ranked = rankWeek(SAMPLE_CANDIDATES, DEFAULT_WEIGHTS, DEFAULT_CONTEXT);
    assert.equal(ranked.length, SAMPLE_CANDIDATES.length);
  });

  it("orders by density throughout", () => {
    const ranked = rankWeek(SAMPLE_CANDIDATES, DEFAULT_WEIGHTS, DEFAULT_CONTEXT);
    for (let i = 1; i < ranked.length; i += 1) {
      assert.ok(ranked[i - 1].density >= ranked[i].density);
    }
  });

  it("responds to the weights — the dials are not decorative", () => {
    // Score, not rank. Raising the compounding weight lifts every compounding
    // candidate, and because selection normalises by hours, a cheap one can
    // rise faster than an expensive one — so relative rank is not guaranteed
    // to move even though the model responded correctly.
    const scoreOf = (weights: typeof DEFAULT_WEIGHTS) =>
      scoreCandidate(find("c-onboarding"), weights, DEFAULT_CONTEXT).score;

    assert.ok(scoreOf({ ...DEFAULT_WEIGHTS, leverage: 12 }) > scoreOf(DEFAULT_WEIGHTS));
  });

  it("weighting compounding changes what the week is made of", () => {
    // The property that actually matters: the mix of the *chosen* week shifts.
    const mixOf = (weights: typeof DEFAULT_WEIGHTS) => {
      const context = { ...DEFAULT_CONTEXT, capacityHours: 40 };
      return verdict(rankWeek(SAMPLE_CANDIDATES, weights, context), context).mix
        .compounding;
    };

    assert.ok(
      mixOf({ ...DEFAULT_WEIGHTS, leverage: 12 }) > mixOf(DEFAULT_WEIGHTS),
      "a heavier compounding weight should make the week compound more",
    );
  });

  it("a big budget does buy the compounding work a slot", () => {
    // The selection counterpart: given the hours, it gets in.
    const ranked = rankWeek(
      SAMPLE_CANDIDATES,
      { ...DEFAULT_WEIGHTS, leverage: 12 },
      { ...DEFAULT_CONTEXT, capacityHours: 40 },
    );
    const chosen = ranked.filter((r) => r.chosen).map((r) => r.candidate.id);
    assert.ok(chosen.includes("c-onboarding"));
  });
});

describe("verdict", () => {
  it("reports committed hours against capacity", () => {
    const ranked = rankWeek(SAMPLE_CANDIDATES, DEFAULT_WEIGHTS, DEFAULT_CONTEXT);
    const v = verdict(ranked, DEFAULT_CONTEXT);
    assert.equal(v.capacityHours, DEFAULT_CONTEXT.capacityHours);
    assert.ok(v.committedHours <= v.capacityHours);
  });

  it("mix is a distribution over the chosen week", () => {
    const ranked = rankWeek(SAMPLE_CANDIDATES, DEFAULT_WEIGHTS, DEFAULT_CONTEXT);
    const v = verdict(ranked, DEFAULT_CONTEXT);
    const total = v.mix.money + v.mix.time + v.mix.compounding + v.mix.cost;
    assert.ok(Math.abs(total - 1) < 1e-6, `mix summed to ${total}`);
  });

  it("calls out a week with no compounding in it", () => {
    // Zero out leverage and learning: the week becomes pure firefighting, and
    // the readout has to say so rather than congratulate the operator.
    const shortTermist = { ...DEFAULT_WEIGHTS, leverage: 0, learning: 0 };
    const ranked = rankWeek(SAMPLE_CANDIDATES, shortTermist, DEFAULT_CONTEXT);
    const v = verdict(ranked, DEFAULT_CONTEXT);
    assert.ok(v.mix.compounding < 0.15);
    assert.match(v.headline, /compounds|reactive/i);
  });

  it("says so plainly when nothing clears the bar", () => {
    const ranked = rankWeek(SAMPLE_CANDIDATES, DEFAULT_WEIGHTS, {
      ...DEFAULT_CONTEXT,
      capacityHours: 0,
    });
    assert.match(verdict(ranked, { ...DEFAULT_CONTEXT, capacityHours: 0 }).headline, /Nothing cleared/);
  });
});

describe("candidatesFromRuns", () => {
  it("turns a gated run into a cheap, decaying candidate", () => {
    const [candidate] = candidatesFromRuns(
      [{ id: "r1", loopId: "content-engine", status: "awaiting-go" }],
      { "content-engine": "Content Engine" },
    );
    assert.match(candidate.title, /Approve or reject/);
    assert.match(candidate.origin, /holding at its gate/);
    assert.ok(candidate.hours <= 0.5, "approving is minutes, not hours");
    assert.ok(candidate.factors.decay > 0.5, "an unapproved week decays fast");
  });

  it("ignores runs that are not waiting on anyone", () => {
    const candidates = candidatesFromRuns(
      [
        { id: "r1", loopId: "content-engine", status: "completed" },
        { id: "r2", loopId: "content-engine", status: "rejected" },
      ],
      {},
    );
    assert.deepEqual(candidates, []);
  });
});
