// POST /api/scripts/preflight: what Deploy reads before offering a deploy or
// a rollback. These tests cover the rollback half: which versions really have
// a rollback, the rollback history, and later scripts from other families.
//
// The target database is the fake client from helpers/fake-pg. Nothing here
// reaches a real database or GitHub.
import { NextRequest } from "next/server";
import { createFakeClient, queriesMatching, type FakeClient, type FakeStep } from "./helpers/fake-pg";
import { FAKE_TOKEN, guardGitHub, type GitHubGuard } from "./helpers/no-github";

// Relative paths on purpose: next/jest rewrites the @/ alias inside import
// statements only, so jest.mock("@/...") would not resolve.
jest.mock("../lib/auth-guard", () => ({
  requireViewer: async () => ({ ok: true, principal: null }),
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
// Set to throw to play a saved secret this server can't decrypt.
const mockBuildPgConfig = jest.fn<unknown, unknown[]>(() => ({}));
jest.mock("../lib/connection-config", () => ({
  buildPgConfig: (...args: unknown[]) => mockBuildPgConfig(...args),
}));

type RouteModule = typeof import("../app/api/scripts/preflight/route");
let POST: RouteModule["POST"];

const CONNECTION = {
  host: "db.test", port: 5432, database_name: "sales", username: "app",
  password: "not-a-real-password", connection_string: null, ssl: false,
  ssl_mode: "disable", name: "Sales dev",
};

const REVERTED = [
  {
    script_name: "orders_fix", version: "3.0.0", title: "Rename a column", change_type: "patch",
    applied_at: "2026-03-01T00:00:00.000Z", reverted_at: "2026-04-01T00:00:00.000Z",
  },
];

function timelineRow(version: string, down_sql: string | null, sql_content: string | null = `SELECT ${version.length};`) {
  return {
    version, title: `v${version}`, description: null, change_type: "additive",
    applied_at: "2026-01-01T00:00:00.000Z", down_sql, sql_content,
    applied_by: "deployer@test",
  };
}

/**
 * The same row as it would have been written before the applied_by column
 * existed — the key is absent, not null.
 *
 * Deletes the key rather than destructuring it away: `({ applied_by, ...rest })`
 * reads well but leaves a binding nothing ever uses, and lint is right to call
 * that a mistake when it cannot tell this one from a genuine oversight.
 */
function rowBeforeAppliedBy(version: string, down_sql: string | null): Record<string, unknown> {
  const row: Record<string, unknown> = { ...timelineRow(version, down_sql) };
  delete row.applied_by;
  return row;
}

/** A target whose answers the test chooses. */
function target(options: {
  ledger?: boolean;
  revertedTable?: boolean;
  timeline?: Record<string, unknown>[];
  others?: Record<string, unknown>[];
  /** The optional script_patch columns the catalog reports (all by default). */
  columns?: string[];
}): FakeStep[] {
  const columns = options.columns ?? ["down_sql", "sql_content", "applied_by"];
  return [
    // Both existence probes are to_regclass now, so they are told apart by the
    // name they ask about rather than by the query text.
    {
      match: /to_regclass/,
      when: (values) => String(values[0]).endsWith(".script_patch"),
      rows: [{ reg: options.ledger !== false ? '"sales".script_patch' : null }],
    },
    {
      match: /to_regclass/,
      when: (values) => String(values[0]).endsWith(".script_patch_reverted"),
      rows: [{ reg: options.revertedTable ? '"sales".script_patch_reverted' : null }],
    },
    { match: /FROM "sales"\.script_patch_reverted/, rows: options.revertedTable ? REVERTED : [] },
    {
      match: /column_name IN \('down_sql', 'sql_content', 'applied_by'\)/,
      rows: columns.map((column_name) => ({ column_name })),
    },
    { match: /script_name <> \$1/, rows: options.others ?? [] },
    { match: /SELECT\s+version,\s+title,\s+description/, rows: options.timeline ?? [] },
  ];
}

/** The timeline SELECT the route sent, with whitespace squeezed. */
function timelineQuery(client: FakeClient): string {
  const query = queriesMatching(client, /SELECT\s+version,\s+title,\s+description/)[0];
  return query.text.replace(/\s+/g, " ");
}

async function preflight(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await POST(
    new NextRequest("http://localhost/api/scripts/preflight", {
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

const FAMILY = { connectionId: 7, schemaName: "sales", scriptName: "orders_fix" };

let guard: GitHubGuard;

beforeAll(async () => {
  ({ POST } = await import("../app/api/scripts/preflight/route"));
});

beforeEach(() => {
  guard = guardGitHub();
  mockPoolQuery.mockReset();
  mockPoolQuery.mockResolvedValue({ rows: [CONNECTION] });
  mockBuildPgConfig.mockReset();
  mockBuildPgConfig.mockReturnValue({});
});

afterEach(() => {
  guard.restore();
  expect(guard.unexpected).toEqual([]);
});

it("says the saved credentials can't be read when this server can't decrypt them", async () => {
  mockBuildPgConfig.mockImplementation(() => {
    throw new Error("Unsupported state or unable to authenticate data");
  });
  mockClient = createFakeClient(target({}));
  const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  const res = await preflight(FAMILY);
  errorSpy.mockRestore();
  // A JSON answer with a reason, not a bare 500 Deploy can only call a network error.
  expect(res.status).toBe(500);
  expect(res.body.error).toBe(
    "This connection's stored credentials can't be read on this server. Set " +
      "APP_ENCRYPTION_KEY to the key they were saved with, or edit the connection on " +
      "the Connections screen and enter its password again."
  );
  expect(mockClient.queries).toEqual([]);
});

it("counts only a rollback with a statement that runs", async () => {
  mockClient = createFakeClient(
    target({
      timeline: [
        timelineRow("3.0.0", "-- nothing to undo\n"),
        timelineRow("2.0.0", "DROP TABLE t2;"),
        timelineRow("1.0.0", null),
      ],
    })
  );
  const res = await preflight(FAMILY);
  expect(res.status).toBe(200);
  const timeline = res.body.timeline as { version: string; has_down_sql: boolean; down_sql: string | null }[];
  expect(timeline.map((entry) => [entry.version, entry.has_down_sql])).toEqual([
    ["3.0.0", false],
    ["2.0.0", true],
    ["1.0.0", false],
  ]);
  // The text still travels, so the operator can read what would run.
  expect(timeline[1].down_sql).toBe("DROP TABLE t2;");
});

it("does not let a non-version applied name become the current version", async () => {
  // "release-9" is not a version, but versionParts would read it as 9.0.0 —
  // above every real version here. The floor must ignore it (highestVersion),
  // so the current version is the highest real one, 2.0.0, not "release-9".
  mockClient = createFakeClient(
    target({
      timeline: [
        timelineRow("release-9", null),
        timelineRow("2.0.0", null),
        timelineRow("1.0.0", null),
      ],
    })
  );
  const res = await preflight(FAMILY);
  expect(res.status).toBe(200);
  expect(res.body.currentVersion).toBe("2.0.0");
  expect(res.body.message).toContain("is at version 2.0.0");
  expect(res.body.message).not.toContain("release-9");
  // The count reports real versions only (2.0.0 + 1.0.0), not the 3 timeline
  // rows — the non-version "release-9" is excluded from the version count too.
  expect(res.body.message).toContain("2 version(s) in history");
  // The non-version row is still in the returned history, just not the floor.
  const timeline = res.body.timeline as { version: string }[];
  expect(timeline.map((entry) => entry.version)).toContain("release-9");
});

it("returns an empty history when the schema never had a rollback", async () => {
  mockClient = createFakeClient(target({ timeline: [timelineRow("1.0.0", "DROP TABLE t1;")] }));
  const res = await preflight(FAMILY);
  expect(res.body.reverted).toEqual([]);
  expect(queriesMatching(mockClient, /FROM "sales"\.script_patch_reverted/)).toHaveLength(0);
});

it("returns the family's history, newest first, even when nothing is applied now", async () => {
  mockClient = createFakeClient(target({ revertedTable: true, timeline: [] }));
  const res = await preflight(FAMILY);
  expect(res.status).toBe(200);
  expect(res.body.timeline).toEqual([]);
  expect(res.body.reverted).toEqual(REVERTED);
  expect(res.body.otherScripts).toEqual([]);

  const history = queriesMatching(mockClient, /FROM "sales"\.script_patch_reverted/)[0];
  expect(history.values).toEqual(["orders_fix"]);
  expect(history.text).toMatch(/ORDER BY reverted_at DESC, id DESC\s+LIMIT 50/);
  expect(queriesMatching(mockClient, /script_name <> \$1/)).toHaveLength(0);
});

it("returns the history when the schema has no script_patch at all", async () => {
  mockClient = createFakeClient(target({ ledger: false, revertedTable: true }));
  const res = await preflight(FAMILY);
  expect(res.body).toMatchObject({ hasVersionTable: false, timeline: [], otherScripts: [] });
  expect(res.body.reverted).toEqual(REVERTED);
});

it("lists other families applied after this family's first version", async () => {
  const others = [{ script_name: "billing_fix", version: "1.1.0", applied_at: "2026-02-01T00:00:00.000Z" }];
  mockClient = createFakeClient(target({ timeline: [timelineRow("1.0.0", "DROP TABLE t1;")], others }));
  const res = await preflight(FAMILY);
  expect(res.body.otherScripts).toEqual(others);

  // The family itself and anything written before its first apply stay out.
  // Rows one deploy wrote share one applied_at, so the ledger id breaks ties.
  const query = queriesMatching(mockClient, /script_name <> \$1/)[0];
  expect(query.values).toEqual(["orders_fix"]);
  const sql = query.text.replace(/\s+/g, " ");
  expect(sql).toContain("WHERE script_name = $1 AND applied_at IS NOT NULL ORDER BY applied_at, id LIMIT 1");
  expect(sql).toContain("other.applied_at = oldest.applied_at AND other.id > oldest.id");
  expect(sql).toContain("ORDER BY other.applied_at, other.id LIMIT 200");
});

// D4: Deploy shows the SQL that actually ran for an applied version. For a
// version with no registry file (a Version Sync replay) the ledger copy is
// the only one there is.
it("returns the SQL each applied version ran", async () => {
  mockClient = createFakeClient(
    target({
      timeline: [
        timelineRow("2.0.0", null, "ALTER TABLE orders ADD COLUMN note text;"),
        timelineRow("1.0.0", null, null),
      ],
    })
  );
  const res = await preflight(FAMILY);
  expect(res.status).toBe(200);
  const timeline = res.body.timeline as { version: string; sql_content: string | null }[];
  expect(timeline.map((entry) => [entry.version, entry.sql_content])).toEqual([
    ["2.0.0", "ALTER TABLE orders ADD COLUMN note text;"],
    ["1.0.0", null],
  ]);

  // One catalog question covers both optional columns, and both are read.
  const check = queriesMatching(mockClient, /information_schema\.columns/)[0];
  expect(check.values).toEqual(["sales"]);
  expect(check.text).toContain("column_name IN ('down_sql', 'sql_content', 'applied_by')");
  expect(timelineQuery(mockClient)).toContain("applied_at, down_sql, sql_content, applied_by FROM \"sales\".script_patch WHERE script_name = $1");
});

it("says who applied each version, and null where the ledger does not know", async () => {
  mockClient = createFakeClient(
    target({
      timeline: [
        timelineRow("2.0.0", null),
        // A row from before applied_by existed, or written by another tool.
        { ...timelineRow("1.0.0", null), applied_by: null },
      ],
    })
  );
  const res = await preflight(FAMILY);
  expect(res.status).toBe(200);
  const timeline = res.body.timeline as { version: string; applied_by: string | null }[];
  expect(timeline.map((entry) => [entry.version, entry.applied_by])).toEqual([
    ["2.0.0", "deployer@test"],
    ["1.0.0", null],
  ]);
});

it("reads applied_by as null on a ledger written before the column existed", async () => {
  mockClient = createFakeClient(
    target({
      columns: ["down_sql", "sql_content"],
      // No applied_by key at all: a SELECT that names it as NULL::text gets
      // the column back empty, which is what a real old table would answer.
      timeline: [rowBeforeAppliedBy("1.0.0", "DROP TABLE t1;")],
    })
  );
  const res = await preflight(FAMILY);
  expect(res.status).toBe(200);
  // Named as a NULL rather than selected, so the whole timeline still reads.
  expect(timelineQuery(mockClient)).toContain("sql_content, NULL::text AS applied_by FROM");
  expect((res.body.timeline as Record<string, unknown>[])[0]).toHaveProperty("applied_by", null);
});

it("reads sql_content as null on a ledger written before the column existed", async () => {
  mockClient = createFakeClient(
    target({ columns: ["down_sql"], timeline: [timelineRow("1.0.0", "DROP TABLE t1;", null)] })
  );
  const res = await preflight(FAMILY);
  expect(res.status).toBe(200);
  // The SELECT names only columns that exist, so an old table still answers.
  const sql = timelineQuery(mockClient);
  expect(sql).toContain("down_sql, NULL::text AS sql_content, NULL::text AS applied_by FROM");
  const timeline = res.body.timeline as { sql_content: string | null; has_down_sql: boolean }[];
  expect(timeline[0]).toMatchObject({ sql_content: null, has_down_sql: true });
});

it("reads both optional columns as null when the table has neither", async () => {
  mockClient = createFakeClient(
    target({ columns: [], timeline: [timelineRow("1.0.0", null, null)] })
  );
  const res = await preflight(FAMILY);
  expect(res.status).toBe(200);
  expect(timelineQuery(mockClient)).toContain(
    "NULL::text AS down_sql, NULL::text AS sql_content, NULL::text AS applied_by FROM"
  );
  expect((res.body.timeline as Record<string, unknown>[])[0]).toMatchObject({
    down_sql: null, has_down_sql: false, sql_content: null,
  });
});

it("reads the whole schema's history and no other-family list without a scriptName", async () => {
  mockClient = createFakeClient(target({ revertedTable: true, timeline: [timelineRow("1.0.0", null)] }));
  const res = await preflight({ connectionId: 7, schemaName: "sales" });
  expect(res.body.otherScripts).toEqual([]);
  expect(queriesMatching(mockClient, /FROM "sales"\.script_patch_reverted/)[0].values).toEqual([null]);
  expect(queriesMatching(mockClient, /script_name <> \$1/)).toHaveLength(0);
  // The unscoped read carries the applied SQL too.
  expect(timelineQuery(mockClient)).toContain(
    "applied_at, down_sql, sql_content, applied_by FROM \"sales\".script_patch ORDER BY"
  );
  expect((res.body.timeline as Record<string, unknown>[])[0]).toHaveProperty("sql_content", "SELECT 5;");
});

// ─── Finding the ledger ────────────────────────────────────────────────────

it("asks the catalog for script_patch, not the privilege-filtered view", async () => {
  mockClient = createFakeClient(target({ ledger: true, revertedTable: false }));
  const res = await preflight(FAMILY);

  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ hasVersionTable: true, needsInit: false });
  // information_schema.tables lists only tables the current user has some
  // privilege on. A ledger owned by somebody else is missing from it, so
  // pre-flight used to offer to initialise a schema that apply already had a
  // ledger in — two screens disagreeing about one table.
  expect(queriesMatching(mockClient, /information_schema\.tables/)).toHaveLength(0);
  const probe = queriesMatching(mockClient, /to_regclass/).find(
    (query) => String(query.values?.[0]).endsWith(".script_patch")
  );
  expect(probe?.values).toEqual(['"sales".script_patch']);
});

it("still says the schema needs initialising when the name does not resolve", async () => {
  // The negative control: to_regclass answers null for a table that really is
  // not there, and that has to keep reading as "needs init".
  mockClient = createFakeClient(target({ ledger: false, revertedTable: false }));
  const res = await preflight(FAMILY);

  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ hasVersionTable: false, needsInit: true });
});

it("quotes a schema name with a double quote in it", async () => {
  // The probe binds the quoted name as text, so the quoting has to be right
  // here as much as in a query that interpolates it.
  mockClient = createFakeClient(target({ ledger: true, revertedTable: false }));
  await preflight({ ...FAMILY, schemaName: 'we"ird' });
  const probe = queriesMatching(mockClient, /to_regclass/).find(
    (query) => String(query.values?.[0]).endsWith(".script_patch")
  );
  expect(probe?.values).toEqual(['"we""ird".script_patch']);
});
