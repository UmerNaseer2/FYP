// The Claude adapter (lib/ai/anthropic.ts). The SDK client is a stand-in that
// records what it was sent and answers from the test, so nothing here reaches
// Anthropic, and the key is a made-up string.

import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from "@anthropic-ai/sdk";
import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicProvider, type ClaudeClient } from "@/lib/ai/anthropic";
import type { AiConfig } from "@/lib/ai/config";
import type { AiToolCall, GenerateRequest } from "@/lib/ai/provider";

const FAKE_KEY = "fake-test-key-not-real-0000";

const CONFIG: AiConfig = {
  provider: "anthropic",
  source: "organization",
  baseUrl: "https://api.anthropic.com",
  apiKey: FAKE_KEY,
  models: { fast: "claude-haiku-5-5", smart: "claude-sonnet-5-5" },
  reasoningEffort: "low",
  timeoutMs: 90_000,
  dailyLimit: 300,
  perMinuteLimit: 10,
};

const REQUEST: GenerateRequest = {
  model: "claude-sonnet-5-5",
  system: "Be brief.",
  messages: [{ role: "user", content: "Hello" }],
  maxOutputTokens: 500,
};

type Options = Parameters<ClaudeClient["messages"]["create"]>[1];
type Sent = { body: Anthropic.MessageCreateParamsNonStreaming; options: Options };

/** An answer from Claude with these blocks. */
function message(content: unknown[], extra: Record<string, unknown> = {}): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 30 },
    ...extra,
  } as unknown as Anthropic.Message;
}

type Reply = Anthropic.Message | Error | ((options: Options) => Promise<Anthropic.Message>);

/** An adapter whose stand-in client answers with these replies, in order. */
function claude(replies: Reply[], config: AiConfig = CONFIG) {
  const sent: Sent[] = [];
  const client: ClaudeClient = {
    messages: {
      create: async (body, options) => {
        sent.push({ body, options });
        const reply = replies.shift();
        if (reply === undefined) throw new Error("no answer queued");
        if (reply instanceof Error) throw reply;
        if (typeof reply === "function") return reply(options);
        return reply;
      },
    },
  };
  return { provider: new AnthropicProvider(config, client), sent };
}

/** The error the SDK throws for a refusal with this status. */
function refusal(status: number, headers: Record<string, string> = {}) {
  return new APIError(
    status,
    { type: "error", error: { type: "api_error", message: `refused with ${status}` } },
    undefined,
    new Headers(headers)
  );
}

describe("the request Claude is sent", () => {
  test("the instructions go in system, with room to think and the effort", async () => {
    const { provider, sent } = claude([message([{ type: "text", text: "Hi" }])]);
    const result = await provider.generate(REQUEST);

    expect(sent).toHaveLength(1);
    const { body, options } = sent[0];
    expect(body.model).toBe("claude-sonnet-5-5");
    expect(body.system).toBe("Be brief.");
    expect(body.messages).toEqual([{ role: "user", content: "Hello" }]);
    expect(body.max_tokens).toBe(500 + 4_000);
    expect(body.output_config).toEqual({ effort: "low" });
    expect(body.tools).toBeUndefined();
    // run.ts decides when to try again, never the SDK.
    expect(options).toMatchObject({ maxRetries: 0, timeout: 90_000 });

    expect(result).toMatchObject({
      text: "Hi",
      toolCalls: [],
      usage: { inputTokens: 120, outputTokens: 40, cachedTokens: 30, estimated: false },
      finishReason: "end_turn",
      model: "claude-sonnet-5-5",
    });
  });

  test("an effort Claude does not know is left out", async () => {
    const { provider, sent } = claude([message([{ type: "text", text: "Hi" }])], { ...CONFIG, reasoningEffort: null });
    await provider.generate(REQUEST);
    expect(sent[0].body.output_config).toBeUndefined();
  });

  test("a JSON answer is asked for with output_config.format, and code fences come off", async () => {
    const { provider, sent } = claude([message([{ type: "text", text: '```json\n{"ok":true}\n```' }])]);
    const result = await provider.generate({
      ...REQUEST,
      jsonSchema: {
        name: "answer",
        schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
      },
    });
    const format = sent[0].body.output_config?.format;
    expect(format).toMatchObject({ type: "json_schema", schema: { type: "object" } });
    expect(sent[0].body.output_config?.effort).toBe("low");
    expect(result.text).toBe('{"ok":true}');
  });

  test("tools are sent with an object input schema", async () => {
    const { provider, sent } = claude([message([{ type: "text", text: "No tools needed." }])]);
    await provider.generate({
      ...REQUEST,
      tools: [
        {
          name: "list_tables",
          description: "List the tables.",
          parameters: { type: "object", properties: { schema: { type: "string" } }, required: ["schema"] },
        },
      ],
    });
    expect(sent[0].body.tools).toEqual([
      {
        name: "list_tables",
        description: "List the tables.",
        input_schema: { type: "object", properties: { schema: { type: "string" } }, required: ["schema"] },
      },
    ]);
  });
});

describe("tool calls and the follow-up", () => {
  const ANSWER = [
    { type: "thinking", thinking: "Look at both tables.", signature: "sig-1" },
    { type: "tool_use", id: "toolu_1", name: "describe_table", input: { table: "books" } },
    { type: "tool_use", id: "toolu_2", name: "describe_table", input: { table: "authors" } },
  ];

  async function firstTurn() {
    const fake = claude([message(ANSWER, { stop_reason: "tool_use" }), message([{ type: "text", text: "Done." }])]);
    const result = await fake.provider.generate(REQUEST);
    return { ...fake, result };
  }

  test("each tool call comes back with its arguments as JSON, the whole answer on the first", async () => {
    const { result } = await firstTurn();
    expect(result.finishReason).toBe("tool_use");
    expect(result.toolCalls.map((c) => [c.id, c.name, c.arguments])).toEqual([
      ["toolu_1", "describe_table", '{"table":"books"}'],
      ["toolu_2", "describe_table", '{"table":"authors"}'],
    ]);
    expect(result.toolCalls[0].extra).toEqual({ anthropicContent: ANSWER });
    expect(result.toolCalls[1].extra).toBeUndefined();
  });

  test("the follow-up sends the answer back as it came, and both results in one message", async () => {
    const { provider, sent, result } = await firstTurn();
    await provider.generate({
      ...REQUEST,
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "", toolCalls: result.toolCalls },
        { role: "tool", toolCallId: "toolu_1", name: "describe_table", content: "books: id, title" },
        { role: "tool", toolCallId: "toolu_2", name: "describe_table", content: "authors: id, name" },
        { role: "user", content: "And now?" },
      ],
    });
    expect(sent[1].body.messages).toEqual([
      { role: "user", content: "Hello" },
      // The thinking block too: Claude refuses a follow-up that changed it.
      { role: "assistant", content: ANSWER },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "books: id, title" },
          { type: "tool_result", tool_use_id: "toolu_2", content: "authors: id, name" },
        ],
      },
      { role: "user", content: "And now?" },
    ]);
  });

  test("a tool call this adapter did not make is rebuilt from its parts", async () => {
    const { provider, sent } = claude([message([{ type: "text", text: "Done." }])]);
    const calls: AiToolCall[] = [
      { id: "call_1", name: "describe_table", arguments: '{"table":"books"}' },
      { id: "call_2", name: "describe_table", arguments: "not json" },
    ];
    await provider.generate({
      ...REQUEST,
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Looking.", toolCalls: calls },
        { role: "assistant", content: "Plain words." },
      ],
    });
    expect(sent[0].body.messages.slice(1)).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Looking." },
          { type: "tool_use", id: "call_1", name: "describe_table", input: { table: "books" } },
          { type: "tool_use", id: "call_2", name: "describe_table", input: {} },
        ],
      },
      { role: "assistant", content: "Plain words." },
    ]);
  });
});

describe("when Claude does not answer", () => {
  test.each([
    [429, "rate_limited"],
    [401, "rejected"],
    [403, "rejected"],
    [404, "rejected"],
    [408, "timeout"],
    [500, "overloaded"],
    [529, "overloaded"],
  ])("a %i is %s", async (status, kind) => {
    const { provider } = claude([refusal(status)]);
    const failure = await provider.generate(REQUEST).catch((e: unknown) => e);
    expect(failure).toMatchObject({ kind, status });
    // The key never goes in a message that could reach a log or a screen.
    expect(String((failure as Error).message)).not.toContain(FAKE_KEY);
  });

  test("a 429 keeps the wait the service asked for", async () => {
    const { provider } = claude([refusal(429, { "retry-after": "30" })]);
    await expect(provider.generate(REQUEST)).rejects.toMatchObject({ kind: "rate_limited", retryAfterMs: 30_000 });
  });

  test("no connection is a busy service, so the other model may answer", async () => {
    const { provider } = claude([new APIConnectionError({ message: "fetch failed" })]);
    await expect(provider.generate(REQUEST)).rejects.toMatchObject({
      kind: "overloaded",
      message: "Could not reach the AI service: fetch failed",
    });
  });

  test("the SDK's own timeout is a timeout", async () => {
    const { provider } = claude([new APIConnectionTimeoutError()]);
    await expect(provider.generate(REQUEST)).rejects.toMatchObject({
      kind: "timeout",
      message: "No answer within 90 seconds.",
    });
  });

  test("an error the adapter does not know is a busy service", async () => {
    const { provider } = claude([new TypeError("something odd")]);
    await expect(provider.generate(REQUEST)).rejects.toMatchObject({ kind: "overloaded" });
  });

  test("Claude declining to answer is a refusal that asking again will not fix", async () => {
    const { provider } = claude([message([], { stop_reason: "refusal" })]);
    await expect(provider.generate(REQUEST)).rejects.toMatchObject({
      kind: "rejected",
      message: "The AI declined to answer this request.",
    });
  });

  test("an answer of the wrong shape is a busy service", async () => {
    const { provider } = claude([{ id: "x" } as unknown as Anthropic.Message]);
    await expect(provider.generate(REQUEST)).rejects.toMatchObject({ kind: "overloaded" });
  });

  test("no usage in the answer gives estimates", async () => {
    const { provider } = claude([message([{ type: "text", text: "Hi" }], { usage: undefined })]);
    const result = await provider.generate(REQUEST);
    expect(result.usage.estimated).toBe(true);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
  });
});

describe("the adapter stops when the caller gives up", () => {
  test("a request already cancelled is never sent", async () => {
    const stop = new AbortController();
    stop.abort();
    const { provider, sent } = claude([message([{ type: "text", text: "Hi" }])]);
    await expect(provider.generate({ ...REQUEST, signal: stop.signal })).rejects.toMatchObject({
      kind: "timeout",
      message: "The request was cancelled.",
    });
    expect(sent).toHaveLength(0);
  });

  test("a request cancelled while it waits fails as a timeout that says so", async () => {
    const stop = new AbortController();
    const waiting = (options: Options) =>
      new Promise<Anthropic.Message>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new APIUserAbortError()));
        setTimeout(() => stop.abort(), 5);
      });
    const { provider } = claude([waiting]);
    await expect(provider.generate({ ...REQUEST, signal: stop.signal })).rejects.toMatchObject({
      kind: "timeout",
      message: "The request was cancelled.",
    });
  });
});
