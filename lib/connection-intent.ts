import type { ConnectorId, ConnectorStatus } from "./connectors";
import type { Turn } from "./orchestrator";

const CONNECTOR_TERMS: Array<{ id: ConnectorId; pattern: RegExp }> = [
  {
    id: "gmail-company",
    pattern:
      /\b(?:company|business|work)\b[\s\S]*\b(?:gmail|inbox|email)\b|\b(?:gmail|inbox|email)\b[\s\S]*\b(?:company|business|work)\b/i,
  },
  { id: "gmail", pattern: /\b(gmail|inbox|email)\b/i },
  { id: "facebook-profile", pattern: /\bfacebook\b/i },
  { id: "google-calendar", pattern: /\b(calendar|google calendar)\b/i },
  { id: "google-drive", pattern: /\b(google drive|drive)\b/i },
];

export function requestedConnection(
  utterance: string,
  history: Turn[] = [],
): ConnectorId | null {
  const recent = [
    ...history
      .filter((turn) => turn.role === "operator")
      .slice(-4)
      .map((turn) => turn.text),
    utterance,
  ].join(" ");
  if (
    !/\b(connect|connected|connection|link|linked|oauth|permission|consent|auth|prompt)\b/i.test(
      recent,
    )
  ) {
    return null;
  }
  return CONNECTOR_TERMS.find((connector) => connector.pattern.test(recent))?.id ?? null;
}

export function connectionReply(status: ConnectorStatus): string {
  if (status.connected) {
    return `${status.name} is linked. I can verify the token with a live Probe on the Connections page; I will not claim the account works until that probe succeeds.`;
  }
  if (!status.available) {
    const variables =
      status.provider === "google"
        ? "GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET"
        : status.provider === "facebook"
          ? "FACEBOOK_APP_ID and FACEBOOK_APP_SECRET"
          : `${status.provider.toUpperCase()} OAuth credentials`;
    return `${status.name} is not linked, and no consent flow was started. ${variables} are missing from .env.local. I opened Connections so you can see the exact setup; there is no popup blocker to fix.`;
  }
  return `${status.name} is not linked yet. I am opening the provider's real consent page now. Access begins only after you approve it there.`;
}
