// What the screens are told about AI. Shared by the routes and the components,
// so both sides agree on the shape. Never the key, the address or the prompts.
import type { AiSetup } from "./config";
import {
  isAiKeyProvider,
  MAX_KEY_LENGTH,
  MIN_KEY_LENGTH,
  modelNameProblem,
  type AiKeyProvider,
} from "./key-providers";
import type { OrgKeyInput } from "./org-key";
import { AI_FEATURES, FEATURE_LABELS, type AiFeature } from "./prompts";
import type { AiUsage } from "./store";
import type { AiSettingsChange } from "./settings";

/** GET /api/ai/status: can this person use AI here, feature by feature. */
export type AiStatusView = {
  configured: boolean;
  service: string | null;
  /** Why AI is not set up, in words for the person, when it is not. */
  problem?: string | null;
  enabled: boolean;
  features: Record<AiFeature, boolean>;
};

/** What the Admin screen is told about the organization's own AI key. Never the key. */
export type AiKeyView = {
  provider: AiKeyProvider;
  /** The service's name, from the fixed list. */
  service: string;
  /** The key's last four characters. */
  hint: string;
  models: { fast: string; smart: string };
  setBy: string | null;
  setAt: string | null;
  /** False when this server cannot open the saved key, so an Admin saves it again. */
  readable: boolean;
};

/** GET /api/admin/ai: the Admin screen's AI tab. */
export type AiAdminView = {
  /** What AI calls use now: the organization's own key when one is saved, else the server's settings. */
  setup: AiSetup;
  /** The server's own AI settings, used when no organization key is saved. */
  serverSetup: AiSetup;
  orgKey: AiKeyView | null;
  /** False when the server has no encryption key, so it refuses to save an AI key. */
  canStoreKeys: boolean;
  enabled: boolean;
  features: { key: AiFeature; label: string; on: boolean }[];
  updatedBy: string | null;
  updatedAt: string | null;
  usage: AiUsage | null;
  dailyLimit: number | null;
  canUpdate: boolean;
};

/**
 * The note under the Admin usage card: what a call is, and what Failed
 * counts (store.ts readAiUsage: every outcome but ok and limit_reached).
 */
export const AI_USAGE_NOTE =
  "Each request to the AI service is one call, a retry or a switch to the other model included. " +
  "Saved answers cost nothing: the same question about the same schema is answered from the last checked answer for seven days. " +
  "Failed counts calls that gave no usable answer: the service was busy, out of its free allowance or too slow, " +
  "or the answer did not pass the app's checks.";

export const FEATURE_LIST = AI_FEATURES.map((key) => ({ key, label: FEATURE_LABELS[key] }));

export function isAiStatusView(value: unknown): value is AiStatusView {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.configured === "boolean" &&
    typeof v.enabled === "boolean" &&
    typeof v.features === "object" &&
    v.features !== null
  );
}

export function isAiAdminView(value: unknown): value is AiAdminView {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.enabled === "boolean" &&
    Array.isArray(v.features) &&
    typeof v.setup === "object" &&
    v.setup !== null &&
    typeof v.serverSetup === "object" &&
    v.serverSetup !== null &&
    typeof v.canStoreKeys === "boolean" &&
    (v.orgKey === null || typeof v.orgKey === "object")
  );
}

/** PATCH /api/admin/ai: the change asked for, or what is wrong with it. */
export function readAiSettingsChange(body: unknown): AiSettingsChange | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "Expected a JSON object.";
  const { enabled, features } = body as { enabled?: unknown; features?: unknown };
  const change: AiSettingsChange = {};
  if (enabled !== undefined) {
    if (typeof enabled !== "boolean") return "enabled must be true or false.";
    change.enabled = enabled;
  }
  if (features !== undefined) {
    if (typeof features !== "object" || features === null || Array.isArray(features)) {
      return "features must be an object of feature names to true or false.";
    }
    const picked: Partial<Record<AiFeature, boolean>> = {};
    for (const [key, on] of Object.entries(features)) {
      if (!(AI_FEATURES as string[]).includes(key)) return `There is no AI feature called ${key}.`;
      if (typeof on !== "boolean") return `${key} must be true or false.`;
      picked[key as AiFeature] = on;
    }
    change.features = picked;
  }
  if (change.enabled === undefined && change.features === undefined) return "Nothing to change.";
  return change;
}

/**
 * PUT /api/admin/ai/key: the key to save, or what is wrong with it. The key
 * is only trimmed, never changed, and never put in the answer.
 */
export function readAiKeyChange(body: unknown): OrgKeyInput | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "Expected a JSON object.";
  const { provider, apiKey, modelFast, modelSmart } = body as Record<string, unknown>;
  if (!isAiKeyProvider(provider)) return "Pick one of the AI services in the list.";
  if (typeof apiKey !== "string") return "Paste the API key.";
  const key = apiKey.trim();
  if (key.length < MIN_KEY_LENGTH) return "That API key is too short. Paste the whole key.";
  if (key.length > MAX_KEY_LENGTH) return `An API key can be at most ${MAX_KEY_LENGTH} characters.`;
  if (/\s/.test(key)) return "An API key has no spaces or line breaks in it.";
  const input: OrgKeyInput = { provider, apiKey: key };
  for (const [field, value] of [
    ["modelFast", modelFast],
    ["modelSmart", modelSmart],
  ] as const) {
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") return `${field} must be text.`;
    const name = value.trim();
    const problem = modelNameProblem(name);
    if (problem) return problem;
    if (name) input[field] = name;
  }
  return input;
}

/** Every AI route's answer: the checked answer, and how it was made. */
export type AiAnswerMeta = {
  callId: number | null;
  model: string;
  saved: boolean;
  ms: number;
  retries: number;
  inputTokens: number;
  outputTokens: number;
};
export type AiAnswerBody<T> = { answer: T; meta: AiAnswerMeta };

export function isAiAnswerBody(value: unknown): value is AiAnswerBody<unknown> {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return "answer" in v && typeof v.meta === "object" && v.meta !== null;
}
