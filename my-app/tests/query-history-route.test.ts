// GET /api/performance/history — and mostly the baseline it compares against.
//
// Spec feature 10 asks to "compare historical performance with current
// performance". Until this was built, the route always compared the newest run
// with the one immediately before it. That answers "did the change I just make
// help?" and cannot answer the other question people bring to this screen: a
// query that has degraded over months does it a few percent at a time, and
// every consecutive pair of runs looks fine.
//
// So the run to compare against is now chosen by the caller. The cases worth
// pinning are the ones where a wrong answer would still look like a real one:
// a baseline that has aged out, a baseline belonging to a different query, and
// the newest run offered as its own baseline — each of which would produce a
// comparison the screen would present as the answer to the question asked.
//
// The reads are mocked. What is being tested is the choosing, not the SQL.
import { NextRequest } from "next/server";
import type { QueryHistoryRow } from "@/lib/query-history";

// Relative paths on purpose: next/jest rewrites the @/ alias inside import
// statements only, so jest.mock("@/...") would not resolve.
let mockGate: { ok: true; principal: null } | { ok: false; response: Response };
jest.mock("../lib/auth-guard", () => ({
  requireViewer: async () => mockGate,
}));

// The metadata pool, which this route uses only to read the connection's name.
const mockPoolQuery = jest.fn<Promise<unknown>, unknown[]>(async () => ({ rows: [] }));
jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: { query: (...args: unknown[]) => mockPoolQuery(...args) },
  syncMetadataTables: async () => undefined,
}));

const mockListRuns = jest.fn<Promise<QueryHistoryRow[]>, unknown[]>();
const mockListHistory = jest.fn<Promise<QueryHistoryRow[]>, unknown[]>();
const mockTrend = jest.fn<Promise<unknown[]>, unknown[]>();
jest.mock("../lib/query-history-db", () => ({
  HISTORY_PAGE_SIZE: 50,
  listRunsOfQuery: (...args: unknown[]) => mockListRuns(...args),
  listQueryHistory: (...args: unknown[]) => mockListHistory(...args),
  queryTrend: (...args: unknown[]) => mockTrend(...args),
}));

type RouteModule = typeof import("../app/api/performance/history/route");
let GET: RouteModule["GET"];

const FINGERPRINT = "a1b2c3d4";

/** One stored run. Only what a comparison reads is worth setting here. */
function run(id: number, extra: Partial<QueryHistoryRow> = {}): QueryHistoryRow {
  return {
    id,
    connection_id: 7,
    connection_name: "Shop dev",
    schema_name: "sales",
    query_text: "select * from orders",
    fingerprint: FINGERPRINT,
    exec_time_ms: 100,
    planning_ms: 1,
    rows_returned: 10,
    total_cost: 500,
    estimated_rows: 10,
    score: 80,
    band: "good",
    measured: true,
    high_count: 0,
    medium_count: 0,
    low_count: 0,
    captured_by: "tester@example.com",
    captured_at: `2026-09-${String(id).padStart(2, "0")}T10:00:00.000Z`,
    ...extra,
  };
}

async function read(query: string) {
  const res = await GET(new NextRequest(`http://localhost/api/performance/history${query}`));
  const text = await res.text();
  // Whatever the answer is, the saved password must not be in it.
  expect(text).not.toContain("not-a-real-password");
  return { status: res.status, body: JSON.parse(text) as Record<string, never> };
}

/** The body of a successful read, typed loosely enough to assert on. */
type Body = {
  comparison: { verdict: string; execTimeDeltaMs: number | null } | null;
  baselineId: number | null;
  baselineNote: string | null;
  rows: QueryHistoryRow[];
};

async function readView(query: string): Promise<Body> {
  const res = await read(query);
  expect(res.status).toBe(200);
  return res.body as unknown as Body;
}

beforeAll(async () => {
  ({ GET } = await import("../app/api/performance/history/route"));
});

beforeEach(() => {
  mockGate = { ok: true, principal: null };
  mockPoolQuery.mockReset();
  mockPoolQuery.mockResolvedValue({ rows: [{ name: "Shop dev" }] });
  mockListRuns.mockReset();
  mockListHistory.mockReset();
  mockListHistory.mockResolvedValue([]);
  mockTrend.mockReset();
  mockTrend.mockResolvedValue([]);
});

describe("which run it compares against", () => {
  it("uses the run before the newest when no baseline is asked for", async () => {
    // Newest first, the order both list functions return.
    mockListRuns.mockResolvedValue([run(9, { exec_time_ms: 300 }), run(8, { exec_time_ms: 100 }), run(1)]);

    const view = await readView(`?connectionId=7&schema=sales&fingerprint=${FINGERPRINT}`);
    expect(view.baselineId).toBe(8);
    expect(view.baselineNote).toBeNull();
    // 300 against 100, not against run 1 — proving it took the second row.
    expect(view.comparison?.execTimeDeltaMs).toBe(200);
  });

  it("compares against the run that was asked for, however old", async () => {
    // The whole point of the feature: run 1 is three runs back, and the slide
    // from 100 ms to 300 ms is only visible against it. Each consecutive pair
    // below is well inside the ratio that would be called a regression.
    mockListRuns.mockResolvedValue([
      run(9, { exec_time_ms: 300 }),
      run(8, { exec_time_ms: 260 }),
      run(7, { exec_time_ms: 210 }),
      run(1, { exec_time_ms: 100 }),
    ]);

    const drift = await readView(`?connectionId=7&schema=sales&fingerprint=${FINGERPRINT}&baseline=1`);
    expect(drift.baselineId).toBe(1);
    expect(drift.comparison?.execTimeDeltaMs).toBe(200);
    expect(drift.comparison?.verdict).toContain("Slower");

    // And the default, on the same data, says nothing is wrong — which is the
    // reason the choice had to exist. A test that only checked the first half
    // would pass with the baseline ignored entirely.
    const quiet = await readView(`?connectionId=7&schema=sales&fingerprint=${FINGERPRINT}`);
    expect(quiet.baselineId).toBe(8);
    expect(quiet.comparison?.verdict).not.toContain("Slower");
  });

  it("says so when the chosen baseline is no longer in the history", async () => {
    // Retention prunes rows out from under a screen that is still open. The
    // silent failure this prevents: falling back without a word, so the user
    // reads a comparison against the previous run as one against the run they
    // picked.
    mockListRuns.mockResolvedValue([run(9), run(8), run(7)]);

    const view = await readView(`?connectionId=7&schema=sales&fingerprint=${FINGERPRINT}&baseline=4`);
    expect(view.baselineId).toBe(8);
    expect(view.baselineNote).toContain("not in this query's history");
  });

  it("refuses to use the newest run as its own baseline", async () => {
    // Comparing a run with itself prints "About the same speed as before",
    // which reads as a finding and is not one.
    mockListRuns.mockResolvedValue([run(9, { exec_time_ms: 300 }), run(8, { exec_time_ms: 100 })]);

    const view = await readView(`?connectionId=7&schema=sales&fingerprint=${FINGERPRINT}&baseline=9`);
    expect(view.baselineId).toBe(8);
    expect(view.comparison?.execTimeDeltaMs).toBe(200);
    // And the note says what actually happened. The other note — "pruned, or
    // it belongs to another query" — would be false here: run 9 is right there
    // in the list, it is just the run being measured.
    expect(view.baselineNote).toContain("cannot be its own baseline");
  });

  it("refuses a baseline that is not a run id at all", async () => {
    // Ignoring it would answer a different question than the one asked, and
    // the screen would present that answer as the one it asked for.
    mockListRuns.mockResolvedValue([run(9), run(8)]);
    for (const value of ["abc", "-1", "0", "2.5"]) {
      const res = await read(`?connectionId=7&schema=sales&fingerprint=${FINGERPRINT}&baseline=${value}`);
      expect(res.status).toBe(400);
    }
    expect(mockListRuns).not.toHaveBeenCalled();
  });

  it("does not compare at all without a fingerprint", async () => {
    // The schema-wide list is forty different queries. The newest two rows are
    // almost never the same query, and setting one against the other would be
    // a number with no meaning at all.
    mockListHistory.mockResolvedValue([run(9), run(8)]);

    const view = await readView("?connectionId=7&schema=sales&baseline=8");
    expect(view.comparison).toBeNull();
    expect(view.baselineId).toBeNull();
    expect(view.baselineNote).toBeNull();
    expect(mockListRuns).not.toHaveBeenCalled();
  });

  it("does not compare a query that has only ever been run once", async () => {
    mockListRuns.mockResolvedValue([run(9)]);
    const view = await readView(`?connectionId=7&schema=sales&fingerprint=${FINGERPRINT}`);
    expect(view.comparison).toBeNull();
    expect(view.baselineId).toBeNull();
  });
});

describe("what it refuses", () => {
  it("refuses a caller who is not signed in", async () => {
    mockGate = { ok: false, response: new Response("no", { status: 401 }) };
    const res = await GET(new NextRequest("http://localhost/api/performance/history?connectionId=7&schema=sales"));
    expect(res.status).toBe(401);
    // Nothing was read on the way to being refused.
    expect(mockPoolQuery).not.toHaveBeenCalled();
    expect(mockListHistory).not.toHaveBeenCalled();
  });

  it("refuses a missing connectionId or schema, and a bad fingerprint", async () => {
    expect((await read("?schema=sales")).status).toBe(400);
    expect((await read("?connectionId=7")).status).toBe(400);
    expect((await read("?connectionId=7&schema=sales&fingerprint=nothex!!")).status).toBe(400);
    expect(mockListHistory).not.toHaveBeenCalled();
  });

  it("still shows the history when the connection it was captured against is gone", async () => {
    // query_history.connection_id is deliberately not a foreign key, so the
    // history outlives the connection. Refusing here would throw away the only
    // record that the work was ever done.
    mockPoolQuery.mockResolvedValue({ rows: [] });
    mockListHistory.mockResolvedValue([run(9)]);
    const res = await read("?connectionId=7&schema=sales");
    expect(res.status).toBe(200);
    expect(res.body.connectionName as unknown as string).toContain("deleted");
  });

  it("says the history could not be read rather than showing an empty list", async () => {
    // An empty list means "nothing has ever been analysed here", which is a
    // different and false claim.
    mockListHistory.mockRejectedValue(new Error("relation query_history does not exist"));
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    const res = await read("?connectionId=7&schema=sales");
    expect(res.status).toBe(500);
    expect(res.body.ok as unknown as boolean).toBe(false);
    spy.mockRestore();
  });
});
