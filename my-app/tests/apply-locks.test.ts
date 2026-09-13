// POST /api/scripts/apply: the locks it shares with the revert route, the
// rollbacks it stores, and the approval kind it spends.
//
// The target database is the fake client from helpers/fake-pg. Nothing here
// reaches a real database or GitHub.
import { NextRequest } from "next/server";
import { createFakeClient, queriesMatching, queryTexts, type FakeClient, type FakeStep } from "./helpers/fake-pg";
import { FAKE_TOKEN, guardGitHub, type GitHubGuard } from "./helpers/no-github";

// Relative paths on purpose: next/jest rewrites the @/ alias inside import
// statements only, so jest.mock("@/...") would not resolve.
jest.mock("../lib/auth-guard", () => ({
  requireEditor: async () => ({ ok: true, principal: { email: "a@test", bypass: false } }),
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
jest.mock("../lib/connection-config", () => ({ buildPgConfig: () => ({}) }));
jest.mock("../lib/lineage-db", () => ({
  findTrackedSchema: async () => null,
  recordAppliedMigrationToLineage: async () => ({ advanced: false }),
}));

const mockClaim = jest.fn<Promise<unknown>, unknown[]>(async () => null);
jest.mock("../lib/approvals-db", () => ({
  claimApproval: (...args: unknown[]) => mockClaim(...args),
  releaseApproval: async () => undefined,
}));

type RouteModule = typeof import("../app/api/scripts/apply/route");
let POST: RouteModule["POST"];

function connectionRow(environment: string) {
  return {
    host: "db.test", port: 5432, database_name: "sales", username: "app",
    password: "not-a-real-password", connection_string: null, ssl: false,
    ssl_mode: "disable", environment,
  };
}

// Two families in one run, listed out of alphabetical order on purpose. a_fix
// carries a comment-only rollback, the kind Version Sync used to store.
const RUN = {
  connectionId: 7,
  schemaName: "sales",
  scripts: [
    {
      script_name: "b_fix", version: "1.0.0",
      sql_content: "CREATE TABLE b (id int);", down_sql: "DROP TABLE b;",
    },
    {
      script_name: "a_fix", version: "1.0.0",
      sql_content: "CREATE TABLE a (id int);", down_sql: "-- nothing to undo\n",
    },
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

let guard: GitHubGuard;
let consoleSpy: jest.SpyInstance;
let logSpy: jest.SpyInstance;

beforeAll(async () => {
  ({ POST } = await import("../app/api/scripts/apply/route"));
});

beforeEach(() => {
  guard = guardGitHub();
  mockPoolQuery.mockReset();
  mockPoolQuery.mockResolvedValue({ rows: [connectionRow("dev")] });
  mockClaim.mockReset();
  mockClaim.mockResolvedValue(null);
  mockClient = createFakeClient(target());
  consoleSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  consoleSpy.mockRestore();
  logSpy.mockRestore();
  guard.restore();
  expect(guard.unexpected).toEqual([]);
});

it("locks every family, sorted, after lock_timeout and before any per-version lock", async () => {
  const res = await apply(RUN);
  expect(res.status).toBe(200);

  const texts = queryTexts(mockClient);
  const locks = mockClient.queries
    .map((q, index) => ({ index, key: /pg_advisory_xact_lock/.test(q.text) ? String(q.values?.[1]) : null }))
    .filter((lock) => lock.key !== null);
  const timeout = texts.indexOf("SET LOCAL lock_timeout = 15000");

  expect(locks.map((lock) => lock.key)).toEqual([
    "family:a_fix",
    "family:b_fix",
    "b_fix|1.0.0",
    "a_fix|1.0.0",
  ]);
  expect(timeout).toBeGreaterThanOrEqual(0);
  expect(timeout).toBeLessThan(locks[0].index);
  expect(mockClient.queries[locks[0].index].values).toEqual(["sales", "family:a_fix"]);
});

it("answers 503 naming a running deploy or rollback when a family lock times out", async () => {
  mockClient = createFakeClient(
    target([
      {
        match: /pg_advisory_xact_lock/,
        when: (values) => values[1] === "family:a_fix",
        error: { code: "55P03", message: "canceling statement due to lock timeout" },
      },
    ])
  );
  const res = await apply(RUN);
  expect(res.status).toBe(503);
  expect(String(res.body.error)).toContain("waited 15 seconds");
  expect(String(res.body.error)).toContain("a deploy or rollback of the same script that is still running");
  expect(queryTexts(mockClient)).toContain("ROLLBACK");
});

it("stores a comment-only rollback as NULL and a real one as written", async () => {
  await apply(RUN);
  const inserts = queriesMatching(mockClient, /INSERT INTO "sales"\.script_patch/);
  const downSqlFor = (name: string) => inserts.find((q) => q.values?.[0] === name)?.values?.[7];
  expect(downSqlFor("a_fix")).toBeNull();
  expect(downSqlFor("b_fix")).toBe("DROP TABLE b;");
});

it("claims a 'deploy' approval on a real production run", async () => {
  mockPoolQuery.mockResolvedValue({ rows: [connectionRow("prod")] });
  mockClaim.mockResolvedValue({ id: 9 });
  const res = await apply({ ...RUN, acknowledgeProduction: true });
  expect(res.status).toBe(200);
  expect(mockClaim).toHaveBeenCalledTimes(1);
  expect(mockClaim.mock.calls[0][0]).toMatchObject({ connectionId: 7, schemaName: "sales", action: "deploy" });
});
