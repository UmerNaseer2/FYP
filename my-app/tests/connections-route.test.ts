// Editing a saved connection must not send its saved password somewhere new.
//
// On edit a blank password means "keep the saved one". Before this rule an
// editor could change the host to a server they run, leave the password blank,
// press Test, and receive a password nobody ever showed them. The PUT route now
// refuses that edit and asks for the password again; edits that keep the
// password going to the same place still save.
//
// The metadata database and the auth gate are stand-ins. Nothing is dialled.
import { NextRequest } from "next/server";
import {
  REENTER_PASSWORD_MESSAGE,
  savedPasswordWouldMove,
  type PasswordDestination,
} from "@/lib/connection-validate";
import { TEST_ORG } from "./helpers/principals";

jest.mock("../lib/auth-guard", () => ({
  requirePermission: async () => ({
    ok: true,
    principal: require("./helpers/principals").principalFor("editor"),
  }),
}));

type SavedRow = {
  password: string | null;
  connection_string: string | null;
  host: string;
  port: number;
  database_name: string;
  username: string;
  ssl: boolean | null;
  ssl_mode: string | null;
};

let mockSaved: SavedRow;
const mockPoolQuery = jest.fn<Promise<unknown>, [string, unknown[]?]>();
jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: { query: (text: string, values?: unknown[]) => mockPoolQuery(text, values) },
  syncMetadataTables: async () => undefined,
}));
const mockDependents = jest.fn<Promise<unknown>, unknown[]>(async () => ({
  trackedSchemas: 0,
  schemaNames: [],
  snapshots: 0,
  comparisonSets: 0,
  comparisonSetNames: [],
}));
jest.mock("../lib/lineage-db", () => ({
  getConnectionDependents: (...args: unknown[]) => mockDependents(...args),
}));
// Encryption is not what these tests are about; a typed value is stored as typed.
// decryptSecret has to undo that prefix rather than be left out: the host check
// resolves a stored connection string before it judges it, and a stand-in that
// returned undefined would make every string unreadable — which the check
// answers with "nothing to judge", waving the blocked hosts below straight past.
jest.mock("../lib/secret-store", () => ({
  encryptSecret: (value: string | null | undefined) => (value ? `enc:${value}` : null),
  decryptSecret: (value: string | null | undefined) =>
    typeof value === "string" ? value.replace(/^enc:/, "") : (value ?? null),
}));

import { DELETE, GET, POST, PUT } from "@/app/api/connections/route";

const SAVED: SavedRow = {
  password: "enc:v1:the-saved-ciphertext",
  connection_string: null,
  host: "db.internal.example.com",
  port: 5432,
  database_name: "app",
  username: "app_owner",
  ssl: true,
  ssl_mode: "verify-full",
};

/** The edit form as the drawer sends it: the saved fields, with a blank password. */
const EDIT = {
  id: 4,
  name: "Production",
  type: "PostgreSQL",
  host: SAVED.host,
  port: SAVED.port,
  database_name: SAVED.database_name,
  username: SAVED.username,
  password: "",
  connection_string: "",
  ssl_mode: "verify-full",
  environment: "prod",
};

function setUp(saved: SavedRow = SAVED) {
  mockSaved = saved;
  mockPoolQuery.mockReset();
  mockPoolQuery.mockImplementation(async (text: string) => {
    if (/SELECT password, connection_string/.test(text)) return { rows: [mockSaved] };
    if (/RETURNING/.test(text)) return { rows: [{ id: 4, name: "Production" }] };
    return { rows: [] };
  });
}

async function send(method: "POST" | "PUT", body: Record<string, unknown>) {
  const request = new NextRequest("http://localhost:3000/api/connections", {
    method,
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  const response = await (method === "POST" ? POST(request) : PUT(request));
  return { status: response.status, body: await response.json() };
}

const put = (body: Record<string, unknown>) => send("PUT", body);
const post = (body: Record<string, unknown>) => send("POST", body);

/** Whether the route got as far as writing the row — both writes say RETURNING. */
function updated(): boolean {
  return mockPoolQuery.mock.calls.some(([text]) => /RETURNING/.test(text));
}

describe("PUT /api/connections — a kept password stays where it was", () => {
  it("refuses a new host with a blank password, and says why on the password field", async () => {
    setUp();
    const result = await put({ ...EDIT, host: "attacker.example.net" });
    expect(result.status).toBe(400);
    expect(result.body.error).toBe(REENTER_PASSWORD_MESSAGE);
    expect(result.body.errors.password).toBe(REENTER_PASSWORD_MESSAGE);
    expect(updated()).toBe(false);
  });

  it("refuses a new port, a new user, or weaker TLS with a blank password", async () => {
    for (const change of [{ port: 6543 }, { username: "postgres" }, { ssl_mode: "disable" }]) {
      setUp();
      const result = await put({ ...EDIT, ...change });
      expect(result.status).toBe(400);
      expect(updated()).toBe(false);
    }
  });

  it("saves a new host when the password is typed again", async () => {
    setUp();
    const result = await put({ ...EDIT, host: "db2.internal.example.com", password: "typed-again" });
    expect(result.status).toBe(200);
    expect(updated()).toBe(true);
  });

  it("saves edits that send the saved password to the same place", async () => {
    // Renaming, relabelling, another database on the same server, stronger TLS.
    for (const change of [
      { name: "Production (EU)" },
      { environment: "staging" },
      { database_name: "reporting" },
      { host: "DB.INTERNAL.EXAMPLE.COM" },
    ]) {
      setUp({ ...SAVED, ssl_mode: "require" });
      const result = await put({ ...EDIT, ssl_mode: "require", ...change });
      expect(result.status).toBe(200);
    }
    setUp({ ...SAVED, ssl_mode: "require" });
    expect((await put({ ...EDIT, ssl_mode: "verify-full" })).status).toBe(200);
  });

  it("leaves the check to the connection string when one is kept", async () => {
    // The saved string decides where the app connects and carries its own
    // password, so edited loose fields send nothing anywhere new.
    setUp({ ...SAVED, password: null, connection_string: "enc:v1:saved-uri" });
    const result = await put({ ...EDIT, host: "somewhere-else.example.com" });
    expect(result.status).toBe(200);
  });

  it("reads a legacy row's TLS setting from the old boolean", async () => {
    // ssl_mode is NULL on rows written before it existed; ssl=true meant "require".
    setUp({ ...SAVED, ssl_mode: null, ssl: true });
    expect((await put({ ...EDIT, ssl_mode: "require" })).status).toBe(200);
    setUp({ ...SAVED, ssl_mode: null, ssl: true });
    expect((await put({ ...EDIT, ssl_mode: "disable" })).status).toBe(400);
  });
});

describe("savedPasswordWouldMove", () => {
  const here: PasswordDestination = {
    host: "db.example.com",
    port: 5432,
    username: "app",
    sslMode: "require",
  };

  it("is false for the same destination, whatever the case or spacing of the host", () => {
    expect(savedPasswordWouldMove(here, { ...here })).toBe(false);
    expect(savedPasswordWouldMove(here, { ...here, host: " DB.example.com " })).toBe(false);
  });

  it("is true for another host, port or user", () => {
    expect(savedPasswordWouldMove(here, { ...here, host: "evil.example.com" })).toBe(true);
    expect(savedPasswordWouldMove(here, { ...here, port: 5433 })).toBe(true);
    expect(savedPasswordWouldMove(here, { ...here, username: "admin" })).toBe(true);
  });

  it("is true only when TLS gets weaker", () => {
    expect(savedPasswordWouldMove(here, { ...here, sslMode: "disable" })).toBe(true);
    expect(savedPasswordWouldMove(here, { ...here, sslMode: "verify-full" })).toBe(false);
  });
});

/**
 * Saving a connection that dials somewhere this server refuses to go.
 *
 * The SSRF rule used to run on "Test connection" only, and on the hostname
 * written in the URL. A connection string can put a different host behind that
 * hostname — pg-connection-string lets "?host=" win — and Compare, Deploy and
 * Drift never press Test. Both routes now judge the host the driver resolves.
 */
describe("saving a connection that would dial a blocked host", () => {
  // The URL reads as a database on the internet. pg dials the cloud metadata
  // service, which is where a cloud server keeps its own credentials.
  const BLOCKED_URI = "postgres://app:pw@db.example.com/app?host=169.254.169.254";
  const BLOCKED = "That host isn't allowed.";

  const NEW_CONNECTION = {
    name: "Reporting",
    type: "PostgreSQL",
    ssl_mode: "require",
    environment: "dev",
  };

  it("refuses it on create, and writes nothing", async () => {
    setUp();
    const result = await post({ ...NEW_CONNECTION, connection_string: BLOCKED_URI });
    expect(result.status).toBe(400);
    expect(result.body.error).toBe(BLOCKED);
    expect(updated()).toBe(false);
  });

  it("still saves an ordinary connection string", async () => {
    setUp();
    const result = await post({
      ...NEW_CONNECTION,
      connection_string: "postgres://app:pw@db.example.com:5432/app",
    });
    expect(result.status).toBe(200);
    expect(updated()).toBe(true);
  });

  it("refuses it on edit", async () => {
    setUp();
    const result = await put({ ...EDIT, connection_string: BLOCKED_URI, password: "typed-again" });
    expect(result.status).toBe(400);
    expect(result.body.error).toBe(BLOCKED);
    expect(updated()).toBe(false);
  });

  it("refuses an edit that keeps a saved string pointing there", async () => {
    // A blank connection string means "keep the saved one", so the host this
    // row would dial after the save is not in the request at all. A row written
    // before this rule existed is exactly the case that matters.
    setUp({ ...SAVED, password: null, connection_string: `enc:${BLOCKED_URI}` });
    const result = await put({ ...EDIT, name: "Renamed" });
    expect(result.status).toBe(400);
    expect(updated()).toBe(false);
  });

  it("lets that row be repaired by switching back to fields", async () => {
    // Refusing every edit would strand the row. Clearing the string (what the
    // drawer sends when you switch to Fields mode) drops the blocked host, and
    // the loose fields are judged instead.
    setUp({ ...SAVED, password: null, connection_string: `enc:${BLOCKED_URI}` });
    const result = await put({
      ...EDIT,
      clear_connection_string: true,
      password: "typed-again",
    });
    expect(result.status).toBe(200);
    expect(updated()).toBe(true);
  });
});

/**
 * Every saved connection belongs to one organization. The route names the
 * caller's organization next to the id in every statement, so another
 * organization's connection reads as missing (the same 404 a deleted one
 * gets), and a new connection lands in the caller's organization whatever the
 * body says.
 */
describe("connections inside the caller's organization", () => {
  const OTHER_ORG = TEST_ORG.id + 1;
  const ROWS = [
    { ...SAVED, id: 4, org_id: TEST_ORG.id, name: "Production" },
    { ...SAVED, id: 9, org_id: OTHER_ORG, name: "Someone else's" },
  ];

  /**
   * Answers the way the statement's own WHERE clause would. A statement that
   * left the organization out would find the other organization's row here,
   * which is the mistake these tests exist to catch.
   */
  function matching(text: string, values: unknown[]) {
    const id = /WHERE id = \$(\d+)/.exec(text);
    const org = /org_id = \$(\d+)/.exec(text);
    return ROWS.filter(
      (row) =>
        (!id || row.id === values[Number(id[1]) - 1]) &&
        (!org || row.org_id === values[Number(org[1]) - 1])
    );
  }

  function setUpTwoOrgs() {
    mockDependents.mockClear();
    mockPoolQuery.mockReset();
    mockPoolQuery.mockImplementation(async (text: string, values: unknown[] = []) => {
      if (/^\s*INSERT/.test(text)) return { rows: [{ id: 10, name: "Reporting" }] };
      const rows = matching(text, values);
      return { rows, rowCount: rows.length };
    });
  }

  function statements(pattern: RegExp) {
    return mockPoolQuery.mock.calls.filter(([text]) => pattern.test(text));
  }

  async function remove(body: Record<string, unknown>) {
    const request = new NextRequest("http://localhost:3000/api/connections", {
      method: "DELETE",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    const response = await DELETE(request);
    return { status: response.status, body: await response.json() };
  }

  it("lists only the caller's organization's connections", async () => {
    setUpTwoOrgs();
    const response = await GET();
    expect(response.status).toBe(200);
    const body = (await response.json()) as Array<{ id: number }>;
    expect(body.map((row) => row.id)).toEqual([4]);
    expect(statements(/FROM connections/)[0][1]).toEqual([TEST_ORG.id]);
  });

  it("saves a new connection into the caller's organization, not one the body names", async () => {
    setUpTwoOrgs();
    const result = await post({
      name: "Reporting",
      type: "PostgreSQL",
      ssl_mode: "require",
      environment: "dev",
      connection_string: "postgres://app:pw@db.example.com:5432/app",
      org_id: OTHER_ORG,
    });
    expect(result.status).toBe(200);
    const [insert] = statements(/INSERT INTO connections/);
    expect(insert[0]).toMatch(/execute_role, org_id\)/);
    expect(insert[1]?.[13]).toBe(TEST_ORG.id);
    expect(insert[1]).not.toContain(OTHER_ORG);
  });

  it("answers an edit of another organization's connection with not found", async () => {
    setUpTwoOrgs();
    const result = await put({ ...EDIT, id: 9, port: 6543, password: "typed-again" });
    expect(result.status).toBe(404);
    expect(result.body.error).toBe("Connection not found.");
    expect(statements(/UPDATE connections/)).toHaveLength(0);
  });

  it("edits the caller's own connection, naming the organization in both updates", async () => {
    setUpTwoOrgs();
    // A new port clears the last test result first, so both UPDATEs run.
    const result = await put({ ...EDIT, id: 4, port: 6543, password: "typed-again" });
    expect(result.status).toBe(200);
    const updates = statements(/UPDATE connections/);
    expect(updates).toHaveLength(2);
    expect(updates[0][1]).toEqual([4, TEST_ORG.id]);
    expect(updates[1][1]?.slice(-2)).toEqual([4, TEST_ORG.id]);
  });

  it("answers a delete of another organization's connection with not found", async () => {
    setUpTwoOrgs();
    const result = await remove({ id: 9, confirm: true });
    expect(result.status).toBe(404);
    expect(result.body.error).toBe("Connection not found.");
    expect(statements(/DELETE FROM connections/)).toHaveLength(0);
    expect(mockDependents).not.toHaveBeenCalled();
  });

  it("deletes the caller's own connection, counting dependents in its organization", async () => {
    setUpTwoOrgs();
    const result = await remove({ id: 4 });
    expect(result.status).toBe(200);
    expect(mockDependents).toHaveBeenCalledWith(TEST_ORG.id, 4);
    expect(statements(/DELETE FROM connections/)[0][1]).toEqual([4, TEST_ORG.id]);
  });
});
