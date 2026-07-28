import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ACTIONS,
  CORPUS,
  DEFAULT_SIGNALS,
  DEFAULT_WEIGHTS,
  combinedScore,
  predictActions,
  rankFeed,
  retrievalScore,
} from "../lib/phoenix";

/**
 * The Phoenix reconstruction makes claims about X's published algorithm, so
 * the parts taken from the source — the 19 heads and the combine formula's
 * negative branch — are pinned. If a refactor breaks these, the teardown
 * becomes wrong rather than merely different.
 */

describe("the 19 heads", () => {
  it("has exactly the published count and split", () => {
    assert.equal(ACTIONS.length, 19);
    assert.equal(ACTIONS.filter((a) => a.polarity === -1).length, 4);
    assert.equal(ACTIONS.filter((a) => a.polarity === 1).length, 15);
  });

  it("carries the real xAI constant names", () => {
    const names = new Set(ACTIONS.map((a) => a.weightName));
    for (const expected of [
      "FAVORITE_WEIGHT",
      "REPLY_WEIGHT",
      "RETWEET_WEIGHT",
      "VQV_WEIGHT",
      "CONT_DWELL_TIME_WEIGHT",
      "NOT_INTERESTED_WEIGHT",
      "REPORT_WEIGHT",
    ]) {
      assert.ok(names.has(expected), `missing ${expected}`);
    }
  });

  it("has no head for whether the post is true — the whole point", () => {
    const suspicious = ACTIONS.filter((a) =>
      /vera|true|truth|accura|fact/i.test(`${a.key} ${a.label}`),
    );
    assert.deepEqual(suspicious, []);
  });
});

describe("predictActions", () => {
  it("never reads veracity — it is displayed but feeds nothing", () => {
    const post = CORPUS[0];
    const honest = predictActions(DEFAULT_SIGNALS, { ...post, veracity: 1 });
    const dishonest = predictActions(DEFAULT_SIGNALS, { ...post, veracity: 0 });
    assert.deepEqual(honest, dishonest);
  });

  it("returns probabilities, not unbounded scores", () => {
    for (const post of CORPUS) {
      const predictions = predictActions(DEFAULT_SIGNALS, post);
      for (const action of ACTIONS) {
        const p = predictions[action.key];
        assert.ok(p >= 0 && p <= 1, `${action.key} out of range: ${p}`);
      }
    }
  });

  it("gives no video credit to a post with no video", () => {
    const noVideo = CORPUS.find((p) => p.videoDurationMs === 0)!;
    assert.equal(predictActions(DEFAULT_SIGNALS, noVideo).vqv, 0);
  });

  it("outrage drives reply harder than it drives report", () => {
    // This asymmetry is the mechanism the whole teardown is about: the brakes
    // are weaker than the accelerator.
    const bait = CORPUS.find((p) => p.outrage > 0.9)!;
    const predictions = predictActions(DEFAULT_SIGNALS, bait);
    assert.ok(
      predictions.reply > predictions.report,
      `reply ${predictions.reply} should exceed report ${predictions.report}`,
    );
  });
});

describe("combinedScore", () => {
  it("adds the offset on the positive branch", () => {
    const preds = Object.fromEntries(ACTIONS.map((a) => [a.key, 0]));
    preds.favorite = 1;
    const weights = { ...DEFAULT_WEIGHTS };
    assert.equal(combinedScore(preds, weights), weights.favorite + 1);
  });

  it("squashes a negative into a small positive band, per the published branch", () => {
    const preds = Object.fromEntries(ACTIONS.map((a) => [a.key, 0]));
    preds.report = 1; // maximally reported
    const score = combinedScore(preds, DEFAULT_WEIGHTS);
    assert.ok(score >= 0, `negatives must not run away: ${score}`);
    assert.ok(score < 1, `a reported post must rank below a neutral one: ${score}`);
  });

  it("clamps to zero when every weight is zero", () => {
    const preds = Object.fromEntries(ACTIONS.map((a) => [a.key, 1]));
    const zeroed = Object.fromEntries(ACTIONS.map((a) => [a.key, 0]));
    assert.equal(combinedScore(preds, zeroed), 0);
  });
});

describe("rankFeed", () => {
  it("returns every candidate, ordered by final score", () => {
    const ranked = rankFeed(DEFAULT_SIGNALS, DEFAULT_WEIGHTS);
    assert.equal(ranked.length, CORPUS.length);
    for (let i = 1; i < ranked.length; i += 1) {
      assert.ok(ranked[i - 1].finalScore >= ranked[i].finalScore);
    }
  });

  it("decays a repeated author so one account cannot stack the feed", () => {
    // The seeded corpus has unique handles, so the decay needs an explicit
    // case — otherwise the mechanic is untested dead code.
    const twin = { ...CORPUS[0], id: "twin" };
    const ranked = rankFeed(DEFAULT_SIGNALS, DEFAULT_WEIGHTS, [CORPUS[0], twin]);
    const [first, second] = ranked;
    assert.equal(first.post.handle, second.post.handle);
    assert.ok(
      second.finalScore < first.finalScore,
      "the second post from one author must be penalised",
    );
    assert.ok(Math.abs(second.finalScore - second.score * 0.6) < 1e-9);
  });

  it("moves with the signals — the sliders are not decorative", () => {
    const calm = rankFeed({ ...DEFAULT_SIGNALS, sentiment: 0 }, DEFAULT_WEIGHTS);
    const heated = rankFeed({ ...DEFAULT_SIGNALS, sentiment: 1 }, DEFAULT_WEIGHTS);
    const outrageOf = (r: ReturnType<typeof rankFeed>) =>
      r.slice(0, 4).reduce((sum, x) => sum + x.post.outrage, 0) / 4;
    assert.ok(
      outrageOf(heated) > outrageOf(calm),
      "raising sentiment must surface more outrage",
    );
  });
});

describe("retrievalScore", () => {
  it("is a cosine, so it stays within [-1, 1]", () => {
    for (const post of CORPUS) {
      const score = retrievalScore(DEFAULT_SIGNALS, post);
      assert.ok(score >= -1 && score <= 1, `out of range: ${score}`);
    }
  });
});
