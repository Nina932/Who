import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDailyBriefing } from "../lib/daily-briefing";
import type { Product } from "../lib/products";

const now = Date.parse("2026-07-29T16:00:00Z");

const product: Product = {
  id: "product-1",
  name: "Morpheus",
  phase: "build",
  phaseSince: now - 86_400_000,
  objective: "Make the cockpit truthful and useful.",
  working: [],
  blockers: [],
  milestone: { name: "Live briefing", exit: [] },
};

describe("daily briefing", () => {
  it("assembles connected calendar, both mailboxes, live news and project truth", async () => {
    const result = await buildDailyBriefing("Historical fact.", now, {
      calendar: async () => ({
        ok: true,
        data: [
          {
            summary: "Product review",
            htmlLink: "https://calendar.google.com/event",
            start: { dateTime: "2026-07-29T18:30:00Z" },
          },
        ],
      }),
      mail: async (connectorId) => ({
        ok: true,
        data:
          connectorId === "gmail"
            ? [{ id: "mail-1", subject: "Decision needed", from: "Nina" }]
            : [{ id: "mail-2", subject: "Company update", from: "NYX" }],
      }),
      news: async () => ({
        fetchedAt: now,
        sources: [{ name: "Verified source", ok: true }],
        headlines: [
          {
            title: "A current verified headline",
            summary: "",
            link: "https://example.test/current",
            at: now,
            source: "Verified source",
          },
        ],
      }),
      products: async () => [product],
      operatorContext: async () => ({
        description: "",
        projectNotes: "",
        updatedAt: null,
      }),
      memory: async () => [],
    });

    assert.equal(result.coverage.live, 4);
    assert.equal(result.headlines.length, 1);
    assert.match(result.lines.find((line) => line.id === "calendar")?.text ?? "", /Product review/);
    assert.match(
      result.lines.find((line) => line.id === "mail")?.text ?? "",
      /2 priority unread loaded/,
    );
    assert.match(result.lines.find((line) => line.id === "news")?.text ?? "", /current verified/);
    assert.match(result.lines.find((line) => line.id === "projects")?.text ?? "", /Morpheus/);
    assert.equal(result.almanac, "Historical fact.");
    assert.match(result.summary, /At least 2 priority emails need review/);
  });

  it("reports missing sources and context instead of manufacturing a briefing", async () => {
    const result = await buildDailyBriefing("No historical entry.", now, {
      calendar: async () => ({
        ok: false,
        error: "Calendar is not connected",
        needsConnection: true,
      }),
      mail: async () => ({
        ok: false,
        error: "Mailbox is not connected",
        needsConnection: true,
      }),
      news: async () => ({
        fetchedAt: now,
        sources: [{ name: "Verified source", ok: false, error: "offline" }],
        headlines: [],
      }),
      products: async () => [],
      operatorContext: async () => ({
        description: "",
        projectNotes: "",
        updatedAt: null,
      }),
      memory: async () => [],
    });

    assert.equal(result.coverage.live, 1);
    assert.equal(
      result.lines.find((line) => line.id === "projects")?.text,
      "No active projects saved",
    );
    assert.equal(
      result.lines.find((line) => line.id === "calendar")?.state,
      "unavailable",
    );
    assert.equal(
      result.lines.find((line) => line.id === "news")?.state,
      "unavailable",
    );
    assert.equal(result.headlines.length, 0);
  });
});
