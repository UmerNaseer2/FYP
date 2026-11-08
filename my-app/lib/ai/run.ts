// SERVER-ONLY: import this file from API routes and other server code only.
//
// The one way an AI feature asks the model anything. Every feature calls
// runAiTask, so every answer goes through the same steps:
//
//   1. Is AI set up on this server, switched on for the organization, and is
//      this feature on? (The route has already checked the person may use it.)
//   2. Is a checked answer to the same question saved? Then that is the answer.
//   3. Are the organization's daily limit and the person's per-minute limit
//      still clear?
//   4. Ask the model for JSON of a fixed shape. If the smart model times out
//      or is busy, the fast one is asked instead.
//   5. Read the JSON against the shape (zod), then run the feature's own code
//      checks (names exist, grade locked, SQL guards). One retry (or the
//      feature's own count), with the problems spelled out, when either fails.
//   6. Write a usage row either way, and save a good answer for reuse.
//
// The model never decides anything here. A feature's `check` is where the
// engine's facts overrule it.
import { z } from "zod";
import { readAiConfig, serviceName, type AiConfig, type AiTier } from "./config";
import { AiError, type AiMessage, type AiProvider, type AiUsage, type GenerateRequest } from "./provider";
import { OpenAiCompatibleProvider } from "./openai-compatible";
import { PROMPT_VERSIONS, SHARED_RULES, type AiFeature } from "./prompts";
import { featureOn, readOrgAi, type OrgAiSettings } from "./settings";
import * as store from "./store";
import type { AiOutcome } from "./store";

/** Who is asking. The route builds this from the signed-in principal. */
export type AiCaller = { orgId: number; email: string };

export type AiTaskSpec<T> = {
  feature: AiFeature;
  tier: AiTier;
  /** The feature's own instructions. The shared rules go in front of them. */
  system: string;
  /** The question, with the schema text and the engine's facts in it. */
  prompt: string;
  /** The shape the answer must have. */
  schema: z.ZodType<T>;
  /** What makes two questions the same, for the saved answers. Null skips them. */
  cacheInput: unknown | null;
  maxOutputTokens: number;
  /**
   * The feature's code checks. Returns the answer to show (the engine's facts
   * written over the model's) and any problems. A problem triggers a retry,
   * and fails the task if it is still there after the last one. It may be
   * async: SQL generation tries the script on the database inside it.
   */
  check?: (value: T) => { value: T; problems: string[] } | Promise<{ value: T; problems: string[] }>;
  /** How many times a failed answer is sent back to be fixed. One unless said. */
  repairs?: number;
  timeoutMs?: number;
};

export type AiAnswerMeta = {
  callId: number | null;
  model: string;
  /** True when the answer came from the saved answers and cost nothing. */
  saved: boolean;
  ms: number;
  retries: number;
  usage: AiUsage;
};

export type AiRunResult<T> =
  | ({ kind: "ok"; value: T } & AiAnswerMeta)
  | { kind: "unavailable"; reason: "not-configured" | "switched-off" | "feature-off"; message: string }
  | { kind: "limited"; message: string }
  | { kind: "failed"; outcome: AiOutcome; message: string };

/** Everything run.ts reaches outside itself, so the tests can hand in their own. */
export type AiDeps = {
  config: AiConfig | null;
  provider: AiProvider | null;
  readSettings: (orgId: number) => Promise<OrgAiSettings>;
  store: Pick<
    typeof store,
    "recordAiCall" | "callsToday" | "callsLastMinute" | "readSavedAnswer" | "saveAnswer"
  >;
  now: () => number;
};

export function defaultAiDeps(): AiDeps {
  const config = readAiConfig();
  return {
    config,
    provider: config ? new OpenAiCompatibleProvider(config) : null,
    readSettings: readOrgAi,
    store,
    now: () => Date.now(),
  };
}

export const NOT_CONFIGURED =
  "AI assistance is not set up on this server. An administrator adds an AI service key to the server's settings.";
export const SWITCHED_OFF = "AI assistance is switched off for this organization. An Admin can switch it on in Admin, AI.";
export const FEATURE_OFF = "This AI feature is switched off for this organization. An Admin can switch it on in Admin, AI.";

/** The JSON Schema the service is asked to follow, from the zod shape. */
// Keywords left out of the answer format sent to the service. Gemini's
// OpenAI-compatible endpoint answers a strict format that limits a list's
// length with a bare 400 "Request contains an invalid argument." The limits
// still hold: readAnswer checks the answer against the zod schema itself.
const UNSENT_KEYWORDS = new Set(["$schema", "minItems", "maxItems"]);

function withoutUnsent(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutUnsent);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (UNSENT_KEYWORDS.has(key)) continue;
    // Under "properties" the keys are field names, never keywords.
    out[key] =
      key === "properties" && value !== null && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).map(([field, sub]) => [field, withoutUnsent(sub)]))
        : withoutUnsent(value);
  }
  return out;
}

/** The answer format sent to the service: the zod schema as JSON Schema, minus what services refuse. */
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  return withoutUnsent(z.toJSONSchema(schema)) as Record<string, unknown>;
}

function zodProblems(error: z.ZodError): string[] {
  return error.issues.slice(0, 6).map((issue) => {
    const where = issue.path.length > 0 ? issue.path.join(".") : "the answer";
    return `${where}: ${issue.message}`;
  });
}

/** Read the model's text as JSON of the right shape. */
export function readAnswer<T>(text: string, schema: z.ZodType<T>): { value: T } | { problems: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { problems: ["The answer was not valid JSON."] };
  }
  const result = schema.safeParse(parsed);
  return result.success ? { value: result.data } : { problems: zodProblems(result.error) };
}

/** Is AI usable for this feature here? Null when it is, else why not. */
export async function aiGate(
  caller: AiCaller,
  feature: AiFeature,
  deps: Pick<AiDeps, "config" | "provider" | "readSettings">
): Promise<Extract<AiRunResult<never>, { kind: "unavailable" }> | null> {
  if (!deps.config || !deps.provider) return { kind: "unavailable", reason: "not-configured", message: NOT_CONFIGURED };
  const settings = await deps.readSettings(caller.orgId);
  if (!settings.enabled) return { kind: "unavailable", reason: "switched-off", message: SWITCHED_OFF };
  if (!featureOn(settings, feature)) return { kind: "unavailable", reason: "feature-off", message: FEATURE_OFF };
  return null;
}

/** The daily and per-minute limits. Null when clear. */
export async function aiLimits(
  caller: AiCaller,
  config: AiConfig,
  deps: Pick<AiDeps, "store">
): Promise<string | null> {
  if ((await deps.store.callsToday(caller.orgId)) >= config.dailyLimit) {
    return `Your organization has used its ${config.dailyLimit} AI calls for today. The count starts again at midnight UTC.`;
  }
  if ((await deps.store.callsLastMinute(caller.orgId, caller.email)) >= config.perMinuteLimit) {
    return "That is a lot of AI questions in one minute. Wait a moment and try again.";
  }
  return null;
}

/** The models to try, best first. */
export function modelsFor(config: AiConfig, tier: AiTier): string[] {
  return tier === "smart" && config.models.smart !== config.models.fast
    ? [config.models.smart, config.models.fast]
    : [config.models[tier]];
}

function outcomeOf(error: AiError): AiOutcome {
  if (error.kind === "rate_limited") return "rate_limited";
  if (error.kind === "timeout") return "timeout";
  return "provider_error";
}

export function messageForFailure(outcome: AiOutcome): string {
  switch (outcome) {
    case "rate_limited":
      return "The AI service's free allowance is used up for now. Try again in a minute.";
    case "timeout":
      return "The AI service took too long to answer. Try again.";
    case "invalid_output":
    case "failed_check":
      return "The AI's answer did not pass the app's checks, so it is not shown. Try again, or read the engine's own report.";
    default:
      return "The AI service could not answer. Try again later.";
  }
}

const ZERO: AiUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, estimated: false };

function addUsage(a: AiUsage, b: AiUsage): AiUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    estimated: a.estimated || b.estimated,
  };
}

export async function runAiTask<T>(
  caller: AiCaller,
  spec: AiTaskSpec<T>,
  deps: AiDeps = defaultAiDeps()
): Promise<AiRunResult<T>> {
  const refused = await aiGate(caller, spec.feature, deps);
  if (refused) return refused;
  const config = deps.config!;
  const provider = deps.provider!;
  const promptVersion = PROMPT_VERSIONS[spec.feature];
  const base = {
    orgId: caller.orgId,
    actor: caller.email,
    feature: spec.feature,
    provider: serviceName(config.baseUrl),
    promptVersion,
  };

  const key = spec.cacheInput === null ? null : store.cacheKey(spec.feature, promptVersion, spec.cacheInput);
  if (key) {
    const saved = await deps.store.readSavedAnswer<unknown>(caller.orgId, spec.feature, key);
    const read = saved ? spec.schema.safeParse(saved.answer) : null;
    if (saved && read?.success) {
      const callId = await deps.store.recordAiCall({
        ...base,
        model: saved.model,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        estimated: false,
        ms: 0,
        retries: 0,
        outcome: "ok",
        cacheHit: true,
      });
      return { kind: "ok", value: read.data, callId, model: saved.model, saved: true, ms: 0, retries: 0, usage: ZERO };
    }
  }

  const limited = await aiLimits(caller, config, deps);
  if (limited) {
    await deps.store.recordAiCall({
      ...base,
      model: config.models[spec.tier],
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      estimated: false,
      ms: 0,
      retries: 0,
      outcome: "limit_reached",
      cacheHit: false,
    });
    return { kind: "limited", message: limited };
  }

  const started = deps.now();
  const messages: AiMessage[] = [{ role: "user", content: spec.prompt }];
  const models = modelsFor(config, spec.tier);
  let usage = ZERO;
  let retries = 0;
  let lastModel = models[0];
  let failure: AiOutcome | null = null;

  const finish = async (outcome: AiOutcome) =>
    deps.store.recordAiCall({
      ...base,
      model: lastModel,
      ...usage,
      ms: deps.now() - started,
      retries,
      outcome,
      cacheHit: false,
    });

  const repairs = Math.max(0, spec.repairs ?? 1);
  for (let attempt = 0; attempt <= repairs; attempt += 1) {
    let text: string | null = null;
    for (const model of models) {
      lastModel = model;
      const request: GenerateRequest = {
        model,
        system: `${SHARED_RULES}\n\n${spec.system}`,
        messages,
        jsonSchema: { name: spec.feature.replace(/-/g, "_"), schema: jsonSchemaOf(spec.schema) },
        maxOutputTokens: spec.maxOutputTokens,
        timeoutMs: spec.timeoutMs,
      };
      try {
        const result = await provider.generate(request);
        usage = addUsage(usage, result.usage);
        lastModel = result.model || model;
        text = result.text;
        failure = null;
        break;
      } catch (error) {
        if (!(error instanceof AiError)) throw error;
        failure = outcomeOf(error);
        // A refused request will be refused by the other model too, and a
        // used-up quota is shared by both.
        if (error.kind === "rejected" || error.kind === "rate_limited") break;
      }
    }
    if (text === null) {
      const outcome = failure ?? "provider_error";
      await finish(outcome);
      return { kind: "failed", outcome, message: messageForFailure(outcome) };
    }

    const read = readAnswer(text, spec.schema);
    let problems: string[];
    let value: T | null = null;
    let outcome: AiOutcome = "invalid_output";
    if ("problems" in read) {
      problems = read.problems;
    } else {
      const checked = spec.check ? await spec.check(read.value) : { value: read.value, problems: [] };
      problems = checked.problems;
      value = checked.value;
      outcome = "failed_check";
    }
    if (problems.length === 0 && value !== null) {
      const ms = deps.now() - started;
      const callId = await finish("ok");
      if (key) await deps.store.saveAnswer(caller.orgId, spec.feature, key, lastModel, value);
      return { kind: "ok", value, callId, model: lastModel, saved: false, ms, retries, usage };
    }
    if (attempt < repairs) {
      retries += 1;
      messages.push({ role: "assistant", content: text });
      messages.push({
        role: "user",
        content: `Your answer has these problems:\n- ${problems.join("\n- ")}\nAnswer again in the same JSON shape, fixing them.`,
      });
      continue;
    }
    await finish(outcome);
    return { kind: "failed", outcome, message: messageForFailure(outcome) };
  }
  // Not reached: the loop returns on its last pass.
  await finish("provider_error");
  return { kind: "failed", outcome: "provider_error", message: messageForFailure("provider_error") };
}

/** The HTTP answer a route gives for a result that is not "ok". */
export function aiRefusalStatus(result: Exclude<AiRunResult<unknown>, { kind: "ok" }>): number {
  if (result.kind === "unavailable") return result.reason === "not-configured" ? 503 : 403;
  if (result.kind === "limited") return 429;
  return result.outcome === "rate_limited" ? 429 : 502;
}
