/**
 * Tools — the point where a loop stops producing text and touches the world.
 *
 * This is the piece that was missing: connectors worked, loops worked, and
 * nothing joined them, so an approved post was never actually placed on the
 * calendar.
 *
 * A tool step runs in two beats:
 *
 *   1. the step's model turns the run's artefacts into structured JSON
 *   2. that JSON is validated here, then executed against a real connector
 *
 * The model never calls the API. It only proposes arguments; this file decides
 * whether they are well-formed and runs them. A hallucinated field becomes a
 * validation error rather than a bad calendar entry.
 *
 * Every tool is placed downstream of a gate in the loops that use it, so a
 * side effect can only happen after a human said GO.
 */

import { propose, withAuthority } from "./authority-runtime";
import { readBack, type Origin } from "./pending";
import {
  CONNECTORS_BY_ID,
  appendToLog,
  createCalendarEvent,
  createMailDraft,
  createSlideDeck,
  type ConnectorId,
} from "./connectors";

export interface ToolResult {
  ok: boolean;
  /** Written into the run's artefacts, so the record shows what really happened. */
  summary: string;
  /**
   * Set when the call was refused for want of approval and a pending action
   * was created. The caller shows the read-back and waits; it is not a failure.
   */
  awaitingApproval?: string;
  /**
   * The provider may have acted despite the failure.
   *
   * Carried up so execution can record `outcome-uncertain` rather than
   * `failed` — and so a retry is a human decision rather than an automatic
   * second send.
   */
  uncertain?: boolean;
}

export interface ToolSpec {
  name: string;
  connectorId: ConnectorId;
  /**
   * Which registered capability this tool exercises.
   *
   * Declared, not decided. A tool that checked its own permission would be a
   * tool that could be argued out of it; this names what it is and the answer
   * comes from `withAuthority`.
   */
  capabilityId: string;
  /** Told to the model, so it knows what it is producing arguments for. */
  purpose: string;
  /** The exact JSON shape the model must return. */
  schemaHint: string;
  /**
   * `granted` is the scope list from the redeemed grant, threaded into the
   * connector call. Passing it is what turns the grant from a promise into a
   * constraint — the connector refuses anything the grant did not authorise.
   */
  run: (input: unknown, granted?: string[]) => Promise<ToolResult>;
}

/**
 * Run a tool through the authority layer.
 *
 * Every path that touches the world goes through here. A refusal is a result,
 * not an exception — the loop records what was refused and why, which is the
 * artefact worth having when somebody asks later why nothing was sent.
 */
export async function runTool(
  tool: ToolSpec,
  input: unknown,
  binding: {
    grantId?: string;
    pendingActionId?: string;
    operatorSessionId?: string;
    /** Who asked. A voice request that needs approval becomes a pending one. */
    requestedBy?: Origin;
    /** Set false to refuse rather than propose. Loops do not want a prompt. */
    proposeOnRefusal?: boolean;
  } = {},
): Promise<ToolResult> {
  const outcome = await withAuthority(
    tool.capabilityId,
    async (granted) => tool.run(input, granted),
    {
      grantId: binding.grantId,
      pendingActionId: binding.pendingActionId,
      operatorSessionId: binding.operatorSessionId,
      args: input,
    },
  );

  if (outcome.ok) return outcome.value;

  // A refusal for want of approval is not a dead end — it is the start of the
  // approval flow. The arguments are frozen here, so what the operator is
  // about to be read is exactly what will run.
  if (outcome.refusal === "needs-approval" && binding.proposeOnRefusal !== false) {
    const proposed = await propose({
      capabilityId: tool.capabilityId,
      requestedBy: binding.requestedBy ?? "text",
      actionSummary: describeCall(tool, input),
      args: input,
    });

    if (proposed.ok) {
      return {
        ok: false,
        awaitingApproval: proposed.action.id,
        summary: readBack(proposed.action, "voice"),
      };
    }
  }

  // A policy refusal never reached the world, so it is definitively
  // before-effect and safe to retry.
  return {
    ok: false,
    summary: `Not run. ${outcome.reason}`,
  };
}

/**
 * One sentence naming what will happen, built from the actual arguments.
 *
 * Read aloud before approval, so it has to contain the details that matter —
 * the recipient, the title, the amount. "Send an email" is not something a
 * person can meaningfully approve.
 */
export function describeCall(tool: ToolSpec, input: unknown): string {
  const record = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const detail = ["to", "title", "summary", "subject", "channel", "amount"]
    .filter((key) => typeof record[key] === "string" || typeof record[key] === "number")
    .map((key) => `${key}: ${String(record[key]).slice(0, 80)}`)
    .join(", ");

  return detail ? `${tool.purpose.split(".")[0]}. ${detail}.` : tool.purpose;
}

// ── Validation helpers ───────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * A date the model produced. Rejected if unparseable or in the past — an agent
 * scheduling into last week is a bug that would otherwise ship silently.
 */
function asFutureDate(value: unknown): Date | null {
  const text = asString(value);
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  // A minute of slack for clock skew between the model's idea of now and ours.
  if (date.getTime() < Date.now() - 60_000) return null;
  return date;
}

// ── The tools ────────────────────────────────────────────────────────────

export const TOOLS: Record<string, ToolSpec> = {
  "calendar.schedule": {
    name: "calendar.schedule",
    connectorId: "google-calendar",
    // Own calendar only. Inviting other people is `calendar.invite`, level 4.
    capabilityId: "calendar.propose",
    purpose:
      "Place each approved post on the operator's calendar at its publish time, so the week is visible rather than living in a document.",
    schemaHint: `{"events":[{"summary":string,"description":string,"startsAt":"ISO 8601 datetime in the future","minutes":number}]}`,
    async run(input, granted) {
      const root = asRecord(input);
      const events = Array.isArray(root?.events) ? root.events : null;
      if (!events || events.length === 0) {
        return { ok: false, summary: "No events proposed — nothing was scheduled." };
      }

      const created: string[] = [];
      const skipped: string[] = [];
      // If any single event's outcome is unknown, the whole call is unknown —
      // a partial batch cannot be retried wholesale without risking a double.
      let uncertain = false;

      for (const raw of events.slice(0, 10)) {
        const event = asRecord(raw);
        const summary = asString(event?.summary);
        const startsAt = asFutureDate(event?.startsAt);

        if (!summary || !startsAt) {
          skipped.push(
            `"${summary ?? "untitled"}" — ${startsAt ? "no title" : "missing or past start time"}`,
          );
          continue;
        }

        const result = await createCalendarEvent({
          granted,
          summary,
          description: asString(event?.description) ?? undefined,
          startsAt,
          minutes: typeof event?.minutes === "number" ? event.minutes : 30,
        });

        if (result.ok) {
          created.push(`${summary} — ${startsAt.toISOString()}`);
        } else {
          if (result.uncertain) uncertain = true;
          skipped.push(`"${summary}" — ${result.error}`);
        }
      }

      const lines = [
        created.length
          ? `Placed ${created.length} event${created.length === 1 ? "" : "s"} on the calendar:`
          : "Nothing was placed on the calendar.",
        ...created.map((c) => `- ${c}`),
      ];
      if (skipped.length) {
        lines.push("", "Skipped:", ...skipped.map((s) => `- ${s}`));
      }

      return { ok: created.length > 0, summary: lines.join("\n"), uncertain };
    },
  },

  "gmail.draft": {
    name: "gmail.draft",
    connectorId: "gmail",
    // Draft, never send. The split is the whole reason both exist.
    capabilityId: "mail.draft",
    purpose:
      "Save the approved reply as a Gmail draft. It is never sent — the operator presses send.",
    schemaHint: `{"to":string,"subject":string,"body":string}`,
    async run(input, granted) {
      const root = asRecord(input);
      const to = asString(root?.to);
      const subject = asString(root?.subject);
      const body = asString(root?.body);

      if (!to || !subject || !body) {
        return { ok: false, summary: "Draft not created — to, subject and body are all required." };
      }
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
        return { ok: false, summary: `Draft not created — "${to}" is not a valid address.` };
      }

      const result = await createMailDraft({ to, subject, body, granted });
      return result.ok
        ? { ok: true, summary: `Draft saved to Gmail for ${to} — "${subject}". Not sent.` }
        : { ok: false, summary: `Draft failed — ${result.error}`, uncertain: result.uncertain };
    },
  },

  "sheets.log": {
    name: "sheets.log",
    connectorId: "google-sheets",
    capabilityId: "doc.append",
    purpose:
      "Append one row to a running log spreadsheet, so results can be compared across weeks instead of living in prose.",
    schemaHint: `{"log":string,"row":[string]}`,
    async run(input, granted) {
      const root = asRecord(input);
      const log = asString(root?.log) ?? "Morpheus — run log";
      const row = Array.isArray(root?.row)
        ? root.row.map((cell) => (cell === null || cell === undefined ? "" : String(cell)))
        : null;

      if (!row || row.length === 0) {
        return { ok: false, summary: "Nothing logged — no row was proposed." };
      }

      // Stamped here rather than by the model: a model-invented timestamp in a
      // log is worse than none at all.
      const result = await appendToLog(log, [new Date().toISOString(), ...row], granted);
      return result.ok
        ? { ok: true, summary: `Logged to "${log}" — ${result.data.url}` }
        : { ok: false, summary: `Log failed — ${result.error}` };
    },
  },

  "slides.deck": {
    name: "slides.deck",
    connectorId: "google-slides",
    capabilityId: "doc.create",
    purpose: "Turn the approved outline into a Google Slides deck.",
    schemaHint: `{"title":string,"slides":[{"title":string,"body":string}]}`,
    async run(input, granted) {
      const root = asRecord(input);
      const title = asString(root?.title);
      const slides = Array.isArray(root?.slides) ? root.slides : [];

      if (!title) return { ok: false, summary: "Deck not created — a title is required." };

      const clean = slides
        .map((s) => {
          const slide = asRecord(s);
          const slideTitle = asString(slide?.title);
          return slideTitle ? { title: slideTitle, body: asString(slide?.body) ?? "" } : null;
        })
        .filter((s): s is { title: string; body: string } => s !== null);

      if (clean.length === 0) {
        return { ok: false, summary: "Deck not created — no usable slides were proposed." };
      }

      const result = await createSlideDeck({ title, slides: clean, granted });
      return result.ok
        ? {
            ok: true,
            summary: `Created "${title}" with ${clean.length} slide${clean.length === 1 ? "" : "s"} — ${result.data.url}`,
          }
        : { ok: false, summary: `Deck failed — ${result.error}` };
    },
  },
};

/** The prompt fragment that makes a model produce arguments, not prose. */
export function toolInstruction(tool: ToolSpec): string {
  return [
    `You are producing the arguments for the tool \`${tool.name}\`.`,
    `Purpose: ${tool.purpose}`,
    "",
    `Return ONLY JSON matching this shape, with no prose and no code fence:`,
    tool.schemaHint,
    "",
    "Rules:",
    "- Draw every value from the approved work above. Invent nothing.",
    "- Datetimes must be ISO 8601 and in the future.",
    `- If the approved work does not contain what this tool needs, return {} — an empty object is a correct answer.`,
    `- The tool touches the operator's ${CONNECTORS_BY_ID[tool.connectorId]?.name ?? tool.connectorId}. Be conservative.`,
  ].join("\n");
}
