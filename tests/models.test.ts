import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  NO_DOWNGRADE,
  callRole,
  candidatesFor,
  keyNameFor,
  parseJson,
  routeTurn,
  specFor,
  stackStatus,
} from "../lib/models";

/**
 * Routing decides how much a turn costs and how good the answer is. The
 * escalation rule in particular is a money-and-judgment decision, so it is
 * pinned here rather than left to inspection.
 */

describe("routeTurn", () => {
  it("sends a throwaway turn to the cheap model", () => {
    // The role is the contract; which provider serves it depends on which
    // keys are present, and is deliberately not pinned here.
    const route = routeTurn("what time is it");
    assert.equal(route.role, "quick");
  });

  it("escalates consequential judgment to Opus", () => {
    for (const utterance of [
      "should we raise our pricing next quarter?",
      "is it worth it to hire someone",
      "do we sign this contract",
    ]) {
      const route = routeTurn(utterance);
      assert.equal(route.role, "judgment", `"${utterance}" must escalate`);
      assert.equal(route.spec.provider, "anthropic");
      assert.match(route.reason, /Consequential/);
    }
  });

  it("escalation beats the reasoning tier, not the other way round", () => {
    // Contains both a HARD term ("strategy") and a CONSEQUENTIAL one
    // ("should we"). Being fast and wrong here is the expensive failure.
    const route = routeTurn("should we change the pricing strategy");
    assert.equal(route.role, "judgment");
  });

  it("routes reasoning-shaped turns to Pro", () => {
    const route = routeTurn("compare the two approaches for me");
    assert.equal(route.role, "hard");
  });

  it("treats a very long turn as needing reasoning", () => {
    const route = routeTurn("a".repeat(300));
    assert.equal(route.role, "hard");
    assert.match(route.reason, /Long/);
  });

  it("an attachment always wins — vision is the only role that can read it", () => {
    const route = routeTurn("should we sign this contract", true);
    assert.equal(route.role, "vision");
  });
});

describe("parseJson", () => {
  it("parses plain JSON", () => {
    assert.deepEqual(parseJson<string[]>('["a","b"]'), ["a", "b"]);
  });

  it("survives a fenced block, which models emit despite instructions", () => {
    assert.deepEqual(parseJson<string[]>('```json\n["a"]\n```'), ["a"]);
  });

  it("recovers an object buried in prose", () => {
    assert.deepEqual(
      parseJson<{ a: number }>('Sure! Here you go: {"a": 1} — hope that helps'),
      { a: 1 },
    );
  });

  it("returns null rather than throwing on junk", () => {
    assert.equal(parseJson("not json at all"), null);
  });
});

describe("provider preference", () => {
  const withKeys = (keys: Record<string, string | undefined>, fn: () => void) => {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(keys)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  const NO_KEYS = {
    GROQ_API_KEY: undefined,
    GOOGLE_API_KEY: undefined,
    ANTHROPIC_API_KEY: undefined,
  };

  it("prefers Groq for the latency-bound role", () => {
    // A voice turn half a second late is a worse answer than a duller one
    // that arrives immediately.
    withKeys({ ...NO_KEYS, GROQ_API_KEY: "x", GOOGLE_API_KEY: "y" }, () => {
      assert.equal(specFor("quick")?.provider, "groq");
    });
  });

  it("falls back to Google for quick when Groq is absent", () => {
    withKeys({ ...NO_KEYS, GOOGLE_API_KEY: "y" }, () => {
      assert.equal(specFor("quick")?.provider, "google");
    });
  });

  it("does not prefer Groq for reasoning", () => {
    withKeys({ ...NO_KEYS, GROQ_API_KEY: "x", GOOGLE_API_KEY: "y" }, () => {
      assert.equal(specFor("hard")?.provider, "google");
    });
  });

  it("still serves reasoning from Groq when it is the only key", () => {
    withKeys({ ...NO_KEYS, GROQ_API_KEY: "x" }, () => {
      assert.equal(specFor("hard")?.provider, "groq");
    });
  });
});

describe("consequential judgment never downgrades", () => {
  const withKeys = (keys: Record<string, string | undefined>, fn: () => void | Promise<void>) => {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(keys)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const restore = () => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    };
    const out = fn();
    if (out instanceof Promise) return out.finally(restore);
    restore();
    return undefined;
  };

  const ONLY_FAST = {
    GROQ_API_KEY: "x",
    GOOGLE_API_KEY: "y",
    ANTHROPIC_API_KEY: undefined,
  };

  it("has exactly one candidate, so there is nothing to fall back to", () => {
    assert.equal(candidatesFor("judgment").length, 1);
  });

  it("resolves to nothing rather than to the fast tier", () => {
    // The failure this prevents is invisible: the answer still arrives, still
    // fluent, just from a model that should not have been asked.
    withKeys(ONLY_FAST, () => {
      assert.equal(specFor("judgment"), null);
      assert.notEqual(specFor("quick"), null);
    });
  });

  it("refuses the call and says why, rather than answering from elsewhere", async () => {
    await withKeys(ONLY_FAST, async () => {
      const result = await callRole("judgment", {
        system: "",
        messages: [{ role: "user", content: "should we raise pricing" }],
      });
      assert.equal(result.live, false);
      assert.match(result.error ?? "", /ANTHROPIC_API_KEY/);
      assert.match(result.error ?? "", /worse than none/);
      assert.equal(result.text, "");
    });
  });

  it("marks the protected role in the status readout", () => {
    withKeys(ONLY_FAST, () => {
      const judgment = stackStatus().find((s) => s.role === "judgment");
      assert.ok(judgment);
      assert.equal(judgment.protected, true);
      assert.equal(judgment.ready, false);
      // And the rest of the stack is unaffected — one missing key must not
      // present as a dead stack.
      assert.ok(stackStatus().some((s) => s.ready));
    });
  });

  it("names the key you would need to add", () => {
    assert.equal(keyNameFor("groq"), "GROQ_API_KEY");
    assert.equal(keyNameFor("anthropic"), "ANTHROPIC_API_KEY");
    assert.equal(keyNameFor("google"), "GOOGLE_API_KEY");
  });

  it("protects judgment and nothing it should not", () => {
    assert.deepEqual(NO_DOWNGRADE, ["judgment"]);
  });
});
