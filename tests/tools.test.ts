import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * Tool argument validation.
 *
 * This is the layer between a language model and the operator's real calendar
 * and mailbox. A hallucinated field has to become a validation error here, not
 * a bad calendar entry there — so the malformed cases matter more than the
 * happy path, which cannot run without a live connection anyway.
 */

let tmp: string;
let tools: typeof import("../lib/tools");
let loops: typeof import("../lib/loops");

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "thor-tools-"));
  process.env.THOR_DATA_DIR = tmp;
  delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  tools = await import("../lib/tools");
  loops = await import("../lib/loops");
});

after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("calendar.schedule", () => {
  it("refuses an empty proposal instead of calling out", async () => {
    const result = await tools.TOOLS["calendar.schedule"].run({});
    assert.equal(result.ok, false);
    assert.match(result.summary, /No events proposed/);
  });

  it("skips an event scheduled in the past", async () => {
    // An agent booking into last week is a bug that would otherwise ship
    // silently — a calendar entry nobody sees.
    const result = await tools.TOOLS["calendar.schedule"].run({
      events: [{ summary: "Old post", startsAt: "2020-01-01T09:00:00Z" }],
    });
    assert.equal(result.ok, false);
    assert.match(result.summary, /past start time/);
  });

  it("skips an event with no title", async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const result = await tools.TOOLS["calendar.schedule"].run({
      events: [{ startsAt: future }],
    });
    assert.match(result.summary, /Skipped/);
  });

  it("reports the connection problem rather than claiming success", async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const result = await tools.TOOLS["calendar.schedule"].run({
      events: [{ summary: "Launch post", startsAt: future }],
    });
    assert.equal(result.ok, false);
    assert.match(result.summary, /not configured|not connected/i);
  });
});

describe("gmail.draft", () => {
  it("requires all three fields", async () => {
    const result = await tools.TOOLS["gmail.draft"].run({ to: "a@b.com" });
    assert.equal(result.ok, false);
    assert.match(result.summary, /required/);
  });

  it("rejects a malformed address before calling out", async () => {
    const result = await tools.TOOLS["gmail.draft"].run({
      to: "not-an-address",
      subject: "Hi",
      body: "Hello",
    });
    assert.equal(result.ok, false);
    assert.match(result.summary, /not a valid address/);
  });
});

describe("slides.deck", () => {
  it("requires a title", async () => {
    const result = await tools.TOOLS["slides.deck"].run({ slides: [{ title: "One" }] });
    assert.equal(result.ok, false);
    assert.match(result.summary, /title is required/);
  });

  it("requires at least one usable slide", async () => {
    const result = await tools.TOOLS["slides.deck"].run({ title: "Deck", slides: [{}] });
    assert.equal(result.ok, false);
    assert.match(result.summary, /no usable slides/i);
  });
});

describe("tool wiring", () => {
  it("every tool step names a tool that exists", () => {
    for (const loop of loops.LOOPS) {
      for (const step of loop.steps) {
        if (step.kind !== "tool") continue;
        assert.ok(step.tool, `${loop.id}/${step.id} has no tool`);
        assert.ok(tools.TOOLS[step.tool], `${loop.id}/${step.id}: unknown tool ${step.tool}`);
      }
    }
  });

  it("no tool ever runs before its loop's human gate", () => {
    // The whole safety story: a side effect can only happen after a GO.
    for (const loop of loops.LOOPS) {
      const gateAt = loop.steps.findIndex((s) => s.kind === "gate");
      loop.steps.forEach((step, index) => {
        if (step.kind !== "tool") return;
        assert.ok(
          gateAt !== -1 && index > gateAt,
          `${loop.id}/${step.id} runs a tool before the gate`,
        );
      });
    }
  });

  it("does not publish to LinkedIn from any seeded loop", () => {
    // Every other write lands somewhere private or is reversible. A public
    // post is neither, so it stays opt-in.
    const used = loops.LOOPS.flatMap((l) => l.steps.map((s) => s.tool)).filter(Boolean);
    assert.ok(!used.some((t) => t?.startsWith("linkedin")));
  });

  it("the tool prompt tells the model to return {} when it lacks the inputs", () => {
    const instruction = tools.toolInstruction(tools.TOOLS["calendar.schedule"]);
    assert.match(instruction, /\{\}/);
    assert.match(instruction, /Invent nothing/);
  });
});
