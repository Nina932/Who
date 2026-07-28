/**
 * Connectors.
 *
 * The largest gap between this and the real Apex was that the integrations —
 * Drive, Calendar, Email — were drawn and inert. This is the actual wiring:
 * a real Google OAuth authorisation-code flow with refresh, tokens persisted
 * through the same store as everything else, and real API calls on top.
 *
 * It needs credentials to do anything, and it says so rather than pretending.
 * Nothing here fabricates data when disconnected: every call returns a typed
 * failure with the reason, exactly like the model layer does.
 *
 * Scopes are requested narrowly on purpose — `drive.readonly` and
 * `gmail.compose` rather than full mailbox access — because an agent that can
 * send mail unattended is a different risk than one that can only draft.
 */

import { id, mutate, readCollection } from "./store";

export type ConnectorId = "google-drive" | "google-calendar" | "gmail";

export interface ConnectorSpec {
  id: ConnectorId;
  name: string;
  /** The agent that reaches through this surface. */
  ownerAgentId: string;
  scopes: string[];
  description: string;
}

export const CONNECTORS: ConnectorSpec[] = [
  {
    id: "google-drive",
    name: "Drive",
    ownerAgentId: "researcher",
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    description: "Read documents and assets. Read-only by design.",
  },
  {
    id: "google-calendar",
    name: "Calendar",
    ownerAgentId: "chief-of-staff",
    scopes: ["https://www.googleapis.com/auth/calendar.events"],
    description: "Read availability and put approved work on the calendar.",
  },
  {
    id: "gmail",
    name: "Email",
    ownerAgentId: "chief-of-staff",
    // compose, not send: drafts wait for a human.
    scopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
    ],
    description: "Read the inbox and prepare drafts. Never sends unattended.",
  },
];

export const CONNECTORS_BY_ID: Record<string, ConnectorSpec> = Object.fromEntries(
  CONNECTORS.map((c) => [c.id, c]),
);

interface StoredToken {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. */
  expiresAt: number;
  scopes: string[];
  account?: string;
  connectedAt: number;
}

type TokenStore = Record<string, StoredToken>;

const TOKENS = "connections";
const OAUTH_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const OAUTH_TOKEN = "https://oauth2.googleapis.com/token";

export function oauthConfigured(): boolean {
  return Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET);
}

function redirectUri(): string {
  return (
    process.env.GOOGLE_OAUTH_REDIRECT_URI ??
    `${process.env.THOR_BASE_URL ?? "http://localhost:3000"}/api/connectors/callback`
  );
}

// ── Authorisation ────────────────────────────────────────────────────────

/**
 * Build the consent URL.
 *
 * `access_type=offline` + `prompt=consent` because without a refresh token the
 * connection silently dies in an hour, which is worse than not connecting.
 */
export function authorizeUrl(connectorId: ConnectorId, state: string): string | null {
  const spec = CONNECTORS_BY_ID[connectorId];
  if (!spec || !oauthConfigured()) return null;

  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID as string,
    redirect_uri: redirectUri(),
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    scope: spec.scopes.join(" "),
    state,
  });

  return `${OAUTH_AUTH}?${params.toString()}`;
}

/** Opaque state so the callback can prove which connector it belongs to. */
export function makeState(connectorId: ConnectorId): string {
  return `${connectorId}:${id("st")}`;
}

export function readState(state: string): ConnectorId | null {
  const [connectorId] = state.split(":");
  return CONNECTORS_BY_ID[connectorId] ? (connectorId as ConnectorId) : null;
}

export async function exchangeCode(
  connectorId: ConnectorId,
  code: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!oauthConfigured()) return { ok: false, error: "GOOGLE_OAUTH_CLIENT_ID/SECRET not set" };

  try {
    const response = await fetch(OAUTH_TOKEN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_OAUTH_CLIENT_ID as string,
        client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET as string,
        redirect_uri: redirectUri(),
        grant_type: "authorization_code",
      }),
    });

    if (!response.ok) {
      return { ok: false, error: `token exchange ${response.status}: ${(await response.text()).slice(0, 200)}` };
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope?: string;
    };

    await mutate<TokenStore, null>(TOKENS, {}, (current) => ({
      next: {
        ...current,
        [connectorId]: {
          accessToken: data.access_token,
          refreshToken: data.refresh_token ?? current[connectorId]?.refreshToken,
          expiresAt: Date.now() + data.expires_in * 1000,
          scopes: data.scope?.split(" ") ?? CONNECTORS_BY_ID[connectorId].scopes,
          connectedAt: Date.now(),
        },
      },
      result: null,
    }));

    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "exchange failed" };
  }
}

async function refresh(connectorId: ConnectorId, token: StoredToken): Promise<StoredToken | null> {
  if (!token.refreshToken || !oauthConfigured()) return null;

  const response = await fetch(OAUTH_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: token.refreshToken,
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID as string,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET as string,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    console.error(`connectors: refresh failed for ${connectorId}`, response.status);
    return null;
  }

  const data = (await response.json()) as { access_token: string; expires_in: number };
  const updated: StoredToken = {
    ...token,
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  await mutate<TokenStore, null>(TOKENS, {}, (current) => ({
    next: { ...current, [connectorId]: updated },
    result: null,
  }));

  return updated;
}

/** A valid access token, refreshing if it is close to expiry. */
async function accessToken(connectorId: ConnectorId): Promise<string | null> {
  const tokens = await readCollection<TokenStore>(TOKENS, {});
  const token = tokens[connectorId];
  if (!token) return null;

  // 60s of headroom, so a token cannot expire mid-request.
  if (token.expiresAt > Date.now() + 60_000) return token.accessToken;
  return (await refresh(connectorId, token))?.accessToken ?? null;
}

export async function disconnect(connectorId: ConnectorId): Promise<void> {
  await mutate<TokenStore, null>(TOKENS, {}, (current) => {
    const next = { ...current };
    delete next[connectorId];
    return { next, result: null };
  });
}

export interface ConnectorStatus {
  id: ConnectorId;
  name: string;
  description: string;
  ownerAgentId: string;
  connected: boolean;
  /** True when OAuth credentials exist, so connecting is even possible. */
  available: boolean;
  connectedAt?: number;
  scopes: string[];
}

export async function statuses(): Promise<ConnectorStatus[]> {
  const tokens = await readCollection<TokenStore>(TOKENS, {});
  const available = oauthConfigured();

  return CONNECTORS.map((spec) => ({
    id: spec.id,
    name: spec.name,
    description: spec.description,
    ownerAgentId: spec.ownerAgentId,
    connected: Boolean(tokens[spec.id]),
    available,
    connectedAt: tokens[spec.id]?.connectedAt,
    scopes: spec.scopes,
  }));
}

// ── Calls ────────────────────────────────────────────────────────────────

export type CallOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; needsConnection?: boolean };

async function googleFetch<T>(
  connectorId: ConnectorId,
  url: string,
  init?: RequestInit,
): Promise<CallOutcome<T>> {
  const token = await accessToken(connectorId);
  if (!token) {
    return {
      ok: false,
      needsConnection: true,
      error: oauthConfigured()
        ? `${CONNECTORS_BY_ID[connectorId].name} is not connected.`
        : "Google OAuth is not configured (GOOGLE_OAUTH_CLIENT_ID/SECRET).",
    };
  }

  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    });

    if (!response.ok) {
      return { ok: false, error: `${response.status}: ${(await response.text()).slice(0, 200)}` };
    }
    return { ok: true, data: (await response.json()) as T };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "request failed" };
  }
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
}

export async function listDriveFiles(query?: string): Promise<CallOutcome<DriveFile[]>> {
  const params = new URLSearchParams({
    pageSize: "20",
    fields: "files(id,name,mimeType,modifiedTime)",
    orderBy: "modifiedTime desc",
  });
  if (query) params.set("q", `name contains '${query.replace(/'/g, "")}'`);

  const result = await googleFetch<{ files: DriveFile[] }>(
    "google-drive",
    `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
  );
  return result.ok ? { ok: true, data: result.data.files ?? [] } : result;
}

export interface CalendarEvent {
  id?: string;
  summary?: string;
  htmlLink?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
}

export async function listCalendarEvents(days = 7): Promise<CallOutcome<CalendarEvent[]>> {
  const params = new URLSearchParams({
    timeMin: new Date().toISOString(),
    timeMax: new Date(Date.now() + days * 86_400_000).toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "25",
  });

  const result = await googleFetch<{ items: CalendarEvent[] }>(
    "google-calendar",
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`,
  );
  return result.ok ? { ok: true, data: result.data.items ?? [] } : result;
}

/**
 * Put an approved piece of work on the calendar.
 *
 * This is the "automatic Google Calendar events for your posts" behaviour —
 * and it only ever runs downstream of a loop's gate, never before it.
 */
export async function createCalendarEvent(input: {
  summary: string;
  description?: string;
  startsAt: Date;
  minutes?: number;
}): Promise<CallOutcome<CalendarEvent>> {
  const end = new Date(input.startsAt.getTime() + (input.minutes ?? 30) * 60_000);

  return googleFetch<CalendarEvent>(
    "google-calendar",
    "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    {
      method: "POST",
      body: JSON.stringify({
        summary: input.summary,
        description: input.description,
        start: { dateTime: input.startsAt.toISOString() },
        end: { dateTime: end.toISOString() },
      }),
    },
  );
}

export interface MailHeader {
  id: string;
  snippet?: string;
  subject?: string;
  from?: string;
}

export async function listRecentMail(max = 10): Promise<CallOutcome<MailHeader[]>> {
  const list = await googleFetch<{ messages?: Array<{ id: string }> }>(
    "gmail",
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${max}&q=is:unread`,
  );
  if (!list.ok) return list;

  const ids = (list.data.messages ?? []).map((m) => m.id);
  const headers: MailHeader[] = [];

  for (const messageId of ids) {
    const detail = await googleFetch<{
      id: string;
      snippet?: string;
      payload?: { headers?: Array<{ name: string; value: string }> };
    }>(
      "gmail",
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
    );
    if (!detail.ok) continue;

    const find = (name: string) =>
      detail.data.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value;
    headers.push({
      id: detail.data.id,
      snippet: detail.data.snippet,
      subject: find("subject"),
      from: find("from"),
    });
  }

  return { ok: true, data: headers };
}

/** Create a draft. Deliberately never `send` — a human presses send. */
export async function createMailDraft(input: {
  to: string;
  subject: string;
  body: string;
}): Promise<CallOutcome<{ id: string }>> {
  const mime = [
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    input.body,
  ].join("\r\n");

  // Gmail wants base64url without padding.
  const raw = Buffer.from(mime, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return googleFetch<{ id: string }>(
    "gmail",
    "https://gmail.googleapis.com/gmail/v1/users/me/drafts",
    { method: "POST", body: JSON.stringify({ message: { raw } }) },
  );
}
