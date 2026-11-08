// An organization's own AI key (Admin, AI): which adapter and settings a saved
// key gives (aiDepsFor), how the form's input is checked (readAiKeyChange),
// the key route (app/api/admin/ai/key/route.ts), and the request OpenAI's own
// service is sent. The database, the gate and the key store are fakes, the
// services are never called, and every key is a made-up string.

jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: {},
  syncMetadataTables: async () => undefined,
}));

const mockReadOrgKey = jest.fn();
const mockSaveOrgKey = jest.fn();
const mockRemoveOrgKey = jest.fn();
jest.mock("../lib/ai/org-key", () => ({
  readOrgKey: (...args: unknown[]) => mockReadOrgKey(...args),
  saveOrgKey: (...args: unknown[]) => mockSaveOrgKey(...args),
  removeOrgKey: (...args: unknown[]) => mockRemoveOrgKey(...args),
}));

const mockReadAiAdminView = jest.fn();
jest.mock("../lib/ai/admin-view", () => ({
  readAiAdminView: (...args: unknown[]) => mockReadAiAdminView(...args),
}));

const mockKeySource = jest.fn();
jest.mock("../lib/secret-store", () => ({
  ...jest.requireActual("../lib/secret-store"),
  encryptionKeySource: () => mockKeySource(),
}));

type Gate = { ok: true; principal: unknown } | { ok: false; response: Response };
let mockGate: Gate;
jest.mock("../lib/auth-guard", () => ({
  requirePermission: async () => mockGate,
}));

import { NextRequest } from "next/server";
import { DELETE, PUT } from "@/app/api/admin/ai/key/route";
import { AnthropicProvider } from "@/lib/ai/anthropic";
import type { AiConfig } from "@/lib/ai/config";
import { OpenAiCompatibleProvider } from "@/lib/ai/openai-compatible";
import { aiDepsFor, KEY_UNREADABLE, SETTINGS_UNREADABLE } from "@/lib/ai/run";
import { readAiKeyChange } from "@/lib/ai/views";
import { principalFor, TEST_ORG } from "./helpers/principals";

const FAKE_KEY = "fake-test-key-not-real-0000";

/** A saved key as readOrgKey hands it back. */
function savedKey(over: Record<string, unknown> = {}) {
  return {
    provider: "anthropic",
    apiKey: FAKE_KEY,
    hint: "0000",
    models: { fast: "claude-haiku-5-5", smart: "claude-sonnet-5-5" },
    setBy: "admin@example.com",
    setAt: new Date("2026-11-08T00:00:00Z"),
    ...over,
  };
}

// The routes log their failures; the tests read what was logged.
let errors: jest.SpyInstance;
afterEach(() => errors.mockRestore());

beforeEach(() => {
  errors = jest.spyOn(console, "error").mockImplementation(() => {});
  mockReadOrgKey.mockReset();
  mockSaveOrgKey.mockReset();
  mockRemoveOrgKey.mockReset();
  mockReadAiAdminView.mockReset().mockResolvedValue({ setup: { configured: true }, orgKey: null });
  mockKeySource.mockReset().mockReturnValue("env");
  mockGate = { ok: true, principal: principalFor("admin") };
});

describe("aiDepsFor: which key an organization's AI calls use", () => {
  test("no key saved: the server's settings, with nothing to report", async () => {
    mockReadOrgKey.mockResolvedValue(null);
    const deps = await aiDepsFor(4);
    expect(mockReadOrgKey).toHaveBeenCalledWith(4);
    expect(deps.setupProblem).toBeUndefined();
    expect(deps.config?.source).not.toBe("organization");
  });

  test("a Claude key: the Claude adapter, with the saved models", async () => {
    mockReadOrgKey.mockResolvedValue(savedKey({ models: { fast: "claude-haiku-5-5", smart: "my-claude" } }));
    const deps = await aiDepsFor(4);
    expect(deps.provider).toBeInstanceOf(AnthropicProvider);
    expect(deps.config).toMatchObject({
      provider: "anthropic",
      source: "organization",
      baseUrl: "https://api.anthropic.com",
      apiKey: FAKE_KEY,
      models: { fast: "claude-haiku-5-5", smart: "my-claude" },
    });
    expect(deps.setupProblem).toBeUndefined();
  });

  test.each([
    ["gemini", "https://generativelanguage.googleapis.com/v1beta/openai/"],
    ["openai", "https://api.openai.com/v1/"],
  ])("a %s key: the OpenAI-style adapter, sent to that service only", async (provider, baseUrl) => {
    mockReadOrgKey.mockResolvedValue(savedKey({ provider, models: { fast: "a", smart: "b" } }));
    const deps = await aiDepsFor(4);
    expect(deps.provider).toBeInstanceOf(OpenAiCompatibleProvider);
    expect(deps.config).toMatchObject({ provider: "openai-compatible", source: "organization", baseUrl });
  });

  test("a key this server cannot open: no AI, and never the server's key instead", async () => {
    mockReadOrgKey.mockResolvedValue(savedKey({ apiKey: null }));
    const deps = await aiDepsFor(4);
    expect(deps.config).toBeNull();
    expect(deps.provider).toBeNull();
    expect(deps.setupProblem).toBe(KEY_UNREADABLE);
  });

  test("the database cannot be read: no AI, with a message that says so", async () => {
    mockReadOrgKey.mockRejectedValue(new Error("connection refused"));
    const deps = await aiDepsFor(4);
    expect(deps.config).toBeNull();
    expect(deps.provider).toBeNull();
    expect(deps.setupProblem).toBe(SETTINGS_UNREADABLE);
  });
});

describe("readAiKeyChange: the form's input", () => {
  const good = { provider: "anthropic", apiKey: FAKE_KEY };

  test.each([
    [null, "Expected a JSON object."],
    [[good], "Expected a JSON object."],
    [{ ...good, provider: "someone-else" }, "Pick one of the AI services in the list."],
    [{ ...good, provider: "toString" }, "Pick one of the AI services in the list."],
    [{ provider: "gemini" }, "Paste the API key."],
    [{ ...good, apiKey: 12345678 }, "Paste the API key."],
    [{ ...good, apiKey: "  short  " }, "That API key is too short. Paste the whole key."],
    [{ ...good, apiKey: "k".repeat(501) }, "An API key can be at most 500 characters."],
    [{ ...good, apiKey: "fake-key with-a-space" }, "An API key has no spaces or line breaks in it."],
    [{ ...good, apiKey: "fake-key\nsecond-line" }, "An API key has no spaces or line breaks in it."],
    [{ ...good, modelFast: 5 }, "modelFast must be text."],
    [{ ...good, modelSmart: "m".repeat(101) }, "A model name can be at most 100 characters."],
    [{ ...good, modelSmart: "model; drop" }, "A model name can only have letters, digits and . _ - : / in it."],
    [{ ...good, modelFast: "-starts-with-a-dash" }, "A model name can only have letters, digits and . _ - : / in it."],
  ])("%j is refused", (body, message) => {
    expect(readAiKeyChange(body)).toBe(message);
  });

  test("the key and model names are trimmed, and empty names are left out", () => {
    expect(
      readAiKeyChange({ provider: "openai", apiKey: `  ${FAKE_KEY}\n`, modelFast: "  ", modelSmart: " gpt-5.1 ", extra: 1 })
    ).toEqual({ provider: "openai", apiKey: FAKE_KEY, modelSmart: "gpt-5.1" });
  });

  test("model names may be null or missing", () => {
    expect(readAiKeyChange({ ...good, modelFast: null })).toEqual(good);
  });
});

describe("the key route", () => {
  function put(body: unknown) {
    return PUT(
      new NextRequest("http://localhost/api/admin/ai/key", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      })
    );
  }

  const input = { provider: "anthropic", apiKey: FAKE_KEY, modelFast: "", modelSmart: "" };

  test("a refusal from the gate is passed on as it is", async () => {
    mockGate = { ok: false, response: Response.json({ error: "Only an Admin can do that." }, { status: 403 }) };
    expect((await put(input)).status).toBe(403);
    expect((await DELETE()).status).toBe(403);
    expect(mockSaveOrgKey).not.toHaveBeenCalled();
    expect(mockRemoveOrgKey).not.toHaveBeenCalled();
  });

  test("a body that is not JSON", async () => {
    const response = await put("{not json");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Expected a JSON body." });
  });

  test("input the form checks refuse", async () => {
    const response = await put({ ...input, provider: "nope" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Pick one of the AI services in the list." });
    expect(mockSaveOrgKey).not.toHaveBeenCalled();
  });

  test("a server with no encryption key saves nothing", async () => {
    mockKeySource.mockReturnValue("none");
    const response = await put(input);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("APP_ENCRYPTION_KEY");
    expect(mockSaveOrgKey).not.toHaveBeenCalled();
  });

  test("the store finding no encryption key either", async () => {
    mockSaveOrgKey.mockResolvedValue({ kind: "no-key" });
    const response = await put(input);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("APP_ENCRYPTION_KEY");
  });

  test("an organization deleted a moment ago", async () => {
    mockSaveOrgKey.mockResolvedValue({ kind: "not-found" });
    const response = await put(input);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "This organization no longer exists." });
  });

  test("a database error, without the key in the log", async () => {
    mockSaveOrgKey.mockRejectedValue(new Error("connection refused"));
    const response = await put(input);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Could not save the AI key. Try again in a moment." });
    expect(errors).toHaveBeenCalledWith("Failed to save the organization's AI key:", "connection refused");
    expect(JSON.stringify(errors.mock.calls)).not.toContain(FAKE_KEY);
  });

  test("a saved key answers with the AI tab, never the key", async () => {
    mockSaveOrgKey.mockResolvedValue({ kind: "ok" });
    const response = await put({ ...input, modelSmart: " claude-opus-5-5 " });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ setup: { configured: true }, orgKey: null });
    expect(text).not.toContain(FAKE_KEY);
    expect(mockSaveOrgKey).toHaveBeenCalledWith(
      TEST_ORG.id,
      { provider: "anthropic", apiKey: FAKE_KEY, modelSmart: "claude-opus-5-5" },
      expect.objectContaining({ role: "admin" })
    );
  });

  test("removing the key says whether there was one", async () => {
    mockRemoveOrgKey.mockResolvedValue({ removed: true });
    const response = await DELETE();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ setup: { configured: true }, orgKey: null, removed: true });
    expect(mockRemoveOrgKey).toHaveBeenCalledWith(TEST_ORG.id, expect.objectContaining({ role: "admin" }));
  });

  test("removing when the database is down", async () => {
    mockRemoveOrgKey.mockRejectedValue(new Error("connection refused"));
    const response = await DELETE();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Could not remove the AI key. Try again in a moment." });
  });
});

describe("the OpenAI-style adapter: OpenAI's own service and the others", () => {
  const base: AiConfig = {
    provider: "openai-compatible",
    source: "organization",
    baseUrl: "https://api.openai.com/v1/",
    apiKey: FAKE_KEY,
    models: { fast: "gpt-5-mini", smart: "gpt-5" },
    reasoningEffort: "low",
    timeoutMs: 90_000,
    dailyLimit: 300,
    perMinuteLimit: 10,
  };

  // A string field with length limits, and a field that is itself named "maxLength".
  const schema = {
    type: "object",
    properties: {
      summary: { type: "string", minLength: 1, maxLength: 400 },
      maxLength: { type: "integer" },
    },
    required: ["summary", "maxLength"],
    additionalProperties: false,
  };

  async function sentBody(config: AiConfig): Promise<{ url: string; body: Record<string, unknown> }> {
    let url = "";
    let body: Record<string, unknown> = {};
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      url = String(input);
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        model: "gpt-5",
        choices: [{ message: { content: '{"summary":"ok","maxLength":1}' }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
    }) as typeof fetch;
    await new OpenAiCompatibleProvider(config, fakeFetch).generate({
      model: "gpt-5",
      system: "Be brief.",
      messages: [{ role: "user", content: "Hello" }],
      maxOutputTokens: 600,
      jsonSchema: { name: "answer", schema },
    });
    return { url, body };
  }

  test("OpenAI gets max_completion_tokens with room to think, and no length limits", async () => {
    const { url, body } = await sentBody(base);
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(body.max_completion_tokens).toBe(600 + 4_000);
    expect(body).not.toHaveProperty("max_tokens");
    expect(body.reasoning_effort).toBe("low");
    const sent = (body.response_format as { json_schema: { strict: boolean; schema: typeof schema } }).json_schema;
    expect(sent.strict).toBe(true);
    expect(sent.schema.properties.summary).toEqual({ type: "string" });
    // A field named like a keyword is still a field.
    expect(sent.schema.properties.maxLength).toEqual({ type: "integer" });
    expect(sent.schema.required).toEqual(["summary", "maxLength"]);
  });

  test("Gemini's request is as it was: max_tokens, and the length limits kept", async () => {
    const { url, body } = await sentBody({ ...base, baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/" });
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    expect(body.max_tokens).toBe(600);
    expect(body).not.toHaveProperty("max_completion_tokens");
    const sent = (body.response_format as { json_schema: { schema: typeof schema } }).json_schema;
    expect(sent.schema.properties.summary).toEqual({ type: "string", minLength: 1, maxLength: 400 });
  });

  test("an address that only looks like OpenAI's is not OpenAI", async () => {
    const { body } = await sentBody({ ...base, baseUrl: "https://api.openai.com.example.net/v1/" });
    expect(body.max_tokens).toBe(600);
  });
});
