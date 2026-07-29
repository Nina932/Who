/**
 * Turning a calendar into an honest number.
 *
 * `bookedHours` was a field nothing filled, so the brief always said "no
 * calendar connected". This is the arithmetic that fills it, kept pure and
 * separate from the fetch so the awkward parts — overlapping meetings, events
 * that started before you looked, all-day blocks that are not actually time —
 * can be tested without a network.
 *
 * The number that matters is not "how long are today's meetings". It is **how
 * much of the working time you have left is already spoken for**, which means
 * clipping every event to the window between now and the end of your day.
 */

export interface Busy {
  start: number;
  end: number;
  summary?: string;
  /** All-day entries are markers, not commitments of time. */
  allDay?: boolean;
  /** Events you declined do not occupy you. */
  declined?: boolean;
}

/**
 * Hours of the window already committed.
 *
 * Overlaps are merged rather than summed: two meetings double-booked at the
 * same hour cost you one hour, and reporting two would understate your
 * capacity — which is the direction that makes an assistant useless, because
 * it starts telling you that you have no time when you do.
 */
export function bookedHoursIn(events: Busy[], windowStart: number, windowEnd: number): number {
  if (windowEnd <= windowStart) return 0;

  const clipped = events
    .filter((event) => !event.allDay && !event.declined)
    .map((event) => ({
      start: Math.max(event.start, windowStart),
      end: Math.min(event.end, windowEnd),
    }))
    .filter((span) => span.end > span.start)
    .sort((a, b) => a.start - b.start);

  let total = 0;
  let cursor = -Infinity;

  for (const span of clipped) {
    const from = Math.max(span.start, cursor);
    if (span.end > from) {
      total += span.end - from;
      cursor = span.end;
    }
  }

  return Math.round((total / 3_600_000) * 100) / 100;
}

interface RawEvent {
  summary?: string;
  status?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: Array<{ self?: boolean; responseStatus?: string }>;
}

/** Google's event shape, reduced to the four things that decide busyness. */
export function toBusy(events: RawEvent[]): Busy[] {
  return events
    .filter((event) => event.status !== "cancelled")
    .map((event) => {
      const allDay = Boolean(event.start?.date && !event.start?.dateTime);
      const start = Date.parse(event.start?.dateTime ?? event.start?.date ?? "");
      const end = Date.parse(event.end?.dateTime ?? event.end?.date ?? "");
      const self = event.attendees?.find((a) => a.self);

      return {
        start,
        end,
        summary: event.summary,
        allDay,
        declined: self?.responseStatus === "declined",
      };
    })
    .filter((busy) => Number.isFinite(busy.start) && Number.isFinite(busy.end));
}
