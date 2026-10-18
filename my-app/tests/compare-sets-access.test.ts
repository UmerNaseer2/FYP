// compare-sets-access: the Compare screen hands out saved comparison sets only
// to a role allowed to open them (POST /api/compare, and runComparison in
// lib/compare-run.ts).
//
// Comparing schemas is Compare: Read. The saved sets that ride along on the
// same screen are Comparison sets: Read. They are two boxes on purpose: an
// admin can let a role compare whatever it picks without showing it the sets
// other people saved. These tests run the real route over the real
// runComparison, with the databases replaced, and check that for a role
// without the box:
//
//   - the sets are not read at all, so none can slip out through the reply;
//   - a ?set= link says the role can't open saved sets, in place of "that
//     saved set no longer exists", since the set may be fine;
//   - the link then runs nothing, the same as a link to a deleted set.
//
// And that a role with the box still gets the sets, and the link opens one.
import { NextRequest } from "next/server";
import type { Gate, Principal } from "@/lib/auth-guard";
import { principalFor } from "./helpers/principals";

let mockGate: Gate;
/** The keys each call to requirePermission asked for, in order. */
let mockAskedFor: string[][] = [];

jest.mock("../lib/auth-guard", () => ({
  requirePermission: async (...keys: string[]) => {
    mockAskedFor.push(keys);
    return mockGate;
  },
}));

// Two saved PostgreSQL connections: the set below compares one with the other.
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

// Reached through mockListSets when called, not when this factory runs,
// because the factory runs before the line that creates it.
const mockListSets = jest.fn();
jest.mock("../lib/comparison-sets", () => ({
  listComparisonSets: (...args: unknown[]) => mockListSets(...args),
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

const mockConnections = [1, 2].map((id) => ({
  id,
  name: id === 1 ? "Dev" : "Staging",
  host: id === 1 ? "localhost" : "staging.example.com",
  port: 5432,
  database_name: "app",
  type: "PostgreSQL",
  username: "u",
  password: "p",
  connection_string: null,
  ssl: false,
  ssl_mode: null,
  environment: id === 1 ? "development" : "staging",
}));

import { POST } from "@/app/api/compare/route";

/** "Nightly": Dev's public schema against Staging's. */
const NIGHTLY = {
  id: 5,
  name: "Nightly",
  sourceConnectionId: 1,
  sourceConnectionLabel: "Dev",
  sourceSchema: "public",
  allowDataLoss: false,
  compareData: false,
  dataTables: [],
  createdAt: "2026-10-17T09:00:00.000Z",
  updatedAt: "2026-10-17T09:00:00.000Z",
  lastRunAt: null,
  targets: [
    {
      position: 0,
      connectionId: 2,
      connectionLabel: "Staging",
      schema: "public",
      environment: "staging",
    },
  ],
};

/** A role an admin might make: compare anything, but no saved sets. */
const COMPARER = principalFor("viewer", {
  role: "comparer",
  roleLabel: "Comparer",
  permissions: ["compare:read"],
});
const MAY_NOT_OPEN_SETS =
  "Your role (Comparer) can't open saved comparison sets. " +
  `Ask an admin to allow "Comparison sets: Read" for this role.`;

type Screen = {
  kind: string;
  sets: { name: string }[];
  activeSetId: number | null;
  setNotFound: boolean;
  setsRefusal: string | null;
  asked: boolean;
};

beforeEach(() => {
  mockAskedFor = [];
  mockListSets.mockReset();
  mockListSets.mockResolvedValue([NIGHTLY]);
});

/** Open the Compare screen with this query string, as this principal. */
async function compareAs(principal: Principal, query: string): Promise<[number, Screen]> {
  mockGate = { ok: true, principal };
  const response = await POST(
    new NextRequest("http://localhost/api/compare", {
      method: "POST",
      body: JSON.stringify({ query }),
      headers: { "content-type": "application/json" },
    })
  );
  return [response.status, await response.json()];
}

/** The parts of the screen that are about saved sets. */
function setsPart(screen: Screen) {
  return {
    kind: screen.kind,
    sets: screen.sets.map((set) => set.name),
    activeSetId: screen.activeSetId,
    setNotFound: screen.setNotFound,
    setsRefusal: screen.setsRefusal,
  };
}

describe("a role that may open saved sets", () => {
  test("gets them on the screen", async () => {
    const [status, screen] = await compareAs(principalFor("viewer"), "");
    expect([status, setsPart(screen)]).toEqual([
      200,
      { kind: "ready", sets: ["Nightly"], activeSetId: null, setNotFound: false, setsRefusal: null },
    ]);
    expect(mockListSets).toHaveBeenCalledTimes(1);
  });

  test("opens one from a ?set= link", async () => {
    const [, screen] = await compareAs(principalFor("viewer"), "set=5");
    expect(setsPart(screen)).toEqual({
      kind: "ready",
      sets: ["Nightly"],
      activeSetId: 5,
      setNotFound: false,
      setsRefusal: null,
    });
  });
});

describe("a role that may compare but not open saved sets", () => {
  test("can still compare, because the gate asks only for Compare: Read", async () => {
    const [status] = await compareAs(COMPARER, "");
    expect([status, mockAskedFor]).toEqual([200, [["compare:read"]]]);
  });

  test("is not given the sets, and they are not even read", async () => {
    const [, screen] = await compareAs(COMPARER, "");
    expect(setsPart(screen)).toEqual({
      kind: "ready",
      sets: [],
      activeSetId: null,
      setNotFound: false,
      setsRefusal: MAY_NOT_OPEN_SETS,
    });
    expect(mockListSets).not.toHaveBeenCalled();
  });

  test("is told why a ?set= link didn't open, and nothing runs in its place", async () => {
    // run=1 is what a saved-set link carries. With the set unread, running
    // would compare the default pickers under a link that promised "Nightly".
    const [, screen] = await compareAs(COMPARER, "set=5&run=1");
    expect([setsPart(screen), screen.asked]).toEqual([
      {
        kind: "ready",
        sets: [],
        activeSetId: null,
        setNotFound: true,
        setsRefusal: MAY_NOT_OPEN_SETS,
      },
      false,
    ]);
    expect(mockListSets).not.toHaveBeenCalled();
  });
});
