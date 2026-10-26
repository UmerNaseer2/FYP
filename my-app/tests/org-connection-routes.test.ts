// org-connection-routes: every route that takes a saved connection's id keeps
// to the caller's organization.
//
// A connection id is a plain number in a query string or a body, and ids are
// shared by every organization, so anybody can send one that belongs to
// somebody else. Each of these routes looks the connection up with the
// caller's organization in the WHERE clause, and another organization's
// connection reads as missing: the same 404 a deleted one gets, so a stranger
// cannot even learn which ids exist. Before the answer, nothing about the
// other connection is read: its saved password is never decrypted, and its
// database is never dialled.
//
// The app's own database is a stand-in that answers the way each statement's
// WHERE clause would, with one connection in the caller's organization and
// one in another. A statement that left the organization out would find the
// other organization's row, and the route would go on to use it. Every case
// also asks for the caller's own connection first, so a 404 below cannot be
// the stand-in failing to find anything at all.
//
// Nothing here reaches a real database or the network: the pg driver refuses
// to be constructed, and fetch refuses every request.
import { NextRequest } from "next/server";
import { TEST_ORG } from "./helpers/principals";
import { guardGitHub, type GitHubGuard } from "./helpers/no-github";

jest.mock("../lib/auth-guard", () => ({
  requirePermission: async () => ({
    ok: true,
    principal: require("./helpers/principals").principalFor("admin"),
  }),
}));

const OTHER_ORG = TEST_ORG.id + 1;
/** Connection ids that are not org ids, so a value bound in the wrong place shows. */
const OURS = 21;
const THEIRS = 22;

/** A saved connection row, as the routes select it. */
function connection(id: number, orgId: number, name: string, host: string) {
  return {
    id,
    org_id: orgId,
    name,
    type: "PostgreSQL",
    host,
    port: 5432,
    database_name: "app",
    username: "app",
    password: null,
    connection_string: null,
    ssl: false,
    ssl_mode: "disable",
    environment: "dev",
    application_table: null,
  };
}

const mockTables: Record<string, Array<Record<string, unknown>>> = {
  connections: [
    connection(OURS, TEST_ORG.id, "Orders (ours)", "ours.example.test"),
    connection(THEIRS, OTHER_ORG, "Ledger (theirs)", "theirs.example.test"),
  ],
  deploy_attempts: [
    {
      id: 1,
      org_id: TEST_ORG.id,
      connection_id: OURS,
      schema_name: "sales",
      scripts: [],
      outcome: "applied",
      dry_run: false,
      http_status: 200,
      detail: null,
      actor: "ours@test",
      created_at: "2026-10-01T00:00:00.000Z",
    },
    {
      id: 2,
      org_id: OTHER_ORG,
      connection_id: THEIRS,
      schema_name: "sales",
      scripts: [],
      outcome: "failed",
      dry_run: false,
      http_status: 500,
      detail: "theirs failed",
      actor: "theirs@test",
      created_at: "2026-10-02T00:00:00.000Z",
    },
  ],
};

/** Every statement sent to the app's own database, in order. */
const mockStatements: Array<{ text: string; values: unknown[] }> = [];

/**
 * Answers a SELECT the way its WHERE clause would: rows of the table it reads
 * from, kept only where each `column = $n` it names for id, connection_id,
 * schema_name or org_id holds. A table it does not know reads as empty, and
 * anything else (an INSERT, an UPDATE) changes nothing.
 */
function mockAnswer(text: string, values: unknown[]) {
  mockStatements.push({ text, values });
  const from = /\bFROM\s+(\w+)/.exec(text);
  if (!/^\s*SELECT\b/.test(text) || !from) return { rows: [], rowCount: 0 };
  const conditions = Array.from(
    text.matchAll(/\b(id|connection_id|schema_name|org_id) = \$(\d+)/g),
    (match) => ({ column: match[1], value: values[Number(match[2]) - 1] })
  );
  const rows = (mockTables[from[1]] ?? []).filter((row) =>
    conditions.every(({ column, value }) => row[column] === value)
  );
  return { rows, rowCount: rows.length };
}

jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: {
    query: async (text: string, values: unknown[] = []) => mockAnswer(text, values),
    connect: async () => ({
      query: async (text: string, values: unknown[] = []) => mockAnswer(text, values),
      release: () => undefined,
    }),
  },
  syncMetadataTables: async () => undefined,
}));

/** Every attempt to open a target database, which these routes do with pg. */
const mockTargetOpened = jest.fn();
jest.mock("pg", () => {
  const actual = jest.requireActual("pg");
  function refusing(kind: string) {
    return class {
      constructor(config: unknown) {
        mockTargetOpened(kind, config);
        throw new Error("Tests never open a target database.");
      }
    };
  }
  return { ...actual, Pool: refusing("Pool"), Client: refusing("Client") };
});

/**
 * Every saved connection whose credentials a route read. buildPgConfig is
 * where a saved password is decrypted, so a route that called it for another
 * organization's connection has already read something it should not have.
 */
const mockBuildPgConfig = jest.fn();
jest.mock("../lib/connection-config", () => {
  const actual = jest.requireActual("../lib/connection-config");
  return {
    ...actual,
    buildPgConfig: (...args: unknown[]) => {
      mockBuildPgConfig(...args);
      return actual.buildPgConfig(...args);
    },
  };
});

import { GET as versionHistory } from "@/app/api/compare/version-history/route";
import { GET as phoneConnections } from "@/app/api/connections/phone/route";
import { GET as lineageSchemas } from "@/app/api/lineage/schemas/route";
import { POST as trackSchema } from "@/app/api/lineage/track/route";
import { GET as activity } from "@/app/api/performance/activity/route";
import { GET as advice } from "@/app/api/performance/advice/route";
import { POST as analyze } from "@/app/api/performance/analyze/route";
import { GET as queryHistory } from "@/app/api/performance/history/route";
import { GET as metrics } from "@/app/api/performance/metrics/route";
import {
  GET as readThresholds,
  PUT as saveThresholds,
} from "@/app/api/performance/thresholds/route";
import { GET as snapshot } from "@/app/api/schema/snapshot/route";
import { GET as deployAttempts } from "@/app/api/scripts/attempts/route";
import { POST as preflight } from "@/app/api/scripts/preflight/route";
import { GET as targetSchemas } from "@/app/api/scripts/schemas/route";
import { GET as ledger } from "@/app/api/versionsync/ledger/route";

const BASE = "http://localhost:3000";

function get(path: string, query: Record<string, string | number>) {
  const params = new URLSearchParams(
    Object.entries(query).map(([key, value]) => [key, String(value)])
  );
  return new NextRequest(`${BASE}${path}?${params}`);
}

function send(path: string, method: string, body: unknown) {
  return new NextRequest(`${BASE}${path}`, {
    method,
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

type Answer = { status: number; text: string };

/**
 * Calls a route and reads its answer. A route that throws is an answer too
 * (Next.js would send a 500), so it is caught rather than failing the test
 * before the checks below have looked at what the route did.
 */
async function answer(response: Promise<Response>): Promise<Answer> {
  try {
    const settled = await response;
    return { status: settled.status, text: await settled.text() };
  } catch (error) {
    return { status: 500, text: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The routes that look a connection up by an id the caller sends.
 *
 * `opensTarget` routes go on to read the connection's credentials and dial it,
 * so for the caller's own connection they get as far as buildPgConfig (and the
 * dial then fails, on purpose). The others only read the app's own database,
 * and answer 200 with the connection's name in it.
 */
const ROUTES: Array<{
  name: string;
  call: (connectionId: number) => Promise<Response>;
  opensTarget: boolean;
}> = [
  {
    name: "GET /api/compare/version-history",
    call: (id) =>
      versionHistory(get("/api/compare/version-history", { connectionId: id, schema: "public" })),
    opensTarget: true,
  },
  {
    name: "GET /api/lineage/schemas",
    call: (id) => lineageSchemas(get("/api/lineage/schemas", { connectionId: id })),
    opensTarget: true,
  },
  {
    name: "POST /api/lineage/track",
    call: (id) =>
      trackSchema(send("/api/lineage/track", "POST", { connectionId: id, schemaName: "public" })),
    opensTarget: true,
  },
  {
    name: "GET /api/performance/activity",
    call: (id) =>
      activity(get("/api/performance/activity", { connectionId: id, schema: "public" })),
    opensTarget: true,
  },
  {
    name: "GET /api/performance/advice",
    call: (id) => advice(get("/api/performance/advice", { connectionId: id, schema: "public" })),
    opensTarget: true,
  },
  {
    name: "POST /api/performance/analyze",
    call: (id) =>
      analyze(
        send("/api/performance/analyze", "POST", {
          connectionId: id,
          schema: "public",
          sql: "SELECT 1",
          measure: false,
        })
      ),
    opensTarget: true,
  },
  {
    name: "GET /api/performance/metrics",
    call: (id) => metrics(get("/api/performance/metrics", { connectionId: id, schema: "public" })),
    opensTarget: false,
  },
  {
    name: "GET /api/performance/thresholds",
    call: (id) =>
      readThresholds(get("/api/performance/thresholds", { connectionId: id, schema: "public" })),
    opensTarget: false,
  },
  {
    name: "PUT /api/performance/thresholds",
    call: (id) =>
      saveThresholds(
        send("/api/performance/thresholds", "PUT", {
          connectionId: id,
          schema: "public",
          settings: [],
        })
      ),
    opensTarget: false,
  },
  {
    name: "GET /api/schema/snapshot",
    call: (id) => snapshot(get("/api/schema/snapshot", { connectionId: id, schema: "public" })),
    opensTarget: true,
  },
  {
    name: "POST /api/scripts/preflight",
    call: (id) =>
      preflight(send("/api/scripts/preflight", "POST", { connectionId: id, schemaName: "public" })),
    opensTarget: true,
  },
  {
    name: "GET /api/scripts/schemas",
    call: (id) => targetSchemas(get("/api/scripts/schemas", { connectionId: id })),
    opensTarget: true,
  },
  {
    name: "GET /api/versionsync/ledger",
    call: (id) => ledger(get("/api/versionsync/ledger", { connectionId: id, schema: "public" })),
    opensTarget: true,
  },
];

/**
 * Every statement that reads the connections table names org_id and binds the
 * caller's organization there. Checked on what was sent, so a route that also
 * filtered in JavaScript afterwards could not pass by luck.
 */
function expectConnectionLookupsInCallersOrg() {
  const lookups = mockStatements.filter(({ text }) => /\bFROM\s+connections\b/.test(text));
  expect(lookups.length).toBeGreaterThan(0);
  for (const { text, values } of lookups) {
    const org = /\borg_id = \$(\d+)/.exec(text);
    expect(org).not.toBeNull();
    expect(values[Number(org![1]) - 1]).toBe(TEST_ORG.id);
  }
}

/** Nothing about the other organization's connection reached the answer. */
function expectNothingOfTheirs(result: Answer) {
  expect(result.text).not.toContain("Ledger (theirs)");
  expect(result.text).not.toContain("theirs.example.test");
}

let github: GitHubGuard;

beforeEach(() => {
  mockStatements.length = 0;
  mockTargetOpened.mockClear();
  mockBuildPgConfig.mockClear();
  github = guardGitHub();
  // The dials that fail on purpose are logged by the routes; that is expected.
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  github.restore();
  jest.restoreAllMocks();
});

describe.each(ROUTES)("$name", ({ call, opensTarget }) => {
  it("finds the caller's own connection", async () => {
    const result = await answer(call(OURS));
    expect(result.status).not.toBe(404);
    if (opensTarget) {
      expect(mockBuildPgConfig).toHaveBeenCalled();
      expect(mockBuildPgConfig.mock.calls[0][0]).toMatchObject({ host: "ours.example.test" });
    } else {
      expect(result.status).toBe(200);
      expect(result.text).toContain("Orders (ours)");
    }
    expectConnectionLookupsInCallersOrg();
  });

  it("answers another organization's connection as missing, reading nothing about it", async () => {
    const result = await answer(call(THEIRS));
    expect(result.status).toBe(404);
    expectNothingOfTheirs(result);
    expect(mockBuildPgConfig).not.toHaveBeenCalled();
    expect(mockTargetOpened).not.toHaveBeenCalled();
    expect(github.unexpected).toEqual([]);
    expectConnectionLookupsInCallersOrg();
  });
});

describe("GET /api/performance/history", () => {
  // History outlives its connection on purpose (query_history.connection_id
  // has no foreign key), so a missing connection is not a 404 here: the route
  // names it "(deleted connection)" and shows whatever history is left. For
  // another organization's connection that is nothing, because every history
  // read is filtered on the caller's organization too.
  const read = (id: number) =>
    answer(queryHistory(get("/api/performance/history", { connectionId: id, schema: "public" })));

  it("names the caller's own connection", async () => {
    const result = await read(OURS);
    expect(result.status).toBe(200);
    expect(result.text).toContain("Orders (ours)");
    expectConnectionLookupsInCallersOrg();
  });

  it("reads another organization's connection as deleted, with no history", async () => {
    const result = await read(THEIRS);
    expect(result.status).toBe(200);
    expect(result.text).toContain("(deleted connection)");
    expectNothingOfTheirs(result);
    expectConnectionLookupsInCallersOrg();
    const historyReads = mockStatements.filter(({ text }) => /\bFROM\s+query_history\b/.test(text));
    expect(historyReads.length).toBeGreaterThan(0);
    for (const { text, values } of historyReads) {
      const org = /\borg_id = \$(\d+)/.exec(text);
      expect(org).not.toBeNull();
      expect(values[Number(org![1]) - 1]).toBe(TEST_ORG.id);
    }
  });
});

describe("GET /api/connections/phone", () => {
  it("lists only the caller's organization's connections", async () => {
    const result = await answer(phoneConnections());
    expect(result.status).toBe(200);
    const body = JSON.parse(result.text) as { connections: Array<{ id: number; name: string }> };
    expect(body.connections.map((row) => row.id)).toEqual([OURS]);
    expectNothingOfTheirs(result);
    expectConnectionLookupsInCallersOrg();
  });
});

describe("GET /api/scripts/attempts", () => {
  // The deploy audit trail. It never opens the target, so another
  // organization's connection id is not refused: it finds the same empty
  // trail an id nobody ever deployed to finds.
  const read = (id: number) =>
    answer(deployAttempts(get("/api/scripts/attempts", { connectionId: id, schema: "sales" })));

  it("shows the caller's own attempts", async () => {
    const result = await read(OURS);
    expect(result.status).toBe(200);
    const body = JSON.parse(result.text) as { attempts: Array<{ id: number }> };
    expect(body.attempts.map((row) => row.id)).toEqual([1]);
  });

  it("shows nothing of another organization's attempts", async () => {
    const result = await read(THEIRS);
    expect(result.status).toBe(200);
    const body = JSON.parse(result.text) as { attempts: unknown[] };
    expect(body.attempts).toEqual([]);
    expect(result.text).not.toContain("theirs");
    const [lookup] = mockStatements.filter(({ text }) => /\bFROM\s+deploy_attempts\b/.test(text));
    const org = /\borg_id = \$(\d+)/.exec(lookup.text);
    expect(org).not.toBeNull();
    expect(lookup.values[Number(org![1]) - 1]).toBe(TEST_ORG.id);
  });
});
