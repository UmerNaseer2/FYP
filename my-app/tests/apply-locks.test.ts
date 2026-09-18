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
  requireEditor: async () => ({ ok: true, principal: { email: "a@test", role: "editor", bypass: false } }),
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

// The GitHub registry. The apply route records every committed version there
// (spec 07), and the real module reads GITHUB_PAT / GITHUB_REPO_OWNER /
// GITHUB_REPO_NAME out of .env.local — which next/jest loads exactly as
// `next dev` does. Left unmocked, a test that reaches COMMIT would write
// migration files into somebody's actual registry repository. Mocked to answer
// "not configured", which is the same answer a server with no GitHub settings
// gives, so the route takes its ordinary path.
jest.mock("../lib/registry-archive", () => ({
  archiveAppliedVersions: async () => null,
}));

const mockClaim = jest.fn<Promise<unknown>, unknown[]>(async () => null);
const mockReleaseApproval = jest.fn<Promise<void>, unknown[]>(async () => undefined);
jest.mock("../lib/approvals-db", () => ({
  claimApproval: (...args: unknown[]) => mockClaim(...args),
  releaseApproval: (...args: unknown[]) => mockReleaseApproval(...args),
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
  mockReleaseApproval.mockClear();
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
  // The same status as a run that never started, so the flag is what tells
  // them apart: this one opened its transaction and rolled it back.
  expect(res.body.nothingRan).toBeUndefined();
});

/**
 * The audit row the route writes for one attempt, or null when it wrote none.
 *
 * Read off the METADATA pool, not the target client, and that is the whole
 * point of the feature: the target's ledger row is written inside the run's
 * transaction, so the ROLLBACK below takes it away again. This one is on a
 * different connection and survives.
 */
function auditRow(): unknown[] | null {
  const call = mockPoolQuery.mock.calls.find((args) =>
    String(args[0]).includes("INSERT INTO deploy_attempts")
  );
  return call ? (call[1] as unknown[]) : null;
}

it("records a lock timeout in the audit trail, which the ROLLBACK cannot erase", async () => {
  // Spec feature 07 — "Track SQL execution history for auditing".
  //
  // This is the case the trail exists for. The run opened its transaction, the
  // lock timed out, and the ROLLBACK undid every statement in it — including
  // the script_patch row that would have been the only record of the attempt.
  // Before this, a timed-out deploy left the target with no memory of it at
  // all, and the operator with nothing to show anyone.
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
  expect(queryTexts(mockClient)).toContain("ROLLBACK");

  const row = auditRow();
  expect(row).not.toBeNull();
  // Ordered as the INSERT lists them: connection, schema, scripts, outcome,
  // dry_run, http_status, detail, actor.
  const [, schemaName, scripts, outcome, dryRun, status, detail] = row as unknown[];
  expect(schemaName).toBe("sales");
  // "failed", not "refused": it reached its transaction. The two are separate
  // so a reader knows whether there was ever anything to inspect.
  expect(outcome).toBe("failed");
  expect(dryRun).toBe(false);
  expect(status).toBe(503);
  // The reason the operator was given, kept verbatim — a refusal they have
  // since closed the tab on is otherwise unrecoverable.
  expect(String(detail)).toContain("waited 15 seconds");
  // Both migrations in the run, so the row says what was asked for and not
  // just what broke.
  expect(JSON.parse(String(scripts))).toEqual([
    { script_name: "b_fix", version: "1.0.0" },
    { script_name: "a_fix", version: "1.0.0" },
  ]);
});

it("records a run that committed, and stores no reason for it", async () => {
  // The other end of the same trail: a success is a row too, or the history
  // would be a list of nothing but problems.
  const res = await apply(RUN);
  expect(res.status).toBe(200);
  const row = auditRow();
  expect(row).not.toBeNull();
  const [, , , outcome, , status, detail] = row as unknown[];
  expect(outcome).toBe("applied");
  expect(status).toBe(200);
  expect(detail).toBeNull();
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

// ─── A COMMIT that failed ──────────────────────────────────────────────────
// The two halves of the same moment. Only one of them is genuinely unknown,
// and telling them apart is what stops the screen sending somebody to read
// script_patch over a constraint the error had already named.

/** The run's COMMIT throws whatever this says. */
function commitFails(error: FakeStep["error"]): FakeStep[] {
  return target([{ match: /^COMMIT$/, error }]);
}

it("says the server rolled the run back when it refuses the COMMIT", async () => {
  mockPoolQuery.mockResolvedValue({ rows: [connectionRow("prod")] });
  mockClaim.mockResolvedValue({ id: 9 });
  mockClient = createFakeClient(
    commitFails({
      code: "23503",
      message: 'insert or update on table "orders" violates foreign key constraint',
      constraint: "orders_customer_fkey",
      table: "orders",
    })
  );
  const res = await apply({ ...RUN, acknowledgeProduction: true });

  expect(res.status).toBe(500);
  // Not unknown: the server answered, so it did the rollback itself.
  expect(res.body.outcomeUnknown).toBeUndefined();
  expect(String(res.body.error)).toContain("refused the COMMIT");
  expect(String(res.body.error)).toContain("nothing was applied");
  // And the constraint it named comes through, which is the whole point.
  expect(String(res.body.error)).toContain('constraint "orders_customer_fkey" on "orders"');
  expect(String(res.body.error)).not.toContain("script_patch");
  // Every script in the run is reported failed, not "unknown" and not
  // "skipped" — they all ran and none of them survived.
  expect(res.body.results).toEqual([
    { script_name: "b_fix", version: "1.0.0", status: "failed", error: "The COMMIT was refused, so the whole run was rolled back." },
    { script_name: "a_fix", version: "1.0.0", status: "failed", error: "The COMMIT was refused, so the whole run was rolled back." },
  ]);
  // Nothing landed, so the approval was not spent: it goes back for the
  // operator to fix the data and press Deploy again.
  expect(mockReleaseApproval).toHaveBeenCalledWith(9);
});

it("still says the outcome is unknown when the COMMIT does not report back", async () => {
  mockPoolQuery.mockResolvedValue({ rows: [connectionRow("prod")] });
  mockClaim.mockResolvedValue({ id: 9 });
  // A socket that died mid-COMMIT: no SQLSTATE, so nobody can say whether the
  // server wrote it. This is the case the "go and look" answer is for.
  mockClient = createFakeClient(commitFails({ message: "Connection terminated unexpectedly" }));
  const res = await apply({ ...RUN, acknowledgeProduction: true });

  expect(res.status).toBe(500);
  expect(res.body.outcomeUnknown).toBe(true);
  expect(String(res.body.error)).toContain("did not report back");
  expect(String(res.body.error)).toContain("script_patch");
  expect((res.body.results as { status: string }[]).map((row) => row.status)).toEqual([
    "unknown",
    "unknown",
  ]);
  // The approval stays spent: handing it back would put a one-click re-run of
  // migrations that may already be applied under a screen that has just said
  // it does not know.
  expect(mockReleaseApproval).not.toHaveBeenCalled();
});
