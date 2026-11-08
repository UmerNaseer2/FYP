// The AI services an organization may use with its own key (Admin, AI).
//
// A fixed list on purpose: the address each key is sent to is written here,
// never typed by an Admin, so a key can only ever go to the service it was
// made for, and a saved key cannot be pointed at a machine inside the
// server's network.
//
// Shared by the server (lib/ai/org-key.ts) and the Admin screen's AI tab, so
// it holds names and addresses only, never a key.

export type AiKeyProvider = "gemini" | "openai" | "anthropic";

export type AiKeyProviderInfo = {
  /** The name people know the service by, shown on screen. */
  label: string;
  /** How the app talks to it: the OpenAI-style adapter, or the Claude SDK. */
  protocol: "openai-compatible" | "anthropic";
  baseUrl: string;
  /** The models used when the Admin leaves the model names empty. */
  models: { fast: string; smart: string };
  /** How hard a model that thinks first should think. Low keeps answers quick. */
  reasoningEffort: "low" | "medium" | "high" | null;
  /** Where an Admin makes a key, for the hint under the form. */
  keyPage: string;
};

export const AI_KEY_PROVIDERS: Record<AiKeyProvider, AiKeyProviderInfo> = {
  anthropic: {
    label: "Anthropic Claude",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com",
    models: { fast: "claude-haiku-5-5", smart: "claude-sonnet-5-5" },
    reasoningEffort: "low",
    keyPage: "console.anthropic.com, API keys",
  },
  gemini: {
    label: "Google Gemini",
    protocol: "openai-compatible",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    models: { fast: "gemini-3.5-flash-lite", smart: "gemini-3.5-flash" },
    reasoningEffort: "low",
    keyPage: "aistudio.google.com, Get API key",
  },
  openai: {
    label: "OpenAI",
    protocol: "openai-compatible",
    baseUrl: "https://api.openai.com/v1/",
    models: { fast: "gpt-5-mini", smart: "gpt-5" },
    reasoningEffort: "low",
    keyPage: "platform.openai.com, API keys",
  },
};

/** The list in the order the Admin screen shows it. */
export const AI_KEY_PROVIDER_LIST = (Object.keys(AI_KEY_PROVIDERS) as AiKeyProvider[]).map((key) => ({
  key,
  ...AI_KEY_PROVIDERS[key],
}));

export function isAiKeyProvider(value: unknown): value is AiKeyProvider {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(AI_KEY_PROVIDERS, value);
}

/**
 * The subject of the change log rows about the key (kind "ai-settings"). The
 * detail is the service's label, or "removed". Never any part of the key.
 */
export const AI_KEY_LOG_SUBJECT = "Organization AI key";

/** The shortest and longest key accepted. Real keys are 30 to 200 characters. */
export const MIN_KEY_LENGTH = 8;
export const MAX_KEY_LENGTH = 500;

/** The longest model name accepted. Real ones are far shorter. */
export const MAX_MODEL_NAME = 100;

/**
 * A model name an Admin typed: letters, digits and . _ - : / only, so it can
 * go in a request body and on screen without surprises. Empty means "use the
 * provider's usual one".
 */
export function modelNameProblem(name: string): string | null {
  if (name === "") return null;
  if (name.length > MAX_MODEL_NAME) return `A model name can be at most ${MAX_MODEL_NAME} characters.`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(name)) {
    return "A model name can only have letters, digits and . _ - : / in it.";
  }
  return null;
}
