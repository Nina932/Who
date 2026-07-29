import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";

describe("same-page news reader", () => {
  it("waits for a source-icon click before opening an article", async () => {
    const source = await readFile(
      new URL("../components/NewsDock.tsx", import.meta.url),
      "utf8",
    );
    assert.match(source, /setSelected\(null\)/);
    assert.match(source, /className="news-source-icon"/);
    assert.match(source, /onClick=\{\(\) => setSelected\(index\)\}/);
    assert.doesNotMatch(source, /window\.location/);
  });
});
