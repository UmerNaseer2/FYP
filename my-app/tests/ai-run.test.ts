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
  modelsFor,
  NOT_CONFIGURED,
  readAnswer,
  runAiTask,
  SWITCHED_OFF,
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
        promptVersion: 1,
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
    // Both calls' tokens are counted in the one row.
    expect(calls).toHaveLength(1);
    expect(calls[0].outputTokens).toBe(20);
  });

  test("JSON of the wrong shape twice fails as invalid output", async () => {
    const { deps, calls, saved } = fakes({ replies: [{ summary: 3 }, { tables: "books" }] });
    const result = await runAiTask(caller, spec(), deps);
    expect(result).toEqual({
      kind: "failed",
      outcome: "invalid_output",
      message: expect.stringContaining("did not pass the app's checks"),
    });
    expect(calls).toEqual([expect.objectContaining({ outcome: "invalid_output", retries: 1 })]);
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
    const { deps, provider, calls } = fakes({ replies: [new AiError("timeout", "slow"), good] });
    const result = await runAiTask(caller, spec(), deps);
    expect(result).toMatchObject({ kind: "ok", model: "fast-model" });
    expect(provider.requests.map((r) => r.model)).toEqual(["smart-model", "fast-model"]);
    expect(calls[0]).toMatchObject({ model: "fast-model", outcome: "ok" });
  });

  test("a busy smart model falls back too", async () => {
    const { deps } = fakes({ replies: [new AiError("overloaded", "503", 503), good] });
    await expect(runAiTask(caller, spec(), deps)).resolves.toMatchObject({ kind: "ok", model: "fast-model" });
  });

  test("a used-up quota does not try the other model", async () => {
    const { deps, provider, calls } = fakes({ replies: [new AiError("rate_limited", "429", 429)] });
    const result = await runAiTask(caller, spec(), deps);
    expect(result).toMatchObject({ kind: "failed", outcome: "rate_limited" });
    expect(provider.requests).toHaveLength(1);
    expect(calls[0].outcome).toBe("rate_limited");
  });

  test("a refused request does not try the other model", async () => {
    const { deps, provider } = fakes({ replies: [new AiError("rejected", "bad key", 401)] });
    await expect(runAiTask(caller, spec(), deps)).resolves.toMatchObject({ kind: "failed", outcome: "provider_error" });
    expect(provider.requests).toHaveLength(1);
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

  test("an error that is not the service's is not swallowed", async () => {
    const { deps } = fakes({
      replies: [
        () => {
          throw new TypeError("bug");
        },
      ],
    });
    await expect(runAiTask(caller, spec(), deps)).rejects.toThrow("bug");
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
