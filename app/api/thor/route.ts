import { NextResponse } from "next/server";
import { AGENTS_BY_ID, FAMILY_LABEL } from "@/lib/agents";
import { learnFrom, recall, renderForPrompt as renderMemory } from "@/lib/memory";
import { callRole, routeTurn, stackStatus } from "@/lib/models";
import { decideAttendance, draftReply, type Turn } from "@/lib/orchestrator";
import { getProfile, renderForPrompt as renderStyle } from "@/lib/style";

/**
 * The orchestrator endpoint.
 *
 * Two independent decisions happen before a single token is generated:
 *
 *   WHO   Specialist Attendance picks the seat  (lib/orchestrator.ts)
 *   WHICH Model routing picks the brain         (lib/models.ts)
 *
 * They are separate on purpose. The Marketing specialist answering a throwaway
 * question should ride Gemini Flash; the same specialist weighing a pricing
 * change should escalate to Claude Opus. Seat and model are orthogonal, and
 * collapsing them would mean either paying Opus prices for small talk or
 * taking consequential decisions on a fast model.
 *
 * Then memory and the learned style profile are folded into the prompt, and
 * after the reply lands, Haiku is asked what in the exchange is worth keeping.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_HISTORY = 12;

interface ThorRequest {
  utterance?: unknown;
  history?: unknown;
  forceAgentId?: unknown;
  hasAttachment?: unknown;
}

export async function GET() {
  // Lets the cockpit show which parts of the stack are actually reachable.
  return NextResponse.json({ stack: stackStatus() });
}

export async function POST(request: Request) {
  let body: ThorRequest;
  try {
    body = (await request.json()) as ThorRequest;
  } catch {
    return NextResponse.json({ error: "Malformed request body." }, { status: 400 });
  }

  const utterance = typeof body.utterance === "string" ? body.utterance.trim() : "";
  if (!utterance) {
    return NextResponse.json({ error: "An utterance is required." }, { status: 400 });
  }

  // ── WHO ────────────────────────────────────────────────────────────────
  const forced =
    typeof body.forceAgentId === "string" && AGENTS_BY_ID[body.forceAgentId]
      ? body.forceAgentId
      : null;

  const attendance = forced
    ? { primaryId: forced, supportingIds: [], triggers: [], confidence: 1 }
    : decideAttendance(utterance);

  // ── WHICH ──────────────────────────────────────────────────────────────
  const route = routeTurn(utterance, body.hasAttachment === true);

  const agent = attendance.primaryId ? AGENTS_BY_ID[attendance.primaryId] : null;

  // ── Context ────────────────────────────────────────────────────────────
  const [facts, style] = await Promise.all([recall(utterance), getProfile()]);

  const system = [
    agent
      ? `You are the ${agent.name} seat inside Thor — an autonomous AI co-founder that runs a solo operator's business.`
      : "You are Thor, an autonomous AI co-founder.",
    agent ? `Your family: ${FAMILY_LABEL[agent.family]}.` : "",
    agent ? `Your charter: ${agent.charter}` : "",
    "",
    route.role === "judgment"
      ? "This was escalated to you because it is a consequential judgment. Give the call, the reasoning, and what would change your mind."
      : "You have just been called into a live voice conversation because the operator's words fell in your domain.",
    "",
    "Rules:",
    "- Answer as the specialist, not as a generic assistant. Never break character to describe yourself.",
    "- This is spoken aloud. Two or three sentences unless the operator asked for depth.",
    "- Lead with the answer or the decision.",
    "- If the task belongs to another seat, say which one in half a sentence, then answer what you can.",
    "- Never invent numbers, dates, or facts about the operator's business. Say what you would need instead.",
  ]
    .filter(Boolean)
    .join("\n");

  const memoryBlock = renderMemory(facts);
  const styleBlock = renderStyle(style);
  const fullSystem = [system, memoryBlock, styleBlock].filter(Boolean).join("\n\n");

  // ── Generate ───────────────────────────────────────────────────────────
  const history = Array.isArray(body.history) ? (body.history as Turn[]) : [];
  const messages = history
    .filter(
      (t) =>
        t &&
        typeof t.text === "string" &&
        (t.role === "operator" || t.role === "specialist"),
    )
    .slice(-MAX_HISTORY)
    .map((t) => ({
      role: t.role === "operator" ? ("user" as const) : ("assistant" as const),
      content: t.text,
    }));
  messages.push({ role: "user", content: utterance });

  const result = await callRole(route.role, { system: fullSystem, messages });

  if (!result.live) {
    return NextResponse.json({
      attendance,
      reply: draftReply(utterance, attendance),
      local: true,
      routing: { role: route.role, model: result.spec.label, reason: route.reason },
      memoryUsed: facts.length,
      degraded: result.error,
    });
  }

  // ── Learn ──────────────────────────────────────────────────────────────
  // Deliberately awaited: the operator can say "remember that" and immediately
  // ask about it in the next breath, and a fire-and-forget write would lose
  // that race. It is one Haiku call.
  const learned = await learnFrom(utterance, result.text).catch((error) => {
    console.error("memory: extraction failed", error);
    return [];
  });

  return NextResponse.json({
    attendance,
    reply: result.text,
    local: false,
    routing: { role: route.role, model: result.spec.label, reason: route.reason },
    memoryUsed: facts.length,
    learned: learned.map((f) => f.text),
  });
}
