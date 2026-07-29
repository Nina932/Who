import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  operatorProfiles,
  renderOperatorIntegrations,
  telegramBotStatus,
} from "../lib/operator-integrations";

const originalFetch = globalThis.fetch;
const originalFacebook = process.env.OPERATOR_FACEBOOK_URL;
const originalToken = process.env.TELEGRAM_BOT_TOKEN;
const originalUsername = process.env.TELEGRAM_BOT_USERNAME;
const originalBotId = process.env.TELEGRAM_BOT_ID;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalFacebook === undefined) delete process.env.OPERATOR_FACEBOOK_URL;
  else process.env.OPERATOR_FACEBOOK_URL = originalFacebook;
  if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = originalToken;
  if (originalUsername === undefined) delete process.env.TELEGRAM_BOT_USERNAME;
  else process.env.TELEGRAM_BOT_USERNAME = originalUsername;
  if (originalBotId === undefined) delete process.env.TELEGRAM_BOT_ID;
  else process.env.TELEGRAM_BOT_ID = originalBotId;
});

describe("operator integrations", () => {
  it("treats known profile links as identity, not API access", () => {
    process.env.OPERATOR_FACEBOOK_URL = "https://www.facebook.com/example";
    const profiles = operatorProfiles();
    const facebook = profiles.find((profile) => profile.id === "facebook");
    assert.equal(facebook?.url, "https://www.facebook.com/example");
    assert.match(
      renderOperatorIntegrations(profiles, {
        configured: false,
        verified: false,
      }),
      /not proof of API\/OAuth access/i,
    );
  });

  it("verifies a Telegram token without ever returning it", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token-unique";
    process.env.TELEGRAM_BOT_USERNAME = "example_bot";
    process.env.TELEGRAM_BOT_ID = "12345";
    globalThis.fetch = async () =>
      Response.json({
        ok: true,
        result: { id: 12345, username: "example_bot", first_name: "Example" },
      });
    const status = await telegramBotStatus(1_000_000);
    assert.deepEqual(status, {
      configured: true,
      verified: true,
      botId: 12345,
      username: "example_bot",
      displayName: "Example",
      expectedBotId: 12345,
      expectedUsername: "example_bot",
      matchesExpected: true,
      usernameChanged: false,
    });
    assert.doesNotMatch(JSON.stringify(status), /test-token-unique/);
  });

  it("does not confuse a valid token with the bot handle the operator named", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "another-unique-token";
    process.env.TELEGRAM_BOT_USERNAME = "wanted_bot";
    process.env.TELEGRAM_BOT_ID = "777";
    globalThis.fetch = async () =>
      Response.json({
        ok: true,
        result: { id: 888, username: "different_bot", first_name: "Different" },
      });
    const status = await telegramBotStatus(2_000_000);
    assert.equal(status.verified, true);
    assert.equal(status.matchesExpected, false);
    assert.match(
      renderOperatorIntegrations([], status),
      /credential mismatch/i,
    );
  });

  it("trusts the immutable bot id when a username has changed", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "renamed-bot-token";
    process.env.TELEGRAM_BOT_USERNAME = "old_name_bot";
    process.env.TELEGRAM_BOT_ID = "999";
    globalThis.fetch = async () =>
      Response.json({
        ok: true,
        result: { id: 999, username: "current_name_bot", first_name: "Current" },
      });
    const status = await telegramBotStatus(3_000_000);
    assert.equal(status.matchesExpected, true);
    assert.equal(status.usernameChanged, true);
    assert.match(
      renderOperatorIntegrations([], status),
      /same immutable bot ID/,
    );
  });
});
