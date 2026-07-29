/**
 * Server side of the assistant layer.
 *
 * Same seam as the case ledger: everything above this line is pure and runs in
 * the browser, everything here touches disk. The brief itself is *built* on
 * the server so that the model-facing surfaces and the UI cannot drift apart —
 * there is one derivation, not two.
 */

import { hoursLeftToday, localHour } from "./ambient";
import { buildBrief, type Brief, type BriefRecord, type Capacity } from "./brief";
import { bookedHoursIn, toBusy } from "./calendar";
import { caseViews } from "./case-store";
import { listCalendarEvents } from "./connectors";
import { merge, poll, type PollResult } from "./feeds";
import { contextFor, systemPromptFor, unphrasedAnswer, type ModeId, type TruthInput } from "./modes";
import { callRole } from "./models";
import { validate, type Entry } from "./knowledge";
import { exampleKnowledge, exampleProducts, type Blocker, type Product } from "./products";
import { classify, exampleSignals, partition, type Classified, type Signal } from "./signals";
import { id, mutate, readCollection } from "./store";
import { view as productView } from "./products";

const ENTRIES = "knowledge";
const PRODUCTS = "products";
const SIGNALS = "signals";
const HISTORY = "brief-history";
const CAPACITY = "capacity";

const DEFAULT_CAPACITY: Capacity = { plannedHours: 6, bookedHours: null };

export async function allEntries(): Promise<Entry[]> {
  return readCollection<Entry[]>(ENTRIES, []);
}

export async function allProducts(): Promise<Product[]> {
  return readCollection<Product[]>(PRODUCTS, []);
}

export async function allSignals(): Promise<Signal[]> {
  return readCollection<Signal[]>(SIGNALS, []);
}

export async function getCapacity(): Promise<Capacity> {
  return readCollection<Capacity>(CAPACITY, DEFAULT_CAPACITY);
}

export async function setCapacity(next: Capacity): Promise<Capacity> {
  return mutate<Capacity, Capacity>(CAPACITY, DEFAULT_CAPACITY, () => ({
    next,
    result: next,
  }));
}

// ── Knowledge ────────────────────────────────────────────────────────────

/**
 * Add an entry, refusing anything that would corrupt the evidence chain.
 *
 * The rejection is the feature. An entry that cites a hypothesis as proof is
 * turned away at the door rather than stored and quietly reasoned from — the
 * whole point of typing memory is lost if invalid chains can be written and
 * only noticed later.
 */
export async function addEntry(
  entry: Omit<Entry, "id"> & { id?: string },
): Promise<{ ok: boolean; entry?: Entry; problems?: string[] }> {
  const candidate: Entry = { ...entry, id: entry.id ?? id("k") };

  return mutate<Entry[], { ok: boolean; entry?: Entry; problems?: string[] }>(
    ENTRIES,
    [],
    (current) => {
      const problems = validate([...current, candidate]).filter(
        (p) => p.entryId === candidate.id,
      );
      if (problems.length > 0) {
        return { next: current, result: { ok: false, problems: problems.map((p) => p.message) } };
      }
      return { next: [...current, candidate], result: { ok: true, entry: candidate } };
    },
  );
}

/** Replace an entry without deleting it — the old one stays, marked. */
export async function supersede(entryId: string, replacement: Omit<Entry, "id">): Promise<Entry> {
  const next: Entry = { ...replacement, id: id("k") };
  await mutate<Entry[], null>(ENTRIES, [], (current) => ({
    next: [...current.map((e) => (e.id === entryId ? { ...e, supersededBy: next.id } : e)), next],
    result: null,
  }));
  return next;
}

// ── Products ─────────────────────────────────────────────────────────────

export async function patchProduct(
  productId: string,
  patch: Partial<Product>,
): Promise<Product | null> {
  return mutate<Product[], Product | null>(PRODUCTS, [], (current) => {
    let updated: Product | null = null;
    const next = current.map((product) => {
      if (product.id !== productId) return product;
      // Moving phase restarts the phase clock; forgetting to would make every
      // staleness rule quietly wrong.
      const movedPhase = patch.phase !== undefined && patch.phase !== product.phase;
      updated = { ...product, ...patch, phaseSince: movedPhase ? Date.now() : product.phaseSince };
      return updated;
    });
    return { next, result: updated };
  });
}

export async function resolveBlocker(
  productId: string,
  blockerId: string,
  at = Date.now(),
): Promise<Product | null> {
  return mutate<Product[], Product | null>(PRODUCTS, [], (current) => {
    let updated: Product | null = null;
    const next = current.map((product) => {
      if (product.id !== productId) return product;
      updated = {
        ...product,
        blockers: product.blockers.map((b: Blocker) =>
          b.id === blockerId ? { ...b, resolvedAt: at } : b,
        ),
      };
      return updated;
    });
    return { next, result: updated };
  });
}

// ── The brief ────────────────────────────────────────────────────────────

export interface AssistantState {
  brief: Brief;
  alerts: Classified[];
  digest: Classified[];
  /** Urgent items that exceeded the interruption cap. Never silently dropped. */
  pushedDown: number;
  entries: Entry[];
  /** Evidence-chain violations found in the stored knowledge, if any. */
  problems: string[];
  /** Where the booked hours came from, so the number is never anonymous. */
  calendar: { connected: boolean; bookedHours: number | null; note: string };
}

/**
 * Read today's remaining calendar rather than assuming an empty day.
 *
 * Measured against the window between now and the end of the working day,
 * because what matters is not how long today's meetings are but how much of
 * the time you have left is already spoken for. A calendar that cannot be
 * reached returns null and says why — the brief then reports uncertainty
 * instead of inventing an empty afternoon.
 */
async function readCalendar(
  now: number,
): Promise<{ connected: boolean; bookedHours: number | null; note: string }> {
  const result = await listCalendarEvents(1);

  if (!result.ok) {
    return {
      connected: false,
      bookedHours: null,
      note: result.needsConnection
        ? "Calendar not connected."
        : `Calendar unreachable: ${result.error ?? "unknown error"}.`,
    };
  }

  const windowEnd = now + hoursLeftToday(now) * 3_600_000;
  const hours = bookedHoursIn(toBusy(result.data), now, windowEnd);
  return {
    connected: true,
    bookedHours: hours,
    note: `Read from your calendar: ${hours}h booked between now and the end of your day.`,
  };
}

export async function assistantState(
  operator: string,
  now = Date.now(),
): Promise<AssistantState> {
  const [cases, entries, products, signals, history, capacity] = await Promise.all([
    caseViews(now),
    allEntries(),
    allProducts(),
    allSignals(),
    readCollection<BriefRecord[]>(HISTORY, []),
    getCapacity(),
  ]);

  // A real reading replaces the stored guess whenever one is available.
  const calendar = await readCalendar(now);
  const effective: Capacity = {
    // Never plan more hours than the working day has left in it. At four in
    // the afternoon you do not have six hours, and a brief that says you do
    // is one you will not finish.
    plannedHours: Math.min(capacity.plannedHours, Math.max(0, hoursLeftToday(now))),
    bookedHours: calendar.connected ? calendar.bookedHours : capacity.bookedHours,
  };

  // Built here because only this layer knows all three pieces: whether the
  // calendar answered, how much of the working day is left, and what the
  // operator said they would give.
  const left = hoursLeftToday(now);
  const shortened = left < capacity.plannedHours;
  const capacityNote = [
    calendar.connected
      ? `${calendar.bookedHours}h of what remains is already booked.`
      : calendar.note.startsWith("Calendar not")
        ? "No calendar connected, so nothing has checked this against your actual day."
        : calendar.note,
    shortened
      ? `Only ${Math.round(left * 10) / 10}h of your working day is left, so the ${capacity.plannedHours}h you planned is not on offer.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  const brief = buildBrief({
    now,
    operator,
    localHour: localHour(now),
    capacityNote,
    cases,
    products,
    entries,
    capacity: effective,
    history,
  });

  const views = products.map((p) => productView(p, entries, now));
  const classified = signals.map((s) => classify(s, views));
  const { alerts, digest, pushedDown } = partition(classified);

  return {
    brief,
    alerts,
    digest,
    pushedDown,
    entries,
    // Surfaced rather than thrown: a corrupt chain is a thing the operator
    // needs to know about, not an exception that hides the whole screen.
    problems: validate(entries).map((p) => `${p.entryId}: ${p.message}`),
    calendar,
  };
}

// ── The feed ─────────────────────────────────────────────────────────────

/**
 * Poll every configured source and keep only what touches this business.
 *
 * Filtering happens at ingestion. A store that accumulates every headline is
 * a news database, and the first time it is slow the temptation is to show it
 * unfiltered.
 */
export async function pollFeeds(now = Date.now()): Promise<PollResult[]> {
  const [products, entries] = await Promise.all([allProducts(), allEntries()]);
  const views = products.map((p) => productView(p, entries, now));

  if (views.filter((v) => v.active).length === 0) {
    return [
      {
        source: "—",
        ok: false,
        found: 0,
        kept: 0,
        error: "No active products, so there is no vocabulary to match against.",
      },
    ];
  }

  const { signals, results } = await poll(views, now);
  await mutate<Signal[], null>(SIGNALS, [], (current) => ({
    next: merge(current, signals),
    result: null,
  }));
  return results;
}

// ── Modes ────────────────────────────────────────────────────────────────

export interface Answer {
  mode: ModeId;
  text: string;
  /** False when no model phrased it — the state is returned instead. */
  live: boolean;
  /** Always returned, so the answer can be checked against its own basis. */
  context: string;
  model?: string;
}

/**
 * Ask one mode a question.
 *
 * The model is handed the derived state and forbidden from adding to it. With
 * no key the assembled context comes back verbatim with a plain statement
 * that nothing phrased it — degrading to *less fluent*, never to *made up*.
 */
export async function ask(
  mode: ModeId,
  question: string,
  operator: string,
  now = Date.now(),
): Promise<Answer> {
  const state = await assistantState(operator, now);
  const [products, entries] = await Promise.all([allProducts(), allEntries()]);

  const truth: TruthInput = {
    brief: state.brief,
    products: products.map((p) => productView(p, entries, now)),
    entries,
    alerts: state.alerts,
    digest: state.digest,
    now,
  };

  const context = contextFor(mode, truth);

  const result = await callRole("hard", {
    system: systemPromptFor(mode),
    messages: [{ role: "user", content: `CURRENT STATE:\n\n${context}\n\n---\n\nQUESTION: ${question}` }],
  });

  if (!result.live) {
    return {
      mode,
      live: false,
      context,
      text: unphrasedAnswer(mode, context, result.error ?? "No model available."),
    };
  }

  return { mode, live: true, context, text: result.text, model: result.spec.label };
}

/**
 * Record that a brief was shown, so avoidance can be measured.
 *
 * Written once per day at most — recording every page load would make three
 * refreshes look like three days of not doing something.
 */
export async function recordBrief(brief: Brief): Promise<void> {
  await mutate<BriefRecord[], null>(HISTORY, [], (current) => {
    const day = 86_400_000;
    const last = current[0];
    if (last && brief.at - last.at < day) return { next: current, result: null };
    return {
      next: [{ at: brief.at, itemKeys: brief.items.map((i) => i.key) }, ...current].slice(0, 60),
      result: null,
    };
  });
}

// ── Examples ─────────────────────────────────────────────────────────────

export async function seedAssistantExamples(now = Date.now()): Promise<number> {
  const [products, entries, signals] = await Promise.all([
    mutate<Product[], number>(PRODUCTS, [], (current) =>
      current.length > 0
        ? { next: current, result: 0 }
        : { next: exampleProducts(now), result: exampleProducts(now).length },
    ),
    mutate<Entry[], number>(ENTRIES, [], (current) =>
      current.length > 0
        ? { next: current, result: 0 }
        : { next: exampleKnowledge(now), result: exampleKnowledge(now).length },
    ),
    mutate<Signal[], number>(SIGNALS, [], (current) =>
      current.length > 0
        ? { next: current, result: 0 }
        : { next: exampleSignals(now), result: exampleSignals(now).length },
    ),
  ]);
  return products + entries + signals;
}

export async function clearAssistantExamples(): Promise<number> {
  const drop = async <T extends { demo?: boolean }>(collection: string): Promise<number> =>
    mutate<T[], number>(collection, [], (current) => {
      const next = current.filter((row) => row.demo !== true);
      return { next, result: current.length - next.length };
    });

  const [products, signals] = await Promise.all([
    drop<Product>(PRODUCTS),
    drop<Signal>(SIGNALS),
  ]);

  // Knowledge entries carry no demo flag of their own; they are identified by
  // the ids the example set uses, so a real entry can never be swept up.
  const exampleIds = new Set(exampleKnowledge(Date.now()).map((e) => e.id));
  const entries = await mutate<Entry[], number>(ENTRIES, [], (current) => {
    const next = current.filter((e) => !exampleIds.has(e.id));
    return { next, result: current.length - next.length };
  });

  return products + signals + entries;
}
