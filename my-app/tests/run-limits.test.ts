// run-limits: the time limits on deploy and rollback runs, and the machinery
// behind the Stop button (lib/run-limits.ts).
//
// Nothing here reaches a database. A run's pool is a stand-in whose
// connections are tests/helpers/fake-pg clients, so each test can say what
// pg_stat_activity answers and read back every statement sent. Jest's fake
// clock stands in for time, so an hour-long limit is checked in a moment.
import type { Pool, PoolClient } from "pg";
import {
  createFakeClient,
  queriesMatching,
  queryTexts,
  type FakeClient,
  type FakeStep,
} from "./helpers/fake-pg";
import {
  APPLICATION_NAME_PREFIX,
  DRY_RUN_LIMITS,
  QUERY_CANCELED,
  REAL_RUN_LIMITS,
  RunStoppedError,
  TRIAL_MAX_CONCURRENT_RUNS,
  TRIAL_RUN_LIMITS,
  beginCommit,
  cancelRunElsewhere,
  cancelRunStatement,
  countOtherRuns,
  findRun,
  formatLimit,
  keepFirstClientError,
  prepareRunTransaction,
  registerRun,
  runApplicationName,
  runLimits,
  runStopMessage,
  stopRun,
  throwIfStopped,
  unregisterRun,
  type CancelOutcome,
  type RunDetails,
  type RunEntry,
  type RunLimits,
  type StopContext,
} from "@/lib/run-limits";
import { isRunId, newRunId } from "@/lib/run-id";

const RUN = "3f2a6c1e-8b4d-4e5f-9a7b-1c2d3e4f5a6b";
const PID = 4242;

/** What the cancel's look at pg_stat_activity finds, for each outcome. */
const ACTIVITY: Record<CancelOutcome, Record<string, unknown>[]> = {
  cancelled: [{ pid: PID, state: "active", committing: false, cancelled: true }],
  idle: [{ pid: PID, state: "idle in transaction", committing: false, cancelled: false }],
  committing: [{ pid: PID, state: "active", committing: true, cancelled: false }],
  not_found: [],
};

const answering = (outcome: CancelOutcome): FakeStep[] => [
  { match: /FROM pg_stat_activity/, rows: ACTIVITY[outcome] },
];

/** A stand-in pool: each connect() hands out a new fake client. */
function fakePool(steps: FakeStep[] | (() => FakeStep[])) {
  const clients: FakeClient[] = [];
  const connect = jest.fn(async () => {
    const client = createFakeClient(typeof steps === "function" ? steps() : steps);
    clients.push(client);
    return client;
  });
  return { pool: { connect } as unknown as Pool, connect, clients };
}

/** A pool whose cancels find each outcome in turn, and then the last one for good. */
function poolAnswering(...outcomes: CancelOutcome[]) {
  let call = 0;
  return fakePool(() => answering(outcomes[Math.min(call++, outcomes.length - 1)]));
}

/** A pool that cannot reach its database. */
function unreachablePool(message: string) {
  const connect = jest.fn(async () => {
    throw new Error(message);
  });
  return { pool: { connect } as unknown as Pool, connect };
}

/** Lets every promise chain already started run to its end, moving the clock on by `ms`. */
const flush = (ms = 0) => jest.advanceTimersByTimeAsync(ms);

let pool: ReturnType<typeof fakePool>;
let errorSpy: jest.SpyInstance;

function details(over: Partial<RunDetails> = {}): RunDetails {
  return {
    runId: newRunId(),
    orgId: 7,
    connectionId: 5,
    actor: "editor@test",
    kind: "deploy",
    trial: false,
    pool: pool.pool,
    ...over,
  };
}

function start(over: Partial<RunDetails> = {}, limits: RunLimits = REAL_RUN_LIMITS): RunEntry {
  const entry = registerRun(details(over), limits);
  if (typeof entry === "string") throw new Error(`registerRun answered "${entry}"`);
  return entry;
}

beforeEach(() => {
  jest.useFakeTimers();
  pool = poolAnswering("idle");
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  for (const entry of [...(globalThis.__schemaStudioRuns?.values() ?? [])]) unregisterRun(entry);
  globalThis.__schemaStudioRuns = undefined;
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("the limits", () => {
  it("are generous for a real run: half an hour a statement, an hour a run", () => {
    expect(REAL_RUN_LIMITS).toEqual({ statementMs: 1_800_000, runMs: 3_600_000, idleInTransactionMs: 300_000 });
  });

  it("are shorter for a dry run, which is thrown away whatever happens", () => {
    expect(DRY_RUN_LIMITS).toEqual({ statementMs: 300_000, runMs: 900_000, idleInTransactionMs: 300_000 });
  });

  it("are shorter still in the trial, whose small demo database every visitor shares", () => {
    expect(TRIAL_RUN_LIMITS).toEqual({ statementMs: 60_000, runMs: 240_000, idleInTransactionMs: 60_000 });
  });

  it("end a trial run before a Vercel function's 300 seconds run out, so the run's own answer comes back", () => {
    expect(TRIAL_RUN_LIMITS.runMs).toBeLessThan(300_000);
  });

  it("give one statement less time than the whole run", () => {
    for (const limits of [REAL_RUN_LIMITS, DRY_RUN_LIMITS, TRIAL_RUN_LIMITS]) {
      expect(limits.statementMs).toBeLessThan(limits.runMs);
    }
  });

  it("are the trial's for any run in the trial, dry or real", () => {
    expect(runLimits({ trial: true, dryRun: false })).toBe(TRIAL_RUN_LIMITS);
    expect(runLimits({ trial: true, dryRun: true })).toBe(TRIAL_RUN_LIMITS);
    expect(runLimits({ trial: false, dryRun: true })).toBe(DRY_RUN_LIMITS);
    expect(runLimits({ trial: false, dryRun: false })).toBe(REAL_RUN_LIMITS);
  });
});

describe("run ids", () => {
  it("make a session name that fits in PostgreSQL's 63 characters", () => {
    const name = runApplicationName(newRunId());
    expect(name.startsWith(APPLICATION_NAME_PREFIX)).toBe(true);
    expect(name).toHaveLength(54);
  });

  it("are fresh each time, and well formed", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newRunId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(isRunId(id)).toBe(true);
  });

  it("are made from getRandomValues on a page that has no randomUUID (plain http)", () => {
    const cryptoApi = globalThis.crypto;
    Object.defineProperty(cryptoApi, "randomUUID", { value: undefined, configurable: true, writable: true });
    try {
      expect(newRunId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } finally {
      delete (cryptoApi as { randomUUID?: unknown }).randomUUID;
    }
    expect(typeof cryptoApi.randomUUID).toBe("function");
  });

  it("are accepted in either case", () => {
    expect(isRunId(RUN.toUpperCase())).toBe(true);
  });

  it.each<[string, unknown]>([
    ["a number", 42],
    ["null", null],
    ["nothing", undefined],
    ["an object", { runId: RUN }],
    ["an empty string", ""],
    ["SQL", "x'); SELECT pg_sleep(100000); --"],
    ["an id with a newline after it", `${RUN}\n`],
    ["an id in braces", `{${RUN}}`],
    ["an id without its dashes", RUN.replace(/-/g, "")],
  ])("are refused when they are %s", (_label, value) => {
    expect(isRunId(value)).toBe(false);
  });
});

describe("the list of runs going", () => {
  it("notes a new run, with nothing yet known about its session", () => {
    const now = Date.now();
    const entry = start({ actor: "admin@test", kind: "rollback" });
    expect(entry).toMatchObject({
      orgId: 7,
      connectionId: 5,
      actor: "admin@test",
      kind: "rollback",
      trial: false,
      pid: null,
      startedAt: now,
      committing: false,
      done: false,
      stopReason: null,
    });
    expect(entry.pool).toBe(pool.pool);
    expect(findRun(entry.runId)).toBe(entry);
    expect(findRun(newRunId())).toBeNull();
  });

  it("refuses a second run with the same id", () => {
    const entry = start();
    expect(registerRun(details({ runId: entry.runId }), REAL_RUN_LIMITS)).toBe("duplicate");
    expect(findRun(entry.runId)).toBe(entry);
  });

  it(`takes at most ${TRIAL_MAX_CONCURRENT_RUNS} trial runs at once, and any number of others`, () => {
    expect(TRIAL_MAX_CONCURRENT_RUNS).toBe(2);
    const first = start({ trial: true }, TRIAL_RUN_LIMITS);
    start({ trial: true }, TRIAL_RUN_LIMITS);
    expect(registerRun(details({ trial: true }), TRIAL_RUN_LIMITS)).toBe("busy");
    // A run outside the trial is never held up by the trial's runs.
    expect(typeof registerRun(details({ trial: false }), REAL_RUN_LIMITS)).toBe("object");
    unregisterRun(first);
    expect(typeof registerRun(details({ trial: true }), TRIAL_RUN_LIMITS)).toBe("object");
  });

  it("forgets a run once it ends, and is safe to tell twice", () => {
    const entry = start();
    unregisterRun(entry);
    unregisterRun(entry);
    expect(entry.done).toBe(true);
    expect(entry.timer).toBeNull();
    expect(findRun(entry.runId)).toBeNull();
    expect(jest.getTimerCount()).toBe(0);
  });

  it("never forgets a newer run that took the same id", () => {
    const old = start();
    unregisterRun(old);
    const newer = start({ runId: old.runId });
    unregisterRun(old);
    expect(findRun(old.runId)).toBe(newer);
  });
});

describe("the whole-run limit", () => {
  it("stops a real run after an hour, and not a moment before", async () => {
    const entry = start();
    await flush(REAL_RUN_LIMITS.runMs - 1);
    expect(entry.stopReason).toBeNull();
    expect(pool.connect).not.toHaveBeenCalled();
    await flush(1);
    expect(entry.stopReason).toBe("run_limit");
    expect(pool.connect).toHaveBeenCalledTimes(1);
  });

  it("stops a trial run after four minutes", async () => {
    const entry = start({ trial: true }, TRIAL_RUN_LIMITS);
    await flush(TRIAL_RUN_LIMITS.runMs);
    expect(entry.stopReason).toBe("run_limit");
  });

  it("never fires for a run that has ended", async () => {
    const entry = start();
    unregisterRun(entry);
    await flush(REAL_RUN_LIMITS.runMs * 2);
    expect(entry.stopReason).toBeNull();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("never fires once the run has begun its COMMIT", async () => {
    const entry = start();
    beginCommit(entry);
    await flush(REAL_RUN_LIMITS.runMs * 2);
    expect(entry.stopReason).toBeNull();
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

describe("stopRun", () => {
  it("marks the run stopped and cancels its statement through the run's own pool", async () => {
    const entry = start();
    entry.pid = PID;
    expect(stopRun(entry, "cancelled")).toBe(true);
    expect(entry.stopReason).toBe("cancelled");
    // The whole-run timer is gone, so it cannot fire as well.
    expect(entry.timer).toBeNull();
    await flush();
    expect(pool.connect).toHaveBeenCalledTimes(1);
    const [select] = queriesMatching(pool.clients[0], /FROM pg_stat_activity/);
    expect(select.values).toEqual([runApplicationName(entry.runId), PID]);
  });

  it("is the same pressed twice as once", async () => {
    const entry = start();
    expect(stopRun(entry, "cancelled")).toBe(true);
    expect(stopRun(entry, "run_limit")).toBe(true);
    await flush();
    expect(entry.stopReason).toBe("cancelled");
    expect(pool.connect).toHaveBeenCalledTimes(1);
  });

  it("answers false for a run that has ended", async () => {
    const entry = start();
    unregisterRun(entry);
    expect(stopRun(entry, "cancelled")).toBe(false);
    await flush();
    expect(entry.stopReason).toBeNull();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("answers false once the run has begun its COMMIT", async () => {
    const entry = start();
    beginCommit(entry);
    expect(stopRun(entry, "cancelled")).toBe(false);
    await flush();
    expect(entry.stopReason).toBeNull();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it.each(["idle", "cancelled"] as const)(
    "cancels again every two seconds (the database answering %s) until the run ends",
    async (outcome) => {
      // A cancel that lands between two statements is lost, and one that
      // landed may still leave the run going a moment, so Stop keeps at it.
      pool = poolAnswering(outcome);
      const entry = start();
      stopRun(entry, "cancelled");
      await flush();
      expect(pool.connect).toHaveBeenCalledTimes(1);
      await flush(1999);
      expect(pool.connect).toHaveBeenCalledTimes(1);
      await flush(1);
      expect(pool.connect).toHaveBeenCalledTimes(2);
      await flush(2000);
      expect(pool.connect).toHaveBeenCalledTimes(3);
      unregisterRun(entry);
      await flush(60_000);
      expect(pool.connect).toHaveBeenCalledTimes(3);
      expect(jest.getTimerCount()).toBe(0);
    }
  );

  it("logs a cancel that cannot reach the database, and tries again", async () => {
    const unreachable = unreachablePool("connect ECONNREFUSED 10.0.0.9:5432");
    const entry = start({ pool: unreachable.pool });
    stopRun(entry, "cancelled");
    await flush();
    expect(errorSpy).toHaveBeenCalledWith(
      "Could not cancel a run's statement:",
      "connect ECONNREFUSED 10.0.0.9:5432"
    );
    await flush(2000);
    expect(unreachable.connect).toHaveBeenCalledTimes(2);
  });
});

describe("beginCommit", () => {
  it("never lets a stopped run commit", () => {
    const entry = start();
    stopRun(entry, "cancelled");
    expect(() => beginCommit(entry)).toThrow(RunStoppedError);
    expect(entry.committing).toBe(false);
  });

  it("marks the run as committing, after which Stop is too late", () => {
    const entry = start();
    beginCommit(entry);
    expect(entry.committing).toBe(true);
    expect(entry.timer).toBeNull();
    expect(stopRun(entry, "cancelled")).toBe(false);
    expect(entry.stopReason).toBeNull();
  });
});

describe("throwIfStopped", () => {
  it("lets a run that nobody stopped go on", () => {
    expect(() => throwIfStopped(null)).not.toThrow();
    expect(() => throwIfStopped(start())).not.toThrow();
  });

  it("throws why the run was stopped", async () => {
    const entry = start();
    stopRun(entry, "run_limit");
    await flush();
    let thrown: unknown;
    try {
      throwIfStopped(entry);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RunStoppedError);
    expect(thrown).toMatchObject({
      name: "RunStoppedError",
      reason: "run_limit",
      message: "The run took longer than it may.",
    });
    expect(new RunStoppedError("cancelled").message).toBe("The run was stopped, as asked.");
  });
});

describe("prepareRunTransaction", () => {
  const withPid = (rows: Record<string, unknown>[] = [{ pid: PID }], extra: FakeStep[] = []) =>
    createFakeClient([...extra, { match: /pg_backend_pid/, rows }]);
  const prepare = (client: FakeClient, limits: RunLimits = REAL_RUN_LIMITS) =>
    prepareRunTransaction(client as unknown as PoolClient, RUN, limits);

  it("names the session after the run and gives it its idle limit, for this transaction only", async () => {
    const client = withPid();
    expect(await prepare(client, TRIAL_RUN_LIMITS)).toBe(PID);
    const [first] = client.queries;
    expect(first.text).toContain("set_config('application_name', $1, true)");
    expect(first.text).toContain("set_config('idle_in_transaction_session_timeout', $2, true)");
    expect(first.values).toEqual([`schema-studio run ${RUN}`, "60000"]);
  });

  it("sets nothing on the session itself, which a transaction pooler would hand on to others", async () => {
    const client = withPid();
    await prepare(client);
    const texts = queryTexts(client);
    const calls = texts.join(" ").match(/set_config\([^)]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toMatch(/, true\)$/);
    expect(texts.some((text) => /(^|;\s*)SET (?!LOCAL)/i.test(text))).toBe(false);
  });

  it("asks the database to watch for this server going away, inside a savepoint", async () => {
    const client = withPid();
    await prepare(client);
    expect(queryTexts(client)).toEqual([
      expect.stringMatching(/^SELECT set_config\('application_name'/),
      "SAVEPOINT run_check_interval; SELECT set_config('client_connection_check_interval', '10000', true); RELEASE SAVEPOINT run_check_interval",
    ]);
  });

  it("goes on without that watch where the database does not know the setting", async () => {
    const client = withPid(undefined, [
      {
        match: /^SAVEPOINT run_check_interval/,
        error: { code: "42704", message: 'unrecognized configuration parameter "client_connection_check_interval"' },
      },
    ]);
    expect(await prepare(client)).toBe(PID);
    expect(queryTexts(client)[2]).toBe(
      "ROLLBACK TO SAVEPOINT run_check_interval; RELEASE SAVEPOINT run_check_interval"
    );
  });

  it.each<[string, Record<string, unknown>[]]>([
    ["a pid sent as text", [{ pid: "4242" }]],
    ["no row", []],
  ])("answers null for %s", async (_label, rows) => {
    expect(await prepare(withPid(rows))).toBeNull();
  });
});

describe("countOtherRuns", () => {
  it("counts the other runs on this database under this login, from any instance of the app", async () => {
    const client = createFakeClient([{ match: /FROM pg_stat_activity/, rows: [{ n: 3 }] }]);
    expect(await countOtherRuns(client as unknown as PoolClient)).toBe(3);
    const [query] = client.queries;
    expect(query.values).toEqual(["schema-studio run %"]);
    expect(query.text).toContain("usename = current_user");
    expect(query.text).toContain("datname = current_database()");
    expect(query.text).toContain("pid <> pg_backend_pid()");
  });

  it("answers 0 when the database sends no row", async () => {
    expect(await countOtherRuns(createFakeClient([]) as unknown as PoolClient)).toBe(0);
  });
});

describe("cancelRunStatement", () => {
  it.each(["cancelled", "idle", "committing", "not_found"] as const)(
    "answers %s when that is what it finds",
    async (outcome) => {
      await expect(cancelRunStatement(poolAnswering(outcome).pool, RUN, null)).resolves.toBe(outcome);
    }
  );

  it("answers idle for an active statement the database would not cancel", async () => {
    const target = fakePool([
      {
        match: /FROM pg_stat_activity/,
        rows: [{ pid: PID, state: "active", committing: false, cancelled: false }],
      },
    ]);
    await expect(cancelRunStatement(target.pool, RUN, PID)).resolves.toBe("idle");
  });

  it("sends its one query in a short transaction of its own, with its own time limit", async () => {
    const target = poolAnswering("cancelled");
    await cancelRunStatement(target.pool, RUN, PID);
    const texts = queryTexts(target.clients[0]);
    expect(texts).toEqual([
      "BEGIN",
      "SET LOCAL statement_timeout = 10000",
      expect.stringMatching(/^SELECT pid, state/),
      "COMMIT",
    ]);
    expect(target.clients[0].queries[2].values).toEqual([`schema-studio run ${RUN}`, PID]);
  });

  it("finds the run's session by its name alone when its pid is not known", async () => {
    const target = poolAnswering("cancelled");
    await cancelRunStatement(target.pool, RUN, null);
    expect(target.clients[0].queries[2].values).toEqual([`schema-studio run ${RUN}`, null]);
  });

  it("cancels only an active statement that is not a COMMIT, and never ends a session", async () => {
    const target = poolAnswering("idle");
    await cancelRunStatement(target.pool, RUN, null);
    const select = queryTexts(target.clients[0])[2];
    expect(select).toContain(
      "CASE WHEN state = 'active' AND NOT (query ~* '^[[:space:]]*commit([^[:alnum:]_]|$)') " +
        "THEN pg_cancel_backend(pid) ELSE false END"
    );
    expect(select).not.toMatch(/pg_terminate_backend/);
    expect(select).toContain("usename = current_user");
    expect(select).toContain("pid <> pg_backend_pid()");
  });

  it("gives its connection back to the pool when done", async () => {
    const target = poolAnswering("cancelled");
    await cancelRunStatement(target.pool, RUN, null);
    expect(target.clients[0].releaseCount).toBe(1);
    expect(target.clients[0].releasedWith).toBeUndefined();
  });

  it("closes its connection, rather than hand it on, when a query fails", async () => {
    const target = fakePool([
      { match: /FROM pg_stat_activity/, error: { code: "42501", message: "permission denied to cancel query" } },
    ]);
    await expect(cancelRunStatement(target.pool, RUN, null)).rejects.toMatchObject({ code: "42501" });
    expect(target.clients[0].releaseCount).toBe(1);
    expect(target.clients[0].releasedWith).toBe(true);
  });

  it("listens for its connection's errors while it holds it, and stops before handing it back", async () => {
    const client = createFakeClient(answering("cancelled"));
    const on = jest.spyOn(client, "on");
    const off = jest.spyOn(client, "off");
    const release = jest.spyOn(client, "release");
    const target = { connect: jest.fn(async () => client) } as unknown as Pool;
    await cancelRunStatement(target, RUN, null);
    const listener = on.mock.calls.find(([event]) => event === "error")?.[1];
    expect(listener).toEqual(expect.any(Function));
    expect(off).toHaveBeenCalledWith("error", listener);
    expect(off.mock.invocationCallOrder[0]).toBeLessThan(release.mock.invocationCallOrder[0]);
    // What the listener does with an error: log it, never throw.
    expect(() => listener?.(new Error("Connection terminated unexpectedly"))).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith(
      "The connection that cancels a run failed:",
      "Connection terminated unexpectedly"
    );
  });
});

describe("cancelRunElsewhere", () => {
  it("tries again a moment later while the run is between two statements", async () => {
    const target = poolAnswering("idle", "idle", "cancelled");
    const answer = cancelRunElsewhere(target.pool, RUN);
    await flush(1000);
    await expect(answer).resolves.toBe("cancelled");
    expect(target.connect).toHaveBeenCalledTimes(3);
    for (const client of target.clients) {
      expect(client.queries[2].values).toEqual([`schema-studio run ${RUN}`, null]);
    }
  });

  it("gives up after eight tries, a quarter second apart", async () => {
    const target = poolAnswering("idle");
    const answer = cancelRunElsewhere(target.pool, RUN);
    await flush(1749);
    expect(target.connect).toHaveBeenCalledTimes(7);
    await flush(1);
    await expect(answer).resolves.toBe("idle");
    expect(target.connect).toHaveBeenCalledTimes(8);
  });

  it.each(["cancelled", "committing", "not_found"] as const)(
    "answers %s at once, without trying again",
    async (outcome) => {
      const target = poolAnswering(outcome);
      await expect(cancelRunElsewhere(target.pool, RUN)).resolves.toBe(outcome);
      expect(target.connect).toHaveBeenCalledTimes(1);
    }
  );

  it("passes a database error on at once", async () => {
    const target = fakePool([
      { match: /FROM pg_stat_activity/, error: { code: "42501", message: "permission denied to cancel query" } },
    ]);
    await expect(cancelRunElsewhere(target.pool, RUN)).rejects.toMatchObject({ code: "42501" });
    expect(target.connect).toHaveBeenCalledTimes(1);
  });
});

describe("formatLimit", () => {
  it.each<[number, string]>([
    [3_600_000, "1 hour"],
    [7_200_000, "2 hours"],
    [5_400_000, "90 minutes"],
    [1_800_000, "30 minutes"],
    [60_000, "1 minute"],
    [90_000, "90 seconds"],
    [45_000, "45 seconds"],
    [1_000, "1 second"],
  ])("writes %i ms as %s", (ms, text) => {
    expect(formatLimit(ms)).toBe(text);
  });
});

describe("runStopMessage", () => {
  const ctx = (over: Partial<StopContext> = {}): StopContext => ({
    kind: "deploy",
    dryRun: false,
    trial: false,
    limits: REAL_RUN_LIMITS,
    subject: null,
    ...over,
  });
  const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });
  const statementTimeout = pgError(QUERY_CANCELED, "canceling statement due to statement timeout");
  const userCancel = pgError(QUERY_CANCELED, "canceling statement due to user request");
  const idleTimeout = pgError("25P03", "terminating connection due to idle-in-transaction timeout");
  const adminShutdown = pgError("57P01", "terminating connection due to administrator command");
  const stoppedWith = (stopReason: RunEntry["stopReason"]) => ({ stopReason }) as RunEntry;

  describe("for a statement over its time limit", () => {
    it("in a real deploy", () => {
      expect(runStopMessage([statementTimeout], null, ctx())).toBe(
        "A statement ran longer than 30 minutes, the most one statement may take in a deploy, so the " +
          "deploy was stopped. Nothing was applied."
      );
    });

    it("names the script it was in", () => {
      expect(runStopMessage([statementTimeout], null, ctx({ subject: 'Version 3 of "orders"' }))).toBe(
        'Version 3 of "orders" had a statement that ran longer than 30 minutes, the most one statement ' +
          "may take in a deploy, so the deploy was stopped. Nothing was applied."
      );
    });

    it("in a real rollback", () => {
      expect(runStopMessage([statementTimeout], null, ctx({ kind: "rollback" }))).toBe(
        "A statement ran longer than 30 minutes, the most one statement may take in a rollback, so the " +
          "rollback was stopped. Nothing was changed, and every version in this rollback is still applied."
      );
    });

    it("in a dry run, saying a real deploy allows more", () => {
      expect(runStopMessage([statementTimeout], null, ctx({ dryRun: true, limits: DRY_RUN_LIMITS }))).toBe(
        "A statement ran longer than 5 minutes, the most one statement may take in a dry run, so the dry " +
          "run was stopped. Nothing was changed. A real deploy allows each statement 30 minutes, so the " +
          "script may still be fine, only slow on this much data."
      );
    });

    it("in the trial, dry or real, where a real run is no longer", () => {
      expect(
        runStopMessage([statementTimeout], null, ctx({ trial: true, dryRun: true, limits: TRIAL_RUN_LIMITS }))
      ).toBe(
        "A statement ran longer than 1 minute, the most one statement may take in the trial, so the dry " +
          "run was stopped. Nothing was changed."
      );
      expect(runStopMessage([statementTimeout], null, ctx({ trial: true, limits: TRIAL_RUN_LIMITS }))).toBe(
        "A statement ran longer than 1 minute, the most one statement may take in the trial, so the " +
          "deploy was stopped. Nothing was applied."
      );
    });

    it("even when Stop was pressed at the same moment, since the database says which it was", () => {
      expect(runStopMessage([statementTimeout], stoppedWith("cancelled"), ctx())).toMatch(
        /^A statement ran longer than 30 minutes/
      );
    });
  });

  describe("for the Stop button", () => {
    it("as the run's own next step found it", () => {
      expect(runStopMessage([new RunStoppedError("cancelled")], null, ctx())).toBe(
        "This deploy was stopped, as asked. Nothing was applied."
      );
    });

    it("as the cancelled statement found it", () => {
      expect(runStopMessage([userCancel], stoppedWith("cancelled"), ctx({ kind: "rollback" }))).toBe(
        "This rollback was stopped, as asked. Nothing was changed, and every version in this rollback " +
          "is still applied."
      );
    });

    it("in a dry run", () => {
      expect(
        runStopMessage([new RunStoppedError("cancelled")], null, ctx({ dryRun: true, limits: DRY_RUN_LIMITS }))
      ).toBe("This dry run was stopped, as asked. Nothing was changed.");
    });
  });

  describe("for the whole-run limit", () => {
    it.each<[string, Partial<StopContext>, string]>([
      [
        "a real deploy",
        {},
        "This deploy took longer than 1 hour, the most a deploy may take, so it was stopped. Nothing was applied.",
      ],
      [
        "a real rollback",
        { kind: "rollback" },
        "This rollback took longer than 1 hour, the most a rollback may take, so it was stopped. Nothing " +
          "was changed, and every version in this rollback is still applied.",
      ],
      [
        "a dry run",
        { dryRun: true, limits: DRY_RUN_LIMITS },
        "This dry run took longer than 15 minutes, the most a dry run may take, so it was stopped. Nothing " +
          "was changed.",
      ],
      [
        "a trial deploy",
        { trial: true, limits: TRIAL_RUN_LIMITS },
        "This deploy took longer than 4 minutes, the most a run in the trial may take, so it was stopped. " +
          "Nothing was applied.",
      ],
    ])("in %s", (_label, over, text) => {
      expect(runStopMessage([new RunStoppedError("run_limit")], null, ctx(over))).toBe(text);
      expect(runStopMessage([userCancel], stoppedWith("run_limit"), ctx(over))).toBe(text);
    });
  });

  it("says a cancel came from outside the run when nothing here stopped it", () => {
    const text =
      "A statement in this deploy was cancelled from outside it, by the Stop button or by another " +
      "database session, so the deploy was stopped. Nothing was applied.";
    expect(runStopMessage([userCancel], null, ctx())).toBe(text);
    expect(runStopMessage([userCancel], stoppedWith(null), ctx())).toBe(text);
    // A bare SQLSTATE with no message to read is still a cancel.
    expect(runStopMessage([{ code: QUERY_CANCELED }], null, ctx())).toBe(text);
  });

  describe("for the database ending the session", () => {
    it("after the run sat idle too long, as the connection reported between queries", () => {
      const notQueryable = new Error("Client has encountered a connection error and is not queryable");
      expect(runStopMessage([notQueryable, idleTimeout], null, ctx({ kind: "rollback" }))).toBe(
        "This rollback sat inside its transaction without sending anything for longer than 5 minutes, " +
          "so the database ended its session. Nothing was changed, and every version in this rollback " +
          "is still applied."
      );
    });

    it("after a minute idle in the trial", () => {
      expect(runStopMessage([idleTimeout], null, ctx({ trial: true, limits: TRIAL_RUN_LIMITS }))).toBe(
        "This deploy sat inside its transaction without sending anything for longer than 1 minute, so " +
          "the database ended its session. Nothing was applied."
      );
    });

    it("by an administrator's command", () => {
      expect(runStopMessage([adminShutdown], null, ctx())).toBe(
        "The database ended this deploy's session (an administrator, or another session, stopped it). " +
          "Nothing was applied."
      );
    });
  });

  it("reads the errors in order and goes by the first it knows", () => {
    expect(runStopMessage([new RunStoppedError("cancelled"), adminShutdown], null, ctx())).toBe(
      "This deploy was stopped, as asked. Nothing was applied."
    );
  });

  it("answers null for a run that ended some other way", () => {
    expect(runStopMessage([], null, ctx())).toBeNull();
    expect(runStopMessage([pgError("42601", 'syntax error at or near "SELEC"')], null, ctx())).toBeNull();
    expect(
      runStopMessage([null, undefined, "text", 42, { code: 57014 }], stoppedWith("cancelled"), ctx())
    ).toBeNull();
  });
});

describe("keepFirstClientError", () => {
  it("keeps the database's reason for ending a session, not pg's vaguer error after it", async () => {
    const client = createFakeClient([
      {
        match: /SELECT 1/,
        endsSession: { code: "25P03", message: "terminating connection due to idle-in-transaction timeout" },
      },
    ]);
    const clientError = keepFirstClientError(client as unknown as PoolClient);
    expect(clientError()).toBeNull();

    const thrown = await client.query("SELECT 1").then(
      () => null,
      (error: unknown) => error
    );
    // What the run's own query throws has no code, so only the connection's
    // first error can say why the session ended.
    expect(thrown).toMatchObject({ message: "Client has encountered a connection error and is not queryable" });
    expect((thrown as { code?: string }).code).toBeUndefined();
    expect(clientError()).toMatchObject({ code: "25P03" });
    expect(
      runStopMessage([thrown, clientError()], null, {
        kind: "deploy",
        dryRun: false,
        trial: true,
        limits: TRIAL_RUN_LIMITS,
        subject: null,
      })
    ).toBe(
      "This deploy sat inside its transaction without sending anything for longer than 1 minute, so " +
        "the database ended its session. Nothing was applied."
    );
  });
});
