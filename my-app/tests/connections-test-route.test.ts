// connections-test-route: POST /api/connections/test, the drawer's "Test now".
//
// While the drawer edits a saved connection, a blank password or a blank
// connection string means "keep the saved one". Save (PUT /api/connections)
// keeps them, so Test has to dial with them too, or it tests a different login
// from the one Save stores. These tests check that the route fills them in from
// the saved row the same way, uses the SSL mode on screen, and never lets the
// saved password reach a server the editor chose, a row in another
// organization, or a role that may not edit connections.
//
// The metadata database and the connection test are stand-ins. Nothing is
// dialled.
import { NextRequest } from "next/server";
import { TEST_ORG } from "./helpers/principals";
import { REENTER_CONNECTION_STRING_MESSAGE, REENTER_PASSWORD_MESSAGE } from "@/lib/connection-validate";

/** The permissions the caller's role holds; each test can change them. */
let mockPermissions: string[] = ["connections:create", "connections:update"];
jest.mock("../lib/auth-guard", () => ({
  requirePermission: async () => ({
    ok: true,
    principal: require("./helpers/principals").principalFor("editor", {
      permissions: mockPermissions,
    }),
  }),
}));

const OTHER_ORG = TEST_ORG.id + 1;

// Stand-ins for what the column holds. Built here rather than written out, as
// the repository is public.
const STORED_PASSWORD = ["enc", "v1", "saved", "password"].join(":");
const STORED_URI = ["enc", "v1", "saved", "uri"].join(":");

/** A Fields row and a URI row in the caller's organization, one in another. */
const mockRows = [
  {
    id: 4,
    org_id: TEST_ORG.id,
    host: "db.example.test",
    port: 5432,
    username: "app",
    password: STORED_PASSWORD,
    connection_string: null,
    ssl: true,
    ssl_mode: "require",
  },
  {
    id: 5,
    org_id: TEST_ORG.id,
    host: "hosted.example.test",
    port: 5432,
    username: "app",
    password: "",
    connection_string: STORED_URI,
    ssl: true,
    ssl_mode: "require",
  },
  {
    id: 9,
    org_id: OTHER_ORG,
    host: "other.example.test",
    port: 5432,
    username: "app",
    password: STORED_PASSWORD,
    connection_string: null,
    ssl: true,
    ssl_mode: "require",
  },
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
  ssl: true,
  sslMode: "require" as const,
}));
jest.mock("../lib/connection-config", () => ({
  runConnectionTest: (...args: unknown[]) => mockRunConnectionTest(...args),
}));

import { POST } from "@/app/api/connections/test/route";

/** What the drawer's buildPayload() sends while editing row 4 in Fields mode. */
function fieldsEdit(over: Record<string, unknown> = {}) {
  return {
    type: "PostgreSQL",
    ssl: true,
    ssl_mode: "require",
    environment: "dev",
    application_table: "",
    execute_role: "default",
    connection_string: "",
    clear_connection_string: true,
    host: "db.example.test",
    port: "5432",
    database_name: "shop",
    username: "app",
    password: "",
    id: 4,
    ...over,
  };
}

async function runTest(payload: Record<string, unknown>) {
  const request = new NextRequest("http://localhost:3000/api/connections/test", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" },
  });
  const response = await POST(request);
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) };
}

/** The one input the route handed to runConnectionTest. */
function dialled() {
  expect(mockRunConnectionTest).toHaveBeenCalledTimes(1);
  return mockRunConnectionTest.mock.calls[0][0] as Record<string, unknown>;
}

beforeEach(() => {
  mockPermissions = ["connections:create", "connections:update"];
  mockPoolQuery.mockClear();
  mockRunConnectionTest.mockClear();
});

test("a blank password on an edit tests the saved password, as Save keeps it", async () => {
  const result = await runTest(fieldsEdit());
  expect(result.body.ok).toBe(true);
  const input = dialled();
  expect(input.password).toBe(STORED_PASSWORD);
  expect(input.connectionString).toBe("");
  expect(input.host).toBe("db.example.test");
  // Read from the caller's organization only.
  const [read] = mockPoolQuery.mock.calls.filter(([text]) => /FROM connections/.test(text));
  expect(read[1]).toEqual([4, TEST_ORG.id]);
  // Nothing from the saved row comes back to the browser.
  expect(result.text).not.toContain(STORED_PASSWORD);
});

test("a typed password on an edit is the one tested", async () => {
  const typed = ["new", "password"].join("-");
  await runTest(fieldsEdit({ password: typed }));
  expect(dialled().password).toBe(typed);
});

test("a blank connection string on an edit tests the saved one with the SSL mode on screen", async () => {
  await runTest(
    fieldsEdit({
      id: 5,
      clear_connection_string: false,
      host: "hosted.example.test",
      ssl_mode: "verify-full",
    })
  );
  const input = dialled();
  expect(input.connectionString).toBe(STORED_URI);
  expect(input.sslMode).toBe("verify-full");
});

test("refuses to send a kept connection string over weaker TLS, dialling nothing", async () => {
  // The saved string carries its own password, so turning TLS down would send
  // that password less protected than the user agreed to when saving it.
  const result = await runTest(
    fieldsEdit({ id: 5, clear_connection_string: false, host: "hosted.example.test", ssl: false, ssl_mode: "disable" })
  );
  expect(result.status).toBe(400);
  expect(result.body.error).toBe(REENTER_CONNECTION_STRING_MESSAGE);
  expect(mockRunConnectionTest).not.toHaveBeenCalled();
});

test("Fields mode drops the saved connection string, as Save does", async () => {
  const typed = ["typed", "password"].join("-");
  await runTest(fieldsEdit({ id: 5, host: "hosted.example.test", password: typed }));
  const input = dialled();
  expect(input.connectionString).toBe("");
  expect(input.password).toBe(typed);
});

test("refuses to send the saved password to a different host, dialling nothing", async () => {
  const result = await runTest(fieldsEdit({ host: "attacker.example.test" }));
  expect(result.status).toBe(400);
  expect(result.body).toEqual({
    ok: false,
    error: REENTER_PASSWORD_MESSAGE,
    sslRequired: false,
    detail: "",
  });
  expect(mockRunConnectionTest).not.toHaveBeenCalled();
  expect(result.text).not.toContain(STORED_PASSWORD);
});

test("refuses to send the saved password over weaker TLS", async () => {
  const result = await runTest(fieldsEdit({ ssl: false, ssl_mode: "disable" }));
  expect(result.body.error).toBe(REENTER_PASSWORD_MESSAGE);
  expect(mockRunConnectionTest).not.toHaveBeenCalled();
});

test("answers another organization's connection with not found, dialling nothing", async () => {
  const result = await runTest(fieldsEdit({ id: 9, host: "other.example.test" }));
  expect(result.status).toBe(404);
  expect(result.body.error).toBe("Connection not found.");
  expect(mockRunConnectionTest).not.toHaveBeenCalled();
});

test("a role that may only add connections cannot use a saved one's credentials", async () => {
  mockPermissions = ["connections:create"];
  const result = await runTest(fieldsEdit());
  expect(result.status).toBe(403);
  expect(result.body.ok).toBe(false);
  expect(result.body.error).toMatch(/Your role/);
  expect(mockPoolQuery).not.toHaveBeenCalled();
  expect(mockRunConnectionTest).not.toHaveBeenCalled();
});

test("a new connection is tested as typed, without reading any saved row", async () => {
  // JSON leaves out a key whose value is undefined, so no id is sent.
  await runTest(fieldsEdit({ id: undefined }));
  expect(dialled().password).toBe("");
  expect(mockPoolQuery).not.toHaveBeenCalled();
});
