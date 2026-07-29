import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";

describe("Groq speech route", () => {
  it("still asks Orpheus for a dark deliberate delivery", async () => {
    // The provider details moved to lib/speech-provider.ts when a second
    // provider was added; the route now only guards and serves.
    const source = await readFile(
      new URL("../lib/speech-provider.ts", import.meta.url),
      "utf8",
    );
    assert.match(source, /process\.env\.GROQ_API_KEY/);
    assert.match(source, /canopylabs\/orpheus-v1-english/);
    assert.match(source, /\[menacing\] \[deliberately\]/);
    assert.doesNotMatch(source, /NEXT_PUBLIC_GROQ/);
    assert.doesNotMatch(source, /Optimus|Peter Cullen/i);
  });

  it("refuses a cross-origin write and serves audio as audio", async () => {
    const source = await readFile(
      new URL("../app/api/speech/route.ts", import.meta.url),
      "utf8",
    );
    assert.match(source, /guardMutation\(request\)/);
    assert.match(source, /"content-type": "audio\/wav"/);
    // A substituted voice is announced in a header rather than passed off as
    // the intended one.
    assert.match(source, /x-voice-provider/);
    assert.match(source, /x-voice-fallback-reason/);
  });
});
