// /api/internal/drift-tick: the scheduled call that wakes the drift checker.
//
// proxy.ts lets this path through with no session (lib/public-paths.ts), so the
// shared secret here is the whole check. A mistake in it would let anyone on
// the internet set off database work for every organization.
import { GET, maxDuration } from "@/app/api/internal/drift-tick/route";

const SECRET = "made-up-secret-for-this-test-only-0123456789";

const mockDisabled = jest.fn<string | null, []>(() => null);
const mockTick = jest.fn(async () => ({ kind: "shared", line: "unused" }));
jest.mock("../lib/drift-scheduler", () => ({
  disabledReason: () => mockDisabled(),
  runSchedulerTick: () => mockTick(),
}));

// The real after() throws outside a request.
const mockAfter = jest.fn<void, [() => unknown]>();
jest.mock("next/server", () => ({
  ...jest.requireActual("next/server"),
  after: (task: () => unknown) => mockAfter(task),
}));

function call(authorization?: string) {
  const headers = authorization === undefined ? undefined : { authorization };
  return GET(new Request("http://localhost:3000/api/internal/drift-tick", { headers }));
}

const savedSecret = process.env.CRON_SECRET;

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
  mockDisabled.mockReset();
  mockDisabled.mockReturnValue(null);
  mockTick.mockClear();
  mockAfter.mockClear();
});

afterAll(() => {
  if (savedSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = savedSecret;
});

describe("who may wake the checker", () => {
  async function expectRefused(authorization: string | undefined, status: number) {
    const response = await call(authorization);
    expect(response.status).toBe(status);
    expect(mockAfter).not.toHaveBeenCalled();
    expect(mockTick).not.toHaveBeenCalled();
  }

  it("refuses everyone on a server with no secret", async () => {
    delete process.env.CRON_SECRET;
    await expectRefused(undefined, 503);
  });

  it("does not let the words for a missing secret stand in for it", async () => {
    // A check that builds `Bearer ${process.env.CRON_SECRET}` compares against
    // exactly this when the secret was never set.
    delete process.env.CRON_SECRET;
    await expectRefused("Bearer undefined", 503);
  });

  it("refuses everyone on a server with a blank secret", async () => {
    process.env.CRON_SECRET = "";
    await expectRefused("Bearer ", 503);
  });

  it("refuses everyone on a server with a secret short enough to guess", async () => {
    process.env.CRON_SECRET = "x".repeat(31);
    await expectRefused(`Bearer ${"x".repeat(31)}`, 503);
  });

  it("takes a secret at the shortest length it allows", async () => {
    process.env.CRON_SECRET = "x".repeat(32);
    expect((await call(`Bearer ${"x".repeat(32)}`)).status).toBe(202);
  });

  it("refuses a call with no secret", async () => {
    await expectRefused(undefined, 401);
  });

  it.each([
    ["the wrong secret", `Bearer ${SECRET}x`],
    ["part of the secret", `Bearer ${SECRET.slice(0, -1)}`],
    ["the secret with no scheme", SECRET],
    ["another scheme", `Basic ${SECRET}`],
    ["an empty value", ""],
  ])("refuses %s", async (_name, authorization) => {
    await expectRefused(authorization, 401);
  });
});

describe("a call with the right secret", () => {
  it("answers at once and leaves the tick to run afterwards", async () => {
    const response = await call(`Bearer ${SECRET}`);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    // pg_net does not wait for an answer: running the tick before answering
    // would only make the caller time out.
    expect(mockAfter).toHaveBeenCalledTimes(1);
    expect(mockTick).not.toHaveBeenCalled();

    await mockAfter.mock.calls[0][0]();
    expect(mockTick).toHaveBeenCalledTimes(1);
  });

  it("runs nothing on a server where the checker is turned off", async () => {
    mockDisabled.mockReturnValue("Turned off by DRIFT_SCHEDULER.");
    const response = await call(`Bearer ${SECRET}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: false });
    expect(mockAfter).not.toHaveBeenCalled();
    expect(mockTick).not.toHaveBeenCalled();
  });
});

it("asks for no more time than the free plan allows", () => {
  // A higher number can fail the whole deployment there.
  expect(maxDuration).toBe(300);
});
