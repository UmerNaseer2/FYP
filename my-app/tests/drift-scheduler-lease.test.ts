// drift-scheduler: only one copy of the app may run a tick.
//
// The guard against two overlapping ticks was a boolean in the process, which
// says nothing about the copy of the app running next to it. Two replicas — or
// a `next dev` left open beside a `next start`, which is how this happens on a
// laptop — each ran the whole schedule against the one metadata database. Every
// due schema was introspected twice a cadence, and every drift event written in
// "always" mode was written twice, so the audit feed showed each check twice.
//
// The metadata database is the only thing both copies can see, so the agreement
// about whose turn it is is made there, with a lease on one row. Not a lock:
// behind a transaction pooler a session lock lands on a server connection the
// app may never see again, and a frozen serverless instance would hold any lock
// for as long as its socket stays open. A lease ends by the database's clock.
//
// This file fakes the database, to pin what the scheduler does with each answer.
// tests/drift-lease-db.test.ts runs the same SQL on a real one.
import {
  driftSchedulerStatus,
  requestImmediateCheck,
  runSchedulerTick,
  startDriftScheduler,
  stopDriftScheduler,
} from "@/lib/drift-scheduler";

/** One row of the schedule, as loadEntries reads it. */
type ScheduledRow = {
  id: number;
  org_id: number;
  drift_check_interval_minutes: number;
  last_drift_check_at: string | null;
};

/**
 * One schema, on a cadence, never checked, so always due. It belongs to
 * organization 3, which the check has to be run in.
 */
const ONE_SCHEMA: ScheduledRow[] = [
  { id: 1, org_id: 3, drift_check_interval_minutes: 15, last_drift_check_at: null },
];

/** The one row of drift_scheduler_state, as far as this file cares. */
type StateRow = {
  holder: string | null;
  lastTickAt: Date | null;
  lastReport: unknown;
  // What the SQL's clock comparison would answer.
  recent: boolean;
};

const mockDb = {
  row: null as StateRow | null,
  schedule: ONE_SCHEMA,
  statements: [] as { text: string; params: unknown[] }[],
  connected: 0,
  query: async (text: string, params: unknown[] = []) => {
    mockDb.statements.push({ text, params });
    if (text.includes("FROM tracked_schemas")) return { rows: mockDb.schedule };
    // Ahead of the writes, because the finishing UPDATE also names last_report.
    if (/^\s*SELECT/.test(text) && text.includes("FROM drift_scheduler_state")) {
      const row = mockDb.row;
      return {
        rows: row
          ? [{ last_tick_at: row.lastTickAt, last_report: row.lastReport, recent: row.recent }]
          : [],
      };
    }
    if (text.includes("INSERT INTO drift_scheduler_state")) {
      if (mockDb.row?.holder) return { rows: [] };
      mockDb.row = { lastTickAt: null, lastReport: null, recent: true, ...mockDb.row, holder: params[1] as string };
      return { rows: [{ holder: params[1] }] };
    }
    if (text.includes("SET last_prune_at")) return { rows: [] };
    if (text.includes("SET holder = NULL")) {
      const row = mockDb.row;
      if (row && row.holder === params[0]) {
        row.holder = null;
        row.lastTickAt = new Date("2026-09-17T12:00:30Z");
        row.lastReport = JSON.parse(params[1] as string);
      }
      return { rows: [] };
    }
    if (text.includes("SET lease_until")) return { rows: [] };
    throw new Error(`A statement this fake does not know: ${text}`);
  },
};

// Relative paths on purpose: next/jest rewrites the @/ alias inside import
// statements only, so jest.mock("@/...") would not resolve.
jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: {
    query: (text: string, params?: unknown[]) => mockDb.query(text, params),
    connect: async () => {
      mockDb.connected += 1;
      throw new Error("The scheduler must not hold a connection.");
    },
  },
  syncMetadataTables: async () => undefined,
}));

/** The check, called with (orgId, trackedSchemaId, source, mode). */
const mockCheck = jest.fn<Promise<{ ok: true; run: { status: string } }>, unknown[]>(
  async () => ({ ok: true, run: { status: "in_sync" } })
);
jest.mock("../lib/drift-runner", () => ({
  runDriftCheck: (...args: unknown[]) => mockCheck(...args),
}));
const mockAlert = jest.fn(async (..._args: unknown[]) => undefined);
jest.mock("../lib/push-alerts", () => ({
  alertDriftChange: (...args: unknown[]) => mockAlert(...args),
}));
jest.mock("../lib/schema-metrics", () => ({
  pruneSchemaMetrics: async () => 0,
  METRIC_RETENTION_DAYS: 90,
}));

// The real after() throws outside a request.
const mockAfter = jest.fn<void, [() => unknown]>();
jest.mock("next/server", () => ({
  ...jest.requireActual("next/server"),
  after: (task: () => unknown) => mockAfter(task),
}));

// The factories above run before the module body, so they cannot close over
// ordinary lets — a `mock`-prefixed name is the exception jest allows.

const NOW = new Date("2026-09-17T12:00:00Z");

const written = () =>
  mockDb.statements
    .map((statement) => statement.text)
    .filter((text) => /UPDATE drift_scheduler_state/.test(text));

const savedVercel = process.env.VERCEL;
const savedScheduler = process.env.DRIFT_SCHEDULER;

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  // The scheduler keeps its counts on globalThis, so each test starts from a
  // process that has never ticked.
  globalThis.__driftSchedulerState = undefined;
  mockDb.row = null;
  mockDb.schedule = ONE_SCHEMA;
  mockDb.statements = [];
  mockDb.connected = 0;
  mockCheck.mockClear();
  mockAfter.mockClear();
  mockAlert.mockClear();
  delete process.env.VERCEL;
  delete process.env.DRIFT_SCHEDULER;
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  jest.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  stopDriftScheduler();
  jest.restoreAllMocks();
  restoreEnv("VERCEL", savedVercel);
  restoreEnv("DRIFT_SCHEDULER", savedScheduler);
});

describe("a tick another copy of the app is already running", () => {
  beforeEach(() => {
    mockDb.row = { holder: "the-other-copy", lastTickAt: null, lastReport: null, recent: true };
  });

  it("does no work at all", async () => {
    const report = await runSchedulerTick(NOW);
    // The schema was due. Without the lease this tick would have checked it,
    // and so would the copy that is checking it right now.
    expect(mockCheck).not.toHaveBeenCalled();
    expect(report).toEqual({ kind: "shared", line: expect.stringContaining("another copy of the app") });
  });

  it("writes nothing to the row", async () => {
    await runSchedulerTick(NOW);
    expect(written()).toEqual([]);
    expect(mockDb.row?.holder).toBe("the-other-copy");
    expect(mockDb.row?.lastReport).toBeNull();
  });
});

describe("a tick nobody else is running", () => {
  it("checks what is due", async () => {
    const report = await runSchedulerTick(NOW);
    expect(mockCheck).toHaveBeenCalledTimes(1);
    expect(report).toEqual({ kind: "by_org", byOrg: new Map([[3, "Checked 1."]]) });
  });

  it("runs each check in the organization its schema belongs to", async () => {
    await runSchedulerTick(NOW);
    // The tick reads schemas from every organization, so nothing else tells the
    // check whose rows it may read and write.
    expect(mockCheck.mock.calls[0]).toEqual([3, 1, "scheduled", "on_change"]);
  });

  it("passes each check's outcome to the phone alerts, in that organization", async () => {
    await runSchedulerTick(NOW);
    expect(mockAlert.mock.calls).toEqual([[3, { status: "in_sync" }]]);
  });

  it("has nothing to alert about when a check could not run", async () => {
    mockCheck.mockRejectedValueOnce(new Error("metadata database went away"));
    await runSchedulerTick(NOW);
    expect(mockAlert).not.toHaveBeenCalled();
  });

  it("gives the lease back under the name it took it", async () => {
    await runSchedulerTick(NOW);
    const taken = mockDb.statements.find(({ text }) => text.includes("INSERT INTO drift_scheduler_state"));
    const finished = mockDb.statements.find(({ text }) => text.includes("SET holder = NULL"));
    expect(typeof taken?.params[1]).toBe("string");
    expect(finished?.params[0]).toBe(taken?.params[1]);
    expect(mockDb.row?.holder).toBeNull();
  });

  it("takes each lease under a new name", async () => {
    await runSchedulerTick(NOW);
    await runSchedulerTick(new Date(NOW.getTime() + 60_000));
    const holders = mockDb.statements
      .filter(({ text }) => text.includes("INSERT INTO drift_scheduler_state"))
      .map(({ params }) => params[1]);
    expect(new Set(holders).size).toBe(2);
  });

  it("gives the lease back even when the tick blows up", async () => {
    // The failure mode that matters most: a tick that throws and keeps the
    // lease stops every copy of the app from checking anything until it expires.
    mockCheck.mockRejectedValueOnce(new Error("metadata database went away"));
    const report = await runSchedulerTick(NOW);
    expect(report).toEqual({ kind: "shared", line: expect.stringContaining("Tick failed") });
    expect(mockDb.row?.holder).toBeNull();
    expect(mockDb.row?.lastReport).toEqual({
      kind: "shared",
      line: expect.stringContaining("Tick failed"),
    });
  });

  it("takes no lock and holds no connection", async () => {
    // Either would stop working, or hang, behind a transaction pooler.
    await runSchedulerTick(NOW);
    expect(mockDb.connected).toBe(0);
    expect(mockDb.statements.filter(({ text }) => /pg_\w*advisory/.test(text))).toEqual([]);
  });

  it("never throws, even when the database is what went away", async () => {
    const query = jest.spyOn(mockDb, "query").mockRejectedValue(new Error("gone"));
    await expect(runSchedulerTick(NOW)).resolves.toEqual({
      kind: "shared",
      line: expect.stringContaining("Tick failed"),
    });
    query.mockRestore();
  });
});

describe("keeping the lease during a long tick", () => {
  // Only the renew interval is faked: everything else needs real promises.
  beforeEach(() => {
    jest.useFakeTimers({
      doNotFake: ["nextTick", "queueMicrotask", "setImmediate", "setTimeout", "clearTimeout", "Date"],
    });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  /** Lets a tick get as far as it can on promises alone. */
  async function settle() {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  }

  const renewals = () =>
    mockDb.statements.filter(
      ({ text }) => text.includes("SET lease_until") && !text.includes("INSERT INTO")
    );

  it("renews while a check runs, under its own name, and stops when the tick ends", async () => {
    let finish: (value: { ok: true; run: { status: string } }) => void = () => undefined;
    mockCheck.mockImplementationOnce(
      () => new Promise((resolve) => { finish = resolve; })
    );
    const tick = runSchedulerTick(NOW);
    await settle();
    expect(renewals()).toEqual([]);

    await jest.advanceTimersByTimeAsync(30_000);
    expect(renewals()).toHaveLength(1);
    const holder = mockDb.row?.holder;
    // $1 is the row's name and $2 the holder, so a copy whose lease was taken
    // over changes nothing.
    expect(renewals()[0].params[1]).toBe(holder);

    await jest.advanceTimersByTimeAsync(30_000);
    expect(renewals()).toHaveLength(2);

    finish({ ok: true, run: { status: "in_sync" } });
    await tick;
    await jest.advanceTimersByTimeAsync(120_000);
    expect(renewals()).toHaveLength(2);
  });
});

describe("what each organization is told about a tick", () => {
  // One tick checks every organization's due schemas together. A line or a
  // count that added them up would tell each organization how much drift and
  // how many unreachable databases the others have.
  const TWO_ORGS: ScheduledRow[] = [
    { id: 1, org_id: 3, drift_check_interval_minutes: 15, last_drift_check_at: null },
    { id: 2, org_id: 5, drift_check_interval_minutes: 15, last_drift_check_at: null },
    { id: 3, org_id: 5, drift_check_interval_minutes: 15, last_drift_check_at: null },
  ];

  beforeEach(() => {
    mockDb.schedule = TWO_ORGS;
    // Organization 5's databases have drifted; organization 3's has not.
    mockCheck.mockImplementation(async (orgId) => ({
      ok: true,
      run: { status: orgId === 5 ? "drifted" : "in_sync" },
    }));
  });
  afterEach(() => {
    mockCheck.mockReset();
    mockCheck.mockImplementation(async () => ({ ok: true, run: { status: "in_sync" } }));
  });

  it("gives each organization a line about its own schemas only", async () => {
    await runSchedulerTick(NOW);
    expect((await driftSchedulerStatus(3)).lastTickSummary).toBe("Checked 1.");
    expect((await driftSchedulerStatus(5)).lastTickSummary).toBe("Checked 2 · 2 drifted.");
  });

  it("reads the same line on a copy of the app that did not run the tick", async () => {
    // Behind a load balancer the next request lands on another instance, whose
    // memory knows nothing about a tick this one ran.
    await runSchedulerTick(NOW);
    globalThis.__driftSchedulerState = undefined;
    expect((await driftSchedulerStatus(3)).lastTickSummary).toBe("Checked 1.");
    expect((await driftSchedulerStatus(5)).lastTickSummary).toBe("Checked 2 · 2 drifted.");
    expect((await driftSchedulerStatus(5)).lastTickAt).toBe("2026-09-17T12:00:30.000Z");
  });

  it("counts each organization's checks apart", async () => {
    await runSchedulerTick(NOW);
    await runSchedulerTick(new Date("2026-09-17T12:01:00Z"));
    // The fake never stamps a check, so every schema is due on both ticks.
    expect((await driftSchedulerStatus(3)).checksRun).toBe(2);
    expect((await driftSchedulerStatus(5)).checksRun).toBe(4);
  });

  it("tells an organization with nothing on a cadence just that", async () => {
    await runSchedulerTick(NOW);
    expect(await driftSchedulerStatus(9)).toMatchObject({
      checksRun: 0,
      lastTickSummary: expect.stringContaining("Nothing scheduled"),
    });
  });

  it("says which of an organization's due schemas the tick did not reach", async () => {
    // Eight schemas due in organization 5 and one in organization 3: the tick
    // stops at six, most overdue first, so three of them wait for the next one.
    mockDb.schedule = [
      { id: 1, org_id: 3, drift_check_interval_minutes: 15, last_drift_check_at: null },
      ...Array.from({ length: 8 }, (_, i) => ({
        id: 10 + i,
        org_id: 5,
        drift_check_interval_minutes: 15,
        last_drift_check_at: "2026-09-17T09:00:00Z",
      })),
    ];
    await runSchedulerTick(NOW);
    expect((await driftSchedulerStatus(3)).lastTickSummary).toBe("Checked 1.");
    expect((await driftSchedulerStatus(5)).lastTickSummary).toBe(
      "Checked 5 · 5 drifted · 3 more waiting for the next tick."
    );
  });

  it("keeps a failed check's error out of the line every organization sees", async () => {
    // The error can come from any organization's database, its host and all.
    mockCheck.mockRejectedValueOnce(new Error("could not reach db.org-five.internal"));
    await runSchedulerTick(NOW);
    for (const orgId of [3, 5]) {
      const line = (await driftSchedulerStatus(orgId)).lastTickSummary;
      expect(line).toContain("Tick failed");
      expect(line).not.toContain("org-five");
    }
  });
});

describe("the status before any tick", () => {
  it("has nothing to report, and sends no error for a row that is not there", async () => {
    expect(await driftSchedulerStatus(3)).toMatchObject({
      running: false,
      lastTickAt: null,
      lastTickSummary: null,
      external: false,
    });
  });
});

describe("on a host with no process to keep a timer in", () => {
  beforeEach(() => {
    process.env.VERCEL = "1";
  });

  it("starts no timer and sends nothing to the database", () => {
    const interval = jest.spyOn(global, "setInterval");
    startDriftScheduler();
    expect(interval).not.toHaveBeenCalled();
    expect(mockDb.statements).toEqual([]);
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it("reads as running when a call has come in lately", async () => {
    mockDb.row = { holder: null, lastTickAt: NOW, lastReport: null, recent: true };
    expect(await driftSchedulerStatus(3)).toMatchObject({
      running: true,
      stoppedReason: null,
      external: true,
    });
  });

  it("says plainly when no call has come in", async () => {
    mockDb.row = { holder: null, lastTickAt: NOW, lastReport: null, recent: false };
    const status = await driftSchedulerStatus(3);
    expect(status.running).toBe(false);
    expect(status.stoppedReason).toContain("no scheduled call has reached this server");
    expect(status.stoppedReason).toContain("deploy/SUPABASE-VERCEL.md");
  });

  it("says the same when no call has ever come in", async () => {
    const status = await driftSchedulerStatus(3);
    expect(status.running).toBe(false);
    expect(status.stoppedReason).toContain("no scheduled call has reached this server");
  });

  it("does not claim a count it cannot know", async () => {
    // Each instance counts only its own ticks and is thrown away after minutes,
    // so any number here would look wrong to whoever reads it twice.
    await runSchedulerTick(NOW);
    expect((await driftSchedulerStatus(3)).checksRun).toBeNull();
  });

  it("keeps an immediate check alive past the response", async () => {
    requestImmediateCheck(3, 1);
    // Not started yet: a floating promise could be frozen with the function.
    expect(mockCheck).not.toHaveBeenCalled();
    expect(mockAfter).toHaveBeenCalledTimes(1);
    await mockAfter.mock.calls[0][0]();
    expect(mockCheck).toHaveBeenCalledWith(3, 1, "tracking", "always");
  });

  it("is still turned off by DRIFT_SCHEDULER=off", () => {
    process.env.DRIFT_SCHEDULER = "off";
    requestImmediateCheck(3, 1);
    expect(mockAfter).not.toHaveBeenCalled();
    expect(mockCheck).not.toHaveBeenCalled();
  });
});

describe("DRIFT_SCHEDULER=external, anywhere", () => {
  it("wakes by a call even where a timer would work", async () => {
    process.env.DRIFT_SCHEDULER = "external";
    const interval = jest.spyOn(global, "setInterval");
    startDriftScheduler();
    expect(interval).not.toHaveBeenCalled();
    expect((await driftSchedulerStatus(3)).external).toBe(true);
  });
});

describe("on a server that stays up", () => {
  it("starts its timer, and reads as running from it", async () => {
    startDriftScheduler();
    expect(await driftSchedulerStatus(3)).toMatchObject({
      running: true,
      stoppedReason: null,
      external: false,
    });
    // Its first tick, started at once, may still be running.
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  });

  it("runs an immediate check straight away, because after() throws outside a request", () => {
    requestImmediateCheck(3, 1);
    expect(mockAfter).not.toHaveBeenCalled();
    expect(mockCheck).toHaveBeenCalledWith(3, 1, "tracking", "always");
  });

  it("does nothing for an immediate check when it is turned off", () => {
    process.env.DRIFT_SCHEDULER = "off";
    requestImmediateCheck(3, 1);
    expect(mockCheck).not.toHaveBeenCalled();
  });
});
