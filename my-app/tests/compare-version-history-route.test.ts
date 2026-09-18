// GET /api/compare/version-history: one schema's WHOLE version history, from
// whatever table it keeps its versions in.
//
// A comparison carries only the newest few entries of each side, so before
// this route a schema using flyway_schema_history showed five rows and had no
// way to show the sixth. What matters here is that the route hands back every
// row the detector read, marks the same entry as current that the version bar
// above the timeline prints, and never lets a saved password out in its answer.
//
// The detector is mocked: it opens database connections, and what is being
// tested is the route around it, not the catalog queries it sends.
import { NextRequest } from "next/server";
import type { VersionDetectionResult, VersionTimelineEntry } from "@/lib/version-detection";

// Relative paths on purpose: next/jest rewrites the @/ alias inside import
// statements only, so jest.mock("@/...") would not resolve.
let mockGate: { ok: true; principal: null } | { ok: false; response: Response };
jest.mock("../lib/auth-guard", () => ({
  requireViewer: async () => mockGate,
}));

const mockPoolQuery = jest.fn<Promise<unknown>, unknown[]>(async () => ({ rows: [] }));
jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: { query: (...args: unknown[]) => mockPoolQuery(...args) },
  syncMetadataTables: async () => undefined,
}));

// Set to throw to play a saved secret this server can't decrypt.
const mockBuildPgConfig = jest.fn<unknown, unknown[]>(() => ({}));
jest.mock("../lib/connection-config", () => ({
  buildPgConfig: (...args: unknown[]) => mockBuildPgConfig(...args),
}));

// Only fetchSchemaVersionInfo is replaced. pickCurrentVersion is the real one,
// because the route's job is to apply that rule to what the detector returned
// — a stub would let a wrong entry be marked current and still pass.
const mockFetchInfo = jest.fn<Promise<VersionDetectionResult>, unknown[]>();
jest.mock("../lib/version-detection", () => {
  const real = jest.requireActual("../lib/version-detection");
  return {
    ...real,
    fetchSchemaVersionInfo: (...args: unknown[]) => mockFetchInfo(...args),
  };
});

type RouteModule = typeof import("../app/api/compare/version-history/route");
let GET: RouteModule["GET"];

const CONNECTION = {
  host: "db.test", port: 5432, database_name: "sales", username: "app",
  password: "not-a-real-password", connection_string: null, ssl: false,
  ssl_mode: "disable", name: "Sales dev",
};

/** One Flyway row, with only what a test is about set. */
function row(version: string, extra: Partial<VersionTimelineEntry> = {}): VersionTimelineEntry {
  return {
    version,
    label: `V${version}__migration`,
    description: null,
    changeLevel: "unknown",
    appliedAt: `2026-03-0${version.split(".")[1] ?? "1"}T10:00:00.000Z`,
    sourceTable: "flyway_schema_history",
    succeeded: true,
    scriptName: null,
    ...extra,
  };
}

/** What the detector found, defaulting to a readable Flyway table. */
function info(extra: Partial<VersionDetectionResult> = {}): VersionDetectionResult {
  return {
    schema: "sales",
    hasVersionTable: true,
    tableName: "flyway_schema_history",
    detectedVersion: "1.3",
    comparableValue: null,
    versionScheme: "numeric",
    timeline: [],
    familyHeads: null,
    truncated: false,
    fallbackMode: false,
    message: "Version table found: flyway_schema_history",
    ...extra,
  };
}

async function read(query = "?connectionId=7&schema=sales") {
  const res = await GET(new NextRequest(`http://localhost/api/compare/version-history${query}`));
  const text = await res.text();
  // A saved password must never travel to the browser, whatever the answer is.
  expect(text).not.toContain("not-a-real-password");
  return { status: res.status, body: JSON.parse(text) as Record<string, never> };
}

beforeAll(async () => {
  ({ GET } = await import("../app/api/compare/version-history/route"));
});

beforeEach(() => {
  mockGate = { ok: true, principal: null };
  mockPoolQuery.mockReset();
  mockPoolQuery.mockResolvedValue({ rows: [CONNECTION] });
  mockBuildPgConfig.mockReset();
  mockBuildPgConfig.mockReturnValue({});
  mockFetchInfo.mockReset();
  mockFetchInfo.mockResolvedValue(info());
});

describe("what it answers with", () => {
  it("returns every row the detector read, not the newest few", async () => {
    // Nine rows: more than VERSION_TIMELINE_SHOWN, which is the whole point.
    const rows = Array.from({ length: 9 }, (_, index) => row(`1.${index}`));
    mockFetchInfo.mockResolvedValue(info({ timeline: rows.slice().reverse(), detectedVersion: "1.8" }));

    const res = await read();
    expect(res.status).toBe(200);
    const detected = res.body.detected as unknown as { recent: { version: string }[]; table: string };
    expect(detected.table).toBe("flyway_schema_history");
    expect(detected.recent).toHaveLength(9);
    // Newest first, the order the detector returned them in.
    expect(detected.recent[0].version).toBe("1.8");
  });

  it("marks the same entry current that the version bar prints", async () => {
    // A failed run is never the current version, even when it is the newest
    // row. pickCurrentVersion is the rule; the route must apply it, not take
    // the first row.
    mockFetchInfo.mockResolvedValue(
      info({
        timeline: [row("2.0", { succeeded: false }), row("1.9"), row("1.8")],
        detectedVersion: "1.9",
      })
    );

    const res = await read();
    const detected = res.body.detected as unknown as {
      recent: { version: string; current: boolean; succeeded: boolean | null }[];
    };
    expect(detected.recent.filter((entry) => entry.current).map((entry) => entry.version)).toEqual(["1.9"]);
    // And the failed run still travels, so the timeline can show it as failed
    // rather than quietly dropping a migration that ran and did not finish.
    expect(detected.recent[0]).toMatchObject({ version: "2.0", succeeded: false, current: false });
  });

  it("says when the detector's row limit cut the history short", async () => {
    mockFetchInfo.mockResolvedValue(info({ timeline: [row("1.3")], truncated: true }));
    const cut = await read();
    expect((cut.body.detected as unknown as { recentComplete: boolean }).recentComplete).toBe(false);

    mockFetchInfo.mockResolvedValue(info({ timeline: [row("1.3")], truncated: false }));
    const whole = await read();
    expect((whole.body.detected as unknown as { recentComplete: boolean }).recentComplete).toBe(true);
  });

  it("answers plainly when the schema keeps no versions at all", async () => {
    // The detector answers rather than throws for this, and the screen already
    // renders a side with no table. A 200 with no entries is the honest shape.
    mockFetchInfo.mockResolvedValue(
      info({
        hasVersionTable: false,
        tableName: null,
        detectedVersion: null,
        fallbackMode: true,
        message: "no version table in this schema",
      })
    );
    const res = await read();
    expect(res.status).toBe(200);
    expect(res.body.detected as unknown as { table: null; recent: [] }).toMatchObject({
      table: null,
      recent: [],
    });
  });

  it("reads the schema the caller asked for, through the saved connection", async () => {
    await read("?connectionId=7&schema=warehouse");
    expect(mockPoolQuery).toHaveBeenCalledWith(expect.stringContaining("FROM connections"), [7]);
    expect(mockFetchInfo).toHaveBeenCalledWith(expect.anything(), "warehouse");
  });
});

describe("what it refuses", () => {
  it("refuses a caller who is not signed in", async () => {
    mockGate = { ok: false, response: new Response("no", { status: 401 }) };
    const res = await GET(new NextRequest("http://localhost/api/compare/version-history?connectionId=7&schema=sales"));
    expect(res.status).toBe(401);
    // Nothing was read on the way to being refused.
    expect(mockPoolQuery).not.toHaveBeenCalled();
    expect(mockFetchInfo).not.toHaveBeenCalled();
  });

  it("refuses a missing or nonsense connectionId, and a missing schema", async () => {
    for (const query of ["?schema=sales", "?connectionId=0&schema=sales", "?connectionId=abc&schema=sales"]) {
      expect((await read(query)).status).toBe(400);
    }
    expect((await read("?connectionId=7&schema=%20%20")).status).toBe(400);
    expect(mockFetchInfo).not.toHaveBeenCalled();
  });

  it("says so when the connection is gone", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    const res = await read();
    expect(res.status).toBe(404);
    expect(res.body.error as unknown as string).toContain("7");
  });

  it("names the key, not the secret, when the saved password cannot be read", async () => {
    mockBuildPgConfig.mockImplementation(() => {
      throw new Error("APP_ENCRYPTION_KEY does not match");
    });
    const res = await read();
    expect(res.status).toBe(500);
    expect(typeof (res.body.error as unknown as string)).toBe("string");
    expect(mockFetchInfo).not.toHaveBeenCalled();
  });

  it("reports an unreachable target without claiming the schema has no versions", async () => {
    mockFetchInfo.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const res = await read();
    expect(res.status).toBe(503);
    expect(res.body.error as unknown as string).toContain("Sales dev");
    expect(res.body.detected).toBeUndefined();
  });
});
