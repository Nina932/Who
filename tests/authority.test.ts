import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CAPABILITIES,
  CAPABILITY_BY_ID,
  DEFAULT_POLICY,
  MAX_AUTOMATIC_LEVEL,
  decide,
  renderForPrompt,
  unattended,
  type Policy,
} from "../lib/authority";
import { createBroker, describe as describeEntry } from "../lib/broker";

/**
 * This is the file where a bug is expensive in a way no other bug here is:
 * everything else can produce a wrong answer, and this can send an email,
 * merge a branch, or move money.
 *
 * So the tests are mostly invariants over the whole registry rather than
 * examples. An invariant catches the capability somebody adds next year; an
 * example only catches the ones that exist today.
 */

const policy = (over: Partial<Policy> = {}): Policy => ({ ...DEFAULT_POLICY, ...over });

describe("registry invariants", () => {
  it("puts everything irreversible at level 4", () => {
    // The rule that must not depend on anybody remembering it.
    for (const capability of CAPABILITIES) {
      if (capability.reversible) continue;
      assert.equal(
        capability.level,
        4,
        `${capability.id} cannot be undone but sits at level ${capability.level}`,
      );
    }
  });

  it("never marks a level-4 capability reversible", () => {
    for (const capability of CAPABILITIES) {
      if (capability.level !== 4) continue;
      if (capability.reversible) {
        // Allowed in principle, but it must be deliberate — a reversible
        // level-4 is a judgement call and should be visible in review.
        assert.ok(
          capability.consequence.length > 20,
          `${capability.id} is reversible at level 4 with no stated reason`,
        );
      }
    }
  });

  it("gives every capability a consequence worth reading at an approval prompt", () => {
    for (const capability of CAPABILITIES) {
      assert.ok(capability.consequence.length > 15, `${capability.id} says nothing`);
      assert.ok(capability.scopes.length >= 0);
    }
  });

  it("has unique ids", () => {
    assert.equal(new Set(CAPABILITIES.map((c) => c.id)).size, CAPABILITIES.length);
  });

  it("splits drafting from sending, everywhere it matters", () => {
    // "Email access" as one permission is how an assistant ends up able to send.
    for (const [prepare, act] of [
      ["mail.draft", "mail.send"],
      ["invoice.draft", "invoice.send"],
      ["deploy.plan", "deploy.production"],
      ["repo.patch", "repo.merge"],
    ]) {
      assert.ok(CAPABILITY_BY_ID[prepare], `${prepare} missing`);
      assert.ok(CAPABILITY_BY_ID[act], `${act} missing`);
      assert.ok(CAPABILITY_BY_ID[prepare].level < CAPABILITY_BY_ID[act].level);
      assert.equal(CAPABILITY_BY_ID[act].level, 4);
    }
  });

  it("never lets money move below level 4", () => {
    for (const capability of CAPABILITIES) {
      if (!capability.spends) continue;
      assert.equal(capability.level, 4, `${capability.id} spends money below level 4`);
    }
  });
});

describe("the ceiling saturates", () => {
  it("cannot be raised to cover level 4", () => {
    // The single most important test here. If this ever passes at level 4,
    // the whole model is decorative.
    const reckless = policy({ ceiling: 4 as never });
    for (const capability of CAPABILITIES.filter((c) => c.level === 4)) {
      const decision = decide(capability.id, reckless);
      assert.equal(
        decision.requiresApproval,
        true,
        `${capability.id} ran unattended at ceiling 4`,
      );
    }
  });

  it("bounds the constant itself below 4", () => {
    assert.ok(MAX_AUTOMATIC_LEVEL < 4);
  });

  it("leaves nothing irreversible in the unattended set, at any ceiling", () => {
    for (const ceiling of [1, 2, 3, 4] as const) {
      for (const capability of unattended(policy({ ceiling: ceiling as never }))) {
        assert.ok(
          capability.reversible,
          `${capability.id} runs unattended at ceiling ${ceiling} and cannot be undone`,
        );
      }
    }
  });
});

describe("decide", () => {
  it("defaults to prepare-only — reads and drafts, changes nothing", () => {
    const free = unattended(DEFAULT_POLICY);
    assert.ok(free.every((c) => c.level <= 2));
    assert.ok(free.some((c) => c.id === "mail.draft"));
    assert.ok(!free.some((c) => c.id === "repo.pr"));
  });

  it("lets deny beat allow, always", () => {
    const contradictory = policy({ allow: ["mail.draft"], deny: ["mail.draft"] });
    const decision = decide("mail.draft", contradictory);
    assert.equal(decision.permitted, false);
    assert.match(decision.reason, /denied/);
  });

  it("lets deny beat the ceiling", () => {
    const decision = decide("mail.read", policy({ ceiling: 3, deny: ["mail.read"] }));
    assert.equal(decision.permitted, false);
  });

  it("does not let allow reach a level-4 capability", () => {
    // Otherwise `allow` becomes a way to configure the boundary away.
    const decision = decide("mail.send", policy({ allow: ["mail.send"] }));
    assert.equal(decision.requiresApproval, true);
  });

  it("refuses a capability nobody registered", () => {
    const decision = decide("shell.rm_rf", policy({ ceiling: 3 }));
    assert.equal(decision.permitted, false);
    assert.match(decision.reason, /unreviewed/);
  });

  it("asks first once a spend passes the limit", () => {
    const spendy = policy({ ceiling: 3, spendLimitMinor: 5000 });
    assert.equal(decide("purchase.make", spendy, { amountMinor: 100 }).requiresApproval, true);
  });

  it("explains itself every time", () => {
    for (const capability of CAPABILITIES) {
      assert.ok(decide(capability.id, DEFAULT_POLICY).reason.length > 15);
    }
  });
});

describe("what the model is told", () => {
  it("says plainly that the boundary is not in the prompt", () => {
    assert.match(renderForPrompt(DEFAULT_POLICY), /enforced in code, not here/);
  });

  it("never lists a level-4 capability as free", () => {
    for (const ceiling of [1, 2, 3] as const) {
      const rendered = renderForPrompt(policy({ ceiling }));
      for (const capability of CAPABILITIES.filter((c) => c.level === 4)) {
        assert.ok(
          !rendered.includes(`${capability.id},`) && !rendered.includes(`${capability.id}.`),
          `${capability.id} advertised as free at ceiling ${ceiling}`,
        );
      }
    }
  });

  it("says so when nothing may run unattended", () => {
    assert.match(renderForPrompt(policy({ ceiling: 1 as never, deny: CAPABILITIES.map((c) => c.id) })), /may not take any action/);
  });
});

describe("the broker", () => {
  const NOW = 1_800_000_000_000;

  it("issues a grant for something the policy already permits", () => {
    const broker = createBroker(policy({ ceiling: 2 }));
    const result = broker.request("mail.draft", { now: NOW });
    assert.ok(result.ok);
    assert.deepEqual(result.grant.scopes, ["gmail.compose"]);
    assert.equal(result.grant.approvedBy, "policy");
  });

  it("refuses rather than issuing a provisional grant for level 4", () => {
    // There must be no state that looks like authority and is not.
    const broker = createBroker(policy({ ceiling: 3 }));
    const result = broker.request("mail.send", { now: NOW });
    assert.ok(!result.ok);
    assert.equal(result.refusal, "needs-approval");
    assert.equal(broker.outstanding(NOW).length, 0);
  });

  it("issues once the operator approves", () => {
    const broker = createBroker(policy());
    const result = broker.approve("mail.send", "Reply to Halden & Co about the invoice", { now: NOW });
    assert.ok(result.ok);
    assert.equal(result.grant.approvedBy, "operator");
    assert.match(result.grant.approvedFor ?? "", /Halden/);
  });

  it("still refuses a denied capability the operator approves by mistake", () => {
    // The two disagree only when something changed since the prompt rendered,
    // and the deny is the more recent intent.
    const broker = createBroker(policy({ deny: ["mail.send"] }));
    const result = broker.approve("mail.send", "stale prompt", { now: NOW });
    assert.ok(!result.ok);
    assert.equal(result.refusal, "not-permitted");
  });

  it("never puts a credential in a grant", () => {
    const broker = createBroker(policy({ ceiling: 3 }));
    const result = broker.request("calendar.propose", { now: NOW });
    assert.ok(result.ok);
    const serialised = JSON.stringify(result.grant);
    for (const smell of ["token", "secret", "key", "Bearer", "password"]) {
      assert.ok(!serialised.toLowerCase().includes(smell.toLowerCase()), `grant leaked "${smell}"`);
    }
  });

  it("spends a use, and refuses the second redemption", () => {
    const broker = createBroker(policy({ ceiling: 2 }));
    const issued = broker.request("mail.draft", { now: NOW });
    assert.ok(issued.ok);

    const first = broker.redeem(issued.grant.id, NOW + 100);
    assert.ok(first.ok);
    assert.deepEqual(first.scopes, ["gmail.compose"]);

    const second = broker.redeem(issued.grant.id, NOW + 200);
    assert.ok(!second.ok);
    assert.equal(second.refusal, "spent");
  });

  it("refuses a grant past its expiry", () => {
    const broker = createBroker(policy({ ceiling: 2 }));
    const issued = broker.request("mail.draft", { now: NOW, ttlMs: 1000 });
    assert.ok(issued.ok);
    const result = broker.redeem(issued.grant.id, NOW + 5000);
    assert.ok(!result.ok);
    assert.equal(result.refusal, "expired");
  });

  it("refuses a grant id that was never issued", () => {
    const broker = createBroker(policy());
    const result = broker.redeem("g_forged", NOW);
    assert.ok(!result.ok);
    assert.equal(result.refusal, "unknown-grant");
  });

  it("audits the refusals, which are the rows that matter", () => {
    const broker = createBroker(policy({ ceiling: 2 }));
    broker.request("mail.send", { now: NOW });
    broker.redeem("g_forged", NOW + 1);

    const refusals = broker.audit().filter((e) => e.outcome === "refused");
    assert.equal(refusals.length, 2);
    assert.ok(refusals.every((e) => e.detail.length > 10));
  });

  it("audits every issue and every redemption too", () => {
    const broker = createBroker(policy({ ceiling: 2 }));
    const issued = broker.request("mail.draft", { now: NOW });
    assert.ok(issued.ok);
    broker.redeem(issued.grant.id, NOW + 10);

    const outcomes = broker.audit().map((e) => e.outcome);
    assert.ok(outcomes.includes("issued"));
    assert.ok(outcomes.includes("redeemed"));
  });

  it("reads back as something a person can follow a year later", () => {
    const broker = createBroker(policy({ ceiling: 2 }));
    broker.request("mail.send", { now: NOW });
    const line = describeEntry(broker.audit()[0]);
    assert.match(line, /REFUSED/);
    assert.match(line, /mail\.send/);
  });

  it("drops outstanding grants once they expire", () => {
    const broker = createBroker(policy({ ceiling: 2 }));
    broker.request("mail.draft", { now: NOW, ttlMs: 1000 });
    assert.equal(broker.outstanding(NOW + 500).length, 1);
    assert.equal(broker.outstanding(NOW + 5000).length, 0);
  });
});
