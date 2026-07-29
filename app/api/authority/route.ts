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
  appendAudit,
  auditLog,
  currentPolicy,
  liveBroker,
  resetBroker,
  savePolicy,
} from "@/lib/authority-runtime";
import { guardMutation } from "@/lib/guard";

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
  });
}

interface Body {
  action?: unknown;
  ceiling?: unknown;
  capabilityId?: unknown;
  list?: unknown;
  spendLimitMinor?: unknown;
  approvedFor?: unknown;
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
