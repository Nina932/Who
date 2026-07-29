import { NextResponse } from "next/server";
import { AMBIENT } from "@/lib/ambient";
import {
  addEntry,
  allProducts,
  assistantState,
  clearAssistantExamples,
  getCapacity,
  recordBrief,
  resolveBlocker,
  seedAssistantExamples,
  setCapacity,
} from "@/lib/assistant-store";
import { guardMutation } from "@/lib/guard";
import type { Kind, Provenance } from "@/lib/knowledge";
import type { Phase } from "@/lib/products";

/**
 * The assistant's surface.
 *
 * The brief is derived here rather than in the browser so that what the UI
 * shows and what a model would be handed come from the same call. Two
 * derivations of "what should I do today" is one derivation too many.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const state = await assistantState(AMBIENT.operator);
  const [products, capacity] = await Promise.all([allProducts(), getCapacity()]);
  return NextResponse.json({ ...state, products, capacity });
}

interface Body {
  action?: unknown;
  kind?: unknown;
  subject?: unknown;
  text?: unknown;
  provenance?: unknown;
  evidence?: unknown;
  dueAt?: unknown;
  productId?: unknown;
  blockerId?: unknown;
  phase?: unknown;
  plannedHours?: unknown;
  bookedHours?: unknown;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

const KINDS: Kind[] = ["fact", "decision", "hypothesis", "preference", "commitment", "recommendation"];
const PROVENANCES: Provenance[] = ["observed", "stated", "inferred", "guessed"];

export async function POST(request: Request) {
  const blocked = guardMutation(request);
  if (blocked) return blocked.response;

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Malformed body." }, { status: 400 });
  }

  const reply = async (extra: Record<string, unknown> = {}) => {
    const state = await assistantState(AMBIENT.operator);
    const [products, capacity] = await Promise.all([allProducts(), getCapacity()]);
    return NextResponse.json({ ...state, products, capacity, ...extra });
  };

  try {
    switch (str(body.action)) {
      case "remember": {
        const kind = str(body.kind) as Kind | undefined;
        const text = str(body.text);
        const subject = str(body.subject) ?? "business";
        const provenance = (str(body.provenance) ?? "stated") as Provenance;

        if (!kind || !KINDS.includes(kind)) {
          return NextResponse.json(
            { error: `kind must be one of: ${KINDS.join(", ")}` },
            { status: 400 },
          );
        }
        if (!PROVENANCES.includes(provenance)) {
          return NextResponse.json(
            { error: `provenance must be one of: ${PROVENANCES.join(", ")}` },
            { status: 400 },
          );
        }
        if (!text) return NextResponse.json({ error: "text required." }, { status: 400 });

        const result = await addEntry({
          kind,
          subject,
          text,
          provenance,
          at: Date.now(),
          dueAt: num(body.dueAt),
          evidence: Array.isArray(body.evidence)
            ? body.evidence.filter((r): r is string => typeof r === "string")
            : undefined,
        });

        // A rejected entry is a 400 with the reason, not a silent no-op — the
        // operator should find out that their evidence chain was unsound.
        if (!result.ok) {
          return NextResponse.json({ error: result.problems?.join("; ") }, { status: 400 });
        }
        return reply({ added: result.entry });
      }

      case "resolve-blocker": {
        const productId = str(body.productId);
        const blockerId = str(body.blockerId);
        if (!productId || !blockerId) {
          return NextResponse.json({ error: "productId and blockerId required." }, { status: 400 });
        }
        const updated = await resolveBlocker(productId, blockerId);
        if (!updated) return NextResponse.json({ error: "Unknown product." }, { status: 404 });
        return reply();
      }

      case "set-phase": {
        const productId = str(body.productId);
        const phase = str(body.phase) as Phase | undefined;
        if (!productId || !phase) {
          return NextResponse.json({ error: "productId and phase required." }, { status: 400 });
        }
        const { patchProduct } = await import("@/lib/assistant-store");
        const updated = await patchProduct(productId, { phase });
        if (!updated) return NextResponse.json({ error: "Unknown product." }, { status: 404 });
        return reply();
      }

      case "set-capacity": {
        const plannedHours = num(body.plannedHours);
        if (plannedHours === undefined) {
          return NextResponse.json({ error: "plannedHours required." }, { status: 400 });
        }
        await setCapacity({
          plannedHours,
          bookedHours: body.bookedHours === null ? null : (num(body.bookedHours) ?? null),
        });
        return reply();
      }

      case "acknowledge": {
        // Marks the brief as seen, which is what makes avoidance measurable.
        const state = await assistantState(AMBIENT.operator);
        await recordBrief(state.brief);
        return reply();
      }

      case "seed-examples":
        return reply({ added: await seedAssistantExamples() });

      case "clear-examples":
        return reply({ removed: await clearAssistantExamples() });

      default:
        return NextResponse.json({ error: `Unknown action: ${String(body.action)}` }, { status: 400 });
    }
  } catch (error) {
    console.error("assistant route failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Assistant action failed." },
      { status: 500 },
    );
  }
}
