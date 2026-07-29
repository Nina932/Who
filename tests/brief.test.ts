import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildBrief, shouldInterrupt, type BriefInput } from "../lib/brief";
import { exampleCases, project, type CaseView } from "../lib/cases";
import type { Entry } from "../lib/knowledge";
import { exampleKnowledge, exampleProducts } from "../lib/products";

/**
 * The brief is the assistant's face, so its failure mode is the worst one in
 * the system: fluent, confident, and made up. These pin the properties that
 * make it derived rather than composed — every item traceable to a case, a
 * blocker or a dated promise, every cut explained, and capacity never
 * flattered.
 */

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

const cases = (): CaseView[] => exampleCases(NOW).map((r) => project(r, NOW));

function input(overrides: Partial<BriefInput> = {}): BriefInput {
  return {
    now: NOW,
    operator: "Nino",
    cases: cases(),
    products: exampleProducts(NOW),
    entries: exampleKnowledge(NOW),
    capacity: { plannedHours: 6, bookedHours: null },
    history: [],
    ...overrides,
  };
}

describe("capacity", () => {
  it("says plainly when no calendar has been checked", () => {
    const brief = buildBrief(input());
    assert.match(brief.capacity.note, /No calendar connected/);
    assert.equal(brief.capacity.realisticHours, 6);
  });

  it("subtracts what the calendar already holds", () => {
    const brief = buildBrief(input({ capacity: { plannedHours: 6, bookedHours: 3 } }));
    assert.equal(brief.capacity.realisticHours, 3);
  });

  it("calls out a day that is mostly already spoken for", () => {
    const brief = buildBrief(input({ capacity: { plannedHours: 6, bookedHours: 5 } }));
    assert.match(brief.capacity.note, /already spoken for/);
  });

  it("never commits more time than actually exists", () => {
    for (const plannedHours of [1, 3, 6, 12]) {
      const brief = buildBrief(input({ capacity: { plannedHours, bookedHours: null } }));
      assert.ok(
        brief.committedMinutes <= plannedHours * 60,
        `committed ${brief.committedMinutes}m against ${plannedHours * 60}m`,
      );
    }
  });
});

describe("what makes the list", () => {
  it("gives every item a reason, a now, and a cost of delay", () => {
    for (const item of buildBrief(input()).items) {
      assert.ok(item.matters.length > 10, `${item.title} has no reason`);
      assert.ok(item.now.length > 10, `${item.title} does not say why today`);
      assert.ok(item.ifDelayed.length > 10, `${item.title} claims no cost to waiting`);
      assert.ok(item.minutes > 0);
    }
  });

  it("traces every item to a case, a release blocker or a commitment", () => {
    // Nothing may appear that was not derived from recorded state.
    for (const item of buildBrief(input()).items) {
      assert.ok(["case", "commitment", "blocker"].includes(item.source));
    }
  });

  it("pulls release blockers in as work in their own right", () => {
    const brief = buildBrief(input({ capacity: { plannedHours: 20, bookedHours: null } }));
    assert.ok(brief.items.some((i) => i.source === "blocker"));
  });

  it("gives blocker time to exactly one product, and says which", () => {
    // Otherwise the brief schedules a day split across two stuck products
    // while the same system advises against running two at once.
    const brief = buildBrief(input({ capacity: { plannedHours: 40, bookedHours: null } }));
    const subjects = new Set(
      brief.items.filter((i) => i.source === "blocker").map((i) => i.subject),
    );
    assert.equal(subjects.size, 1, `blocker work spread across ${[...subjects].join(", ")}`);
    assert.ok(brief.focus);
    assert.equal(brief.focus?.productName, [...subjects][0]);
    assert.match(brief.focus?.note ?? "", /unsticks neither/);
  });

  it("picks the product that has carried its blockers longest", () => {
    const brief = buildBrief(input({ capacity: { plannedHours: 40, bookedHours: null } }));
    // FinAI's oldest release blocker is 38 days; G8's is 24.
    assert.equal(brief.focus?.productName, "FinAI");
  });

  it("has no focus when nothing is blocked", () => {
    assert.equal(buildBrief(input({ products: [] })).focus, null);
  });

  it("pulls in a commitment as its date arrives", () => {
    const brief = buildBrief(input({ capacity: { plannedHours: 20, bookedHours: null } }));
    assert.ok(brief.items.some((i) => i.source === "commitment"));
  });

  it("does not tell you a commitment is late when it is due tomorrow", () => {
    // The small lie that costs an assistant its credibility permanently.
    const brief = buildBrief(input({ capacity: { plannedHours: 20, bookedHours: null } }));
    const commitment = brief.items.find((i) => i.source === "commitment");
    assert.ok(commitment);
    assert.match(commitment.now, /Due in 1 day/);
    assert.ok(!/past the date/.test(commitment.now));
  });

  it("does say so when a commitment really has passed", () => {
    const entries = exampleKnowledge(NOW).map((e) =>
      e.kind === "commitment" ? { ...e, dueAt: NOW - 4 * DAY } : e,
    );
    const brief = buildBrief(
      input({ entries, capacity: { plannedHours: 20, bookedHours: null } }),
    );
    const commitment = brief.items.find((i) => i.source === "commitment");
    assert.match(commitment?.now ?? "", /4 days past the date you gave/);
  });

  it("leaves waiting work off entirely — it is not today's work", () => {
    const brief = buildBrief(input({ capacity: { plannedHours: 40, bookedHours: null } }));
    const waiting = cases().filter((c) => c.turn === "theirs" || c.turn === "scheduled");
    assert.ok(waiting.length > 0, "the fixture should contain waiting cases");
    for (const view of waiting) {
      assert.ok(!brief.items.some((i) => i.key === `case-${view.id}`));
    }
    assert.equal(brief.waitingCount, waiting.length);
  });

  it("counts blocked cases as neither today's work nor waiting on a person", () => {
    const brief = buildBrief(input({ capacity: { plannedHours: 40, bookedHours: null } }));
    const blocked = cases().find((c) => c.turn === "blocked");
    assert.ok(blocked);
    assert.ok(!brief.items.some((i) => i.key === `case-${blocked.id}`));
  });
});

describe("what gets cut, and why", () => {
  it("explains every deferral rather than dropping it", () => {
    const brief = buildBrief(input({ capacity: { plannedHours: 1, bookedHours: null } }));
    assert.ok(brief.deferred.length > 0);
    for (const row of brief.deferred) {
      assert.ok(row.reason.length > 10, `${row.title} was cut with no reason`);
    }
  });

  it("says it is a room problem when it is a room problem", () => {
    const brief = buildBrief(input({ capacity: { plannedHours: 0.5, bookedHours: null } }));
    assert.ok(brief.deferred.some((d) => /no room left today/.test(d.reason)));
  });

  it("nothing is silently lost — every candidate is listed or deferred", () => {
    const brief = buildBrief(input({ capacity: { plannedHours: 2, bookedHours: null } }));
    const keys = new Set([...brief.items.map((i) => i.key), ...brief.deferred.map((d) => d.key)]);
    // One entry per candidate, and none appearing in both lists.
    assert.equal(keys.size, brief.items.length + brief.deferred.length);
  });
});

describe("avoidance", () => {
  it("stays silent on something that has come up twice", () => {
    const first = buildBrief(input());
    const keys = first.items.map((i) => i.key);
    const history = [
      { at: NOW - DAY, itemKeys: keys },
      { at: NOW - 2 * DAY, itemKeys: keys },
    ];
    assert.deepEqual(buildBrief(input({ history })).avoided, []);
  });

  it("names what you have skipped three days running", () => {
    const first = buildBrief(input());
    const keys = first.items.map((i) => i.key);
    const history = [1, 2, 3].map((d) => ({ at: NOW - d * DAY, itemKeys: keys }));
    const brief = buildBrief(input({ history }));
    assert.ok(brief.avoided.length > 0);
    assert.ok(brief.avoided.every((i) => i.appearances >= 3));
  });

  it("resets the count when a day passes without it", () => {
    const first = buildBrief(input());
    const keys = first.items.map((i) => i.key);
    const history = [
      { at: NOW - DAY, itemKeys: keys },
      { at: NOW - 2 * DAY, itemKeys: [] },
      { at: NOW - 3 * DAY, itemKeys: keys },
    ];
    assert.deepEqual(buildBrief(input({ history })).avoided, []);
  });
});

describe("horizons", () => {
  it("ties today to the objective and the milestone for each live product", () => {
    for (const link of buildBrief(input()).horizons) {
      assert.ok(link.today.length > 0);
      assert.ok(link.week.length > 0);
      assert.match(link.phase, /conditions evidenced/);
    }
  });

  it("says so when nothing today moves a product at all", () => {
    const brief = buildBrief(
      input({ cases: [], capacity: { plannedHours: 0.1, bookedHours: null } }),
    );
    assert.ok(brief.horizons.some((h) => /Nothing today moves/.test(h.today)));
  });
});

describe("advisories in the brief", () => {
  it("surfaces a hypothesis carried past its shelf life", () => {
    const brief = buildBrief(input());
    assert.ok(brief.advisories.some((a) => a.rule === "untested-hypothesis"));
  });

  it("never cites a hypothesis as its own evidence", () => {
    const entries: Entry[] = exampleKnowledge(NOW);
    const byId = new Map(entries.map((e) => [e.id, e]));
    for (const advisory of buildBrief(input()).advisories) {
      for (const ref of advisory.evidence) {
        assert.notEqual(byId.get(ref)?.kind, "hypothesis");
      }
    }
  });
});

describe("shouldInterrupt", () => {
  const none = {
    requiresDecision: false,
    requiresAction: false,
    changesPlan: false,
    createsRisk: false,
    timeSensitive: false,
  };

  it("does not interrupt for something merely interesting", () => {
    assert.equal(shouldInterrupt(none), false);
  });

  it("does not interrupt on one test alone", () => {
    // One box ticked is a digest line. An assistant that interrupts on one
    // gets muted, and then it is not there for the things that mattered.
    assert.equal(shouldInterrupt({ ...none, timeSensitive: true }), false);
  });

  it("interrupts when two hold", () => {
    assert.equal(shouldInterrupt({ ...none, timeSensitive: true, createsRisk: true }), true);
  });
});
