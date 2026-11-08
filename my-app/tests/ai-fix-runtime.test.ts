// Review fixes in the AI runtime that the run tests (ai-run.test.ts) do not
// reach: the adapter reading an answer of the wrong shape and being cancelled,
// the service name never showing an unknown host, the SQL the store sends for
// the limits, the clear-out and the usage card, the rating route refusing an
// id too big for the table, and the usage card's note.
//
// The database is a fake: every statement is recorded and answered from a
// small table of canned replies, so nothing here needs PostgreSQL. The real
// SQL runs in the database suites.

import { NextRequest } from "next/server";
import type { Gate } from "@/lib/auth-guard";
import { principalFor } from "./helpers/principals";

type Sent = { text: string; values: unknown[] };
/** Every statement sent, through the pool or a client, in order. */
let mockSent: Sent[] = [];
/** The answer for a statement: the first pattern that matches its text. */
let mockAnswers: [RegExp, { rows?: unknown[]; rowCount?: number } | Error][] = [];
let mockReleased = 0;

function mockAnswer(text: string, values: unknown[] = []) {
  mockSent.push({ text, values });
  const found = mockAnswers.find(([pattern]) => pattern.test(text));
  if (found && found[1] instanceof Error) return Promise.reject(found[1]);
  const answer = found ? found[1] : {};
  return Promise.resolve({ rows: [], rowCount: 0, ...(answer as object) });
}

jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: {
    query: (text: string, values?: unknown[]) => mockAnswer(text, values),
    connect: async () => ({
      query: (text: string, values?: unknown[]) => mockAnswer(text, values),
      release: () => {
        mockReleased += 1;
      },
    }),
  },
  syncMetadataTables: async () => undefined,
}));

let mockGate: Gate;
jest.mock("../lib/auth-guard", () => ({
  requirePermission: async () => mockGate,
}));

import type { AiConfig } from "@/lib/ai/config";
import { describeAiConfig, OTHER_SERVICE, serviceName } from "@/lib/ai/config";
import { OpenAiCompatibleProvider } from "@/lib/ai/openai-compatible";
import { AiError, type GenerateRequest } from "@/lib/ai/provider";
import { runAiTask, type AiDeps } from "@/lib/ai/run";
import { AI_OFF } from "@/lib/ai/settings";
import {
  AI_CALLS_KEEP_DAYS,
  cacheKey,
  CACHE_DAYS,
  finishAiCall,
  pruneOldAiRows,
  readAiUsage,
  reserveAiCall,
  saveAnswer,
  type AiCallRecord,
} from "@/lib/ai/store";
import { AI_USAGE_NOTE } from "@/lib/ai/views";
import { POST as rate } from "@/app/api/ai/rate/route";
import { z } from "zod";

const CONFIG: AiConfig = {
  provider: "openai-compatible",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
  apiKey: "test-key",
  models: { fast: "fast-model", smart: "smart-model" },
  reasoningEffort: "low",
  timeoutMs: 90_000,
  dailyLimit: 300,
  perMinuteLimit: 10,
};

const REQUEST: GenerateRequest = {
  model: "smart-model",
  system: "Be brief.",
  messages: [{ role: "user", content: "Hello" }],
  maxOutputTokens: 100,
};

const HOUR_MS = 60 * 60 * 1000;

beforeAll(async () => {
  // The clear-out runs at most once an hour. Start that hour now, so the
  // writes below do not run it by chance; the clear-out tests move time on.
  await pruneOldAiRows(Date.now());
});

beforeEach(() => {
  mockSent = [];
  mockAnswers = [];
  mockReleased = 0;
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** An adapter whose service always answers 200 with this body. */
function answering(body: unknown) {
  const fetchImpl = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
  return new OpenAiCompatibleProvider(CONFIG, fetchImpl);
}

describe("the adapter reads an answer of the wrong shape without breaking", () => {
  test.each([
    ["null", null],
    ["a list", []],
    ["no choices", { choices: null }],
    ["an empty choices list", { choices: [] }],
    ["a choice that is not an object", { choices: ["hi"] }],
  ])("%s is the service failing, not a TypeError", async (_name, body) => {
    const failure = await answering(body).generate(REQUEST).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AiError);
    expect(failure).toMatchObject({ kind: "overloaded", message: "The AI service sent an answer of the wrong shape." });
  });

  test("a 200 with an error inside says what the service said", async () => {
    const failure = await answering({ error: { message: "Model is loading" } }).generate(REQUEST).catch((e: unknown) => e);
    expect(failure).toMatchObject({ kind: "overloaded", message: "Model is loading" });
  });

  test("text sent as a list of parts is joined, and odd usage numbers are estimated instead", async () => {
    const result = await answering({
      choices: [{ message: { content: [{ type: "text", text: "Hel" }, { type: "image" }, { text: "lo" }] } }],
      usage: { prompt_tokens: "12", completion_tokens: -1 },
    }).generate(REQUEST);
    expect(result.text).toBe("Hello");
    expect(result.usage.estimated).toBe(true);
    expect(result.finishReason).toBe("unknown");
    expect(result.model).toBe("smart-model");
  });

  test("tool calls without a name are left out, and missing parts get safe values", async () => {
    const result = await answering({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: null,
            tool_calls: [
              null,
              { function: { name: 5 } },
              { function: { name: "list_tables", arguments: { not: "a string" } } },
              { id: "c9", function: { name: "describe_table", arguments: '{"table":"books"}' }, extra_content: "x" },
            ],
          },
        },
      ],
    }).generate(REQUEST);
    expect(result.text).toBe("");
    expect(result.toolCalls).toEqual([
      { id: "call_2", name: "list_tables", arguments: "{}" },
      { id: "c9", name: "describe_table", arguments: '{"table":"books"}' },
    ]);
  });

  test("through runAiTask, the wrong shape is a clean failure with a usage row for each model", async () => {
    const calls: AiCallRecord[] = [];
    const deps: AiDeps = {
      config: CONFIG,
      provider: answering({ choices: null }),
      readSettings: async () => ({ ...AI_OFF, enabled: true, features: { ...AI_OFF.features } }),
      store: {
        recordAiCall: async (record) => {
          calls.push(record);
          return calls.length;
        },
        callsToday: async () => 0,
        callsLastMinute: async () => 0,
        readSavedAnswer: (async () => null) as AiDeps["store"]["readSavedAnswer"],
        saveAnswer: async () => undefined,
      },
      now: () => Date.now(),
    };
    const result = await runAiTask(
      { orgId: 4, email: "ada@example.com" },
      {
        feature: "compare-summary",
        tier: "smart",
        system: "Summarise.",
        prompt: "TABLE books",
        schema: z.object({ summary: z.string() }),
        cacheInput: null,
        maxOutputTokens: 100,
      },
      deps
    );
    expect(result).toMatchObject({ kind: "failed", outcome: "provider_error" });
    expect(calls.map((c) => [c.model, c.outcome])).toEqual([
      ["smart-model", "provider_error"],
      ["fast-model", "provider_error"],
    ]);
  });
});

describe("the adapter stops when the caller gives up", () => {
  test("a request cancelled while it waits fails as a timeout that says so", async () => {
    const stop = new AbortController();
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        setTimeout(() => stop.abort(), 5);
      })) as unknown as typeof fetch;
    const provider = new OpenAiCompatibleProvider(CONFIG, fetchImpl);
    const failure = await provider.generate({ ...REQUEST, signal: stop.signal }).catch((e: unknown) => e);
    expect(failure).toMatchObject({ kind: "timeout", message: "The request was cancelled." });
  });

  test("a request already cancelled is never sent", async () => {
    const stop = new AbortController();
    stop.abort();
    const fetchImpl = jest.fn(async () => new Response("{}")) as unknown as typeof fetch;
    const provider = new OpenAiCompatibleProvider(CONFIG, fetchImpl);
    await expect(provider.generate({ ...REQUEST, signal: stop.signal })).rejects.toMatchObject({ kind: "timeout" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("the service's name never shows an unknown host", () => {
  test.each([
    "http://ai.corp.internal:8000/v1/",
    "http://10.0.4.17:11434/v1/",
    "https://my-vllm.example.org/v1/",
    "not a url",
  ])("%s is shown as the server's AI service", (baseUrl) => {
    expect(serviceName(baseUrl)).toBe(OTHER_SERVICE);
    const setup = describeAiConfig({ ...CONFIG, baseUrl });
    expect(setup.service).toBe(OTHER_SERVICE);
    expect(JSON.stringify(setup)).not.toMatch(/corp\.internal|10\.0\.4\.17|my-vllm/);
  });

  test.each([
    ["https://generativelanguage.googleapis.com/v1beta/openai/", "Google Gemini"],
    ["https://api.groq.com/openai/v1/", "Groq"],
    ["https://openrouter.ai/api/v1/", "OpenRouter"],
    ["https://api.openai.com/v1/", "OpenAI"],
    ["http://localhost:11434/v1/", "Ollama (this computer)"],
    ["http://127.0.0.1:11434/v1/", "Ollama (this computer)"],
    ["http://[::1]:11434/v1/", "Ollama (this computer)"],
  ])("%s is %s", (baseUrl, name) => {
    expect(serviceName(baseUrl)).toBe(name);
  });
});

const START = {
  orgId: 4,
  actor: "ada@example.com",
  feature: "compare-summary" as const,
  provider: "Google Gemini",
  model: "smart-model",
  promptVersion: 1,
};
const LIMITS = { dailyLimit: 300, perMinuteLimit: 10 };

describe("store: reserving a call under the limits", () => {
  test("locks the organization, counts, then writes the row, all in one transaction", async () => {
    mockAnswers = [
      [/count\(\*\)/, { rows: [{ today: 3, last_minute: 1 }] }],
      [/INSERT INTO ai_calls/, { rows: [{ id: 77 }] }],
    ];
    await expect(reserveAiCall(START, LIMITS)).resolves.toEqual({ kind: "reserved", id: 77 });
    const texts = mockSent.map((s) => s.text);
    expect(texts[0]).toBe("BEGIN");
    expect(texts[1]).toMatch(/SET LOCAL lock_timeout/);
    expect(texts[2]).toMatch(/pg_advisory_xact_lock\(hashtext\('ai_calls'\), \$1::int\)/);
    expect(mockSent[2].values).toEqual([4]);
    expect(texts[3]).toMatch(/count\(\*\)/);
    expect(texts[3]).toMatch(/outcome <> 'limit_reached'/);
    expect(mockSent[3].values).toEqual([4, "ada@example.com"]);
    expect(texts[4]).toMatch(/INSERT INTO ai_calls/);
    expect(texts[5]).toBe("COMMIT");
    expect(mockReleased).toBe(1);
  });

  test.each([
    [{ today: 300, last_minute: 0 }, "daily"],
    [{ today: 12, last_minute: 10 }, "per-minute"],
  ])("a count of %o is the %s limit: rolled back, nothing written", async (counts, which) => {
    mockAnswers = [[/count\(\*\)/, { rows: [counts] }]];
    await expect(reserveAiCall(START, LIMITS)).resolves.toEqual({ kind: "limited", which });
    const texts = mockSent.map((s) => s.text);
    expect(texts).toContain("ROLLBACK");
    expect(texts.some((t) => /INSERT/.test(t))).toBe(false);
    expect(mockReleased).toBe(1);
  });

  test("a database that cannot count throws, so the call is not let through", async () => {
    mockAnswers = [[/pg_advisory_xact_lock/, new Error("lock timeout")]];
    await expect(reserveAiCall(START, LIMITS)).rejects.toThrow("lock timeout");
    expect(mockSent.map((s) => s.text)).toContain("ROLLBACK");
    expect(mockReleased).toBe(1);
  });

  test("finishing fills in the reserved row", async () => {
    mockAnswers = [[/UPDATE ai_calls/, { rowCount: 1 }]];
    const end = {
      model: "fast-model",
      inputTokens: 10.4,
      outputTokens: 20,
      cachedTokens: 0,
      estimated: true,
      ms: 812.6,
      retries: 1,
      outcome: "ok" as const,
    };
    await expect(finishAiCall(77, end)).resolves.toBe(true);
    expect(mockSent).toHaveLength(1);
    expect(mockSent[0].text).toMatch(/UPDATE ai_calls\s+SET model = \$2/);
    expect(mockSent[0].values).toEqual([77, "fast-model", 10, 20, 0, true, 813, 1, "ok"]);
  });

  test("a row that could not be finished is reported, never thrown", async () => {
    mockAnswers = [[/UPDATE ai_calls/, new Error("gone")]];
    await expect(finishAiCall(77, { ...START, inputTokens: 0, outputTokens: 0, cachedTokens: 0, estimated: false, ms: 0, retries: 0, outcome: "ok" })).resolves.toBe(false);
  });
});

describe("store: clearing out old rows", () => {
  // These run in order: each moves the clock on from the one before.
  test("runs for every organization, keeping usage 90 days and saved answers a week", async () => {
    expect(AI_CALLS_KEEP_DAYS).toBe(90);
    await expect(pruneOldAiRows(Date.now() + 2 * HOUR_MS)).resolves.toBe(true);
    expect(mockSent).toEqual([
      { text: expect.stringMatching(/^DELETE FROM ai_calls WHERE created_at < now\(\) - make_interval/), values: [90] },
      { text: expect.stringMatching(/^DELETE FROM ai_results WHERE created_at < now\(\) - make_interval/), values: [CACHE_DAYS] },
    ]);
    // No organization in it: it clears them all.
    expect(mockSent.some((s) => /org_id/.test(s.text))).toBe(false);
  });

  test("runs at most once an hour", async () => {
    await expect(pruneOldAiRows(Date.now() + 2 * HOUR_MS + 1_000)).resolves.toBe(false);
    expect(mockSent).toHaveLength(0);
    await expect(pruneOldAiRows(Date.now() + 4 * HOUR_MS)).resolves.toBe(true);
  });

  test("saving an answer no longer sends a DELETE of its own", async () => {
    await saveAnswer(4, "compare-summary", "k", "smart-model", { summary: "x" });
    expect(mockSent).toHaveLength(1);
    expect(mockSent[0].text).toMatch(/INSERT INTO ai_results/);
  });

  test("a clear-out that fails is reported, never thrown", async () => {
    mockAnswers = [[/DELETE FROM ai_calls/, new Error("busy")]];
    await expect(pruneOldAiRows(Date.now() + 10 * HOUR_MS)).resolves.toBe(false);
  });
});

describe("store: the usage card and the saved-answer key", () => {
  test("the median and p95 times leave out saved answers and refusals at the limit", async () => {
    await readAiUsage(4);
    const usage = mockSent.find((s) => /percentile_cont/.test(s.text));
    expect(usage).toBeDefined();
    const filters = usage!.text.match(/percentile_cont\([^)]*\) WITHIN GROUP \(ORDER BY ms\)\s+FILTER \(WHERE [^)]*\)/g);
    expect(filters).toHaveLength(2);
    for (const filter of filters!) expect(filter).toMatch(/NOT cache_hit AND outcome <> 'limit_reached'/);
  });

  test("the model is part of the key when given, and the old key is kept without it", () => {
    const plain = cacheKey("compare-summary", 1, { diff: 1 });
    expect(cacheKey("compare-summary", 1, { diff: 1 })).toBe(plain);
    const one = cacheKey("compare-summary", 1, { diff: 1 }, "smart-model at https://a/");
    const other = cacheKey("compare-summary", 1, { diff: 1 }, "newer-model at https://a/");
    expect(one).not.toBe(plain);
    expect(one).not.toBe(other);
  });
});

describe("POST /api/ai/rate", () => {
  function post(body: unknown) {
    return rate(
      new NextRequest("http://localhost/api/ai/rate", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      })
    );
  }

  beforeEach(() => {
    mockGate = { ok: true, principal: principalFor("editor") };
  });

  test.each([99_999_999_999, 2_147_483_648])("a callId of %i is a bad request, and the database is not asked", async (callId) => {
    const response = await post({ callId, rating: 1 });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Send a callId and a rating of 1 or -1." });
    expect(mockSent).toHaveLength(0);
  });

  test("the largest id the table holds is still rated", async () => {
    mockAnswers = [[/UPDATE ai_calls SET rating/, { rowCount: 1 }]];
    const response = await post({ callId: 2_147_483_647, rating: -1 });
    expect(response.status).toBe(200);
    expect(mockSent[0].values).toEqual([expect.any(Number), expect.any(String), 2_147_483_647, -1]);
  });
});

describe("the usage card's note", () => {
  test("says each request is a call, and what Failed counts", () => {
    expect(AI_USAGE_NOTE).toMatch(/Each request to the AI service is one call, a retry or a switch to the other model included\./);
    expect(AI_USAGE_NOTE).toMatch(/Failed counts calls that gave no usable answer/);
    expect(AI_USAGE_NOTE).toMatch(/busy|too slow/);
    expect(AI_USAGE_NOTE).not.toMatch(/[–—]/);
  });
});
