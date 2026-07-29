import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";

describe("Groq speech route", () => {
  it("keeps the credential server-side and requests a dark deliberate delivery", async () => {
    const source = await readFile(
      new URL("../app/api/speech/route.ts", import.meta.url),
      "utf8",
    );
    assert.match(source, /process\.env\.GROQ_API_KEY/);
    assert.match(source, /canopylabs\/orpheus-v1-english/);
    assert.match(source, /\[menacing\] \[deliberately\]/);
    assert.match(source, /guardMutation\(request\)/);
    assert.doesNotMatch(source, /NEXT_PUBLIC_GROQ/);
    assert.doesNotMatch(source, /Optimus|Peter Cullen/i);
  });
});
