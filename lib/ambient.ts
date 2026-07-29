/**
 * Ambient context — the strip of the cockpit that is true whether or not you
 * are talking to Thor: time, weather, who you are, and one thing that
 * happened on this date. It exists to make the machine feel present rather
 * than summoned.
 */

export interface AmbientConfig {
  /** Empty means the greeting simply omits a name. */
  operator: string;
  /** Empty means the weather line omits a place. */
  city: string;
  /** Celsius. Only shown when a live reading is unavailable. */
  temperature: number;
  conditions: string;
}

/**
 * Whose cockpit this is.
 *
 * Deliberately blank by default. An earlier version hardcoded a name and a
 * city taken from the reference screenshots, which meant every install greeted
 * someone else's operator in someone else's city. A cockpit that gets this
 * wrong is worse than one that says nothing.
 *
 * Set in `.env.local`:
 *
 *   THOR_OPERATOR=Nina
 *   THOR_CITY=Tbilisi
 *   THOR_LAT=41.7151
 *   THOR_LON=44.8271
 *
 * Read on the server and delivered through /api/ambient rather than inlined
 * with a NEXT_PUBLIC_ prefix, so changing your name takes effect on the next
 * page load rather than the next build.
 *
 * Two things have to hold for this to be a real runtime lookup, and both were
 * got wrong at first:
 *
 *  - the route serving it must be `dynamic = "force-dynamic"`. With
 *    `revalidate` it is statically generated at build time and serves whatever
 *    the environment held during `npm run build`, which is nothing.
 *  - the read goes through a variable key. Bundlers can replace a literal
 *    `process.env.FOO`; they cannot replace `process.env[name]`.
 */
function env(name: string): string {
  return process.env[name] ?? "";
}

/**
 * The operator this build belongs to.
 *
 * A default rather than a hardcoding: `THOR_OPERATOR` still wins, so a second
 * install greets whoever set it. The earlier blank default was right when the
 * name came from someone else's screenshot and wrong once this became a
 * particular person's cockpit — an assistant that will not say your name is
 * not being careful, it is being unfinished.
 */
const DEFAULT_OPERATOR = "Nino";

export const AMBIENT: AmbientConfig = {
  get operator() {
    return env("THOR_OPERATOR") || DEFAULT_OPERATOR;
  },
  get city() {
    return env("THOR_CITY");
  },
  temperature: 0,
  conditions: "",
};

// ── Time ─────────────────────────────────────────────────────────────────

/**
 * The operator's local hour — not the server's.
 *
 * The brief is derived server-side, so `new Date().getHours()` is the hour
 * wherever the process happens to run. On a UTC host that greeted a UTC+4
 * operator with "Good evening" over breakfast, which is the kind of small
 * wrongness that makes everything else on the page feel guessed at.
 *
 * `THOR_TZ` is an IANA zone (`Asia/Tbilisi`). Unset falls back to the host's
 * zone, which is correct when you run this on your own machine.
 */
export function timeZone(): string | undefined {
  return env("THOR_TZ") || undefined;
}

export function localHour(at: number = Date.now()): number {
  const zone = timeZone();
  if (!zone) return new Date(at).getHours();
  try {
    return Number(
      new Intl.DateTimeFormat("en-GB", {
        hour: "2-digit",
        hour12: false,
        timeZone: zone,
      }).format(at),
    );
  } catch {
    // A bad zone string should cost you an accurate greeting, not the page.
    return new Date(at).getHours();
  }
}

/** The hours you actually work, so "how much of today is left" has meaning. */
export function workingDay(): { start: number; end: number } {
  const start = Number(env("THOR_DAY_START"));
  const end = Number(env("THOR_DAY_END"));
  return {
    start: Number.isFinite(start) && start > 0 ? start : 9,
    end: Number.isFinite(end) && end > 0 ? end : 18,
  };
}

/**
 * Hours left in the working day.
 *
 * The difference between an assistant and a list: at four in the afternoon
 * you do not have six hours, and a plan that assumes you do is a plan you
 * will not finish. Returns the full day before it starts, and zero after.
 */
export function hoursLeftToday(at: number = Date.now()): number {
  const { start, end } = workingDay();
  const zone = timeZone();

  let hour: number;
  let minute: number;
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: zone,
    }).formatToParts(at);
    hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
    minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  } catch {
    const date = new Date(at);
    hour = date.getHours();
    minute = date.getMinutes();
  }

  const now = hour + minute / 60;
  if (now <= start) return end - start;
  return Math.max(0, end - now);
}

/** Coordinates for the weather readout, or null when unset. */
export function coordinates(): { lat: string; lon: string } | null {
  const lat = env("THOR_LAT");
  const lon = env("THOR_LON");
  return lat && lon ? { lat, lon } : null;
}

export function greeting(hour: number): string {
  if (hour < 5) return "Still up";
  // Six is not "morning" in the sense the word usually carries, and an
  // assistant that says "Good morning" at 06:10 to someone who has been up
  // since five sounds like a script rather than a colleague.
  if (hour < 8) return "Early start";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  if (hour < 22) return "Good evening";
  return "Late one";
}

/** The greeting with the operator's name, or without it if none is set. */
export function greetingLine(hour: number, operator: string): string {
  return operator.trim() ? `${greeting(hour)}, ${operator.trim()}` : greeting(hour);
}

const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MONTHS = [
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];

export function formatClock(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function formatDate(d: Date): string {
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/**
 * A small local almanac. Deliberately offline: the cockpit must render the
 * same with or without network, and one good fact beats a spinner.
 */
const ALMANAC: Record<string, string> = {
  "01-24": "1984 — Apple shipped the first Macintosh, the machine that argued a computer could be personal.",
  "02-24": "1955 — Steve Jobs was born in San Francisco.",
  "03-11": "1985 — Mikhail Gorbachev took office and began dismantling the Soviet system from inside it.",
  "04-12": "1961 — Yuri Gagarin became the first human in orbit, a flight lasting 108 minutes.",
  "05-25": "1961 — Kennedy committed the United States to the Moon before anyone knew how to get there.",
  "06-15": "1215 — The Magna Carta was sealed at Runnymede, first binding a ruler to written law.",
  "07-20": "1969 — Apollo 11 landed at Tranquility Base with roughly 25 seconds of fuel remaining.",
  "07-24": "1969 — Apollo 11 splashed down safely in the Pacific Ocean, returning the first humans to walk on the Moon to Earth.",
  "07-28": "1858 — Fingerprints were used to sign a contract for the first time, in India, on the theory that no two hands are alike.",
  "08-06": "1991 — Tim Berners-Lee posted a summary of the World Wide Web project to a Usenet newsgroup.",
  "09-09": "1947 — Grace Hopper's team logged a literal moth in a relay and taped it into the notebook.",
  "10-29": "1969 — The first message was sent over ARPANET; the system crashed after two letters.",
  "11-10": "1983 — Microsoft announced Windows, two years before it shipped.",
  "12-23": "1947 — Bell Labs demonstrated the transistor, and everything since is downstream of it.",
};

const FALLBACKS = [
  "No entry in the almanac for today — which is its own kind of clean slate.",
  "Nothing on file for this date. The interesting thing about today is that it has not happened yet.",
];

export function onThisDay(d: Date): string {
  const key = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return ALMANAC[key] ?? FALLBACKS[d.getDate() % FALLBACKS.length];
}
