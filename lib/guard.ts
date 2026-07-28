import { NextResponse } from "next/server";

/**
 * A gate in front of the mutating endpoints.
 *
 * Thor's write endpoints approve autonomous work, delete memory and spend
 * money on model calls. On localhost that is fine; the moment the port is
 * reachable by anything else it is not, and this build had no check at all.
 *
 * Two layers, both cheap:
 *
 *   origin  cross-site requests are rejected outright, so a random page cannot
 *           drive the API from a victim's browser
 *   secret  when THOR_API_SECRET is set, every mutating call must present it
 *
 * The secret is opt-in because forcing one on a local single-user cockpit
 * would just get exported into a shell profile and forgotten. Anything beyond
 * localhost should set it.
 */

export interface GuardFailure {
  response: NextResponse;
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  // Non-browser callers (curl, cron) send no Origin; the secret covers those.
  if (!origin) return true;

  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

/**
 * Returns null when the request may proceed, or the response to return.
 *
 * Callers guard mutations only — reads stay open so the cockpit renders.
 */
export function guardMutation(request: Request): GuardFailure | null {
  if (!sameOrigin(request)) {
    return {
      response: NextResponse.json(
        { error: "Cross-origin writes are refused." },
        { status: 403 },
      ),
    };
  }

  const secret = process.env.THOR_API_SECRET;
  if (!secret) return null;

  const presented =
    request.headers.get("x-thor-secret") ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

  if (presented !== secret) {
    return {
      response: NextResponse.json(
        { error: "Missing or invalid THOR_API_SECRET." },
        { status: 401 },
      ),
    };
  }

  return null;
}
