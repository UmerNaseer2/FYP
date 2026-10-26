// org-data-db: two organizations in one real metadata database, and every
// place the app writes or reads their data.
//
// The route and library tests elsewhere check that each statement is SENT with
// the caller's organization. Only Postgres can say whether the statement then
// does what it claims: whether `INSERT ... SELECT org_id FROM connections
// WHERE id = $1 AND org_id = $2` really writes nothing for another
// organization's connection, whether a join really matches on org_id, whether
// a lookup by name really stays inside one organization. So this file seeds a
// second organization next to the default one, gives each a connection, and
// drives the real code against both: the track, re-baseline and acknowledge
// routes, the lineage reads, the drift writers and the scheduler tick, query
// history, thresholds, comparison sets and their runs, approvals and the
// deploy trail. Each one must work inside its own organization and, given
// the other organization's row, behave as though that row did not exist.
//
// Nothing is dialled. The snapshot reader and the size reader are stand-ins
// that answer as a reachable database would, and the gate is a stand-in that
// signs the request in as an Admin of whichever organization the test picks.
//
// It needs a Postgres it may create and drop databases in, so it runs only when
// TEST_DATABASE_URL is set (CI sets it, and fails rather than skip without it:
// see tests/helpers/test-database.ts), and only against a database whose name
// contains "test". To run it locally:
//
//   docker run -d --name ss-migration-test -p 127.0.0.1:55432:5432 \
//     -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=schema_studio_test \
//     postgres:17-alpine
//   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/schema_studio_test \
//     npx jest tests/org-data-db.test.ts
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { Client } from "pg";
import type { SchemaSnapshot } from "@/lib/postgres";
import type { RunPair, RunRecord } from "@/lib/comparison-history-db";
import type { RecordQueryInput } from "@/lib/query-history-db";
import type { SaveComparisonSetInput } from "@/lib/comparison-set-rules";
import type { ApprovalScript } from "@/lib/approval-fingerprint";
import { column, schema, table } from "./helpers/snapshots";
import { testDatabaseUrl } from "./helpers/test-database";

type Org = { id: number; slug: string; name: string };

/** The organization the stand-in gate signs the next request into. */
let mockOrg: Org = { id: 0, slug: "", name: "" };

jest.mock("../lib/auth-guard", () => ({
  requirePermission: async () => ({
    ok: true,
    principal: require("./helpers/principals").principalFor("admin", {
      orgId: mockOrg.id,
      orgSlug: mockOrg.slug,
      orgName: mockOrg.name,
    }),
  }),
}));

/** What the live schema looks like on the next read. */
const BASE = schema([table("books", [column("id")])]);
const DRIFTED = schema([table("books", [column("id")]), table("authors", [column("id")])]);
let mockLive: SchemaSnapshot = BASE;

const mockFetch = jest.fn<Promise<unknown>, unknown[]>(async () => ({
  ok: true as const,
  data: mockLive,
}));

/**
 * A target database that answers the size query and nothing else.
 *
 * The size reader runs BEGIN, SET LOCAL, one SELECT and COMMIT. The numbers are
 * what a tiny schema would report, and a sample that carries them shows the
 * reader found its connection through the organization-matched join.
 */
const mockTargetPool = {
  connect: async () => ({
    query: async (text: string) =>
      text.includes("pg_total_relation_size")
        ? { rows: [{ total_bytes: "8192", index_bytes: "0", estimated_rows: "0" }] }
        : { rows: [] },
    release: () => undefined,
  }),
};

jest.mock("../lib/postgres", () => ({
  ...jest.requireActual("../lib/postgres"),
  fetchSchemaSnapshot: (...args: unknown[]) => mockFetch(...args),
  getPoolForConfig: () => mockTargetPool,
}));

// The saved passwords below are not real ciphertext, so the config builder,
// which would decrypt them, hands back a fixed config instead.
jest.mock("../lib/connection-config", () => ({
  ...jest.requireActual("../lib/connection-config"),
  buildPgConfig: () => ({ host: "db.example.test", port: 5432, database: "shop", user: "reader" }),
}));

// Tracking a schema asks the scheduler for an early check. The test runs the
// scheduler's tick itself, when it chooses, so that request is only recorded.
const mockRequestImmediateCheck = jest.fn<void, unknown[]>();
jest.mock("../lib/drift-scheduler", () => ({
  ...jest.requireActual("../lib/drift-scheduler"),
  requestImmediateCheck: (...args: unknown[]) => mockRequestImmediateCheck(...args),
}));

const testUrl = testDatabaseUrl();
const describeWithDatabase = testUrl ? describe : describe.skip;

// Made up on every run. The connections these tests write are never opened.
const FAKE_PASSWORD = randomUUID();

const SLOW = 60_000;
const SETUP = 120_000;

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

describeWithDatabase("two organizations in one metadata database", () => {
  const savedUrl = process.env.DATABASE_URL_A;
  const savedDesktop = process.env.SCHEMA_STUDIO_DESKTOP;
  let server: Client;
  let db: Client;
  let databaseName = "";

  // The code under test. Imported after DATABASE_URL_A points at the fresh
  // database, so every module shares the one Sequelize pool made for it.
  let sequelize: typeof import("@/lib/db/sequelize").sequelize;
  let track: typeof import("@/app/api/lineage/track/route");
  let rebaseline: typeof import("@/app/api/lineage/rebaseline/route");
  let acknowledge: typeof import("@/app/api/lineage/acknowledge/route");
  let lineage: typeof import("@/lib/lineage-db");
  let driftRunner: typeof import("@/lib/drift-runner");
  let scheduler: typeof import("@/lib/drift-scheduler");
  let metrics: typeof import("@/lib/schema-metrics");
  let queries: typeof import("@/lib/query-history-db");
  let thresholds: typeof import("@/lib/perf-thresholds-db");
  let sets: typeof import("@/lib/comparison-sets");
  let runs: typeof import("@/lib/comparison-history-db");
  let approvals: typeof import("@/lib/approvals-db");
  let attempts: typeof import("@/lib/deploy-attempts-db");

  let orgA: Org;
  let orgB: Org;
  /** One saved connection in each organization. */
  let connA = 0;
  let connB = 0;
  /** "public" tracked in each organization, and "sales" in A, from the routes. */
  let trackedA = 0;
  let trackedB = 0;
  let salesA = 0;

  async function rows<T>(text: string, values: unknown[] = []): Promise<T[]> {
    return (await db.query(text, values)).rows as T[];
  }

  async function count(text: string, values: unknown[] = []): Promise<number> {
    const [row] = await rows<{ n: number }>(text, values);
    return row.n;
  }

  async function post(
    handler: (request: NextRequest) => Promise<Response>,
    path: string,
    org: Org,
    body: unknown
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    mockOrg = org;
    const request = new NextRequest(`http://localhost:3000${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    const response = await handler(request);
    return { status: response.status, body: await response.json() };
  }

  async function trackAs(org: Org, connectionId: number, schemaName: string): Promise<number> {
    const result = await post(track.POST, "/api/lineage/track", org, {
      connectionId,
      schemaName,
    });
    expect(result.status).toBe(201);
    return (result.body.trackedSchema as { id: number }).id;
  }

  /**
   * Wait until the metadata pool has nothing in flight.
   *
   * Recording a query starts a prune it does not wait for, on purpose (the
   * caller has its answer already). Closing the pool under that prune would
   * fail it, and a test that ends while it runs would lose its log line to
   * the next test's spy. Three idle readings in a row, 20 ms apart, rather
   * than one, because the prune borrows its connection a moment after the
   * insert hands one back.
   */
  async function settle(): Promise<void> {
    const pool = (sequelize.connectionManager as unknown as {
      pool: { using: number; waiting: number };
    }).pool;
    let idle = 0;
    for (let attempt = 0; attempt < 250 && idle < 3; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      idle = pool.using === 0 && pool.waiting === 0 ? idle + 1 : 0;
    }
    if (idle < 3) throw new Error("The metadata pool never went idle.");
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
    databaseName = `${baseName}_data`;
    await server.query(`DROP DATABASE IF EXISTS ${quoteIdent(databaseName)} WITH (FORCE)`);
    await server.query(`CREATE DATABASE ${quoteIdent(databaseName)}`);
    const url = urlFor(databaseName);

    jest.resetModules();
    globalThis.__metadataSequelize = undefined;
    process.env.DATABASE_URL_A = url;
    delete process.env.SCHEMA_STUDIO_DESKTOP;
    const { syncMetadataTables } = await import("@/lib/db/bootstrap");
    await syncMetadataTables();
    ({ sequelize } = await import("@/lib/db/sequelize"));
    track = await import("@/app/api/lineage/track/route");
    rebaseline = await import("@/app/api/lineage/rebaseline/route");
    acknowledge = await import("@/app/api/lineage/acknowledge/route");
    lineage = await import("@/lib/lineage-db");
    driftRunner = await import("@/lib/drift-runner");
    scheduler = await import("@/lib/drift-scheduler");
    metrics = await import("@/lib/schema-metrics");
    queries = await import("@/lib/query-history-db");
    thresholds = await import("@/lib/perf-thresholds-db");
    sets = await import("@/lib/comparison-sets");
    runs = await import("@/lib/comparison-history-db");
    approvals = await import("@/lib/approvals-db");
    attempts = await import("@/lib/deploy-attempts-db");

    db = await connectTo(url);
    [orgA] = await rows<Org>(`SELECT id, slug, name FROM organizations WHERE is_default`);
    [orgB] = await rows<Org>(
      `INSERT INTO organizations (slug, name) VALUES ('other-org', 'Other org')
       RETURNING id, slug, name`
    );
    // The same name in both, which is allowed: names only have to make sense
    // to the people inside one organization.
    const addConnection = async (org: Org) => {
      const [row] = await rows<{ id: number }>(
        `INSERT INTO connections (org_id, name, host, username, password)
         VALUES ($1, 'Bookshop', 'db.example.test', 'reader', $2)
         RETURNING id`,
        [org.id, FAKE_PASSWORD]
      );
      return row.id;
    };
    connA = await addConnection(orgA);
    connB = await addConnection(orgB);

    trackedA = await trackAs(orgA, connA, "public");
    trackedB = await trackAs(orgB, connB, "public");
  }, SETUP);

  afterAll(async () => {
    if (sequelize) {
      await settle();
      await sequelize.close();
    }
    globalThis.__metadataSequelize = undefined;
    if (savedUrl === undefined) delete process.env.DATABASE_URL_A;
    else process.env.DATABASE_URL_A = savedUrl;
    if (savedDesktop === undefined) delete process.env.SCHEMA_STUDIO_DESKTOP;
    else process.env.SCHEMA_STUDIO_DESKTOP = savedDesktop;
    await db?.end();
    if (server) {
      if (databaseName) {
        await server.query(`DROP DATABASE IF EXISTS ${quoteIdent(databaseName)} WITH (FORCE)`);
      }
      await server.end();
    }
  }, SETUP);

  // Nothing here should log an error. The writers that swallow their failures
  // (recordRuns, recordQuery, the drift and metric writers) report them only
  // to the server's log, so a statement that broke would otherwise pass as
  // "wrote nothing", which is exactly what the cross-organization cases expect.
  let errorSpy: jest.SpyInstance;
  beforeEach(() => {
    mockLive = BASE;
    mockFetch.mockClear();
    mockRequestImmediateCheck.mockClear();
    errorSpy = jest.spyOn(console, "error");
  });
  afterEach(() => {
    const logged = errorSpy.mock.calls.slice();
    errorSpy.mockRestore();
    expect(logged).toEqual([]);
  });

  describe("tracking a schema", () => {
    test("files the tracked schema, its baseline and its lineage under the caller's organization", async () => {
      salesA = await trackAs(orgA, connA, "sales");

      const [tracked] = await rows<{ org_id: number }>(
        `SELECT org_id FROM tracked_schemas WHERE id = $1`,
        [salesA]
      );
      expect(tracked.org_id).toBe(orgA.id);
      const snapshots = await rows<{ org_id: number }>(
        `SELECT org_id FROM snapshots WHERE tracked_schema_id = $1`,
        [salesA]
      );
      expect(snapshots).toEqual([{ org_id: orgA.id }]);
      const steps = await rows<{ org_id: number; seq: number }>(
        `SELECT org_id, seq FROM lineage_migrations WHERE tracked_schema_id = $1`,
        [salesA]
      );
      expect(steps).toEqual([{ org_id: orgA.id, seq: 1 }]);
      expect(mockRequestImmediateCheck).toHaveBeenCalledTimes(1);
      expect(mockRequestImmediateCheck.mock.calls[0]).toEqual([orgA.id, salesA]);
    }, SLOW);

    test("answers another organization's connection as missing and writes nothing", async () => {
      const before = await count(`SELECT count(*)::int AS n FROM tracked_schemas`);
      const result = await post(track.POST, "/api/lineage/track", orgA, {
        connectionId: connB,
        schemaName: "sales",
      });
      expect(result.status).toBe(404);
      expect(result.body.error).toBe(`No saved connection found with id ${connB}.`);
      expect(await count(`SELECT count(*)::int AS n FROM tracked_schemas`)).toBe(before);
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockRequestImmediateCheck).not.toHaveBeenCalled();
    }, SLOW);
  });

  describe("re-baselining and acknowledging", () => {
    test("re-baselines only a schema in the caller's organization", async () => {
      const snapshotsOf = () =>
        count(`SELECT count(*)::int AS n FROM snapshots WHERE tracked_schema_id = $1`, [
          trackedA,
        ]);
      const before = await snapshotsOf();

      const refused = await post(rebaseline.POST, "/api/lineage/rebaseline", orgB, {
        trackedSchemaId: trackedA,
      });
      expect(refused.status).toBe(404);
      expect(refused.body.error).toBe("Tracked schema not found.");
      expect(await snapshotsOf()).toBe(before);
      expect(mockFetch).not.toHaveBeenCalled();

      const done = await post(rebaseline.POST, "/api/lineage/rebaseline", orgA, {
        trackedSchemaId: trackedA,
      });
      expect(done.status).toBe(200);
      expect(await snapshotsOf()).toBe(before + 1);
      const [snapshot] = await rows<{ org_id: number }>(
        `SELECT org_id FROM snapshots WHERE id = $1`,
        [done.body.snapshotId]
      );
      expect(snapshot.org_id).toBe(orgA.id);
      const [step] = await rows<{ org_id: number }>(
        `SELECT org_id FROM lineage_migrations WHERE tracked_schema_id = $1 AND seq = $2`,
        [trackedA, done.body.seq]
      );
      expect(step.org_id).toBe(orgA.id);
      const events = await rows<{ org_id: number }>(
        `SELECT org_id FROM drift_events WHERE tracked_schema_id = $1 AND source = 'rebaseline'`,
        [trackedA]
      );
      expect(events).toEqual([{ org_id: orgA.id }]);
    }, SLOW);

    test("acknowledges only a schema in the caller's organization", async () => {
      const acknowledgedOf = () =>
        count(
          `SELECT count(*)::int AS n FROM drift_events
            WHERE tracked_schema_id = $1 AND source = 'acknowledged'`,
          [trackedA]
        );

      const refused = await post(acknowledge.POST, "/api/lineage/acknowledge", orgB, {
        trackedSchemaId: trackedA,
      });
      expect(refused.status).toBe(404);
      expect(refused.body.error).toBe("Tracked schema not found.");
      expect(await acknowledgedOf()).toBe(0);
      expect(mockFetch).not.toHaveBeenCalled();

      const done = await post(acknowledge.POST, "/api/lineage/acknowledge", orgA, {
        trackedSchemaId: trackedA,
      });
      expect(done.status).toBe(200);
      const events = await rows<{ org_id: number; acknowledged: boolean }>(
        `SELECT org_id, acknowledged_at IS NOT NULL AS acknowledged FROM drift_events
          WHERE tracked_schema_id = $1 AND source = 'acknowledged'`,
        [trackedA]
      );
      expect(events).toEqual([{ org_id: orgA.id, acknowledged: true }]);
    }, SLOW);
  });

  describe("reading lineage and drift", () => {
    test("shows each tracked schema to its own organization only", async () => {
      // An event in B, so B's feed has something in it to keep to itself.
      const checked = await driftRunner.runDriftCheck(orgB.id, trackedB, "manual");
      expect(checked.ok).toBe(true);

      const refs = [
        { connectionId: connA, schemaName: "public" },
        { connectionId: connB, schemaName: "public" },
      ];
      const headsA = await lineage.findTrackedSchemas(orgA.id, refs);
      expect([...headsA.values()].map((head) => head.trackedSchemaId)).toEqual([trackedA]);
      const headsB = await lineage.findTrackedSchemas(orgB.id, refs);
      expect([...headsB.values()].map((head) => head.trackedSchemaId)).toEqual([trackedB]);

      expect(await lineage.findTrackedSchema(orgA.id, connB, "public")).toBeNull();
      expect((await lineage.findTrackedSchema(orgB.id, connB, "public"))?.trackedSchemaId).toBe(
        trackedB
      );

      const listA = (await lineage.listTrackedSchemas(orgA.id)).map((item) => item.id);
      expect(listA.sort((a, b) => a - b)).toEqual([trackedA, salesA].sort((a, b) => a - b));
      expect((await lineage.listTrackedSchemas(orgB.id)).map((item) => item.id)).toEqual([
        trackedB,
      ]);

      expect(await lineage.getLineageDetail(orgB.id, trackedA)).toBeNull();
      expect((await lineage.getLineageDetail(orgA.id, trackedA))?.trackedSchemaId).toBe(trackedA);

      expect(await lineage.computeDriftDetail(orgB.id, trackedA)).toEqual({ kind: "not_found" });
      expect((await lineage.computeDriftDetail(orgA.id, trackedA)).kind).toBe("ok");

      expect(await lineage.getDriftDetail(orgB.id, trackedA)).toBeNull();
      expect((await lineage.getDriftDetail(orgA.id, trackedA))?.trackedSchemaId).toBe(trackedA);

      const feedA = await lineage.listDriftEvents(orgA.id);
      expect(feedA.length).toBeGreaterThan(0);
      expect(feedA.every((item) => item.trackedSchemaId !== trackedB)).toBe(true);
      const feedB = await lineage.listDriftEvents(orgB.id);
      expect(feedB.length).toBeGreaterThan(0);
      expect(feedB.every((item) => item.trackedSchemaId === trackedB)).toBe(true);
      expect(await lineage.listDriftEvents(orgB.id, trackedA)).toEqual([]);

      const fromB = await lineage.getConnectionDependents(orgB.id, connA);
      expect(fromB.trackedSchemas).toBe(0);
      expect(fromB.snapshots).toBe(0);
      const fromA = await lineage.getConnectionDependents(orgA.id, connA);
      expect(fromA.trackedSchemas).toBe(2);
      expect(fromA.schemaNames.sort()).toEqual(["public", "sales"]);
    }, SLOW);

    test("advances the lineage after a deploy only inside the caller's organization", async () => {
      const stepsOf = () =>
        count(`SELECT count(*)::int AS n FROM lineage_migrations WHERE tracked_schema_id = $1`, [
          trackedA,
        ]);
      const before = await stepsOf();
      const deploy = {
        connectionId: connA,
        schemaName: "public",
        targetConfig: { host: "db.example.test" },
        changeLevel: "additive" as const,
        name: "V2__add_shelves.sql",
        sqlRef: null,
      };

      expect(
        await lineage.recordAppliedMigrationToLineage({ ...deploy, orgId: orgB.id })
      ).toEqual({ advanced: false, reason: "not tracked" });
      expect(await stepsOf()).toBe(before);

      const advanced = await lineage.recordAppliedMigrationToLineage({
        ...deploy,
        orgId: orgA.id,
      });
      expect(advanced.advanced).toBe(true);
      expect(await stepsOf()).toBe(before + 1);
      const [step] = await rows<{ org_id: number; snapshot_org: number }>(
        `SELECT l.org_id, s.org_id AS snapshot_org
           FROM lineage_migrations l JOIN snapshots s ON s.id = l.snapshot_id
          WHERE l.tracked_schema_id = $1 AND l.seq = $2`,
        [trackedA, advanced.seq]
      );
      expect(step).toEqual({ org_id: orgA.id, snapshot_org: orgA.id });
    }, SLOW);
  });

  describe("drift writers and the scheduler", () => {
    test("records a drift event or a metric only against the caller's own schema", async () => {
      const eventsOf = () =>
        count(`SELECT count(*)::int AS n FROM drift_events WHERE tracked_schema_id = $1`, [
          trackedA,
        ]);
      const event = {
        trackedSchemaId: trackedA,
        status: "in_sync" as const,
        summary: "In sync.",
        counts: null,
        baselineSnapshotId: null,
        source: "manual" as const,
      };
      const before = await eventsOf();
      expect(await driftRunner.recordDriftEvent({ ...event, orgId: orgB.id })).toBe(false);
      expect(await eventsOf()).toBe(before);
      expect(await driftRunner.recordDriftEvent({ ...event, orgId: orgA.id })).toBe(true);
      expect(await eventsOf()).toBe(before + 1);

      const sample = { trackedSchemaId: trackedA, live: BASE, drifted: false };
      expect(await metrics.recordSchemaMetrics({ ...sample, orgId: orgB.id })).toBe(false);
      expect(await metrics.readSchemaMetrics(orgA.id, trackedA, 1)).toEqual([]);
      expect(await metrics.recordSchemaMetrics({ ...sample, orgId: orgA.id })).toBe(true);
      const readings = await metrics.readSchemaMetrics(orgA.id, trackedA, 1);
      expect(readings).toHaveLength(1);
      expect(readings[0]).toMatchObject({ tables: 1, totalBytes: 8192, drifted: false });
      expect(await metrics.readSchemaMetrics(orgB.id, trackedA, 1)).toEqual([]);

      const stampOf = async () =>
        (
          await rows<{ at: string | null }>(
            `SELECT last_drift_check_at::text AS at FROM tracked_schemas WHERE id = $1`,
            [trackedA]
          )
        )[0].at;
      const stamped = await stampOf();
      expect(await driftRunner.runDriftCheck(orgB.id, trackedA, "manual")).toEqual({
        ok: false,
        problem: { kind: "not_found" },
      });
      expect(await stampOf()).toBe(stamped);
      expect(await eventsOf()).toBe(before + 1);
    }, SLOW);

    test("a tick checks every organization's schemas, each inside its own organization", async () => {
      mockLive = DRIFTED;
      // A day on, so every schema is due whatever the earlier tests stamped.
      const report = await scheduler.runSchedulerTick(new Date(Date.now() + 24 * 60 * 60 * 1000));

      expect(report.kind).toBe("by_org");
      if (report.kind !== "by_org") return;
      expect([...report.byOrg.keys()].sort((a, b) => a - b)).toEqual(
        [orgA.id, orgB.id].sort((a, b) => a - b)
      );
      // Each organization's line is about its own schemas: two in A, one in B.
      expect(report.byOrg.get(orgA.id)).toBe("Checked 2 · 2 drifted.");
      expect(report.byOrg.get(orgB.id)).toBe("Checked 1 · 1 drifted.");

      const events = await rows<{ id: number; schema_org: number; event_org: number }>(
        `SELECT ts.id, ts.org_id AS schema_org, e.org_id AS event_org
           FROM drift_events e JOIN tracked_schemas ts ON ts.id = e.tracked_schema_id
          WHERE e.source = 'scheduled' AND e.status = 'drifted'
          ORDER BY ts.id`
      );
      expect(events).toEqual(
        [
          { id: trackedA, schema_org: orgA.id, event_org: orgA.id },
          { id: trackedB, schema_org: orgB.id, event_org: orgB.id },
          { id: salesA, schema_org: orgA.id, event_org: orgA.id },
        ].sort((a, b) => a.id - b.id)
      );
      const samples = await rows<{ id: number; schema_org: number; sample_org: number; bytes: string }>(
        `SELECT ts.id, ts.org_id AS schema_org, m.org_id AS sample_org, m.total_bytes AS bytes
           FROM schema_metrics m JOIN tracked_schemas ts ON ts.id = m.tracked_schema_id
          WHERE m.drifted
          ORDER BY ts.id`
      );
      expect(samples).toEqual(
        [
          { id: trackedA, schema_org: orgA.id, sample_org: orgA.id, bytes: "8192" },
          { id: trackedB, schema_org: orgB.id, sample_org: orgB.id, bytes: "8192" },
          { id: salesA, schema_org: orgA.id, sample_org: orgA.id, bytes: "8192" },
        ].sort((a, b) => a.id - b.id)
      );
    }, SLOW);
  });

  describe("query history and thresholds", () => {
    function analysed(orgId: number, connectionId: number): RecordQueryInput {
      return {
        orgId,
        connectionId,
        schema: "public",
        sql: "SELECT * FROM books WHERE id = 1",
        score: { score: 90, band: "good", basis: "time", measured: true, reasons: [] },
        execTimeMs: 12,
        planningMs: 1,
        rowsReturned: 1,
        totalCost: 8.27,
        estimatedRows: 1,
        counts: { high: 0, medium: 0, low: 0 },
        capturedBy: "admin@test",
        searches: [{ table: "books", equality: ["id"], range: null }],
      };
    }

    afterEach(async () => {
      // Recording a query starts a prune it does not wait for.
      await settle();
    });

    test("keeps each organization's query history to itself", async () => {
      const idA = await queries.recordQuery(analysed(orgA.id, connA));
      expect(idA).not.toBeNull();
      expect(await queries.recordQuery(analysed(orgB.id, connA))).toBeNull();
      const idB = await queries.recordQuery(analysed(orgB.id, connB));
      expect(idB).not.toBeNull();
      expect(
        await rows<{ id: number; org_id: number }>(
          `SELECT id, org_id FROM query_history ORDER BY id`
        )
      ).toEqual([
        { id: idA, org_id: orgA.id },
        { id: idB, org_id: orgB.id },
      ]);

      expect((await queries.listQueryHistory(orgA.id, connA, "public")).map((r) => r.id)).toEqual([
        idA,
      ]);
      expect(await queries.listQueryHistory(orgB.id, connA, "public")).toEqual([]);

      expect(await queries.getQueryHistoryRow(orgB.id, idA as number)).toBeNull();
      const row = await queries.getQueryHistoryRow(orgA.id, idA as number);
      expect(row?.id).toBe(idA);

      const fingerprint = row?.fingerprint ?? "";
      expect(
        (await queries.listRunsOfQuery(orgA.id, connA, "public", fingerprint)).map((r) => r.id)
      ).toEqual([idA]);
      expect(await queries.listRunsOfQuery(orgB.id, connA, "public", fingerprint)).toEqual([]);

      const trendA = await queries.queryTrend(orgA.id, connA, "public", 7);
      expect(trendA.reduce((sum, day) => sum + day.runs, 0)).toBe(1);
      const trendB = await queries.queryTrend(orgB.id, connA, "public", 7);
      expect(trendB.reduce((sum, day) => sum + day.runs, 0)).toBe(0);

      expect(await queries.listSearches(orgA.id, connA, "public")).toHaveLength(1);
      expect(await queries.listSearches(orgB.id, connA, "public")).toEqual([]);
    }, SLOW);

    test("saves thresholds only on the caller's own connection", async () => {
      const settings = [{ key: "query_exec_ms" as const, value: 250, enabled: true }];

      expect(
        await thresholds.saveThresholds(orgB.id, connA, "public", settings, "admin@test")
      ).toEqual([]);
      expect(await count(`SELECT count(*)::int AS n FROM perf_thresholds`)).toBe(0);

      expect(
        await thresholds.saveThresholds(orgA.id, connA, "public", settings, "admin@test")
      ).toEqual([]);
      expect(await rows(`SELECT org_id, connection_id FROM perf_thresholds`)).toEqual([
        { org_id: orgA.id, connection_id: connA },
      ]);

      const own = await thresholds.getThresholds(orgA.id, connA, "public");
      expect(own.find((s) => s.key === "query_exec_ms")).toEqual(settings[0]);
      const other = await thresholds.getThresholds(orgB.id, connA, "public");
      expect(other.find((s) => s.key === "query_exec_ms")).toEqual({
        key: "query_exec_ms",
        value: 1000,
        enabled: false,
      });
    }, SLOW);
  });

  describe("comparison sets and their runs", () => {
    const access = { mayCreate: true, mayUpdate: true, roleLabel: "Admin" };
    let setA = 0;

    function nightly(name: string, source: number, target: number): SaveComparisonSetInput {
      return {
        id: null,
        overwrite: false,
        name,
        sourceConnectionId: source,
        sourceConnectionLabel: "Bookshop",
        sourceSchema: "public",
        allowDataLoss: false,
        compareData: false,
        dataTables: [],
        targets: [{ connectionId: target, connectionLabel: "Bookshop", schema: "staging" }],
      };
    }

    test("keeps each organization's sets, and set names, to itself", async () => {
      const savedA = await sets.saveComparisonSet(orgA.id, nightly("Nightly", connA, connA), access);
      expect(savedA).toMatchObject({ ok: true, created: true });
      if (!savedA.ok) return;
      setA = savedA.set.id;

      // The same name in B is a new set, not a conflict with A's.
      const savedB = await sets.saveComparisonSet(orgB.id, nightly("Nightly", connB, connB), access);
      expect(savedB).toMatchObject({ ok: true, created: true });
      if (!savedB.ok) return;
      expect(savedB.set.id).not.toBe(setA);

      const borrowed = await sets.saveComparisonSet(
        orgB.id,
        nightly("Borrowed", connB, connA),
        access
      );
      expect(borrowed).toEqual({
        ok: false,
        error: "One of the connections in this set no longer exists. Pick it again, then save.",
        conflict: false,
      });
      expect(
        await count(`SELECT count(*)::int AS n FROM comparison_sets WHERE name = 'Borrowed'`)
      ).toBe(0);

      expect(
        await rows(`SELECT DISTINCT org_id FROM comparison_set_targets WHERE set_id = $1`, [setA])
      ).toEqual([{ org_id: orgA.id }]);

      expect((await sets.listComparisonSets(orgA.id)).map((set) => set.id)).toEqual([setA]);
      expect((await sets.listComparisonSets(orgB.id)).map((set) => set.id)).toEqual([
        savedB.set.id,
      ]);
      expect(await sets.getComparisonSet(orgB.id, setA)).toBeNull();
      const stampOf = async () =>
        (
          await rows<{ stamped: boolean }>(
            `SELECT last_run_at IS NOT NULL AS stamped FROM comparison_sets WHERE id = $1`,
            [setA]
          )
        )[0].stamped;
      expect(await sets.markComparisonSetRun(orgB.id, setA)).toBeNull();
      expect(await stampOf()).toBe(false);
      expect(await sets.markComparisonSetRun(orgA.id, setA)).not.toBeNull();
      expect(await stampOf()).toBe(true);

      expect(await sets.listSetNamesUsingConnection(orgB.id, connA)).toEqual([]);
      expect(await sets.listSetNamesUsingConnection(orgA.id, connA)).toEqual(["Nightly"]);
      const dependents = await lineage.getConnectionDependents(orgA.id, connA);
      expect(dependents.comparisonSetNames).toEqual(["Nightly"]);

      expect(await sets.deleteComparisonSet(orgB.id, setA)).toBe(false);
      expect(await sets.getComparisonSet(orgA.id, setA)).not.toBeNull();
      expect(await sets.deleteComparisonSet(orgB.id, savedB.set.id)).toBe(true);
      expect(await sets.listComparisonSets(orgB.id)).toEqual([]);
    }, SLOW);

    test("stores a run only between the caller's own connections, linked only to its own set", async () => {
      const findings = {
        breaking: 0,
        safe: 1,
        info: 0,
        total: 1,
        items: [{ key: "table:authors", severity: "safe" as const }],
        truncated: false,
        fingerprint: "one-new-table",
      };
      const pairA: RunPair = {
        sourceConnectionId: connA,
        sourceSchema: "public",
        targetConnectionId: connA,
        targetSchema: "staging",
      };
      const pairB: RunPair = { ...pairA, sourceConnectionId: connB, targetConnectionId: connB };
      const run = (pair: RunPair, setId: number | null): RunRecord => ({
        pair,
        setId,
        ranBy: "admin@test",
        findings,
      });

      await runs.recordRuns(orgA.id, [run(pairA, setA)]);
      // B naming A's connections stores nothing; B naming A's set stores the
      // run with no set, as if none had been open.
      await runs.recordRuns(orgB.id, [run(pairA, null)]);
      await runs.recordRuns(orgB.id, [run(pairB, setA)]);

      expect(
        await rows(
          `SELECT org_id, set_id, source_connection_id FROM comparison_runs ORDER BY id`
        )
      ).toEqual([
        { org_id: orgA.id, set_id: setA, source_connection_id: connA },
        { org_id: orgB.id, set_id: null, source_connection_id: connB },
      ]);

      const seenByA = await runs.readPreviousRuns(orgA.id, [pairA, pairB]);
      expect([...seenByA.keys()]).toEqual([runs.pairKey(pairA)]);
      const seenByB = await runs.readPreviousRuns(orgB.id, [pairA, pairB]);
      expect([...seenByB.keys()]).toEqual([runs.pairKey(pairB)]);
    }, SLOW);
  });

  describe("approvals and the deploy trail", () => {
    const scripts: ApprovalScript[] = [
      {
        scriptName: "V3__add_authors.sql",
        version: "3.0.0",
        sqlContent: "CREATE TABLE authors (id integer PRIMARY KEY);",
      },
    ];

    test("an approval is requested, decided, spent and released only in its own organization", async () => {
      const request = {
        connectionId: connA,
        schemaName: "public",
        scriptName: "V3__add_authors.sql",
        targetVersion: "3.0.0",
        scripts,
        breakingCount: 0,
        requestedBy: "editor@test",
        note: null,
        action: "deploy" as const,
      };
      const created = await approvals.createApprovalRequest({ ...request, orgId: orgA.id });
      expect(created).not.toBeNull();
      const id = created?.id as number;
      // The same open request exists in A. B asking for it gets neither that
      // request back nor a new one of its own.
      expect(await approvals.createApprovalRequest({ ...request, orgId: orgB.id })).toBeNull();
      expect(await rows(`SELECT id, org_id FROM deploy_approvals`)).toEqual([
        { id, org_id: orgA.id },
      ]);

      expect(await approvals.getApproval(orgB.id, id)).toBeNull();
      expect(await approvals.listPendingApprovals(orgB.id)).toEqual([]);
      expect((await approvals.listPendingApprovals(orgA.id)).map((a) => a.id)).toEqual([id]);
      expect(await approvals.listApprovals(orgB.id, connA, "public", null)).toEqual([]);
      expect((await approvals.listApprovals(orgA.id, connA, "public", null)).map((a) => a.id)).toEqual(
        [id]
      );
      expect(await approvals.getApprovalScripts(orgB.id, id)).toBeNull();
      expect((await approvals.getApprovalScripts(orgA.id, id))?.approval.id).toBe(id);

      const statusOf = async () =>
        (await rows<{ status: string }>(`SELECT status FROM deploy_approvals WHERE id = $1`, [id]))[0]
          .status;
      const decision = {
        id,
        approve: true,
        decidedBy: "admin@test",
        selfApproved: false,
        note: null,
      };
      expect(await approvals.decideApproval({ ...decision, orgId: orgB.id })).toBeNull();
      expect(await statusOf()).toBe("pending");
      expect((await approvals.decideApproval({ ...decision, orgId: orgA.id }))?.status).toBe(
        "approved"
      );

      const claim = { connectionId: connA, schemaName: "public", scripts, action: "deploy" as const };
      expect(await approvals.claimApproval({ ...claim, orgId: orgB.id })).toBeNull();
      expect(await statusOf()).toBe("approved");
      expect((await approvals.claimApproval({ ...claim, orgId: orgA.id }))?.id).toBe(id);
      expect(await statusOf()).toBe("used");

      await approvals.releaseApproval(orgB.id, id);
      expect(await statusOf()).toBe("used");
      await approvals.releaseApproval(orgA.id, id);
      expect(await statusOf()).toBe("approved");
    }, SLOW);

    test("files each deploy attempt under the caller's organization, and only there", async () => {
      const attempt = { connectionId: connA, schemaName: "public", actor: "editor@test" };
      await attempts.recordDeployAttempt({ ...attempt, orgId: orgA.id }, 200, { success: true });
      // Refused at the gate: no organization, so no row.
      await attempts.recordDeployAttempt(attempt, 403, { error: "Not allowed." });
      // B asking about A's connection is kept in B's own trail.
      await attempts.recordDeployAttempt({ ...attempt, orgId: orgB.id }, 404, {
        error: "Connection not found.",
      });

      expect(await rows(`SELECT org_id, http_status FROM deploy_attempts ORDER BY id`)).toEqual([
        { org_id: orgA.id, http_status: 200 },
        { org_id: orgB.id, http_status: 404 },
      ]);
      const readBy = async (org: Org) =>
        (
          await attempts.listDeployAttempts({
            orgId: org.id,
            connectionId: connA,
            schemaName: "public",
          })
        ).map((row) => row.http_status);
      expect(await readBy(orgA)).toEqual([200]);
      expect(await readBy(orgB)).toEqual([404]);
    }, SLOW);
  });
});
