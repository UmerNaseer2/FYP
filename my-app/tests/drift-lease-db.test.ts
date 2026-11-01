// The drift checker's lease, against a real Postgres.
//
// tests/drift-scheduler-lease.test.ts covers the decisions against a fake
// database, and a fake cannot say whether the SQL does what it claims: that a row
// with time left refuses a second taker, that one which ran out hands over, and
// that a copy which lost its lease leaves the new holder's row alone. Those are
// what stop two copies checking every schema twice, or a dead copy silently
// stopping the schedule, so they are checked here on the real thing.
//
// The checks themselves are stand-ins (tests/org-data-db.test.ts runs real ones):
// here they only need to take as long as a test says they do.
//
// Needs a Postgres it may create and drop databases in, runs only when
// TEST_DATABASE_URL is set (CI sets it, and fails rather than skip without it: see
// tests/helpers/test-database.ts), and only against a database whose name contains
// "test". tests/invites-db.test.ts shows how to start one locally.
import { Client } from "pg";
import { testDatabaseUrl } from "./helpers/test-database";

const testUrl = testDatabaseUrl();
const describeWithDatabase = testUrl ? describe : describe.skip;
const SLOW = 60_000;
const SETUP = 120_000;

const mockCheck = jest.fn();
jest.mock("../lib/drift-runner", () => ({
  runDriftCheck: (...args: unknown[]) => mockCheck(...args),
}));

const mockPrune = jest.fn(async () => 0);
jest.mock("../lib/schema-metrics", () => ({
  METRIC_RETENTION_DAYS: 30,
  pruneSchemaMetrics: () => mockPrune(),
}));

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function urlFor(name: string): string {
  const url = new URL(testUrl);
  url.pathname = "/" + encodeURIComponent(name);
  return url.toString();
}

async function connectTo(url: string): Promise<Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

/** Wait for something another copy is doing, with a failure that says what. */
async function until(what: string, condition: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Still waiting for ${what}.`);
}

const IN_SYNC = { ok: true, run: { status: "in_sync" } };

type StateRow = {
  holder: string | null;
  lease_until: Date | null;
  last_tick_at: Date | null;
  last_report: { kind: string; line?: string; byOrg?: Record<string, string> } | null;
  last_prune_at: Date | null;
};

describeWithDatabase("the drift checker's lease on a real database", () => {
  const savedUrl = process.env.DATABASE_URL_A;
  const savedDesktop = process.env.SCHEMA_STUDIO_DESKTOP;
  const savedVercel = process.env.VERCEL;
  const savedScheduler = process.env.DRIFT_SCHEDULER;
  let server: Client;
  let db: Client;
  let databaseName = "";
  let sequelize: typeof import("@/lib/db/sequelize").sequelize;
  let pool: typeof import("@/lib/db/sequelize").metadataPool;
  let scheduler: typeof import("@/lib/drift-scheduler");
  let orgA = 0;
  let orgB = 0;
  let schemaA = 0;
  let schemaB = 0;

  async function stateRow(): Promise<StateRow | undefined> {
    const { rows } = await db.query(
      `SELECT holder, lease_until, last_tick_at, last_report, last_prune_at
         FROM drift_scheduler_state
        WHERE name = 'tick'`
    );
    return rows[0];
  }

  /** A tick as a brand new instance of the app would run it. */
  function tickAsNewCopy() {
    globalThis.__driftSchedulerState = undefined;
    return scheduler.runSchedulerTick();
  }

  /** Make every check wait until the test lets go of it. */
  function holdChecks(): () => void {
    let letGo = () => {};
    const held = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    mockCheck.mockImplementation(async () => {
      await held;
      return IN_SYNC;
    });
    return letGo;
  }

  async function addSchema(orgId: number, name: string): Promise<number> {
    const { rows: connections } = await db.query(
      `INSERT INTO connections (org_id, name, host, username, password)
       VALUES ($1, $2, 'probe.invalid', 'probe', 'not-a-real-password') RETURNING id`,
      [orgId, name]
    );
    const { rows: schemas } = await db.query(
      `INSERT INTO tracked_schemas (org_id, connection_id, schema_name, drift_check_interval_minutes)
       VALUES ($1, $2, 'probe_schema', 15) RETURNING id`,
      [orgId, connections[0].id]
    );
    return schemas[0].id;
  }

  beforeAll(async () => {
    const baseName = decodeURIComponent(new URL(testUrl).pathname.slice(1));
    if (!/test/i.test(baseName)) {
      throw new Error(
        `TEST_DATABASE_URL names "${baseName}". These tests create and drop databases, ` +
          `so they only run against one whose name contains "test".`
      );
    }
    server = await connectTo(testUrl);
    databaseName = `${baseName}_lease`;
    await server.query(`DROP DATABASE IF EXISTS ${quoteIdent(databaseName)} WITH (FORCE)`);
    await server.query(`CREATE DATABASE ${quoteIdent(databaseName)}`);
    const url = urlFor(databaseName);

    jest.resetModules();
    globalThis.__metadataSequelize = undefined;
    process.env.DATABASE_URL_A = url;
    delete process.env.SCHEMA_STUDIO_DESKTOP;
    delete process.env.VERCEL;
    delete process.env.DRIFT_SCHEDULER;
    const bootstrap = await import("@/lib/db/bootstrap");
    await bootstrap.syncMetadataTables();
    ({ sequelize, metadataPool: pool } = await import("@/lib/db/sequelize"));
    scheduler = await import("@/lib/drift-scheduler");
    db = await connectTo(url);

    const { rows: orgs } = await db.query(`SELECT id FROM organizations WHERE is_default`);
    orgA = orgs[0].id;
    const { rows: others } = await db.query(
      `INSERT INTO organizations (slug, name) VALUES ('other-org', 'Other org') RETURNING id`
    );
    orgB = others[0].id;
    schemaA = await addSchema(orgA, "probe-a");
    schemaB = await addSchema(orgB, "probe-b");
  }, SETUP);

  beforeEach(async () => {
    await db.query(`DELETE FROM drift_scheduler_state`);
    mockCheck.mockReset();
    mockCheck.mockResolvedValue(IN_SYNC);
    mockPrune.mockClear();
    delete process.env.VERCEL;
    globalThis.__driftSchedulerState = undefined;
  });

  afterAll(async () => {
    if (sequelize) {
      const connections = (sequelize.connectionManager as unknown as {
        pool: { using: number; waiting: number };
      }).pool;
      await until("the metadata pool to go idle", () => connections.using === 0 && connections.waiting === 0);
      await sequelize.close();
    }
    globalThis.__metadataSequelize = undefined;
    globalThis.__driftSchedulerState = undefined;
    const restore = (name: string, value: string | undefined) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore("DATABASE_URL_A", savedUrl);
    restore("SCHEMA_STUDIO_DESKTOP", savedDesktop);
    restore("VERCEL", savedVercel);
    restore("DRIFT_SCHEDULER", savedScheduler);
    await db?.end();
    if (server) {
      if (databaseName) {
        await server.query(`DROP DATABASE IF EXISTS ${quoteIdent(databaseName)} WITH (FORCE)`);
      }
      await server.end();
    }
  }, SETUP);

  describe("whose turn it is", () => {
    it("gives a tick to exactly one of eight copies that start together", async () => {
      const letGo = holdChecks();
      const finished: { kind: string; line?: string }[] = [];
      const copies = Array.from({ length: 8 }, () =>
        tickAsNewCopy().then((report) => {
          finished.push(report as { kind: string; line?: string });
          return report;
        })
      );

      // The winner's checks stay held until the other seven have answered.
      // Otherwise the lease would be free again and a late copy could rightly win.
      await until("seven copies to stand down and one to start checking", () => {
        return finished.length === 7 && mockCheck.mock.calls.length === 2;
      });
      for (const report of finished) {
        expect(report.line).toMatch(/another copy/);
      }
      expect(mockCheck.mock.calls.map((call) => call[1]).sort()).toEqual([schemaA, schemaB].sort());

      letGo();
      const reports = await Promise.all(copies);
      expect(reports.filter((report) => report.kind === "by_org")).toHaveLength(1);
      expect(mockCheck).toHaveBeenCalledTimes(2);
    }, SLOW);

    it("stands down while another copy's lease has time left, and leaves its row alone", async () => {
      await db.query(
        `INSERT INTO drift_scheduler_state (name, holder, lease_until)
         VALUES ('tick', 'someone-else', now() + interval '2 minutes')`
      );
      const before = await stateRow();

      const report = await tickAsNewCopy();

      expect(report).toEqual({ kind: "shared", line: expect.stringMatching(/another copy/) });
      expect(mockCheck).not.toHaveBeenCalled();
      expect(await stateRow()).toEqual(before);
    }, SLOW);

    it("takes over from a copy that died, once its lease runs out", async () => {
      await db.query(
        `INSERT INTO drift_scheduler_state (name, holder, lease_until)
         VALUES ('tick', 'dead', now() - interval '1 second')`
      );

      const report = await tickAsNewCopy();

      expect(report.kind).toBe("by_org");
      expect(mockCheck).toHaveBeenCalledTimes(2);
      const row = await stateRow();
      expect(row?.holder).toBeNull();
      expect(row?.lease_until).toBeNull();
    }, SLOW);

    it("frees the lease at the end, so the next tick need not wait for it to run out", async () => {
      await tickAsNewCopy();
      const row = await stateRow();
      expect(row?.holder).toBeNull();
      expect(row?.lease_until).toBeNull();

      expect((await tickAsNewCopy()).kind).toBe("by_org");
    }, SLOW);

    it("frees the lease after a failed tick too, and writes down a line that names nothing", async () => {
      // A check's message can name one organization's database host, and this
      // line goes to every organization.
      const logged = jest.spyOn(console, "error").mockImplementation(() => {});
      mockCheck.mockRejectedValue(new Error("connect failed at private-host.invalid"));

      const report = await tickAsNewCopy();
      logged.mockRestore();

      expect(report).toEqual({ kind: "shared", line: expect.stringMatching(/^Tick failed/) });
      const row = await stateRow();
      expect(row?.holder).toBeNull();
      expect(row?.lease_until).toBeNull();
      expect(JSON.stringify(row?.last_report)).not.toMatch(/private-host/);
    }, SLOW);

    it("leaves the new holder's row alone when its own lease was taken during a long tick", async () => {
      // The instance froze for longer than the lease, and another copy moved in.
      const letGo = holdChecks();
      const tick = tickAsNewCopy();
      await until("the tick to start checking", () => mockCheck.mock.calls.length > 0);
      await db.query(
        `UPDATE drift_scheduler_state
            SET holder = 'newer',
                lease_until = now() + interval '2 minutes',
                last_report = '{"kind":"shared","line":"the newer copy wrote this"}'`
      );
      const before = await stateRow();

      letGo();
      await tick;

      expect(await stateRow()).toEqual(before);
    }, SLOW);
  });

  describe("a tick that runs long", () => {
    // Only the renew timer is faked. The rest of the machinery, the connection
    // pool included, carries on in real time against a real database.
    const ONLY_INTERVALS = {
      doNotFake: [
        "Date",
        "hrtime",
        "nextTick",
        "performance",
        "queueMicrotask",
        "requestAnimationFrame",
        "cancelAnimationFrame",
        "requestIdleCallback",
        "cancelIdleCallback",
        "setImmediate",
        "clearImmediate",
        "setTimeout",
        "clearTimeout",
      ],
    } as Parameters<typeof jest.useFakeTimers>[0];

    /** Fire the renew timer, and wait for the statement it sends to finish. */
    async function renewTimerFires(): Promise<void> {
      const sent = jest.spyOn(pool, "query");
      jest.advanceTimersByTime(30_000);
      const renewals = sent.mock.calls.filter(([text]) => text.includes("SET lease_until"));
      expect(renewals).toHaveLength(1);
      await Promise.all(sent.mock.results.map((result) => result.value));
      sent.mockRestore();
    }

    afterEach(() => {
      jest.useRealTimers();
    });

    it("keeps its lease going", async () => {
      jest.useFakeTimers(ONLY_INTERVALS);
      const letGo = holdChecks();
      const tick = tickAsNewCopy();
      await until("the tick to start checking", () => mockCheck.mock.calls.length > 0);
      await db.query(`UPDATE drift_scheduler_state SET lease_until = now() + interval '5 seconds'`);

      await renewTimerFires();

      const { rows } = await db.query(
        `SELECT EXTRACT(EPOCH FROM lease_until - now())::float AS left FROM drift_scheduler_state`
      );
      expect(rows[0].left).toBeGreaterThan(170);
      letGo();
      await tick;
    }, SLOW);

    it("does not renew a lease another copy holds now", async () => {
      jest.useFakeTimers(ONLY_INTERVALS);
      const letGo = holdChecks();
      const tick = tickAsNewCopy();
      await until("the tick to start checking", () => mockCheck.mock.calls.length > 0);
      await db.query(
        `UPDATE drift_scheduler_state SET holder = 'newer', lease_until = now() + interval '5 seconds'`
      );
      const before = await stateRow();

      await renewTimerFires();

      expect(await stateRow()).toEqual(before);
      letGo();
      await tick;
    }, SLOW);

    it("stops renewing once the tick is over", async () => {
      jest.useFakeTimers(ONLY_INTERVALS);
      await tickAsNewCopy();
      const sent = jest.spyOn(pool, "query");

      jest.advanceTimersByTime(120_000);

      expect(sent).not.toHaveBeenCalled();
      sent.mockRestore();
    }, SLOW);
  });

  describe("what the schedule screen reads", () => {
    it("tells each organization about its own schemas, even from an instance that ran no tick", async () => {
      mockCheck.mockImplementation(async (orgId: number) => {
        return { ok: true, run: { status: orgId === orgA ? "in_sync" : "drifted" } };
      });
      await tickAsNewCopy();

      // The status comes from a different instance from the tick, on a host with
      // no process left running. Everything it says has to have been in the row.
      globalThis.__driftSchedulerState = undefined;
      const [statusA, statusB] = await Promise.all([
        scheduler.driftSchedulerStatus(orgA),
        scheduler.driftSchedulerStatus(orgB),
      ]);

      expect(statusA.lastTickSummary).toBe("Checked 1.");
      expect(statusB.lastTickSummary).toBe("Checked 1 · 1 drifted.");
      const stamp = statusA.lastTickAt as string;
      expect(new Date(stamp).toISOString()).toBe(stamp);
      expect(Math.abs(Date.now() - Date.parse(stamp))).toBeLessThan(60_000);
    }, SLOW);

    it("tells an organization the tick had nothing for that it has nothing scheduled", async () => {
      await tickAsNewCopy();
      const status = await scheduler.driftSchedulerStatus(orgA + orgB + 1000);
      expect(status.lastTickSummary).toMatch(/^Nothing scheduled/);
    }, SLOW);

    it("shows a failed tick's line to every organization", async () => {
      const logged = jest.spyOn(console, "error").mockImplementation(() => {});
      mockCheck.mockRejectedValue(new Error("boom"));
      await tickAsNewCopy();
      logged.mockRestore();

      const status = await scheduler.driftSchedulerStatus(orgB);
      expect(status.lastTickSummary).toMatch(/^Tick failed/);
    }, SLOW);

    it("has nothing to say before the first tick", async () => {
      const status = await scheduler.driftSchedulerStatus(orgA);
      expect(status.lastTickAt).toBeNull();
      expect(status.lastTickSummary).toBeNull();
    }, SLOW);
  });

  describe("pruning old readings", () => {
    it("happens once in a window, by the database's clock, however many instances come and go", async () => {
      await tickAsNewCopy();
      expect(mockPrune).toHaveBeenCalledTimes(1);

      // A new instance knows nothing, and must not take that as "never pruned".
      await tickAsNewCopy();
      expect(mockPrune).toHaveBeenCalledTimes(1);

      await db.query(`UPDATE drift_scheduler_state SET last_prune_at = now() - interval '5 hours'`);
      await tickAsNewCopy();
      expect(mockPrune).toHaveBeenCalledTimes(1);

      await db.query(`UPDATE drift_scheduler_state SET last_prune_at = now() - interval '7 hours'`);
      await tickAsNewCopy();
      expect(mockPrune).toHaveBeenCalledTimes(2);
    }, SLOW);
  });

  describe("on a host with no process left running", () => {
    beforeEach(() => {
      process.env.VERCEL = "1";
    });

    it("reads as running just after a scheduled call", async () => {
      await tickAsNewCopy();
      const status = await scheduler.driftSchedulerStatus(orgA);
      expect(status).toMatchObject({
        running: true,
        stoppedReason: null,
        external: true,
        checksRun: null,
      });
    }, SLOW);

    it("reads as running during a tick that has been going for a while", async () => {
      await db.query(
        `INSERT INTO drift_scheduler_state (name, holder, lease_until, last_tick_at)
         VALUES ('tick', 'busy', now() + interval '1 minute', now() - interval '6 minutes')`
      );
      expect((await scheduler.driftSchedulerStatus(orgA)).running).toBe(true);
    }, SLOW);

    it("reads as not running when the calls have stopped, and says what to do", async () => {
      await tickAsNewCopy();
      await db.query(`UPDATE drift_scheduler_state SET last_tick_at = now() - interval '6 minutes'`);

      const status = await scheduler.driftSchedulerStatus(orgA);

      expect(status.running).toBe(false);
      expect(status.stoppedReason).toMatch(/no scheduled call has reached this server/);
      // What the last pass did is still true, and still worth showing.
      expect(status.lastTickSummary).toBe("Checked 1.");
    }, SLOW);

    it("does not count a lease that ran out as somebody working", async () => {
      await db.query(
        `INSERT INTO drift_scheduler_state (name, holder, lease_until, last_tick_at)
         VALUES ('tick', 'dead', now() - interval '1 second', now() - interval '6 minutes')`
      );
      expect((await scheduler.driftSchedulerStatus(orgA)).running).toBe(false);
    }, SLOW);

    it("reads as not running before the first call ever", async () => {
      const status = await scheduler.driftSchedulerStatus(orgA);
      expect(status.running).toBe(false);
      expect(status.stoppedReason).toMatch(/no scheduled call has reached this server/);
    }, SLOW);
  });
});
