import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  liveNewsReply,
  renderLiveNews,
  requestsFreshNews,
  type LiveNewsContext,
} from "../lib/live-news";
import type { Turn } from "../lib/orchestrator";

const context: LiveNewsContext = {
  fetchedAt: Date.parse("2026-07-29T12:00:00Z"),
  sources: [
    { name: "Hugging Face Daily Papers", ok: true },
    { name: "GitHub Changelog", ok: true },
  ],
  headlines: [
    {
      title: "Kimi K3: Open Frontier Intelligence",
      summary: "",
      link: "https://huggingface.co/papers/2607.24653",
      at: Date.parse("2026-07-27T00:00:00Z"),
      source: "Hugging Face Daily Papers",
    },
  ],
};

describe("live conversational news", () => {
  it("keeps a news request active through short follow-ups", () => {
    const history: Turn[] = [
      { id: "1", role: "operator", text: "Tell me the latest open-source AI news", at: 1 },
      { id: "2", role: "specialist", text: "Checking.", at: 2 },
    ];
    assert.equal(requestsFreshNews("so where is it", history), true);
  });

  it("does not let an old news turn hijack a new topic", () => {
    const history: Turn[] = [
      { id: "1", role: "operator", text: "Tell me the latest AI news", at: 1 },
      { id: "2", role: "specialist", text: "Here are six headlines.", at: 2 },
    ];
    assert.equal(
      requestsFreshNews("tell me about Facebook and about yourself", history),
      false,
    );
  });

  it("renders only fetched titles with dates, sources and links", () => {
    const reply = liveNewsReply(context);
    assert.match(reply, /Kimi K3/);
    assert.match(reply, /2026-07-27/);
    assert.match(reply, /Hugging Face Daily Papers/);
    assert.match(reply, /https:\/\/huggingface\.co\/papers\/2607\.24653/);
    assert.match(reply, /not all news/i);
  });

  it("does not turn no matches into a claim that nothing happened", () => {
    const reply = liveNewsReply({ ...context, headlines: [] });
    assert.match(reply, /not proof that no relevant news exists/);
  });

  it("tells the model that source coverage is bounded", () => {
    assert.match(renderLiveNews(context), /bounded source set/);
  });

  it("never labels an old archive item as current news", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        `<rss><channel><item><title>Old model release</title><link>https://example.test/old</link><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item></channel></rss>`,
        { status: 200 },
      );
    try {
      const { fetchLiveNews } = await import("../lib/live-news");
      const result = await fetchLiveNews(
        "latest model",
        Date.parse("2026-07-29T12:00:00Z"),
      );
      assert.equal(result.headlines.length, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not let one feed take over a broad news briefing", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      const source = url.includes("techcrunch")
        ? "techcrunch"
        : url.includes("venturebeat")
          ? "venturebeat"
          : url.includes("arstechnica")
            ? "ars"
            : url.includes("github")
              ? "github"
              : "huggingface";
      return new Response(
        `<rss><channel>${[1, 2, 3]
          .map(
            (index) =>
              `<item><title>${source} item ${index}</title><link>https://example.test/${source}/${index}</link><pubDate>Wed, 29 Jul 2026 10:00:00 GMT</pubDate></item>`,
          )
          .join("")}</channel></rss>`,
        { status: 200 },
      );
    };
    try {
      const { fetchLiveNews } = await import("../lib/live-news");
      const result = await fetchLiveNews(
        "tell me the news",
        Date.parse("2026-07-29T12:00:00Z"),
      );
      const counts = new Map<string, number>();
      for (const item of result.headlines) {
        counts.set(item.source, (counts.get(item.source) ?? 0) + 1);
      }
      assert.ok(result.sources.length >= 5);
      assert.ok([...counts.values()].every((count) => count <= 2));
      assert.equal(
        result.sources.some((source) => source.name === "Hugging Face Daily Papers"),
        false,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
