import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { guardMutation } from "../lib/guard";

function request(url: string, origin: string) {
  return new Request(url, {
    method: "POST",
    headers: { origin },
  });
}

describe("same-origin mutation guard", () => {
  it("accepts the localhost and 127.0.0.1 aliases on the same port", () => {
    assert.equal(
      guardMutation(request("http://localhost:4173/api/morpheus", "http://127.0.0.1:4173")),
      null,
    );
    assert.equal(
      guardMutation(request("http://127.0.0.1:4173/api/morpheus", "http://localhost:4173")),
      null,
    );
  });

  it("still rejects a different port or a remote origin", () => {
    assert.equal(
      guardMutation(request("http://localhost:4173/api/morpheus", "http://127.0.0.1:9999"))
        ?.response.status,
      403,
    );
    assert.equal(
      guardMutation(request("http://localhost:4173/api/morpheus", "https://example.com"))
        ?.response.status,
      403,
    );
  });
});
