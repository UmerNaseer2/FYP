// The Performance routes, against a stand-in database.
//
// What is checked here is the part the pure functions cannot show: which
// statements reach the server, in what order, and what happens to the
// connection afterwards. The saved connection comes from a mocked metadata
// pool, and the target database is a fake client that answers from a script
// (tests/helpers/fake-pg). Nothing reaches a real database or GitHub.
import { NextRequest } from "next/server";
import { guardGitHub, type GitHubGuard } from "./helpers/no-github";
import { createFakeClient, queriesMatching, queryTexts, type FakeClient, type FakeStep } from "./helpers/fake-pg";

// Relative paths on purpose: next/jest rewrites the @/ alias inside import
// statements only, so jest.mock("@/...") would not resolve.
jest.mock("../lib/auth-guard", () => ({
  requireViewer: async () => ({ ok: true, principal: null }),
  requireEditor: async () => ({ ok: true, principal: null }),
}));

// The metadata database, which only holds the saved connection here.
const mockPoolQuery = jest.fn<Promise<unknown>, unknown[]>(async () => ({ rows: [] }));
jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: { query: (...args: unknown[]) => mockPoolQuery(...args) },
  syncMetadataTables: async () => undefined,
}));

// The target database. Each test puts its own fake client behind connect().
const mockConnect = jest.fn<Promise<unknown>, []>();
const mockGetPoolForConfig = jest.fn<unknown, unknown[]>(() => ({ connect: () => mockConnect() }));
const mockFetchSchemaSnapshot = jest.fn<Promise<unknown>, unknown[]>();
jest.mock("../lib/postgres", () => ({
  ...jest.requireActual("../lib/postgres"),
  fetchSchemaSnapshot: (...args: unknown[]) => mockFetchSchemaSnapshot(...args),
  getPoolForConfig: (...args: unknown[]) => mockGetPoolForConfig(...args),
}));

// No password to decrypt: the config is only handed to getPoolForConfig above.
jest.mock("../lib/connection-config", () => ({
  buildPgConfig: (input: { host?: string | null }) => ({ host: input.host }),
}));

/** One saved connection, with every column the routes select. */
const ROW = {
  name: "Shop dev",
  host: "db.test",
  port: 5432,
  database_name: "shop",
  type: "PostgreSQL",
  username: "app",
  password: "not-a-real-password",
  connection_string: null,
  ssl: false,
  ssl_mode: "disable",
};

let guard: GitHubGuard;
let consoleSpy: jest.SpyInstance;

beforeEach(() => {
  guard = guardGitHub();
  mockPoolQuery.mockReset();
  mockPoolQuery.mockResolvedValue({ rows: [ROW] });
  mockConnect.mockReset();
  mockGetPoolForConfig.mockClear();
  mockFetchSchemaSnapshot.mockReset();
  // The failure cases log what went wrong; that is expected, not noise to show.
  consoleSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  consoleSpy.mockRestore();
  guard.restore();
  expect(guard.unexpected).toEqual([]);
});

/** Put a fake client answering from `steps` behind the target pool. */
function target(steps: FakeStep[]): FakeClient {
  const client = createFakeClient(steps);
  mockConnect.mockResolvedValue(client);
  return client;
}

describe("POST /api/performance/analyze", () => {
  /** One read of shop.orders, the way EXPLAIN (FORMAT JSON) returns it. */
  const SCAN = {
    "Node Type": "Seq Scan",
    "Relation Name": "orders",
    Schema: "shop",
    Alias: "orders",
    "Plan Rows": 10,
    "Total Cost": 5,
    Output: ["orders.id"],
  };
  const ESTIMATE = [{ Plan: SCAN }];
  const MEASURED = [
    {
      Plan: { ...SCAN, "Actual Rows": 10, "Actual Loops": 1, "Actual Total Time": 0.1 },
      "Planning Time": 0.1,
      "Execution Time": 0.2,
    },
  ];

  /** The two EXPLAINs answered with the plans above; everything else with no rows. */
  const PLANS: FakeStep[] = [
    { match: /^EXPLAIN \(ANALYZE/, rows: [{ "QUERY PLAN": MEASURED }] },
    { match: /^EXPLAIN/, rows: [{ "QUERY PLAN": ESTIMATE }] },
  ];

  async function analyze(sql: string, measure: boolean): Promise<Response> {
    const { POST } = await import("../app/api/performance/analyze/route");
    return POST(
      new NextRequest("http://localhost/api/performance/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId: 7, schema: "shop", sql, measure }),
      })
    );
  }

  it("plans without running, and hands the connection back to the pool", async () => {
    const client = target(PLANS);
    const res = await analyze("SELECT id FROM orders", false);

    expect(res.status).toBe(200);
    expect((await res.json()).mode).toBe("estimate");
    expect(queriesMatching(client, /^EXPLAIN \(ANALYZE/)).toEqual([]);
    const texts = queryTexts(client);
    expect(texts[0]).toBe("BEGIN READ ONLY");
    expect(texts[texts.length - 1]).toBe("ROLLBACK");
    // Nothing ran, so the session is as clean as it was: reuse it.
    expect(client.releaseCount).toBe(1);
    expect(client.releasedWith).toBe(false);
  });

  it("closes a measured query's connection instead of handing it to the next request", async () => {
    const client = target(PLANS);
    const res = await analyze("SELECT id FROM orders", true);

    expect(res.status).toBe(200);
    expect((await res.json()).mode).toBe("measured");
    expect(queriesMatching(client, /^EXPLAIN \(ANALYZE/)).toHaveLength(1);
    expect(queryTexts(client).at(-1)).toBe("ROLLBACK");
    // The query really ran. A function it called can leave something on the
    // session (a session advisory lock, a setting) that ROLLBACK does not undo.
    expect(client.releaseCount).toBe(1);
    expect(client.releasedWith).toBe(true);
  });

  it("closes the connection too when the measured run fails partway", async () => {
    const client = target([
      {
        match: /^EXPLAIN \(ANALYZE/,
        error: { code: "57014", message: "canceling statement due to statement timeout" },
      },
      ...PLANS,
    ]);
    const res = await analyze("SELECT id FROM orders", true);

    expect(res.status).toBe(400);
    expect((await res.json()).ok).toBe(false);
    expect(queryTexts(client).at(-1)).toBe("ROLLBACK");
    expect(client.releasedWith).toBe(true);
  });

  it("closes the connection when the ROLLBACK itself fails", async () => {
    const client = target([{ match: /^ROLLBACK/, error: { message: "Connection terminated" } }, ...PLANS]);
    const res = await analyze("SELECT id FROM orders", false);

    // The plan was read before the ROLLBACK, so the answer still arrives.
    expect(res.status).toBe(200);
    // Whether the session left its transaction is unknown, so it is not reused.
    expect(client.releasedWith).toBe(true);
  });

  it("refuses a quoted call to a server function before dialling anything, when measuring", async () => {
    target(PLANS);
    const sql = 'SELECT * FROM (VALUES ("pg_try_advisory_lock"(42))) AS v(locked)';
    const res = await analyze(sql, true);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain("pg_try_advisory_lock");
    // Decided from the text alone: no saved connection read, no server asked.
    expect(mockPoolQuery).not.toHaveBeenCalled();
    expect(mockGetPoolForConfig).not.toHaveBeenCalled();
  });

  it("still plans that query when not measuring, since a plan runs nothing", async () => {
    const client = target(PLANS);
    const sql = 'SELECT * FROM (VALUES ("pg_try_advisory_lock"(42))) AS v(locked)';
    const res = await analyze(sql, false);

    expect(res.status).toBe(200);
    expect(queriesMatching(client, /^EXPLAIN \(ANALYZE/)).toEqual([]);
    expect(client.releasedWith).toBe(false);
  });
});
