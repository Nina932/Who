export interface OperatorProfile {
  id: "facebook" | "x" | "linkedin" | "linkedin-company" | "github";
  label: string;
  url: string;
  kind: "personal" | "company" | "developer";
}

export interface TelegramBotStatus {
  configured: boolean;
  verified: boolean;
  botId?: number;
  username?: string;
  displayName?: string;
  expectedBotId?: number;
  expectedUsername?: string;
  matchesExpected?: boolean;
  usernameChanged?: boolean;
  workerActive?: boolean;
  paired?: boolean;
  lastWorkerHeartbeat?: number;
  error?: string;
}

export async function telegramWorkerRuntimeStatus(
  now = Date.now(),
): Promise<Pick<
  TelegramBotStatus,
  "workerActive" | "paired" | "lastWorkerHeartbeat"
>> {
  const state = await readCollection<TelegramWorkerState>(
    "telegram-worker",
    EMPTY_TELEGRAM_WORKER_STATE,
  );
  const lastWorkerHeartbeat = state.heartbeatAt || undefined;
  return {
    workerActive: Boolean(
      lastWorkerHeartbeat && now - lastWorkerHeartbeat < 70_000,
    ),
    paired:
      parseAllowedTelegramUserIds(process.env.TELEGRAM_ALLOWED_USER_IDS).size > 0,
    lastWorkerHeartbeat,
  };
}

const PROFILE_ENV = [
  ["facebook", "Facebook", "OPERATOR_FACEBOOK_URL", "personal"],
  ["x", "X", "OPERATOR_X_URL", "personal"],
  ["linkedin", "LinkedIn", "OPERATOR_LINKEDIN_URL", "personal"],
  [
    "linkedin-company",
    "LinkedIn company",
    "OPERATOR_LINKEDIN_COMPANY_URL",
    "company",
  ],
  ["github", "GitHub", "OPERATOR_GITHUB_URL", "developer"],
] as const;

let telegramCache:
  | {
      token: string;
      expectedBotId?: number;
      expectedUsername?: string;
      checkedAt: number;
      status: TelegramBotStatus;
    }
  | undefined;

export function operatorProfiles(): OperatorProfile[] {
  return PROFILE_ENV.flatMap(([id, label, envName, kind]) => {
    const url = process.env[envName]?.trim();
    if (!url || !/^https:\/\//i.test(url)) return [];
    return [{ id, label, url, kind }];
  });
}

/** Read-only proof that the supplied Telegram token belongs to a live bot. */
export async function telegramBotStatus(
  now = Date.now(),
): Promise<TelegramBotStatus> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const expectedUsername = process.env.TELEGRAM_BOT_USERNAME
    ?.trim()
    .replace(/^@/, "");
  const rawExpectedBotId = process.env.TELEGRAM_BOT_ID?.trim();
  const expectedBotId = rawExpectedBotId
    ? Number(rawExpectedBotId)
    : undefined;
  if (!token) return { configured: false, verified: false };
  if (
    telegramCache?.token === token &&
    telegramCache.expectedBotId === expectedBotId &&
    telegramCache.expectedUsername === expectedUsername &&
    now - telegramCache.checkedAt < 5 * 60_000
  ) {
    return telegramCache.status;
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    const body = (await response.json()) as {
      ok?: boolean;
      result?: { id?: number; username?: string; first_name?: string };
      description?: string;
    };
    if (!response.ok || !body.ok || !body.result) {
      const status: TelegramBotStatus = {
        configured: true,
        verified: false,
        error: body.description ?? `Telegram returned ${response.status}`,
      };
      telegramCache = {
        token,
        expectedBotId,
        expectedUsername,
        checkedAt: now,
        status,
      };
      return status;
    }
    const usernameMatches = expectedUsername
      ? body.result.username?.toLowerCase() === expectedUsername.toLowerCase()
      : undefined;
    const idMatches =
      expectedBotId !== undefined
        ? body.result.id === expectedBotId
        : undefined;
    const status: TelegramBotStatus = {
      configured: true,
      verified: true,
      botId: body.result.id,
      username: body.result.username,
      displayName: body.result.first_name,
      expectedBotId,
      expectedUsername,
      // Bot IDs are immutable; usernames can be renamed.
      matchesExpected: idMatches ?? usernameMatches,
      usernameChanged:
        idMatches === true && usernameMatches === false,
    };
    telegramCache = {
      token,
      expectedBotId,
      expectedUsername,
      checkedAt: now,
      status,
    };
    return status;
  } catch (error) {
    const status: TelegramBotStatus = {
      configured: true,
      verified: false,
      error: error instanceof Error ? error.message : "Telegram probe failed",
    };
    telegramCache = {
      token,
      expectedBotId,
      expectedUsername,
      checkedAt: now,
      status,
    };
    return status;
  }
}

export function renderOperatorIntegrations(
  profiles: OperatorProfile[],
  telegram: TelegramBotStatus,
): string {
  const lines = profiles.map(
    (profile) => `- ${profile.label} (${profile.kind}): ${profile.url}`,
  );
  if (telegram.verified) {
    lines.push(
      telegram.matchesExpected === false
        ? `- Telegram credential mismatch: Telegram reports bot ID ${telegram.botId} as @${telegram.username}; the declared bot is ID ${telegram.expectedBotId ?? "unknown"} / @${telegram.expectedUsername}.`
        : telegram.usernameChanged
          ? `- Telegram bot: ID ${telegram.botId} is verified. Telegram currently reports @${telegram.username}; @${telegram.expectedUsername} is a previous or incorrect username for the same immutable bot ID.`
          : `- Telegram bot: @${telegram.username ?? "verified bot"} (ID ${telegram.botId}, token verified by Telegram getMe)`,
    );
  }
  if (!lines.length) return "";
  return [
    "VERIFIED OPERATOR IDENTITIES AND LOCAL INTEGRATIONS:",
    ...lines,
    "A known profile URL is identity context, not proof of API/OAuth access. Never claim a social account is connected unless its connector status says so.",
  ].join("\n");
}
import { readCollection } from "./store";
import {
  EMPTY_TELEGRAM_WORKER_STATE,
  parseAllowedTelegramUserIds,
  type TelegramWorkerState,
} from "./telegram";
