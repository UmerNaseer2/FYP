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
import type { SchemaSnapshot } from "@/lib/postgres";

// Relative paths on purpose: next/jest rewrites the @/ alias inside import
// statements only, so jest.mock("@/...") would not resolve.
// A principal rather than null: requireViewer/requireEditor return
// `{ ok: true; principal: Principal }`, so `ok` being true means there is one.
// The routes record who analysed a query, and a mock that answers null for the
// allowed case describes a state the real guard cannot produce.
const PRINCIPAL = { email: "tester@example.com", name: "Tester", role: "editor" };
jest.mock("../lib/auth-guard", () => ({
  requireViewer: async () => ({ ok: true, principal: PRINCIPAL }),
  requireEditor: async () => ({ ok: true, principal: PRINCIPAL }),
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
    // The EXPLAIN went over the extended protocol. That is what makes the
    // server refuse a second statement hiding in the text, so even estimate
    // mode (open to any viewer) cannot be tricked into a COMMIT then a DELETE.
    const explains = queriesMatching(client, /^EXPLAIN/);
    expect(explains).toHaveLength(1);
    expect(explains.every((q) => q.queryMode === "extended")).toBe(true);
    // The setup statements stay on the simple protocol; only the user's query
    // needs the wall.
    expect(queriesMatching(client, /^BEGIN|^SET LOCAL|^SELECT set_config/).every(
      (q) => q.queryMode === undefined
    )).toBe(true);
  });

  it("closes a measured query's connection instead of handing it to the next request", async () => {
    const client = target(PLANS);
    const res = await analyze("SELECT id FROM orders", true);

    expect(res.status).toBe(200);
    expect((await res.json()).mode).toBe("measured");
    const analyzeExplains = queriesMatching(client, /^EXPLAIN \(ANALYZE/);
    expect(analyzeExplains).toHaveLength(1);
    // The measured run is a real EXPLAIN ANALYZE, so the extended-protocol wall
    // matters most here: it too carries exactly one command.
    expect(analyzeExplains.every((q) => q.queryMode === "extended")).toBe(true);
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

describe("GET /api/performance/advice", () => {
  /** An index on orders (customer_id), as the snapshot records it. */
  const copyNamed = (name: string) => ({
    name,
    definition: `CREATE INDEX ${name} ON orders USING btree (customer_id)`,
    normalizedDefinition: `CREATE INDEX ${name} ON orders USING btree (customer_id)`,
    columns: ["customer_id"],
    isUnique: false,
    method: "btree",
    predicate: null,
  });

  /** shop.orders with two identical indexes: a duplicate, unless one of them is invalid. */
  const SNAPSHOT: SchemaSnapshot = {
    database: "shop",
    schema: "shop",
    tables: [
      {
        name: "orders",
        columns: [],
        primaryKey: {
          name: "orders_pkey",
          kind: "PRIMARY KEY",
          columns: ["id"],
          definition: "PRIMARY KEY (id)",
          normalizedDefinition: "PRIMARY KEY (id)",
        },
        uniqueConstraints: [],
        foreignKeys: [],
        checkConstraints: [],
        excludeConstraints: [],
        indexes: [copyNamed("orders_a"), copyNamed("orders_b")],
      },
    ],
  };

  /** The first read of pass two, for orders_a, which PostgreSQL has marked invalid. */
  const INVALID_COPY = {
    index_name: "orders_a",
    table_name: "orders",
    is_unique: false,
    is_primary: false,
    is_partitioned: false,
    is_partition_child: false,
    definition: "CREATE INDEX orders_a ON shop.orders USING btree (customer_id)",
    constraint_definition: null,
    waiting_on: null,
    attached_example: null,
    top_index: null,
  };

  /** And for a partitioned table's index that one partition has no copy of yet. */
  const UNFINISHED = {
    index_name: "events_k",
    table_name: "events",
    is_unique: false,
    is_primary: false,
    is_partitioned: true,
    is_partition_child: false,
    definition: "CREATE INDEX events_k ON ONLY shop.events USING btree (k)",
    constraint_definition: null,
    // node-pg parses json itself, so these arrive as objects.
    waiting_on: [
      { schema: "shop", table: "events_2026", partitioned: false, foreign: false, foreign_below: false, attached: null },
    ],
    attached_example: { schema: "shop", name: "events_2025_k_idx" },
    top_index: null,
  };

  /** Pass two's reads, with `invalid` as the list of invalid indexes. */
  function statsSteps(invalid: Record<string, unknown>[]): FakeStep[] {
    return [
      { match: /NOT ix\.indisvalid/, rows: invalid },
      { match: /pg_stat_database/, rows: [{ counters_since: "2026-08-01T00:00:00.000Z" }] },
    ];
  }

  async function advise(): Promise<Response> {
    const { GET } = await import("../app/api/performance/advice/route");
    return GET(new NextRequest("http://localhost/api/performance/advice?connectionId=7&schema=shop"));
  }

  /** The ids of the findings in a response body. */
  const idsIn = (body: { advice: { id: string }[] }) => body.advice.map((a) => a.id);

  beforeEach(() => {
    mockFetchSchemaSnapshot.mockResolvedValue({ ok: true, data: SNAPSHOT });
  });

  it("does not count an invalid index as a copy, and shows an unfinished partitioned index", async () => {
    const client = target(statsSteps([INVALID_COPY, UNFINISHED]));
    const res = await advise();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.statsUnavailable).toBeNull();
    // orders_a is invalid, so orders_b is no duplicate of it.
    expect(idsIn(body)).not.toContain("duplicate-index");
    const unfinished = body.advice.filter((a: { id: string }) => a.id === "unfinished-partitioned-index");
    expect(unfinished).toHaveLength(1);
    expect(unfinished[0].object).toBe("events.events_k");
    expect(unfinished[0].origin).toBe("statistics");
    expect(unfinished[0].fix).toContain(
      '-- ALTER INDEX "shop"."events_k" ATTACH PARTITION "shop"."events_2026_k_idx";'
    );

    // The invalid indexes are read first, with every name written out in full.
    const texts = queryTexts(client);
    const invalidAt = texts.findIndex((text) => /NOT ix\.indisvalid/.test(text));
    expect(texts).toContain("SET LOCAL search_path = pg_catalog");
    expect(invalidAt).toBeGreaterThan(texts.indexOf("SET LOCAL search_path = pg_catalog"));
    expect(invalidAt).toBeLessThan(texts.findIndex((text) => /pg_stat_user_tables/.test(text)));
    expect(queriesMatching(client, /NOT ix\.indisvalid/)[0].values).toEqual([
      "shop",
      ["script_patch", "script_patch_reverted"],
    ]);
    expect(texts.at(-1)).toBe("COMMIT");
    expect(client.releaseCount).toBe(1);
    expect(client.releasedWith).toBe(false);
  });

  it("keeps the list of invalid indexes when a later read of the statistics fails", async () => {
    const client = target([
      {
        match: /pg_stat_user_tables/,
        error: { code: "57014", message: "canceling statement due to statement timeout" },
      },
      ...statsSteps([INVALID_COPY, UNFINISHED]),
    ]);
    const res = await advise();

    expect(res.status).toBe(200);
    const body = await res.json();
    // The statistics are lost, and the page says so...
    expect(body.statsUnavailable).toEqual(expect.any(String));
    expect(idsIn(body)).not.toContain("unfinished-partitioned-index");
    // ...but the invalid index was already known, so it is still no copy,
    // and the page does not say the list is missing.
    expect(idsIn(body)).not.toContain("duplicate-index");
    expect(body.statsUnavailable).not.toContain("Which indexes are invalid");
    expect(queryTexts(client).at(-1)).toBe("ROLLBACK");
    expect(client.releaseCount).toBe(1);
    expect(client.releasedWith).toBe(false);
  });

  it("says so when even the list of invalid indexes could not be read", async () => {
    target([
      {
        match: /NOT ix\.indisvalid/,
        error: { code: "57014", message: "canceling statement due to statement timeout" },
      },
      ...statsSteps([INVALID_COPY]),
    ]);
    const body = await (await advise()).json();
    // With no list, orders_a counts as a copy of orders_b, so the page warns
    // that a suggestion from the schema may lean on an invalid index.
    expect(idsIn(body)).toContain("duplicate-index");
    expect(body.statsUnavailable).toMatch(/^Reading the usage statistics took longer than/);
    expect(body.statsUnavailable).toMatch(
      / Which indexes are invalid could not be read either, so a suggestion from the schema may count an invalid index as one queries use\.$/
    );
  });

  it("finds the duplicate when neither copy is invalid", async () => {
    target(statsSteps([]));
    const body = await (await advise()).json();
    expect(idsIn(body)).toContain("duplicate-index");
  });

  /** The finding with this id, or undefined. */
  const find = (body: { advice: { id: string }[] }, id: string) =>
    body.advice.find((a) => a.id === id) as
      | { id: string; fix: string; startUnticked?: string }
      | undefined;

  /** Pass two, with the very first read — the invalid indexes — timing out. */
  const NO_INVALID_LIST: FakeStep[] = [
    {
      match: /NOT ix\.indisvalid/,
      error: { code: "57014", message: "canceling statement due to statement timeout" },
    },
    ...statsSteps([]),
  ];

  it("leaves the index drop unticked when it cannot tell which index is broken", async () => {
    // orders_a and orders_b look identical, so one is offered for DROP. With no
    // list, the app cannot know orders_a is the half-built one a failed CREATE
    // INDEX CONCURRENTLY left behind — so the DROP it wrote may be aimed at the
    // only working index of the two, and it must not go into a script that
    // somebody runs without reading.
    target(NO_INVALID_LIST);
    const body = await (await advise()).json();

    const duplicate = find(body, "duplicate-index");
    expect(duplicate?.startUnticked).toContain("Starts unticked");
    expect(duplicate?.startUnticked).toContain("which indexes are invalid could not be read");
  });

  it("leaves it ticked like everything else once the list has been read", async () => {
    // The ordinary case, and the one that would make this fix a nuisance if it
    // leaked: a duplicate found with the list in hand is as good as any other
    // suggestion.
    target(statsSteps([]));
    const body = await (await advise()).json();

    expect(find(body, "duplicate-index")?.startUnticked).toBeUndefined();
  });

  it("does not untick advice that acts on no index at all", async () => {
    // A table with no primary key and nothing to build one out of. Its fix
    // names its own column, so the missing list says nothing about it and
    // unticking it would just be noise.
    mockFetchSchemaSnapshot.mockResolvedValue({
      ok: true,
      data: {
        ...SNAPSHOT,
        tables: [
          ...SNAPSHOT.tables,
          {
            name: "audit_log",
            columns: [],
            primaryKey: null,
            uniqueConstraints: [],
            foreignKeys: [],
            checkConstraints: [],
            excludeConstraints: [],
            indexes: [],
          },
        ],
      },
    });
    target(NO_INVALID_LIST);
    const body = await (await advise()).json();

    const noKey = find(body, "no-primary-key");
    expect(noKey).toBeDefined();
    expect(noKey?.fix).not.toContain("USING INDEX");
    expect(noKey?.startUnticked).toBeUndefined();
  });

  it("falls back to general steps when the partitions come back in a shape it does not know", async () => {
    target(statsSteps([{ ...UNFINISHED, waiting_on: "not a list" }]));
    const body = await (await advise()).json();
    const found = body.advice.find((a: { id: string }) => a.id === "unfinished-partitioned-index");
    expect(found.fix).toContain("-- Find which partitions have no finished copy attached:");
  });
});
