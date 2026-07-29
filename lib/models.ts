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

export type Provider = "google" | "anthropic" | "groq";

export interface ModelSpec {
  provider: Provider;
  model: string;
  /** Shown in the cockpit so the operator can see the stack working. */
  label: string;
  maxTokens: number;
}

/**
 * Candidates per role, in preference order.
 *
 * Groq is first for `quick` because that role is latency-bound — a voice turn
 * that arrives half a second late is a worse answer than a slightly duller one
 * that arrives immediately. Groq is *last* for `hard`, present only so the
 * role still works when it is the only key configured.
 *
 * `judgment` has exactly one candidate, and that is the point. See below.
 */
const CANDIDATES: Record<ModelRole, ModelSpec[]> = {
  quick: [
    {
      provider: "groq",
      model: process.env.MORPHEUS_MODEL_QUICK_GROQ ?? "openai/gpt-oss-120b",
      label: "GPT-OSS 120B (Groq)",
      maxTokens: 700,
    },
    {
      provider: "google",
      model: process.env.MORPHEUS_MODEL_QUICK ?? "gemini-2.5-flash",
      label: "Gemini Flash",
      maxTokens: 700,
    },
  ],
  hard: [
    {
      provider: "google",
      model: process.env.MORPHEUS_MODEL_HARD ?? "gemini-2.5-pro",
      label: "Gemini Pro",
      maxTokens: 1600,
    },
    {
      provider: "groq",
      model: process.env.MORPHEUS_MODEL_HARD_GROQ ?? "openai/gpt-oss-120b",
      label: "GPT-OSS 120B (Groq)",
      maxTokens: 1600,
    },
  ],
  /**
   * One candidate, deliberately.
   *
   * `judgment` is the role reached when a turn is consequential — pricing,
   * contracts, firing someone, spending money. If a frontier key is missing,
   * this role must report that it is unavailable rather than quietly answering
   * from the fast tier. A silent downgrade on exactly the questions where
   * being fast and wrong is most expensive is the single worst thing a router
   * can do, and it is invisible: the answer still arrives, still fluent.
   */
  judgment: [
    {
      provider: "anthropic",
      model: process.env.MORPHEUS_MODEL_JUDGMENT ?? "claude-opus-4-5",
      label: "Claude Opus",
      maxTokens: 1600,
    },
  ],
  vision: [
    {
      provider: "anthropic",
      model: process.env.MORPHEUS_MODEL_VISION ?? "claude-sonnet-4-5",
      label: "Claude Sonnet",
      maxTokens: 1600,
    },
  ],
  extract: [
    {
      provider: "groq",
      model: process.env.MORPHEUS_MODEL_EXTRACT_GROQ ?? "openai/gpt-oss-120b",
      label: "GPT-OSS 120B (Groq)",
      maxTokens: 600,
    },
    {
      provider: "anthropic",
      model: process.env.MORPHEUS_MODEL_EXTRACT ?? "claude-haiku-4-5-20251001",
      label: "Claude Haiku",
      maxTokens: 600,
    },
  ],
};

/** Roles that must never fall back to a cheaper tier. */
export const NO_DOWNGRADE: ModelRole[] = ["judgment"];

/**
 * The model that will actually serve a role, given the keys present.
 *
 * Returns null when no candidate has a key — which for `judgment` is the
 * correct and important outcome. Callers surface that as "unavailable", never
 * as an answer from somewhere else.
 */
export function specFor(role: ModelRole): ModelSpec | null {
  return CANDIDATES[role].find((spec) => Boolean(keyFor(spec.provider))) ?? null;
}

/** Every candidate for a role, so the UI can show what it would fall back to. */
export function candidatesFor(role: ModelRole): ModelSpec[] {
  return CANDIDATES[role];
}

/**
 * The stack as currently resolved.
 *
 * A getter per role rather than a frozen object: keys can appear between a
 * build and a request, and an earlier version of this file was inlined at
 * build time and served whatever the environment held during `npm run build`.
 */
export const STACK: Record<ModelRole, ModelSpec> = {
  get quick() {
    return specFor("quick") ?? CANDIDATES.quick[0];
  },
  get hard() {
    return specFor("hard") ?? CANDIDATES.hard[0];
  },
  get judgment() {
    return CANDIDATES.judgment[0];
  },
  get vision() {
    return CANDIDATES.vision[0];
  },
  get extract() {
    return specFor("extract") ?? CANDIDATES.extract[0];
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
const GROQ_BASE = process.env.GROQ_BASE_URL ?? "https://api.groq.com";
const GOOGLE_BASE =
  process.env.GOOGLE_API_BASE_URL ?? "https://generativelanguage.googleapis.com";

/** The env var a provider needs, for error messages that tell you what to do. */
export function keyNameFor(provider: Provider): string {
  return provider === "groq"
    ? "GROQ_API_KEY"
    : provider === "anthropic"
      ? "ANTHROPIC_API_KEY"
      : "GOOGLE_API_KEY";
}

export function keyFor(provider: Provider): string | undefined {
  if (provider === "groq") return process.env.GROQ_API_KEY;
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

/**
 * Groq speaks the OpenAI chat-completions shape, so one small adapter covers
 * every model it hosts. The system prompt becomes a leading `system` message
 * rather than a separate field, which is the only real difference from here.
 */
function groqBody(spec: ModelSpec, options: CallOptions) {
  return JSON.stringify({
    model: spec.model,
    max_tokens: options.maxTokens ?? spec.maxTokens,
    messages: [
      ...(options.system ? [{ role: "system", content: options.system }] : []),
      ...options.messages,
    ],
    ...(options.json ? { response_format: { type: "json_object" } } : {}),
  });
}

async function callGroq(spec: ModelSpec, options: CallOptions): Promise<string> {
  const response = await fetch(`${GROQ_BASE}/openai/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${keyFor("groq") as string}`,
    },
    body: groqBody(spec, options),
  });

  if (!response.ok) {
    throw new Error(`groq ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content?.trim() ?? "";
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
  // Resolved per call rather than read from a frozen table, so a key added
  // after start-up takes effect, and so `judgment` can refuse rather than
  // silently answer from whatever else happens to be configured.
  const resolved = specFor(role);
  const spec = resolved ?? STACK[role];

  if (!resolved) {
    const wanted = [...new Set(candidatesFor(role).map((s) => keyNameFor(s.provider)))];
    return {
      text: "",
      spec,
      live: false,
      error: NO_DOWNGRADE.includes(role)
        ? `No ${wanted.join(" or ")} configured. This is a consequential-judgment call and will not be answered by a cheaper model — a fast wrong answer here is worse than none.`
        : `No ${wanted.join(" or ")} configured`,
    };
  }

  try {
    const text =
      spec.provider === "anthropic"
        ? await callAnthropic(spec, options)
        : spec.provider === "groq"
          ? await callGroq(spec, options)
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
export function stackStatus(): Array<{
  role: ModelRole;
  spec: ModelSpec;
  ready: boolean;
  /** True when this role refuses to fall back rather than downgrading. */
  protected: boolean;
}> {
  return (Object.keys(CANDIDATES) as ModelRole[]).map((role) => {
    const resolved = specFor(role);
    return {
      role,
      spec: resolved ?? CANDIDATES[role][0],
      ready: resolved !== null,
      protected: NO_DOWNGRADE.includes(role),
    };
  });
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

// ── Streaming ────────────────────────────────────────────────────────────

/**
 * Stream a role, delivering text deltas as they arrive.
 *
 * This exists for one reason: Morpheus is voice-first. Waiting for a full
 * completion before speaking adds seconds of silence to every turn, and the
 * whole point of the rebuilt voice system is that you are not sitting there
 * waiting for it. With deltas, the first sentence can be spoken while the rest
 * is still being generated.
 *
 * Returns the full text as well, so callers can persist and learn from it.
 */
export async function streamRole(
  role: ModelRole,
  options: CallOptions,
  onDelta: (delta: string) => void,
): Promise<CallResult> {
  const resolved = specFor(role);
  const spec = resolved ?? STACK[role];

  if (!resolved) {
    const wanted = [...new Set(candidatesFor(role).map((s) => keyNameFor(s.provider)))];
    return {
      text: "",
      spec,
      live: false,
      error: NO_DOWNGRADE.includes(role)
        ? `No ${wanted.join(" or ")} configured. Consequential judgment is never downgraded.`
        : `No ${wanted.join(" or ")} configured`,
    };
  }

  const request: { url: string; headers: Record<string, string>; body: string } =
    spec.provider === "groq"
      ? {
          // OpenAI-compatible SSE. Groq serves `quick`, which is the voice
          // path — so this branch existing is the difference between speaking
          // as the words arrive and a second of silence before every reply.
          url: `${GROQ_BASE}/openai/v1/chat/completions`,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${keyFor("groq") as string}`,
          },
          body: JSON.stringify({
            model: spec.model,
            max_tokens: options.maxTokens ?? spec.maxTokens,
            messages: [
              ...(options.system ? [{ role: "system", content: options.system }] : []),
              ...options.messages,
            ],
            stream: true,
          }),
        }
      : spec.provider === "anthropic"
      ? {
          url: `${ANTHROPIC_BASE}/v1/messages`,
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
            stream: true,
          }),
        }
      : {
          url: `${GOOGLE_BASE}/v1beta/models/${spec.model}:streamGenerateContent?alt=sse`,
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
            generationConfig: { maxOutputTokens: options.maxTokens ?? spec.maxTokens },
          }),
        };

  try {
    const response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
    });

    if (!response.ok || !response.body) {
      throw new Error(
        `${spec.provider} ${response.status}: ${(await response.text()).slice(0, 300)}`,
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are newline-delimited; the tail may be a partial line.
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;

        try {
          const event = JSON.parse(payload) as {
            type?: string;
            delta?: { type?: string; text?: string };
            candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
            choices?: Array<{ delta?: { content?: string } }>;
          };

          const delta =
            spec.provider === "groq"
              ? (event.choices?.[0]?.delta?.content ?? "")
              : spec.provider === "anthropic"
                ? event.type === "content_block_delta" && event.delta?.type === "text_delta"
                  ? (event.delta.text ?? "")
                  : ""
                : (event.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "");

          if (delta) {
            text += delta;
            onDelta(delta);
          }
        } catch {
          // A malformed frame should not abort a good stream.
        }
      }
    }

    return { text, spec, live: true };
  } catch (error) {
    console.error(`models: ${role} stream failed`, error);
    return {
      text: "",
      spec,
      live: false,
      error: error instanceof Error ? error.message : "unknown provider error",
    };
  }
}

// ── Images ───────────────────────────────────────────────────────────────

/**
 * Image generation.
 *
 * From the source description: "branded graphics are rendered as code, while
 * photos use Gemini's image model or Imagen." This covers the photo path;
 * the render-as-code path is the existing HTML/SVG surfaces, which is why
 * there is no template engine here.
 *
 * Returns a data URL so callers never have to manage a file, and the caller
 * decides whether to persist it.
 */
export async function generateImage(
  prompt: string,
): Promise<{ ok: true; dataUrl: string; model: string } | { ok: false; error: string }> {
  const key = keyFor("google");
  if (!key) return { ok: false, error: "No GOOGLE_API_KEY configured" };

  const model = process.env.MORPHEUS_MODEL_IMAGE ?? "imagen-4.0-generate-001";

  try {
    const response = await fetch(`${GOOGLE_BASE}/v1beta/models/${model}:predict`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: { sampleCount: 1, aspectRatio: process.env.MORPHEUS_IMAGE_ASPECT ?? "1:1" },
      }),
    });

    if (!response.ok) {
      return { ok: false, error: `imagen ${response.status}: ${(await response.text()).slice(0, 200)}` };
    }

    const data = (await response.json()) as {
      predictions?: Array<{ bytesBase64Encoded?: string; mimeType?: string }>;
    };
    const prediction = data.predictions?.[0];
    if (!prediction?.bytesBase64Encoded) {
      return { ok: false, error: "the model returned no image" };
    }

    return {
      ok: true,
      model,
      dataUrl: `data:${prediction.mimeType ?? "image/png"};base64,${prediction.bytesBase64Encoded}`,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "image request failed" };
  }
}
