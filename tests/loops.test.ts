import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * The Loops Engine's safety properties.
 *
 * These run with no API keys on purpose. A step that cannot reach a model must
 * fail loudly rather than silently producing nothing, and — the property that
 * matters most — a human's rejection must be impossible to walk back.
 */

let tmp: string;
let loops: typeof import("../lib/loops");

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "thor-loops-"));
  process.env.THOR_DATA_DIR = tmp;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GEMINI_API_KEY;
  // Imported after the env is set so the store picks up the temp directory.
  loops = await import("../lib/loops");
});

after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("loop definitions", () => {
  it("every loop has exactly one human gate", () => {
    for (const loop of loops.LOOPS) {
      const gates = loop.steps.filter((s) => s.kind === "gate");
      assert.equal(gates.length, 1, `${loop.id} should have one gate`);
    }
  });

  it("no loop can act before its gate", () => {
    // An `act` step ahead of the gate would publish without approval.
    for (const loop of loops.LOOPS) {
      const gateAt = loop.steps.findIndex((s) => s.kind === "gate");
      const actBeforeGate = loop.steps.findIndex(
        (s, i) => s.kind === "act" && i < gateAt,
      );
      assert.equal(actBeforeGate, -1, `${loop.id} acts before its gate`);
    }
  });
});

describe("execution without a reachable model", () => {
  it("fails with the reason instead of inventing an artefact", async () => {
    const run = await loops.startRun("content-engine");
    assert.equal(run.status, "failed");
    assert.match(run.error ?? "", /GOOGLE_API_KEY/);
    assert.equal(run.artifacts.length, 0, "must not fabricate output");
  });
});

describe("the gate is load-bearing", () => {
  it("rejection is terminal — advance cannot resurrect it", async () => {
    // Regression: `advance()` had no status guard, so this call walked a
    // rejected run back to `awaiting-go` and undid the operator's decision.
    const run = await loops.startRun("content-engine");
    await loops.reject(run.id, "not good enough");

    const rejected = await loops.getRun(run.id);
    assert.equal(rejected?.status, "rejected");

    const after = await loops.advance(run.id);
    assert.equal(after.status, "rejected", "a human's no must stick");
  });

  it("approving a run that is not at a gate changes nothing", async () => {
    const run = await loops.startRun("content-engine");
    const result = await loops.approve(run.id, "GO");
    assert.equal(result.status, run.status);
  });

  it("rejection without a reason is refused by the engine's contract", async () => {
    // The reason is the training signal; a bare "no" teaches the loop nothing.
    const run = await loops.startRun("content-engine");
    const before = (await loops.allLearnings("content-engine")).length;
    await loops.reject(run.id, "   ");
    const after = (await loops.allLearnings("content-engine")).length;
    assert.equal(after, before, "an empty note must not produce a learning");
  });
});

describe("run history", () => {
  it("persists across a fresh read of the store", async () => {
    const run = await loops.startRun("weekly-business-review");
    const found = (await loops.allRuns()).find((r) => r.id === run.id);
    assert.ok(found, "run should be readable back from disk");
    assert.equal(found?.loopId, "weekly-business-review");
  });
});
