import { NextResponse } from "next/server";
import { guardMutation } from "@/lib/guard";
import {
  CONNECTORS_BY_ID,
  authorizeUrl,
  disconnect,
  listCalendarEvents,
  listDriveFiles,
  listRecentMail,
  makeState,
  oauthConfigured,
  statuses,
  type ConnectorId,
} from "@/lib/connectors";

/**
 * Connector status, authorisation kick-off, disconnect, and a live probe.
 *
 * The probe matters: a connector that claims "connected" without ever having
 * made a call is the same kind of theatre this build has been removing.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    configured: oauthConfigured(),
    connectors: await statuses(),
  });
}

export async function POST(request: Request) {
  const blocked = guardMutation(request);
  if (blocked) return blocked.response;

  const body = (await request.json().catch(() => ({}))) as {
    action?: unknown;
    connectorId?: unknown;
  };

  const connectorId =
    typeof body.connectorId === "string" && CONNECTORS_BY_ID[body.connectorId]
      ? (body.connectorId as ConnectorId)
      : null;

  if (!connectorId) {
    return NextResponse.json({ error: "A known connectorId is required." }, { status: 400 });
  }

  switch (body.action) {
    case "connect": {
      const url = authorizeUrl(connectorId, makeState(connectorId));
      if (!url) {
        return NextResponse.json(
          {
            error:
              "Google OAuth is not configured. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.",
          },
          { status: 400 },
        );
      }
      return NextResponse.json({ url });
    }

    case "disconnect": {
      await disconnect(connectorId);
      return NextResponse.json({ connectors: await statuses() });
    }

    case "probe": {
      // One real call against the live API, so "connected" means something.
      const result =
        connectorId === "google-drive"
          ? await listDriveFiles()
          : connectorId === "google-calendar"
            ? await listCalendarEvents(7)
            : await listRecentMail(5);

      return NextResponse.json(
        result.ok
          ? { ok: true, count: Array.isArray(result.data) ? result.data.length : 1, sample: result.data }
          : { ok: false, error: result.error, needsConnection: result.needsConnection },
      );
    }

    default:
      return NextResponse.json({ error: `Unknown action: ${String(body.action)}` }, { status: 400 });
  }
}
