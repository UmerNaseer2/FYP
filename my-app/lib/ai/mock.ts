// ---------------------------------------------------------------------------
// lib/ai/mock.ts
// A stand-in AI service for Jest. CI never calls a real model.
//
// Hand it answers in order: a string (the text), an object (sent as JSON
// text), a function of the request, an AiError to throw, or a full result.
// It records every request so a test can see exactly what was sent.
// ---------------------------------------------------------------------------

import {
  AiError,
  estimateTokens,
  type AiProvider,
  type GenerateRequest,
  type GenerateResult,
} from "./provider";

export type MockReply =
  | string
  | Record<string, unknown>
  | AiError
  | Partial<GenerateResult>
  | ((
      request: GenerateRequest
    ) =>
      | string
      | Record<string, unknown>
      | Partial<GenerateResult>
      | AiError
      | Promise<string | Record<string, unknown> | Partial<GenerateResult> | AiError>);

function isResult(value: object): value is Partial<GenerateResult> {
  return "text" in value || "toolCalls" in value;
}

export class MockProvider implements AiProvider {
  readonly requests: GenerateRequest[] = [];
  private readonly replies: MockReply[];

  constructor(replies: MockReply[] = []) {
    this.replies = [...replies];
  }

  /** Add more answers to the end of the queue. */
  queue(...replies: MockReply[]): void {
    this.replies.push(...replies);
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    this.requests.push(request);
    // Like the real adapter: a caller that already gave up gets a timeout.
    if (request.signal?.aborted) throw new AiError("timeout", "The request was cancelled.");
    let reply = this.replies.shift();
    if (reply === undefined) throw new Error("MockProvider: no answer queued for this call");
    // A function may be async, so a test can hold an answer back.
    if (typeof reply === "function") reply = await reply(request);
    if (reply instanceof AiError) throw reply;
    const base: GenerateResult = {
      text: "",
      toolCalls: [],
      usage: { inputTokens: estimateTokens(request.system), outputTokens: 10, cachedTokens: 0, estimated: true },
      finishReason: "stop",
      model: request.model,
      ms: 1,
    };
    if (typeof reply === "string") return { ...base, text: reply };
    if (isResult(reply)) return { ...base, ...reply };
    return { ...base, text: JSON.stringify(reply) };
  }
}
