import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  calendarAgendaReply,
  requestsCalendarAgenda,
} from "../lib/calendar-intent";
import type { Turn } from "../lib/orchestrator";

describe("calendar conversation truth", () => {
  it("recognises schedule reads but not event creation", () => {
    assert.equal(
      requestsCalendarAgenda("do I have anything scheduled on calendar today"),
      true,
    );
    assert.equal(
      requestsCalendarAgenda("add a meeting to my calendar tomorrow"),
      false,
    );
  });

  it("keeps a calendar verification follow-up grounded", () => {
    const history: Turn[] = [
      { id: "1", role: "operator", text: "you have my calendar", at: 1 },
    ];
    assert.equal(
      requestsCalendarAgenda("double check because you have it", history),
      true,
    );
  });

  it("reports live events instead of claiming the connector is absent", () => {
    const reply = calendarAgendaReply({
      ok: true,
      data: [
        {
          summary: "Nino's Zoom meeting",
          start: { dateTime: "2026-07-29T20:30:00+04:00" },
        },
      ],
    });
    assert.match(reply, /connected and responding/i);
    assert.match(reply, /Zoom meeting/);
  });
});
