/**
 * Ambient context — the strip of the cockpit that is true whether or not you
 * are talking to Apex: time, weather, who you are, and one thing that
 * happened on this date. It exists to make the machine feel present rather
 * than summoned.
 */

export interface AmbientConfig {
  operator: string;
  city: string;
  /** Celsius. */
  temperature: number;
  conditions: string;
}

export const AMBIENT: AmbientConfig = {
  operator: "Ruben",
  city: "Tel Aviv",
  temperature: 24,
  conditions: "Partly cloudy",
};

export function greeting(hour: number): string {
  if (hour < 5) return "Still up";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
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
