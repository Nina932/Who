import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Durable state.
 *
 * Thor claims to *learn* — to keep facts, pick up your style, and run loops
 * that get better each time. None of that is true if state dies with the
 * process, so everything is persisted.
 *
 * Two drivers, because the right answer depends on where this runs:
 *
 *   fs      flat JSON under `.thor/` — the default, and deliberately readable.
 *           A system claiming durable memory should let you audit it with
 *           `cat`. Correct for a long-lived server; wrong on serverless, where
 *           the filesystem is per-instance and ephemeral.
 *   redis   Upstash Redis over its REST API, chosen because it needs no TCP
 *           socket and no client library — plain `fetch`, so it works in any
 *           runtime. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.
 *
 * The driver is picked once at module load. Collections are whole JSON
 * documents in both cases, so the semantics are identical and nothing above
 * this file knows which is in use.
 */

export interface StoreDriver {
  readonly name: string;
  read(collection: string): Promise<string | null>;
  write(collection: string, serialised: string): Promise<void>;
  remove(collection: string): Promise<void>;
}

// ── Filesystem ───────────────────────────────────────────────────────────

function createFsDriver(root: string): StoreDriver {
  const fileFor = (collection: string) =>
    // Collection names are internal constants, but never build a path from
    // unsanitised input.
    path.join(root, `${collection.replace(/[^a-z0-9_-]/gi, "")}.json`);

  return {
    name: "fs",
    async read(collection) {
      try {
        return await fs.readFile(fileFor(collection), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async write(collection, serialised) {
      await fs.mkdir(root, { recursive: true });
      const target = fileFor(collection);
      // Write-then-rename so a crash mid-write cannot leave a partial file.
      const temp = `${target}.${process.pid}.tmp`;
      await fs.writeFile(temp, serialised, "utf8");
      await fs.rename(temp, target);
    },
    async remove(collection) {
      await fs.rm(fileFor(collection), { force: true });
    },
  };
}

// ── Upstash Redis (REST) ─────────────────────────────────────────────────

function createRedisDriver(url: string, token: string): StoreDriver {
  const key = (collection: string) => `thor:${collection.replace(/[^a-z0-9_-]/gi, "")}`;

  const command = async (parts: string[]): Promise<unknown> => {
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(parts),
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`upstash ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    return (await response.json()) as { result?: unknown };
  };

  return {
    name: "redis",
    async read(collection) {
      const body = (await command(["GET", key(collection)])) as { result?: string | null };
      return body.result ?? null;
    },
    async write(collection, serialised) {
      await command(["SET", key(collection), serialised]);
    },
    async remove(collection) {
      await command(["DEL", key(collection)]);
    },
  };
}

function selectDriver(): StoreDriver {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return createRedisDriver(url, token);
  return createFsDriver(process.env.THOR_DATA_DIR ?? path.join(process.cwd(), ".thor"));
}

let driver: StoreDriver = selectDriver();

/** Which driver is live — surfaced so the UI can warn about ephemeral state. */
export function driverName(): string {
  return driver.name;
}

/** Swap the driver. Exists for tests; production selects once at load. */
export function setDriver(next: StoreDriver): void {
  driver = next;
}

// ── Collection access ────────────────────────────────────────────────────

export async function readCollection<T>(collection: string, fallback: T): Promise<T> {
  try {
    const raw = await driver.read(collection);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch (error) {
    // A corrupt document or an unreachable backend should not take the
    // cockpit down with it.
    console.error(`store: could not read ${collection}`, error);
    return fallback;
  }
}

export async function writeCollection<T>(collection: string, value: T): Promise<void> {
  await driver.write(collection, JSON.stringify(value, null, 2));
}

export async function dropCollection(collection: string): Promise<void> {
  await driver.remove(collection);
}

/**
 * Read-modify-write under a per-collection promise chain.
 *
 * Route handlers run concurrently in one process, so a naive
 * read-modify-write would interleave and silently lose updates.
 *
 * The chain is per-process. On a single long-lived server that is the whole
 * story; behind several instances sharing Redis it is not, and a compare-and-
 * set would be needed. That is a real limit and it is named in docs/ENGINE.md
 * rather than papered over.
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

/** Monotonic-ish id that stays readable in the stored documents. */
export function id(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}
