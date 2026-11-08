// SERVER-ONLY: import this file from API routes and other server code only.
//
// The one way an AI feature asks the model anything. Every feature calls
// runAiTask, so every answer goes through the same steps:
//
//   1. Is AI set up on this server, switched on for the organization, and is
//      this feature on? (The route has already checked the person may use it.)
//   2. Is a checked answer to the same question, from the same model, saved?
//      Then that is the answer (unless the person pressed Ask again).
//   3. Before every request to the service: are the organization's daily
//      limit and the person's per-minute limit still clear? The request is
//      counted (a usage row is reserved) in the same step, so calls still in
//      flight count too.
//   4. Ask the model for JSON of a fixed shape. If the smart model times out
//      or is busy, the fast one is asked instead, and a model that failed is
//      not asked again in the same task.
//   5. Read the JSON against the shape (zod), then run the feature's own code
//      checks (names exist, grade locked, SQL guards). One retry (or the
//      feature's own count), with the problems spelled out, when either fails.
//   6. Every request ends with its usage row filled in, and a good answer
//      from the first-choice model is saved for reuse.
//
// The whole task has a deadline (TASK_DEADLINE_MS), and the caller can stop it
// with spec.signal.
//
// The model never decides anything here. A feature's `check` is where the
// engine's facts overrule it.
import { z } from "zod";
import { readAiConfig, serviceName, type AiConfig, type AiTier } from "./config";
import {
  AiError,
  type AiMessage,
  type AiProvider,
  type AiUsage,
  type GenerateRequest,
  type GenerateResult,
} from "./provider";
import { OpenAiCompatibleProvider } from "./openai-compatible";
import { PROMPT_VERSIONS, SHARED_RULES, type AiFeature } from "./prompts";
import { featureOn, readOrgAi, type OrgAiSettings } from "./settings";
import * as store from "./store";
import type { AiCallEnd, AiCallStart, AiOutcome } from "./store";

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
  /** The longest one request may take. The configured wait (AI_TIMEOUT_MS) unless said. */
  timeoutMs?: number;
  /**
   * Stops the task when the caller gives up (a route passes request.signal,
   * the drift alert passes its own when its wait is over). The request in
   * flight is cancelled, no other model and no repair is tried, and the task
   * fails as a timeout.
   */
  signal?: AbortSignal;
  /**
   * Ask the model even when a saved answer exists ("Ask again"). A good new
   * answer still replaces the saved one.
   */
  refresh?: boolean;
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
  store: Pick<typeof store, "recordAiCall" | "callsToday" | "callsLastMinute" | "readSavedAnswer" | "saveAnswer"> &
    // Optional, so a test may leave them out. Without them each request is
    // checked with aiLimits and its row is written whole when it ends.
    Partial<Pick<typeof store, "reserveAiCall" | "finishAiCall">>;
  now: () => number;
  /** Waits, for the one pause schema chat takes when the service asks it to. Tests pass their own. */
  sleep?: (ms: number) => Promise<void>;
};

export function defaultAiDeps(): AiDeps {
  const config = readAiConfig();
  return {
    config,
    provider: config ? new OpenAiCompatibleProvider(config) : null,
    readSettings: readOrgAi,
    store,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
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

function dailyLimitMessage(config: AiConfig): string {
  return `Your organization has used its ${config.dailyLimit} AI calls for today. The count starts again at midnight UTC.`;
}

const PER_MINUTE_MESSAGE = "That is a lot of AI questions in one minute. Wait a moment and try again.";

/**
 * The daily and per-minute limits. Null when clear.
 *
 * Only a check: it counts nothing itself, so two requests at the same moment
 * can both pass it. Use startAiCall before each request instead, which
 * checks and counts in one step. This stays for older callers.
 */
export async function aiLimits(
  caller: AiCaller,
  config: AiConfig,
  deps: Pick<AiDeps, "store">
): Promise<string | null> {
  if ((await deps.store.callsToday(caller.orgId)) >= config.dailyLimit) {
    return dailyLimitMessage(config);
  }
  if ((await deps.store.callsLastMinute(caller.orgId, caller.email)) >= config.perMinuteLimit) {
    return PER_MINUTE_MESSAGE;
  }
  return null;
}

/** What startAiCall decided: go ahead (with the reserved row's id), or a limit is reached. */
/** No tokens used: the usage of a call that was never sent, or answered from the saved copy. */
export const ZERO: AiUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, estimated: false };

/** The fields every ai_calls row of one task starts with. Both runners use it. */
export function callBase(caller: AiCaller, feature: AiFeature, config: AiConfig) {
  return {
    orgId: caller.orgId,
    actor: caller.email,
    feature,
    provider: serviceName(config.baseUrl),
    promptVersion: PROMPT_VERSIONS[feature],
  };
}

export type AiCallTicket = { kind: "started"; id: number | null } | { kind: "limited"; message: string };

/**
 * Call this right before each request to the AI service, including a retry
 * and a switch to the other model: each request is one call against the
 * limits. It checks the limits and counts this request in the same step
 * (store.reserveAiCall), so requests still in flight count too.
 *
 * When a limit is reached it writes the "limit_reached" row itself and says
 * so; send nothing then. Otherwise send the request and, when it ends, pass
 * the ticket to endAiCall.
 */
export async function startAiCall(config: AiConfig, deps: Pick<AiDeps, "store">, call: AiCallStart): Promise<AiCallTicket> {
  let message: string | null = null;
  let id: number | null = null;
  if (deps.store.reserveAiCall) {
    const reserved = await deps.store.reserveAiCall(call, {
      dailyLimit: config.dailyLimit,
      perMinuteLimit: config.perMinuteLimit,
    });
    if (reserved.kind === "limited") {
      message = reserved.which === "daily" ? dailyLimitMessage(config) : PER_MINUTE_MESSAGE;
    } else {
      id = reserved.id;
    }
  } else {
    message = await aiLimits({ orgId: call.orgId, email: call.actor }, config, deps);
  }
  if (message !== null) {
    await deps.store.recordAiCall({
      ...call,
      ...ZERO,
      ms: 0,
      retries: 0,
      outcome: "limit_reached",
      cacheHit: false,
    });
    return { kind: "limited", message };
  }
  return { kind: "started", id };
}

/**
 * Call this when a request that startAiCall let through has ended, however it
 * ended (a failed request is a call too). Fills in the reserved row, or writes
 * a whole row when there is none. Returns the row's id, so the person can
 * rate the answer.
 */
export async function endAiCall(
  deps: Pick<AiDeps, "store">,
  ticket: { id: number | null },
  call: AiCallStart,
  end: AiCallEnd
): Promise<number | null> {
  if (ticket.id !== null && deps.store.finishAiCall) {
    await deps.store.finishAiCall(ticket.id, end);
    return ticket.id;
  }
  return deps.store.recordAiCall({ ...call, ...end, cacheHit: false });
}

/**
 * True when the service refused the key itself (401 or 403): no model will
 * answer, so the other one is not tried. Any other refusal (400, 402, 404)
 * may be about this one model, which the key cannot use or which no longer
 * exists, so the other model is still asked.
 */
export function keyRefused(error: AiError): boolean {
  return error.kind === "rejected" && (error.status === 401 || error.status === 403);
}

/** The models to try, best first. */
export function modelsFor(config: AiConfig, tier: AiTier): string[] {
  return tier === "smart" && config.models.smart !== config.models.fast
    ? [config.models.smart, config.models.fast]
    : [config.models[tier]];
}

export function outcomeOf(error: AiError): AiOutcome {
  if (error.kind === "rate_limited") return "rate_limited";
  if (error.kind === "timeout") return "timeout";
  return "provider_error";
}

/** The sooner of two waits a busy service named, when it named any. */
export function soonerWait(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * A free allowance can be used up for a minute or for the rest of the day
 * (Gemini's free tier allows a set number of requests a day for each model),
 * so the message says how long, as far as the service said.
 */
function usedUpMessage(retryAfterMs: number | null): string {
  if (retryAfterMs !== null && retryAfterMs >= HOUR_MS) {
    const hours = Math.round(retryAfterMs / HOUR_MS);
    return `The AI service's free allowance is used up for today. Try again in about ${hours === 1 ? "an hour" : `${hours} hours`}.`;
  }
  if (retryAfterMs !== null && retryAfterMs > 90_000) {
    return `The AI service's free allowance is used up for now. Try again in about ${Math.ceil(retryAfterMs / 60_000)} minutes.`;
  }
  return "The AI service's free allowance is used up for now. Try again in a minute.";
}

export function messageForFailure(outcome: AiOutcome, retryAfterMs: number | null = null): string {
  switch (outcome) {
    case "rate_limited":
      return usedUpMessage(retryAfterMs);
    case "timeout":
      return "The AI service took too long to answer. Try again.";
    case "invalid_output":
    case "failed_check":
      return "The AI's answer did not pass the app's checks, so it is not shown. Try again, or read the engine's own report.";
    default:
      return "The AI service could not answer. Try again later.";
  }
}


export function addUsage(a: AiUsage, b: AiUsage): AiUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    estimated: a.estimated || b.estimated,
  };
}

/**
 * The longest one task may take, all its requests, repairs and checks
 * together. The same budget as schema chat (chat.ts): well inside the 300
 * seconds a Vercel function may run, so the person gets an answer or a clear
 * "took too long" instead of the platform cutting the request off.
 */
export const TASK_DEADLINE_MS = 150_000;

/** With less time than this left, a request is not started. */
const MIN_REQUEST_MS = 2_000;

export async function runAiTask<T>(
  caller: AiCaller,
  spec: AiTaskSpec<T>,
  deps: AiDeps = defaultAiDeps()
): Promise<AiRunResult<T>> {
  const refused = await aiGate(caller, spec.feature, deps);
  if (refused) return refused;
  const config = deps.config!;
  const provider = deps.provider!;
  const base = callBase(caller, spec.feature, config);
  const models = modelsFor(config, spec.tier);

  // The first-choice model and its service are part of the key, so changing
  // either asks the new model. Only a hash of this is stored.
  const key =
    spec.cacheInput === null
      ? null
      : store.cacheKey(spec.feature, base.promptVersion, spec.cacheInput, `${models[0]} at ${config.baseUrl}`);
  if (key && !spec.refresh) {
    const saved = await deps.store.readSavedAnswer<unknown>(caller.orgId, spec.feature, key);
    const read = saved ? spec.schema.safeParse(saved.answer) : null;
    if (saved && read?.success) {
      const callId = await deps.store.recordAiCall({
        ...base,
        model: saved.model,
        ...ZERO,
        ms: 0,
        retries: 0,
        outcome: "ok",
        cacheHit: true,
      });
      return { kind: "ok", value: read.data, callId, model: saved.model, saved: true, ms: 0, retries: 0, usage: ZERO };
    }
  }

  const started = deps.now();
  const deadline = started + TASK_DEADLINE_MS;
  const messages: AiMessage[] = [{ role: "user", content: spec.prompt }];
  let usage = ZERO;
  let retries = 0;
  // Where the next request starts in `models`. A model that failed (timed
  // out, busy, used up) is not asked again in this task, so a repair does
  // not wait on a hung model a second time.
  let modelIndex = 0;
  let waitMs: number | null = null;
  const cancelled = () => spec.signal?.aborted === true;
  const failed = (outcome: AiOutcome): AiRunResult<T> => ({
    kind: "failed",
    outcome,
    message: messageForFailure(outcome, outcome === "rate_limited" ? waitMs : null),
  });

  const repairs = Math.max(0, spec.repairs ?? 1);
  for (let attempt = 0; attempt <= repairs; attempt += 1) {
    let failure: AiOutcome | null = null;
    for (let i = modelIndex; i < models.length; i += 1) {
      const model = models[i];
      const timeLeft = deadline - deps.now();
      if (cancelled() || timeLeft < MIN_REQUEST_MS) {
        failure = "timeout";
        break;
      }
      const call: AiCallStart = { ...base, model };
      const ticket = await startAiCall(config, deps, call);
      if (ticket.kind === "limited") return { kind: "limited", message: ticket.message };
      const requestStarted = deps.now();
      // This request's own row: its tokens, its time, how it ended.
      const end = (outcome: AiOutcome, used: AiUsage = ZERO, answeredBy: string = model) =>
        endAiCall(deps, ticket, call, { model: answeredBy, ...used, ms: deps.now() - requestStarted, retries, outcome });

      const request: GenerateRequest = {
        model,
        system: `${SHARED_RULES}\n\n${spec.system}`,
        messages,
        jsonSchema: { name: spec.feature.replace(/-/g, "_"), schema: jsonSchemaOf(spec.schema) },
        maxOutputTokens: spec.maxOutputTokens,
        timeoutMs: Math.min(spec.timeoutMs ?? config.timeoutMs, timeLeft),
        signal: spec.signal,
      };
      let result: GenerateResult;
      try {
        result = await provider.generate(request);
      } catch (error) {
        if (!(error instanceof AiError)) {
          await end("provider_error");
          throw error;
        }
        failure = outcomeOf(error);
        await end(failure);
        if (error.kind === "rate_limited") waitMs = soonerWait(waitMs, error.retryAfterMs);
        if (keyRefused(error)) break;
        // A used-up allowance is worth trying the other model for: Gemini
        // counts each model's requests apart.
        modelIndex = i + 1;
        continue;
      }

      usage = addUsage(usage, result.usage);
      const answeredBy = result.model || model;
      let problems: string[];
      let value: T | null = null;
      let outcome: AiOutcome = "invalid_output";
      try {
        const read = readAnswer(result.text, spec.schema);
        if ("problems" in read) {
          problems = read.problems;
        } else {
          const checked = spec.check ? await spec.check(read.value) : { value: read.value, problems: [] };
          problems = checked.problems;
          value = checked.value;
          outcome = "failed_check";
        }
      } catch (error) {
        // A check that broke is the app's fault, not the model's: it is not swallowed.
        await end("provider_error", result.usage, answeredBy);
        throw error;
      }

      if (problems.length === 0 && value !== null) {
        const callId = await end("ok", result.usage, answeredBy);
        // Only the first-choice model's answers are saved, so a fallback answer
        // given while the better model was busy is not served for a week.
        if (key && i === 0) await deps.store.saveAnswer(caller.orgId, spec.feature, key, answeredBy, value);
        return { kind: "ok", value, callId, model: answeredBy, saved: false, ms: deps.now() - started, retries, usage };
      }
      await end(outcome, result.usage, answeredBy);
      if (attempt >= repairs) return failed(outcome);
      retries += 1;
      messages.push({ role: "assistant", content: result.text });
      messages.push({
        role: "user",
        content: `Your answer has these problems:\n- ${problems.join("\n- ")}\nAnswer again in the same JSON shape, fixing them.`,
      });
      failure = null;
      break;
    }
    if (failure !== null) return failed(failure);
  }
  // Not reached: every pass returns, or breaks out to a repair it has left.
  return failed("provider_error");
}

/** The HTTP answer a route gives for a result that is not "ok". */
export function aiRefusalStatus(result: Exclude<AiRunResult<unknown>, { kind: "ok" }>): number {
  if (result.kind === "unavailable") return result.reason === "not-configured" ? 503 : 403;
  if (result.kind === "limited") return 429;
  return result.outcome === "rate_limited" ? 429 : 502;
}
