/**
 * Verify that every configured model ID actually exists.
 *
 * The IDs in `lib/models.ts` were written from memory and never called. A
 * wrong one fails at the worst moment — mid-conversation, or halfway through
 * an unattended loop — and the error surfaces as "the stack is down" rather
 * than "that model does not exist".
 *
 *   npm run verify:models
 *
 * One minimal call per role. Exits non-zero if any configured role is broken,
 * so it can gate a deploy. Roles whose provider has no key are reported as
 * skipped rather than failed — a missing key is a choice, a wrong ID is a bug.
 */

import { STACK, callRole, keyFor, type ModelRole } from "../lib/models";

const RESET = "[0m";
const DIM = "[2m";
const GREEN = "[32m";
const RED = "[31m";
const YELLOW = "[33m";

async function main(): Promise<void> {
  const roles = Object.keys(STACK) as ModelRole[];
  let failed = 0;
  let skipped = 0;

  console.log(`\nVerifying ${roles.length} model IDs\n`);

  for (const role of roles) {
    const spec = STACK[role];
    const label = `${role.padEnd(9)} ${spec.model.padEnd(34)}`;

    if (!keyFor(spec.provider)) {
      console.log(`${YELLOW}skip${RESET}  ${label} ${DIM}no ${spec.provider} key${RESET}`);
      skipped += 1;
      continue;
    }

    const started = Date.now();
    const result = await callRole(role, {
      // Deliberately tiny: this checks that the ID resolves and the key is
      // accepted, not that the model is any good.
      system: "Reply with the single word: ok",
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 8,
    });
    const ms = Date.now() - started;

    if (result.live) {
      console.log(`${GREEN}ok${RESET}    ${label} ${DIM}${ms}ms${RESET}`);
    } else {
      console.log(`${RED}FAIL${RESET}  ${label} ${result.error ?? "unknown error"}`);
      failed += 1;
    }
  }

  const image = process.env.MORPHEUS_MODEL_IMAGE ?? "imagen-4.0-generate-001";
  console.log(`${DIM}\nimage model configured as ${image} (not called — generation costs money)${RESET}`);

  console.log(
    `\n${failed === 0 ? GREEN : RED}${roles.length - failed - skipped} ok${RESET}, ${failed} failed, ${skipped} skipped\n`,
  );

  if (failed > 0) process.exitCode = 1;
}

void main().catch((error) => {
  console.error("verify-models crashed:", error);
  process.exitCode = 1;
});
