import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CAPABILITIES, CAPABILITY_BY_ID, DEFAULT_POLICY } from "../lib/authority";
import { createBroker } from "../lib/broker";
import {
  amend,
  canonical,
  challengePhrase,
  createPending,
  hashArguments,
  matchesChallenge,
  readBack,
  statusOf,
} from "../lib/pending";
import {
  VOICE_APPROVAL,
  control,
  explain,
  judge,
  receipt,
  voiceApprovalFor,
  type VoiceContext,
} from "../lib/voice-authority";

/**
 * Voice is another interface to the authority engine, not a way around it. The
 * two failures that matter: a stray "yes" approving something, and an approval
 * for one action authorising a different one.
 */

const NOW = 1_800_000_000_000;

const pending = (over: Partial<Parameters<typeof createPending>[0]> = {}) =>
  createPending({
    id: "pa-1",
    reference: "7421",
    capabilityId: "mail.send",
    requestedBy: "voice",
    actionSummary: "This sends an email to David at david@example.com, subject 'G8 deployment update'.",
    consequence: "It reaches a person and cannot be recalled.",
    args: { to: "david@example.com", subject: "G8 deployment update", body: "..." },
    now: NOW,
    ...over,
  });

const live = (over: Partial<VoiceContext> = {}): VoiceContext => ({
  floor: "awaiting-approval",
  source: "operator-mic",
  speaking: false,
  sessionId: "s1",
  ...over,
});

// ── Argument binding ─────────────────────────────────────────────────────

describe("frozen arguments", () => {
  it("hashes independently of key order", async () => {
    // Otherwise a JSON round-trip invalidates an approval, which trains people
    // to re-approve reflexively — worse than not asking.
    assert.equal(canonical({ a: 1, b: 2 }), canonical({ b: 2, a: 1 }));
    assert.equal(await hashArguments({ a: 1, b: 2 }), await hashArguments({ b: 2, a: 1 }));
  });

  it("treats an absent field and an undefined field as the same", async () => {
    assert.equal(await hashArguments({ a: 1 }), await hashArguments({ a: 1, b: undefined }));
  });

  it("changes when anything material changes", async () => {
    const base = await hashArguments({ to: "david@example.com", amount: 500 });
    assert.notEqual(base, await hashArguments({ to: "maria@example.com", amount: 500 }));
    assert.notEqual(base, await hashArguments({ to: "david@example.com", amount: 5000 }));
  });

  it("keeps the arguments it was created with, not a live reference", async () => {
    const args = { to: "david@example.com" };
    const action = await pending({ args });
    args.to = "maria@example.com";
    assert.deepEqual(action.immutableArguments, { to: "david@example.com" });
  });
});

describe("amending supersedes rather than edits", () => {
  it("cancels the original and issues a new reference", async () => {
    const original = await pending();
    const { cancelled, replacement } = await amend(
      original,
      { to: "maria@example.com", subject: "G8 deployment update", body: "..." },
      NOW + 1000,
    );
    assert.equal(cancelled.status, "cancelled");
    assert.notEqual(replacement.argumentsHash, original.argumentsHash);
    assert.notEqual(replacement.reference, original.reference);
    assert.equal(replacement.status, "awaiting-approval");
  });
});

// ── The binding the broker enforces ──────────────────────────────────────

describe("a grant authorises one action, not a category", () => {
  const broker = () => createBroker(DEFAULT_POLICY);

  it("redeems when everything matches", async () => {
    const action = await pending();
    const b = broker();
    const issued = b.approve("mail.send", action.actionSummary, {
      now: NOW,
      pendingActionId: action.id,
      argumentsHash: action.argumentsHash,
      operatorSessionId: "s1",
    });
    assert.ok(issued.ok);

    const result = b.redeem(
      issued.grant.id,
      { pendingActionId: action.id, argumentsHash: action.argumentsHash, operatorSessionId: "s1" },
      NOW + 100,
    );
    assert.ok(result.ok);
  });

  it("refuses when the arguments changed after approval", async () => {
    // The whole correction. Approve an email to David, then swap the
    // recipient: the approval must stop applying.
    const action = await pending();
    const b = broker();
    const issued = b.approve("mail.send", action.actionSummary, {
      now: NOW,
      pendingActionId: action.id,
      argumentsHash: action.argumentsHash,
      operatorSessionId: "s1",
    });
    assert.ok(issued.ok);

    const tampered = await hashArguments({ to: "maria@example.com" });
    const result = b.redeem(
      issued.grant.id,
      { pendingActionId: action.id, argumentsHash: tampered, operatorSessionId: "s1" },
      NOW + 100,
    );
    assert.ok(!result.ok);
    assert.equal(result.refusal, "binding-mismatch");
    assert.match(result.detail ?? "", /changed after you approved/);
  });

  it("refuses a grant presented for a different action", async () => {
    const first = await pending();
    const second = await pending({ id: "pa-2", reference: "7422" });
    const b = broker();
    const issued = b.approve("mail.send", first.actionSummary, {
      now: NOW,
      pendingActionId: first.id,
      argumentsHash: first.argumentsHash,
      operatorSessionId: "s1",
    });
    assert.ok(issued.ok);

    const result = b.redeem(
      issued.grant.id,
      { pendingActionId: second.id, argumentsHash: second.argumentsHash, operatorSessionId: "s1" },
      NOW + 100,
    );
    assert.ok(!result.ok);
    assert.equal(result.refusal, "binding-mismatch");
  });

  it("refuses a grant from another session — an approval is not transferable", async () => {
    const action = await pending();
    const b = broker();
    const issued = b.approve("mail.send", action.actionSummary, {
      now: NOW,
      pendingActionId: action.id,
      argumentsHash: action.argumentsHash,
      operatorSessionId: "s1",
    });
    assert.ok(issued.ok);

    const result = b.redeem(
      issued.grant.id,
      { pendingActionId: action.id, argumentsHash: action.argumentsHash, operatorSessionId: "attacker" },
      NOW + 100,
    );
    assert.ok(!result.ok);
    assert.equal(result.refusal, "binding-mismatch");
  });

  it("treats an omitted binding as a mismatch, not a pass", async () => {
    // "No hash offered" would otherwise be the easiest way around the whole
    // mechanism.
    const action = await pending();
    const b = broker();
    const issued = b.approve("mail.send", action.actionSummary, {
      now: NOW,
      pendingActionId: action.id,
      argumentsHash: action.argumentsHash,
      operatorSessionId: "s1",
    });
    assert.ok(issued.ok);
    assert.ok(!b.redeem(issued.grant.id, {}, NOW + 100).ok);
  });

  it("does not spend the use on a mismatched attempt", async () => {
    // Otherwise one wrong presentation burns a legitimate approval.
    const action = await pending();
    const b = broker();
    const issued = b.approve("mail.send", action.actionSummary, {
      now: NOW,
      pendingActionId: action.id,
      argumentsHash: action.argumentsHash,
      operatorSessionId: "s1",
    });
    assert.ok(issued.ok);

    b.redeem(issued.grant.id, { pendingActionId: "wrong" }, NOW + 10);
    const good = b.redeem(
      issued.grant.id,
      { pendingActionId: action.id, argumentsHash: action.argumentsHash, operatorSessionId: "s1" },
      NOW + 20,
    );
    assert.ok(good.ok, "the real approval survived a failed attempt");
  });

  it("audits the mismatch", async () => {
    const action = await pending();
    const b = broker();
    const issued = b.approve("mail.send", "x", {
      now: NOW,
      pendingActionId: action.id,
      argumentsHash: action.argumentsHash,
      operatorSessionId: "s1",
    });
    assert.ok(issued.ok);
    b.redeem(issued.grant.id, { pendingActionId: "wrong" }, NOW + 10);
    assert.ok(b.audit().some((e) => e.refusal === "binding-mismatch"));
  });
});

// ── The approval phrase ──────────────────────────────────────────────────

describe("a generic yes never approves", () => {
  it("rejects every bare affirmative", async () => {
    const action = await pending();
    for (const said of ["yes", "yeah", "ok", "sure", "do it", "go ahead", "approve"]) {
      assert.equal(matchesChallenge(action, said), false, `"${said}" approved something`);
    }
  });

  it("accepts the exact phrase", async () => {
    const action = await pending();
    assert.ok(matchesChallenge(action, "approve send 7421"));
    assert.ok(matchesChallenge(action, "Approve send 7421."), "punctuation and case are forgiven");
  });

  it("rejects the right phrase with the wrong reference", async () => {
    const action = await pending();
    assert.equal(matchesChallenge(action, "approve send 7422"), false);
  });

  it("does not let a prefix of the reference match", async () => {
    // "742" must not approve 7421.
    const action = await pending({ reference: "7421" });
    assert.equal(matchesChallenge(action, "approve send 742"), false);
  });

  it("puts the reference in what is read back", async () => {
    const action = await pending();
    const spoken = readBack(action, "voice");
    assert.match(spoken, /cannot be recalled/);
    assert.match(spoken, /approve send 7421/);
    // Never just "do you approve?" — the consequence comes first.
    assert.ok(spoken.indexOf(action.consequence) < spoken.indexOf(challengePhrase(action)));
  });
});

// ── Where the audio came from ────────────────────────────────────────────

describe("Morpheus cannot approve itself", () => {
  it("is deaf to approval while speaking", async () => {
    const action = await pending();
    const verdict = judge(action, "approve send 7421", live({ speaking: true }), NOW + 10);
    assert.ok(!verdict.ok);
    assert.equal(verdict.code, "self-playback");
  });

  it("rejects its own playback even when not flagged as speaking", async () => {
    const action = await pending();
    const verdict = judge(action, "approve send 7421", live({ source: "self-playback" }), NOW + 10);
    assert.ok(!verdict.ok);
    assert.equal(verdict.code, "self-playback");
  });

  it("never accepts uploaded audio", async () => {
    const action = await pending();
    const verdict = judge(action, "approve send 7421", live({ source: "uploaded" }), NOW + 10);
    assert.ok(!verdict.ok);
    assert.match(verdict.reason, /never approve/);
  });

  it("never accepts remote call audio", async () => {
    const action = await pending();
    assert.equal(
      judge(action, "approve send 7421", live({ source: "remote" }), NOW + 10).ok,
      false,
    );
  });

  it("requires an authenticated session", async () => {
    const action = await pending();
    const verdict = judge(action, "approve send 7421", live({ sessionId: null }), NOW + 10);
    assert.ok(!verdict.ok);
    assert.equal(verdict.code, "no-session");
  });

  it("hears the phrase as dictation when nothing is pending", async () => {
    // This is what stops a dictated email containing the phrase approving it.
    const action = await pending();
    const verdict = judge(action, "approve send 7421", live({ floor: "dictating" }), NOW + 10);
    assert.ok(!verdict.ok);
    assert.equal(verdict.code, "wrong-floor");
  });

  it("approves when everything is right", async () => {
    const action = await pending();
    assert.ok(judge(action, "approve send 7421", live(), NOW + 10).ok);
  });

  it("refuses once the pending action has expired", async () => {
    const action = await pending();
    const verdict = judge(action, "approve send 7421", live(), action.expiresAt + 1);
    assert.ok(!verdict.ok);
    assert.equal(verdict.code, "expired");
  });
});

// ── Which capabilities voice may finish ──────────────────────────────────

describe("voice approval levels", () => {
  it("never lets voice move money, rotate credentials, or delete production data", async () => {
    for (const id of ["payment.transfer", "secret.rotate", "db.migrate", "file.delete"]) {
      assert.equal(voiceApprovalFor(CAPABILITY_BY_ID[id]), "never", id);
      const action = await pending({ capabilityId: id, id: `pa-${id}` });
      const verdict = judge(action, challengePhrase(action), live(), NOW + 10);
      assert.ok(!verdict.ok);
      assert.equal(verdict.code, "voice-not-permitted");
    }
  });

  it("fails closed for a level-4 capability nobody classified", () => {
    // A capability added later must not become voice-approvable by omission.
    for (const capability of CAPABILITIES.filter((c) => c.level === 4)) {
      if (VOICE_APPROVAL[capability.id]) continue;
      assert.equal(voiceApprovalFor(capability), "never", capability.id);
    }
  });

  it("requires a preview before publishing", async () => {
    const action = await pending({ capabilityId: "social.publish", id: "pa-pub" });
    const unseen = judge(action, challengePhrase(action), live(), NOW + 10);
    assert.ok(!unseen.ok);
    assert.equal(unseen.code, "needs-preview");
    assert.ok(judge(action, challengePhrase(action), live({ previewed: true }), NOW + 10).ok);
  });

  it("requires a second factor for production", async () => {
    const action = await pending({ capabilityId: "deploy.production", id: "pa-dep" });
    const voiceOnly = judge(action, challengePhrase(action), live(), NOW + 10);
    assert.ok(!voiceOnly.ok);
    assert.equal(voiceOnly.code, "needs-step-up");
    assert.match(voiceOnly.reason, /cannot finish it/);
    assert.ok(judge(action, challengePhrase(action), live({ steppedUp: true }), NOW + 10).ok);
  });
});

// ── Cancelling and asking ────────────────────────────────────────────────

describe("control phrases", () => {
  it("makes stopping easy — no reference required", () => {
    // Deliberately asymmetric. Making it hard to stop something is a far worse
    // failure than making it easy.
    for (const said of ["cancel that", "never mind", "stop", "forget it"]) {
      assert.notEqual(control(said).kind, "none", said);
    }
  });

  it("takes a reference when rejecting a specific action", () => {
    const result = control("reject action 7421");
    assert.equal(result.kind, "reject");
    assert.equal(result.kind === "reject" ? result.reference : null, "7421");
  });

  it("recognises the review commands", () => {
    assert.equal(control("read the draft").kind, "read-back");
    assert.equal(control("why does this need approval").kind, "explain");
    assert.equal(control("change the recipient to Maria").kind, "amend");
  });
});

describe("explain", () => {
  it("answers from the registry, not from a model", async () => {
    const action = await pending();
    const text = explain(action);
    assert.match(text, /level 4/);
    assert.match(text, /cannot be recalled/);
  });

  it("says plainly when voice cannot finish it", async () => {
    const action = await pending({ capabilityId: "payment.transfer", id: "pa-pay" });
    assert.match(explain(action), /recorded or synthesised/);
  });
});

describe("receipts", () => {
  it("reports evidence rather than 'Done'", async () => {
    const action = await pending();
    const done = {
      ...action,
      status: "completed" as const,
      executionEvidence: "The draft was saved in Gmail. Nothing was sent.",
    };
    assert.match(receipt(done), /Nothing was sent/);
  });

  it("flags a completion nobody confirmed", async () => {
    const action = await pending();
    assert.match(receipt({ ...action, status: "completed" }), /unverified/);
  });

  it("says nothing happened when nothing happened", async () => {
    const action = await pending();
    for (const status of ["rejected", "cancelled"] as const) {
      assert.match(receipt({ ...action, status }), /Nothing happened/);
    }
  });
});

describe("expiry is derived, never a background job", () => {
  it("reports expired without anything having run", async () => {
    const action = await pending();
    assert.equal(statusOf(action, NOW), "awaiting-approval");
    assert.equal(statusOf(action, action.expiresAt + 1), "expired");
  });
});
