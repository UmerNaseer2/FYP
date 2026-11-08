// ---------------------------------------------------------------------------
// lib/ai/openai-compatible.ts
// The adapter for every service that speaks the OpenAI chat completions API:
// Google Gemini (its /v1beta/openai/ layer), Groq, OpenRouter and Ollama.
//
// Plain fetch, no SDK. Switching between those services is a change to
// AI_BASE_URL and the model names, not to code.
//
// The services differ in small ways this file smooths over:
//   - Gemini wants max_tokens to leave room for its thinking, and rejects
//     reasoning_effort "none", so the effort comes from the config.
//   - A service may quietly ignore the JSON schema. That is fine: run.ts parses
//     and checks every answer itself, so a stray answer is caught there.
//   - Some put a JSON answer inside ```json fences. stripFences takes them off.
//   - OpenAI's own service (an organization's own OpenAI key, Admin, AI) wants
//     max_completion_tokens, which its thinking models also spend on thinking,
//     and its strict JSON format refuses string length limits. See isOpenAiItself.
// ---------------------------------------------------------------------------

import type { AiConfig } from "./config";
import {
  AiError,
  estimateTokens,
  type AiMessage,
  type AiProvider,
  type AiToolCall,
  type GenerateRequest,
  type GenerateResult,
} from "./provider";

/** True for OpenAI's own service, as opposed to the other OpenAI-style ones. */
export function isOpenAiItself(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === "api.openai.com";
  } catch {
    return false;
  }
}

/**
 * Room for an OpenAI thinking model's thinking on top of the answer itself:
 * OpenAI counts the thinking against max_completion_tokens, and an answer cut
 * short is an answer lost. The same room as the Claude adapter gives.
 */
const OPENAI_THINKING_ROOM = 4_000;

/** The JSON Schema keywords OpenAI's strict format refuses. The app checks them itself (run.ts readAnswer). */
const OPENAI_UNSENT = new Set(["minLength", "maxLength"]);

function withoutOpenAiUnsent(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutOpenAiUnsent);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (OPENAI_UNSENT.has(key)) continue;
    // Under "properties" the keys are field names, never keywords.
    out[key] =
      key === "properties" && value !== null && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).map(([field, sub]) => [field, withoutOpenAiUnsent(sub)]))
        : withoutOpenAiUnsent(value);
  }
  return out;
}

type WireMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
        extra_content?: Record<string, unknown>;
      }>;
    }
  | { role: "tool"; tool_call_id: string; name: string; content: string };

function toWire(system: string, messages: readonly AiMessage[]): WireMessage[] {
  const wire: WireMessage[] = [{ role: "system", content: system }];
  for (const message of messages) {
    if (message.role === "user") wire.push({ role: "user", content: message.content });
    else if (message.role === "assistant") {
      wire.push({
        role: "assistant",
        content: message.content || null,
        ...(message.toolCalls && message.toolCalls.length > 0
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function" as const,
                function: { name: call.name, arguments: call.arguments },
                ...(call.extra ? { extra_content: call.extra } : {}),
              })),
            }
          : {}),
      });
    } else {
      wire.push({ role: "tool", tool_call_id: message.toolCallId, name: message.name, content: message.content });
    }
  }
  return wire;
}

/** ```json ... ``` around an answer, which some models add even when asked not to. */
export function stripFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

/** The status code, sorted the way run.ts reacts to it. */
function kindOf(status: number): AiError["kind"] {
  if (status === 429) return "rate_limited";
  if (status === 408) return "timeout";
  if (status >= 500) return "overloaded";
  return "rejected";
}

/**
 * The service's own words for a refusal, kept short, and the wait it asked
 * for, when it named one. Never the request: the request holds the prompt,
 * and the headers hold the key.
 */
async function refusalFrom(response: Response): Promise<{ reason: string; retryAfterMs: number | null }> {
  let text = "";
  try {
    text = await response.text();
  } catch {
    return { reason: "", retryAfterMs: retryAfterFrom(response.headers.get("retry-after"), "") };
  }
  let reason = text.slice(0, 300);
  try {
    const parsed = JSON.parse(text) as unknown;
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    const message = (first as { error?: { message?: unknown } } | null)?.error?.message;
    if (typeof message === "string") reason = message.slice(0, 300);
  } catch {
    // Not JSON: the text itself is the reason.
  }
  return { reason, retryAfterMs: retryAfterFrom(response.headers.get("retry-after"), text) };
}

/**
 * The wait a refusal asked for: a Retry-After header in seconds, or the
 * "retry in 23.4s" and "retryDelay": "23s" that Gemini writes in its body.
 */
export function retryAfterFrom(header: string | null, body: string): number | null {
  const seconds = (value: string | undefined) => {
    const n = Number(value);
    return value !== undefined && Number.isFinite(n) && n >= 0 ? Math.ceil(n * 1000) : null;
  };
  if (header && /^\s*\d+(\.\d+)?\s*$/.test(header)) return seconds(header.trim());
  return (
    seconds(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body)?.[1]) ??
    seconds(/retry in (\d+(?:\.\d+)?)\s*s/i.exec(body)?.[1])
  );
}

/** A plain object (not null, not a list), for reading an answer whose shape is not trusted. */
function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * The text of an answer. Most services send a string; some send a list of
 * parts ({ type: "text", text }). Anything else counts as no text.
 */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const text = objectOf(part)?.text;
      return typeof text === "string" ? text : "";
    })
    .join("");
}

const WRONG_SHAPE = "The AI service sent an answer of the wrong shape.";

/**
 * The service's answer, read without trusting its shape. A proxy or a
 * service having a bad day can send a 200 with anything in it; that must end
 * as a clean "could not answer" (and a usage row), never as a TypeError.
 */
function readWireAnswer(data: unknown): {
  text: string;
  toolCalls: AiToolCall[];
  finishReason: string;
  model: string | null;
  promptTokens: number | undefined;
  completionTokens: number | undefined;
  cachedTokens: number | undefined;
} {
  const body = objectOf(data);
  if (!body) throw new AiError("overloaded", WRONG_SHAPE);
  const choices = body.choices;
  const choice = Array.isArray(choices) ? objectOf(choices[0]) : null;
  if (!choice) {
    // Some services answer 200 with an error inside instead of a 4xx or 5xx.
    const said = objectOf(body.error)?.message;
    throw new AiError("overloaded", typeof said === "string" && said ? said.slice(0, 300) : WRONG_SHAPE);
  }
  const message = objectOf(choice.message);
  const rawCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  const toolCalls: AiToolCall[] = [];
  rawCalls.forEach((raw, index) => {
    const call = objectOf(raw);
    const fn = objectOf(call?.function);
    if (!call || !fn || typeof fn.name !== "string" || !fn.name) return;
    const extra = objectOf(call.extra_content);
    toolCalls.push({
      id: typeof call.id === "string" && call.id ? call.id : `call_${index}`,
      name: fn.name,
      arguments: typeof fn.arguments === "string" ? fn.arguments : "{}",
      ...(extra ? { extra } : {}),
    });
  });
  const usage = objectOf(body.usage);
  return {
    text: textOf(message?.content),
    toolCalls,
    finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : "unknown",
    model: typeof body.model === "string" && body.model ? body.model : null,
    promptTokens: numberOf(usage?.prompt_tokens),
    completionTokens: numberOf(usage?.completion_tokens),
    cachedTokens: numberOf(objectOf(usage?.prompt_tokens_details)?.cached_tokens),
  };
}

export class OpenAiCompatibleProvider implements AiProvider {
  constructor(
    private readonly config: AiConfig,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args)
  ) {}

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const openAi = isOpenAiItself(this.config.baseUrl);
    const body: Record<string, unknown> = {
      model: request.model,
      messages: toWire(request.system, request.messages),
    };
    // OpenAI's thinking models refuse max_tokens; the other services want it.
    if (openAi) body.max_completion_tokens = request.maxOutputTokens + OPENAI_THINKING_ROOM;
    else body.max_tokens = request.maxOutputTokens;
    if (this.config.reasoningEffort) body.reasoning_effort = this.config.reasoningEffort;
    if (request.jsonSchema) {
      const schema = openAi ? withoutOpenAiUnsent(request.jsonSchema.schema) : request.jsonSchema.schema;
      body.response_format = {
        type: "json_schema",
        json_schema: { name: request.jsonSchema.name, strict: true, schema },
      };
    }
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }));
    }

    // One controller stops the call for either reason: the wait ran out, or
    // the caller gave up (request.signal).
    const controller = new AbortController();
    const timeoutMs = request.timeoutMs ?? this.config.timeoutMs;
    const cancelled = () => request.signal?.aborted === true;
    const giveUp = () => controller.abort();
    if (cancelled()) throw new AiError("timeout", "The request was cancelled.");
    request.signal?.addEventListener("abort", giveUp, { once: true });
    const stopped = () =>
      cancelled()
        ? new AiError("timeout", "The request was cancelled.")
        : new AiError("timeout", `No answer within ${Math.round(timeoutMs / 1000)} seconds.`);
    const timer = setTimeout(giveUp, timeoutMs);
    const started = Date.now();
    let data: unknown;
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.config.baseUrl}chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.config.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) throw stopped();
        throw new AiError("overloaded", `Could not reach the AI service: ${(error as Error).message}`);
      }
      try {
        if (!response.ok) {
          const { reason, retryAfterMs } = await refusalFrom(response);
          throw new AiError(kindOf(response.status), reason, response.status, retryAfterMs);
        }
        data = (await response.json()) as unknown;
      } catch (error) {
        if (error instanceof AiError) throw error;
        if (controller.signal.aborted) throw stopped();
        throw new AiError("overloaded", "The AI service sent an answer that was not JSON.");
      }
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", giveUp);
    }

    const answer = readWireAnswer(data);
    const reported = answer.promptTokens !== undefined && answer.completionTokens !== undefined;
    const inputText = request.system + request.messages.map((m) => m.content).join("\n");
    return {
      text: request.jsonSchema ? stripFences(answer.text) : answer.text,
      toolCalls: answer.toolCalls,
      usage: {
        inputTokens: answer.promptTokens ?? estimateTokens(inputText),
        outputTokens: answer.completionTokens ?? estimateTokens(answer.text),
        cachedTokens: answer.cachedTokens ?? 0,
        estimated: !reported,
      },
      finishReason: answer.finishReason,
      model: answer.model || request.model,
      ms: Date.now() - started,
    };
  }
}
