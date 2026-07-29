import { promises as fs } from "node:fs";
import path from "node:path";
import {
  EMPTY_TELEGRAM_WORKER_STATE,
  appendTelegramHistory,
  parseAllowedTelegramUserIds,
  parseSseReply,
  telegramTextChunks,
  telegramUserAllowed,
  type TelegramUpdate,
  type TelegramWorkerState,
} from "../lib/telegram";

async function loadLocalEnvironment(): Promise<void> {
  try {
    const raw = await fs.readFile(path.join(process.cwd(), ".env.local"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!match) continue;
      let value = match[2];
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      // Local file truth wins over stale variables inherited from Desktop.
      process.env[match[1]] = value;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function main(): Promise<void> {
await loadLocalEnvironment();

const { readCollection, writeCollection } = await import("../lib/store");

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN is missing from .env.local.");
}

const apiBase = `https://api.telegram.org/bot${token}`;
const morpheusBase =
  process.env.MORPHEUS_BASE_URL?.trim() || "http://127.0.0.1:4173";
const allowedUsers = parseAllowedTelegramUserIds(
  process.env.TELEGRAM_ALLOWED_USER_IDS,
);
const startedAt = Date.now();
let stopping = false;

process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});

async function telegramCall<T>(
  method: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${apiBase}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(40_000),
  });
  const payload = (await response.json()) as {
    ok?: boolean;
    result?: T;
    description?: string;
  };
  if (!response.ok || !payload.ok) {
    throw new Error(payload.description ?? `Telegram returned ${response.status}`);
  }
  return payload.result as T;
}

async function sendText(chatId: number, text: string): Promise<void> {
  for (const chunk of telegramTextChunks(text)) {
    await telegramCall("sendMessage", {
      chat_id: chatId,
      text: chunk,
      link_preview_options: { is_disabled: true },
    });
  }
}

async function requestReply(
  utterance: string,
  history: TelegramWorkerState["chats"][string]["history"],
): Promise<string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const secret = process.env.MORPHEUS_API_SECRET?.trim();
  if (secret) headers["x-morpheus-secret"] = secret;

  const response = await fetch(`${morpheusBase}/api/morpheus`, {
    method: "POST",
    headers,
    body: JSON.stringify({ utterance, history, channel: "telegram" }),
    signal: AbortSignal.timeout(90_000),
  });
  const payload = await response.text();
  if (!response.ok) {
    throw new Error(`Morpheus returned ${response.status}: ${payload.slice(0, 180)}`);
  }
  const reply = parseSseReply(payload);
  if (!reply) throw new Error("Morpheus returned no reply text.");
  return reply;
}

async function handleUpdate(
  update: TelegramUpdate,
  state: TelegramWorkerState,
): Promise<TelegramWorkerState> {
  const message = update.message;
  if (!message?.from || message.from.is_bot || !message.text?.trim()) return state;

  const chatId = message.chat.id;
  const userId = message.from.id;
  const utterance = message.text.trim();

  if (message.chat.type !== "private") {
    await sendText(
      chatId,
      "Morpheus only accepts private chats. That keeps your business context out of group conversations.",
    );
    return state;
  }

  if (!telegramUserAllowed(userId, allowedUsers)) {
    await sendText(
      chatId,
      `This Morpheus bot is private and not paired yet. Your Telegram user ID is ${userId}. Add it to TELEGRAM_ALLOWED_USER_IDS in .env.local, then restart the Telegram worker.`,
    );
    return state;
  }

  if (/^\/start(?:@\w+)?$/i.test(utterance)) {
    await sendText(
      chatId,
      "Morpheus is online. Send a question here and I’ll answer through the same brain as the cockpit. Telegram remains read-and-draft only; approvals and external actions stay in the local cockpit.",
    );
    return state;
  }

  await telegramCall("sendChatAction", {
    chat_id: chatId,
    action: "typing",
  }).catch(() => undefined);

  const key = String(chatId);
  const history = state.chats[key]?.history ?? [];
  try {
    const reply = await requestReply(utterance, history);
    await sendText(chatId, reply);
    return {
      ...state,
      chats: {
        ...state.chats,
        [key]: {
          history: appendTelegramHistory(history, utterance, reply),
        },
      },
    };
  } catch (error) {
    console.error(
      "telegram: Morpheus reply failed",
      error instanceof Error ? error.message : error,
    );
    await sendText(
      chatId,
      "I received that, but the local Morpheus service did not return a usable answer. Check that the cockpit is running on port 4173, then try again.",
    );
    return state;
  }
}

console.log(
  `telegram: worker started; ${allowedUsers.size ? `${allowedUsers.size} allowed user(s)` : "awaiting private user pairing"}`,
);

while (!stopping) {
  let state = await readCollection<TelegramWorkerState>(
    "telegram-worker",
    EMPTY_TELEGRAM_WORKER_STATE,
  );
  state = {
    ...state,
    startedAt: state.startedAt || startedAt,
    heartbeatAt: Date.now(),
  };
  await writeCollection("telegram-worker", state);

  try {
    const updates = await telegramCall<TelegramUpdate[]>("getUpdates", {
      offset: state.offset,
      timeout: 25,
      allowed_updates: ["message"],
    });

    for (const update of updates) {
      state = await handleUpdate(update, state);
      state = {
        ...state,
        offset: Math.max(state.offset, update.update_id + 1),
        heartbeatAt: Date.now(),
      };
      await writeCollection("telegram-worker", state);
    }
  } catch (error) {
    console.error(
      "telegram: polling failed",
      error instanceof Error ? error.message : error,
    );
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

console.log("telegram: worker stopped");
}

void main().catch((error) => {
  console.error(
    "telegram: worker terminated",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});
