import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

/**
 * A guard against the bug a rename actually causes.
 *
 * Renaming Thor to Morpheus with a plain string replace also rewrote every
 * word containing "thor" — `authorization` became `aumorpheusization`, the
 * LinkedIn and Slack OAuth URLs were corrupted, `grant_type` stopped being
 * `authorization_code`, and the `Authorization` header on every Google call
 * was malformed.
 *
 * None of it failed a test, because none of it runs without real OAuth
 * credentials. That is exactly why it needs a test that reads the source
 * rather than the behaviour.
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const SKIP = new Set(["node_modules", ".git", ".next", ".morpheus", "screenshots"]);
const EXTENSIONS = [".ts", ".tsx", ".md", ".css", ".json", ".example"];

async function sourceFiles(dir = ROOT): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await sourceFiles(full)));
    } else if (
      EXTENSIONS.some((e) => entry.name.endsWith(e)) &&
      entry.name !== "package-lock.json"
    ) {
      out.push(full);
    }
  }
  return out;
}

describe("the rename did not corrupt real words", () => {
  it("never leaves 'morpheus' glued inside another word", async () => {
    // The signature of the bug is a *letter* welded to the name in the same
    // case-run: `aumorpheusization`, `AUMORPHEUSITY`. Legitimate neighbours
    // are separators (`morpheus_session`, `.morpheus/`) or a case change
    // (`morpheusRef`), so those are not flagged.
    const bad = /[a-z]Morpheus|[a-z]morpheus|morpheus[a-z]|[A-Z]MORPHEUS|MORPHEUS[a-z]/;

    const offenders: string[] = [];
    for (const file of await sourceFiles()) {
      // This file necessarily contains the corrupted forms, as examples.
      if (file.endsWith("naming.test.ts")) continue;
      const text = await fs.readFile(file, "utf8");
      text.split("\n").forEach((line, index) => {
        if (bad.test(line)) {
          offenders.push(`${path.relative(ROOT, file)}:${index + 1}  ${line.trim().slice(0, 90)}`);
        }
      });
    }

    assert.deepEqual(offenders, [], `\n${offenders.join("\n")}`);
  });

  it("keeps the OAuth constants exactly as the providers define them", async () => {
    // These are the ones that silently break: nothing exercises them without
    // real credentials, so a corrupted URL ships and fails months later.
    const connectors = await fs.readFile(path.join(ROOT, "lib/connectors.ts"), "utf8");

    for (const literal of [
      "https://www.linkedin.com/oauth/v2/authorization",
      "https://slack.com/oauth/v2/authorize",
      'grant_type: "authorization_code"',
      "accounts.google.com/o/oauth2/v2/auth",
    ]) {
      assert.ok(connectors.includes(literal), `connectors.ts no longer contains: ${literal}`);
    }
  });

  it("sends a header the servers will recognise", async () => {
    const connectors = await fs.readFile(path.join(ROOT, "lib/connectors.ts"), "utf8");
    const guard = await fs.readFile(path.join(ROOT, "lib/guard.ts"), "utf8");

    assert.ok(connectors.includes("authorization: `Bearer ${token}`"));
    assert.ok(guard.includes('request.headers.get("authorization")'));
    // LinkedIn's post body field is `author`, not anything else.
    assert.ok(connectors.includes("author: `urn:li:person:"));
  });
});
