// connections-test-saved-route: POST /api/connections/test-saved, the per-row
// "Test" action on the Connections screen.
//
// Every saved connection belongs to one organization. These tests check that
// the route only dials a connection in the caller's organization, and only
// writes the test result back to that same row: another organization's id
// reads as missing, the same 404 a deleted one gets.
//
// The metadata database and the connection test are stand-ins. Nothing is
// dialled.
import { NextRequest } from "next/server";
import { TEST_ORG } from "./helpers/principals";

jest.mock("../lib/auth-guard", () => ({
  requirePermission: async () => ({
    ok: true,
    principal: require("./helpers/principals").principalFor("editor"),
  }),
}));

const OTHER_ORG = TEST_ORG.id + 1;

/** One saved row in the caller's organization and one in another. */
const mockRows = [
  { id: 4, org_id: TEST_ORG.id, type: "PostgreSQL", host: "db.example.test", port: 5432 },
  { id: 9, org_id: OTHER_ORG, type: "PostgreSQL", host: "other.example.test", port: 5432 },
];
const mockPoolQuery = jest.fn(async (text: string, values: unknown[] = []) => {
  // Answers the way the statement's own WHERE clause would, so a statement
  // that left the organization out would find the other organization's row.
  const id = /WHERE id = \$(\d+)/.exec(text);
  const org = /org_id = \$(\d+)/.exec(text);
  const rows = mockRows.filter(
    (row) =>
      (!id || row.id === values[Number(id[1]) - 1]) &&
      (!org || row.org_id === values[Number(org[1]) - 1])
  );
  return { rows, rowCount: rows.length };
});
jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: {
    query: (text: string, values?: unknown[]) => mockPoolQuery(text, values),
  },
  syncMetadataTables: async () => undefined,
}));

const mockRunConnectionTest = jest.fn<Promise<unknown>, unknown[]>(async () => ({
  ok: true as const,
  version: "PostgreSQL 17",
  schemaCount: 1,
  schemas: ["public"],
  latencyMs: 12,
  ssl: false,
  sslMode: "disable" as const,
}));
jest.mock("../lib/connection-config", () => ({
  runConnectionTest: (...args: unknown[]) => mockRunConnectionTest(...args),
}));

import { POST } from "@/app/api/connections/test-saved/route";

async function testSaved(id: number) {
  const request = new NextRequest("http://localhost:3000/api/connections/test-saved", {
    method: "POST",
    body: JSON.stringify({ id }),
    headers: { "Content-Type": "application/json" },
  });
  const response = await POST(request);
  return { status: response.status, body: await response.json() };
}

function statements(pattern: RegExp) {
  return mockPoolQuery.mock.calls.filter(([text]) => pattern.test(text));
}

beforeEach(() => {
  mockPoolQuery.mockClear();
  mockRunConnectionTest.mockClear();
});

test("tests a connection in the caller's organization and records the result on it", async () => {
  const result = await testSaved(4);
  expect(result.status).toBe(200);
  expect(result.body.ok).toBe(true);
  expect(mockRunConnectionTest).toHaveBeenCalledTimes(1);
  expect(statements(/FROM connections/)[0][1]).toEqual([4, TEST_ORG.id]);
  const [update] = statements(/UPDATE connections/);
  expect(update[1]?.slice(-2)).toEqual([4, TEST_ORG.id]);
});

test("answers another organization's connection with not found, dialling nothing", async () => {
  const result = await testSaved(9);
  expect(result.status).toBe(404);
  expect(result.body.error).toBe("Connection not found.");
  expect(mockRunConnectionTest).not.toHaveBeenCalled();
  expect(statements(/UPDATE connections/)).toHaveLength(0);
});
