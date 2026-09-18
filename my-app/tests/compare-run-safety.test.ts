// compare-run: one target blowing up must not take the other targets with it.
//
// compareOneTarget returns every failure it anticipates — an unreachable
// server, a schema that is not there, a connection that was deleted. What it
// cannot return is a failure it did not anticipate: anything thrown out of the
// introspection, the diff or the SQL generation leaves the function without a
// value, and the fan-out hands that rejection to the caller. Six targets then
// render as a blank page instead of five reports and one error, which is the
// worst possible trade — the five that worked were real answers.
//
// These tests drive the real runComparison with the database layer mocked, so
// the net is exercised where it actually sits rather than through an exported
// hook that only tests use.
import { runComparison } from "@/lib/compare-run";

/** Which target database's snapshot read should throw, by host. Null for none. */
let explodeOnHost: string | null = null;

const connections = [
  {
    id: 1,
    name: "Dev",
    host: "localhost",
    port: 5432,
    database_name: "app",
    type: "PostgreSQL",
    username: "u",
    password: "p",
    connection_string: null,
    ssl: false,
    ssl_mode: null,
    environment: "development",
  },
  {
    id: 2,
    name: "Staging",
    host: "staging.example.com",
    port: 5432,
    database_name: "app",
    type: "PostgreSQL",
    username: "u",
    password: "p",
    connection_string: null,
    ssl: false,
    ssl_mode: null,
    environment: "staging",
  },
  {
    id: 3,
    name: "QA",
    host: "qa.example.com",
    port: 5432,
    database_name: "app",
    type: "PostgreSQL",
    username: "u",
    password: "p",
    connection_string: null,
    ssl: false,
    ssl_mode: null,
    environment: "staging",
  },
];

/** An empty schema. Every other collection is optional, so three fields is one. */
function emptySnapshot(schema: string) {
  return { database: "app", schema, tables: [] };
}

jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: {
    query: async () => ({ rows: mockConnections, rowCount: mockConnections.length }),
  },
  syncMetadataTables: async () => {},
}));

jest.mock("../lib/comparison-sets", () => ({
  listComparisonSets: async () => [],
  markComparisonSetRun: async () => {},
}));

jest.mock("../lib/lineage-db", () => ({
  findTrackedSchemas: async () => new Map(),
  trackedSchemaKey: (id: number, schema: string) => `${id}|${schema}`,
  recordComparisonRun: async () => {},
}));

jest.mock("../lib/postgres", () => ({
  POOL_MAX: 4,
  fetchSchemaNames: async () => ({ ok: true, data: ["public", "qa"] }),
  fetchSchemaSnapshot: async (config: { host?: string }, schema: string) => {
    // The unforeseen failure this whole fix is about: not a returned error,
    // a throw out of the middle of the work. Keyed on the host so a target can
    // explode without the source — whose read happens first — going with it.
    if (config.host === mockState.explodeOnHost) {
      throw new Error("Cannot read properties of undefined (reading 'relname')");
    }
    return { ok: true, data: mockEmptySnapshot(schema) };
  },
}));

// Only the one function that opens a database is replaced. Listing the module's
// exports by hand instead would silently stub out pickCurrentVersion and the
// rest, and the failure would read as a bug in compare-run.
jest.mock("../lib/version-detection", () => ({
  ...jest.requireActual("../lib/version-detection"),
  fetchSchemaVersionInfo: async () => mockNoVersionTable,
}));

// The factories above run before the module body, so they cannot close over an
// ordinary const — a `mock`-prefixed name is the exception jest allows.
const mockConnections = connections;
/** What a schema with no version table detects as — the ordinary case. */
const mockNoVersionTable = {
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
};
const mockEmptySnapshot = emptySnapshot;
const mockState = {
  get explodeOnHost() {
    return explodeOnHost;
  },
};

/** Compare the dev source against staging and QA, both on `public`. */
async function compareTwoTargets() {
  const query = new URLSearchParams();
  query.set("run", "1");
  query.set("sourceConnection", "1");
  query.set("sourceSchema", "public");
  query.append("targetConnection", "2");
  query.append("targetSchema", "public");
  query.append("targetConnection", "3");
  query.append("targetSchema", "qa");
  const screen = await runComparison(query, null);
  if (screen.kind !== "ready") throw new Error(`expected a ready screen, got ${screen.kind}`);
  return screen;
}

beforeEach(() => {
  explodeOnHost = null;
});

describe("a target whose comparison throws", () => {
  it("does not take the other targets' reports with it", async () => {
    explodeOnHost = "qa.example.com";
    const screen = await compareTwoTargets();

    expect(screen.outcomes).toHaveLength(2);
    // The one that worked still has its report. Before the net, this whole
    // call rejected and the screen showed nothing at all.
    expect(screen.outcomes[0].failure).toBeNull();
    expect(screen.outcomes[0].report).not.toBeNull();
    expect(screen.outcomes[1].failure).toBe("failed");
    expect(screen.outcomes[1].report).toBeNull();
  });

  it("says what happened, in that target's own slot", async () => {
    explodeOnHost = "qa.example.com";
    const screen = await compareTwoTargets();
    const failed = screen.outcomes[1];

    // The target keeps its identity, so the reader can see which one it was
    // and fix it rather than re-running a comparison of unknown shape.
    expect(failed.schema).toBe("qa");
    expect(failed.displayName).toContain("QA");
    expect(failed.error).toContain("failed unexpectedly");
    // The driver's own words are kept: they are the only clue to the cause.
    expect(failed.error).toContain("relname");
    // And it says the rest of the run is still good, because a reader who has
    // just seen one error assumes the page is lying about the others.
    expect(failed.error).toContain("other targets in this run are unaffected");
  });

  it("is not counted as unreachable", async () => {
    // The distinction matters on the summary bar. Nothing here says the QA
    // server is down — it answered, and the fault is on this side. Calling it
    // unreachable sends the reader to check a network that is working.
    explodeOnHost = "qa.example.com";
    const screen = await compareTwoTargets();

    expect(screen.outcomes.filter((o) => o.failure === "unreachable")).toHaveLength(0);
    expect(screen.outcomes.filter((o) => o.failure === "failed")).toHaveLength(1);
  });

  it("leaves every target clean when nothing throws", async () => {
    const screen = await compareTwoTargets();

    expect(screen.outcomes).toHaveLength(2);
    expect(screen.outcomes.every((o) => o.failure === null)).toBe(true);
    expect(screen.outcomes.every((o) => o.report !== null)).toBe(true);
  });

  it("survives a throw on the first target as well as the last", async () => {
    // Order matters to a fan-out: an exception from the first item can abort
    // the ones still queued behind it. Here the first target explodes and the
    // second must still come back with a report.
    explodeOnHost = "staging.example.com";
    const screen = await compareTwoTargets();

    expect(screen.outcomes).toHaveLength(2);
    expect(screen.outcomes[0].failure).toBe("failed");
    expect(screen.outcomes[1].failure).toBeNull();
    expect(screen.outcomes[1].report).not.toBeNull();
  });
});
