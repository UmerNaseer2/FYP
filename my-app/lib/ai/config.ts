// ---------------------------------------------------------------------------
// lib/ai/config.ts
// Which AI service the server talks to, read from the environment.
//
// Server only. The key is read here and handed to the provider, and nothing
// else: it never goes to the browser, into the database, or into a log line.
// describeAiConfig() is the only thing screens see, and it carries no key.
//
// An organization can also save its own key (Admin, AI; lib/ai/org-key.ts).
// Its calls then use configForOrgKey below instead of these settings, with
// the same limits and wait.
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

import { AI_KEY_PROVIDERS, type AiKeyProvider } from "./key-providers";

export type AiTier = "fast" | "smart";

export type AiConfig = {
  /** How the app talks to the service: the OpenAI-style adapter, or the Claude SDK. */
  provider: "openai-compatible" | "anthropic";
  /** Whose key this is: the server's settings (when missing), or the organization's own. */
  source?: "server" | "organization";
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

/** The limits and wait every AI call keeps, whoever's key it uses. */
export type AiLimits = Pick<AiConfig, "timeoutMs" | "dailyLimit" | "perMinuteLimit">;

export function readAiLimits(env: NodeJS.ProcessEnv = process.env): AiLimits {
  return {
    timeoutMs: wholeNumber(env.AI_TIMEOUT_MS, 90_000, 1_000),
    dailyLimit: wholeNumber(env.AI_DAILY_LIMIT, 300, 0),
    perMinuteLimit: wholeNumber(env.AI_PER_MINUTE, 10, 0),
  };
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
    ...readAiLimits(env),
  };
}

/**
 * The settings for an organization's own key: the service's address and
 * protocol from the fixed list, never typed by anyone, and the server's
 * limits and wait.
 */
export function configForOrgKey(
  key: { provider: AiKeyProvider; apiKey: string; models: Record<AiTier, string> },
  env: NodeJS.ProcessEnv = process.env
): AiConfig {
  const service = AI_KEY_PROVIDERS[key.provider];
  return {
    provider: service.protocol,
    source: "organization",
    baseUrl: service.baseUrl,
    apiKey: key.apiKey,
    models: { ...key.models },
    reasoningEffort: service.reasoningEffort,
    ...readAiLimits(env),
  };
}

/** What a service this file does not know is called on screen. Never its address. */
export const OTHER_SERVICE = "the AI service in the server's settings";

/**
 * The service's name as people know it, from its address. Shown to everyone
 * who may use AI, so it is only ever a name from this list: a service this
 * file does not know is OTHER_SERVICE, never its host name, which could be
 * an internal machine's name or address.
 */
export function serviceName(baseUrl: string): string {
  let host = "";
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return OTHER_SERVICE;
  }
  if (host.endsWith("generativelanguage.googleapis.com")) return "Google Gemini";
  if (host.endsWith("groq.com")) return "Groq";
  if (host.endsWith("openrouter.ai")) return "OpenRouter";
  if (host === "api.openai.com") return "OpenAI";
  if (host === "api.anthropic.com") return "Anthropic Claude";
  // URL gives an IPv6 host in brackets: "[::1]".
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return "Ollama (this computer)";
  return OTHER_SERVICE;
}

/** What a screen may know about the AI setup: never the key or the address. */
export type AiSetup = {
  configured: boolean;
  service: string | null;
  models: Record<AiTier, string> | null;
  /** True when the organization's own key is used, not the server's. */
  ownKey: boolean;
};

export function describeAiConfig(config: AiConfig | null = readAiConfig()): AiSetup {
  if (!config) return { configured: false, service: null, models: null, ownKey: false };
  return {
    configured: true,
    service: serviceName(config.baseUrl),
    models: { ...config.models },
    ownKey: config.source === "organization",
  };
}
