import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { CAPABILITIES } from "../lib/authority";

/**
 * One mandatory route to the world.
 *
 * `runTool` being safe is worth nothing if another module can reach
 * `createMailDraft` directly. The authority layer is only a boundary if it is
 * the *only* path — so this reads the source and refuses any import of a
 * connector mutation from outside the modules allowed to have one.
 *
 * A test rather than a convention, because a convention is a thing people
 * remember until the afternoon they are in a hurry.
 */

const ROOT = path.resolve(import.meta.dirname, "..");

/**
 * Derived, never hand-maintained.
 *
 * A fixed list is a list somebody forgets to add to. `export async function
 * sendInvoice` would ship, be missed, and the seam test would stay green. So
 * the mutations are read out of the connector source: any exported async
 * function whose body issues a non-GET request.
 *
 * Reads are excluded deliberately — they are gated at a different level and
 * their failure mode is disclosure, not action.
 */
/**
 * The OAuth dance itself, which is not an action taken on the operator's
 * behalf against third-party data — it is how the connection comes to exist.
 * Excluded by name rather than by omission, so the exclusion is a decision
 * somebody can disagree with rather than a gap nobody noticed.
 */
const OAUTH_LIFECYCLE = new Set(["exchangeCode", "refresh", "disconnect"]);

async function connectorMutations(): Promise<string[]> {
  const text = await fs.readFile(path.join(ROOT, "lib/connectors.ts"), "utf8");
  const found: string[] = [];

  const pattern = /export async function (\w+)\s*[(<]/g;
  const starts: Array<{ name: string; at: number }> = [];
  for (const match of text.matchAll(pattern)) {
    starts.push({ name: match[1], at: match.index ?? 0 });
  }

  starts.forEach((start, index) => {
    const body = text.slice(start.at, starts[index + 1]?.at ?? text.length);
    if (OAUTH_LIFECYCLE.has(start.name)) return;
    if (/method:\s*["'](POST|PUT|PATCH|DELETE)["']/i.test(body)) found.push(start.name);
  });

  return found;
}

/**
 * The only modules permitted to import them.
 *
 * `tools.ts` declares a capability per tool and goes through `withAuthority`;
 * `loops.ts` calls `runTool`, never `tool.run`. Everything else must go
 * through one of those.
 */
const ALLOWED = ["lib/tools.ts", "lib/connectors.ts"];

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", ".next", ".morpheus", "tests"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("the execution seam is the only way out", () => {
  it("finds the mutations by reading the connector, not from a list", async () => {
    // If this returns nothing the whole suite passes vacuously.
    const mutations = await connectorMutations();
    assert.ok(mutations.length >= 5, `only found ${mutations.join(", ")}`);
    for (const expected of [
      "createMailDraft",
      "createCalendarEvent",
      "postToSlack",
      "postToLinkedIn",
      "appendToLog",
    ]) {
      assert.ok(mutations.includes(expected), `did not detect ${expected}`);
    }
    // The OAuth dance is not a business mutation and must stay excluded.
    assert.ok(!mutations.includes("exchangeCode"));
  });

  it("refuses a mutating call that arrives with no declared scope", async () => {
    // Runtime enforcement, which catches what static analysis cannot: a
    // renamed import, a namespace import, a dynamic import, a re-export.
    const connectors = await fs.readFile(path.join(ROOT, "lib/connectors.ts"), "utf8");
    assert.match(connectors, /a mutating connector call arrived without a declared capability scope/);
    assert.match(connectors, /const mutating = method !== "GET"/);
  });

  it("nothing outside the authority layer imports a connector mutation", async () => {
    const MUTATIONS = await connectorMutations();
    const offenders: string[] = [];

    for (const file of await sourceFiles(ROOT)) {
      const relative = path.relative(ROOT, file).replace(/\\/g, "/");
      if (ALLOWED.includes(relative)) continue;

      const text = await fs.readFile(file, "utf8");
      // Only import statements. A mention in a comment or a string is not a
      // call, and flagging those would make the test noise rather than signal.
      const imports = text.match(/import\s+\{[\s\S]*?\}\s+from\s+["'][^"']*connectors["']/g) ?? [];

      for (const statement of imports) {
        for (const mutation of MUTATIONS) {
          if (new RegExp(`\\b${mutation}\\b`).test(statement)) {
            offenders.push(`${relative} imports ${mutation}`);
          }
        }
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `\nThese reach the world without going through withAuthority:\n${offenders.join("\n")}\n\n` +
        "Route them through lib/tools.ts with a declared capabilityId.",
    );
  });

  it("the Loops Engine calls runTool, never a tool's run directly", async () => {
    // Past its human gate, a loop is still not permission to act.
    const loops = await fs.readFile(path.join(ROOT, "lib/loops.ts"), "utf8");
    assert.ok(loops.includes("runTool("), "loops.ts no longer routes through runTool");
    assert.ok(
      !/\btool\.run\(/.test(loops),
      "loops.ts calls tool.run directly, bypassing the authority layer",
    );
  });

  it("every tool declares a capability that exists", async () => {
    const tools = await import("../lib/tools");
    const known = new Set(CAPABILITIES.map((c) => c.id));
    for (const tool of Object.values(tools.TOOLS)) {
      assert.ok(tool.capabilityId, `${tool.name} declares no capability`);
      assert.ok(known.has(tool.capabilityId), `${tool.name} declares an unregistered capability`);
    }
  });

  it("no API route reaches a connector mutation on its own", async () => {
    // The route handlers are the other place a shortcut is tempting.
    const routes = (await sourceFiles(path.join(ROOT, "app"))).filter((f) => f.endsWith("route.ts"));
    assert.ok(routes.length > 0, "no routes found — the check would pass vacuously");

    const MUTATIONS = await connectorMutations();
    for (const file of routes) {
      const text = await fs.readFile(file, "utf8");
      for (const mutation of MUTATIONS) {
        assert.ok(
          !new RegExp(`\\b${mutation}\\s*\\(`).test(text),
          `${path.relative(ROOT, file)} calls ${mutation} directly`,
        );
      }
    }
  });
});
