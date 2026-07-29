import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CONNECTORS_BY_ID } from "../lib/connectors";

describe("personal Facebook connector", () => {
  it("is identity-only and does not request feed, publishing or messages", () => {
    const connector = CONNECTORS_BY_ID["facebook-profile"];
    assert.equal(connector.provider, "facebook");
    assert.equal(connector.writes, false);
    assert.deepEqual(connector.scopes, ["public_profile"]);
    assert.ok(!connector.scopes.some((scope) => /posts|feed|messaging/.test(scope)));
  });

  it("belongs to the Social specialist and explains its boundary", () => {
    const connector = CONNECTORS_BY_ID["facebook-profile"];
    assert.equal(connector.ownerAgentId, "social");
    assert.match(connector.description, /does not permit.*personal timeline/i);
  });
});
