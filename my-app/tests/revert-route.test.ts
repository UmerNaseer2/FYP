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
import { UNREADABLE_CREDENTIALS_MESSAGE } from "@/lib/secret-store";

// Relative paths on purpose: next/jest rewrites the @/ alias inside import
// statements only, so jest.mock("@/...") would not resolve.
// The caller. A test sets mockBypass to play the auth bypass's one principal.
let mockBypass = false;
jest.mock("../lib/auth-guard", () => ({
  requireEditor: async () => ({ ok: true, principal: { email: "a@test", bypass: mockBypass } }),
}));
afterEach(() => {
  mockBypass = false;
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
// Untracked by default — the connection row's own label then decides. One test
// makes this throw to play a metadata database that has gone away.
const mockFindTracked = jest.fn<Promise<unknown>, unknown[]>(async () => null);
jest.mock("../lib/lineage-db", () => ({
  findTrackedSchema: (...args: unknown[]) => mockFindTracked(...args),
  recordAppliedMigrationToLineage: (...args: unknown[]) => mockRecordLineage(...args),
}));

const mockClaim = jest.fn<Promise<unknown>, unknown[]>(async () => null);
const mockRelease = jest.fn<Promise<void>, unknown[]>(async () => undefined);
jest.mock("../lib/approvals-db", () => ({
  claimApproval: (...args: unknown[]) => mockClaim(...args),
  releaseApproval: (...args: unknown[]) => mockRelease(...args),
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
};

// orders_fix has three versions applied, each with its own rollback.
const V1: LedgerRow = {
  id: 1, version: "1.0.0", title: "Add orders", change_type: "additive",
  applied_at: "2026-01-01T00:00:00.000Z", down_sql: "DROP TABLE t1;",
};
const V2: LedgerRow = {
  id: 2, version: "2.0.0", title: "Drop legacy", change_type: "breaking",
  applied_at: "2026-02-01T00:00:00.000Z", down_sql: "DROP TABLE t2;",
};
const V3: LedgerRow = {
  id: 3, version: "3.0.0", title: "Rename a column", change_type: "patch",
  applied_at: "2026-03-01T00:00:00.000Z", down_sql: "DROP TABLE t3;",
};

// Every rollback above is a DROP TABLE, which deletes rows, so the route asks
// for the data-loss tick. BASE carries it, so each test reaches the check it
// is about; the "rows the rollback deletes" tests leave it out on purpose.
const UNTICKED = { connectionId: 7, schemaName: "sales", script_name: "orders_fix" };
const BASE = { ...UNTICKED, acknowledgeDataLoss: true };

function connectionRow(environment: string) {
  return {
    host: "db.test", port: 5432, database_name: "sales", username: "app",
    password: "not-a-real-password", connection_string: null, ssl: false,
    ssl_mode: "disable", environment, name: "Sales dev",
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
    { match: /FROM pg_namespace/, rows: [{ exists: 1 }] },
    { match: /to_regclass/, rows: [{ reg: "script_patch" }] },
    { match: /column_name = 'down_sql'/, rows: [{ column_name: "down_sql" }] },
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
  mockRecordLineage.mockReset();
  mockRecordLineage.mockResolvedValue({ advanced: false });
  mockFindTracked.mockReset();
  mockFindTracked.mockResolvedValue(null);
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

  it("stops at 503 when the schema's tracking record cannot be read", async () => {
    // The environment label is the only thing standing between "Roll back" and
    // a production database losing rows, and a schema can carry a louder label
    // than its connection does. This lookup failing used to be logged and
    // ignored, which left the schema looking unlabelled — the one state that
    // needs no acknowledgement at all. Apply answers 503 here; so does revert.
    mockFindTracked.mockRejectedValue(new Error("metadata database is unreachable"));
    const res = await revert({ ...BASE, versions: ["3.0.0"] });
    expect(res.status).toBe(503);
    expect(String(res.body.error)).toContain("Nothing was run");
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

  it("asks for an approval, not a second person, under the auth bypass", async () => {
    // With the bypass on there is one principal, and it clears its own
    // request, so the refusal must not send it looking for someone else.
    mockBypass = true;
    mockPoolQuery.mockResolvedValue({ rows: [connectionRow("prod")] });
    const res = await revert({ ...BASE, versions: ["3.0.0"], acknowledgeProduction: true });
    expect(res.status).toBe(403);
    expect(res.body.needsApproval).toBe(true);
    expect(res.body.error).toBe(
      "Rolling back on production needs an approval. Request it in the Approvals " +
        "panel and approve it there yourself (the auth bypass is on), then press " +
        "Roll back again."
    );
    expect(ran(mockClient, "DROP TABLE t3;")).toBe(false);
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
  it("runs the rollback, reports its NOTICEs, then rolls back without claiming", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [connectionRow("prod")] });
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
    expect(mockClaim).not.toHaveBeenCalled();
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
      expect(audit[0].values?.[5]).toBe("DROP TABLE registry_t3;");
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
    expect(audit.map((q) => q.values)).toEqual([
      ["orders_fix", "3.0.0", "Rename a column", "patch", V3.applied_at, "DROP TABLE t3;"],
      ["orders_fix", "2.0.0", "Drop legacy", "breaking", V2.applied_at, "DROP TABLE t2;"],
    ]);
    expect(queriesMatching(mockClient, /DELETE FROM/).map((q) => q.values)).toEqual([[3], [2]]);
    expect(count(mockClient, "COMMIT")).toBe(1);
    expect(count(mockClient, "ROLLBACK")).toBe(0);

    expect(mockRecordLineage).toHaveBeenCalledTimes(1);
    expect(mockRecordLineage.mock.calls[0][0]).toMatchObject({
      connectionId: 7,
      schemaName: "sales",
      changeLevel: "breaking",
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

  it("refuses a real run until they are acknowledged, and asks from the oldest version undone", async () => {
    mockClient = createFakeClient(ledger({ others }));
    const res = await revert({ ...BASE, versions: ["3.0.0", "2.0.0"] });
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
  it("refuses until they are ticked, dry run included, before any rollback SQL runs", async () => {
    for (const dryRun of [false, true]) {
      mockClient = createFakeClient(ledger());
      const res = await revert({ ...UNTICKED, versions: ["3.0.0"], dryRun });
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
    mockClient = createFakeClient(
      ledger({ rows: [V1, V2, { ...V3, down_sql: "CREATE TABLE t3_restored (id int);" }] })
    );
    const res = await revert({ ...UNTICKED, versions: ["2.0.0", "3.0.0"] });
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
    expect(mockRelease).toHaveBeenCalledWith(42);
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
    expect(mockRelease).toHaveBeenCalledWith(42);
    expect(mockRecordLineage).not.toHaveBeenCalled();
    // A refusal leaves a perfectly good connection: it goes back to the pool.
    expect(mockClient.releasedWith).toBeUndefined();
    expect(mockClient.listenersAtRelease).toBe(0);
  });
});
