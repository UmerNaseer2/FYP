// ---------------------------------------------------------------------------
// lib/ai/anthropic.ts
// The adapter for Anthropic's Claude, used when an organization saves its own
// Claude key in Admin, AI (lib/ai/org-key.ts). It speaks the same AiProvider
// as openai-compatible.ts, so run.ts and chat.ts do not know which is which.
//
// It uses Anthropic's own SDK (@anthropic-ai/sdk). The ways Claude differs from
// the OpenAI-style services, smoothed over here:
//   - The fixed instructions go in `system`, not in the first message.
//   - A tool's answer is a tool_result block inside a user message, and the
//     answers to one turn's tool calls must all go in that one message.
//   - The model thinks before it answers. Its thinking comes back as blocks in
//     the answer, and a follow-up after a tool call must send those blocks back
//     exactly as they came. So the first tool call carries the whole answer in
//     `extra`, and toWire sends it back unread.
//   - A JSON answer is asked for with output_config.format, and how hard the
//     model thinks with output_config.effort.
//   - The SDK's own retries are off: run.ts decides when to try again.
// ---------------------------------------------------------------------------

import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "@anthropic-ai/sdk";
import { transformJSONSchema } from "@anthropic-ai/sdk/lib/transform-json-schema";
import type { AiConfig } from "./config";
import { stripFences, retryAfterFrom } from "./openai-compatible";
import {
  AiError,
  estimateTokens,
  type AiMessage,
  type AiProvider,
  type AiToolCall,
  type GenerateRequest,
  type GenerateResult,
} from "./provider";

type WireMessage = Anthropic.MessageParam;
type WireBlock = Anthropic.ContentBlockParam;

/**
 * Room for the model's thinking on top of the answer itself. Claude counts its
 * thinking against max_tokens, and an answer cut short is an answer lost.
 */
const THINKING_ROOM = 4_000;

/** The effort levels Claude knows. Anything else is left out, and Claude uses its own default. */
const CLAUDE_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

/** The key in AiToolCall.extra that holds Claude's whole answer, thinking included. */
const REPLAY_KEY = "anthropicContent";

/** The tool's arguments, which the model sent as a JSON string, back as an object. */
function inputOf(argumentsJson: string): unknown {
  try {
    const parsed = JSON.parse(argumentsJson) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** One assistant turn, as Claude wants it back. */
function assistantBlocks(message: Extract<AiMessage, { role: "assistant" }>): WireBlock[] | string {
  const calls = message.toolCalls ?? [];
  // The answer exactly as Claude sent it, thinking and all, when this adapter made it.
  const replay = calls[0]?.extra?.[REPLAY_KEY];
  if (Array.isArray(replay) && replay.length > 0) return replay as WireBlock[];
  if (calls.length === 0) return message.content;
  const blocks: WireBlock[] = [];
  if (message.content) blocks.push({ type: "text", text: message.content });
  for (const call of calls) {
    blocks.push({ type: "tool_use", id: call.id, name: call.name, input: inputOf(call.arguments) });
  }
  return blocks;
}

function toWire(messages: readonly AiMessage[]): WireMessage[] {
  const wire: WireMessage[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      wire.push({ role: "user", content: message.content });
    } else if (message.role === "assistant") {
      wire.push({ role: "assistant", content: assistantBlocks(message) });
    } else {
      const result: WireBlock = { type: "tool_result", tool_use_id: message.toolCallId, content: message.content };
      // The answers to one turn's tool calls share one user message.
      const last = wire[wire.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content) && last.content.every((b) => b.type === "tool_result")) {
        last.content.push(result);
      } else {
        wire.push({ role: "user", content: [result] });
      }
    }
  }
  return wire;
}

/** The status code, sorted the way run.ts reacts to it (the same as the OpenAI-style adapter). */
function kindOf(status: number): AiError["kind"] {
  if (status === 429) return "rate_limited";
  if (status === 408) return "timeout";
  if (status >= 500) return "overloaded";
  return "rejected";
}

/**
 * The SDK's error, as an AiError. Only the service's own short words go in the
 * message: never the request, which holds the prompt, nor the headers, which
 * hold the key.
 */
function aiErrorOf(error: unknown, stopped: () => AiError, aborted: boolean): AiError {
  if (error instanceof AiError) return error;
  if (aborted || error instanceof APIUserAbortError) return stopped();
  if (error instanceof APIConnectionTimeoutError) return stopped();
  if (error instanceof APIConnectionError) {
    return new AiError("overloaded", `Could not reach the AI service: ${error.message.slice(0, 200)}`);
  }
  if (error instanceof APIError && typeof error.status === "number") {
    const reason = (error.apiMessage ?? error.message ?? "").slice(0, 300);
    const header = error.headers?.get("retry-after") ?? null;
    return new AiError(kindOf(error.status), reason, error.status, retryAfterFrom(header, reason));
  }
  return new AiError("overloaded", "The AI service sent an answer the app could not read.");
}

/** The part of the SDK client this adapter uses, so tests can hand in a stand-in. */
export type ClaudeClient = {
  messages: {
    create(
      body: Anthropic.MessageCreateParamsNonStreaming,
      options?: { signal?: AbortSignal; timeout?: number; maxRetries?: number }
    ): Promise<Anthropic.Message>;
  };
};

export class AnthropicProvider implements AiProvider {
  private readonly client: ClaudeClient;

  constructor(
    private readonly config: AiConfig,
    client?: ClaudeClient
  ) {
    this.client = client ?? new Anthropic({ apiKey: config.apiKey, maxRetries: 0 });
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const body: Anthropic.MessageCreateParamsNonStreaming = {
      model: request.model,
      system: request.system,
      messages: toWire(request.messages),
      max_tokens: request.maxOutputTokens + THINKING_ROOM,
    };
    const outputConfig: Anthropic.OutputConfig = {};
    const effort = this.config.reasoningEffort;
    if (effort && CLAUDE_EFFORTS.has(effort)) outputConfig.effort = effort as NonNullable<Anthropic.OutputConfig["effort"]>;
    if (request.jsonSchema) {
      outputConfig.format = { type: "json_schema", schema: transformJSONSchema(request.jsonSchema.schema) };
    }
    if (Object.keys(outputConfig).length > 0) body.output_config = outputConfig;
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: { type: "object" as const, ...tool.parameters },
      }));
    }

    // One controller stops the call for either reason: the wait ran out, or
    // the caller gave up (request.signal). The same messages as the other adapter.
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
    let answer: Anthropic.Message;
    try {
      answer = await this.client.messages.create(body, {
        signal: controller.signal,
        timeout: timeoutMs,
        maxRetries: 0,
      });
    } catch (error) {
      throw aiErrorOf(error, stopped, controller.signal.aborted);
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", giveUp);
    }

    if (!answer || !Array.isArray(answer.content)) {
      throw new AiError("overloaded", "The AI service sent an answer of the wrong shape.");
    }
    if (answer.stop_reason === "refusal") {
      // Claude declined to answer. Asking the same model again will not help.
      throw new AiError("rejected", "The AI declined to answer this request.");
    }

    let text = "";
    const toolCalls: AiToolCall[] = [];
    for (const block of answer.content) {
      if (block.type === "text") text += block.text;
      else if (block.type === "tool_use") {
        toolCalls.push({ id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) });
      }
    }
    // The whole answer rides on the first tool call, for toWire to send back.
    if (toolCalls.length > 0) toolCalls[0] = { ...toolCalls[0], extra: { [REPLAY_KEY]: answer.content } };

    const usage = answer.usage;
    const reported = typeof usage?.input_tokens === "number" && typeof usage?.output_tokens === "number";
    const inputText = request.system + request.messages.map((m) => m.content).join("\n");
    return {
      text: request.jsonSchema ? stripFences(text) : text,
      toolCalls,
      usage: {
        inputTokens: reported ? usage.input_tokens : estimateTokens(inputText),
        outputTokens: reported ? usage.output_tokens : estimateTokens(text),
        cachedTokens: usage?.cache_read_input_tokens ?? 0,
        estimated: !reported,
      },
      finishReason: answer.stop_reason ?? "unknown",
      model: typeof answer.model === "string" && answer.model ? answer.model : request.model,
      ms: Date.now() - started,
    };
  }
}
