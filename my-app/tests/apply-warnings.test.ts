// POST /api/scripts/apply: the warnings PostgreSQL sends while a version runs
// come back on that version's outcome, so Deploy and Quick run can show what a
// run that worked still left undone (lib/deploy/run-warnings.ts).
//
// The target database is the fake client from helpers/fake-pg. Nothing here
// reaches a real database or GitHub.
import { NextRequest } from "next/server";
import { createFakeClient, type FakeClient, type FakeNotice, type FakeStep } from "./helpers/fake-pg";
import { FAKE_TOKEN, guardGitHub, type GitHubGuard } from "./helpers/no-github";
import { MAX_RUN_WARNINGS, MAX_WARNING_LENGTH } from "@/lib/deploy/run-warnings";

// Relative paths on purpose: next/jest rewrites the @/ alias inside import
// statements only, so jest.mock("@/...") would not resolve.
jest.mock("../lib/auth/guard", () => ({
  requirePermission: async () => ({
    ok: true,
    principal: require("./helpers/principals").principalFor("editor", { email: "a@test" }),
  }),
}));

const mockPoolQuery = jest.fn<Promise<unknown>, unknown[]>(async () => ({ rows: [] }));
jest.mock("../lib/db/version-db", () => ({
  __esModule: true,
  default: { query: (...args: unknown[]) => mockPoolQuery(...args) },
  syncMetadataTables: async () => undefined,
}));

let mockClient: FakeClient;
jest.mock("../lib/postgres", () => ({
  getPoolForConfig: () => ({ connect: async () => mockClient }),
}));
jest.mock("../lib/connections/config", () => ({
  buildPgConfig: () => ({}),
}));
jest.mock("../lib/versions/lineage-db", () => ({
  findTrackedSchema: async () => null,
  recordAppliedMigrationToLineage: async () => ({ advanced: false }),
}));
// Answers "not configured", so no test writes to a real GitHub registry.
jest.mock("../lib/github/registry-archive", () => ({
  archiveAppliedVersions: async () => null,
}));
jest.mock("../lib/deploy/approvals-db", () => ({
  claimApproval: async () => null,
  releaseApproval: async () => undefined,
}));

type RouteModule = typeof import("../app/api/scripts/apply/route");
let POST: RouteModule["POST"];

function connectionRow() {
  return {
    host: "db.test", port: 5432, database_name: "sales", username: "app",
    password: "not-a-real-password", connection_string: null, ssl: false,
    ssl_mode: "disable", name: "Sales",
  };
}

const RUN = {
  connectionId: 7,
  schemaName: "sales",
  scripts: [
    { script_name: "b_fix", version: "1.0.0", sql_content: "CREATE TABLE b (id int);", down_sql: "DROP TABLE b;" },
    { script_name: "a_fix", version: "1.0.0", sql_content: "CREATE TABLE a (id int);", down_sql: "DROP TABLE a;" },
  ],
};

/** What an owner change the login may not make sends (ownerStatement in lib/sql/generate/privileges.ts). */
const OWNER_WARNING: FakeNotice = {
  message: 'The owner of table b was not changed: must be able to SET ROLE "postgres"',
  severity: "WARNING",
  code: "01000",
};

function warning(message: string): FakeNotice {
  return { message, severity: "WARNING", code: "01000" };
}

function target(first: FakeStep[] = []): FakeStep[] {
  return [
    ...first,
    { match: /information_schema\.schemata/, rows: [{ exists: 1 }] },
    { match: /INSERT INTO "sales"\.script_patch/, rows: [{ applied_at: "2026-11-19T00:00:00.000Z" }] },
  ];
}

type Outcome = Record<string, unknown> & { script_name: string };

async function apply(body: Record<string, unknown>): Promise<{ status: number; results: Outcome[] }> {
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
  const parsed = JSON.parse(text) as { results?: Outcome[] };
  return { status: res.status, results: parsed.results ?? [] };
}

function outcomeFor(results: Outcome[], name: string): Outcome {
  const outcome = results.find((result) => result.script_name === name);
  if (!outcome) throw new Error(`no outcome for ${name}`);
  return outcome;
}

let guard: GitHubGuard;
let consoleSpy: jest.SpyInstance;
let logSpy: jest.SpyInstance;

beforeAll(async () => {
  ({ POST } = await import("../app/api/scripts/apply/route"));
});

beforeEach(() => {
  guard = guardGitHub();
  mockPoolQuery.mockReset();
  mockPoolQuery.mockResolvedValue({ rows: [connectionRow()] });
  consoleSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  consoleSpy.mockRestore();
  logSpy.mockRestore();
  guard.restore();
  expect(guard.unexpected).toEqual([]);
});

it("puts a version's warnings on its own outcome and leaves plain notices out", async () => {
  mockClient = createFakeClient(
    target([
      {
        match: /CREATE TABLE b/,
        notice: [
          OWNER_WARNING,
          // What IF NOT EXISTS sends on a second run: a NOTICE, on purpose.
          { message: 'relation "b" already exists, skipping', severity: "NOTICE", code: "42P07" },
        ],
      },
      { match: /CREATE TABLE a/, notice: "a notice from a RAISE NOTICE" },
    ])
  );
  const res = await apply(RUN);
  expect(res.status).toBe(200);

  const b = outcomeFor(res.results, "b_fix");
  expect(b.status).toBe("applied");
  expect(b.warnings).toEqual([OWNER_WARNING.message]);
  expect(b).not.toHaveProperty("moreWarnings");
  // A version that raised no warning keeps the outcome's old shape.
  const a = outcomeFor(res.results, "a_fix");
  expect(a.status).toBe("applied");
  expect(a).not.toHaveProperty("warnings");
  expect(a).not.toHaveProperty("moreWarnings");
  // The listener is off again before the connection goes back to the pool.
  expect(mockClient.listenersAtRelease).toBe(0);
});

it("reports them on a dry run too, so they show before anything is applied", async () => {
  mockClient = createFakeClient(target([{ match: /CREATE TABLE b/, notice: OWNER_WARNING }]));
  const res = await apply({ ...RUN, dryRun: true });
  expect(res.status).toBe(200);
  const b = outcomeFor(res.results, "b_fix");
  expect(b.status).toBe("rehearsed");
  expect(b.warnings).toEqual([OWNER_WARNING.message]);
  expect(outcomeFor(res.results, "a_fix")).not.toHaveProperty("warnings");
  expect(mockClient.listenersAtRelease).toBe(0);
});

it("keeps the first warnings and counts the rest", async () => {
  const many = Array.from({ length: MAX_RUN_WARNINGS + 5 }, (_, index) => warning(`warning ${index + 1}`));
  mockClient = createFakeClient(target([{ match: /CREATE TABLE b/, notice: many }]));
  const res = await apply(RUN);
  const b = outcomeFor(res.results, "b_fix");
  expect(b.warnings).toEqual(many.slice(0, MAX_RUN_WARNINGS).map((notice) => notice.message));
  expect(b.moreWarnings).toBe(5);
});

it("writes each warning as one short line", async () => {
  const long = "x".repeat(MAX_WARNING_LENGTH + 100);
  mockClient = createFakeClient(
    target([{ match: /CREATE TABLE b/, notice: [warning("first line\n   second line\t end "), warning(long)] }])
  );
  const res = await apply(RUN);
  const warnings = outcomeFor(res.results, "b_fix").warnings as string[];
  expect(warnings[0]).toBe("first line second line end");
  expect(warnings[1]).toHaveLength(MAX_WARNING_LENGTH);
  expect(warnings[1].endsWith("...")).toBe(true);
});

it("goes by the SQLSTATE, so a server answering in another language still counts", async () => {
  mockClient = createFakeClient(
    target([
      {
        match: /CREATE TABLE b/,
        notice: { message: "le propriétaire de table b n'a pas été changé", severity: "ATTENTION", code: "01000" },
      },
    ])
  );
  const res = await apply(RUN);
  expect(outcomeFor(res.results, "b_fix").warnings).toEqual(["le propriétaire de table b n'a pas été changé"]);
});

it("puts nothing on a version from the route's own queries", async () => {
  mockClient = createFakeClient(
    target([
      {
        match: /INSERT INTO "sales"\.script_patch/,
        rows: [{ applied_at: "2026-11-19T00:00:00.000Z" }],
        notice: warning("a warning from the ledger insert"),
      },
    ])
  );
  const res = await apply(RUN);
  expect(res.status).toBe(200);
  for (const outcome of res.results) expect(outcome).not.toHaveProperty("warnings");
});

it("drops the warnings of a run that failed, since nothing it did was kept", async () => {
  mockClient = createFakeClient(
    target([
      { match: /CREATE TABLE b/, notice: OWNER_WARNING },
      { match: /CREATE TABLE a/, error: { code: "42P07", message: 'relation "a" already exists' } },
    ])
  );
  const res = await apply(RUN);
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(res.results.length).toBeGreaterThan(0);
  for (const outcome of res.results) expect(outcome).not.toHaveProperty("warnings");
  expect(mockClient.listenersAtRelease).toBe(0);
});
