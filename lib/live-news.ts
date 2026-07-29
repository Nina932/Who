import { parseFeed, type FeedItem } from "./feeds";
import type { Turn } from "./orchestrator";

export interface LiveHeadline extends FeedItem {
  source: string;
}

export interface LiveNewsContext {
  fetchedAt: number;
  headlines: LiveHeadline[];
  sources: Array<{ name: string; ok: boolean; error?: string }>;
}

const DEFAULT_NEWS_SOURCES = [
  { name: "Hugging Face Blog", url: "https://huggingface.co/blog/feed.xml", kind: "rss" },
  {
    name: "TechCrunch AI",
    url: "https://techcrunch.com/category/artificial-intelligence/feed/",
    kind: "rss",
  },
  {
    name: "VentureBeat AI",
    url: "https://venturebeat.com/category/ai/feed/",
    kind: "rss",
  },
  {
    name: "Ars Technica",
    url: "https://feeds.arstechnica.com/arstechnica/technology-lab",
    kind: "rss",
  },
  {
    name: "Hugging Face Daily Papers",
    url: "https://huggingface.co/api/daily_papers",
    kind: "daily-papers",
  },
  { name: "GitHub Changelog", url: "https://github.blog/changelog/feed/", kind: "rss" },
];

const QUERY_STOP = new Set([
  "about", "actual", "all", "and", "are", "because", "fresh", "freshest",
  "from", "give", "happening", "headlines", "important", "latest", "me",
  "news", "newest", "now", "please", "really", "show", "tell", "the",
  "there", "this", "today", "what", "which", "will", "world", "you",
]);
const BROAD_TECH_TERMS = new Set([
  "agent", "agents", "ai", "github", "hugging", "model", "models", "open",
  "paper", "papers", "source",
]);
const MAX_CURRENT_AGE = 45 * 86_400_000;

export function requestsFreshNews(utterance: string, history: Turn[] = []): boolean {
  const current = utterance.trim();
  if (
    /\b(news|headlines?|latest|newest|current events?|what(?:'s| is) happening)\b/i.test(
      current,
    )
  ) {
    return true;
  }

  // A news turn can have a short elliptical follow-up ("where is it?", "more",
  // "what else?"). It must not poison every later topic merely because the
  // word "news" still exists four turns back in history.
  const words = current.split(/\s+/).filter(Boolean);
  if (
    words.length > 12 ||
    !/^(?:(?:so|and|okay|ok)\s+)?(?:where is (?:it|that)|show (?:it|them)|more|tell me more|what else|is that all|that's all)\??$/i.test(
      current,
    )
  ) {
    return false;
  }
  return history
    .filter((turn) => turn.role === "operator")
    .slice(-2)
    .some((turn) =>
      /\b(news|headlines?|latest|newest|current events?)\b/i.test(turn.text),
    );
}

function queryTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .replace(/open[\s-]source/g, "open source")
        .split(/[^a-z0-9+#.]+/)
        .filter((word) => word.length > 2 && !QUERY_STOP.has(word)),
    ),
  ];
}

function configuredSources(): Array<{ name: string; url: string; kind: string }> {
  const raw = process.env.MORPHEUS_NEWS_FEEDS?.trim();
  if (!raw) return DEFAULT_NEWS_SOURCES;
  return raw
    .split(",")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair, index) => {
      const [name, url] = pair.split("|").map((part) => part.trim());
      return { name: name || `News source ${index + 1}`, url: url ?? name, kind: "rss" };
    })
    .filter((source) => /^https?:\/\//.test(source.url));
}

export async function fetchLiveNews(
  query: string,
  now = Date.now(),
): Promise<LiveNewsContext> {
  const terms = queryTerms(query);
  const wantsResearch =
    /\b(papers?|research|benchmark|evaluation|study|studies|academic)\b/i.test(
      query,
    );
  // Daily Papers is valuable when explicitly requested, but it is not a
  // general-news desk. Including it in every broad briefing is what made
  // Morpheus answer "news" with a wall of paper titles.
  const sources = configuredSources().filter(
    (source) => source.kind !== "daily-papers" || wantsResearch,
  );
  const outcomes = await Promise.allSettled(
    sources.map(async (source) => {
      const response = await fetch(source.url, {
        headers: {
          accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
        },
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(String(response.status));
      if (source.kind === "daily-papers") {
        const rows = (await response.json()) as Array<{
          paper?: {
            id?: string;
            title?: string;
            summary?: string;
            publishedAt?: string;
            submittedOnDailyAt?: string;
          };
        }>;
        return {
          source,
          items: rows
            .map(({ paper }) => ({
              title: paper?.title?.trim() ?? "",
              summary: paper?.summary?.slice(0, 400) ?? "",
              link: paper?.id ? `https://huggingface.co/papers/${paper.id}` : "",
              at:
                Date.parse(paper?.publishedAt ?? paper?.submittedOnDailyAt ?? "") ||
                now,
              source: source.name,
            }))
            .filter((item) => item.title),
        };
      }
      return {
        source,
        items: parseFeed(await response.text(), now).map((item) => ({
          ...item,
          source: source.name,
        })),
      };
    }),
  );

  const sourceStatus: LiveNewsContext["sources"] = [];
  const candidates: LiveHeadline[] = [];
  outcomes.forEach((outcome, index) => {
    const source = sources[index];
    if (outcome.status === "rejected") {
      sourceStatus.push({
        name: source.name,
        ok: false,
        error:
          outcome.reason instanceof Error ? outcome.reason.message : "unreachable",
      });
      return;
    }
    sourceStatus.push({ name: source.name, ok: true });
    candidates.push(...outcome.value.items);
  });

  const rankedCandidates = candidates
    .filter(
      (item) =>
        item.at <= now + 86_400_000 &&
        item.at >= now - MAX_CURRENT_AGE,
    )
    .map((item) => {
      const text = `${item.title} ${item.summary}`.toLowerCase();
      const score = terms.reduce(
        (total, term) =>
          total +
          (text.includes(term)
            ? BROAD_TECH_TERMS.has(term)
              ? 1
              : 5
            : 0),
        0,
      );
      return { item, score };
    })
    .filter((row) => terms.length === 0 || row.score > 0)
    .sort((a, b) => b.score - a.score || b.item.at - a.item.at);

  // Broad news needs editorial breadth. Cap any one feed at two results and
  // deduplicate syndicated links/titles; specific searches may go deeper into
  // the source that actually matched.
  const perSource = new Map<string, number>();
  const seen = new Set<string>();
  const ranked: LiveHeadline[] = [];
  const sourceLimit = /\b(?:news|headlines?)\b/i.test(query) ? 2 : 4;
  for (const row of rankedCandidates) {
    const key = (row.item.link || row.item.title).toLowerCase();
    if (seen.has(key)) continue;
    const count = perSource.get(row.item.source) ?? 0;
    if (count >= sourceLimit) continue;
    seen.add(key);
    perSource.set(row.item.source, count + 1);
    ranked.push(row.item);
    if (ranked.length === 8) break;
  }

  return { fetchedAt: now, headlines: ranked, sources: sourceStatus };
}

export function renderLiveNews(context: LiveNewsContext): string {
  const sourceLine = context.sources
    .map((source) => `${source.name}: ${source.ok ? "reached" : `failed (${source.error})`}`)
    .join("; ");
  const lines = context.headlines.map(
    (item) =>
      `- ${new Date(item.at).toISOString().slice(0, 10)} | ${item.source} | ${item.title}\n  ${item.link}`,
  );
  return [
    `LIVE NEWS FETCHED ${new Date(context.fetchedAt).toISOString()}.`,
    `Coverage: ${sourceLine}. This is a bounded source set, never "all news".`,
    lines.length
      ? lines.join("\n")
      : "NO MATCHING HEADLINES WERE VERIFIED. Say that plainly; do not fill the gap from model memory.",
  ].join("\n");
}

export function liveNewsReply(context: LiveNewsContext): string {
  const reached = context.sources.filter((source) => source.ok).map((source) => source.name);
  if (!context.headlines.length) {
    return reached.length
      ? `I checked ${reached.join(", ")} just now, but none of their current items matched your request. That is a source result, not proof that no relevant news exists.`
      : "I could not reach the configured live news sources, so I cannot verify current headlines right now.";
  }

  const lines = context.headlines.slice(0, 6).map((item, index) => {
    const date = new Date(item.at).toISOString().slice(0, 10);
    return `${index + 1}. ${item.title} — ${item.source}, ${date}. [source: ${item.link}]`;
  });
  return [
    `I checked ${reached.join(", ")} just now. This is verified, bounded coverage—not all news.`,
    ...lines,
  ].join("\n");
}
