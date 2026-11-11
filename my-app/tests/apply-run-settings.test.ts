// POST /api/scripts/apply: the settings every script runs under, the ledger
// table setup before the transaction, and the request checks and failure
// answers that came out of the 2026-11-10 review.
//
// The target database is the fake client from helpers/fake-pg. Nothing here
// reaches a real database or GitHub.
import { NextRequest } from "next/server";
import { createFakeClient, queryTexts, type FakeClient, type FakeStep } from "./helpers/fake-pg";
import { FAKE_TOKEN, guardGitHub, type GitHubGuard } from "./helpers/no-github";

// Relative paths on purpose: next/jest rewrites the @/ alias inside import
// statements only, so jest.mock("@/...") would not resolve.
jest.mock("../lib/auth-guard", () => ({
  requirePermission: async () => ({
    ok: true,
    principal: require("./helpers/principals").principalFor("editor", { email: "a@test" }),
  }),
}));

const mockPoolQuery = jest.fn<Promise<unknown>, unknown[]>(async () => ({ rows: [] }));
jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: { query: (...args: unknown[]) => mockPoolQuery(...args) },
  syncMetadataTables: async () => undefined,
}));

let mockClient: FakeClient;
jest.mock("../lib/postgres", () => ({
  getPoolForConfig: () => ({ connect: async () => mockClient }),
}));
jest.mock("../lib/connection-config", () => ({
  buildPgConfig: () => ({}),
}));
jest.mock("../lib/lineage-db", () => ({
  findTrackedSchema: async () => null,
  recordAppliedMigrationToLineage: async () => ({ advanced: false }),
}));
// Answers "not configured", so no test writes to a real registry repository.
jest.mock("../lib/registry-archive", () => ({
  archiveAppliedVersions: async () => null,
}));
jest.mock("../lib/approvals-db", () => ({
  claimApproval: async () => null,
  releaseApproval: async () => undefined,
}));

type RouteModule = typeof import("../app/api/scripts/apply/route");
let POST: RouteModule["POST"];

const CONNECTION = {
  host: "db.test", port: 5432, database_name: "sales", username: "app",
  password: "not-a-real-password", connection_string: null, ssl: false,
  ssl_mode: "disable", environment: "dev",
};

// Two scripts in one run. The first one could carry a plain SET of its own.
const RUN = {
  connectionId: 7,
  schemaName: "sales",
  scripts: [
    { script_name: "a_fix", version: "1.0.0", sql_content: "CREATE TABLE a (id int);", down_sql: "DROP TABLE a;" },
    { script_name: "b_fix", version: "1.0.0", sql_content: "CREATE TABLE b (id int);", down_sql: "DROP TABLE b;" },
  ],
};

function target(first: FakeStep[] = []): FakeStep[] {
  return [
    ...first,
    { match: /information_schema\.schemata/, rows: [{ exists: 1 }] },
    { match: /INSERT INTO "sales"\.script_patch/, rows: [{ applied_at: "2026-09-11T00:00:00.000Z" }] },
  ];
}

async function apply(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await POST(
    new NextRequest("http://localhost/api/scripts/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
  const text = await res.text();
  expect(text).not.toContain(FAKE_TOKEN);
  expect(text).not.toContain("not-a-real-password");
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown> };
}

/** The queries sent before BEGIN: the ledger table setup. */
function beforeTransaction(): string[] {
  const texts = queryTexts(mockClient);
  const begin = texts.indexOf("BEGIN");
  return begin === -1 ? texts : texts.slice(0, begin);
}

let guard: GitHubGuard;
let consoleSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;
let logSpy: jest.SpyInstance;

beforeAll(async () => {
  ({ POST } = await import("../app/api/scripts/apply/route"));
});

beforeEach(() => {
  guard = guardGitHub();
  mockPoolQuery.mockReset();
  mockPoolQuery.mockResolvedValue({ rows: [CONNECTION] });
  mockClient = createFakeClient(target());
  consoleSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  consoleSpy.mockRestore();
  warnSpy.mockRestore();
  logSpy.mockRestore();
  guard.restore();
  expect(guard.unexpected).toEqual([]);
});

describe("the settings each script runs under", () => {
  it("puts them back before every script, so one script's SET cannot reach the next", async () => {
    // A plain SET search_path inside a transaction replaces the route's
    // SET LOCAL for everything after it (checked on PostgreSQL 18: the next
    // script's DROP TABLE landed in public). A later SET LOCAL wins again.
    const res = await apply(RUN);
    expect(res.status).toBe(200);
    const texts = queryTexts(mockClient);
    const between = texts.slice(
      texts.indexOf("CREATE TABLE a (id int);"),
      texts.indexOf("CREATE TABLE b (id int);")
    );
    expect(between).toEqual(
      expect.arrayContaining([
        "RESET ROLE",
        "SET LOCAL lock_timeout = 15000",
        'SET LOCAL search_path TO "sales"',
        "SET LOCAL check_function_bodies = off",
      ])
    );
  });

  it("turns the function body check off before the first script", async () => {
    // With it on, a function written before the column it reads fails at
    // CREATE FUNCTION although the finished script is correct.
    await apply(RUN);
    const texts = queryTexts(mockClient);
    const off = texts.indexOf("SET LOCAL check_function_bodies = off");
    expect(off).toBeGreaterThan(texts.indexOf("BEGIN"));
    expect(off).toBeLessThan(texts.indexOf("CREATE TABLE a (id int);"));
  });

  it("puts the dry run time limit back before every script too", async () => {
    await apply({ ...RUN, dryRun: true });
    const texts = queryTexts(mockClient);
    const between = texts.slice(
      texts.indexOf("CREATE TABLE a (id int);"),
      texts.indexOf("CREATE TABLE b (id int);")
    );
    expect(between).toContain("SET LOCAL statement_timeout = 300000");
  });

  it("adds a schema that holds only extensions after the target schema", async () => {
    // Supabase keeps citext and pg_trgm in "extensions". With the target
    // schema alone on the path, an unqualified citext column failed.
    mockClient = createFakeClient(target([{ match: /extnamespace/, rows: [{ nspname: "extensions" }] }]));
    await apply(RUN);
    const texts = queryTexts(mockClient);
    expect(texts).toContain('SET LOCAL search_path TO "sales", "extensions"');
    expect(texts).not.toContain('SET LOCAL search_path TO "sales"');
  });
});

describe("the ledger table setup before the transaction", () => {
  const ALL_COLUMNS = [
    "id", "script_name", "version", "title", "description", "change_type",
    "source_ref", "sql_content", "down_sql", "applied_by",
  ].map((column_name) => ({ column_name, data_type: "text" }));
  const UP_TO_DATE: FakeStep[] = [
    {
      match: /information_schema\.columns/,
      rows: [...ALL_COLUMNS, { column_name: "applied_at", data_type: "timestamp with time zone" }],
    },
    { match: /FROM pg_indexes/, rows: [{ exists: 1 }] },
  ];

  it("waits for a lock no longer than a deploy does, and puts the session back", async () => {
    await apply(RUN);
    const early = beforeTransaction();
    const set = early.indexOf("SET lock_timeout = 15000");
    const create = early.findIndex((text) => /CREATE TABLE IF NOT EXISTS "sales"\.script_patch/.test(text));
    const reset = early.indexOf("RESET lock_timeout");
    expect(set).toBeGreaterThanOrEqual(0);
    expect([set < create, create < reset]).toEqual([true, true]);
  });

  it("changes nothing on a ledger that is already up to date", async () => {
    // ALTER TABLE ... ADD COLUMN IF NOT EXISTS and CREATE INDEX IF NOT EXISTS
    // take their lock before they look, so behind an open writer they waited
    // with no limit although there was nothing to do (checked on PostgreSQL 18).
    mockClient = createFakeClient(target(UP_TO_DATE));
    const res = await apply(RUN);
    expect(res.status).toBe(200);
    const early = beforeTransaction();
    expect(early.filter((text) => /ALTER TABLE/.test(text))).toEqual([]);
    expect(early.filter((text) => /CREATE UNIQUE INDEX/.test(text))).toEqual([]);
  });

  it("still adds a column an older ledger is missing", async () => {
    const withoutAppliedBy = UP_TO_DATE.map((step) =>
      /information_schema/.test(String(step.match))
        ? { ...step, rows: (step.rows ?? []).filter((row) => row.column_name !== "applied_by") }
        : step
    );
    mockClient = createFakeClient(target(withoutAppliedBy));
    await apply(RUN);
    const alters = beforeTransaction().filter((text) => /ALTER TABLE/.test(text));
    expect(alters).toHaveLength(1);
    expect(alters[0]).toContain("ADD COLUMN IF NOT EXISTS applied_by");
  });

  it("answers 503 when the setup cannot get its lock in time, having run nothing", async () => {
    mockClient = createFakeClient(
      target([
        {
          match: /ALTER TABLE "sales"\.script_patch/,
          error: { code: "55P03", message: "canceling statement due to lock timeout" },
        },
      ])
    );
    const res = await apply(RUN);
    expect(res.status).toBe(503);
    expect(String(res.body.error)).toContain("waited 15 seconds");
    const texts = queryTexts(mockClient);
    expect(texts).not.toContain("BEGIN");
    expect(texts).not.toContain("CREATE TABLE a (id int);");
    // The session setting does not outlive the request.
    expect(texts).toContain("RESET lock_timeout");
  });
});

describe("request checks", () => {
  it("refuses a connectionId that is not a whole number", async () => {
    // "7" used to pass the check and reach the query as text.
    for (const connectionId of ["7", 7.5, 0, -1, true]) {
      const res = await apply({ ...RUN, connectionId });
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toContain("connectionId must be a whole number");
      expect(res.body.nothingRan).toBe(true);
    }
    expect(mockClient.queries).toEqual([]);
  });

  it("refuses a dryRun that is not true or false instead of running for real", async () => {
    // "true", 1 and "yes" all used to count as false: a real deploy.
    for (const dryRun of ["true", 1, "yes", null]) {
      const res = await apply({ ...RUN, dryRun });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("dryRun must be true or false. Nothing was run.");
    }
    expect(mockClient.queries).toEqual([]);
  });
});

describe("failure answers", () => {
  it("says in plain words why CREATE INDEX CONCURRENTLY cannot run here", async () => {
    mockClient = createFakeClient(
      target([
        {
          match: /^CREATE TABLE b/,
          error: {
            code: "25001",
            message: "CREATE INDEX CONCURRENTLY cannot run inside a transaction block",
          },
        },
      ])
    );
    const res = await apply(RUN);
    expect(res.status).toBe(500);
    const error = String(res.body.error);
    expect(error).toContain('Version 1.0.0 of "b_fix" has a statement that PostgreSQL will not run inside a transaction');
    expect(error).toContain("Take the word CONCURRENTLY out");
    expect(error).toContain("The run was rolled back and nothing was applied.");
    expect(queryTexts(mockClient)).toContain("ROLLBACK");
  });

  it("names the enum value that stayed when the run after it failed", async () => {
    // ALTER TYPE ... ADD VALUE runs before the transaction and cannot be
    // undone, so "nothing was applied" alone was not the whole truth.
    const sql = [
      "ALTER TYPE order_state ADD VALUE IF NOT EXISTS 'refunded';",
      "CREATE INDEX refunds ON orders (id) WHERE state <> 'refunded';",
    ].join("\n");
    mockClient = createFakeClient(
      target([
        { match: /to_regtype/, rows: [{ present: true }] },
        { match: /CREATE INDEX refunds/, error: { message: 'relation "orders" does not exist' } },
      ])
    );
    const res = await apply({
      connectionId: 7,
      schemaName: "sales",
      scripts: [{ script_name: "enum_fix", version: "1.0.0", sql_content: sql, down_sql: "-- none\n" }],
    });
    expect(res.status).toBe(500);
    const error = String(res.body.error);
    expect(error).toContain('relation "orders" does not exist');
    expect(error).toContain("One statement of this run did not roll back");
    expect(error).toContain("ALTER TYPE order_state ADD VALUE IF NOT EXISTS 'refunded';");
  });

  it("adds no such sentence when nothing ran before the transaction", async () => {
    mockClient = createFakeClient(
      target([{ match: /^CREATE TABLE b/, error: { message: 'relation "b" already exists' } }])
    );
    const res = await apply(RUN);
    expect(res.status).toBe(500);
    expect(String(res.body.error)).not.toContain("did not roll back");
  });
});
