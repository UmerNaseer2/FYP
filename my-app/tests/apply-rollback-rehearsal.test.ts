// POST /api/scripts/apply: a dry run also tries each version's rollback
// (down) script, inside a savepoint, and says how it went on that version's
// outcome. A real run stores the rollback and nothing changes it afterwards,
// so the dry run is the last moment a broken one can be found.
//
// The target database is the fake client from helpers/fake-pg. Nothing here
// reaches a real database or GitHub.
import { NextRequest } from "next/server";
import { createFakeClient, queryTexts, type FakeClient, type FakeStep } from "./helpers/fake-pg";
import { FAKE_TOKEN, guardGitHub, type GitHubGuard } from "./helpers/no-github";

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

type Script = { script_name: string; version: string; sql_content: string; down_sql?: string };

// Three versions of one script. The rehearsal tries their rollbacks newest
// first: c, then b, then a.
const A: Script = { script_name: "shop", version: "1.0.0", sql_content: "CREATE TABLE a (id int);", down_sql: "DROP TABLE a;" };
const B: Script = { script_name: "shop", version: "1.1.0", sql_content: "CREATE TABLE b (id int);", down_sql: "DROP TABLE b;" };
const C: Script = { script_name: "shop", version: "1.2.0", sql_content: "CREATE TABLE c (id int);", down_sql: "DROP TABLE c;" };

function target(first: FakeStep[] = []): FakeStep[] {
  return [
    ...first,
    { match: /information_schema\.schemata/, rows: [{ exists: 1 }] },
    { match: /INSERT INTO "sales"\.script_patch/, rows: [{ applied_at: "2026-11-19T00:00:00.000Z" }] },
  ];
}

type Outcome = Record<string, unknown> & { version: string };
type Answer = { status: number; body: Record<string, unknown>; results: Outcome[] };

async function apply(scripts: Script[], dryRun: boolean): Promise<Answer> {
  const res = await POST(
    new NextRequest("http://localhost/api/scripts/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectionId: 7, schemaName: "sales", scripts, dryRun }),
    })
  );
  const text = await res.text();
  expect(text).not.toContain(FAKE_TOKEN);
  expect(text).not.toContain("not-a-real-password");
  const body = JSON.parse(text) as Record<string, unknown>;
  return { status: res.status, body, results: (body.results as Outcome[] | undefined) ?? [] };
}

function checks(results: Outcome[]): Record<string, unknown> {
  return Object.fromEntries(results.map((result) => [result.version, result.rollbackCheck]));
}

/** Where a query sits in the order the route sent them, or -1. */
function position(pattern: RegExp): number {
  return queryTexts(mockClient).findIndex((text) => pattern.test(text));
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

it("tries every rollback newest first, inside a savepoint that is rolled back", async () => {
  mockClient = createFakeClient(target());
  const { status, body, results } = await apply([A, B, C], true);

  expect(status).toBe(200);
  expect(body.success).toBe(true);
  expect(checks(results)).toEqual({ "1.0.0": "ok", "1.1.0": "ok", "1.2.0": "ok" });
  expect(results.every((result) => result.rollbackError === undefined)).toBe(true);

  // After the last migration: savepoint, c, b, a, back to the savepoint, and
  // only then the ROLLBACK that ends the dry run.
  const order = [
    position(/^CREATE TABLE c/),
    position(/^SAVEPOINT rollback_rehearsal$/),
    position(/^DROP TABLE c;$/),
    position(/^DROP TABLE b;$/),
    position(/^DROP TABLE a;$/),
    position(/^ROLLBACK TO SAVEPOINT rollback_rehearsal$/),
    position(/^ROLLBACK$/),
  ];
  expect(order.every((at) => at >= 0)).toBe(true);
  expect([...order].sort((x, y) => x - y)).toEqual(order);
  expect(queryTexts(mockClient)).not.toContain("COMMIT");
  expect(String(body.message)).not.toContain("failed in the rehearsal");
});

it("puts every script back on the run's settings before its rollback", async () => {
  mockClient = createFakeClient(target());
  await apply([A, B], true);
  const texts = queryTexts(mockClient);
  for (const down of ["DROP TABLE b;", "DROP TABLE a;"]) {
    const at = texts.indexOf(down);
    expect(texts.slice(at - 6, at).some((text) => /^SET LOCAL search_path/.test(text))).toBe(true);
  }
});

it("reports a failing rollback as a warning: the dry run still succeeds and earlier ones are not checked", async () => {
  mockClient = createFakeClient(
    target([{ match: /^DROP TABLE b;$/, error: { code: "42601", message: 'syntax error at or near "Add"' } }])
  );
  const { status, body, results } = await apply([A, B, C], true);

  expect(status).toBe(200);
  expect(body.success).toBe(true);
  expect(results.map((result) => result.status)).toEqual(["rehearsed", "rehearsed", "rehearsed"]);
  expect(checks(results)).toEqual({ "1.0.0": "not_checked", "1.1.0": "failed", "1.2.0": "ok" });
  expect(results[1].rollbackError).toBe('syntax error at or near "Add"');
  expect(String(body.message)).toContain("The rollback of shop v1.1.0 failed in the rehearsal");

  const texts = queryTexts(mockClient);
  // a's rollback was never tried, and the failed statement was taken back
  // before the dry run's own ROLLBACK.
  expect(texts).not.toContain("DROP TABLE a;");
  expect(texts.indexOf("ROLLBACK TO SAVEPOINT rollback_rehearsal")).toBeGreaterThan(texts.indexOf("DROP TABLE b;"));
  expect(texts[texts.length - 1]).toBe("ROLLBACK");
  expect(texts).not.toContain("COMMIT");
});

it("stops at a version with no rollback and leaves the ones before it unchecked", async () => {
  mockClient = createFakeClient(target());
  const noRollback: Script = { script_name: "shop", version: "1.1.0", sql_content: "CREATE TABLE b (id int);" };
  const commentOnly: Script = { ...A, down_sql: "-- nothing to undo" };
  const { status, results } = await apply([commentOnly, A, noRollback, C].map((s, i) => ({ ...s, version: `1.${i}.0` })), true);

  expect(status).toBe(200);
  expect(checks(results)).toEqual({
    "1.0.0": "none",
    "1.1.0": "not_checked",
    "1.2.0": "none",
    "1.3.0": "ok",
  });
  const texts = queryTexts(mockClient);
  expect(texts).toContain("DROP TABLE c;");
  expect(texts).not.toContain("DROP TABLE a;");
});

it("stops a rollback that ends the run's transaction and never reports the dry run as clean", async () => {
  // txid_current answers "100" until c's rollback has run and "101" after it.
  let downRan = false;
  mockClient = createFakeClient(
    target([
      { match: /^DROP TABLE c;$/, when: () => (downRan = true) },
      { match: /txid_current/, when: () => !downRan, rows: [{ xid: "100" }] },
      { match: /txid_current/, rows: [{ xid: "101" }] },
    ])
  );
  const { status, body, results } = await apply([A, B, C], true);

  expect(status).toBe(500);
  expect(body.success).toBe(false);
  expect(body.outcomeUnknown).toBe(true);
  expect(String(body.error)).toContain("The rollback of shop v1.2.0 ended this run's transaction");
  expect(results.every((result) => result.status === "unknown")).toBe(true);
  const texts = queryTexts(mockClient);
  expect(texts).not.toContain("DROP TABLE b;");
  expect(texts).not.toContain("COMMIT");
});

it("refuses a rollback with a COMMIT in it before anything runs", async () => {
  mockClient = createFakeClient(target());
  const { status, body } = await apply([{ ...A, down_sql: "DROP TABLE a; COMMIT;" }], true);
  expect(status).toBe(400);
  expect(String(body.error)).toContain("down_sql must not contain COMMIT");
  expect(queryTexts(mockClient)).not.toContain("BEGIN");
});

it("hands a stopped or timed out rollback to the run's own stop message", async () => {
  mockClient = createFakeClient(
    target([{ match: /^DROP TABLE c;$/, error: { code: "57014", message: "canceling statement due to statement timeout" } }])
  );
  const { status, body, results } = await apply([A, C], true);
  expect(status).toBe(503);
  expect(body.success).toBe(false);
  expect(results.some((result) => result.rollbackCheck === "failed")).toBe(false);
});

it("runs no rollback script on a real run", async () => {
  mockClient = createFakeClient(target());
  const { status, body, results } = await apply([A, B, C], false);

  expect(status).toBe(200);
  expect(body.success).toBe(true);
  expect(results.map((result) => result.status)).toEqual(["applied", "applied", "applied"]);
  expect(results.every((result) => result.rollbackCheck === undefined)).toBe(true);
  const texts = queryTexts(mockClient);
  expect(texts.some((text) => /^DROP TABLE/.test(text))).toBe(false);
  expect(texts.some((text) => /SAVEPOINT rollback_rehearsal/.test(text))).toBe(false);
  expect(texts).toContain("COMMIT");
});
