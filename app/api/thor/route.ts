import { NextResponse } from "next/server";
import { AGENTS_BY_ID, FAMILY_LABEL } from "@/lib/agents";
import { learnFrom, recall, renderForPrompt as renderMemory } from "@/lib/memory";
import { routeTurn, stackStatus, streamRole } from "@/lib/models";
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
 * Then memory and the learned style profile are folded into the prompt.
 *
 * The response is a Server-Sent Event stream: `meta` first so the cockpit can
 * light the right node immediately, then text deltas so speech can start on
 * the first sentence, then `done`. Memory extraction runs AFTER the last delta
 * is flushed — it is a second model call, and blocking the reply on it added
 * seconds of silence to a voice-first product.
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

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      // Sent before a single token exists, so the cockpit lights the attending
      // node the instant the operator stops talking.
      send("meta", {
        attendance,
        routing: { role: route.role, model: route.spec.label, reason: route.reason },
        memoryUsed: facts.length,
      });

      const result = await streamRole(
        route.role,
        { system: fullSystem, messages },
        (delta) => send("delta", { text: delta }),
      );

      if (!result.live) {
        const fallback = draftReply(utterance, attendance);
        send("delta", { text: fallback });
        send("done", { local: true, degraded: result.error, learned: [] });
        controller.close();
        return;
      }

      // The operator already has the whole reply; extraction latency is now
      // invisible to them.
      const learned = await learnFrom(utterance, result.text).catch((error) => {
        console.error("memory: extraction failed", error);
        return [];
      });

      send("done", { local: false, learned: learned.map((f) => f.text) });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
