import { NextResponse } from "next/server";
import {
  CAPABILITIES,
  DEFAULT_POLICY,
  LEVELS,
  MAX_AUTOMATIC_LEVEL,
  decide,
  unattended,
  type Level,
  type Policy,
} from "@/lib/authority";
import {
  allPending,
  appendAudit,
  auditLog,
  currentPolicy,
  grantFor,
  liveBroker,
  openPending,
  patchPending,
  propose,
  resetBroker,
  savePolicy,
} from "@/lib/authority-runtime";
import { guardMutation } from "@/lib/guard";
import { amend, challengePhrase, readBack, statusOf } from "@/lib/pending";
import { explain, judge, voiceApprovalFor, type VoiceContext } from "@/lib/voice-authority";

/**
 * The authority surface.
 *
 * The policy is durable; grants are not. The broker lives for the process, so
 * an approval and the request that redeems it can be different calls — a
 * broker rebuilt per request would issue grants nothing could ever use. A
 * restart invalidates outstanding authority, which is the intended behaviour.
 *
 * Editing the policy resets the broker, so tightening takes effect at once
 * rather than whenever the last grant happens to expire.
 *
 * The audit log *is* persisted, because it is the artefact worth keeping —
 * particularly the refusals, which are the only evidence you get that
 * something tried.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [current, audit] = await Promise.all([currentPolicy(), auditLog()]);

  return NextResponse.json({
    policy: current,
    levels: LEVELS,
    maxAutomaticLevel: MAX_AUTOMATIC_LEVEL,
    // Every capability with the decision it would get right now, so the blast
    // radius of the current policy is legible rather than inferred.
    capabilities: CAPABILITIES.map((capability) => ({
      ...capability,
      decision: decide(capability.id, current),
    })),
    unattended: unattended(current).map((c) => c.id),
    audit,
    pending: (await allPending()).map((action) => ({
      ...action,
      status: statusOf(action, Date.now()),
      challenge: challengePhrase(action),
      voiceApproval: voiceApprovalFor(CAPABILITIES.find((c) => c.id === action.capabilityId)!),
    })),
  });
}

interface Body {
  action?: unknown;
  ceiling?: unknown;
  capabilityId?: unknown;
  list?: unknown;
  spendLimitMinor?: unknown;
  approvedFor?: unknown;
  actionId?: unknown;
  actionSummary?: unknown;
  args?: unknown;
  transcript?: unknown;
  sessionId?: unknown;
  channel?: unknown;
  previewed?: unknown;
  steppedUp?: unknown;
  speaking?: unknown;
  source?: unknown;
  floor?: unknown;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export async function POST(request: Request) {
  const blocked = guardMutation(request);
  if (blocked) return blocked.response;

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Malformed body." }, { status: 400 });
  }

  // Any policy edit drops outstanding grants. Tightening should take effect
  // now, not whenever the last grant happens to expire.
  const save = async (next: Policy) => {
    const saved = await savePolicy(next);
    resetBroker();
    return saved;
  };

  try {
    const current = await currentPolicy();

    switch (str(body.action)) {
      case "set-ceiling": {
        const requested = num(body.ceiling);
        if (requested === undefined || requested < 1 || requested > 4) {
          return NextResponse.json({ error: "ceiling must be 1-4." }, { status: 400 });
        }
        // Clamped rather than rejected, and the response says what it became.
        // Silently storing 4 and enforcing 3 elsewhere would be the kind of
        // gap where a safety property quietly stops being one.
        const ceiling = Math.min(requested, MAX_AUTOMATIC_LEVEL) as Level;
        await save({ ...current, ceiling });
        return NextResponse.json({
          policy: { ...current, ceiling },
          clamped: ceiling !== requested,
          note:
            ceiling !== requested
              ? `Set to ${ceiling}. Level 4 cannot be automatic — sending, publishing, deploying, deleting and spending always ask.`
              : undefined,
        });
      }

      case "deny":
      case "allow": {
        const capabilityId = str(body.capabilityId);
        if (!capabilityId) {
          return NextResponse.json({ error: "capabilityId required." }, { status: 400 });
        }
        const which = str(body.action) as "deny" | "allow";
        const other = which === "deny" ? "allow" : "deny";
        const next: Policy = {
          ...current,
          // Membership is exclusive: adding to one list removes from the
          // other, so the two can never disagree about the same capability.
          [which]: [...new Set([...current[which], capabilityId])],
          [other]: current[other].filter((id) => id !== capabilityId),
        };
        await save(next);
        return NextResponse.json({ policy: next });
      }

      case "clear": {
        const capabilityId = str(body.capabilityId);
        if (!capabilityId) {
          return NextResponse.json({ error: "capabilityId required." }, { status: 400 });
        }
        const next: Policy = {
          ...current,
          deny: current.deny.filter((id) => id !== capabilityId),
          allow: current.allow.filter((id) => id !== capabilityId),
        };
        await save(next);
        return NextResponse.json({ policy: next });
      }

      case "set-spend-limit": {
        const spendLimitMinor = num(body.spendLimitMinor);
        if (spendLimitMinor === undefined || spendLimitMinor < 0) {
          return NextResponse.json({ error: "spendLimitMinor must be >= 0." }, { status: 400 });
        }
        const next = { ...current, spendLimitMinor };
        await save(next);
        return NextResponse.json({ policy: next });
      }

      case "request": {
        // A dry run: what would happen if Morpheus asked for this right now.
        const capabilityId = str(body.capabilityId);
        if (!capabilityId) {
          return NextResponse.json({ error: "capabilityId required." }, { status: 400 });
        }
        const broker = await liveBroker();
        const result = broker.request(capabilityId);
        await appendAudit(broker.audit().slice(0, 5));
        return NextResponse.json(
          result.ok
            ? {
                granted: true,
                grantId: result.grant.id,
                expiresAt: result.grant.expiresAt,
                scopes: result.grant.scopes,
              }
            : { granted: false, refusal: result.refusal, reason: result.decision.reason },
        );
      }

      case "approve": {
        const capabilityId = str(body.capabilityId);
        const approvedFor = str(body.approvedFor);
        if (!capabilityId || !approvedFor) {
          return NextResponse.json(
            { error: "capabilityId and approvedFor required — an approval with no stated purpose is not one." },
            { status: 400 },
          );
        }
        const broker = await liveBroker();
        const result = broker.approve(capabilityId, approvedFor);
        await appendAudit(broker.audit().slice(0, 5));
        return NextResponse.json(
          result.ok
            ? {
                // The id the caller redeems. Never a credential — resolving
                // scopes into a token happens server-side at redemption.
                granted: true,
                grantId: result.grant.id,
                expiresAt: result.grant.expiresAt,
                scopes: result.grant.scopes,
              }
            : { granted: false, refusal: result.refusal, reason: result.decision.reason },
        );
      }

      // ── Pending actions ────────────────────────────────────────────
      case "propose": {
        const capabilityId = str(body.capabilityId);
        const actionSummary = str(body.actionSummary);
        if (!capabilityId || !actionSummary) {
          return NextResponse.json(
            { error: "capabilityId and actionSummary required." },
            { status: 400 },
          );
        }
        const result = await propose({
          capabilityId,
          requestedBy: (str(body.source) as "voice" | "text" | "ui") ?? "ui",
          actionSummary,
          args: body.args ?? null,
        });
        if (!result.ok) return NextResponse.json({ error: result.reason }, { status: 400 });

        return NextResponse.json({
          action: result.action,
          challenge: challengePhrase(result.action),
          // What Morpheus says: the consequence, then the exact phrase. Never
          // "do you approve?" — a prompt that does not say what will happen is
          // a prompt that trains people to say yes.
          readBack: readBack(result.action, "voice"),
        });
      }

      case "approve-voice": {
        const actionId = str(body.actionId);
        const transcript = str(body.transcript);
        if (!actionId || !transcript) {
          return NextResponse.json({ error: "actionId and transcript required." }, { status: 400 });
        }

        const action = (await openPending()).find((a) => a.id === actionId);
        if (!action) {
          return NextResponse.json(
            { error: "No open action with that id. It may have expired or been cancelled." },
            { status: 404 },
          );
        }

        const context: VoiceContext = {
          floor: (str(body.floor) as VoiceContext["floor"]) ?? "awaiting-approval",
          source: (str(body.source) as VoiceContext["source"]) ?? "unknown",
          speaking: body.speaking === true,
          sessionId: str(body.sessionId) ?? null,
          previewed: body.previewed === true,
          steppedUp: body.steppedUp === true,
        };

        const verdict = judge(action, transcript, context, Date.now());
        if (!verdict.ok) {
          // A refused approval is audited, because a refusal is the only
          // evidence you get that something tried.
          await appendAudit([
            {
              at: Date.now(),
              capabilityId: action.capabilityId,
              outcome: "refused",
              refusal: "needs-approval",
              detail: `Voice approval refused (${verdict.code}): ${verdict.reason}`,
            },
          ]);
          return NextResponse.json({ approved: false, code: verdict.code, reason: verdict.reason });
        }

        const granted = await grantFor(action, context.sessionId as string, "voice");
        if (!granted.ok) return NextResponse.json({ approved: false, reason: granted.reason });
        return NextResponse.json({ approved: true, grantId: granted.grantId });
      }

      case "approve-action": {
        // The UI path. Same engine, same binding — a click is not a shortcut.
        const actionId = str(body.actionId);
        const sessionId = str(body.sessionId) ?? "ui-session";
        if (!actionId) {
          return NextResponse.json({ error: "actionId required." }, { status: 400 });
        }
        const action = (await openPending()).find((a) => a.id === actionId);
        if (!action) return NextResponse.json({ error: "No open action." }, { status: 404 });

        const channel = str(body.channel) === "security-key" ? "security-key" : "ui";
        const granted = await grantFor(action, sessionId, channel);
        if (!granted.ok) return NextResponse.json({ approved: false, reason: granted.reason });
        return NextResponse.json({ approved: true, grantId: granted.grantId });
      }

      case "reject-action":
      case "cancel-action": {
        const actionId = str(body.actionId);
        if (!actionId) return NextResponse.json({ error: "actionId required." }, { status: 400 });
        const status = str(body.action) === "reject-action" ? "rejected" : "cancelled";
        const updated = await patchPending(actionId, { status });
        return NextResponse.json({ action: updated });
      }

      case "amend-action": {
        // Amending supersedes rather than edits: the original is cancelled and
        // a new action with a new hash replaces it, so any grant against the
        // old arguments becomes unredeemable.
        const actionId = str(body.actionId);
        if (!actionId) return NextResponse.json({ error: "actionId required." }, { status: 400 });
        const action = (await allPending()).find((a) => a.id === actionId);
        if (!action) return NextResponse.json({ error: "No such action." }, { status: 404 });

        const { cancelled, replacement } = await amend(
          action,
          body.args ?? null,
          Date.now(),
          str(body.actionSummary),
        );
        await patchPending(actionId, { status: cancelled.status });
        const created = await propose({
          capabilityId: replacement.capabilityId,
          requestedBy: replacement.requestedBy,
          actionSummary: replacement.actionSummary,
          args: replacement.immutableArguments,
        });
        if (!created.ok) return NextResponse.json({ error: created.reason }, { status: 400 });
        return NextResponse.json({
          action: created.action,
          challenge: challengePhrase(created.action),
          note: "The previous approval no longer applies.",
        });
      }

      case "explain-action": {
        const actionId = str(body.actionId);
        if (!actionId) return NextResponse.json({ error: "actionId required." }, { status: 400 });
        const action = (await allPending()).find((a) => a.id === actionId);
        if (!action) return NextResponse.json({ error: "No such action." }, { status: 404 });
        return NextResponse.json({ explanation: explain(action) });
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${String(body.action)}` }, { status: 400 });
    }
  } catch (error) {
    console.error("authority route failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Authority action failed." },
      { status: 500 },
    );
  }
}
