// ---------------------------------------------------------------------------
// lib/ai/config.ts
// Which AI service the server talks to, read from the environment.
//
// Server only. The key is read here and handed to the provider, and nothing
// else: it never goes to the browser, into the database, or into a log line.
// describeAiConfig() is the only thing screens see, and it carries no key.
//
//   AI_PROVIDER      openai-compatible (Gemini, Groq, OpenRouter, Ollama)
//   AI_BASE_URL      the service's OpenAI-style address, ending in a slash
//   AI_API_KEY       the key
//   AI_MODEL_FAST    the model for short jobs (summaries, the drift line)
//   AI_MODEL_SMART   the model for the rest; the fast one if left empty
//   AI_REASONING_EFFORT  low, medium or high, for models that think first
//   AI_TIMEOUT_MS    how long one call may take (default 90 seconds)
//   AI_DAILY_LIMIT   calls per organization per day (default 300)
//   AI_PER_MINUTE    calls per person per minute (default 10)
// ---------------------------------------------------------------------------

export type AiTier = "fast" | "smart";

export type AiConfig = {
  provider: "openai-compatible";
  baseUrl: string;
  apiKey: string;
  models: Record<AiTier, string>;
  /** Sent as reasoning_effort when set. Null leaves it to the model. */
  reasoningEffort: string | null;
  timeoutMs: number;
  dailyLimit: number;
  perMinuteLimit: number;
};

const EFFORTS = new Set(["low", "medium", "high"]);

/** A whole number from the environment, or the fallback when it is missing or nonsense. */
function wholeNumber(value: string | undefined, fallback: number, min: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min ? parsed : fallback;
}

/**
 * The AI settings, or null when AI is not set up on this server: no key, no
 * address, or no model. Every AI route answers "not set up" on null, and the
 * screens hide the AI buttons.
 */
export function readAiConfig(env: NodeJS.ProcessEnv = process.env): AiConfig | null {
  const provider = (env.AI_PROVIDER ?? "").trim() || "openai-compatible";
  if (provider !== "openai-compatible") return null;
  const baseUrl = (env.AI_BASE_URL ?? "").trim();
  const apiKey = (env.AI_API_KEY ?? "").trim();
  const fast = (env.AI_MODEL_FAST ?? "").trim();
  const smart = (env.AI_MODEL_SMART ?? "").trim();
  if (!baseUrl || !apiKey || (!fast && !smart)) return null;
  if (!/^https?:\/\//i.test(baseUrl)) return null;
  const effort = (env.AI_REASONING_EFFORT ?? "").trim().toLowerCase();
  return {
    provider,
    baseUrl: baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
    apiKey,
    models: { fast: fast || smart, smart: smart || fast },
    reasoningEffort: EFFORTS.has(effort) ? effort : null,
    timeoutMs: wholeNumber(env.AI_TIMEOUT_MS, 90_000, 1_000),
    dailyLimit: wholeNumber(env.AI_DAILY_LIMIT, 300, 0),
    perMinuteLimit: wholeNumber(env.AI_PER_MINUTE, 10, 0),
  };
}

/** The service's name as people know it, from its address. */
export function serviceName(baseUrl: string): string {
  let host = "";
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return "AI service";
  }
  if (host.endsWith("generativelanguage.googleapis.com")) return "Google Gemini";
  if (host.endsWith("groq.com")) return "Groq";
  if (host.endsWith("openrouter.ai")) return "OpenRouter";
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return "Ollama (this computer)";
  return host;
}

/** What a screen may know about the AI setup: never the key or the address. */
export type AiSetup = {
  configured: boolean;
  service: string | null;
  models: Record<AiTier, string> | null;
};

export function describeAiConfig(config: AiConfig | null = readAiConfig()): AiSetup {
  if (!config) return { configured: false, service: null, models: null };
  return { configured: true, service: serviceName(config.baseUrl), models: { ...config.models } };
}
