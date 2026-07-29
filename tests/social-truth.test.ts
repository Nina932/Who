import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PLATFORMS } from "../lib/social";

describe("social account truth", () => {
  it("contains no invented account identity or sample metrics", () => {
    const serialized = JSON.stringify(PLATFORMS).toLowerCase();
    assert.doesNotMatch(serialized, /reznikov|followers|reach|sample/);
    assert.deepEqual(
      PLATFORMS.map((platform) => platform.name),
      ["X", "Facebook", "LinkedIn"],
    );
  });

  it("uses the free X web composer instead of implying paid API access", () => {
    const x = PLATFORMS.find((platform) => platform.id === "x");
    assert.equal(x?.connectorId, undefined);
    assert.equal(x?.manualUrl, "https://x.com/compose/post");
  });
});
