/**
 * Server side of the assistant layer.
 *
 * Same seam as the case ledger: everything above this line is pure and runs in
 * the browser, everything here touches disk. The brief itself is *built* on
 * the server so that the model-facing surfaces and the UI cannot drift apart —
 * there is one derivation, not two.
 */

import { buildBrief, type Brief, type BriefRecord, type Capacity } from "./brief";
import { caseViews } from "./case-store";
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
  entries: Entry[];
  /** Evidence-chain violations found in the stored knowledge, if any. */
  problems: string[];
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

  const brief = buildBrief({
    now,
    operator,
    cases,
    products,
    entries,
    capacity,
    history,
  });

  const views = products.map((p) => productView(p, entries, now));
  const classified = signals.map((s) => classify(s, views));
  const { alerts, digest } = partition(classified);

  return {
    brief,
    alerts,
    digest,
    entries,
    // Surfaced rather than thrown: a corrupt chain is a thing the operator
    // needs to know about, not an exception that hides the whole screen.
    problems: validate(entries).map((p) => `${p.entryId}: ${p.message}`),
  };
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
