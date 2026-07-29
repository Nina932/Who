/**
 * Voice as another interface to the authority engine — never a way around it.
 *
 * Every capability should be reachable by voice: asking for work, reviewing
 * the plan, approving, rejecting, cancelling, checking the result. What must
 * *not* follow is that voice grants broader authority than a click. The same
 * registry, the same policy, the same broker, the same audit.
 *
 * Two things make voice specifically dangerous, and both are handled here.
 *
 * **A generic "yes" must never approve anything.** The word can come from a
 * television, a recording, another conversation in the room, or Morpheus's own
 * speaker. So approval requires an action-specific phrase containing a
 * reference number that was spoken aloud a moment earlier, and the reference
 * must appear as its own token — "742" does not approve 7421.
 *
 * **Morpheus must not approve itself.** Its own audio is the most likely
 * source of a false affirmative, because it is the audio physically closest to
 * the microphone and it is the audio most likely to contain the exact phrase —
 * having just read the phrase out. So approval recognition is disabled while
 * the speaker is active, and uploaded or remote audio is never eligible.
 *
 * The state machine exists so "yes" means something different depending on
 * what Morpheus is doing. A system where every transcript is interpreted the
 * same way cannot safely have an approval phrase at all.
 */

import { CAPABILITY_BY_ID, type Capability } from "./authority";
import { challengePhrase, matchesChallenge, type PendingAction } from "./pending";

// ── Which capabilities voice may finish ──────────────────────────────────

export type VoiceApproval =
  /** The spoken phrase is sufficient. */
  | "phrase"
  /** Phrase, plus the operator having seen the thing on screen. */
  | "phrase-with-preview"
  /** Phrase initiates; a second factor authorises. */
  | "step-up"
  /** Voice cannot finish this. Ever. */
  | "never";

/**
 * Per capability, because "send an email" and "transfer money" are not the
 * same risk even though both are level 4.
 *
 * The `never` list is the important one: a voice can be recorded or
 * synthesised, and a voiceprint is not an authentication factor. Money
 * movement, credential rotation, production deletion and changes to the
 * authority policy itself require something that cannot be played back.
 */
export const VOICE_APPROVAL: Record<string, VoiceApproval> = {
  "mail.send": "phrase",
  "calendar.invite": "phrase",
  "chat.post": "phrase",
  "social.publish": "phrase-with-preview",
  "invoice.send": "phrase-with-preview",
  "repo.merge": "phrase-with-preview",
  "deploy.production": "step-up",
  "purchase.make": "step-up",
  "payment.transfer": "never",
  "secret.rotate": "never",
  "db.migrate": "never",
  "file.delete": "never",
  "memory.forget": "never",
};

/**
 * Unlisted level-4 capabilities default to `never`.
 *
 * Fail closed. A capability added later without a considered entry here must
 * not become voice-approvable by omission — which is exactly how a default
 * quietly becomes a policy.
 */
export function voiceApprovalFor(capability: Capability): VoiceApproval {
  if (capability.level < 4) return "phrase";
  return VOICE_APPROVAL[capability.id] ?? "never";
}

// ── The floor ────────────────────────────────────────────────────────────

/**
 * What Morpheus is currently listening *for*.
 *
 * `awaiting-approval` is the only state in which an approval phrase means
 * anything. Outside it the same words are dictation — which is what stops a
 * sentence like "approve payment 7421" in a dictated email from approving
 * anything.
 */
export type Floor =
  | "idle"
  | "awaiting-command"
  | "clarifying"
  | "awaiting-approval"
  | "dictating"
  | "executing";

/** Where the audio came from. Only one of these can ever approve. */
export type AudioSource =
  /** The operator's live microphone, in an authenticated session. */
  | "operator-mic"
  /** Morpheus's own output, picked up by the microphone. */
  | "self-playback"
  /** A file the operator uploaded. */
  | "uploaded"
  /** A remote participant on a call. */
  | "remote"
  | "unknown";

export interface VoiceContext {
  floor: Floor;
  source: AudioSource;
  /** True while Morpheus is speaking. Approval is deaf during playback. */
  speaking: boolean;
  /** Null when nobody is authenticated. Approval requires a session. */
  sessionId: string | null;
  /** True once the operator has seen this action rendered on screen. */
  previewed?: boolean;
  /** True once a second factor has been satisfied for this action. */
  steppedUp?: boolean;
}

export type Verdict =
  | { ok: true; approves: PendingAction }
  | { ok: false; reason: string; code: Refusal };

export type Refusal =
  | "wrong-floor"
  | "not-operator"
  | "self-playback"
  | "no-session"
  | "no-match"
  | "expired"
  | "needs-preview"
  | "needs-step-up"
  | "voice-not-permitted";

/**
 * Does this transcript approve this action, right now, from this source?
 *
 * Ordered so the cheapest and most categorical refusals come first, and so a
 * failure never reveals more than it must. Every branch returns something the
 * operator can act on — an approval that fails silently is worse than one that
 * fails loudly, because the operator assumes it worked.
 */
export function judge(
  action: PendingAction,
  transcript: string,
  context: VoiceContext,
  now: number,
): Verdict {
  const capability = CAPABILITY_BY_ID[action.capabilityId];
  const mode = capability ? voiceApprovalFor(capability) : "never";

  if (mode === "never") {
    return {
      ok: false,
      code: "voice-not-permitted",
      reason: `${capability?.label ?? action.capabilityId} cannot be approved by voice. A voice can be recorded or synthesised; this needs the Authority screen.`,
    };
  }

  // Morpheus has just read the phrase aloud. Its own speaker is the audio
  // most likely to contain it and the closest to the microphone.
  if (context.speaking || context.source === "self-playback") {
    return {
      ok: false,
      code: "self-playback",
      reason: "Approval is not accepted while Morpheus is speaking.",
    };
  }

  if (context.source !== "operator-mic") {
    return {
      ok: false,
      code: "not-operator",
      reason:
        context.source === "uploaded"
          ? "Uploaded audio can never approve an action."
          : "Only your live microphone can approve an action.",
    };
  }

  if (!context.sessionId) {
    return { ok: false, code: "no-session", reason: "No authenticated session. Sign in first." };
  }

  if (context.floor !== "awaiting-approval") {
    // The same words are dictation outside this state, which is what stops a
    // dictated sentence containing the phrase from approving anything.
    return {
      ok: false,
      code: "wrong-floor",
      reason: "Nothing is waiting for approval, so that was heard as dictation.",
    };
  }

  if (now > action.expiresAt) {
    return {
      ok: false,
      code: "expired",
      reason: `Approval for ${action.reference} expired. Ask again and it will be re-prepared.`,
    };
  }

  if (!matchesChallenge(action, transcript)) {
    return {
      ok: false,
      code: "no-match",
      reason: `That is not the approval phrase. Say: "${challengePhrase(action)}".`,
    };
  }

  if (mode === "phrase-with-preview" && !context.previewed) {
    return {
      ok: false,
      code: "needs-preview",
      reason: "Read it on screen first — this one is not approved unseen.",
    };
  }

  if (mode === "step-up" && !context.steppedUp) {
    return {
      ok: false,
      code: "needs-step-up",
      reason: "Confirm with your security key. Voice can start this; it cannot finish it.",
    };
  }

  return { ok: true, approves: action };
}

// ── Commands other than approval ─────────────────────────────────────────

export type Control =
  | { kind: "approve" }
  | { kind: "reject"; reference: string | null }
  | { kind: "cancel" }
  | { kind: "read-back" }
  | { kind: "explain" }
  | { kind: "amend"; detail: string }
  | { kind: "stop" }
  | { kind: "none" };

const REFERENCE = /\b(\d{3,6})\b/;

/**
 * Control phrases recognised while an approval is pending.
 *
 * Rejection and cancellation are deliberately *easy* — a loose match, no
 * reference required. The asymmetry is the point: making it hard to stop
 * something is a much worse failure than making it easy, and an operator
 * scrambling to cancel should not have to remember a number.
 */
export function control(transcript: string): Control {
  const text = ` ${transcript.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ")} `;

  if (/\b(stop|halt|abort)\b/.test(text)) return { kind: "stop" };
  if (/\b(cancel|never mind|forget it|scrap that)\b/.test(text)) return { kind: "cancel" };
  if (/\b(reject|refuse|deny|do not|don t)\b/.test(text)) {
    return { kind: "reject", reference: text.match(REFERENCE)?.[1] ?? null };
  }
  if (/\b(read (it|the draft|that) back|read the draft|what does it say)\b/.test(text)) {
    return { kind: "read-back" };
  }
  if (/\b(why|explain|what permissions|how long)\b/.test(text)) return { kind: "explain" };
  if (/\b(change|instead|make it|use)\b/.test(text)) {
    return { kind: "amend", detail: transcript.trim() };
  }
  if (/\bapprove\b/.test(text)) return { kind: "approve" };

  return { kind: "none" };
}

/**
 * The answer to "why does this need approval?", spoken.
 *
 * Reaching for the registry rather than a model, because the honest answer is
 * a fact about the policy and a model asked to explain a boundary will
 * eventually explain it away.
 */
export function explain(action: PendingAction): string {
  const capability = CAPABILITY_BY_ID[action.capabilityId];
  if (!capability) return "That capability is not registered, so it cannot run at all.";

  const mode = voiceApprovalFor(capability);
  const extra =
    mode === "never"
      ? " Voice cannot approve it at all — a voice can be recorded or synthesised."
      : mode === "step-up"
        ? " Voice can start it; a security key has to finish it."
        : mode === "phrase-with-preview"
          ? " You have to see it on screen before the phrase counts."
          : "";

  const remaining = Math.max(0, Math.round((action.expiresAt - Date.now()) / 1000));
  return `${capability.label} is level ${capability.level}. ${capability.consequence}${extra} This approval is valid for another ${remaining} seconds.`;
}

/**
 * The receipt. What actually happened, with evidence — never just "Done."
 *
 * A confirmation that does not distinguish "saved a draft" from "sent it" is
 * the failure this whole system exists to prevent, arriving at the last step.
 */
export function receipt(action: PendingAction): string {
  switch (action.status) {
    case "completed":
      return action.executionEvidence
        ? `${action.actionSummary} ${action.executionEvidence}`
        : `${action.actionSummary} Completed, but nothing was returned to confirm it — treat that as unverified.`;
    case "failed":
      return `It did not go through. ${action.failure ?? "No reason was returned."}`;
    case "rejected":
      return `Rejected. Nothing happened.`;
    case "cancelled":
      return `Cancelled. Nothing happened.`;
    case "expired":
      return `The approval for ${action.reference} expired before it ran. Nothing happened.`;
    default:
      return `${action.reference} is ${action.status}.`;
  }
}
