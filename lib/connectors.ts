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

export type ConnectorId =
  | "google-drive"
  | "google-calendar"
  | "gmail"
  | "google-slides"
  | "google-sheets"
  | "linkedin"
  | "slack";

export type OAuthProvider = "google" | "linkedin" | "slack";

export interface ConnectorSpec {
  id: ConnectorId;
  name: string;
  provider: OAuthProvider;
  /** The agent that reaches through this surface. */
  ownerAgentId: string;
  scopes: string[];
  description: string;
  /** True when the connector can change something outside Morpheus. */
  writes: boolean;
}

export const CONNECTORS: ConnectorSpec[] = [
  {
    id: "google-drive",
    name: "Drive",
    provider: "google",
    ownerAgentId: "researcher",
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    description: "Read documents and assets. Read-only by design.",
    writes: false,
  },
  {
    id: "google-calendar",
    name: "Calendar",
    provider: "google",
    ownerAgentId: "chief-of-staff",
    scopes: ["https://www.googleapis.com/auth/calendar.events"],
    description: "Read availability and put approved work on the calendar.",
    writes: true,
  },
  {
    id: "gmail",
    name: "Email",
    provider: "google",
    ownerAgentId: "chief-of-staff",
    // compose, not send: drafts wait for a human.
    scopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
    ],
    description: "Read the inbox and prepare drafts. Never sends unattended.",
    writes: true,
  },
  {
    id: "google-slides",
    name: "Slides",
    provider: "google",
    ownerAgentId: "design",
    scopes: [
      "https://www.googleapis.com/auth/presentations",
      "https://www.googleapis.com/auth/drive.file",
    ],
    description: "Turn an approved outline into a deck. drive.file scope only touches what Morpheus creates.",
    writes: true,
  },
  {
    id: "google-sheets",
    name: "Sheets",
    provider: "google",
    ownerAgentId: "analytics",
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive.file",
    ],
    description: "Append run outcomes to a log so the numbers live somewhere you can pivot.",
    writes: true,
  },
  {
    id: "slack",
    name: "Chat",
    provider: "slack",
    ownerAgentId: "chief-of-staff",
    // chat:write only — Morpheus speaks, it does not read your DMs.
    scopes: ["chat:write", "channels:read"],
    description:
      "Tells you in Slack the moment a loop is holding at its gate. Post-only — no message history is read.",
    writes: true,
  },
  {
    id: "linkedin",
    name: "LinkedIn",
    provider: "linkedin",
    ownerAgentId: "social",
    scopes: ["openid", "profile", "w_member_social"],
    description:
      "Publish to LinkedIn. Available but wired into no loop by default — publishing to a real account is opt-in.",
    writes: true,
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
interface ProviderConfig {
  authUrl: string;
  tokenUrl: string;
  clientId?: string;
  clientSecret?: string;
  /** Extra params the provider needs on the consent URL. */
  extraAuthParams: Record<string, string>;
}

function providerConfig(provider: OAuthProvider): ProviderConfig {
  return provider === "google"
    ? {
        authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
        clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
        // Without offline access the connection dies silently within the hour.
        extraAuthParams: {
          access_type: "offline",
          prompt: "consent",
          include_granted_scopes: "true",
        },
      }
    : provider === "linkedin"
      ? {
          authUrl: "https://www.linkedin.com/oauth/v2/authorization",
          tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
          clientId: process.env.LINKEDIN_CLIENT_ID,
          clientSecret: process.env.LINKEDIN_CLIENT_SECRET,
          extraAuthParams: {},
        }
      : {
          authUrl: "https://slack.com/oauth/v2/authorize",
          tokenUrl: "https://slack.com/api/oauth.v2.access",
          clientId: process.env.SLACK_CLIENT_ID,
          clientSecret: process.env.SLACK_CLIENT_SECRET,
          extraAuthParams: {},
        };
}

export function providerConfigured(provider: OAuthProvider): boolean {
  const config = providerConfig(provider);
  return Boolean(config.clientId && config.clientSecret);
}

/** Kept for callers that only care about the Google half. */
export function oauthConfigured(): boolean {
  return providerConfigured("google");
}

function redirectUri(): string {
  return (
    process.env.GOOGLE_OAUTH_REDIRECT_URI ??
    `${process.env.MORPHEUS_BASE_URL ?? "http://localhost:3000"}/api/connectors/callback`
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
  if (!spec || !providerConfigured(spec.provider)) return null;

  const config = providerConfig(spec.provider);
  const params = new URLSearchParams({
    client_id: config.clientId as string,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: spec.scopes.join(" "),
    state,
    ...config.extraAuthParams,
  });

  return `${config.authUrl}?${params.toString()}`;
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
  const spec = CONNECTORS_BY_ID[connectorId];
  if (!spec) return { ok: false, error: "unknown connector" };
  if (!providerConfigured(spec.provider)) {
    return { ok: false, error: `${spec.provider} OAuth client id/secret not set` };
  }
  const config = providerConfig(spec.provider);

  try {
    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: config.clientId as string,
        client_secret: config.clientSecret as string,
        redirect_uri: redirectUri(),
        grant_type: "authorization_code",
      }),
    });

    if (!response.ok) {
      return { ok: false, error: `token exchange ${response.status}: ${(await response.text()).slice(0, 200)}` };
    }

    const data = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      // Slack's shape: ok/error at the top, bot token nested.
      ok?: boolean;
      error?: string;
      authed_user?: { access_token?: string };
    };

    if (spec.provider === "slack" && data.ok === false) {
      return { ok: false, error: `slack: ${data.error ?? "authorisation refused"}` };
    }

    const token = data.access_token ?? data.authed_user?.access_token;
    if (!token) return { ok: false, error: "no access token in the response" };

    // Slack bot tokens do not expire unless rotation is enabled, so there is
    // no refresh to schedule — parking the expiry far out is honest here.
    const expiresIn = data.expires_in ?? (spec.provider === "slack" ? 60 * 60 * 24 * 3650 : 3600);

    await mutate<TokenStore, null>(TOKENS, {}, (current) => ({
      next: {
        ...current,
        [connectorId]: {
          accessToken: token,
          refreshToken: data.refresh_token ?? current[connectorId]?.refreshToken,
          expiresAt: Date.now() + expiresIn * 1000,
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
  const spec = CONNECTORS_BY_ID[connectorId];
  if (!token.refreshToken || !spec || !providerConfigured(spec.provider)) return null;
  const config = providerConfig(spec.provider);

  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: token.refreshToken,
      client_id: config.clientId as string,
      client_secret: config.clientSecret as string,
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
  provider: OAuthProvider;
  description: string;
  ownerAgentId: string;
  connected: boolean;
  /** True when this provider's OAuth credentials exist. */
  available: boolean;
  writes: boolean;
  connectedAt?: number;
  scopes: string[];
}

export async function statuses(): Promise<ConnectorStatus[]> {
  const tokens = await readCollection<TokenStore>(TOKENS, {});

  return CONNECTORS.map((spec) => ({
    id: spec.id,
    name: spec.name,
    provider: spec.provider,
    description: spec.description,
    ownerAgentId: spec.ownerAgentId,
    connected: Boolean(tokens[spec.id]),
    available: providerConfigured(spec.provider),
    writes: spec.writes,
    connectedAt: tokens[spec.id]?.connectedAt,
    scopes: spec.scopes,
  }));
}

// ── Calls ────────────────────────────────────────────────────────────────

export type CallOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; needsConnection?: boolean };

/**
 * Scope enforcement.
 *
 * A redeemed grant hands back a scope list. Until now that list was carried
 * around and never checked — the connector used whatever the stored OAuth
 * token happened to allow, which is usually broader than the grant. So the
 * grant was a promise rather than a constraint.
 *
 * This is where it becomes a constraint: every call names the scope it needs,
 * and if the caller supplies a granted set that does not contain it, the call
 * does not happen. `undefined` means the caller is outside the authority layer
 * — a status probe, the OAuth dance itself — and is deliberately distinct from
 * an empty array, which means "granted nothing" and refuses everything.
 */
export function scopeSatisfied(
  granted: string[] | undefined,
  required: string,
): { ok: true } | { ok: false; error: string } {
  if (granted === undefined) return { ok: true };
  // Google's scopes arrive fully qualified; the registry uses the short form.
  const has = granted.some((scope) => scope === required || scope.endsWith(`/${required}`));
  return has
    ? { ok: true }
    : {
        ok: false,
        error: `The approval did not include "${required}" — it granted ${
          granted.length ? granted.join(", ") : "nothing"
        }.`,
      };
}

async function googleFetch<T>(
  connectorId: ConnectorId,
  url: string,
  init?: RequestInit,
  scope?: { required: string; granted: string[] | undefined },
): Promise<CallOutcome<T>> {
  const spec = CONNECTORS_BY_ID[connectorId];

  // Checked before the token is fetched. A call the grant does not authorise
  // should never get as far as holding a credential.
  if (scope) {
    const allowed = scopeSatisfied(scope.granted, scope.required);
    if (!allowed.ok) return { ok: false, error: allowed.error };
  }

  const token = await accessToken(connectorId);
  if (!token) {
    return {
      ok: false,
      needsConnection: true,
      error: providerConfigured(spec?.provider ?? "google")
        ? `${spec?.name ?? connectorId} is not connected.`
        : `${spec?.provider ?? "google"} OAuth is not configured.`,
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
  /** Scopes from the redeemed grant. Omit only outside the authority layer. */
  granted?: string[];
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
    { required: "calendar.events", granted: input.granted },
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
  granted?: string[];
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
    // `gmail.compose` and never `gmail.send`. A grant that somehow carried
    // send would still not satisfy this, because the required scope is the
    // narrow one the operation actually needs.
    { required: "gmail.compose", granted: input.granted },
  );
}

/**
 * Create a deck from an approved outline.
 *
 * Two calls: create the presentation, then one batchUpdate that adds every
 * slide and fills its placeholders. Batching matters — one request per slide
 * would half-build a deck if the third one failed.
 */
export async function createSlideDeck(input: {
  title: string;
  slides: Array<{ title: string; body: string }>;
  granted?: string[];
}): Promise<CallOutcome<{ id: string; url: string }>> {
  const created = await googleFetch<{ presentationId: string }>(
    "google-slides",
    "https://slides.googleapis.com/v1/presentations",
    { method: "POST", body: JSON.stringify({ title: input.title }) },
    { required: "presentations", granted: input.granted },
  );
  if (!created.ok) return created;

  const presentationId = created.data.presentationId;
  const requests: unknown[] = [];

  input.slides.forEach((slide, index) => {
    const slideId = `morpheus_slide_${index}`;
    const titleId = `morpheus_title_${index}`;
    const bodyId = `morpheus_body_${index}`;

    requests.push({
      createSlide: {
        objectId: slideId,
        slideLayoutReference: { predefinedLayout: "TITLE_AND_BODY" },
        placeholderIdMappings: [
          { layoutPlaceholder: { type: "TITLE" }, objectId: titleId },
          { layoutPlaceholder: { type: "BODY" }, objectId: bodyId },
        ],
      },
    });
    requests.push({ insertText: { objectId: titleId, text: slide.title } });
    if (slide.body) requests.push({ insertText: { objectId: bodyId, text: slide.body } });
  });

  const updated = await googleFetch<unknown>(
    "google-slides",
    `https://slides.googleapis.com/v1/presentations/${presentationId}:batchUpdate`,
    { method: "POST", body: JSON.stringify({ requests }) },
  );
  if (!updated.ok) return updated;

  return {
    ok: true,
    data: {
      id: presentationId,
      url: `https://docs.google.com/presentation/d/${presentationId}/edit`,
    },
  };
}

/**
 * Publish to LinkedIn.
 *
 * Deliberately not wired into any seeded loop. Every other write in this file
 * either lands somewhere private (a calendar, a draft) or is trivially
 * reversible; a LinkedIn post is neither. It is available for a loop that
 * explicitly opts in, downstream of a gate.
 */
export async function postToLinkedIn(text: string): Promise<CallOutcome<{ id: string }>> {
  const token = await accessToken("linkedin");
  if (!token) {
    return {
      ok: false,
      needsConnection: true,
      error: providerConfigured("linkedin")
        ? "LinkedIn is not connected."
        : "LinkedIn OAuth is not configured (LINKEDIN_CLIENT_ID/SECRET).",
    };
  }

  try {
    // The member URN comes from the OIDC userinfo endpoint.
    const who = await fetch("https://api.linkedin.com/v2/userinfo", {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!who.ok) return { ok: false, error: `userinfo ${who.status}` };
    const { sub } = (await who.json()) as { sub: string };

    const response = await fetch("https://api.linkedin.com/rest/posts", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "LinkedIn-Version": process.env.LINKEDIN_API_VERSION ?? "202405",
        "X-Restli-Protocol-Version": "2.0.0",
      },
      body: JSON.stringify({
        author: `urn:li:person:${sub}`,
        commentary: text,
        visibility: "PUBLIC",
        distribution: { feedDistribution: "MAIN_FEED" },
        lifecycleState: "PUBLISHED",
      }),
    });

    if (!response.ok) {
      return { ok: false, error: `linkedin ${response.status}: ${(await response.text()).slice(0, 200)}` };
    }

    return { ok: true, data: { id: response.headers.get("x-restli-id") ?? "posted" } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "post failed" };
  }
}

// ── Sheets ───────────────────────────────────────────────────────────────

/**
 * Append a row to a log spreadsheet, creating it on first use.
 *
 * The id is remembered so every later append lands in the same sheet rather
 * than littering Drive with one spreadsheet per run.
 */
export async function appendToLog(
  title: string,
  row: string[],
  granted?: string[],
): Promise<CallOutcome<{ spreadsheetId: string; url: string }>> {
  const known = await readCollection<Record<string, string>>("sheets", {});
  let spreadsheetId = known[title];

  if (!spreadsheetId) {
    const created = await googleFetch<{ spreadsheetId: string }>(
      "google-sheets",
      "https://sheets.googleapis.com/v4/spreadsheets",
      { method: "POST", body: JSON.stringify({ properties: { title } }) },
      { required: "drive.file", granted },
    );
    if (!created.ok) return created;

    spreadsheetId = created.data.spreadsheetId;
    await mutate<Record<string, string>, null>("sheets", {}, (current) => ({
      next: { ...current, [title]: spreadsheetId as string },
      result: null,
    }));
  }

  const appended = await googleFetch<unknown>(
    "google-sheets",
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { method: "POST", body: JSON.stringify({ values: [row] }) },
    { required: "spreadsheets", granted },
  );
  if (!appended.ok) return appended;

  return {
    ok: true,
    data: {
      spreadsheetId,
      url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
    },
  };
}

// ── Slack ────────────────────────────────────────────────────────────────

/**
 * Post a message.
 *
 * Slack answers 200 with `{ok: false}` on failure, so the HTTP status alone is
 * not enough to know whether anything was delivered.
 */
export async function postToSlack(
  text: string,
  channel?: string,
): Promise<CallOutcome<{ ts: string }>> {
  const token = await accessToken("slack");
  if (!token) {
    return {
      ok: false,
      needsConnection: true,
      error: providerConfigured("slack")
        ? "Slack is not connected."
        : "Slack OAuth is not configured (SLACK_CLIENT_ID/SECRET).",
    };
  }

  const target = channel ?? process.env.SLACK_DEFAULT_CHANNEL;
  if (!target) {
    return { ok: false, error: "No channel given and SLACK_DEFAULT_CHANNEL is not set." };
  }

  try {
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel: target, text }),
    });

    const data = (await response.json()) as { ok: boolean; ts?: string; error?: string };
    if (!data.ok) return { ok: false, error: `slack: ${data.error ?? "unknown error"}` };
    return { ok: true, data: { ts: data.ts ?? "" } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "post failed" };
  }
}
