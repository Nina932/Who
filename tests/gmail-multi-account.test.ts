import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CONNECTORS_BY_ID,
  makeState,
  readState,
} from "../lib/connectors";
import { readFile } from "node:fs/promises";

describe("two independent Gmail mailboxes", () => {
  it("keeps backward-compatible Personal and a separate Company slot", () => {
    assert.equal(CONNECTORS_BY_ID.gmail.name, "Email — Personal");
    assert.equal(
      CONNECTORS_BY_ID["gmail-company"].name,
      "Email — Company",
    );
    assert.notEqual(CONNECTORS_BY_ID.gmail, CONNECTORS_BY_ID["gmail-company"]);
  });

  it("round-trips each mailbox through its own OAuth state", () => {
    for (const id of ["gmail", "gmail-company"] as const) {
      const state = makeState(id);
      assert.equal(readState(state), id);
    }
  });

  it("forces Google's account chooser and lets drafts select a mailbox", async () => {
    const connectors = await readFile(
      new URL("../lib/connectors.ts", import.meta.url),
      "utf8",
    );
    const tools = await readFile(
      new URL("../lib/tools.ts", import.meta.url),
      "utf8",
    );
    assert.match(connectors, /prompt: "select_account consent"/);
    assert.match(tools, /mailbox === "company" \? "gmail-company" : "gmail"/);
  });
});
