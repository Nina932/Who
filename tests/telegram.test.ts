import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appendTelegramHistory,
  parseAllowedTelegramUserIds,
  parseSseReply,
  telegramTextChunks,
  telegramUserAllowed,
} from "../lib/telegram";

describe("Telegram worker safety and transport", () => {
  it("allows only explicitly configured numeric user ids", () => {
    const allowed = parseAllowedTelegramUserIds(" 42,not-a-number,77,0,-2 ");
    assert.deepEqual([...allowed], [42, 77]);
    assert.equal(telegramUserAllowed(42, allowed), true);
    assert.equal(telegramUserAllowed(41, allowed), false);
    assert.equal(telegramUserAllowed(undefined, allowed), false);
  });

  it("extracts assistant deltas and ignores cockpit actions", () => {
    const payload = [
      'event: meta\ndata: {"attendance":{}}',
      'event: delta\ndata: {"text":"Hello"}',
      'event: action\ndata: {"type":"navigate","url":"/connect"}',
      'event: delta\ndata: {"text":" there."}',
      'event: done\ndata: {"local":false}',
    ].join("\n\n");
    assert.equal(parseSseReply(payload), "Hello there.");
  });

  it("splits long replies under Telegram limits without losing text", () => {
    const value = `${"word ".repeat(1000)}done`;
    const chunks = telegramTextChunks(value, 250);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((chunk) => chunk.length <= 250));
    assert.equal(
      chunks.join(" ").replace(/\s+/g, " "),
      value.replace(/\s+/g, " "),
    );
  });

  it("keeps a bounded per-chat conversation", () => {
    let history: Array<{
      role: "operator" | "specialist";
      text: string;
    }> = [];
    for (let index = 0; index < 8; index += 1) {
      history = appendTelegramHistory(history, `q${index}`, `a${index}`, 12);
    }
    assert.equal(history.length, 12);
    assert.equal(history[0].text, "q2");
    assert.equal(history.at(-1)?.text, "a7");
  });
});
