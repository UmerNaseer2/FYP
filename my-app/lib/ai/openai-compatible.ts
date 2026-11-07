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

type WireMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
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
 * The service's own words for a refusal, kept short. Never the request: the
 * request holds the prompt, and the headers hold the key.
 */
async function reasonFrom(response: Response): Promise<string> {
  try {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text) as unknown;
      const first = Array.isArray(parsed) ? parsed[0] : parsed;
      const message = (first as { error?: { message?: unknown } } | null)?.error?.message;
      if (typeof message === "string") return message.slice(0, 300);
    } catch {
      // Not JSON: fall through to the text itself.
    }
    return text.slice(0, 300);
  } catch {
    return "";
  }
}

type WireResponse = {
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
};

export class OpenAiCompatibleProvider implements AiProvider {
  constructor(
    private readonly config: AiConfig,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args)
  ) {}

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: toWire(request.system, request.messages),
      max_tokens: request.maxOutputTokens,
    };
    if (this.config.reasoningEffort) body.reasoning_effort = this.config.reasoningEffort;
    if (request.jsonSchema) {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: request.jsonSchema.name, strict: true, schema: request.jsonSchema.schema },
      };
    }
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }));
    }

    const controller = new AbortController();
    const timeoutMs = request.timeoutMs ?? this.config.timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl}chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.config.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (controller.signal.aborted) {
        throw new AiError("timeout", `No answer within ${Math.round(timeoutMs / 1000)} seconds.`);
      }
      throw new AiError("overloaded", `Could not reach the AI service: ${(error as Error).message}`);
    }

    let data: WireResponse;
    try {
      if (!response.ok) {
        throw new AiError(kindOf(response.status), await reasonFrom(response), response.status);
      }
      data = (await response.json()) as WireResponse;
    } catch (error) {
      if (error instanceof AiError) throw error;
      if (controller.signal.aborted) {
        throw new AiError("timeout", `No answer within ${Math.round(timeoutMs / 1000)} seconds.`);
      }
      throw new AiError("overloaded", "The AI service sent an answer that was not JSON.");
    } finally {
      clearTimeout(timer);
    }

    const choice = data.choices?.[0];
    const text = choice?.message?.content ?? "";
    const toolCalls: AiToolCall[] = (choice?.message?.tool_calls ?? []).flatMap((call, index) =>
      call.function?.name
        ? [{ id: call.id || `call_${index}`, name: call.function.name, arguments: call.function.arguments ?? "{}" }]
        : []
    );
    const reported = data.usage?.prompt_tokens !== undefined && data.usage?.completion_tokens !== undefined;
    const inputText = request.system + request.messages.map((m) => m.content).join("\n");
    return {
      text: request.jsonSchema ? stripFences(text) : text,
      toolCalls,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? estimateTokens(inputText),
        outputTokens: data.usage?.completion_tokens ?? estimateTokens(text),
        cachedTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
        estimated: !reported,
      },
      finishReason: choice?.finish_reason ?? "unknown",
      model: data.model || request.model,
      ms: Date.now() - started,
    };
  }
}
