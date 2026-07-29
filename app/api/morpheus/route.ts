import { NextResponse } from "next/server";
import { guardMutation } from "@/lib/guard";
import { AGENTS_BY_ID, FAMILY_LABEL } from "@/lib/agents";
import { learnFrom, recall, renderForPrompt as renderMemory } from "@/lib/memory";
import { routeTurn, stackStatus, streamRole } from "@/lib/models";
import { decideAttendance, draftReply, type Turn } from "@/lib/orchestrator";
import { getProfile, renderForPrompt as renderStyle } from "@/lib/style";
import { allProducts } from "@/lib/assistant-store";
import {
  getOperatorContext,
  renderOperatorContext,
} from "@/lib/operator-context";
import {
  fetchLiveNews,
  liveNewsReply,
  renderLiveNews,
  requestsFreshNews,
} from "@/lib/live-news";
import {
  connectionReply,
  requestedConnection,
} from "@/lib/connection-intent";
import {
  authorizeUrl,
  listCalendarEvents,
  makeState,
  statuses,
  type ConnectorStatus,
} from "@/lib/connectors";
import {
  operatorProfiles,
  renderOperatorIntegrations,
  telegramBotStatus,
  telegramWorkerRuntimeStatus,
} from "@/lib/operator-integrations";
import {
  audioUnderstandingReply,
  requestsAudioUnderstanding,
  requestsSystemStatus,
  systemStatusReply,
} from "@/lib/system-status";
import {
  calendarAgendaReply,
  requestsCalendarAgenda,
} from "@/lib/calendar-intent";

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

interface MorpheusRequest {
  utterance?: unknown;
  history?: unknown;
  forceAgentId?: unknown;
  hasAttachment?: unknown;
  channel?: unknown;
}

export async function GET() {
  // Lets the cockpit show which parts of the stack are actually reachable.
  return NextResponse.json({ stack: stackStatus() });
}

export async function POST(request: Request) {
  const blocked = guardMutation(request);
  if (blocked) return blocked.response;

  let body: MorpheusRequest;
  try {
    body = (await request.json()) as MorpheusRequest;
  } catch {
    return NextResponse.json({ error: "Malformed request body." }, { status: 400 });
  }

  const utterance = typeof body.utterance === "string" ? body.utterance.trim() : "";
  if (!utterance) {
    return NextResponse.json({ error: "An utterance is required." }, { status: 400 });
  }
  const history = Array.isArray(body.history) ? (body.history as Turn[]) : [];
  const channel = body.channel === "telegram" ? "telegram" : "web";
  const needsLiveNews = requestsFreshNews(utterance, history);
  const needsSystemStatus = requestsSystemStatus(utterance);
  const needsAudioUnderstanding = requestsAudioUnderstanding(utterance);
  const needsCalendarAgenda = requestsCalendarAgenda(utterance, history);
  const requestedConnectorId = requestedConnection(utterance, history);
  const directNewsRequest =
    /\b(news|headlines?|latest|newest|current events?|what(?:'s| is) happening)\b/i.test(
      utterance,
    );
  const newsQuery = directNewsRequest
    ? utterance
    : [
        ...history
          .filter((turn) => turn.role === "operator")
          .slice(-2)
          .map((turn) => turn.text),
        utterance,
      ].join(" ");

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
  const [
    facts,
    style,
    operatorContext,
    products,
    liveNews,
    connectorStatuses,
    telegram,
    telegramWorker,
    calendarAgenda,
  ] =
    await Promise.all([
    recall(utterance),
    getProfile(),
    getOperatorContext(),
    allProducts(),
    needsLiveNews ? fetchLiveNews(newsQuery) : Promise.resolve(null),
    requestedConnectorId ? statuses() : Promise.resolve([] as ConnectorStatus[]),
    telegramBotStatus(),
    needsSystemStatus
      ? telegramWorkerRuntimeStatus()
      : Promise.resolve({}),
    needsCalendarAgenda
      ? listCalendarEvents(1)
      : Promise.resolve(null),
  ]);
  const telegramWithRuntime = { ...telegram, ...telegramWorker };
  const requestedConnector = requestedConnectorId
    ? connectorStatuses.find((status) => status.id === requestedConnectorId) ?? null
    : null;

  const system = [
    "You are Morpheus. Speak with one consistent identity.",
    agent
      ? `Internal capability selected for this turn: ${agent.name} (${FAMILY_LABEL[agent.family]}). Use this only as subject-matter context; never perform it as a staff persona.`
      : "",
    agent ? `Relevant capability: ${agent.charter}` : "",
    "",
    route.role === "judgment"
      ? "This was escalated to you because it is a consequential judgment. Give the call, the reasoning, and what would change your mind."
      : "You have just been called into a live voice conversation because the operator's words fell in your domain.",
    "",
    "Rules:",
    "- Answer as Morpheus. Specialist routing is invisible implementation detail unless the operator explicitly asks who handled a task.",
    "- This is spoken aloud. Two or three sentences unless the operator asked for depth.",
    "- Lead with the answer or the decision.",
    "- Sound like a sharp, familiar co-founder, not a corporate assistant, department head, or official briefing.",
    "- Use contractions and natural spoken phrasing. Never recite your title, charter, routing logic, or the operator's words back to them.",
    "- Understand jokes, teasing, irony, exaggeration, and sarcasm from context. If the operator is joking, meet them there instead of answering the joke literally.",
    "- Absurd praise, impossible options, mock drama, and obvious overstatement are usually humor. Respond to the social intent first; do not operationalize the absurd premise.",
    "- Dry humor and a little bite are welcome when the moment allows it. Keep it to one clean line; do not perform a comedy routine or explain the joke.",
    "- Example: if the operator says “I opened my inbox—Nobel Prize or parade?”, answer like “Easy, hero. Start with a commemorative plaque; the Nobel committee is slow.” Do not plan PR, permits, or an awards campaign.",
    "- If a turn is only social humor and contains no real request, stop after the humorous line. Do not append a task, department, next step, status update, or follow-up question.",
    "- When the subject is money, safety, legal exposure, or an irreversible action, drop the humor and become exact.",
    "- A greeting gets a greeting, not an agenda, intake form, role introduction, or offer to optimize the operator's week.",
    "- If asked how you are, answer naturally and briefly. Do not invent activity such as calendars humming, coffee-fueled ideas, background teams, or work already underway.",
    "- Do not turn casual conversation into a weekly-priority question. Ask a follow-up only when it is genuinely needed to answer the request.",
    "- Previous assistant replies are context, not examples of how to behave. Do not imitate their staff language, invented activity, or habitual follow-up questions.",
    "- If the task belongs to another seat, say which one in half a sentence, then answer what you can.",
    "- Never invent numbers, dates, or facts about the operator's business. Say what you would need instead.",
    "- Never present model memory as current news. For news, latest, today, recent releases, or current events, use only the LIVE NEWS block supplied below.",
    "- A promise to fetch later is not a result. Either give verified headlines now or say the live sources failed or returned no match.",
    "- Never call a bounded feed 'all the news'. Name the coverage, dates, and sources. Previous assistant claims in conversation history are not evidence.",
    "- Never claim an OAuth flow, popup, connector, sync, email, or external action started unless this request produced an action receipt. There are no invisible teams doing work later.",
    channel === "telegram"
      ? "- This turn came from the private Telegram channel. It may read and draft, but it can never approve, publish, send, purchase, delete, deploy, or complete OAuth. Direct those actions to the local cockpit."
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const memoryBlock = renderMemory(facts);
  const styleBlock = renderStyle(style);
  const operatorBlock = renderOperatorContext(operatorContext, products);
  const integrationBlock = renderOperatorIntegrations(
    operatorProfiles(),
    telegram,
  );
  const newsBlock = liveNews ? renderLiveNews(liveNews) : "";
  const fullSystem = [
    system,
    newsBlock,
    operatorBlock,
    integrationBlock,
    memoryBlock,
    styleBlock,
  ]
    .filter(Boolean)
    .join("\n\n");

  // ── Generate ───────────────────────────────────────────────────────────
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
        if (request.signal.aborted) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          // The operator interrupted and the client stream is already gone.
        }
      };

      // Sent before a single token exists, so the cockpit lights the attending
      // node the instant the operator stops talking.
      send("meta", {
        attendance,
        routing: { role: route.role, model: route.spec.label, reason: route.reason },
        memoryUsed: facts.length,
      });

      if (requestedConnector) {
        send("delta", {
          text:
            channel === "telegram"
              ? `${requestedConnector.name} ${
                  requestedConnector.connected ? "is linked" : "is not linked"
                }. Open Connections in the local Morpheus cockpit to verify or authorize it; Telegram cannot complete OAuth.`
              : connectionReply(requestedConnector),
        });
        if (channel === "telegram") {
          send("done", {
            local: true,
            connector: requestedConnector.id,
            learned: [],
          });
          controller.close();
          return;
        }
        const consentUrl =
          requestedConnector.available && !requestedConnector.connected
            ? authorizeUrl(
                requestedConnector.id,
                makeState(requestedConnector.id),
              )
            : null;
        send("action", {
          type: "navigate",
          url: consentUrl ?? "/connect",
          connectorId: requestedConnector.id,
        });
        send("done", { local: true, connector: requestedConnector.id, learned: [] });
        controller.close();
        return;
      }

      if (needsSystemStatus) {
        send("delta", {
          text: systemStatusReply(stackStatus(), telegramWithRuntime),
        });
        send("done", { local: true, measured: true, learned: [] });
        controller.close();
        return;
      }

      if (calendarAgenda) {
        send("delta", { text: calendarAgendaReply(calendarAgenda) });
        send("done", { local: true, measured: true, learned: [] });
        controller.close();
        return;
      }

      if (needsAudioUnderstanding) {
        send("delta", { text: audioUnderstandingReply() });
        send("done", { local: true, measured: true, learned: [] });
        controller.close();
        return;
      }

      // Current news is rendered from the fetched rows, not phrased by a model.
      // That removes the model's opportunity to add one plausible fake release.
      if (liveNews) {
        send("news", { headlines: liveNews.headlines });
        send("delta", { text: liveNewsReply(liveNews) });
        send("done", { local: false, sourced: true, learned: [] });
        controller.close();
        return;
      }

      const result = await streamRole(
        route.role,
        { system: fullSystem, messages },
        (delta) => send("delta", { text: delta }),
        request.signal,
      );

      if (request.signal.aborted) return;
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
