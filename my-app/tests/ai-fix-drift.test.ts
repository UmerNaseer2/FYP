// The drift alert line's hard 4 second wait: when it is up, the AI task that
// lost the race is stopped, so no repair and no second model is asked later,
// and nothing it does afterwards can reach the server as an uncaught error.

jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: {},
  syncMetadataTables: async () => undefined,
}));

import { compareSchemas } from "@/lib/compare";
import { ALERT_LINE_WAIT_MS, driftAlertLine } from "@/lib/ai/drift-alert-line";
import type { AiConfig } from "@/lib/ai/config";
import { MockProvider } from "@/lib/ai/mock";
import { AiError, type AiProvider, type GenerateRequest } from "@/lib/ai/provider";
import type { AiDeps } from "@/lib/ai/run";
import { AI_OFF } from "@/lib/ai/settings";
import { column, schema, table } from "./helpers/snapshots";

const id = () => column("id", { nullable: false, isPrimaryKey: true });
const report = compareSchemas(
  schema([table("books", [id(), column("price", { typeDisplay: "numeric" })])]),
  schema([table("books", [id()])])
);

const config = {
  provider: "openai-compatible",
  baseUrl: "https://example.test/v1",
  apiKey: "k",
  // Two models, so a task that was not stopped would go on to the second.
  models: { fast: "fast-model", smart: "smart-model" },
  timeoutMs: 20_000,
} as unknown as AiConfig;

function deps(provider: AiProvider): AiDeps {
  return {
    config,
    provider,
    readSettings: async () => ({ ...AI_OFF, enabled: true, features: { ...AI_OFF.features } }),
    store: {
      recordAiCall: async () => 1,
      callsToday: async () => 0,
      callsLastMinute: async () => 0,
      readSavedAnswer: (async () => null) as AiDeps["store"]["readSavedAnswer"],
      saveAnswer: async () => undefined,
    },
    now: () => 0,
  };
}

/** A service that never answers, and gives up only when its request is cancelled, as fetch does. */
function hangingProvider(): { provider: AiProvider; requests: GenerateRequest[] } {
  const requests: GenerateRequest[] = [];
  const provider: AiProvider = {
    generate: (request) => {
      requests.push(request);
      return new Promise((_resolve, reject) => {
        request.signal?.addEventListener("abort", () => reject(new AiError("timeout", "The request was cancelled.")));
      });
    },
  };
  return { provider, requests };
}

afterEach(() => jest.useRealTimers());

test("the wait is the plan's hard 4 seconds", () => {
  expect(ALERT_LINE_WAIT_MS).toBe(4_000);
});

test("when the wait is up the request is cancelled and nothing more is asked", async () => {
  jest.useFakeTimers();
  const quiet = jest.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const { provider, requests } = hangingProvider();
    const pending = driftAlertLine(7, report, deps(provider));
    await jest.advanceTimersByTimeAsync(ALERT_LINE_WAIT_MS - 1);
    expect(requests).toHaveLength(1);
    expect(requests[0].signal?.aborted).toBe(false);

    await jest.advanceTimersByTimeAsync(2);
    expect(await pending).toBeNull();
    expect(requests[0].signal?.aborted).toBe(true);

    // Long after: no repair, no second model, and no error logged for a task
    // that was stopped on purpose.
    await jest.advanceTimersByTimeAsync(60_000);
    expect(requests).toHaveLength(1);
    expect(quiet).not.toHaveBeenCalled();
  } finally {
    quiet.mockRestore();
  }
});

test("a task that fails after the wait is up is caught, not left to crash the server", async () => {
  jest.useFakeTimers();
  let fail: (error: Error) => void = () => undefined;
  // A service that ignores the cancel and fails later with an error the
  // runner does not expect.
  const provider: AiProvider = {
    generate: () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  };
  const unhandled = jest.fn();
  process.on("unhandledRejection", unhandled);
  try {
    const pending = driftAlertLine(7, report, deps(provider));
    await jest.advanceTimersByTimeAsync(ALERT_LINE_WAIT_MS + 1);
    expect(await pending).toBeNull();
    fail(new Error("socket hang up"));
    jest.useRealTimers();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).not.toHaveBeenCalled();
  } finally {
    process.off("unhandledRejection", unhandled);
  }
});

test("an answer in time still comes back", async () => {
  const provider = new MockProvider([{ line: "Live lost `books.price`." }]);
  expect(await driftAlertLine(7, report, deps(provider))).toBe("Live lost books.price.");
  expect(provider.requests).toHaveLength(1);
});
