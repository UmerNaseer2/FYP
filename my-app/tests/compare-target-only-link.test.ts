// compare-run: a link that names only the target fills in the pickers and runs
// nothing (POST /api/compare, and runComparison in lib/compare-run.ts).
//
// Drift, the dashboard and a schema's page link to Compare with their schema
// as the target. They used to add run=1, so the comparison ran at once against
// a default source: the first connection by name. A migration for a pair
// nobody chose then sat on the screen like a recommendation, and when the
// first connection was the target itself, the schema was compared with itself
// and the screen said there was nothing to do.
//
// These tests run the real route over the real runComparison, with the
// databases replaced, and check that such a link (even an old bookmark that
// still carries run=1) runs nothing and starts the source on another
// database, while a link that names both sides still runs.
import { NextRequest } from "next/server";
import type { Gate } from "@/lib/auth-guard";
import { principalFor } from "./helpers/principals";

let mockGate: Gate;

jest.mock("../lib/auth-guard", () => ({
  requirePermission: async () => mockGate,
}));

// Three saved PostgreSQL connections, in the name order the real query uses.
jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: {
    query: async (text: string) => {
      const rows = /FROM connections/.test(text) ? mockConnections : [];
      return { rows, rowCount: rows.length };
    },
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
  fetchSchemaNames: async () => ({ ok: true, data: ["public"] }),
  fetchSchemaSnapshot: async (_config: unknown, schema: string) => ({
    ok: true,
    data: { database: "app", schema, tables: [] },
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

const mockConnections = [
  { id: 1, name: "Dev", environment: "development" },
  { id: 2, name: "Prod", environment: "production" },
  { id: 3, name: "Staging", environment: "staging" },
].map((connection) => ({
  ...connection,
  host: `${connection.name.toLowerCase()}.example.com`,
  port: 5432,
  database_name: "app",
  type: "PostgreSQL",
  username: "u",
  password: null,
  connection_string: null,
  ssl: false,
  ssl_mode: null,
}));

import { POST } from "@/app/api/compare/route";

type Screen = {
  kind: string;
  asked: boolean;
  outcomes: unknown[];
  selection: {
    sourceConnectionId: number | null;
    targets: { connectionId: number | null }[];
  };
};

beforeEach(() => {
  mockGate = { ok: true, principal: principalFor("viewer") };
});

/** Open the Compare screen with this query string. */
async function compare(query: string): Promise<Screen> {
  const response = await POST(
    new NextRequest("http://localhost/api/compare", {
      method: "POST",
      body: JSON.stringify({ query }),
      headers: { "content-type": "application/json" },
    })
  );
  expect(response.status).toBe(200);
  return response.json();
}

/** What the screen ran, and which databases its pickers show. */
function picked(screen: Screen) {
  return {
    kind: screen.kind,
    asked: screen.asked,
    ran: screen.outcomes.length,
    source: screen.selection.sourceConnectionId,
    targets: screen.selection.targets.map((target) => target.connectionId),
  };
}

describe("a link that names only the target", () => {
  test("fills in the target, starts the source on another database, and runs nothing", async () => {
    // Dev is first by name, and it is the target, so the source is not Dev.
    expect(picked(await compare("targetConnection=1&targetSchema=public"))).toEqual({
      kind: "ready",
      asked: false,
      ran: 0,
      source: 2,
      targets: [1],
    });
  });

  test("still runs nothing when an old bookmark carries run=1", async () => {
    for (const query of [
      "targetConnection=1&targetSchema=public&run=1",
      // The names these links used before the rename.
      "rightConnection=1&rightSchema=public&run=1",
    ]) {
      expect(picked(await compare(query))).toMatchObject({ asked: false, ran: 0, source: 2 });
    }
  });

  test("keeps the first connection as the source when the target is another one", async () => {
    expect(picked(await compare("targetConnection=3&targetSchema=public"))).toMatchObject({
      source: 1,
      targets: [3],
    });
  });
});

describe("a link that names both sides", () => {
  test("runs when it carries run=1", async () => {
    const screen = await compare(
      "sourceConnection=3&sourceSchema=public&targetConnection=1&targetSchema=public&run=1"
    );
    expect(picked(screen)).toEqual({
      kind: "ready",
      asked: true,
      ran: 1,
      source: 3,
      targets: [1],
    });
  });
});
