// GET /api/versionsync/ledger: the ledger Version Sync lists and replays from.
//
// The order the rows come back in is the order Version Sync replays them in,
// so it has to be the order they really ran. One deploy writes all its rows
// in one transaction, so they share one applied_at; only the row id (a serial)
// says which came first. Ordering by version instead put orders 1.1.0 before
// users 2.0.0 when the Source ran users first.
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

type RouteModule = typeof import("../app/api/versionsync/ledger/route");
let GET: RouteModule["GET"];

const CONNECTION = {
  host: "db.test", port: 5432, database_name: "sales", username: "app",
  password: "not-a-real-password", connection_string: null, ssl: false,
  ssl_mode: "disable", name: "Sales dev",
};

/** A target with a script_patch table that has these optional columns. */
function target(columns: string[], rows: Record<string, unknown>[] = []): FakeStep[] {
  return [
    { match: /information_schema\.tables/, rows: [{ exists: true }] },
    { match: /information_schema\.columns/, rows: columns.map((column_name) => ({ column_name })) },
    { match: /FROM "sales"\.script_patch/, rows },
  ];
}

/** The ledger SELECT the route sent, with whitespace squeezed. */
function ledgerQuery(client: FakeClient): string {
  return queriesMatching(client, /FROM "sales"\.script_patch/)[0].text.replace(/\s+/g, " ");
}

async function readLedger(): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await GET(new NextRequest("http://localhost/api/versionsync/ledger?connectionId=7&schema=sales"));
  const text = await res.text();
  expect(text).not.toContain(FAKE_TOKEN);
  expect(text).not.toContain("not-a-real-password");
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown> };
}

let guard: GitHubGuard;

beforeAll(async () => {
  ({ GET } = await import("../app/api/versionsync/ledger/route"));
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

it("orders rows the way they were written: applied_at, then id", async () => {
  const sameRun = new Date("2026-03-01T10:00:00.000Z");
  mockClient = createFakeClient(
    target(
      ["id", "sql_content", "down_sql"],
      [
        { script_name: "users", version: "2.0.0", change_type: "additive", applied_at: sameRun, sql_content: "SELECT 2;", down_sql: null },
        { script_name: "orders", version: "1.1.0", change_type: "patch", applied_at: sameRun, sql_content: "SELECT 1;", down_sql: null },
      ]
    )
  );
  const res = await readLedger();
  expect(res.status).toBe(200);
  // The fake answers the column lookup with whatever the test lists, so check
  // that the route really asks whether an id column is there. Without it the
  // real catalog never says so, and the ledger falls back to version order.
  expect(queriesMatching(mockClient, /information_schema\.columns/)[0].text).toContain("'id'");
  expect(ledgerQuery(mockClient)).toContain("ORDER BY applied_at ASC, id ASC");
  // The route keeps the database's order: users ran first, so it is listed first.
  const entries = res.body.entries as { scriptName: string; version: string }[];
  expect(entries.map((e) => `${e.scriptName} ${e.version}`)).toEqual(["users 2.0.0", "orders 1.1.0"]);
  // The id is only used to order the rows; it is not read into the answer.
  expect(ledgerQuery(mockClient)).toMatch(
    /^SELECT script_name, version, change_type, applied_at, sql_content, down_sql, NULL::text AS title, NULL::text AS description /
  );
});

it("sends each row's title and description, so a replay can keep them", async () => {
  const at = new Date("2026-03-01T10:00:00.000Z");
  mockClient = createFakeClient(
    target(
      ["id", "sql_content", "down_sql", "title", "description"],
      [
        { script_name: "app_core", version: "2.0.0", change_type: "breaking", applied_at: at, sql_content: "SELECT 2;", down_sql: null, title: "Drop legacy code", description: "  Removes customers.legacy_code  " },
        // Blank reads as none, the same as the apply route writes it.
        { script_name: "app_core", version: "2.0.1", change_type: "patch", applied_at: at, sql_content: "SELECT 3;", down_sql: null, title: "   ", description: "" },
      ]
    )
  );
  const res = await readLedger();
  expect(res.status).toBe(200);
  // The route has to ask for both columns: the fake answers with whatever the
  // test lists, but the real catalog only reports the columns it was asked about.
  const columnLookup = queriesMatching(mockClient, /information_schema\.columns/)[0].text;
  expect(columnLookup).toContain("'title'");
  expect(columnLookup).toContain("'description'");
  expect(ledgerQuery(mockClient)).toContain("down_sql, title, description FROM");
  const entries = res.body.entries as { title: unknown; description: unknown }[];
  expect(entries.map((e) => [e.title, e.description])).toEqual([
    ["Drop legacy code", "Removes customers.legacy_code"],
    [null, null],
  ]);
});

it("sends each row's level as its pill reads it, so an old ledger's words still count", async () => {
  // Another tool's ledger may say "major" or "Minor". The apply route only
  // counts "breaking", "additive" and "patch", so a replay that passed "major"
  // through would be recorded at whatever the SQL reads as.
  const at = new Date("2026-03-01T10:00:00.000Z");
  mockClient = createFakeClient(
    target(
      ["id", "sql_content"],
      [
        { script_name: "app_core", version: "2.0.0", change_type: "major", applied_at: at, sql_content: "SELECT 2;" },
        { script_name: "app_core", version: "2.1.0", change_type: "Minor", applied_at: at, sql_content: "SELECT 3;" },
        { script_name: "app_core", version: "2.1.1", change_type: "patch", applied_at: at, sql_content: "SELECT 4;" },
        { script_name: "app_core", version: "2.1.2", change_type: "whatever", applied_at: at, sql_content: "SELECT 5;" },
      ]
    )
  );
  const res = await readLedger();
  expect(res.status).toBe(200);
  const entries = res.body.entries as { changeType: unknown }[];
  expect(entries.map((e) => e.changeType)).toEqual(["breaking", "additive", "patch", "unknown"]);
});

it("falls back to version order when the table has no id column", async () => {
  // A script_patch made by another tool. Selecting ORDER BY id there would
  // fail the whole read.
  mockClient = createFakeClient(target(["sql_content"]));
  const res = await readLedger();
  expect(res.status).toBe(200);
  const query = ledgerQuery(mockClient);
  expect(query).toContain("ORDER BY applied_at ASC, version ASC");
  expect(query).not.toMatch(/\bid ASC\b/);
  expect(query).toContain("NULL::text AS down_sql");
  // Another tool's table may have no title or description either.
  expect(query).toContain("NULL::text AS title");
  expect(query).toContain("NULL::text AS description");
});

it("says the saved credentials can't be read when this server can't decrypt them", async () => {
  mockBuildPgConfig.mockImplementation(() => {
    throw new Error("Unsupported state or unable to authenticate data");
  });
  mockClient = createFakeClient(target(["id"]));
  const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  const res = await readLedger();
  errorSpy.mockRestore();
  // A JSON answer with a reason, not a bare 500 the page can only call unreachable.
  expect(res.status).toBe(500);
  expect(res.body.error).toBe(
    "This connection's stored credentials can't be read on this server. Set " +
      "APP_ENCRYPTION_KEY to the key they were saved with, or edit the connection on " +
      "the Connections screen and enter its password again."
  );
  expect(mockClient.queries).toEqual([]);
});
