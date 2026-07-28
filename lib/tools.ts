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
}

export interface ToolSpec {
  name: string;
  connectorId: ConnectorId;
  /** Told to the model, so it knows what it is producing arguments for. */
  purpose: string;
  /** The exact JSON shape the model must return. */
  schemaHint: string;
  run: (input: unknown) => Promise<ToolResult>;
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
    purpose:
      "Place each approved post on the operator's calendar at its publish time, so the week is visible rather than living in a document.",
    schemaHint: `{"events":[{"summary":string,"description":string,"startsAt":"ISO 8601 datetime in the future","minutes":number}]}`,
    async run(input) {
      const root = asRecord(input);
      const events = Array.isArray(root?.events) ? root.events : null;
      if (!events || events.length === 0) {
        return { ok: false, summary: "No events proposed — nothing was scheduled." };
      }

      const created: string[] = [];
      const skipped: string[] = [];

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
          summary,
          description: asString(event?.description) ?? undefined,
          startsAt,
          minutes: typeof event?.minutes === "number" ? event.minutes : 30,
        });

        if (result.ok) {
          created.push(`${summary} — ${startsAt.toISOString()}`);
        } else {
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

      return { ok: created.length > 0, summary: lines.join("\n") };
    },
  },

  "gmail.draft": {
    name: "gmail.draft",
    connectorId: "gmail",
    purpose:
      "Save the approved reply as a Gmail draft. It is never sent — the operator presses send.",
    schemaHint: `{"to":string,"subject":string,"body":string}`,
    async run(input) {
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

      const result = await createMailDraft({ to, subject, body });
      return result.ok
        ? { ok: true, summary: `Draft saved to Gmail for ${to} — "${subject}". Not sent.` }
        : { ok: false, summary: `Draft failed — ${result.error}` };
    },
  },

  "sheets.log": {
    name: "sheets.log",
    connectorId: "google-sheets",
    purpose:
      "Append one row to a running log spreadsheet, so results can be compared across weeks instead of living in prose.",
    schemaHint: `{"log":string,"row":[string]}`,
    async run(input) {
      const root = asRecord(input);
      const log = asString(root?.log) ?? "Thor — run log";
      const row = Array.isArray(root?.row)
        ? root.row.map((cell) => (cell === null || cell === undefined ? "" : String(cell)))
        : null;

      if (!row || row.length === 0) {
        return { ok: false, summary: "Nothing logged — no row was proposed." };
      }

      // Stamped here rather than by the model: a model-invented timestamp in a
      // log is worse than none at all.
      const result = await appendToLog(log, [new Date().toISOString(), ...row]);
      return result.ok
        ? { ok: true, summary: `Logged to "${log}" — ${result.data.url}` }
        : { ok: false, summary: `Log failed — ${result.error}` };
    },
  },

  "slides.deck": {
    name: "slides.deck",
    connectorId: "google-slides",
    purpose: "Turn the approved outline into a Google Slides deck.",
    schemaHint: `{"title":string,"slides":[{"title":string,"body":string}]}`,
    async run(input) {
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

      const result = await createSlideDeck({ title, slides: clean });
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
