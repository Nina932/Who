import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * The store's one hard requirement: concurrent route handlers must not lose
 * each other's writes. Next runs them in the same process, so a naive
 * read-modify-write would drop updates under any real load.
 */

let tmp: string;
let store: typeof import("../lib/store");

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "thor-store-"));
  process.env.THOR_DATA_DIR = tmp;
  store = await import("../lib/store");
});

after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("readCollection", () => {
  it("returns the fallback when nothing has been written", async () => {
    assert.deepEqual(await store.readCollection("missing", []), []);
  });

  it("returns the fallback rather than throwing on a corrupt file", async () => {
    await fs.writeFile(path.join(tmp, "broken.json"), "{ not json", "utf8");
    assert.deepEqual(await store.readCollection("broken", { ok: true }), { ok: true });
  });
});

describe("mutate", () => {
  it("serialises concurrent writers so none are lost", async () => {
    // The bug this guards against: 50 interleaved read-modify-writes landing
    // on top of each other and leaving a handful of entries.
    const writes = Array.from({ length: 50 }, (_, i) =>
      store.mutate<number[], number>("counter", [], (current) => ({
        next: [...current, i],
        result: i,
      })),
    );
    await Promise.all(writes);

    const final = await store.readCollection<number[]>("counter", []);
    assert.equal(final.length, 50, `expected 50 entries, found ${final.length}`);
    assert.deepEqual([...final].sort((a, b) => a - b), [...Array(50).keys()]);
  });

  it("keeps the chain alive after a mutator throws", async () => {
    await assert.rejects(
      store.mutate<number[], never>("chain", [], () => {
        throw new Error("boom");
      }),
    );

    // A rejected link must not deadlock every later write to that collection.
    await store.mutate<number[], null>("chain", [], (current) => ({
      next: [...current, 1],
      result: null,
    }));
    assert.deepEqual(await store.readCollection<number[]>("chain", []), [1]);
  });

  it("passes the mutator's result back to the caller", async () => {
    const result = await store.mutate<string[], string>("echo", [], () => ({
      next: ["x"],
      result: "returned",
    }));
    assert.equal(result, "returned");
  });
});

describe("id", () => {
  it("does not collide across a tight loop", () => {
    const ids = new Set(Array.from({ length: 5000 }, () => store.id("t")));
    assert.equal(ids.size, 5000);
  });
});
