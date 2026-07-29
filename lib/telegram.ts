export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramChatState {
  history: TelegramTurn[];
}

export interface TelegramTurn {
  role: "operator" | "specialist";
  text: string;
}

export interface TelegramWorkerState {
  offset: number;
  heartbeatAt: number;
  startedAt: number;
  chats: Record<string, TelegramChatState>;
}

export const EMPTY_TELEGRAM_WORKER_STATE: TelegramWorkerState = {
  offset: 0,
  heartbeatAt: 0,
  startedAt: 0,
  chats: {},
};

export function parseAllowedTelegramUserIds(value: string | undefined): Set<number> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((part) => Number(part.trim()))
      .filter((id) => Number.isSafeInteger(id) && id > 0),
  );
}

export function telegramUserAllowed(
  userId: number | undefined,
  allowed: Set<number>,
): boolean {
  return userId !== undefined && allowed.has(userId);
}

export function telegramTextChunks(text: string, limit = 3800): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const chunks: string[] = [];
  let remaining = trimmed;

  while (remaining.length > limit) {
    const candidate = remaining.slice(0, limit);
    const splitAt = Math.max(
      candidate.lastIndexOf("\n\n"),
      candidate.lastIndexOf("\n"),
      candidate.lastIndexOf(". "),
      candidate.lastIndexOf(" "),
    );
    const end = splitAt > limit * 0.55 ? splitAt + 1 : limit;
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

/**
 * Extract only assistant text from Morpheus' SSE response.
 *
 * Meta, news and navigation events remain cockpit concerns. Telegram receives
 * the same answer text without pretending it can open a browser consent flow.
 */
export function parseSseReply(payload: string): string {
  const parts: string[] = [];
  for (const frame of payload.split(/\r?\n\r?\n/)) {
    const event = frame
      .split(/\r?\n/)
      .find((line) => line.startsWith("event:"))
      ?.slice("event:".length)
      .trim();
    if (event !== "delta") continue;
    const data = frame
      .split(/\r?\n/)
      .find((line) => line.startsWith("data:"))
      ?.slice("data:".length)
      .trim();
    if (!data) continue;
    try {
      const parsed = JSON.parse(data) as { text?: unknown };
      if (typeof parsed.text === "string") parts.push(parsed.text);
    } catch {
      // Ignore a malformed frame and preserve any valid deltas around it.
    }
  }
  return parts.join("").trim();
}

export function appendTelegramHistory(
  history: TelegramTurn[],
  utterance: string,
  reply: string,
  limit = 12,
): TelegramTurn[] {
  return [
    ...history,
    { role: "operator" as const, text: utterance },
    { role: "specialist" as const, text: reply },
  ].slice(-limit);
}
