/**
 * The model stack.
 *
 * Straight from how Reznikov describes Apex: "not one giant brain, but a
 * precisely orchestrated stack of specialized AI models."
 *
 *   quick      Gemini Flash    — conversational turns, cheap and fast
 *   hard       Gemini Pro      — reasoning that Flash will fumble
 *   judgment   Claude Opus     — consequential calls, escalated to deliberately
 *   vision     Claude Sonnet   — images and PDFs
 *   extract    Claude Haiku    — pulling durable facts out of a conversation
 *
 * Two real provider adapters sit underneath. Routing is a policy object rather
 * than scattered `if` statements, so the stack can be re-pointed in one place —
 * and so the cockpit can *show* which model answered, which is the whole
 * argument for orchestrating rather than calling one big model.
 */

export type ModelRole = "quick" | "hard" | "judgment" | "vision" | "extract";

export type Provider = "google" | "anthropic";

export interface ModelSpec {
  provider: Provider;
  model: string;
  /** Shown in the cockpit so the operator can see the stack working. */
  label: string;
  maxTokens: number;
}

export const STACK: Record<ModelRole, ModelSpec> = {
  quick: {
    provider: "google",
    model: process.env.THOR_MODEL_QUICK ?? "gemini-2.5-flash",
    label: "Gemini Flash",
    maxTokens: 700,
  },
  hard: {
    provider: "google",
    model: process.env.THOR_MODEL_HARD ?? "gemini-2.5-pro",
    label: "Gemini Pro",
    maxTokens: 1600,
  },
  judgment: {
    provider: "anthropic",
    model: process.env.THOR_MODEL_JUDGMENT ?? "claude-opus-4-5",
    label: "Claude Opus",
    maxTokens: 1600,
  },
  vision: {
    provider: "anthropic",
    model: process.env.THOR_MODEL_VISION ?? "claude-sonnet-4-5",
    label: "Claude Sonnet",
    maxTokens: 1600,
  },
  extract: {
    provider: "anthropic",
    model: process.env.THOR_MODEL_EXTRACT ?? "claude-haiku-4-5-20251001",
    label: "Claude Haiku",
    maxTokens: 600,
  },
};

// ── Escalation policy ────────────────────────────────────────────────────

/** Words that mark a decision as consequential enough to escalate to Opus. */
const CONSEQUENTIAL = [
  "should i", "should we", "decide", "decision", "worth it", "risk", "legal",
  "contract", "fire", "hire", "quit", "raise", "pricing", "price", "invest",
  "shut down", "pivot", "commit to", "sign", "liability", "refund", "equity",
  "acquire", "lawsuit", "terminate", "budget", "runway",
];

/** Signals that a turn needs real reasoning rather than a fast reply. */
const HARD = [
  "why", "compare", "trade-off", "tradeoff", "analyse", "analyze", "strategy",
  "plan", "architecture", "design a", "explain how", "figure out", "work out",
  "options", "approach", "root cause",
];

export interface RouteDecision {
  role: ModelRole;
  spec: ModelSpec;
  reason: string;
}

/**
 * Pick a model for a conversational turn.
 *
 * Escalation is one-way and explicit: consequential judgment always goes to
 * Opus regardless of how simple the sentence looks, because the cost of being
 * fast and wrong on those is asymmetric.
 */
export function routeTurn(utterance: string, hasAttachment = false): RouteDecision {
  const text = ` ${utterance.toLowerCase()} `;

  if (hasAttachment) {
    return { role: "vision", spec: STACK.vision, reason: "Attachment to read" };
  }

  const consequential = CONSEQUENTIAL.find((term) => text.includes(term));
  if (consequential) {
    return {
      role: "judgment",
      spec: STACK.judgment,
      reason: `Consequential judgment ("${consequential}")`,
    };
  }

  const hard = HARD.find((term) => text.includes(term));
  if (hard || utterance.length > 240) {
    return {
      role: "hard",
      spec: STACK.hard,
      reason: hard ? `Needs reasoning ("${hard}")` : "Long, multi-part request",
    };
  }

  return { role: "quick", spec: STACK.quick, reason: "Conversational turn" };
}

// ── Provider adapters ────────────────────────────────────────────────────

export interface Message {
  role: "user" | "assistant";
  content: string;
}

export interface CallOptions {
  system: string;
  messages: Message[];
  /** Overrides the role's default. */
  maxTokens?: number;
  /** Ask the model for raw JSON and parse it. */
  json?: boolean;
}

export interface CallResult {
  text: string;
  spec: ModelSpec;
  /** False when no key was configured and nothing was actually called. */
  live: boolean;
  error?: string;
}

const ANTHROPIC_BASE = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
const GOOGLE_BASE =
  process.env.GOOGLE_API_BASE_URL ?? "https://generativelanguage.googleapis.com";

export function keyFor(provider: Provider): string | undefined {
  return provider === "anthropic"
    ? process.env.ANTHROPIC_API_KEY
    : (process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY);
}

async function callAnthropic(spec: ModelSpec, options: CallOptions): Promise<string> {
  const response = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": keyFor("anthropic") as string,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: spec.model,
      max_tokens: options.maxTokens ?? spec.maxTokens,
      system: options.system,
      messages: options.messages,
    }),
  });

  if (!response.ok) {
    throw new Error(`anthropic ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }

  const data = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
  return (
    data.content
      ?.filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("")
      .trim() ?? ""
  );
}

async function callGoogle(spec: ModelSpec, options: CallOptions): Promise<string> {
  const url = `${GOOGLE_BASE}/v1beta/models/${spec.model}:generateContent`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": keyFor("google") as string,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: options.system }] },
      contents: options.messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
      generationConfig: {
        maxOutputTokens: options.maxTokens ?? spec.maxTokens,
        ...(options.json ? { responseMimeType: "application/json" } : {}),
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`google ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }

  const data = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  return (
    data.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? "")
      .join("")
      .trim() ?? ""
  );
}

/**
 * Call a role.
 *
 * Never throws: a missing key or a provider outage returns `live: false` with
 * the reason attached, because the cockpit has to keep running and the
 * operator has to be told which part of the stack is down.
 */
export async function callRole(
  role: ModelRole,
  options: CallOptions,
): Promise<CallResult> {
  const spec = STACK[role];

  if (!keyFor(spec.provider)) {
    return {
      text: "",
      spec,
      live: false,
      error: `No ${spec.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "GOOGLE_API_KEY"} configured`,
    };
  }

  try {
    const text =
      spec.provider === "anthropic"
        ? await callAnthropic(spec, options)
        : await callGoogle(spec, options);
    return { text, spec, live: true };
  } catch (error) {
    console.error(`models: ${role} failed`, error);
    return {
      text: "",
      spec,
      live: false,
      error: error instanceof Error ? error.message : "unknown provider error",
    };
  }
}

/** Which parts of the stack are actually reachable right now. */
export function stackStatus(): Array<{ role: ModelRole; spec: ModelSpec; ready: boolean }> {
  return (Object.keys(STACK) as ModelRole[]).map((role) => ({
    role,
    spec: STACK[role],
    ready: Boolean(keyFor(STACK[role].provider)),
  }));
}

/** Models sometimes fence JSON despite being asked not to. */
export function parseJson<T>(text: string): T | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Fall back to the outermost array or object in the response.
    const match = cleaned.match(/[[{][\s\S]*[\]}]/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]) as T;
    } catch {
      return null;
    }
  }
}
