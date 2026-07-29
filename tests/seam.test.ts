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
 * Functions in `lib/connectors.ts` that change something outside this process.
 *
 * Reads are not listed: they are gated by capability at a different level and
 * their failure mode is disclosure, not action.
 */
const MUTATIONS = [
  "createCalendarEvent",
  "createMailDraft",
  "createSlideDeck",
  "appendToLog",
  "postToSlack",
  "postToLinkedIn",
];

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
  it("nothing outside the authority layer imports a connector mutation", async () => {
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
