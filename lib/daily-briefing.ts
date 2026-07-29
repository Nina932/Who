import { allProducts } from "./assistant-store";
import { timeZone } from "./ambient";
import {
  listCalendarEvents,
  listRecentMail,
  upcomingCalendarEvents,
  type CalendarEvent,
  type CallOutcome,
  type GmailConnectorId,
  type MailHeader,
} from "./connectors";
import {
  fetchLiveNews,
  type LiveHeadline,
  type LiveNewsContext,
} from "./live-news";
import {
  allFacts,
  groundedInOperator,
  type Fact,
} from "./memory";
import { getOperatorContext, type OperatorContext } from "./operator-context";
import type { Product } from "./products";

export type BriefingSourceState = "live" | "empty" | "unavailable";

export interface DailyBriefingLine {
  id: "calendar" | "mail" | "news" | "projects";
  label: string;
  text: string;
  detail?: string;
  href?: string;
  external?: boolean;
  state: BriefingSourceState;
}

export interface DailyBriefing {
  generatedAt: number;
  summary: string;
  lines: DailyBriefingLine[];
  headlines: LiveHeadline[];
  almanac: string;
  coverage: {
    live: number;
    total: number;
  };
}

interface DailyBriefingDependencies {
  calendar: () => Promise<CallOutcome<CalendarEvent[]>>;
  mail: (
    connectorId: GmailConnectorId,
  ) => Promise<CallOutcome<MailHeader[]>>;
  news: () => Promise<LiveNewsContext>;
  products: () => Promise<Product[]>;
  operatorContext: () => Promise<OperatorContext>;
  memory: () => Promise<Fact[]>;
}

const IMPORTANT_UNREAD = "is:unread {label:important is:starred}";

const DEFAULT_DEPENDENCIES: DailyBriefingDependencies = {
  calendar: () => listCalendarEvents(1),
  mail: (connectorId) => listRecentMail(6, connectorId, IMPORTANT_UNREAD),
  news: () => fetchLiveNews(""),
  products: allProducts,
  operatorContext: getOperatorContext,
  memory: allFacts,
};

const TOPIC_STOP = new Set([
  "about", "after", "again", "also", "around", "because", "before", "being",
  "briefing", "could", "from", "have", "important", "into", "latest", "morpheus",
  "news", "only", "please", "should", "that", "their", "there", "these", "this",
  "today", "using", "want", "what", "when", "where", "which", "with", "working",
  "would", "your",
]);

function clean(value: string | undefined, fallback: string): string {
  const compact = value?.replace(/\s+/g, " ").trim();
  return compact || fallback;
}

function clip(value: string, max = 92): string {
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

function sourceFailure(error: string): string {
  if (/connect|token|grant|oauth/i.test(error)) return "Not connected";
  return "Temporarily unavailable";
}

function workingTerms(
  products: Product[],
  context: OperatorContext,
  facts: Fact[],
): string[] {
  const recentSources = [...facts]
    .filter(
      (fact) =>
        ["goal", "constraint", "decision"].includes(fact.kind) &&
        (fact.grounded === true || groundedInOperator(fact.text, fact.source)),
    )
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 12)
    .map((fact) => fact.source);
  const text = [
    ...products
      .filter((product) => !product.archived && product.phase !== "paused")
      .flatMap((product) => [product.name, product.objective]),
    context.projectNotes,
    ...recentSources,
  ].join(" ");
  const counts = new Map<string, number>();
  for (const term of text
    .toLowerCase()
    .split(/[^\p{L}\p{N}+#.-]+/gu)
    .map((value) => value.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((value) => value.length >= 4 && !TOPIC_STOP.has(value))) {
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([term]) => term);
}

function relevance(text: string, terms: string[]): number {
  const haystack = text.toLowerCase();
  return terms.reduce(
    (score, term, index) =>
      score + (haystack.includes(term) ? Math.max(1, 6 - index) : 0),
    0,
  );
}

function calendarLine(
  outcome: CallOutcome<CalendarEvent[]>,
  now: number,
): DailyBriefingLine {
  if (!outcome.ok) {
    return {
      id: "calendar",
      label: "Calendar",
      text: sourceFailure(outcome.error),
      detail: outcome.error,
      href: "/connect",
      state: "unavailable",
    };
  }

  const futureEvents = upcomingCalendarEvents(outcome.data, now);
  const next = futureEvents[0];
  if (!next) {
    return {
      id: "calendar",
      label: "Calendar",
      text: "No events in the next 24 hours",
      href: "/today",
      state: "empty",
    };
  }

  const startsAt = next.start?.dateTime ?? next.start?.date;
  const time = startsAt
      ? new Intl.DateTimeFormat("en", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: timeZone(),
      }).format(new Date(startsAt))
    : "time not set";
  const remainder = futureEvents.length - 1;

  return {
    id: "calendar",
    label: "Calendar",
    text: `${time} · ${clip(clean(next.summary, "Untitled event"), 64)}`,
    detail: remainder > 0 ? `+${remainder} more in the next 24 hours` : "Next event",
    href: next.htmlLink ?? "/today",
    external: Boolean(next.htmlLink),
    state: "live",
  };
}

function mailLine(
  personal: CallOutcome<MailHeader[]>,
  company: CallOutcome<MailHeader[]>,
  terms: string[],
): DailyBriefingLine {
  const reached = [
    personal.ok ? { name: "Personal", items: personal.data } : null,
    company.ok ? { name: "Company", items: company.data } : null,
  ].filter((row): row is { name: string; items: MailHeader[] } => row !== null);

  if (!reached.length) {
    const errors = [personal, company]
      .filter((result) => !result.ok)
      .map((result) => (result.ok ? "" : result.error))
      .filter(Boolean);
    return {
      id: "mail",
      label: "Priority mail",
      text: errors.some((error) => /connect|token|grant|oauth/i.test(error))
        ? "Mailboxes need reconnection"
        : "Mailboxes temporarily unavailable",
      detail: errors.join(" · "),
      href: "/connect",
      state: "unavailable",
    };
  }

  const count = reached.reduce((sum, mailbox) => sum + mailbox.items.length, 0);
  const loaded = reached
    .flatMap((mailbox) =>
      mailbox.items.map((item) => ({ ...item, mailbox: mailbox.name })),
    );
  const first = loaded
    .map((item, index) => ({
      item,
      index,
      score: relevance(`${item.subject ?? ""} ${item.snippet ?? ""}`, terms),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)[0]?.item;

  if (!first) {
    return {
      id: "mail",
      label: "Priority mail",
      text: "No starred or important unread messages",
      detail:
        reached.length === 2
          ? "Personal + Company checked"
          : `${reached[0].name} checked · other mailbox unavailable`,
      href: "/connect",
      state: "empty",
    };
  }

  return {
    id: "mail",
    label: "Priority mail",
    text: `${count} priority unread loaded · ${clip(clean(first.subject, "No subject"), 54)}`,
    detail: `${first.mailbox} · ${clip(clean(first.from, "Unknown sender"), 64)}`,
    href: "/connect",
    state: "live",
  };
}

function newsLine(
  context: LiveNewsContext,
  terms: string[],
): { line: DailyBriefingLine; headlines: LiveHeadline[] } {
  const reached = context.sources.filter((source) => source.ok).length;
  const headlines = context.headlines
    .map((headline, index) => ({
      headline,
      index,
      score: relevance(`${headline.title} ${headline.summary}`, terms),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ headline }) => headline);
  const first = headlines[0];

  if (!first) {
    return {
      headlines,
      line: {
        id: "news",
        label: "Live intel",
        text: reached
          ? "Sources checked; no current matching headlines"
          : "News sources temporarily unavailable",
        detail: `${reached}/${context.sources.length} bounded sources reached`,
        state: reached ? "empty" : "unavailable",
      },
    };
  }

  return {
    headlines,
    line: {
      id: "news",
      label: terms.length ? "Relevant intel" : "Live intel",
      text: clip(first.title),
      detail: `${first.source} · ${new Date(first.at).toLocaleDateString("en")}`,
      href: first.link,
      external: true,
      state: "live",
    },
  };
}

function projectLine(
  products: Product[],
  context: OperatorContext,
  terms: string[],
): DailyBriefingLine {
  const active = products.filter(
    (product) => !product.archived && product.phase !== "paused",
  );
  const first = active[0];
  if (first) {
    return {
      id: "projects",
      label: "Focus",
      text: clip(`${first.name} · ${first.objective}`),
      detail:
        active.length > 1
          ? `${active.length} active projects saved`
          : `${first.phase.replace(/-/g, " ")} phase`,
      href: "/products",
      state: "live",
    };
  }

  const notes = clean(context.projectNotes, "");
  if (notes) {
    return {
      id: "projects",
      label: "Focus",
      text: clip(notes),
      detail: "From your saved project context",
      href: "/connect",
      state: "live",
    };
  }

  return {
    id: "projects",
    label: "Focus",
    text: "No active projects saved",
    detail: terms.length
      ? `Recent themes: ${terms.slice(0, 3).join(" · ")} · save a project to rank work`
      : "Add project context to make this relevant",
    href: "/products",
    state: "empty",
  };
}

function briefingSummary(lines: DailyBriefingLine[]): string {
  const calendar = lines.find((line) => line.id === "calendar");
  const mail = lines.find((line) => line.id === "mail");
  const projects = lines.find((line) => line.id === "projects");
  const parts: string[] = [];

  if (mail?.state === "live") {
    const count = mail.text.match(/^(\d+)/)?.[1];
    parts.push(
      count
        ? `At least ${count} priority emails need review`
        : "Priority email needs review",
    );
  }
  if (calendar?.state === "live") {
    parts.push(`Next: ${calendar.text}`);
  }
  if (projects?.state === "live") {
    parts.push(`Focus: ${projects.text}`);
  } else {
    parts.push("Project priority cannot be ranked until an active project is saved");
  }
  if (!parts.length) return "Connected sources were checked; nothing urgent was verified.";
  return `${parts.slice(0, 3).join(". ")}.`;
}

export async function buildDailyBriefing(
  almanac: string,
  now = Date.now(),
  dependencies: DailyBriefingDependencies = DEFAULT_DEPENDENCIES,
): Promise<DailyBriefing> {
  const [calendar, personal, company, news, products, operatorContext, facts] =
    await Promise.all([
      dependencies.calendar(),
      dependencies.mail("gmail"),
      dependencies.mail("gmail-company"),
      dependencies.news(),
      dependencies.products(),
      dependencies.operatorContext(),
      dependencies.memory(),
    ]);

  const terms = workingTerms(products, operatorContext, facts);
  const rankedNews = newsLine(news, terms);
  const lines = [
    calendarLine(calendar, now),
    mailLine(personal, company, terms),
    rankedNews.line,
    projectLine(products, operatorContext, terms),
  ];

  return {
    generatedAt: now,
    summary: briefingSummary(lines),
    lines,
    headlines: rankedNews.headlines,
    almanac,
    coverage: {
      live: lines.filter((line) => line.state !== "unavailable").length,
      total: lines.length,
    },
  };
}
