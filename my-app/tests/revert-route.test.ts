// POST /api/scripts/revert: undo applied versions of one script family, newest
// first, in one transaction.
//
// The target database is the fake client from helpers/fake-pg: each test
// says what the ledger holds, and then checks what the route said to the
// database (BEGIN, the locks, the rollback SQL, the audit rows, COMMIT or
// ROLLBACK) and what it told the operator. Nothing here reaches a real
// database or GitHub.
import { NextRequest } from "next/server";
import {
  createFakeClient,
  queriesMatching,
  queryTexts,
  type FakeClient,
  type FakeStep,
} from "./helpers/fake-pg";
import { FAKE_TOKEN, guardGitHub, type GitHubGuard } from "./helpers/no-github";
import { TEST_ORG } from "./helpers/principals";
import { UNREADABLE_CREDENTIALS_MESSAGE } from "@/lib/secret-store";

// Relative paths on purpose: next/jest rewrites the @/ alias inside import
// statements only, so jest.mock("@/...") would not resolve.
// The caller: an editor on a new install, whose role may run deployments. A
// test sets mockBypass to play the auth bypass's one principal instead, the
// full admin that answers for everyone while sign-in is off, and mockRuleOff
// an editor in an organization whose two-person rule is switched off.
let mockBypass = false;
let mockRuleOff = false;
jest.mock("../lib/auth-guard", () => {
  const { bypassAdminPrincipal, principalFor } = require("./helpers/principals");
  return {
    requirePermission: async () => ({
      ok: true,
      principal: mockBypass
        ? bypassAdminPrincipal()
        : principalFor("editor", { email: "a@test", orgTwoPersonRule: !mockRuleOff }),
    }),
  };
});
afterEach(() => {
  mockBypass = false;
  mockRuleOff = false;
});

// The metadata database: only the saved-connection lookup reaches it.
const mockPoolQuery = jest.fn<Promise<unknown>, unknown[]>(async () => ({ rows: [] }));
jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: { query: (...args: unknown[]) => mockPoolQuery(...args) },
  syncMetadataTables: async () => undefined,
}));

// The target database: whatever fake client the test built.
let mockClient: FakeClient;
jest.mock("../lib/postgres", () => ({
  getPoolForConfig: () => ({ connect: async () => mockClient }),
}));
// Made to throw once to play a saved password this server can't decrypt.
const mockBuildPgConfig = jest.fn<unknown, unknown[]>(() => ({}));
jest.mock("../lib/connection-config", () => ({
  buildPgConfig: (...args: unknown[]) => mockBuildPgConfig(...args),
}));

const mockRecordLineage = jest.fn<Promise<unknown>, unknown[]>(async () => ({ advanced: false }));
jest.mock("../lib/lineage-db", () => ({
  recordAppliedMigrationToLineage: (...args: unknown[]) => mockRecordLineage(...args),
}));

const mockClaim = jest.fn<Promise<unknown>, unknown[]>(async () => null);
const mockRelease = jest.fn<Promise<void>, unknown[]>(async () => undefined);
jest.mock("../lib/approvals-db", () => ({
  approvalsOn: jest.requireActual("../lib/approvals-db").approvalsOn,
  claimApproval: (...args: unknown[]) => mockClaim(...args),
  releaseApproval: (...args: unknown[]) => mockRelease(...args),
}));

// The audit trail. The route hands every answer to recordDeployAttempt; the
// writer itself is tested in tests/deploy-attempts.test.ts.
const mockRecordAttempt = jest.fn<Promise<void>, unknown[]>(async () => undefined);
jest.mock("../lib/deploy-attempts-db", () => ({
  recordDeployAttempt: (...args: unknown[]) => mockRecordAttempt(...args),
}));

type RouteModule = typeof import("../app/api/scripts/revert/route");
let POST: RouteModule["POST"];

type LedgerRow = {
  id: number;
  version: string;
  title: string;
  change_type: string;
  applied_at: string;
  down_sql: string | null;
  /** Who applied it. Absent on V1 on purpose — see the archive test. */
  applied_by?: string | null;
};

// orders_fix has three versions applied, each with its own rollback.
const V1: LedgerRow = {
  id: 1, version: "1.0.0", title: "Add orders", change_type: "additive",
  applied_at: "2026-01-01T00:00:00.000Z", down_sql: "DROP TABLE t1;",
};
const V2: LedgerRow = {
  id: 2, version: "2.0.0", title: "Drop legacy", change_type: "breaking",
  applied_at: "2026-02-01T00:00:00.000Z", down_sql: "DROP TABLE t2;",
  applied_by: "alice@test",
};
const V3: LedgerRow = {
  id: 3, version: "3.0.0", title: "Rename a column", change_type: "patch",
  applied_at: "2026-03-01T00:00:00.000Z", down_sql: "DROP TABLE t3;",
  applied_by: "bob@test",
};

// Every rollback above is a DROP TABLE, which deletes rows, so the route asks
// for the data-loss tick. BASE carries it, so each test reaches the check it
// is about; the "rows the rollback deletes" tests leave it out on purpose.
const UNTICKED = { connectionId: 7, schemaName: "sales", script_name: "orders_fix" };
const BASE = { ...UNTICKED, acknowledgeDataLoss: true };

function connectionRow(environment: string, execute_role?: string) {
  return {
    host: "db.test", port: 5432, database_name: "sales", username: "app",
    password: "not-a-real-password", connection_string: null, ssl: false,
    ssl_mode: "disable", environment, name: "Sales dev", execute_role,
  };
}

/** The answers a healthy target gives. `first` steps win over these. */
function ledger(options: {
  rows?: LedgerRow[];
  others?: Record<string, unknown>[];
  first?: FakeStep[];
} = {}): FakeStep[] {
  return [
    ...(options.first ?? []),
    // No extension lives in a schema of its own, so the search_path is the
    // target schema alone (lib/run-settings). Before the schema check below,
    // because both read pg_namespace.
    { match: /extnamespace/, rows: [] },
    { match: /FROM pg_namespace/, rows: [{ exists: 1 }] },
    { match: /to_regclass/, rows: [{ reg: "script_patch" }] },
    {
      match: /column_name IN \('down_sql', 'applied_by'\)/,
      rows: [{ column_name: "down_sql" }, { column_name: "applied_by" }],
    },
    { match: /script_name <> \$1/, rows: options.others ?? [] },
    { match: /SELECT id, version, title, change_type, applied_at/, rows: options.rows ?? [V1, V2, V3] },
    { match: /DELETE FROM/, rowCount: 1 },
  ];
}

async function revert(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await POST(
    new NextRequest("http://localhost/api/scripts/revert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
  const text = await res.text();
  // Whatever happens, no secret reaches the browser.
  expect(text).not.toContain(FAKE_TOKEN);
  expect(text).not.toContain("not-a-real-password");
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown> };
}

const count = (client: FakeClient, text: string) => queryTexts(client).filter((t) => t === text).length;
const ran = (client: FakeClient, sql: string) => queryTexts(client).includes(sql);

let guard: GitHubGuard;
let consoleSpy: jest.SpyInstance;

beforeAll(async () => {
  // Imported after the jest.mock calls above, so the route sees the stand-ins.
  ({ POST } = await import("../app/api/scripts/revert/route"));
});

beforeEach(() => {
  guard = guardGitHub();
  mockPoolQuery.mockReset();
  mockPoolQuery.mockResolvedValue({ rows: [connectionRow("dev")] });
  mockClaim.mockReset();
  mockClaim.mockResolvedValue(null);
  mockRelease.mockReset();
  mockRelease.mockResolvedValue(undefined);
  mockRecordAttempt.mockClear();
  mockRecordLineage.mockReset();
  mockRecordLineage.mockResolvedValue({ advanced: false });
  // Calls only: its stand-in stays, and the one test that makes it throw does
  // so for a single call.
  mockBuildPgConfig.mockClear();
  mockClient = createFakeClient(ledger());
  // The route logs its failures; the assertions below read the responses.
  consoleSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  consoleSpy.mockRestore();
  guard.restore();
  expect(guard.unexpected).toEqual([]);
});

describe("request checks (before any database)", () => {
  it("refuses an empty, duplicated or malformed version list", async () => {
    for (const versions of [[], ["1.2", "1.2.0"], ["abc"]]) {
      const res = await revert({ ...BASE, versions });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ ok: false, success: false });
    }
    expect(mockPoolQuery).not.toHaveBeenCalled();
    expect(mockClient.queries).toEqual([]);
  });

  it("refuses more versions than one rollback may undo, in words a person can act on", async () => {
    const versions = Array.from({ length: 51 }, (_, index) => `${51 - index}.0.0`);
    const res = await revert({ ...BASE, versions });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      "A rollback can undo at most 50 versions at a time, and this request lists 51. Nothing was " +
        "rolled back. Roll back in steps: undo the newest 50 first, then roll back again."
    );
    expect(mockPoolQuery).not.toHaveBeenCalled();
    expect(mockClient.queries).toEqual([]);
  });

  it("refuses a registry rollback for a version the request does not undo", async () => {
    const res = await revert({
      ...BASE,
      versions: ["3.0.0"],
      registryRollbacks: [{ version: "2.0.0", down_sql: "DROP TABLE t2;" }],
    });
    expect(res.status).toBe(400);
    expect(mockClient.queries).toEqual([]);
  });

  it("refuses a registry copy with COMMIT before connecting, naming the version", async () => {
    // The legacy body: {version, sql_content}.
    const res = await revert({ ...BASE, version: "3.0.0", sql_content: "DROP TABLE t3; COMMIT;" });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain("v3.0.0");
    expect(String(res.body.error)).toContain("COMMIT or ROLLBACK");
    expect(mockPoolQuery).not.toHaveBeenCalled();
    expect(mockClient.queries).toEqual([]);
  });
});

describe("credentials", () => {
  it("says what to fix when the saved password can't be read here, before touching the database", async () => {
    // What decryptSecret throws for a password saved under another key.
    mockBuildPgConfig.mockImplementationOnce(() => {
      throw new Error("Unsupported state or unable to authenticate data");
    });
    const res = await revert({ ...BASE, versions: ["3.0.0"] });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      ok: false,
      success: false,
      error: `Nothing was run. ${UNREADABLE_CREDENTIALS_MESSAGE}`,
    });
    // The cause is for the server log, not the screen.
    expect(JSON.stringify(res.body)).not.toContain("Unsupported state");
    expect(consoleSpy).toHaveBeenCalledWith(
      "Revert — could not read the saved connection's credentials:",
      "Unsupported state or unable to authenticate data"
    );
    expect(mockClient.queries).toEqual([]);
    expect(mockClient.releaseCount).toBe(0);
    expect(mockClaim).not.toHaveBeenCalled();
  });
});

describe("production", () => {
  it("refuses without the production acknowledgement, dry run included, before BEGIN", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [connectionRow("prod")] });
    for (const dryRun of [false, true]) {
      const res = await revert({ ...BASE, versions: ["3.0.0"], dryRun });
      expect(res.status).toBe(409);
    }
    expect(mockClient.queries).toEqual([]);
  });

  it("needs a second person's approval for a real run, and runs nothing without one", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [connectionRow("prod")] });
    const res = await revert({ ...BASE, versions: ["3.0.0"], acknowledgeProduction: true });
    expect(res.status).toBe(403);
    expect(res.body.needsApproval).toBe(true);
    expect(res.body.error).toBe(
      "Rolling back on production needs a second person's approval. Ask for it in the " +
        "Approvals panel, then press Roll back again."
    );
    expect(count(mockClient, "ROLLBACK")).toBe(1);
    expect(ran(mockClient, "DROP TABLE t3;")).toBe(false);
    expect(mockRelease).not.toHaveBeenCalled();
    expect(mockClient.listenersAtRelease).toBe(0);
  });

  it("asks for no approval under the auth bypass", async () => {
    // With the bypass on there is no second person to ask, so approvals are off.
    mockBypass = true;
    mockPoolQuery.mockResolvedValue({ rows: [connectionRow("prod")] });
    const res = await revert({ ...BASE, versions: ["3.0.0"], acknowledgeProduction: true });
    expect(res.status).toBe(200);
    expect(mockClaim).not.toHaveBeenCalled();
    expect(ran(mockClient, "DROP TABLE t3;")).toBe(true);
  });

  it("asks for no approval with the two-person rule off", async () => {
    mockRuleOff = true;
    mockPoolQuery.mockResolvedValue({ rows: [connectionRow("prod")] });
    const res = await revert({ ...BASE, versions: ["3.0.0"], acknowledgeProduction: true });
    expect(res.status).toBe(200);
    expect(mockClaim).not.toHaveBeenCalled();
    expect(ran(mockClient, "DROP TABLE t3;")).toBe(true);
  });

  it("asks for no tick and no approval off production", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [connectionRow("staging")] });
    const res = await revert({ ...BASE, versions: ["3.0.0"] });
    expect(res.status).toBe(200);
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("claims a 'revert' approval for the ledger SQL, newest first, and keeps it spent", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [connectionRow("prod")] });
    mockClaim.mockResolvedValue({ id: 42 });
    const res = await revert({
      ...BASE,
      versions: ["2.0.0", "3.0.0"],
      acknowledgeProduction: true,
      // Ignored: the ledger copy wins.
      registryRollbacks: [{ version: "3.0.0", down_sql: "DROP TABLE registry_t3;" }],
    });
    expect(res.status).toBe(200);
    expect(mockClaim).toHaveBeenCalledTimes(1);
    expect(mockClaim.mock.calls[0][0]).toEqual({
      // Only an approval given in the caller's organization can be spent.
      orgId: TEST_ORG.id,
      connectionId: 7,
      schemaName: "sales",
      action: "revert",
      scripts: [
        { scriptName: "orders_fix", version: "3.0.0", sqlContent: "DROP TABLE t3;" },
        { scriptName: "orders_fix", version: "2.0.0", sqlContent: "DROP TABLE t2;" },
      ],
    });
    expect(count(mockClient, "COMMIT")).toBe(1);
    expect(mockRelease).not.toHaveBeenCalled();
  });
});

describe("dry run", () => {
  it("needs no production approval, and spends none", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [connectionRow("prod")] });
    const res = await revert({ ...BASE, versions: ["3.0.0"], dryRun: true, acknowledgeProduction: true });
    expect(res.status).toBe(200);
    expect(mockClaim).not.toHaveBeenCalled();
    expect(count(mockClient, "COMMIT")).toBe(0);
  });

  it("runs the rollback, reports its NOTICEs, then rolls back", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [connectionRow("prod")] });
    mockClaim.mockResolvedValue({ id: 42 });
    mockClient = createFakeClient(
      ledger({
        first: [
          { match: /^DROP TABLE t3;$/, notice: "drop cascades to view v_orders" },
          // The route's own bookkeeping is not the operator's news.
          { match: /CREATE TABLE IF NOT EXISTS/, notice: "relation already exists, skipping" },
        ],
      })
    );
    const res = await revert({ ...BASE, versions: ["3.0.0"], dryRun: true, acknowledgeProduction: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, success: true, dryRun: true, versions: ["3.0.0"] });
    expect(res.body.notices).toEqual([{ version: "3.0.0", message: "drop cascades to view v_orders" }]);
    expect(String(res.body.message)).toContain("Dry run passed: the rollback of v3.0.0");
    expect(String(res.body.message)).toContain("PostgreSQL also reported: v3.0.0: drop cascades to view v_orders");
    expect(ran(mockClient, "DROP TABLE t3;")).toBe(true);
    expect(count(mockClient, "ROLLBACK")).toBe(1);
    expect(count(mockClient, "COMMIT")).toBe(0);
    // A rehearsal never touches an approval.
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockRelease).not.toHaveBeenCalled();
    expect(mockClient.listenersAtRelease).toBe(0);
  });
});

describe("transaction setup", () => {
  it("answers 404 for a schema that does not exist, before BEGIN", async () => {
    mockClient = createFakeClient(ledger({ first: [{ match: /FROM pg_namespace/, rows: [] }] }));
    const res = await revert({ ...BASE, versions: ["3.0.0"] });
    expect(res.status).toBe(404);
    expect(String(res.body.error)).toBe('Schema "sales" does not exist on "Sales dev". Pick another schema.');
    expect(count(mockClient, "BEGIN")).toBe(0);
    expect(mockClient.releaseCount).toBe(1);
  });

  it("takes BEGIN, lock_timeout, the family lock, the version lock, then search_path", async () => {
    await revert({ ...BASE, versions: ["3.0.0"] });
    const texts = queryTexts(mockClient);
    const lockAt = (key: string) =>
      mockClient.queries.findIndex((q) => /pg_advisory_xact_lock/.test(q.text) && q.values?.[1] === key);
    const begin = texts.indexOf("BEGIN");
    const timeout = texts.indexOf("SET LOCAL lock_timeout = 15000");
    const family = lockAt("family:orders_fix");
    const version = lockAt("orders_fix|3.0.0");
    const searchPath = texts.indexOf('SET LOCAL search_path TO "sales"');
    expect(begin).toBeGreaterThanOrEqual(0);
    expect([begin < timeout, timeout < family, family < version, version < searchPath]).toEqual([
      true, true, true, true,
    ]);
    expect(mockClient.queries[family].values).toEqual(["sales", "family:orders_fix"]);
  });

  it("answers 503 with a readable copy when a lock wait times out (55P03)", async () => {
    mockClient = createFakeClient(
      ledger({
        first: [
          {
            match: /pg_advisory_xact_lock/,
            when: (values) => values[1] === "family:orders_fix",
            error: { code: "55P03", message: "canceling statement due to lock timeout" },
          },
        ],
      })
    );
    const res = await revert({ ...BASE, versions: ["3.0.0"] });
    expect(res.status).toBe(503);
    expect(String(res.body.error)).toContain("waited 15 seconds");
    expect(String(res.body.error)).toContain("deploy or rollback of this script is running");
    expect(count(mockClient, "ROLLBACK")).toBe(1);
    expect(mockClient.releaseCount).toBe(1);
  });
});

describe("ledger checks", () => {
  it("refuses a schema with no ledger", async () => {
    mockClient = createFakeClient(ledger({ first: [{ match: /to_regclass/, rows: [{ reg: null }] }] }));
    const res = await revert({ ...BASE, versions: ["3.0.0"] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("no_ledger");
  });

  it("refuses a version that is not applied", async () => {
    const res = await revert({ ...BASE, versions: ["4.0.0"] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("not_applied");
    expect(String(res.body.error)).toBe(
      'v4.0.0 of "orders_fix" is not applied to schema "sales", so it can\'t be rolled back. ' +
        "Nothing was rolled back. Someone may have rolled it back already: check the database " +
        "again and plan the rollback from what is applied now."
    );
    expect(count(mockClient, "ROLLBACK")).toBe(1);
  });

  it("refuses to undo v2.0.0 while v3.0.0 is still applied, naming v3.0.0", async () => {
    const res = await revert({ ...BASE, versions: ["2.0.0"] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("not_newest");
    expect(res.body.mustAlsoUndo).toEqual(["3.0.0"]);
    expect(String(res.body.error)).toContain("v3.0.0 of \"orders_fix\" is newer than v2.0.0");
    // The page reads the ledger again on this code, and the advice matches.
    expect(String(res.body.error)).toContain(
      "Nothing was rolled back. This usually means the list of applied versions was out of date: " +
        "check the database again and plan the rollback from what is applied now."
    );
    expect(ran(mockClient, "DROP TABLE t2;")).toBe(false);
  });

  it("refuses when no copy has a statement that runs, and deletes nothing", async () => {
    mockClient = createFakeClient(ledger({ rows: [V1, V2, { ...V3, down_sql: "-- nothing to undo\n" }] }));
    const res = await revert({
      ...BASE,
      versions: ["3.0.0"],
      registryRollbacks: [{ version: "3.0.0", down_sql: "/* still nothing */" }],
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("no_rollback");
    expect(String(res.body.error)).toContain("Add a missing rollback");
    expect(queriesMatching(mockClient, /DELETE FROM/)).toHaveLength(0);
  });

  it("refuses a stored rollback that contains COMMIT, without re-push advice", async () => {
    mockClient = createFakeClient(ledger({ rows: [V1, V2, { ...V3, down_sql: "DROP TABLE t3; COMMIT;" }] }));
    const res = await revert({ ...BASE, versions: ["3.0.0"] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("transaction_control");
    expect(String(res.body.error)).toContain("Run it by hand from a SQL console.");
    expect(String(res.body.error)).not.toContain("push");
  });
});

describe("which rollback runs", () => {
  it("prefers the ledger copy over the registry copy", async () => {
    const res = await revert({
      ...BASE,
      versions: ["3.0.0"],
      registryRollbacks: [{ version: "3.0.0", down_sql: "DROP TABLE registry_t3;" }],
    });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([{ version: "3.0.0", source: "ledger" }]);
    expect(ran(mockClient, "DROP TABLE t3;")).toBe(true);
    expect(ran(mockClient, "DROP TABLE registry_t3;")).toBe(false);
  });

  it("falls back to the registry copy when the ledger copy is comment-only or missing", async () => {
    for (const stored of ["-- generated, nothing to undo", null]) {
      mockClient = createFakeClient(ledger({ rows: [V1, V2, { ...V3, down_sql: stored }] }));
      // The legacy body carries the registry copy as sql_content.
      const res = await revert({ ...BASE, version: "3.0.0", sql_content: "DROP TABLE registry_t3;" });
      expect(res.status).toBe(200);
      expect(res.body.results).toEqual([{ version: "3.0.0", source: "registry" }]);
      expect(ran(mockClient, "DROP TABLE registry_t3;")).toBe(true);
      // The audit row keeps the SQL that actually ran.
      const audit = queriesMatching(mockClient, /INSERT INTO "sales"\.script_patch_reverted/);
      expect(audit[0].values?.[7]).toBe("DROP TABLE registry_t3;");
    }
  });
});

describe("a batch rollback", () => {
  it("undoes v3.0.0 then v2.0.0 in one transaction, with one lineage entry", async () => {
    const res = await revert({ ...BASE, versions: ["2.0.0", "3.0.0"] });
    expect(res.status).toBe(200);

    const texts = queryTexts(mockClient);
    expect(texts.indexOf("DROP TABLE t3;")).toBeLessThan(texts.indexOf("DROP TABLE t2;"));

    const audit = queriesMatching(mockClient, /INSERT INTO "sales"\.script_patch_reverted/);
    // The archive keeps BOTH names: who applied the version (copied from the
    // ledger row about to be deleted) and who took it out (this request).
    expect(audit.map((q) => q.values)).toEqual([
      ["orders_fix", "3.0.0", "Rename a column", "patch", V3.applied_at, "bob@test", "a@test", "DROP TABLE t3;"],
      ["orders_fix", "2.0.0", "Drop legacy", "breaking", V2.applied_at, "alice@test", "a@test", "DROP TABLE t2;"],
    ]);
    expect(queriesMatching(mockClient, /DELETE FROM/).map((q) => q.values)).toEqual([[3], [2]]);
    expect(count(mockClient, "COMMIT")).toBe(1);
    expect(count(mockClient, "ROLLBACK")).toBe(0);

    expect(mockRecordLineage).toHaveBeenCalledTimes(1);
    expect(mockRecordLineage.mock.calls[0][0]).toMatchObject({
      connectionId: 7,
      schemaName: "sales",
      // The bump is graded from the structure the rollback left. The loudest
      // stored level is only the fallback when HEAD has no snapshot, because
      // a stored level describes the forward change, not its undo.
      changeLevel: "breaking",
      levelFromStructure: true,
      name: "Revert orders_fix v3.0.0, v2.0.0",
    });

    expect(res.body).toMatchObject({
      ok: true,
      success: true,
      dryRun: false,
      version: "2.0.0",
      versions: ["3.0.0", "2.0.0"],
      schema: "sales",
    });
    expect(res.body.message).toBe(
      'Rolled back v3.0.0 and v2.0.0 of "orders_fix" in schema "sales" - this script is back at v1.0.0.'
    );
    expect(mockClient.releaseCount).toBe(1);
    expect(mockClient.listenersAtRelease).toBe(0);
  });

  it("archives a null applier for a version the ledger never named one for", async () => {
    // V1 carries no applied_by: it was applied before the column existed. The
    // archive says so rather than borrowing the name of whoever reverted it —
    // an audit row that invents an applier is worse than one that admits it
    // does not know.
    const res = await revert({ ...BASE, versions: ["1.0.0", "2.0.0", "3.0.0"] });
    expect(res.status).toBe(200);
    const audit = queriesMatching(mockClient, /INSERT INTO "sales"\.script_patch_reverted/);
    const v1 = audit[audit.length - 1];
    expect(v1.values?.[1]).toBe("1.0.0");
    expect(v1.values?.[5]).toBeNull();
    expect(v1.values?.[6]).toBe("a@test");
  });

  it("says so when no version is left, and uses the one-version copy for one", async () => {
    const all = await revert({ ...BASE, versions: ["1.0.0", "2.0.0", "3.0.0"] });
    expect(String(all.body.message)).toContain("- no version of this script is applied now.");

    mockClient = createFakeClient(ledger());
    const one = await revert({ ...BASE, versions: ["3.0.0"] });
    expect(one.body.message).toBe(
      'Rolled back v3.0.0 of "orders_fix" in schema "sales". It shows as pending again and can be deployed.'
    );
  });
});

describe("other script families", () => {
  const others = [{ script_name: "billing_fix", version: "1.1.0", applied_at: "2026-03-15T00:00:00.000Z" }];

  it("refuses a real run on production until they are acknowledged, and asks from the oldest version undone", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [connectionRow("prod")] });
    mockClaim.mockResolvedValue({ id: 42 });
    mockClient = createFakeClient(ledger({ others }));
    const res = await revert({ ...BASE, versions: ["3.0.0", "2.0.0"], acknowledgeProduction: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("other_scripts_after");
    expect(res.body.otherScripts).toEqual(others);
    expect(String(res.body.error)).toContain('Other scripts were applied to schema "sales" after v2.0.0 (billing_fix v1.1.0)');
    // "After" is decided in SQL from the ledger ids being undone, never from a
    // timestamp that went through a JS Date (milliseconds, not microseconds).
    const later = queriesMatching(mockClient, /script_name <> \$1/)[0];
    expect(later.values).toEqual(["orders_fix", [3, 2]]);
    expect(later.text).toContain("other.applied_at = oldest.applied_at AND other.id > oldest.id");
    expect(ran(mockClient, "DROP TABLE t3;")).toBe(false);
  });

  it("proceeds once acknowledged", async () => {
    mockClient = createFakeClient(ledger({ others }));
    const res = await revert({ ...BASE, versions: ["3.0.0"], acknowledgeOtherScripts: true });
    expect(res.status).toBe(200);
    expect(count(mockClient, "COMMIT")).toBe(1);
  });

  it("lists them in a dry run without refusing", async () => {
    mockClient = createFakeClient(ledger({ others }));
    const res = await revert({ ...BASE, versions: ["3.0.0"], dryRun: true });
    expect(res.status).toBe(200);
    expect(res.body.otherScripts).toEqual(others);
  });
});

describe("rows the rollback deletes", () => {
  it("refuses on production until they are ticked, dry run included, before any rollback SQL runs", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [connectionRow("prod")] });
    mockClaim.mockResolvedValue({ id: 42 });
    for (const dryRun of [false, true]) {
      mockClient = createFakeClient(ledger());
      const res = await revert({ ...UNTICKED, versions: ["3.0.0"], dryRun, acknowledgeProduction: true });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        ok: false,
        success: false,
        code: "data_loss",
        needsAcknowledgement: ["data_loss"],
        dataLoss: [{ version: "3.0.0", kinds: ["DROP TABLE"] }],
      });
      expect(res.body.error).toBe(
        'Rolling back v3.0.0 of "orders_fix" deletes rows (v3.0.0 runs DROP TABLE), and deploying ' +
          "again brings back the structure, not the rows. Nothing was rolled back. Tick the box " +
          `about deleted rows, then ${dryRun ? "start the dry run" : "roll back"} again.`
      );
      expect(ran(mockClient, "DROP TABLE t3;")).toBe(false);
      expect(queriesMatching(mockClient, /DELETE FROM/)).toHaveLength(0);
      expect(count(mockClient, "ROLLBACK")).toBe(1);
      expect(count(mockClient, "COMMIT")).toBe(0);
    }
  });

  it("names only the rollbacks that delete rows", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [connectionRow("prod")] });
    mockClaim.mockResolvedValue({ id: 42 });
    mockClient = createFakeClient(
      ledger({ rows: [V1, V2, { ...V3, down_sql: "CREATE TABLE t3_restored (id int);" }] })
    );
    const res = await revert({ ...UNTICKED, versions: ["2.0.0", "3.0.0"], acknowledgeProduction: true });
    expect(res.status).toBe(409);
    expect(res.body.dataLoss).toEqual([{ version: "2.0.0", kinds: ["DROP TABLE"] }]);
    expect(String(res.body.error)).toContain('Rolling back v2.0.0 of "orders_fix" deletes rows');
  });

  it("claims no production approval while the tick is missing", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [connectionRow("prod")] });
    mockClaim.mockResolvedValue({ id: 42 });
    const res = await revert({ ...UNTICKED, versions: ["3.0.0"], acknowledgeProduction: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("data_loss");
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it("asks for no tick off production, even when rows go", async () => {
    mockClient = createFakeClient(ledger());
    const res = await revert({ ...UNTICKED, versions: ["3.0.0"] });
    expect(res.status).toBe(200);
  });

  it("asks for no tick when no rollback deletes rows, a commented-out DROP included", async () => {
    mockClient = createFakeClient(
      ledger({
        rows: [V1, V2, { ...V3, down_sql: "-- DROP TABLE t3;\nCREATE TABLE t3_restored (id int);" }],
      })
    );
    const res = await revert({ ...UNTICKED, versions: ["3.0.0"] });
    expect(res.status).toBe(200);
    expect(count(mockClient, "COMMIT")).toBe(1);
  });
});

describe("failures", () => {
  it("rolls everything back when a rollback fails, and gives the approval back", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [connectionRow("prod")] });
    mockClaim.mockResolvedValue({ id: 42 });
    mockClient = createFakeClient(
      ledger({ first: [{ match: /^DROP TABLE t2;$/, error: { message: 'table "t2" does not exist' } }] })
    );
    const res = await revert({ ...BASE, versions: ["3.0.0", "2.0.0"], acknowledgeProduction: true });
    expect(res.status).toBe(500);
    expect(String(res.body.error)).toBe(
      "The rollback of v2.0.0 failed, so nothing was changed - every version in this rollback is " +
        'still applied. PostgreSQL said: table "t2" does not exist'
    );
    expect(count(mockClient, "ROLLBACK")).toBe(1);
    expect(count(mockClient, "COMMIT")).toBe(0);
    expect(mockRelease).toHaveBeenCalledWith(TEST_ORG.id, 42);
    expect(mockClient.listenersAtRelease).toBe(0);
  });

  it("says the outcome is unknown when COMMIT fails, and keeps the approval spent", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [connectionRow("prod")] });
    mockClaim.mockResolvedValue({ id: 42 });
    mockClient = createFakeClient(
      ledger({ first: [{ match: /^COMMIT$/, error: { message: "Connection terminated unexpectedly" } }] })
    );
    const res = await revert({ ...BASE, versions: ["3.0.0"], acknowledgeProduction: true });
    expect(res.status).toBe(500);
    expect(res.body.outcomeUnknown).toBe(true);
    expect(String(res.body.error)).toContain("if v3.0.0 shows as pending, the rollback went through");
    expect(String(res.body.error)).not.toContain("nothing was changed");
    expect(mockRelease).not.toHaveBeenCalled();
    expect(mockRecordLineage).not.toHaveBeenCalled();
    expect(mockClient.releaseCount).toBe(1);
    // The connection is the thing in doubt, so it is destroyed rather than
    // handed to the next request.
    expect(mockClient.releasedWith).toBe(true);
  });

  it("says the outcome is unknown when a down script ends the transaction", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [connectionRow("prod")] });
    mockClaim.mockResolvedValue({ id: 42 });
    // txid_current answers "100" before the down script and "101" after it,
    // which is what a COMMIT inside the script that lib/sql-guard missed
    // would look like.
    let reads = 0;
    mockClient = createFakeClient(
      ledger({
        first: [
          { match: /txid_current/, when: () => reads++ === 0, rows: [{ xid: "100" }] },
          { match: /txid_current/, rows: [{ xid: "101" }] },
        ],
      })
    );
    const res = await revert({ ...BASE, versions: ["3.0.0", "2.0.0"], acknowledgeProduction: true });
    expect(res.status).toBe(500);
    expect(res.body.outcomeUnknown).toBe(true);
    expect(String(res.body.error)).toContain("ended the rollback's transaction");
    expect(String(res.body.error)).toContain("may already be committed");
    expect(String(res.body.error)).not.toContain("nothing was changed");
    // The older version's down script never ran, and no COMMIT was sent.
    expect(ran(mockClient, "DROP TABLE t2;")).toBe(false);
    expect(count(mockClient, "COMMIT")).toBe(0);
    expect(mockRelease).not.toHaveBeenCalled();
    expect(mockRecordLineage).not.toHaveBeenCalled();
    expect(mockClient.releasedWith).toBe(true);
  });

  it("says the server undid the rollback when it refuses the COMMIT", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [connectionRow("prod")] });
    mockClaim.mockResolvedValue({ id: 42 });
    // A DEFERRABLE constraint is checked at the COMMIT: the server refuses,
    // rolls the transaction back itself, and names what went wrong. Nothing
    // about that is unknown.
    mockClient = createFakeClient(
      ledger({
        first: [
          {
            match: /^COMMIT$/,
            error: {
              code: "23503",
              message: 'update or delete on table "customers" violates foreign key constraint',
              constraint: "orders_customer_fkey",
              table: "orders",
            },
          },
        ],
      })
    );
    const res = await revert({ ...BASE, versions: ["3.0.0"], acknowledgeProduction: true });
    expect(res.status).toBe(500);
    expect(res.body.outcomeUnknown).toBeUndefined();
    expect(String(res.body.error)).toContain("nothing was changed");
    expect(String(res.body.error)).toContain("still applied");
    expect(String(res.body.error)).toContain('constraint "orders_customer_fkey" on "orders"');
    // Not "reload Deploy and see for yourself": the answer is already here.
    expect(String(res.body.error)).not.toContain("shows as pending");
    // Nothing landed, so the approval goes back and the baseline does not move.
    expect(mockRelease).toHaveBeenCalledWith(TEST_ORG.id, 42);
    expect(mockRecordLineage).not.toHaveBeenCalled();
    // The connection is closed rather than pooled, as after every run: a plain
    // SET in the down script would otherwise outlive the transaction.
    expect(mockClient.releasedWith).toBe(true);
    expect(mockClient.listenersAtRelease).toBe(0);
  });
});

describe("per-connection execution setting", () => {
  // The mirror of the apply route's block. A rollback is an execution like any
  // other — it is the one that DROPS what a migration added — so the same
  // setting refuses it, with the same sentence.

  it("refuses a read-only connection, dry run included, before BEGIN", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [connectionRow("dev", "none")] });
    for (const dryRun of [false, true]) {
      const res = await revert({ ...BASE, versions: ["3.0.0"], dryRun });
      expect(res.status).toBe(403);
      expect(String(res.body.error)).toContain("read-only");
    }
    expect(mockClient.queries).toEqual([]);
  });

  it("refuses an admins-only connection to an editor", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [connectionRow("dev", "admin")] });
    const res = await revert({ ...BASE, versions: ["3.0.0"] });
    expect(res.status).toBe(403);
    expect(mockClient.queries).toEqual([]);
  });

  it("is checked before the production acknowledgement, not after", async () => {
    // Ordering matters for the message, not the outcome: both refuse. A
    // read-only production connection that answered "tick the box" would send
    // the operator to find an approval for a run that could never happen.
    mockPoolQuery.mockResolvedValue({ rows: [connectionRow("prod", "none")] });
    const res = await revert({ ...UNTICKED, versions: ["3.0.0"] });
    expect(res.status).toBe(403);
    expect(String(res.body.error)).toContain("read-only");
  });

  it("lets the default setting through, so old rows keep working", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [connectionRow("dev", undefined)] });
    const res = await revert({ ...BASE, versions: ["3.0.0"] });
    expect(res.status).toBe(200);
  });
});

describe("another organization's connection", () => {
  // Connection ids are shared by every organization, so anybody can send one
  // that is not theirs. The lookup names the caller's organization, and a
  // connection saved in another one reads as missing: the same 404 a deleted
  // one gets, before its password is decrypted, an approval is claimed or
  // anything is sent to its database.
  it("answers 404 for it, decrypting, claiming and running nothing", async () => {
    // The saved row is in the next organization along, and the stand-in
    // answers the way the lookup's WHERE clause would, so only a lookup that
    // left the caller's organization out would find it.
    const theirs = { ...connectionRow("prod"), id: 7, org_id: TEST_ORG.id + 1 };
    mockPoolQuery.mockImplementation(async (...args: unknown[]) => {
      const [text, values = []] = args as [string, unknown[]?];
      const holds = (column: string, value: unknown) => {
        const param = new RegExp(`\\b${column} = \\$(\\d+)`).exec(text);
        return !param || values[Number(param[1]) - 1] === value;
      };
      const found =
        /FROM connections/.test(text) && holds("id", theirs.id) && holds("org_id", theirs.org_id);
      return { rows: found ? [theirs] : [] };
    });
    mockClaim.mockResolvedValue({ id: 42 });

    const res = await revert({ ...BASE, versions: ["3.0.0"], acknowledgeProduction: true });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("No saved connection found with id 7.");
    expect(JSON.stringify(res.body)).not.toContain("Sales dev");
    const lookups = mockPoolQuery.mock.calls.filter(([text]) =>
      /FROM connections/.test(String(text))
    );
    expect(lookups.map(([, values]) => values)).toEqual([[7, TEST_ORG.id]]);
    expect(mockBuildPgConfig).not.toHaveBeenCalled();
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockClient.queries).toEqual([]);
  });
});

// Saving the production database again as a "dev" connection would skip the
// rollback's approval as surely as relabelling it (lib/environment-guard).
describe("a dev connection that reaches a production database", () => {
  function savedAlsoAs(twin: Record<string, unknown> | Error) {
    mockBuildPgConfig.mockImplementation((input) => {
      const { host, port, database } = input as Record<string, unknown>;
      return { host, port, database };
    });
    mockPoolQuery.mockImplementation(async (...args: unknown[]) => {
      if (/environment = 'prod'/.test(String(args[0]))) {
        if (twin instanceof Error) throw twin;
        return { rows: [twin] };
      }
      return { rows: [connectionRow("dev")] };
    });
  }
  const twinRow = (over: Record<string, unknown> = {}) => ({
    id: 8, ...connectionRow("prod"), name: "Sales (prod)", host: "DB.test", ...over,
  });

  afterEach(() => {
    mockBuildPgConfig.mockImplementation(() => ({}));
  });

  it("refuses the rollback and opens nothing on the target", async () => {
    savedAlsoAs(twinRow());
    const res = await revert({ ...BASE, versions: ["3.0.0"] });
    expect(res.status).toBe(409);
    expect(res.body.environment).toBe("prod");
    expect(res.body.error).toMatch(/"Sales \(prod\)", reaches the same database/);
    expect(queryTexts(mockClient)).toEqual([]);
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("runs when the production connection reaches another database", async () => {
    savedAlsoAs(twinRow({ database_name: "billing" }));
    expect((await revert({ ...BASE, versions: ["3.0.0"] })).status).toBe(200);
  });

  it("refuses with 503 when the lookup fails", async () => {
    savedAlsoAs(new Error("metadata database went away"));
    const res = await revert({ ...BASE, versions: ["3.0.0"] });
    expect(res.status).toBe(503);
    expect(queryTexts(mockClient)).toEqual([]);
  });
});

describe("the settings each down script runs under", () => {
  it("puts them back before every down script, so one script's SET cannot reach the next", async () => {
    // A plain SET search_path inside a transaction replaces the route's
    // SET LOCAL for everything after it (checked on PostgreSQL 18), so v2's
    // down script would have run in whatever schema v3's left behind.
    await revert({ ...BASE, versions: ["3.0.0", "2.0.0"] });
    const texts = queryTexts(mockClient);
    const between = texts.slice(texts.indexOf("DROP TABLE t3;"), texts.indexOf("DROP TABLE t2;"));
    expect(between).toEqual(
      expect.arrayContaining([
        "RESET ROLE",
        "SET LOCAL lock_timeout = 15000",
        'SET LOCAL search_path TO "sales"',
        "SET LOCAL check_function_bodies = off",
      ])
    );
    // A rollback has no time limit on a statement, like a real deploy.
    expect(texts.filter((text) => /statement_timeout/.test(text))).toEqual([]);
  });

  it("adds a schema that holds only extensions after the target schema", async () => {
    mockClient = createFakeClient(
      ledger({ first: [{ match: /extnamespace/, rows: [{ nspname: "extensions" }] }] })
    );
    await revert({ ...BASE, versions: ["3.0.0"] });
    expect(ran(mockClient, 'SET LOCAL search_path TO "sales", "extensions"')).toBe(true);
  });
});

describe("dryRun has to be true or false", () => {
  it("refuses any other value instead of running for real", async () => {
    for (const dryRun of ["true", 1, "yes", null]) {
      const res = await revert({ ...BASE, versions: ["3.0.0"], dryRun });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("dryRun must be true or false. Nothing was run.");
    }
    expect(mockPoolQuery).not.toHaveBeenCalled();
    expect(mockClient.queries).toEqual([]);
  });
});

describe("a statement that cannot run in a transaction", () => {
  it("says so in plain words, and rolls back", async () => {
    mockClient = createFakeClient(
      ledger({
        first: [
          {
            match: /^DROP TABLE t3;$/,
            error: {
              code: "25001",
              message: "DROP INDEX CONCURRENTLY cannot run inside a transaction block",
            },
          },
        ],
      })
    );
    const res = await revert({ ...BASE, versions: ["3.0.0"] });
    expect(res.status).toBe(500);
    const error = String(res.body.error);
    expect(error).toContain("The down script for v3.0.0 has a statement that PostgreSQL will not run inside a transaction");
    expect(error).toContain("Take the word CONCURRENTLY out of the down script");
    expect(error).toContain("PostgreSQL said: DROP INDEX CONCURRENTLY cannot run inside a transaction block");
    expect(count(mockClient, "ROLLBACK")).toBe(1);
    expect(count(mockClient, "COMMIT")).toBe(0);
  });
});

describe("the audit trail", () => {
  // What the route hands to recordDeployAttempt: [context, status, body].
  const recorded = () => mockRecordAttempt.mock.calls[0] as [Record<string, unknown>, number, Record<string, unknown>];

  it("records a rollback that worked, as a rollback", async () => {
    await revert({ ...BASE, versions: ["3.0.0", "2.0.0"] });
    expect(mockRecordAttempt).toHaveBeenCalledTimes(1);
    const [context, status, body] = recorded();
    expect(context).toEqual({
      action: "revert",
      orgId: TEST_ORG.id,
      actor: "a@test",
      connectionId: 7,
      schemaName: "sales",
      dryRun: false,
      scripts: [
        { script_name: "orders_fix", version: "3.0.0" },
        { script_name: "orders_fix", version: "2.0.0" },
      ],
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it("records one that was refused, which used to leave no trace at all", async () => {
    const res = await revert({ ...BASE, versions: ["9.9.9"] });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const [context, status, body] = recorded();
    expect(context).toMatchObject({ action: "revert", connectionId: 7, schemaName: "sales" });
    expect(status).toBe(res.status);
    expect(body.error).toBe(res.body.error);
  });

  it("records one that failed and was rolled back", async () => {
    mockClient = createFakeClient(
      ledger({ first: [{ match: /^DROP TABLE t3;$/, error: { message: 'table "t3" does not exist' } }] })
    );
    await revert({ ...BASE, versions: ["3.0.0"] });
    const [context, status, body] = recorded();
    expect(context).toMatchObject({ action: "revert", scripts: [{ script_name: "orders_fix", version: "3.0.0" }] });
    expect(status).toBe(500);
    expect(String(body.error)).toContain("The rollback of v3.0.0 failed");
  });

  it("records an unknown outcome as unknown", async () => {
    mockClient = createFakeClient(
      ledger({ first: [{ match: /^COMMIT$/, error: { message: "Connection terminated unexpectedly" } }] })
    );
    await revert({ ...BASE, versions: ["3.0.0"] });
    const [, status, body] = recorded();
    expect(status).toBe(500);
    expect(body.outcomeUnknown).toBe(true);
  });

  it("marks a 503 given before the target was touched, so it is not read as a failed run", async () => {
    // The twin check (approvals on, a dev connection) cannot reach the metadata DB.
    mockBuildPgConfig.mockImplementation((input) => {
      const { host, port, database } = input as Record<string, unknown>;
      return { host, port, database };
    });
    mockPoolQuery.mockImplementation(async (...args: unknown[]) => {
      if (/environment = 'prod'/.test(String(args[0]))) throw new Error("metadata database went away");
      return { rows: [connectionRow("dev")] };
    });
    const res = await revert({ ...BASE, versions: ["3.0.0"] });
    mockBuildPgConfig.mockImplementation(() => ({}));
    expect(res.status).toBe(503);
    expect(res.body.nothingRan).toBe(true);
    expect(recorded()[2].nothingRan).toBe(true);
  });
});
