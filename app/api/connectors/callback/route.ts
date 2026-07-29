import { NextResponse } from "next/server";
import { exchangeCode, readState } from "@/lib/connectors";

/**
 * The OAuth redirect target.
 *
 * Google sends the operator back here with a code. The state carries which
 * connector was being aumorpheusised — a callback whose state does not name a
 * known connector is rejected rather than guessed at.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function back(request: Request, params: Record<string, string>) {
  const url = new URL("/connect", new URL(request.url).origin);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return NextResponse.redirect(url);
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;

  const denied = params.get("error");
  if (denied) return back(request, { result: "error", reason: denied });

  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) return back(request, { result: "error", reason: "missing code or state" });

  const connectorId = readState(state);
  if (!connectorId) return back(request, { result: "error", reason: "unrecognised state" });

  const exchange = await exchangeCode(connectorId, code);
  return exchange.ok
    ? back(request, { result: "connected", connector: connectorId })
    : back(request, { result: "error", reason: exchange.error });
}
