import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Durable state.
 *
 * Morpheus claims to *learn* — to keep facts, pick up your style, and run loops
 * that get better each time. None of that is true if state dies with the
 * process, so everything is persisted.
 *
 * Two drivers, because the right answer depends on where this runs:
 *
 *   fs      flat JSON under `.morpheus/` — the default, and deliberately readable.
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

export interface Versioned {
  serialised: string | null;
  /** Opaque token identifying this exact revision. */
  version: string;
}

export interface StoreDriver {
  readonly name: string;
  read(collection: string): Promise<string | null>;
  write(collection: string, serialised: string): Promise<void>;
  remove(collection: string): Promise<void>;
  /**
   * Read with the revision token needed for a compare-and-set.
   * Drivers that cannot version return a constant, which degrades to
   * last-write-wins — correct for single-process, unsafe for many.
   */
  readVersioned?(collection: string): Promise<Versioned>;
  /**
   * Write only if the stored revision still matches `expected`.
   * Returns false when someone else wrote first.
   */
  writeIfUnchanged?(
    collection: string,
    serialised: string,
    expected: string,
  ): Promise<boolean>;
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
  const key = (collection: string) => `morpheus:${collection.replace(/[^a-z0-9_-]/gi, "")}`;
  const versionKey = (collection: string) => `${key(collection)}:v`;

  /**
   * Compare-and-set, server-side.
   *
   * A version counter lives beside the document. The script checks it and
   * bumps it in one atomic step, so two instances writing concurrently cannot
   * both believe they won — which is exactly what the per-process chain
   * cannot protect against.
   */
  const CAS_SCRIPT = `
    local current = redis.call('GET', KEYS[2])
    if current == false then current = '0' end
    if current ~= ARGV[2] then return 0 end
    redis.call('SET', KEYS[1], ARGV[1])
    redis.call('SET', KEYS[2], tostring(tonumber(current) + 1))
    return 1
  `;

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
      await command(["DEL", key(collection), versionKey(collection)]);
    },
    async readVersioned(collection) {
      // One round trip for both the document and its revision counter.
      const body = (await command([
        "MGET",
        key(collection),
        versionKey(collection),
      ])) as { result?: Array<string | null> };
      const [serialised, version] = body.result ?? [];
      return { serialised: serialised ?? null, version: version ?? "0" };
    },
    async writeIfUnchanged(collection, serialised, expected) {
      const body = (await command([
        "EVAL",
        CAS_SCRIPT,
        "2",
        key(collection),
        versionKey(collection),
        serialised,
        expected,
      ])) as { result?: number };
      return body.result === 1;
    },
  };
}

function selectDriver(): StoreDriver {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return createRedisDriver(url, token);
  return createFsDriver(process.env.MORPHEUS_DATA_DIR ?? path.join(process.cwd(), ".morpheus"));
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
 * The chain alone is per-process, which is fine for one long-lived server and
 * not fine behind several instances. When the driver supports versioning, this
 * additionally does a compare-and-set: read the revision, apply the mutator,
 * and write only if nobody else moved first — retrying on fresh state if they
 * did. That is what makes horizontal scale safe.
 *
 * The mutator must therefore be a pure function of `current`: it can be
 * re-run, so side effects inside it would happen more than once.
 */
const chains = new Map<string, Promise<unknown>>();

const MAX_CAS_ATTEMPTS = 8;

export function mutate<T, R>(
  collection: string,
  fallback: T,
  mutator: (current: T) => { next: T; result: R } | Promise<{ next: T; result: R }>,
): Promise<R> {
  const previous = chains.get(collection) ?? Promise.resolve();

  const run = previous.then(async () => {
    // Fast path: a driver with no versioning is single-process by definition,
    // and the chain above is already sufficient.
    if (!driver.readVersioned || !driver.writeIfUnchanged) {
      const current = await readCollection<T>(collection, fallback);
      const { next, result } = await mutator(current);
      await writeCollection(collection, next);
      return result;
    }

    // Optimistic retry: re-read and re-apply when another instance wrote
    // first. The mutator runs again on fresh state rather than clobbering it,
    // which is why it must stay a pure function of `current`.
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const { serialised, version } = await driver.readVersioned(collection);

      let current: T = fallback;
      if (serialised !== null) {
        try {
          current = JSON.parse(serialised) as T;
        } catch (error) {
          console.error(`store: could not parse ${collection}`, error);
        }
      }

      const { next, result } = await mutator(current);
      const won = await driver.writeIfUnchanged(
        collection,
        JSON.stringify(next, null, 2),
        version,
      );
      if (won) return result;

      // Brief, growing backoff so contending writers separate.
      await new Promise((resolve) => setTimeout(resolve, 8 * (attempt + 1)));
    }

    throw new Error(
      `store: gave up writing ${collection} after ${MAX_CAS_ATTEMPTS} contended attempts`,
    );
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
