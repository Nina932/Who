import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Durable state.
 *
 * Thor claims to *learn* — to keep facts, to pick up your style, to run loops
 * that get better each time. None of that is true if state dies with the
 * process, so everything lands on disk under `.thor/`.
 *
 * Deliberately flat JSON, not a database: the whole point is that you can open
 * `.thor/memory.json` and read exactly what the machine believes about you.
 * A system that claims durable memory should let you audit it with `cat`.
 */

const ROOT = process.env.THOR_DATA_DIR ?? path.join(process.cwd(), ".thor");

async function ensureRoot(): Promise<void> {
  await fs.mkdir(ROOT, { recursive: true });
}

function fileFor(collection: string): string {
  // Collection names are internal constants, but never build a path from
  // unsanitised input.
  const safe = collection.replace(/[^a-z0-9_-]/gi, "");
  return path.join(ROOT, `${safe}.json`);
}

export async function readCollection<T>(collection: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(fileFor(collection), "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return fallback;
    // A corrupt file should not take the cockpit down with it.
    console.error(`store: could not read ${collection}`, error);
    return fallback;
  }
}

export async function writeCollection<T>(collection: string, value: T): Promise<void> {
  await ensureRoot();
  const target = fileFor(collection);
  // Write-then-rename so a crash mid-write cannot leave a half-written file.
  const temp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(temp, target);
}

/**
 * Read-modify-write under a per-collection promise chain.
 *
 * Next.js route handlers run concurrently in one process, so two requests
 * mutating the same collection would otherwise interleave and lose writes.
 */
const chains = new Map<string, Promise<unknown>>();

export function mutate<T, R>(
  collection: string,
  fallback: T,
  mutator: (current: T) => { next: T; result: R } | Promise<{ next: T; result: R }>,
): Promise<R> {
  const previous = chains.get(collection) ?? Promise.resolve();

  const run = previous.then(async () => {
    const current = await readCollection<T>(collection, fallback);
    const { next, result } = await mutator(current);
    await writeCollection(collection, next);
    return result;
  });

  // Keep the chain alive even if this link rejects.
  chains.set(
    collection,
    run.catch(() => undefined),
  );
  return run;
}

/** Monotonic-ish id that stays readable in the JSON files. */
export function id(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}
