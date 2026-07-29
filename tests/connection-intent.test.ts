import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  connectionReply,
  requestedConnection,
} from "../lib/connection-intent";
import type { ConnectorStatus } from "../lib/connectors";
import type { Turn } from "../lib/orchestrator";

const gmail: ConnectorStatus = {
  id: "gmail",
  name: "Email",
  provider: "google",
  description: "",
  ownerAgentId: "chief-of-staff",
  connected: false,
  available: false,
  writes: true,
  scopes: [],
};

describe("connector conversation truth", () => {
  it("recognises Gmail connection requests and their follow-ups", () => {
    const history: Turn[] = [
      { id: "1", role: "operator", text: "Can you connect my Gmail?", at: 1 },
      { id: "2", role: "specialist", text: "Checking.", at: 2 },
    ];
    assert.equal(requestedConnection("where is the prompt", history), "gmail");
  });

  it("routes the company mailbox to its independent OAuth slot", () => {
    assert.equal(
      requestedConnection("connect my company Gmail"),
      "gmail-company",
    );
    const history: Turn[] = [
      { id: "1", role: "operator", text: "Connect my Gmail", at: 1 },
    ];
    assert.equal(
      requestedConnection("this one is the company account", history),
      "gmail-company",
    );
  });

  it("says no OAuth flow started when provider credentials are missing", () => {
    const reply = connectionReply(gmail);
    assert.match(reply, /is not linked/);
    assert.match(reply, /no consent flow was started/);
    assert.match(reply, /GOOGLE_OAUTH_CLIENT_ID/);
    assert.match(reply, /no popup blocker/);
  });

  it("does not claim a token works merely because one is stored", () => {
    const reply = connectionReply({ ...gmail, connected: true, available: true });
    assert.match(reply, /live Probe/);
    assert.match(reply, /will not claim the account works/);
  });
});
