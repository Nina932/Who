import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

describe("daily briefing cockpit surface", () => {
  it("loads the live aggregation and can be hidden without removing it", async () => {
    const source = await readFile(
      new URL("../components/HudHeader.tsx", import.meta.url),
      "utf8",
    );
    assert.match(source, /fetch\("\/api\/daily-briefing"/);
    assert.match(source, />\s*Hide\s*<\/button>/);
    assert.match(source, /Show today/);
    assert.match(source, /briefing\.summary/);
  });

  it("feeds verified launch headlines into the same-page news reader", async () => {
    const [header, page] = await Promise.all([
      readFile(new URL("../components/HudHeader.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    ]);
    assert.match(header, /onNews\?\.\(data\.headlines\)/);
    assert.match(page, /onNews=\{setNews\}/);
  });
});
