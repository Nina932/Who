import { NextResponse } from "next/server";
import { AGENTS_BY_ID, FAMILY_LABEL } from "@/lib/agents";
import { decideAttendance, draftReply, type Turn } from "@/lib/orchestrator";

/**
 * The orchestrator endpoint.
 *
 * Attendance is decided *before* the model is called, not by it. That
 * ordering matters: the routing stays inspectable and cheap, the cockpit can
 * light up the right node the instant the operator stops talking, and the
 * model is handed a single seat to speak from rather than being asked to
 * role-play a whole company at once.
 *
 * With no key present the same shape comes back from `draftReply`, so the
 * cockpit is fully demonstrable offline.
 */

export const runtime = "nodejs";

const MODEL = process.env.APEX_MODEL ?? "claude-sonnet-5";
const API_BASE = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
const MAX_HISTORY = 12;

interface ApexRequest {
  utterance?: unknown;
  history?: unknown;
  /** Set when the operator explicitly summoned a seat from the inspector. */
  forceAgentId?: unknown;
}

function systemPrompt(agentId: string): string {
  const agent = AGENTS_BY_ID[agentId];
  if (!agent) return "You are Apex, an autonomous AI co-founder.";

  return [
    `You are the ${agent.name} seat inside Apex — an autonomous AI co-founder that runs a solo operator's business.`,
    `Your family: ${FAMILY_LABEL[agent.family]}.`,
    `Your charter: ${agent.charter}`,
    "",
    "You have just been called into a live voice conversation because the operator's words fell in your domain.",
    "",
    "Rules:",
    "- Answer as the specialist, not as a generic assistant. Never break character to describe yourself.",
    "- This is spoken aloud. Two or three sentences. No lists, no markdown, no headings.",
    "- Lead with the answer or the decision. The operator is running a business, not reading a memo.",
    "- If the task belongs to another seat, say which one in half a sentence and then answer what you can.",
    "- Never invent numbers, dates, or facts about the operator's business. Say what you would need instead.",
  ].join("\n");
}

export async function POST(request: Request) {
  let body: ApexRequest;
  try {
    body = (await request.json()) as ApexRequest;
  } catch {
    return NextResponse.json({ error: "Malformed request body." }, { status: 400 });
  }

  const utterance = typeof body.utterance === "string" ? body.utterance.trim() : "";
  if (!utterance) {
    return NextResponse.json({ error: "An utterance is required." }, { status: 400 });
  }

  const forced =
    typeof body.forceAgentId === "string" && AGENTS_BY_ID[body.forceAgentId]
      ? body.forceAgentId
      : null;

  const decision = forced
    ? { primaryId: forced, supportingIds: [], triggers: [], confidence: 1 }
    : decideAttendance(utterance);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !decision.primaryId) {
    return NextResponse.json({
      attendance: decision,
      reply: draftReply(utterance, decision),
      local: true,
    });
  }

  // Only operator/specialist turns carry meaning for the model; system notes
  // and the tail limit keep the spoken context tight.
  const history = Array.isArray(body.history) ? (body.history as Turn[]) : [];
  const messages = history
    .filter((t) => t && typeof t.text === "string" && (t.role === "operator" || t.role === "specialist"))
    .slice(-MAX_HISTORY)
    .map((t) => ({
      role: t.role === "operator" ? ("user" as const) : ("assistant" as const),
      content: t.text,
    }));

  messages.push({ role: "user", content: utterance });

  try {
    const response = await fetch(`${API_BASE}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        system: systemPrompt(decision.primaryId),
        messages,
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error("Apex model call failed", response.status, detail.slice(0, 400));
      return NextResponse.json({
        attendance: decision,
        reply: draftReply(utterance, decision),
        local: true,
        degraded: `Model call failed (${response.status}) — answering locally.`,
      });
    }

    const data = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const reply =
      data.content
        ?.filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("")
        .trim() ?? "";

    return NextResponse.json({
      attendance: decision,
      reply: reply || draftReply(utterance, decision),
      local: false,
    });
  } catch (error) {
    console.error("Apex model call threw", error);
    return NextResponse.json({
      attendance: decision,
      reply: draftReply(utterance, decision),
      local: true,
      degraded: "Model unreachable — answering locally.",
    });
  }
}
