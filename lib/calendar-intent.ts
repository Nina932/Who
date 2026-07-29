import type {
  CalendarEvent,
  CallOutcome,
} from "./connectors";
import type { Turn } from "./orchestrator";

export function requestsCalendarAgenda(
  utterance: string,
  history: Turn[] = [],
): boolean {
  const current = utterance.trim();
  if (
    /^(?:add|create|book|schedule|put)\b/i.test(current) ||
    /\b(?:add|create|book|schedule)\b[\s\S]*\b(?:event|meeting|calendar)\b/i.test(
      current,
    )
  ) {
    return false;
  }

  const recent = [
    ...history
      .filter((turn) => turn.role === "operator")
      .slice(-2)
      .map((turn) => turn.text),
    current,
  ].join(" ");
  return (
    /\bcalendar\b/i.test(recent) &&
    /\b(?:do i have|anything scheduled|what(?:'s| is) scheduled|events?|meetings?|scheduled (?:there|today)|check|double check|show|see|you have (?:a )?calendar)\b/i.test(
      recent,
    )
  );
}

function eventTime(event: CalendarEvent): string {
  const raw = event.start?.dateTime ?? event.start?.date;
  if (!raw) return "time not set";
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) return "time not set";
  return new Intl.DateTimeFormat("en", {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function calendarAgendaReply(
  outcome: CallOutcome<CalendarEvent[]>,
): string {
  if (!outcome.ok) {
    return outcome.needsConnection
      ? "Google Calendar is not connected. The live calendar check returned a connection requirement."
      : `I reached the calendar path, but it did not return events: ${outcome.error}`;
  }
  if (!outcome.data.length) {
    return "Google Calendar is connected and responding. There are no upcoming events in the next 24 hours.";
  }
  const events = outcome.data.slice(0, 4).map(
    (event) => `${eventTime(event)} — ${event.summary?.trim() || "Untitled event"}`,
  );
  return [
    "Google Calendar is connected and responding. Upcoming:",
    ...events,
  ].join("\n");
}
