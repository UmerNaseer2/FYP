// The one path every AI feature takes: gate, saved answers, limits, the model
// call with its fallback, the shape check, the feature's code checks and the
// one retry. Everything outside run.ts is a fake, so no database and no model.

jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: {},
  syncMetadataTables: async () => undefined,
}));

import { z } from "zod";
import type { AiConfig } from "@/lib/ai/config";
import { MockProvider } from "@/lib/ai/mock";
import { AiError } from "@/lib/ai/provider";
import {
  aiRefusalStatus,
  FEATURE_OFF,
  jsonSchemaOf,
  messageForFailure,
  modelsFor,
  NOT_CONFIGURED,
  OWN_KEY_REFUSED,
  readAnswer,
  runAiTask,
  soonerWait,
  SWITCHED_OFF,
  TASK_DEADLINE_MS,
  type AiDeps,
  type AiTaskSpec,
} from "@/lib/ai/run";
import { AI_OFF, type OrgAiSettings } from "@/lib/ai/settings";
import type { AiCallRecord } from "@/lib/ai/store";

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

const ON: OrgAiSettings = {
  ...AI_OFF,
  enabled: true,
  features: { ...AI_OFF.features },
};

const caller = { orgId: 4, email: "ada@example.com" };

const Answer = z.object({ summary: z.string(), tables: z.array(z.string()) });
type Answer = z.infer<typeof Answer>;

function spec(over: Partial<AiTaskSpec<Answer>> = {}): AiTaskSpec<Answer> {
  return {
    feature: "compare-summary",
    tier: "smart",
    system: "Summarise the change.",
    prompt: "TABLE books ...",
    schema: Answer,
    cacheInput: { diff: 1 },
    maxOutputTokens: 400,
    ...over,
  };
}

type Fakes = {
  deps: AiDeps;
  provider: MockProvider;
  calls: AiCallRecord[];
  saved: { key: string; model: string; value: unknown }[];
};

function fakes(over: {
  config?: AiConfig | null;
  settings?: OrgAiSettings;
  today?: number;
  lastMinute?: number;
  savedAnswer?: { model: string; answer: unknown } | null;
  replies?: ConstructorParameters<typeof MockProvider>[0];
} = {}): Fakes {
  const provider = new MockProvider(over.replies ?? []);
  const calls: AiCallRecord[] = [];
  const saved: Fakes["saved"] = [];
  let clock = 1_000;
  const config = over.config === undefined ? CONFIG : over.config;
  const deps: AiDeps = {
    config,
    provider: config ? provider : null,
    readSettings: async () => over.settings ?? ON,
    store: {
      recordAiCall: async (record) => {
        calls.push(record);
        return calls.length;
      },
      callsToday: async () => over.today ?? 0,
      callsLastMinute: async () => over.lastMinute ?? 0,
      readSavedAnswer: (async () => over.savedAnswer ?? null) as AiDeps["store"]["readSavedAnswer"],
      saveAnswer: async (_org, _feature, key, model, value) => {
        saved.push({ key, model, value });
      },
    },
    now: () => (clock += 250),
  };
  return { deps, provider, calls, saved };
}

const good: Answer = { summary: "Adds a column to books.", tables: ["books"] };

describe("runAiTask: the gate", () => {
  test("no AI service set up on the server", async () => {
    const { deps, provider, calls } = fakes({ config: null });
    await expect(runAiTask(caller, spec(), deps)).resolves.toEqual({
      kind: "unavailable",
      reason: "not-configured",
      message: NOT_CONFIGURED,
    });
    expect(provider.requests).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  test("AI switched off for the organization", async () => {
    const { deps, provider } = fakes({ settings: AI_OFF });
    await expect(runAiTask(caller, spec(), deps)).resolves.toMatchObject({ reason: "switched-off", message: SWITCHED_OFF });
    expect(provider.requests).toHaveLength(0);
  });

  test("this one feature switched off", async () => {
    const { deps } = fakes({ settings: { ...ON, features: { ...ON.features, "compare-summary": false } } });
    await expect(runAiTask(caller, spec(), deps)).resolves.toMatchObject({ reason: "feature-off", message: FEATURE_OFF });
  });
});

describe("runAiTask: saved answers and limits", () => {
  test("a saved answer is served without calling the model, and counted", async () => {
    const { deps, provider, calls } = fakes({ savedAnswer: { model: "smart-model", answer: good } });
    const result = await runAiTask(caller, spec(), deps);
    expect(result).toMatchObject({ kind: "ok", value: good, saved: true, model: "smart-model", ms: 0 });
    expect(provider.requests).toHaveLength(0);
    expect(calls).toEqual([expect.objectContaining({ outcome: "ok", cacheHit: true, inputTokens: 0 })]);
  });

  test("a saved answer of the wrong shape is ignored and the model is asked", async () => {
    const { deps, provider } = fakes({ savedAnswer: { model: "old", answer: { nope: true } }, replies: [good] });
    const result = await runAiTask(caller, spec(), deps);
    expect(result).toMatchObject({ kind: "ok", saved: false });
    expect(provider.requests).toHaveLength(1);
  });

  test("no cache input skips the saved answers both ways", async () => {
    const { deps, saved } = fakes({ savedAnswer: { model: "m", answer: good }, replies: [good] });
    const result = await runAiTask(caller, spec({ cacheInput: null }), deps);
    expect(result).toMatchObject({ kind: "ok", saved: false });
    expect(saved).toHaveLength(0);
  });

  test("the organization's daily limit", async () => {
    const { deps, provider, calls } = fakes({ today: 300 });
    const result = await runAiTask(caller, spec(), deps);
    expect(result).toEqual({
      kind: "limited",
      message: "Your organization has used its 300 AI calls for today. The count starts again at midnight UTC.",
    });
    expect(provider.requests).toHaveLength(0);
    expect(calls).toEqual([expect.objectContaining({ outcome: "limit_reached", cacheHit: false })]);
  });

  test("the per-person per-minute limit", async () => {
    const { deps } = fakes({ lastMinute: 10 });
    await expect(runAiTask(caller, spec(), deps)).resolves.toMatchObject({ kind: "limited" });
  });

  test("a saved answer still comes back when the daily limit is used up", async () => {
    const { deps } = fakes({ today: 999, savedAnswer: { model: "m", answer: good } });
    await expect(runAiTask(caller, spec(), deps)).resolves.toMatchObject({ kind: "ok", saved: true });
  });
});

describe("runAiTask: asking the model", () => {
  test("a good answer is returned, recorded with its usage, and saved", async () => {
    const { deps, provider, calls, saved } = fakes({ replies: [good] });
    const result = await runAiTask(caller, spec(), deps);
    expect(result).toMatchObject({ kind: "ok", value: good, model: "smart-model", saved: false, retries: 0, callId: 1 });
    expect(calls).toEqual([
      expect.objectContaining({
        orgId: 4,
        actor: "ada@example.com",
        feature: "compare-summary",
        provider: "Google Gemini",
        promptVersion: 3,
        model: "smart-model",
        outputTokens: 10,
        estimated: true,
        outcome: "ok",
        cacheHit: false,
      }),
    ]);
    expect(saved).toEqual([{ key: expect.stringMatching(/^[0-9a-f]{64}$/), model: "smart-model", value: good }]);

    const [request] = provider.requests;
    expect(request.system).toMatch(/^You help people who manage PostgreSQL schemas/);
    expect(request.system).toMatch(/Summarise the change\.$/);
    expect(request.jsonSchema?.name).toBe("compare_summary");
    expect(request.messages).toEqual([{ role: "user", content: "TABLE books ..." }]);
    expect(request.maxOutputTokens).toBe(400);
  });

  test("text that is not JSON gets one retry with the problem spelled out", async () => {
    const { deps, provider, calls } = fakes({ replies: ["Sure! Here it is", good] });
    const result = await runAiTask(caller, spec(), deps);
    expect(result).toMatchObject({ kind: "ok", retries: 1 });
    expect(provider.requests).toHaveLength(2);
    const retry = provider.requests[1].messages;
    expect(retry).toHaveLength(3);
    expect(retry[1]).toEqual({ role: "assistant", content: "Sure! Here it is" });
    expect(retry[2].content).toContain("The answer was not valid JSON.");
    // Each request is its own call, with its own tokens; the answer's usage is the sum.
    expect(calls).toEqual([
      expect.objectContaining({ outcome: "invalid_output", outputTokens: 10, retries: 0 }),
      expect.objectContaining({ outcome: "ok", outputTokens: 10, retries: 1 }),
    ]);
    expect(result.kind === "ok" && result.usage.outputTokens).toBe(20);
    expect(result).toMatchObject({ callId: 2 });
  });

  test("JSON of the wrong shape twice fails as invalid output", async () => {
    const { deps, calls, saved } = fakes({ replies: [{ summary: 3 }, { tables: "books" }] });
    const result = await runAiTask(caller, spec(), deps);
    expect(result).toEqual({
      kind: "failed",
      outcome: "invalid_output",
      message: expect.stringContaining("did not pass the app's checks"),
    });
    expect(calls).toEqual([
      expect.objectContaining({ outcome: "invalid_output", retries: 0 }),
      expect.objectContaining({ outcome: "invalid_output", retries: 1 }),
    ]);
    expect(saved).toHaveLength(0);
  });

  test("the feature's check overrules the model, and a problem triggers the retry", async () => {
    const check = jest.fn((value: Answer) => {
      const unknown = value.tables.filter((t) => t !== "books");
      return {
        value: { ...value, tables: value.tables.filter((t) => t === "books") },
        problems: unknown.map((t) => `${t} is not in the schema.`),
      };
    });
    const { deps, provider } = fakes({
      replies: [{ summary: "x", tables: ["books", "invoices"] }, { summary: "y", tables: ["books"] }],
    });
    const result = await runAiTask(caller, spec({ check }), deps);
    expect(result).toMatchObject({ kind: "ok", value: { summary: "y", tables: ["books"] }, retries: 1 });
    expect(provider.requests[1].messages[2].content).toContain("invoices is not in the schema.");
  });

  test("a check problem that survives the retry fails the task", async () => {
    const check = () => ({ value: good, problems: ["still wrong"] });
    const { deps, calls } = fakes({ replies: [good, good] });
    await expect(runAiTask(caller, spec({ check }), deps)).resolves.toMatchObject({
      kind: "failed",
      outcome: "failed_check",
    });
    expect(calls[0].outcome).toBe("failed_check");
  });

  test("an async check is awaited, and repairs sets how many fixes are asked for", async () => {
    let seen = 0;
    const check = async (value: Answer) => {
      seen += 1;
      await Promise.resolve();
      return { value, problems: seen < 3 ? [`wrong ${seen}`] : [] };
    };
    const { deps, provider } = fakes({ replies: [good, good, good] });
    const result = await runAiTask(caller, spec({ check, repairs: 2 }), deps);
    expect(result).toMatchObject({ kind: "ok", retries: 2 });
    expect(provider.requests).toHaveLength(3);
    expect(provider.requests[2].messages.at(-1)?.content).toContain("wrong 2");
  });

  test("repairs 0 asks once and never sends an answer back", async () => {
    const check = () => ({ value: good, problems: ["wrong"] });
    const { deps, provider } = fakes({ replies: [good, good] });
    await expect(runAiTask(caller, spec({ check, repairs: 0 }), deps)).resolves.toMatchObject({
      kind: "failed",
      outcome: "failed_check",
    });
    expect(provider.requests).toHaveLength(1);
  });

  test("the smart model timing out falls back to the fast one", async () => {
    const { deps, provider, calls, saved } = fakes({ replies: [new AiError("timeout", "slow"), good] });
    const result = await runAiTask(caller, spec(), deps);
    expect(result).toMatchObject({ kind: "ok", model: "fast-model", callId: 2 });
    expect(provider.requests.map((r) => r.model)).toEqual(["smart-model", "fast-model"]);
    // The request that timed out is a call too.
    expect(calls).toEqual([
      expect.objectContaining({ model: "smart-model", outcome: "timeout", outputTokens: 0 }),
      expect.objectContaining({ model: "fast-model", outcome: "ok" }),
    ]);
    // A fallback answer is shown but not saved, so the smart model is asked next time.
    expect(saved).toHaveLength(0);
  });

  test("a busy smart model falls back too", async () => {
    const { deps } = fakes({ replies: [new AiError("overloaded", "503", 503), good] });
    await expect(runAiTask(caller, spec(), deps)).resolves.toMatchObject({ kind: "ok", model: "fast-model" });
  });

  test("a used-up allowance on the smart model tries the fast one, which has its own", async () => {
    const { deps, provider } = fakes({ replies: [new AiError("rate_limited", "429", 429, 20_738_000), good] });
    await expect(runAiTask(caller, spec(), deps)).resolves.toMatchObject({ kind: "ok", model: "fast-model" });
    expect(provider.requests.map((r) => r.model)).toEqual(["smart-model", "fast-model"]);
  });

  test("when both allowances are used up, it says how long until the sooner one is back", async () => {
    const { deps, provider, calls } = fakes({
      replies: [new AiError("rate_limited", "429", 429, 20_738_000), new AiError("rate_limited", "429", 429, 5_000_000)],
    });
    const result = await runAiTask(caller, spec(), deps);
    expect(result).toMatchObject({ kind: "failed", outcome: "rate_limited" });
    expect(result.kind === "failed" && result.message).toBe(
      "The AI service's free allowance is used up for today. Try again in about an hour."
    );
    expect(provider.requests).toHaveLength(2);
    expect(calls.map((c) => c.outcome)).toEqual(["rate_limited", "rate_limited"]);
  });

  test("the used-up message names the wait the service gave", () => {
    expect(messageForFailure("rate_limited")).toBe("The AI service's free allowance is used up for now. Try again in a minute.");
    expect(messageForFailure("rate_limited", 30_000)).toContain("Try again in a minute.");
    expect(messageForFailure("rate_limited", 300_000)).toContain("Try again in about 5 minutes.");
    expect(messageForFailure("rate_limited", 20_738_000)).toBe(
      "The AI service's free allowance is used up for today. Try again in about 6 hours."
    );
    expect(soonerWait(null, 5)).toBe(5);
    expect(soonerWait(7, null)).toBe(7);
    expect(soonerWait(7, 5)).toBe(5);
    expect(soonerWait(null, null)).toBeNull();
  });

  test.each([401, 403])("a refused key (%i) does not try the other model", async (status) => {
    const { deps, provider, calls } = fakes({ replies: [new AiError("rejected", "bad key", status)] });
    await expect(runAiTask(caller, spec(), deps)).resolves.toMatchObject({ kind: "failed", outcome: "provider_error" });
    expect(provider.requests).toHaveLength(1);
    expect(calls).toEqual([expect.objectContaining({ outcome: "provider_error" })]);
  });

  test.each([400, 402, 404])("a refusal about the one model (%i) still asks the other model", async (status) => {
    const { deps, provider } = fakes({ replies: [new AiError("rejected", "no such model", status), good] });
    await expect(runAiTask(caller, spec(), deps)).resolves.toMatchObject({ kind: "ok", model: "fast-model" });
    expect(provider.requests.map((r) => r.model)).toEqual(["smart-model", "fast-model"]);
  });

  test("both models timing out fails as a timeout", async () => {
    const { deps } = fakes({ replies: [new AiError("timeout", "a"), new AiError("timeout", "b")] });
    await expect(runAiTask(caller, spec(), deps)).resolves.toMatchObject({ kind: "failed", outcome: "timeout" });
  });

  test("a fast task asks only the fast model", async () => {
    const { deps, provider } = fakes({ replies: [new AiError("timeout", "a")] });
    await runAiTask(caller, spec({ tier: "fast" }), deps);
    expect(provider.requests.map((r) => r.model)).toEqual(["fast-model"]);
  });

  test("an error that is not the service's is not swallowed, and its call is still written", async () => {
    const { deps, calls } = fakes({
      replies: [
        () => {
          throw new TypeError("bug");
        },
      ],
    });
    await expect(runAiTask(caller, spec(), deps)).rejects.toThrow("bug");
    expect(calls).toEqual([expect.objectContaining({ outcome: "provider_error" })]);
  });
});

// A store that keeps its rows in memory and reserves a row before each
// request, like store.reserveAiCall does under its lock. JavaScript runs one
// thing at a time, so the count and the reserved row here are one step.
type Row = AiCallRecord & { id: number };

function reservingFakes(over: { config?: AiConfig; replies?: ConstructorParameters<typeof MockProvider>[0] } = {}) {
  const config = over.config ?? CONFIG;
  const provider = new MockProvider(over.replies ?? []);
  const rows: Row[] = [];
  const counted = () => rows.filter((row) => !row.cacheHit && row.outcome !== "limit_reached");
  const add = (record: AiCallRecord) => {
    const row = { ...record, id: rows.length + 1 };
    rows.push(row);
    return row.id;
  };
  const deps: AiDeps = {
    config,
    provider,
    readSettings: async () => ON,
    store: {
      recordAiCall: async (record) => add(record),
      // What the old check counted: rows already written.
      callsToday: async () => counted().length,
      callsLastMinute: async (_org, email) => counted().filter((row) => row.actor === email).length,
      readSavedAnswer: (async () => null) as AiDeps["store"]["readSavedAnswer"],
      saveAnswer: async () => undefined,
      reserveAiCall: async (call, limits) => {
        if (counted().length >= limits.dailyLimit) return { kind: "limited", which: "daily" };
        if (counted().filter((row) => row.actor === call.actor).length >= limits.perMinuteLimit) {
          return { kind: "limited", which: "per-minute" };
        }
        const id = add({
          ...call,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          estimated: false,
          ms: 0,
          retries: 0,
          outcome: "provider_error",
          cacheHit: false,
        });
        return { kind: "reserved", id };
      },
      finishAiCall: async (id, end) => {
        const row = rows.find((r) => r.id === id);
        if (!row) return false;
        Object.assign(row, end);
        return true;
      },
    },
    now: (() => {
      let clock = 1_000;
      return () => (clock += 250);
    })(),
  };
  return { deps, provider, rows };
}

describe("runAiTask: each request is one call against the limits", () => {
  test("requests still in flight count, so 25 at once with a limit of 10 lets 10 through", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const replies = Array.from({ length: 25 }, () => async () => {
      await held;
      return good;
    });
    const { deps, provider, rows } = reservingFakes({ replies });
    const runs = Array.from({ length: 25 }, () => runAiTask(caller, spec({ cacheInput: null }), deps));
    // Let every task reach its request before any answer comes back.
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    release();
    const results = await Promise.all(runs);
    expect(results.filter((r) => r.kind === "ok")).toHaveLength(10);
    expect(results.filter((r) => r.kind === "limited")).toHaveLength(15);
    expect(provider.requests).toHaveLength(10);
    expect(rows.filter((r) => r.outcome === "ok")).toHaveLength(10);
    expect(rows.filter((r) => r.outcome === "limit_reached")).toHaveLength(15);
  });

  test("the reserved row is filled in when the call ends, and its id is the answer's", async () => {
    const { deps, rows } = reservingFakes({ replies: [good] });
    const result = await runAiTask(caller, spec(), deps);
    expect(result).toMatchObject({ kind: "ok", callId: 1 });
    expect(rows).toEqual([expect.objectContaining({ id: 1, outcome: "ok", model: "smart-model", outputTokens: 10 })]);
  });

  test("a switch to the other model is checked against the limit too", async () => {
    const { deps, provider, rows } = reservingFakes({
      config: { ...CONFIG, perMinuteLimit: 1 },
      replies: [new AiError("timeout", "slow"), good],
    });
    await expect(runAiTask(caller, spec(), deps)).resolves.toMatchObject({ kind: "limited" });
    expect(provider.requests).toHaveLength(1);
    expect(rows.map((r) => r.outcome)).toEqual(["timeout", "limit_reached"]);
  });

  test("a retry is checked against the limit too", async () => {
    const { deps, provider } = reservingFakes({
      config: { ...CONFIG, perMinuteLimit: 1 },
      replies: ["not json", good],
    });
    await expect(runAiTask(caller, spec(), deps)).resolves.toMatchObject({ kind: "limited" });
    expect(provider.requests).toHaveLength(1);
  });

  test("the daily limit names the daily count", async () => {
    const { deps } = reservingFakes({ config: { ...CONFIG, dailyLimit: 0 } });
    await expect(runAiTask(caller, spec(), deps)).resolves.toEqual({
      kind: "limited",
      message: "Your organization has used its 0 AI calls for today. The count starts again at midnight UTC.",
    });
  });
});

describe("runAiTask: time, cancelling and asking again", () => {
  test("a model that timed out is not asked again for the retry", async () => {
    const { deps, provider } = fakes({ replies: [new AiError("timeout", "slow"), "not json", good] });
    await expect(runAiTask(caller, spec(), deps)).resolves.toMatchObject({ kind: "ok", model: "fast-model", retries: 1 });
    expect(provider.requests.map((r) => r.model)).toEqual(["smart-model", "fast-model", "fast-model"]);
  });

  test("the whole task has a deadline: no new request once the time is used up", async () => {
    const { deps, provider, calls } = fakes({ replies: [good, good] });
    let clock = 0;
    deps.now = () => clock;
    const slowCheck = async (value: Answer) => {
      clock += TASK_DEADLINE_MS;
      return { value, problems: ["Name a real table."] };
    };
    await expect(runAiTask(caller, spec({ check: slowCheck }), deps)).resolves.toMatchObject({
      kind: "failed",
      outcome: "timeout",
    });
    expect(provider.requests).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  test("a request may only wait for the time the task has left", async () => {
    const { deps, provider } = fakes({ replies: [good, good] });
    let clock = 0;
    deps.now = () => clock;
    const slowCheck = async (value: Answer) => {
      // The first time only: 100 s go by, and the answer needs fixing.
      if (clock > 0) return { value, problems: [] };
      clock += 100_000;
      return { value, problems: ["Name a real table."] };
    };
    await expect(runAiTask(caller, spec({ check: slowCheck }), deps)).resolves.toMatchObject({ kind: "ok" });
    expect(provider.requests.map((r) => r.timeoutMs)).toEqual([CONFIG.timeoutMs, TASK_DEADLINE_MS - 100_000]);
  });

  test("a task cancelled before it starts asks nothing", async () => {
    const stop = new AbortController();
    stop.abort();
    const { deps, provider, calls } = fakes({ replies: [good] });
    await expect(runAiTask(caller, spec({ signal: stop.signal }), deps)).resolves.toMatchObject({
      kind: "failed",
      outcome: "timeout",
    });
    expect(provider.requests).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  test("a task cancelled while it waits does not ask the other model", async () => {
    const stop = new AbortController();
    const { deps, provider, calls } = fakes({
      replies: [
        () => {
          stop.abort();
          return new AiError("timeout", "The request was cancelled.");
        },
        good,
      ],
    });
    await expect(runAiTask(caller, spec({ signal: stop.signal }), deps)).resolves.toMatchObject({
      kind: "failed",
      outcome: "timeout",
    });
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0].signal).toBe(stop.signal);
    expect(calls).toEqual([expect.objectContaining({ outcome: "timeout" })]);
  });

  test("asking again skips the saved answer and saves the new one", async () => {
    const fresh: Answer = { summary: "Adds two columns to books.", tables: ["books"] };
    const { deps, provider, saved } = fakes({ savedAnswer: { model: "smart-model", answer: good }, replies: [fresh] });
    const result = await runAiTask(caller, spec({ refresh: true }), deps);
    expect(result).toMatchObject({ kind: "ok", value: fresh, saved: false });
    expect(provider.requests).toHaveLength(1);
    expect(saved).toEqual([expect.objectContaining({ value: fresh })]);
  });

  test("a different model means a different saved answer", async () => {
    const one = fakes({ replies: [good] });
    await runAiTask(caller, spec(), one.deps);
    const other = fakes({ config: { ...CONFIG, models: { ...CONFIG.models, smart: "newer-model" } }, replies: [good] });
    await runAiTask(caller, spec(), other.deps);
    expect(one.saved[0].key).not.toBe(other.saved[0].key);
  });
});

describe("the helpers", () => {
  test("modelsFor gives smart then fast, or one model when they are the same", () => {
    expect(modelsFor(CONFIG, "smart")).toEqual(["smart-model", "fast-model"]);
    expect(modelsFor(CONFIG, "fast")).toEqual(["fast-model"]);
    expect(modelsFor({ ...CONFIG, models: { fast: "one", smart: "one" } }, "smart")).toEqual(["one"]);
  });

  test("jsonSchemaOf leaves out the $schema line", () => {
    const json = jsonSchemaOf(Answer);
    expect(json.$schema).toBeUndefined();
    expect(json).toMatchObject({ type: "object", required: ["summary", "tables"] });
  });

  test("jsonSchemaOf leaves out list length limits, which Gemini refuses, and keeps the rest", () => {
    const Limited = z.object({
      minItems: z.string().max(20),
      items: z.array(z.object({ name: z.string().min(1) })).min(1).max(3),
    });
    const json = jsonSchemaOf(Limited);
    const text = JSON.stringify(json);
    expect(text).not.toMatch(/"(minItems|maxItems)":\d/);
    // A field that happens to share a keyword's name is still there.
    expect(json).toMatchObject({
      required: ["minItems", "items"],
      properties: {
        minItems: { type: "string", maxLength: 20 },
        items: { type: "array", items: { properties: { name: { minLength: 1 } } } },
      },
    });
    // The answer is still held to the limits when it is read.
    expect("problems" in readAnswer('{"minItems":"a","items":[]}', Limited)).toBe(true);
  });

  test("readAnswer names the field that is wrong", () => {
    expect(readAnswer('{"summary":"a","tables":["b"]}', Answer)).toEqual({ value: { summary: "a", tables: ["b"] } });
    const wrong = readAnswer('{"summary":1,"tables":[]}', Answer);
    expect("problems" in wrong && wrong.problems[0]).toMatch(/^summary: /);
  });

  test.each([
    [{ kind: "unavailable", reason: "not-configured", message: "" } as const, 503],
    [{ kind: "unavailable", reason: "switched-off", message: "" } as const, 403],
    [{ kind: "unavailable", reason: "feature-off", message: "" } as const, 403],
    [{ kind: "limited", message: "" } as const, 429],
    [{ kind: "failed", outcome: "rate_limited", message: "" } as const, 429],
    [{ kind: "failed", outcome: "timeout", message: "" } as const, 502],
    [{ kind: "failed", outcome: "failed_check", message: "" } as const, 502],
  ])("aiRefusalStatus(%o) is %i", (result, status) => {
    expect(aiRefusalStatus(result)).toBe(status);
  });
});

describe("runAiTask: an organization's own key", () => {
  const OWN: AiConfig = { ...CONFIG, source: "organization", apiKey: "fake-test-key-not-real-0000" };

  test.each([401, 403])("a refused own key (%i) tells the Admin where to fix it, after one request", async (status) => {
    const { deps, provider } = fakes({ config: OWN, replies: [new AiError("rejected", "bad key", status)] });
    const result = await runAiTask(caller, spec(), deps);
    expect(result).toMatchObject({ kind: "failed", outcome: "provider_error", message: OWN_KEY_REFUSED });
    expect(provider.requests).toHaveLength(1);
  });

  test("a refused server key keeps the general message: users cannot fix the server's key", async () => {
    const { deps } = fakes({ replies: [new AiError("rejected", "bad key", 401)] });
    const result = await runAiTask(caller, spec(), deps);
    expect(result).toMatchObject({ kind: "failed", message: "The AI service could not answer. Try again later." });
  });

  test("a refusal about one model is not blamed on the own key", async () => {
    const { deps, provider } = fakes({
      config: OWN,
      replies: [new AiError("rejected", "no such model", 404), new AiError("rejected", "no such model", 404)],
    });
    const result = await runAiTask(caller, spec(), deps);
    expect(result).toMatchObject({ kind: "failed", message: "The AI service could not answer. Try again later." });
    expect(provider.requests).toHaveLength(2);
  });

  test("an own key at its limit on both models says it is the organization's limit", async () => {
    const { deps } = fakes({
      config: OWN,
      replies: [new AiError("rate_limited", "429", 429, 300_000), new AiError("rate_limited", "429", 429, 600_000)],
    });
    const result = await runAiTask(caller, spec(), deps);
    expect(result.kind === "failed" && result.message).toBe(
      "Your organization's AI key has reached its limit for now. Try again in about 5 minutes."
    );
  });

  test("a key that cannot be used gives the reason, not the general not-set-up message", async () => {
    const { deps, provider } = fakes({ config: null });
    deps.setupProblem = "This organization's AI key cannot be read on this server.";
    await expect(runAiTask(caller, spec(), deps)).resolves.toEqual({
      kind: "unavailable",
      reason: "not-configured",
      message: "This organization's AI key cannot be read on this server.",
    });
    expect(provider.requests).toHaveLength(0);
  });

  test("the failure messages for an own key", () => {
    expect(messageForFailure("provider_error", null, { ownKey: true, keyRefused: true })).toBe(OWN_KEY_REFUSED);
    // The server's key refused is not something an organization's Admin can fix.
    expect(messageForFailure("provider_error", null, { ownKey: false, keyRefused: true })).toBe(
      "The AI service could not answer. Try again later."
    );
    expect(messageForFailure("rate_limited", null, { ownKey: true })).toBe(
      "Your organization's AI key has reached its limit for now. Try again in a minute."
    );
    expect(messageForFailure("rate_limited", 7_200_000, { ownKey: true })).toBe(
      "Your organization's AI key has reached its limit for today. Try again in about 2 hours."
    );
    expect(messageForFailure("timeout", null, { ownKey: true })).toBe("The AI service took too long to answer. Try again.");
  });
});
