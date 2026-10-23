// phone-compare-route: POST /api/compare/phone, the comparison a paired phone
// asks for through the desktop app (app/api/compare/phone/route.ts).
//
// These tests run the real route over the real runComparison, with the
// databases replaced, as tests/compare-sets-access.test.ts does. They check
// that each kind of target is answered the way lib/phone-compare.ts says, that
// nothing about the databases leaves the computer (no host, no user name, no
// password, no error a server gave), and that asking writes nothing: no run is
// recorded and no saved set is read or marked.
import { NextRequest, NextResponse } from "next/server";
import type { Gate } from "@/lib/auth-guard";
import { compareSchemas } from "@/lib/compare";
import { buildDiffDocument } from "@/lib/compare-export";
import { countedChanges } from "@/lib/compare-export-format";
import type { CompareSummary } from "@/lib/phone-compare";
import { principalFor } from "./helpers/principals";
import { column, schema, table } from "./helpers/snapshots";

let mockGate: Gate;
/** The keys each call to requirePermission asked for, in order. */
let mockAskedFor: string[][] = [];
/** Every query sent to the metadata database, in order. */
const mockQueries: string[] = [];
/** What the metadata database holds. Reset before each test. */
const mockState = {
  connections: [] as unknown[],
  failConnections: false,
  previousRuns: [] as unknown[],
};

jest.mock("../lib/auth-guard", () => ({
  requirePermission: async (...keys: string[]) => {
    mockAskedFor.push(keys);
    return mockGate;
  },
}));

jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: {
    query: async (text: string) => {
      mockQueries.push(text);
      if (/FROM connections/.test(text)) {
        if (mockState.failConnections) throw new Error("the metadata database is down");
        return { rows: mockState.connections, rowCount: mockState.connections.length };
      }
      const rows = /FROM comparison_runs/.test(text) ? mockState.previousRuns : [];
      return { rows, rowCount: rows.length };
    },
  },
  syncMetadataTables: async () => {},
}));

// Reached through these when called, not when the factory runs, because the
// factory runs before the lines that create them.
const mockListSets = jest.fn();
const mockMarkRun = jest.fn();
jest.mock("../lib/comparison-sets", () => ({
  listComparisonSets: (...args: unknown[]) => mockListSets(...args),
  markComparisonSetRun: (...args: unknown[]) => mockMarkRun(...args),
}));

jest.mock("../lib/lineage-db", () => ({
  findTrackedSchemas: async () => new Map(),
  trackedSchemaKey: (id: number, name: string) => `${id}|${name}`,
}));

jest.mock("../lib/postgres", () => ({
  POOL_MAX: 4,
  fetchSchemaNames: async (config: { host?: string }) => mockSchemaNames(String(config.host)),
  fetchSchemaSnapshot: async (config: { host?: string }, name: string) => ({
    ok: true,
    data: mockSnapshotFor(String(config.host), name),
  }),
}));

// Only the one function that opens a database is replaced, as in
// tests/compare-run-safety.test.ts.
jest.mock("../lib/version-detection", () => ({
  ...jest.requireActual("../lib/version-detection"),
  fetchSchemaVersionInfo: async () => ({
    schema: "public",
    hasVersionTable: false,
    tableName: null,
    detectedVersion: null,
    comparableValue: null,
    versionScheme: null,
    timeline: [],
    familyHeads: null,
    fallbackMode: true,
    message: "No version table in this schema.",
  }),
}));

import { POST } from "@/app/api/compare/phone/route";

const DEV_HOST = "dev-db.example.test";
const STAGING_HOST = "staging-db.example.test";
/** The database that never answers. A private address, as a real one might be. */
const DOWN_HOST = "10.20.30.40";
const USER_NAME = "fake-user-name";
// Built when the test runs, so that no line of this public repo looks like a
// password.
const PASSWORD = ["not", "a", "real", "password"].join("-");

const CONNECTIONS = [
  { id: 1, name: "Dev", host: DEV_HOST, environment: "dev" },
  { id: 2, name: "Staging", host: STAGING_HOST, environment: "staging" },
  { id: 3, name: "Down", host: DOWN_HOST, environment: "prod" },
].map((connection) => ({
  ...connection,
  port: 5432,
  database_name: "app",
  type: "PostgreSQL",
  username: USER_NAME,
  password: PASSWORD,
  connection_string: null,
  ssl: false,
  ssl_mode: null,
}));

// The same shapes as tests/phone-compare.test.ts: a table the target lacks, a
// column the source lacks, and one column whose type differs.
const SOURCE_TABLES = [
  table("orders", [column("id"), column("total", { typeDisplay: "numeric" })]),
  table("users", [column("id"), column("email", { typeDisplay: "text" })]),
];
const TARGET_TABLES = [
  table("users", [
    column("id"),
    column("email", { typeDisplay: "varchar(80)" }),
    column("legacy"),
  ]),
];

/** Every database lists the same schemas, except the one that never answers. */
function mockSchemaNames(host: string) {
  return host === DOWN_HOST
    ? { ok: false, error: `connect ECONNREFUSED ${DOWN_HOST}:5432` }
    : { ok: true, data: ["public", "qa"] };
}

/** Dev holds the source's tables, and every other database the target's. */
function mockSnapshotFor(host: string, name: string) {
  return schema(host === DEV_HOST ? SOURCE_TABLES : TARGET_TABLES, {
    database: "app",
    schema: name,
  });
}

const GONE = "This connection is no longer saved on the computer.";

beforeEach(() => {
  mockAskedFor = [];
  mockQueries.length = 0;
  mockState.connections = CONNECTIONS;
  mockState.failConnections = false;
  mockState.previousRuns = [];
  mockGate = { ok: true, principal: principalFor("viewer") };
  mockListSets.mockReset();
  mockMarkRun.mockReset();
});

type Answer = CompareSummary & { error?: string };

/** Send this body to the route, as the desktop app would. */
async function post(body: unknown): Promise<[number, Answer]> {
  const response = await POST(
    new NextRequest("http://localhost/api/compare/phone", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "content-type": "application/json" },
    })
  );
  return [response.status, await response.json()];
}

/** Compare Dev's public schema with these targets: [connection ID, schema]. */
function compare(...targets: Array<[number, string]>) {
  return post({
    source: { connectionId: 1, schema: "public" },
    targets: targets.map(([connectionId, name]) => ({ connectionId, schema: name })),
  });
}

describe("who may ask", () => {
  test("asks for Compare: Read, the same as the Compare screen", async () => {
    await compare([2, "public"]);
    expect(mockAskedFor).toEqual([["compare:read"]]);
  });

  test("a refused gate is the answer, and nothing is read", async () => {
    mockGate = {
      ok: false,
      response: NextResponse.json({ error: "Sign in first." }, { status: 401 }),
    };
    const [status] = await compare([2, "public"]);
    expect(status).toBe(401);
    expect(mockQueries).toEqual([]);
  });
});

describe("a request the route refuses", () => {
  test("a body that is not JSON", async () => {
    const [status, answer] = await post("{not json");
    expect([status, answer.error]).toEqual([400, "Invalid JSON in request body."]);
  });

  test("a body the reader refuses gets the reader's reason, and nothing is read", async () => {
    const [status, answer] = await post({
      source: { connectionId: 1, schema: " public" },
      targets: [{ connectionId: 2, schema: "public" }],
    });
    expect(status).toBe(400);
    expect(answer.error).toMatch(/^The source needs/);
    expect(mockQueries).toEqual([]);
  });
});

describe("a compared target", () => {
  test("has the counts the Compare screen shows", async () => {
    const [status, answer] = await compare([2, "public"]);
    const document = buildDiffDocument(
      compareSchemas(mockSnapshotFor(DEV_HOST, "public"), mockSnapshotFor(STAGING_HOST, "public"))
    );

    expect(status).toBe(200);
    expect(answer.source).toEqual({
      connectionId: 1,
      name: "Dev (app)",
      environment: "dev",
      schema: "public",
      error: null,
    });
    expect(answer.targets).toHaveLength(1);
    expect(answer.targets[0]).toMatchObject({
      connectionId: 2,
      name: "Staging (app)",
      environment: "staging",
      schema: "public",
      status: "compared",
      error: null,
      changes: countedChanges(document.totals),
      breaking: document.totals.breaking,
      manual: document.totals.manual,
      moreLines: 0,
      history: null,
    });
    expect(answer.targets[0].changes).toBeGreaterThan(0);
    expect(answer.targets[0].lines).toHaveLength(document.changes.length);
  });

  test("nothing about the databases is in the answer", async () => {
    const [, answer] = await compare([2, "public"], [3, "public"]);
    const text = JSON.stringify(answer);
    for (const secret of [DEV_HOST, STAGING_HOST, DOWN_HOST, USER_NAME, PASSWORD, "ECONNREFUSED"]) {
      expect(text).not.toContain(secret);
    }
  });

  test("says what changed since the last recorded run, but not who ran it", async () => {
    mockState.previousRuns = [
      {
        source_connection_id: 1,
        source_schema: "public",
        target_connection_id: 2,
        target_schema: "public",
        ran_at: "2026-09-12T10:00:00.000Z",
        ran_by: "ran-by-a-person",
        findings: { fingerprint: "old", items: [] },
      },
    ];
    const [, answer] = await compare([2, "public"]);
    expect(answer.targets[0].history).toMatch(/^Since the comparison .*: \d+ new differences?/);
    expect(JSON.stringify(answer)).not.toContain("ran-by-a-person");
  });
});

describe("a target that is not compared says why, in the summary's own words", () => {
  test.each<[string, [number, string], string, string]>([
    [
      "a database that does not answer",
      [3, "public"],
      "unreachable",
      "The computer could not connect to this database. Open Compare on the computer to see why.",
    ],
    [
      "the source schema itself",
      [1, "public"],
      "same-as-source",
      "This is the source schema itself, so there is nothing to compare.",
    ],
    ["a connection that is not saved", [99, "public"], "no-connection", GONE],
    [
      "a schema the database does not have",
      [2, "nope"],
      "schema-missing",
      'This database has no schema called "nope".',
    ],
  ])("%s", async (_label, target, status, error) => {
    const [, answer] = await compare(target);
    expect(answer.targets.map((each) => [each.status, each.error])).toEqual([[status, error]]);
  });

  test("a repeated target is compared once, and the repeat names the first", async () => {
    const [, answer] = await compare([2, "public"], [2, "public"]);
    expect(answer.targets.map((each) => [each.status, each.error])).toEqual([
      ["compared", null],
      [
        "duplicate",
        "This is the same database and schema as target 1, so it is compared only once.",
      ],
    ]);
  });
});

describe("a comparison that cannot run", () => {
  test("a source that is not saved stops it, and no target is reported", async () => {
    const [status, answer] = await post({
      source: { connectionId: 99, schema: "public" },
      targets: [{ connectionId: 2, schema: "public" }],
    });
    expect([status, answer.source.error, answer.targets]).toEqual([200, GONE, []]);
  });

  test("with no saved connections there is nothing to compare", async () => {
    mockState.connections = [];
    const [status, answer] = await compare([2, "public"]);
    expect([status, answer.error]).toEqual([404, "There are no saved connections on the computer."]);
  });

  test("a metadata database that fails is a 500, without its error", async () => {
    mockState.failConnections = true;
    const quiet = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const [status, answer] = await compare([2, "public"]);
      expect(status).toBe(500);
      expect(answer.error).toMatch(/^Could not run this comparison/);
      expect(JSON.stringify(answer)).not.toContain("the metadata database is down");
    } finally {
      quiet.mockRestore();
    }
  });
});

test("asking writes nothing: no run is recorded, and no saved set is read or marked", async () => {
  await compare([2, "public"], [3, "public"]);
  expect(mockQueries.filter((text) => /\b(INSERT|UPDATE|DELETE)\b/.test(text))).toEqual([]);
  expect(mockListSets).not.toHaveBeenCalled();
  expect(mockMarkRun).not.toHaveBeenCalled();
  // The previous runs were still read, so the first check saw real queries.
  expect(mockQueries.some((text) => /FROM comparison_runs/.test(text))).toBe(true);
});
