// A saved password this server can't decrypt.
//
// buildPgConfig decrypts a saved connection's password, and throws when
// APP_ENCRYPTION_KEY is missing or is not the key the password was saved with.
// Every place that dials a saved connection used to let that through: a bare
// 500 from a route, and on Compare the whole page gone over one side. Each one
// now answers with UNREADABLE_CREDENTIALS_MESSAGE, in its own error shape, and
// opens nothing. The cause stays in the server log.
//
// buildPgConfig is a stand-in here, and so is every function that would dial a
// database; none of those may be called. Nothing reaches a real database or
// GitHub.
import { NextRequest } from "next/server";
import { FAKE_TOKEN, guardGitHub, type GitHubGuard } from "./helpers/no-github";
import { schema } from "./helpers/snapshots";
import { UNREADABLE_CREDENTIALS_MESSAGE } from "@/lib/secret-store";

// Relative paths on purpose: next/jest rewrites the @/ alias inside import
// statements only, so jest.mock("@/...") would not resolve.
jest.mock("../lib/auth-guard", () => ({
  requireViewer: async () => ({ ok: true, principal: null }),
  requireEditor: async () => ({ ok: true, principal: null }),
}));

// The metadata database: saved connections, tracked schemas, lineage.
const mockPoolQuery = jest.fn<Promise<unknown>, unknown[]>(async () => ({ rows: [] }));
jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: { query: (...args: unknown[]) => mockPoolQuery(...args) },
  syncMetadataTables: async () => undefined,
}));

// The three ways into a target database. The rest of lib/postgres is real.
const mockFetchSchemaSnapshot = jest.fn<Promise<unknown>, unknown[]>();
const mockFetchSchemaNames = jest.fn<Promise<unknown>, unknown[]>();
const mockGetPoolForConfig = jest.fn<unknown, unknown[]>(() => {
  throw new Error("Tests never open a real pool.");
});
jest.mock("../lib/postgres", () => ({
  ...jest.requireActual("../lib/postgres"),
  fetchSchemaSnapshot: (...args: unknown[]) => mockFetchSchemaSnapshot(...args),
  fetchSchemaNames: (...args: unknown[]) => mockFetchSchemaNames(...args),
  getPoolForConfig: (...args: unknown[]) => mockGetPoolForConfig(...args),
}));

type ConfigInput = { host?: string | null; port?: number | null; database?: string | null };
const mockBuildPgConfig = jest.fn<unknown, [ConfigInput]>();
jest.mock("../lib/connection-config", () => ({
  buildPgConfig: (input: ConfigInput) => mockBuildPgConfig(input),
}));

// Track asks for a drift check straight away; that is not what these test.
jest.mock("../lib/drift-scheduler", () => ({ requestImmediateCheck: () => undefined }));

// Compare reads the source's version table once it has the source snapshot.
// A schema with none is the ordinary case, and this is what that returns.
jest.mock("../lib/version-detection", () => ({
  ...jest.requireActual("../lib/version-detection"),
  fetchSchemaVersionInfo: async (_cfg: unknown, schemaName: string) => ({
    schema: schemaName,
    hasVersionTable: false,
    tableName: null,
    detectedVersion: null,
    comparableValue: null,
    versionScheme: null,
    timeline: [],
    familyHeads: null,
    fallbackMode: true,
    message: "no version table in this schema",
  }),
}));

/** What decryptSecret throws for a value saved under another key. */
const CAUSE = "Unsupported state or unable to authenticate data";

function unreadable(): never {
  throw new Error(CAUSE);
}

/** One saved connection, with every column any of these routes selects. */
const ROW = {
  id: 7,
  name: "Sales dev",
  connection_name: "Sales dev",
  schema_name: "sales",
  label: null,
  host: "db.test",
  port: 5432,
  database_name: "sales",
  type: "PostgreSQL",
  username: "app",
  password: "not-a-real-password",
  connection_string: null,
  ssl: false,
  ssl_mode: "disable",
  environment: "dev",
};

let guard: GitHubGuard;
let consoleSpy: jest.SpyInstance;

beforeEach(() => {
  guard = guardGitHub();
  mockPoolQuery.mockReset();
  mockPoolQuery.mockResolvedValue({ rows: [ROW] });
  mockBuildPgConfig.mockReset();
  mockBuildPgConfig.mockImplementation(unreadable);
  mockFetchSchemaSnapshot.mockReset();
  mockFetchSchemaNames.mockReset();
  mockGetPoolForConfig.mockClear();
  // Every case logs the cause; the assertions read it from here.
  consoleSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  consoleSpy.mockRestore();
  guard.restore();
  expect(guard.unexpected).toEqual([]);
});

function get(path: string): NextRequest {
  return new NextRequest(`http://localhost${path}`);
}

function post(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

type RouteCase = {
  route: string;
  /** What the route logs the cause under. */
  log: string;
  /** The performance routes answer { ok: false, error }; the rest { error }. */
  okField: boolean;
  call: () => Promise<Response>;
};

// Imported inside each call, after the jest.mock calls above, so every route
// sees the stand-ins.
const ROUTES: RouteCase[] = [
  {
    route: "GET /api/performance/advice",
    log: "Performance advice",
    okField: true,
    call: async () =>
      (await import("../app/api/performance/advice/route")).GET(
        get("/api/performance/advice?connectionId=7&schema=sales")
      ),
  },
  {
    route: "POST /api/performance/analyze",
    log: "Query analysis",
    okField: true,
    call: async () =>
      (await import("../app/api/performance/analyze/route")).POST(
        post("/api/performance/analyze", { connectionId: 7, schema: "sales", sql: "select 1" })
      ),
  },
  {
    route: "GET /api/schema/snapshot",
    log: "Schema snapshot",
    okField: false,
    call: async () =>
      (await import("../app/api/schema/snapshot/route")).GET(
        get("/api/schema/snapshot?connectionId=7&schema=sales")
      ),
  },
  {
    route: "GET /api/lineage/schemas",
    log: "Lineage schemas",
    okField: false,
    call: async () =>
      (await import("../app/api/lineage/schemas/route")).GET(get("/api/lineage/schemas?connectionId=7")),
  },
  {
    route: "POST /api/lineage/track",
    log: "Track",
    okField: false,
    call: async () =>
      (await import("../app/api/lineage/track/route")).POST(
        post("/api/lineage/track", { connectionId: 7, schemaName: "sales" })
      ),
  },
  {
    route: "POST /api/lineage/rebaseline",
    log: "Rebaseline",
    okField: false,
    call: async () =>
      (await import("../app/api/lineage/rebaseline/route")).POST(
        post("/api/lineage/rebaseline", { trackedSchemaId: 3 })
      ),
  },
  {
    route: "GET /api/scripts/schemas",
    log: "Script schemas",
    okField: false,
    call: async () =>
      (await import("../app/api/scripts/schemas/route")).GET(get("/api/scripts/schemas?connectionId=7")),
  },
];

describe.each(ROUTES)("$route", ({ log, okField, call }) => {
  it("says what to fix, logs the cause, and opens nothing", async () => {
    const res = await call();
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual(
      okField
        ? { ok: false, error: UNREADABLE_CREDENTIALS_MESSAGE }
        : { error: UNREADABLE_CREDENTIALS_MESSAGE }
    );
    // The cause is for whoever reads the server log, not for the screen.
    expect(text).not.toContain(CAUSE);
    expect(text).not.toContain("not-a-real-password");
    expect(text).not.toContain(FAKE_TOKEN);
    expect(consoleSpy).toHaveBeenCalledWith(
      `${log} — could not read the saved connection's credentials:`,
      CAUSE
    );

    expect(mockBuildPgConfig).toHaveBeenCalledTimes(1);
    expect(mockGetPoolForConfig).not.toHaveBeenCalled();
    expect(mockFetchSchemaSnapshot).not.toHaveBeenCalled();
    expect(mockFetchSchemaNames).not.toHaveBeenCalled();
  });
});

describe("Compare", () => {
  const BASE_CONNECTION = {
    port: 5432,
    type: "PostgreSQL",
    username: "app",
    password: "not-a-real-password",
    connection_string: null,
    ssl: false,
    ssl_mode: "disable",
  };
  const SOURCE = {
    ...BASE_CONNECTION, id: 1, name: "Source", host: "src.test", database_name: "src_db", environment: "dev",
  };
  const TARGET = {
    ...BASE_CONNECTION, id: 2, name: "Target", host: "tgt.test", database_name: "tgt_db", environment: "staging",
  };

  /** Both connections saved; only the one on `unreadableHost` can't be read. */
  function savedConnections(unreadableHost: string) {
    mockPoolQuery.mockImplementation(async (sql: unknown) =>
      /FROM connections/.test(String(sql)) && /type = 'PostgreSQL'/.test(String(sql))
        ? { rows: [SOURCE, TARGET] }
        : { rows: [] }
    );
    mockBuildPgConfig.mockImplementation((input) =>
      input.host === unreadableHost
        ? unreadable()
        : { host: input.host, port: input.port, database: input.database }
    );
    mockFetchSchemaNames.mockResolvedValue({ ok: true, data: ["sales"] });
    mockFetchSchemaSnapshot.mockResolvedValue({
      ok: true,
      data: schema([], { database: "src_db", schema: "sales" }),
    });
  }

  /** What pressing Compare on Source.sales against Target.sales returns. */
  async function compare() {
    const { runComparison } = await import("../lib/compare-run");
    const screen = await runComparison(
      new URLSearchParams({
        sourceConnection: "1",
        sourceSchema: "sales",
        targetConnection: "2",
        targetSchema: "sales",
        run: "1",
      }),
      false
    );
    // Whatever happens, no secret reaches the browser.
    expect(JSON.stringify(screen)).not.toContain("not-a-real-password");
    if (screen.kind !== "ready") throw new Error(`Expected the ready screen, got ${screen.kind}.`);
    return screen;
  }

  it("keeps a target it can't unlock in its place, under its own name, and says what to fix", async () => {
    savedConnections("tgt.test");
    const screen = await compare();
    const message = `Could not use Target (tgt_db). ${UNREADABLE_CREDENTIALS_MESSAGE}`;

    expect(screen.sourceError).toBeNull();
    expect(screen.targets).toHaveLength(1);
    // The picker names the connection that was picked and says why it lists nothing.
    expect(screen.targets[0]).toMatchObject({
      connectionId: 2,
      displayName: "Target (tgt_db)",
      schema: "sales",
      missingMessage: message,
    });
    // Counted as a target that could not be dialled, not as "no connection".
    expect(screen.outcomes).toHaveLength(1);
    expect(screen.outcomes[0]).toMatchObject({
      displayName: "Target (tgt_db)",
      failure: "unreachable",
      error: message,
      report: null,
    });
    // Save would still write the connection that was picked.
    expect(screen.selection.targets).toEqual([
      { connectionId: 2, connectionLabel: "Target (tgt_db)", schema: "sales" },
    ]);

    // The source was listed and read. The target was never dialled.
    expect(mockFetchSchemaNames).toHaveBeenCalledTimes(1);
    expect(mockFetchSchemaNames.mock.calls[0][0]).toMatchObject({ host: "src.test" });
    expect(mockFetchSchemaSnapshot).toHaveBeenCalledTimes(1);
    expect(mockFetchSchemaSnapshot.mock.calls[0][0]).toMatchObject({ host: "src.test" });
    expect(mockGetPoolForConfig).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith('Compare — could not read the credentials of "Target":', CAUSE);
  });

  it("compares nothing when it can't unlock the source, and the banner says why", async () => {
    savedConnections("src.test");
    const screen = await compare();

    expect(screen.sourceError).toBe(`Could not use Source (src_db). ${UNREADABLE_CREDENTIALS_MESSAGE}`);
    // Still the source that was picked, with the schema that was asked for.
    // Not "missing": the "Nothing compared yet" panel would then say there is
    // no connection, and there is one.
    expect(screen.source).toMatchObject({
      connectionId: 1,
      displayName: "Source (src_db)",
      schema: "sales",
      missingMessage: null,
      detectedVersion: null,
    });
    expect(screen.selection.sourceConnectionLabel).toBe("Source (src_db)");
    expect(screen.outcomes).toEqual([]);

    // The target is fine, and its picker still lists its schemas.
    expect(screen.targets[0]).toMatchObject({ connectionId: 2, missingMessage: null });
    expect(mockFetchSchemaNames).toHaveBeenCalledTimes(1);
    expect(mockFetchSchemaNames.mock.calls[0][0]).toMatchObject({ host: "tgt.test" });
    expect(mockFetchSchemaSnapshot).not.toHaveBeenCalled();
    expect(mockGetPoolForConfig).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith('Compare — could not read the credentials of "Source":', CAUSE);
  });
});

describe("drift check", () => {
  it("calls a database it can't unlock unreachable, and says what to fix", async () => {
    mockPoolQuery.mockImplementation(async (sql: unknown) => {
      const text = String(sql);
      if (/FROM tracked_schemas ts/.test(text)) {
        return { rows: [{ ...ROW, connection_id: 7, drift_check_interval_minutes: null }] };
      }
      if (/FROM lineage_migrations/.test(text)) {
        return {
          rows: [{ id: 11, snapshot: schema([], { database: "sales", schema: "sales" }), version: "1.2.0", seq: 3 }],
        };
      }
      return { rows: [] };
    });

    const { computeDriftDetail } = await import("../lib/lineage-db");
    const result = await computeDriftDetail(3);

    expect(result).toMatchObject({
      kind: "unreachable",
      summary: UNREADABLE_CREDENTIALS_MESSAGE,
      expected: { version: "1.2.0", seq: 3, snapshotId: 11 },
    });
    expect(JSON.stringify(result)).not.toContain("not-a-real-password");
    expect(mockFetchSchemaSnapshot).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      'Drift check — could not read the credentials of "Sales dev":',
      CAUSE
    );
  });
});
