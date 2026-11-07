// ---------------------------------------------------------------------------
// lib/ai/provider.ts
// What every AI service looks like to the rest of the app.
//
// One call in, one answer out: the text (JSON when a schema was asked for),
// any tool calls, the tokens it used and how long it took. Each service gets an
// adapter that speaks this (openai-compatible.ts today, a Claude one later),
// and the tests use mock.ts. Nothing outside lib/ai calls a provider directly:
// every feature goes through runAiTask in run.ts, which checks the answer.
// ---------------------------------------------------------------------------

/** One turn of the conversation sent to the model. */
export type AiMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: AiToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

/** A read-only tool the model may ask the app to run (schema chat only). */
export type AiToolSpec = {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
};

export type AiToolCall = { id: string; name: string; arguments: string };

export type AiUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** True when the service did not say and the numbers are estimates. */
  estimated: boolean;
};

export type GenerateRequest = {
  model: string;
  /** The fixed instructions. */
  system: string;
  messages: AiMessage[];
  /** Ask for JSON that matches this schema. */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  tools?: AiToolSpec[];
  maxOutputTokens: number;
  /** Overrides the configured wait for this one call. */
  timeoutMs?: number;
};

export type GenerateResult = {
  text: string;
  toolCalls: AiToolCall[];
  usage: AiUsage;
  /** "stop", "length", "tool_calls", or whatever the service said. */
  finishReason: string;
  model: string;
  ms: number;
};

/**
 * Why a call failed, sorted the way the app reacts:
 *
 * - rate_limited: the service's quota is used up; wait, do not retry now.
 * - overloaded: the service is busy (503) or broke (5xx); the fast model may answer.
 * - timeout: no answer in time; the fast model may answer.
 * - rejected: the service refused the request itself (400, 401, 403, 404):
 *   a bad key or a model this key cannot use. Retrying will not help.
 */
export type AiErrorKind = "rate_limited" | "overloaded" | "timeout" | "rejected";

export class AiError extends Error {
  readonly kind: AiErrorKind;
  readonly status: number | null;

  constructor(kind: AiErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = "AiError";
    this.kind = kind;
    this.status = status;
  }
}

export interface AiProvider {
  generate(request: GenerateRequest): Promise<GenerateResult>;
}

/** About four characters a token, the rule of thumb for English and SQL. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
