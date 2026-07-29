/**
 * Where signals actually come from.
 *
 * The classifier was real and nothing fed it. This is the feed: RSS and Atom
 * over plain `fetch`, no dependency, no crawler, no API key.
 *
 * The important design decision is that **tagging needs no model.** The
 * earlier version asked a model to pull keys out of an article and then
 * matched those keys against product state — which meant the whole
 * intelligence layer silently degraded to nothing without an API key.
 *
 * Reversing it removes the dependency entirely: take the vocabulary the
 * *products* already contain — blocker names, capability names, objectives —
 * and look for it in the article. A signal is relevant if your own words
 * appear in it. That is both cheaper and more honest, because the matching
 * vocabulary is inspectable and belongs to the operator rather than to a
 * model's idea of what a keyword is.
 */

import type { Nature, Signal } from "./signals";
import type { ProductView } from "./products";

// ── Sources ──────────────────────────────────────────────────────────────

export interface Source {
  id: string;
  name: string;
  url: string;
  /** Signals from this source are this nature unless the text says otherwise. */
  assume?: Nature;
}

/**
 * Defaults chosen for a stack that is databases, deployment, agents and
 * models. Override wholesale with `THOR_FEEDS` — a comma-separated list of
 * `name|url` pairs — because whose feed this should be is not my call.
 */
export const DEFAULT_SOURCES: Source[] = [
  {
    id: "postgres",
    name: "PostgreSQL news",
    url: "https://www.postgresql.org/news.rss",
    assume: "capability",
  },
  {
    id: "aws-whats-new",
    name: "AWS what's new",
    url: "https://aws.amazon.com/about-aws/whats-new/recent/feed/",
    assume: "capability",
  },
  {
    id: "gcp-release-notes",
    name: "Google Cloud release notes",
    url: "https://cloud.google.com/feeds/gcp-release-notes.xml",
    assume: "capability",
  },
  {
    id: "kubernetes",
    name: "Kubernetes blog",
    url: "https://kubernetes.io/feed.xml",
    assume: "capability",
  },
  {
    id: "hn-frontpage",
    name: "Hacker News",
    url: "https://hnrss.org/frontpage",
    assume: "commentary",
  },
];

export function configuredSources(): Source[] {
  const raw = process.env.THOR_FEEDS?.trim();
  if (!raw) return DEFAULT_SOURCES;

  return raw
    .split(",")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair, index) => {
      const [name, url] = pair.split("|").map((s) => s.trim());
      return { id: `custom-${index}`, name: name || `Source ${index + 1}`, url: url ?? name };
    })
    .filter((source) => /^https?:\/\//.test(source.url));
}

// ── Parsing ──────────────────────────────────────────────────────────────

export interface FeedItem {
  title: string;
  summary: string;
  link: string;
  at: number;
}

/**
 * Order matters twice here, and both are easy to get backwards.
 *
 * Entities are decoded **before** tags are stripped. Doing it the other way
 * round turns `&lt;script&gt;` into live markup on the way out, because the
 * strip runs while the tag is still escaped and the decode then unescapes it
 * with nothing left to catch it.
 *
 * And `&amp;` is decoded **last**, so a double-encoded `&amp;lt;` resolves to
 * the literal text `&lt;` rather than being unwrapped a second time.
 */
function decode(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block: string, name: string): string {
  const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return match ? decode(match[1]) : "";
}

/**
 * RSS and Atom in one pass.
 *
 * Deliberately not a real XML parser. Feeds are a small, well-shaped subset
 * and the output here is text that gets matched against a fixed vocabulary —
 * nothing is executed, nothing is rendered as markup. A dependency for this
 * would be more surface than it saves.
 */
export function parseFeed(xml: string, fallbackAt: number): FeedItem[] {
  const blocks = xml.match(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi) ?? [];

  return blocks
    .map((block) => {
      const title = tag(block, "title");
      const summary =
        tag(block, "description") || tag(block, "summary") || tag(block, "content");

      // Atom puts the link in an attribute; RSS puts it in the element.
      const href = block.match(/<link[^>]*href=["']([^"']+)["']/i)?.[1];
      const link = href ?? tag(block, "link") ?? "";

      const dateText =
        tag(block, "pubDate") || tag(block, "published") || tag(block, "updated");
      const parsed = Date.parse(dateText);

      return {
        title,
        summary: summary.slice(0, 400),
        link: link.trim(),
        at: Number.isFinite(parsed) ? parsed : fallbackAt,
      };
    })
    .filter((item) => item.title.length > 0);
}

// ── Tagging without a model ──────────────────────────────────────────────

/** Words too common to mean anything when matched on their own. */
const STOP = new Set([
  "core", "data", "logic", "tools", "engine", "workflow", "surface", "deployment",
  "execution", "proof", "definition", "resolution", "isolation", "publishing",
  "enforcement", "the", "and", "for", "with", "new", "live", "production",
]);

/**
 * The vocabulary this business actually contains.
 *
 * Multi-word phrases are kept whole ("production worker deployment") *and*
 * split into their distinctive words, because a changelog will say
 * "PostgreSQL" rather than quoting your blocker's full name back at you. The
 * stoplist is what stops "data" matching every article ever written.
 */
export function vocabularyOf(products: ProductView[]): string[] {
  const terms = new Set<string>();

  for (const product of products) {
    if (!product.active) continue;
    const phrases = [
      product.name,
      ...product.openBlockers.map((b) => b.name),
      ...product.working.map((c) => c.name),
    ];

    for (const phrase of phrases) {
      const clean = phrase.trim();
      if (clean.length > 3) terms.add(clean);
      for (const word of clean.split(/[^a-z0-9+#.]+/i)) {
        if (word.length > 4 && !STOP.has(word.toLowerCase())) terms.add(word);
      }
    }
  }

  return [...terms];
}

/** Which of the operator's own terms appear in this text. */
export function deriveTags(text: string, products: ProductView[]): string[] {
  const haystack = text.toLowerCase();
  return vocabularyOf(products).filter((term) => haystack.includes(term.toLowerCase()));
}

const NATURE_MARKERS: Array<{ nature: Nature; pattern: RegExp }> = [
  // Ordered: a security advisory about a deprecated API is a vulnerability
  // first, because that is the one with a clock on it.
  { nature: "vulnerability", pattern: /\bCVE-\d|vulnerabilit|security advisory|exploit|patch release/i },
  { nature: "deprecation", pattern: /deprecat|end[- ]of[- ]life|sunset|will be removed|breaking change|no longer supported/i },
  { nature: "pricing", pattern: /pricing|price (change|increase|reduction)|free tier|per-token cost|billing change/i },
  { nature: "market", pattern: /survey|buyers|enterprise adoption|market|procurement|spending/i },
];

export function detectNature(text: string, fallback: Nature = "commentary"): Nature {
  for (const marker of NATURE_MARKERS) {
    if (marker.pattern.test(text)) return marker.nature;
  }
  return fallback;
}

// ── Polling ──────────────────────────────────────────────────────────────

export interface PollResult {
  source: string;
  ok: boolean;
  found: number;
  /** Only items whose text contains the operator's vocabulary. */
  kept: number;
  error?: string;
}

/** Stable id from the link, so re-polling cannot duplicate a signal. */
function signalId(link: string, title: string): string {
  const basis = link || title;
  let hash = 0;
  for (let i = 0; i < basis.length; i += 1) {
    hash = (hash * 31 + basis.charCodeAt(i)) | 0;
  }
  return `sig-${(hash >>> 0).toString(36)}`;
}

/**
 * Fetch every source and keep only what touches this business.
 *
 * Irrelevant items are dropped *at ingestion* rather than stored and filtered
 * later. A store that accumulates every headline is a news database, and the
 * first time it is slow the temptation is to show it unfiltered.
 *
 * A source that fails is reported per-source and does not sink the poll — one
 * dead feed must not cost you the other four.
 */
export async function poll(
  products: ProductView[],
  now: number = Date.now(),
  sources: Source[] = configuredSources(),
): Promise<{ signals: Signal[]; results: PollResult[] }> {
  const signals: Signal[] = [];
  const results: PollResult[] = [];

  const settled = await Promise.allSettled(
    sources.map(async (source) => {
      const response = await fetch(source.url, {
        headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" },
        cache: "no-store",
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) throw new Error(`${response.status}`);
      return { source, xml: await response.text() };
    }),
  );

  settled.forEach((outcome, index) => {
    const source = sources[index];

    if (outcome.status === "rejected") {
      results.push({
        source: source.name,
        ok: false,
        found: 0,
        kept: 0,
        error: outcome.reason instanceof Error ? outcome.reason.message : "unreachable",
      });
      return;
    }

    const items = parseFeed(outcome.value.xml, now);
    let kept = 0;

    for (const item of items.slice(0, 40)) {
      const text = `${item.title} ${item.summary}`;
      const tags = deriveTags(text, products);
      if (tags.length === 0) continue;

      kept += 1;
      signals.push({
        id: signalId(item.link, item.title),
        headline: item.title.slice(0, 200),
        summary: item.summary,
        nature: detectNature(text, source.assume ?? "commentary"),
        tags,
        source: source.name,
        at: item.at,
      });
    }

    results.push({ source: source.name, ok: true, found: items.length, kept });
  });

  return { signals, results };
}

/** Merge a poll into the store, newest first, without duplicating. */
export function merge(existing: Signal[], incoming: Signal[], keep = 200): Signal[] {
  const seen = new Set(existing.map((s) => s.id));
  const fresh = incoming.filter((s) => !seen.has(s.id));
  return [...fresh, ...existing].sort((a, b) => b.at - a.at).slice(0, keep);
}
