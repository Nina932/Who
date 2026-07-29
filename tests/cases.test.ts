import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LEAD_TO_CASH,
  assessRisk,
  availableEvents,
  candidatesFromCases,
  exampleCases,
  project,
  stageOf,
  type CaseEvent,
  type StoredCase,
} from "../lib/cases";
import { DEFAULT_CONTEXT, DEFAULT_WEIGHTS, rankWeek } from "../lib/priority";

/**
 * A case is a business record. The failure modes are not crashes — they are a
 * proposal that went quiet and nobody noticed, an accepted job that was never
 * invoiced, a "done" that was really "waiting". These pin the properties that
 * make the projection trustworthy enough to run a business on.
 */

const NOW = 1_800_000_000_000; // fixed clock; nothing here may read the wall
const DAY = 86_400_000;
const ago = (days: number) => NOW - days * DAY;

let seq = 0;
function ev(
  type: string,
  days: number,
  extra: Partial<CaseEvent> = {},
): CaseEvent {
  seq += 1;
  return { id: `e${seq}`, type, at: ago(days), actor: "operator", ...extra };
}

function build(events: CaseEvent[], overrides: Partial<StoredCase> = {}): StoredCase {
  return {
    id: "c1",
    title: "Test engagement",
    counterparty: "Acme",
    process: LEAD_TO_CASH.id,
    value: 5000,
    currency: "£",
    openedAt: ago(60),
    events,
    ...overrides,
  };
}

describe("the workflow", () => {
  it("has no stage you can enter and never leave, except the terminal ones", () => {
    for (const stage of LEAD_TO_CASH.stages) {
      if (stage.terminal) continue;
      assert.ok(
        Object.keys(stage.on).length > 0,
        `${stage.id} is a dead end but not marked terminal`,
      );
    }
  });

  it("only ever transitions to stages that exist", () => {
    for (const stage of LEAD_TO_CASH.stages) {
      for (const [type, target] of Object.entries(stage.on)) {
        assert.ok(
          stageOf(LEAD_TO_CASH, target),
          `${stage.id} --${type}--> ${target}, which is not a stage`,
        );
      }
    }
  });

  it("gives every non-mine, non-terminal stage a patience clock", () => {
    // The load-bearing rule. A stage where the turn is not mine and nothing
    // brings it back is exactly where work goes to die.
    for (const stage of LEAD_TO_CASH.stages) {
      if (stage.terminal || stage.turn === "mine") continue;
      assert.ok(stage.waiting, `${stage.id} can wait forever`);
    }
  });

  it("gives every mine stage something to actually do", () => {
    for (const stage of LEAD_TO_CASH.stages) {
      if (stage.turn !== "mine") continue;
      assert.ok(stage.action, `${stage.id} is my turn but names no action`);
    }
  });

  it("never grants execute authority to anything irreversible with money", () => {
    // Drafting an invoice is preparation. Sending one is a commercial act.
    for (const stage of LEAD_TO_CASH.stages) {
      for (const spec of [stage.action, stage.waiting?.escalation]) {
        if (!spec) continue;
        if (stage.loop !== "cash") continue;
        assert.notEqual(
          spec.authority,
          "execute",
          `${stage.id} would act on money unattended`,
        );
      }
    }
  });
});

describe("project", () => {
  it("replays the log rather than storing a position", () => {
    const record = build([
      ev("opened", 60),
      ev("qualified", 59),
      ev("proposal-sent", 58),
      ev("won", 50),
      ev("started", 49),
      ev("delivered", 20),
      ev("accepted", 19),
      ev("invoiced", 18),
      ev("paid", 2),
    ]);
    assert.equal(project(record, NOW).stage.id, "closed-won");
  });

  it("gives the same case a different state at a different moment", () => {
    // The property that makes an event log worth having: the past is queryable.
    const record = build([ev("opened", 60), ev("qualified", 59), ev("proposal-sent", 58), ev("won", 50)]);
    assert.equal(project(record, ago(55)).stage.id, "awaiting-decision");
    assert.equal(project(record, NOW).stage.id, "delivery-due");
  });

  it("applies events in timestamp order, not arrival order", () => {
    const record = build([ev("won", 50), ev("qualified", 59), ev("proposal-sent", 58)]);
    assert.equal(project(record, NOW).stage.id, "delivery-due");
  });

  it("keeps events the stage could not apply instead of dropping them", () => {
    const record = build([ev("opened", 60), ev("paid", 59)]);
    const view = project(record, NOW);
    assert.equal(view.stage.id, "inbound");
    assert.deepEqual(
      view.unapplied.map((u) => u.type),
      ["paid"],
    );
  });

  it("treats a note as history and nothing more", () => {
    const record = build([ev("opened", 60), ev("qualified", 59), ev("note", 3, { note: "chased by phone" })]);
    const view = project(record, NOW);
    assert.equal(view.stage.id, "proposal-due");
    assert.equal(view.events.length, 3);
  });
});

describe("whose turn it is", () => {
  it("is theirs while a proposal is fresh, and says who", () => {
    const record = build([ev("opened", 10), ev("qualified", 9), ev("proposal-sent", 2)]);
    const view = project(record, NOW);
    assert.equal(view.turn, "theirs");
    assert.match(view.waitingOn ?? "", /Acme/);
    assert.equal(view.action, null, "waiting is not doing");
  });

  it("comes back to me when patience runs out", () => {
    // Five days is the stage's tolerance. Nine is not "still waiting".
    const record = build([ev("opened", 20), ev("qualified", 19), ev("proposal-sent", 9)]);
    const view = project(record, NOW);
    assert.equal(view.turn, "mine");
    assert.equal(view.action?.derivedBy, "policy");
    assert.match(view.action?.title ?? "", /Follow up/);
    assert.match(view.action?.why ?? "", /Silent for 9 days/);
  });

  it("takes the turn off Morpheus too when the system stalls", () => {
    const record = build([ev("opened", 4)]);
    const view = project(record, NOW);
    assert.equal(view.stage.id, "inbound");
    assert.equal(view.turn, "mine");
    assert.match(view.action?.why ?? "", /Morpheus has held this/);
  });

  it("blocks override the stage, and name what is blocking", () => {
    const record = build([
      ev("opened", 30),
      ev("qualified", 29),
      ev("proposal-sent", 28),
      ev("won", 20),
      ev("started", 19),
      ev("blocked", 5, { note: "waiting on their API credentials" }),
    ]);
    const view = project(record, NOW);
    assert.equal(view.turn, "blocked");
    assert.match(view.blockedBy ?? "", /API credentials/);
    assert.equal(view.action, null, "a blocked case must not compete for the week");
  });

  it("unblocking hands the turn straight back", () => {
    const record = build([
      ev("opened", 30),
      ev("qualified", 29),
      ev("proposal-sent", 28),
      ev("won", 20),
      ev("started", 19),
      ev("blocked", 5, { note: "credentials" }),
      ev("unblocked", 1),
    ]);
    const view = project(record, NOW);
    assert.equal(view.turn, "mine");
    assert.equal(view.blockedBy, null);
  });

  it("a re-sent proposal restarts the clock", () => {
    const stale = build([ev("opened", 20), ev("qualified", 19), ev("proposal-sent", 9)]);
    const resent = build([
      ev("opened", 20),
      ev("qualified", 19),
      ev("proposal-sent", 9),
      ev("proposal-sent", 1, { note: "re-sent with revised scope" }),
    ]);
    assert.equal(project(stale, NOW).turn, "mine");
    assert.equal(project(resent, NOW).turn, "theirs");
  });

  it("a booked date lands on me before it arrives, not after", () => {
    const record = build([
      ev("opened", 30),
      ev("qualified", 29),
      ev("proposal-sent", 28),
      ev("won", 20),
      ev("scheduled", 19, { data: { dueAt: NOW + 1 * DAY } }),
    ]);
    const view = project(record, NOW);
    assert.equal(view.turn, "scheduled");
    assert.ok(view.action, "a booking a day out is already yours to plan");
    assert.match(view.action?.why ?? "", /Booked in 1 day/);
  });

  it("a booking far out is not yet anybody's problem", () => {
    const record = build([
      ev("opened", 30),
      ev("qualified", 29),
      ev("proposal-sent", 28),
      ev("won", 20),
      ev("scheduled", 19, { data: { dueAt: NOW + 20 * DAY } }),
    ]);
    const view = project(record, NOW);
    assert.equal(view.turn, "scheduled");
    assert.equal(view.action, null);
  });

  it("a passed booking becomes mine outright", () => {
    const record = build([
      ev("opened", 30),
      ev("qualified", 29),
      ev("proposal-sent", 28),
      ev("won", 20),
      ev("scheduled", 19, { data: { dueAt: NOW - 2 * DAY } }),
    ]);
    assert.equal(project(record, NOW).turn, "mine");
  });

  it("a reschedule with no new date does not silently keep the old one", () => {
    const record = build([
      ev("opened", 30),
      ev("qualified", 29),
      ev("proposal-sent", 28),
      ev("won", 20),
      ev("scheduled", 19, { data: { dueAt: NOW + 20 * DAY } }),
      ev("rescheduled", 1, { note: "they want to move it, date TBC" }),
    ]);
    const view = project(record, NOW);
    assert.equal(view.dueAt, null);
    assert.equal(view.turn, "mine", "a booking with no date is a thing to sort out");
  });

  it("a closed case is nobody's turn", () => {
    // Disqualification happens at the enquiry, before qualification — a lead
    // that dies *after* being qualified is `lost`, which is a different fact.
    const record = build([ev("opened", 60), ev("disqualified", 59)]);
    const view = project(record, NOW);
    assert.equal(view.turn, "complete");
    assert.equal(view.action, null);
    assert.deepEqual(availableEvents(view), []);
  });
});

describe("the gap between accepted and invoiced", () => {
  it("accepted work with no invoice is my turn and unblocks the money", () => {
    // The single most expensive silent failure in a solo business.
    const record = build([
      ev("opened", 60),
      ev("qualified", 59),
      ev("proposal-sent", 58),
      ev("won", 50),
      ev("started", 49),
      ev("delivered", 30),
      ev("accepted", 28),
    ]);
    const view = project(record, NOW);
    assert.equal(view.stage.id, "invoice-due");
    assert.equal(view.turn, "mine");
    assert.match(view.action?.title ?? "", /Invoice Acme for £5,000/);
    assert.ok((view.action?.factors.unblocks ?? 0) > 0);
  });

  it("delivered but unsigned chases them rather than sitting still", () => {
    const record = build([
      ev("opened", 60),
      ev("qualified", 59),
      ev("proposal-sent", 58),
      ev("won", 50),
      ev("started", 49),
      ev("delivered", 9),
    ]);
    const view = project(record, NOW);
    assert.equal(view.turn, "mine");
    assert.match(view.action?.title ?? "", /sign off/);
  });
});

describe("value", () => {
  it("an event can restate the amount, and the latest one wins", () => {
    const record = build([
      ev("opened", 60),
      ev("qualified", 59),
      ev("proposal-sent", 58),
      ev("won", 50, { data: { value: 7500 } }),
      ev("started", 49),
      ev("delivered", 30),
      ev("accepted", 28),
    ]);
    assert.equal(project(record, NOW).value, 7500);
    assert.match(project(record, NOW).action?.title ?? "", /£7,500/);
  });
});

describe("risk", () => {
  it("says nothing alarming about a case that is simply in time", () => {
    const record = build([ev("opened", 10), ev("qualified", 9), ev("proposal-sent", 2)]);
    assert.equal(project(record, NOW).risk.level, "none");
  });

  it("warns once patience is nearly spent, before it is", () => {
    const record = build([ev("opened", 10), ev("qualified", 9), ev("proposal-sent", 4.5)]);
    assert.equal(project(record, NOW).risk.level, "watch");
  });

  it("escalates to critical for money far past the point of asking", () => {
    const record = build([
      ev("opened", 200),
      ev("qualified", 199),
      ev("proposal-sent", 198),
      ev("won", 190),
      ev("started", 189),
      ev("delivered", 150),
      ev("accepted", 148),
      ev("invoiced", 146),
    ]);
    const view = project(record, NOW);
    assert.equal(view.risk.level, "critical");
    assert.match(view.risk.reason, /Money owed/);
  });

  it("a block is a risk even when nothing is late", () => {
    const risk = assessRisk(
      stageOf(LEAD_TO_CASH, "delivery-active")!,
      "blocked",
      -3,
      5000,
      "their legal review",
    );
    assert.equal(risk.level, "at-risk");
    assert.match(risk.reason, /legal review/);
  });
});

describe("candidatesFromCases", () => {
  const views = () => exampleCases(NOW).map((record) => project(record, NOW));

  it("emits nothing for cases that are somebody else's turn", () => {
    const waiting = views().filter((v) => v.turn === "theirs" || v.turn === "scheduled");
    const ids = new Set(candidatesFromCases(views()).map((c) => c.id));
    for (const view of waiting) {
      assert.ok(!ids.has(`case-${view.id}`), `${view.id} is being waited on, not done`);
    }
  });

  it("takes hours from the stage rather than inventing them", () => {
    for (const view of views()) {
      if (!view.action) continue;
      const candidate = candidatesFromCases([view])[0];
      assert.equal(candidate.hours, view.action.hours);
    }
  });

  it("names the counterparty in the origin, so no ranking is anonymous", () => {
    for (const candidate of candidatesFromCases(views())) {
      assert.ok(candidate.origin.trim().length > 0);
      assert.ok(candidate.origin.includes("·"));
    }
  });

  it("raises decay as something goes further past its patience", () => {
    const base = build([ev("opened", 20), ev("qualified", 19), ev("proposal-sent", 6)]);
    const worse = build([ev("opened", 40), ev("qualified", 39), ev("proposal-sent", 25)]);
    const [a] = candidatesFromCases([project(base, NOW)]);
    const [b] = candidatesFromCases([project(worse, NOW)]);
    assert.ok(b.factors.decay > a.factors.decay);
  });

  it("keeps every factor bounded at one, however overdue", () => {
    const ancient = build([ev("opened", 400), ev("qualified", 399), ev("proposal-sent", 380)]);
    const [candidate] = candidatesFromCases([project(ancient, NOW)]);
    for (const value of Object.values(candidate.factors)) {
      assert.ok(value <= 1 && value >= 0, `factor out of range: ${value}`);
    }
  });

  it("produces candidates the week can rank without further work", () => {
    const ranked = rankWeek(candidatesFromCases(views()), DEFAULT_WEIGHTS, DEFAULT_CONTEXT);
    assert.ok(ranked.length > 0);
    const committed = ranked
      .filter((r) => r.chosen)
      .reduce((sum, r) => sum + r.candidate.hours, 0);
    assert.ok(committed <= DEFAULT_CONTEXT.capacityHours);
  });
});

describe("the examples", () => {
  it("cover every turn state, because the turn model is the whole claim", () => {
    const turns = new Set(exampleCases(NOW).map((record) => project(record, NOW).turn));
    for (const turn of ["mine", "theirs", "system", "scheduled", "blocked", "complete"] as const) {
      assert.ok(turns.has(turn), `no example demonstrates "${turn}"`);
    }
  });

  it("are all marked as examples, every one", () => {
    assert.ok(exampleCases(NOW).every((record) => record.demo === true));
    assert.ok(exampleCases(NOW).map((r) => project(r, NOW)).every((v) => v.demo));
  });

  it("include the overdue invoice, because that is the point", () => {
    const overdue = exampleCases(NOW)
      .map((record) => project(record, NOW))
      .find((view) => view.stage.id === "awaiting-payment");
    assert.ok(overdue, "no example is waiting on money");
    assert.equal(overdue.turn, "mine", "56 days is not still waiting");
    assert.equal(overdue.risk.level, "critical");
  });
});
