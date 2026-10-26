// phone-connections-route: GET /api/connections/phone, the saved connections a
// paired phone may pick from (app/api/connections/phone/route.ts).
//
// The real route runs over a replaced metadata database. These tests check who
// it lets in, that it answers with the four fields a phone shows and never the
// host, the user name or the password, and that a failure repeats nothing the
// database said.
import { NextResponse } from "next/server";
import type { Gate } from "@/lib/auth-guard";
import { principalFor, TEST_ORG } from "./helpers/principals";

let mockGate: Gate;
/** The keys each call to requirePermission asked for, in order. */
let mockAskedFor: string[][] = [];
/** Every query sent to the metadata database, in order. */
let mockQueries: string[] = [];
/** The values sent with each of those queries, in the same order. */
let mockValues: unknown[][] = [];
/** The rows the metadata database answers with. */
let mockRows: unknown[] = [];
/** What the metadata database says when it fails, or null while it works. */
let mockFailure: string | null = null;

jest.mock("../lib/auth-guard", () => ({
  requirePermission: async (...keys: string[]) => {
    mockAskedFor.push(keys);
    return mockGate;
  },
}));

jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: {
    query: async (text: string, values: unknown[] = []) => {
      mockQueries.push(text);
      mockValues.push(values);
      if (mockFailure !== null) throw new Error(mockFailure);
      return { rows: mockRows, rowCount: mockRows.length };
    },
  },
  syncMetadataTables: async () => {},
}));

import { GET } from "@/app/api/connections/phone/route";

const HOST = "dev-db.example.test";
const USER_NAME = "fake-user-name";
// Built when the test runs, so that no line of this public repo looks like a
// password.
const PASSWORD = ["not", "a", "real", "password"].join("-");

/** A whole row, as GET /api/connections would read it, to show what is left out. */
function row(id: unknown, name: string, environment: unknown, databaseName = "app") {
  return {
    id,
    name,
    host: HOST,
    port: 5432,
    database_name: databaseName,
    type: "PostgreSQL",
    username: USER_NAME,
    password: PASSWORD,
    connection_string: `postgres://${USER_NAME}:${PASSWORD}@${HOST}/${databaseName}`,
    ssl: false,
    ssl_mode: null,
    environment,
  };
}

beforeEach(() => {
  mockGate = { ok: true, principal: principalFor("viewer") };
  mockAskedFor = [];
  mockQueries = [];
  mockValues = [];
  mockRows = [];
  mockFailure = null;
});

test("lets in whoever may compare or read a schema", async () => {
  await GET();
  expect(mockAskedFor).toEqual([["compare:read", "visualizer:read"]]);
});

test("answers with the gate's refusal, and reads nothing", async () => {
  mockGate = {
    ok: false,
    response: NextResponse.json({ error: "Sign in first." }, { status: 401 }),
  };
  const response = await GET();
  expect(response.status).toBe(401);
  expect(mockQueries).toEqual([]);
});

test("answers with what Compare's pickers show, never the host, the user name or the password", async () => {
  mockRows = [row(2, "Dev", "dev"), row(1, "Prod", "prod", "shop")];
  const response = await GET();
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toEqual({
    connections: [
      { id: 2, name: "Dev", environment: "dev", database: "app" },
      { id: 1, name: "Prod", environment: "prod", database: "shop" },
    ],
  });
  const text = JSON.stringify(body);
  for (const secret of [HOST, USER_NAME, PASSWORD]) expect(text).not.toContain(secret);
});

test("asks for PostgreSQL connections only, in Compare's order, and none of their sign-in details", async () => {
  await GET();
  expect(mockQueries).toHaveLength(1);
  const [query] = mockQueries;
  expect(query).toMatch(/WHERE type = 'PostgreSQL'/);
  expect(query).toMatch(/ORDER BY name ASC/);
  expect(query).not.toMatch(/host|username|password|connection_string/);
});

test("asks for the caller's organization's connections only", async () => {
  await GET();
  expect(mockQueries[0]).toMatch(/AND org_id = \$1/);
  expect(mockValues[0]).toEqual([TEST_ORG.id]);
});

test("reads each environment the way the app does, and each number as a number", async () => {
  mockRows = [row("7", "A", " Staging "), row(8, "B", null), row(9, "C", "qa")];
  const body = await (await GET()).json();
  expect(body.connections).toEqual([
    { id: 7, name: "A", environment: "staging", database: "app" },
    { id: 8, name: "B", environment: "unset", database: "app" },
    { id: 9, name: "C", environment: "unset", database: "app" },
  ]);
});

test("says the list could not be read, without repeating what the database said", async () => {
  mockFailure = `password authentication failed for user "${USER_NAME}" at ${HOST}`;
  const logged = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    const response = await GET();
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toMatch(/^Could not read the saved connections\./);
    const text = JSON.stringify(body);
    for (const secret of [HOST, USER_NAME]) expect(text).not.toContain(secret);
    // The details stay in the computer's own log.
    expect(logged).toHaveBeenCalled();
  } finally {
    logged.mockRestore();
  }
});
