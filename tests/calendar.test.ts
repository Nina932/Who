import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { greeting, hoursLeftToday, localHour } from "../lib/ambient";
import { bookedHoursIn, toBusy, type Busy } from "../lib/calendar";

/**
 * Two things that were quietly wrong: the brief greeted the operator using the
 * *server's* clock, and `bookedHours` was a field nothing filled. Both are
 * small, and both make everything else on the page feel guessed at.
 */

const HOUR = 3_600_000;
const NOON = Date.parse("2025-07-01T12:00:00Z");

const busy = (fromHour: number, toHour: number, extra: Partial<Busy> = {}): Busy => ({
  start: NOON + fromHour * HOUR,
  end: NOON + toHour * HOUR,
  ...extra,
});

describe("bookedHoursIn", () => {
  it("sums meetings inside the window", () => {
    assert.equal(bookedHoursIn([busy(0, 1), busy(2, 3.5)], NOON, NOON + 6 * HOUR), 2.5);
  });

  it("merges overlaps instead of double-counting them", () => {
    // Two meetings double-booked at the same hour cost you one hour. Summing
    // them would understate your capacity, which is the direction that makes
    // an assistant useless — it starts insisting you have no time when you do.
    assert.equal(bookedHoursIn([busy(0, 2), busy(1, 3)], NOON, NOON + 6 * HOUR), 3);
  });

  it("merges a meeting entirely contained in another", () => {
    assert.equal(bookedHoursIn([busy(0, 4), busy(1, 2)], NOON, NOON + 6 * HOUR), 4);
  });

  it("clips a meeting that started before you looked", () => {
    assert.equal(bookedHoursIn([busy(-2, 1)], NOON, NOON + 6 * HOUR), 1);
  });

  it("clips a meeting that runs past the end of your day", () => {
    assert.equal(bookedHoursIn([busy(5, 9)], NOON, NOON + 6 * HOUR), 1);
  });

  it("ignores anything wholly outside the window", () => {
    assert.equal(bookedHoursIn([busy(-5, -4), busy(8, 9)], NOON, NOON + 6 * HOUR), 0);
  });

  it("ignores all-day entries — they are markers, not time", () => {
    assert.equal(bookedHoursIn([busy(0, 8, { allDay: true })], NOON, NOON + 6 * HOUR), 0);
  });

  it("ignores meetings you declined", () => {
    assert.equal(bookedHoursIn([busy(0, 2, { declined: true })], NOON, NOON + 6 * HOUR), 0);
  });

  it("returns zero for a window that has already closed", () => {
    assert.equal(bookedHoursIn([busy(0, 2)], NOON, NOON - HOUR), 0);
  });
});

describe("toBusy", () => {
  it("reads a timed event", () => {
    const [event] = toBusy([
      {
        summary: "Call",
        start: { dateTime: "2025-07-01T12:00:00Z" },
        end: { dateTime: "2025-07-01T13:00:00Z" },
      },
    ]);
    assert.equal(event.end - event.start, HOUR);
    assert.equal(event.allDay, false);
  });

  it("marks an all-day event as such rather than as eight hours of work", () => {
    const [event] = toBusy([{ start: { date: "2025-07-01" }, end: { date: "2025-07-02" } }]);
    assert.equal(event.allDay, true);
  });

  it("notices that you declined", () => {
    const [event] = toBusy([
      {
        start: { dateTime: "2025-07-01T12:00:00Z" },
        end: { dateTime: "2025-07-01T13:00:00Z" },
        attendees: [{ self: true, responseStatus: "declined" }],
      },
    ]);
    assert.equal(event.declined, true);
  });

  it("drops cancelled events", () => {
    assert.deepEqual(
      toBusy([
        {
          status: "cancelled",
          start: { dateTime: "2025-07-01T12:00:00Z" },
          end: { dateTime: "2025-07-01T13:00:00Z" },
        },
      ]),
      [],
    );
  });

  it("drops an event with an unparseable date rather than emitting NaN", () => {
    assert.deepEqual(toBusy([{ start: { dateTime: "not a date" }, end: {} }]), []);
  });
});

describe("localHour", () => {
  it("uses the operator's zone, not the host's", () => {
    const previous = process.env.MORPHEUS_TZ;
    try {
      // 12:00 UTC is 16:00 in Tbilisi. A UTC host would say "afternoon" at
      // one and "morning" at the other for the very same instant.
      process.env.MORPHEUS_TZ = "Asia/Tbilisi";
      assert.equal(localHour(NOON), 16);
      process.env.MORPHEUS_TZ = "UTC";
      assert.equal(localHour(NOON), 12);
    } finally {
      if (previous === undefined) delete process.env.MORPHEUS_TZ;
      else process.env.MORPHEUS_TZ = previous;
    }
  });

  it("falls back to the host rather than throwing on a bad zone", () => {
    const previous = process.env.MORPHEUS_TZ;
    try {
      process.env.MORPHEUS_TZ = "Not/AZone";
      assert.equal(localHour(NOON), new Date(NOON).getHours());
    } finally {
      if (previous === undefined) delete process.env.MORPHEUS_TZ;
      else process.env.MORPHEUS_TZ = previous;
    }
  });
});

describe("greeting", () => {
  it("does not call six in the morning 'morning'", () => {
    // Someone up at six has been up a while. "Good morning" reads as a script.
    assert.equal(greeting(6), "Early start");
    assert.equal(greeting(9), "Good morning");
  });

  it("covers the whole clock", () => {
    for (let hour = 0; hour < 24; hour += 1) {
      assert.ok(greeting(hour).length > 0, `no greeting for ${hour}`);
    }
  });

  it("knows the difference between evening and very late", () => {
    assert.equal(greeting(20), "Good evening");
    assert.equal(greeting(23), "Late one");
    assert.equal(greeting(2), "Still up");
  });
});

describe("hoursLeftToday", () => {
  const withEnv = (env: Record<string, string>, fn: () => void) => {
    const saved: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(env)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    try {
      fn();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };

  it("gives the whole day before it starts", () => {
    withEnv({ MORPHEUS_TZ: "UTC", MORPHEUS_DAY_START: "9", MORPHEUS_DAY_END: "18" }, () => {
      assert.equal(hoursLeftToday(Date.parse("2025-07-01T06:00:00Z")), 9);
    });
  });

  it("shrinks as the day goes", () => {
    withEnv({ MORPHEUS_TZ: "UTC", MORPHEUS_DAY_START: "9", MORPHEUS_DAY_END: "18" }, () => {
      // The whole point: at four in the afternoon you do not have six hours,
      // and a plan that says you do is a plan you will not finish.
      assert.equal(hoursLeftToday(Date.parse("2025-07-01T16:00:00Z")), 2);
      assert.equal(hoursLeftToday(Date.parse("2025-07-01T17:30:00Z")), 0.5);
    });
  });

  it("is zero once the day is over", () => {
    withEnv({ MORPHEUS_TZ: "UTC", MORPHEUS_DAY_START: "9", MORPHEUS_DAY_END: "18" }, () => {
      assert.equal(hoursLeftToday(Date.parse("2025-07-01T21:00:00Z")), 0);
    });
  });

  it("is measured in the operator's zone", () => {
    withEnv({ MORPHEUS_TZ: "Asia/Tbilisi", MORPHEUS_DAY_START: "9", MORPHEUS_DAY_END: "18" }, () => {
      // 16:00 in Tbilisi is 12:00 UTC. A UTC host would report six hours left.
      assert.equal(hoursLeftToday(NOON), 2);
    });
  });
});
