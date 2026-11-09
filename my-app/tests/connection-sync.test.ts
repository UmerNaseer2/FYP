// Two-way sync of connections between a website and its linked desktops
// (docs/two-way-sync-plan.md, step 1), the website's half.
//
// A save says which version it started from; one that started from an old copy
// is turned down with the current row, so nobody overwrites a change they never
// saw. A desktop reads its organization's connections through a fingerprint,
// and saves through the link as its person, under that person's website role.
//
// The metadata database, the gate and the database test are stand-ins. Nothing
// is dialled, and the values below are made up.
import { NextRequest, NextResponse } from "next/server";
import type { Principal } from "@/lib/auth-guard";

let mockRole: "viewer" | "editor" | "admin" = "editor";
let mockAgentPrincipal: Principal | null = null;
jest.mock("../lib/auth-guard", () => ({
  requirePermission: async () => ({
    ok: true,
    principal: require("./helpers/principals").principalFor(mockRole),
  }),
  agentPrincipal: async () => mockAgentPrincipal,
}));

let mockLinked = true;
jest.mock("../lib/agent-auth", () => ({
  requireAgent: async () =>
    mockLinked
      ? { ok: true, agent: { id: 41, orgId: 7, profileId: 22 } }
      : {
          ok: false,
          response: require("next/server").NextResponse.json({ error: "Not linked." }, { status: 401 }),
        },
}));

const mockPoolQuery = jest.fn<Promise<unknown>, [string, unknown[]?]>();
jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: { query: (text: string, values?: unknown[]) => mockPoolQuery(text, values) },
  syncMetadataTables: async () => undefined,
}));
jest.mock("../lib/lineage-db", () => ({
  getConnectionDependents: async () => ({
    trackedSchemas: 0,
    schemaNames: [],
    snapshots: 0,
    comparisonSets: 0,
    comparisonSetNames: [],
  }),
}));
jest.mock("../lib/secret-store", () => ({
  encryptSecret: (value: string | null | undefined) => (value ? `enc:${value}` : null),
  decryptSecret: (value: string | null | undefined) =>
    typeof value === "string" ? value.replace(/^enc:/, "") : (value ?? null),
}));
const mockTest = jest.fn();
jest.mock("../lib/connection-config", () => ({
  ...jest.requireActual("../lib/connection-config"),
  runConnectionTest: (...args: unknown[]) => mockTest(...args),
}));

import { DELETE, PUT } from "@/app/api/connections/route";
import { GET as readSyncRoute } from "@/app/api/agent/sync/route";
import { POST as addThroughLink, PUT as editThroughLink } from "@/app/api/agent/sync/connections/route";
import { readRev, revOf } from "@/lib/agent-sync";
import { SITE_OWNED_MESSAGE } from "@/lib/connection-writes";
import { principalFor, TEST_ORG } from "./helpers/principals";

const SAVED = {
  password: "enc:made-up-saved-password",
  connection_string: null,
  host: "db.example.com",
  port: 5432,
  database_name: "app",
  username: "app_owner",
  ssl: true,
  ssl_mode: "verify-full",
  name: "Book shop",
  environment: "dev",
  version: 3,
  site_id: null as number | null,
};

/** The current row a conflict answer carries back. */
const CURRENT = { id: 4, name: "Book shop", version: 3, updated_by: "Sam Lee" };

const EDIT = {
  id: 4,
  name: "Book shop",
  type: "PostgreSQL",
  host: SAVED.host,
  port: SAVED.port,
  database_name: SAVED.database_name,
  username: SAVED.username,
  password: "",
  connection_string: "",
  ssl_mode: "verify-full",
  environment: "dev",
};

function setUp(over: Partial<typeof SAVED> = {}, writeHits = true) {
  const saved = { ...SAVED, ...over };
  mockPoolQuery.mockReset();
  mockPoolQuery.mockImplementation(async (text: string) => {
    if (/SELECT password, connection_string/.test(text)) return { rows: [saved] };
    if (/SELECT name, environment, version, site_id/.test(text)) return { rows: [saved] };
    if (/^\s*UPDATE connections/.test(text) && /RETURNING/.test(text)) {
      return { rows: writeHits ? [{ ...CURRENT, version: saved.version + 1 }] : [] };
    }
    if (/INSERT INTO connections/.test(text)) return { rows: [{ id: 9, name: "New", version: 1 }] };
    if (/DELETE FROM connections/.test(text)) return { rows: [], rowCount: writeHits ? 1 : 0 };
    if (/SELECT id, name, host/.test(text)) return { rows: [CURRENT] };
    return { rows: [], rowCount: 1 };
  });
}

const ran = (pattern: RegExp) => mockPoolQuery.mock.calls.filter(([text]) => pattern.test(text));

function request(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "Content-Type": "application/json", authorization: "Bearer ssa_made-up" },
  });
}

async function answer(response: NextResponse | Response) {
  return { status: response.status, body: await response.json() };
}

let errorLog: jest.SpyInstance;
beforeEach(() => {
  mockRole = "editor";
  mockLinked = true;
  mockAgentPrincipal = principalFor("editor");
  mockTest.mockReset();
  errorLog = jest.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => errorLog.mockRestore());

describe("saving from an old copy", () => {
  const put = async (body: Record<string, unknown>) =>
    answer(await PUT(request("http://localhost:3000/api/connections", "PUT", body)));
  const remove = async (body: Record<string, unknown>) =>
    answer(await DELETE(request("http://localhost:3000/api/connections", "DELETE", body)));

  it("turns down an edit that started from an older version, naming who saved, and writes nothing", async () => {
    setUp();
    const result = await put({ ...EDIT, base_version: 2 });
    expect(result.status).toBe(409);
    expect(result.body.conflict).toBe(true);
    expect(result.body.error).toMatch(/^Sam Lee saved "Book shop" after you opened it\./);
    // A cloud connection: kept on no one machine.
    expect(result.body.current).toEqual({ ...CURRENT, lives_on: null, local_here: false });
    expect(ran(/^\s*UPDATE connections/)).toHaveLength(0);
  });

  it("saves an edit that started from the current version, and only if it still is", async () => {
    setUp();
    const result = await put({ ...EDIT, name: "Books", base_version: 3 });
    expect(result.status).toBe(200);
    const [update] = ran(/^\s*UPDATE connections[\s\S]*RETURNING/);
    expect(update[0]).toMatch(/version = version \+ 1/);
    expect(update[1]?.slice(-2)).toEqual(["A editor", 3]);
  });

  it("turns down an edit when someone saved between the read and the write", async () => {
    setUp({}, false);
    const result = await put({ ...EDIT, name: "Books", base_version: 3 });
    expect(result.status).toBe(409);
    expect(result.body.conflict).toBe(true);
  });

  it("still saves an edit from an older client that sends no version", async () => {
    setUp();
    const result = await put({ ...EDIT, name: "Books" });
    expect(result.status).toBe(200);
    expect(ran(/^\s*UPDATE connections[\s\S]*RETURNING/)[0][1]?.slice(-1)).toEqual([null]);
  });

  it("turns down a delete that started from an older version, and deletes nothing", async () => {
    setUp();
    const result = await remove({ id: 4, base_version: 1 });
    expect(result.status).toBe(409);
    expect(result.body.conflict).toBe(true);
    expect(ran(/DELETE FROM connections/)).toHaveLength(0);
  });

  it("turns down a delete when someone saved between the read and the delete", async () => {
    setUp({}, false);
    const result = await remove({ id: 4, base_version: 3 });
    expect(result.status).toBe(409);
    expect(result.body.conflict).toBe(true);
  });

  it("refuses to change a desktop's copy of a website connection here", async () => {
    setUp({ site_id: 12 });
    const edit = await put({ ...EDIT, name: "Books" });
    expect(edit.status).toBe(409);
    expect(edit.body).toEqual({ error: SITE_OWNED_MESSAGE, siteOwned: true });
    const gone = await remove({ id: 4 });
    expect(gone.status).toBe(409);
    expect(ran(/^\s*UPDATE connections/)).toHaveLength(0);
    expect(ran(/DELETE FROM connections/)).toHaveLength(0);
  });
});

describe("GET /api/agent/sync", () => {
  const ROWS = [
    { ...SAVED, id: 4, type: "PostgreSQL", password: "enc:made-up-pw", application_table: null, execute_role: "", updated_at: null, updated_by: null, version: 3 },
    { ...SAVED, id: 5, type: "PostgreSQL", password: null, connection_string: "enc:postgres://u@h/d", application_table: null, execute_role: "", updated_at: null, updated_by: null, version: 1 },
  ];
  const md5 = "0123456789abcdef0123456789abcdef";

  function setUpSync() {
    mockPoolQuery.mockReset();
    mockPoolQuery.mockImplementation(async (text: string) => {
      if (/md5\(/.test(text)) return { rows: [{ md5 }] };
      if (/FROM connections WHERE org_id = \$1 ORDER BY id/.test(text)) return { rows: ROWS };
      return { rows: [] };
    });
  }
  const read = async (rev?: string) =>
    answer(await readSyncRoute(request(`http://localhost:3000/api/agent/sync${rev ? `?rev=${rev}` : ""}`, "GET")));

  it("answers an unlinked computer with the link's own refusal", async () => {
    mockLinked = false;
    expect((await read()).status).toBe(401);
  });

  it("answers 503 when the computer's person is no longer a member", async () => {
    mockAgentPrincipal = null;
    expect((await read()).status).toBe(503);
  });

  it("says nothing changed when the fingerprint matches, without reading the rows", async () => {
    setUpSync();
    const first = await read();
    expect(first.body.rev).toMatch(new RegExp(`^${md5}\\.s\\.[0-9a-f]{8}$`));
    setUpSync();
    const result = await read(first.body.rev);
    expect(result.body).toEqual({ same: true, rev: first.body.rev });
    expect(ran(/WHERE org_id = \$1 ORDER BY id/)).toHaveLength(0);
  });

  it("sends the person's website role with the list, and a new fingerprint when the role changes", async () => {
    setUpSync();
    const first = await read();
    expect(first.body.role).toEqual({ role: "editor", label: "Editor", permissions: [...principalFor("editor").permissions] });
    const [dropped, ...kept] = principalFor("editor").permissions;
    mockAgentPrincipal = principalFor("editor", { permissions: kept });
    setUpSync();
    const after = await read(first.body.rev);
    expect(after.body.same).toBe(false);
    expect(after.body.rev).not.toBe(first.body.rev);
    expect(after.body.role.permissions).not.toContain(dropped);
    mockAgentPrincipal = principalFor("editor", { roleLabel: "Editors" });
    setUpSync();
    expect((await read(first.body.rev)).body.same).toBe(false);
  });

  it("sends the passwords to someone who could change the connections", async () => {
    setUpSync();
    const result = await read();
    expect(result.body.same).toBe(false);
    expect(result.body.withSecrets).toBe(true);
    expect(result.body.connections.map((row: { password: string }) => row.password)).toEqual(["made-up-pw", ""]);
    expect(result.body.connections[1].connection_string).toBe("postgres://u@h/d");
    expect(ran(/md5\(/)[0][1]).toEqual([TEST_ORG.id]);
  });

  it("sends a local connection as where it lives, without the key that finds its password", async () => {
    mockPoolQuery.mockReset();
    mockPoolQuery.mockImplementation(async (text: string) => {
      if (/md5\(/.test(text)) return { rows: [{ md5 }] };
      if (/FROM connections WHERE org_id = \$1 ORDER BY id/.test(text)) {
        return { rows: [{ ...ROWS[0], password: "local:v1:5f0c7a2e-made-up-key:Swinburne server" }] };
      }
      return { rows: [] };
    });
    const result = await read();
    expect(result.body.connections[0].password).toBe("local:v1:elsewhere:Swinburne server");
    expect(JSON.stringify(result.body)).not.toContain("made-up-key");
  });

  it("sends a viewer the connections without any secret, and a new fingerprint", async () => {
    mockAgentPrincipal = principalFor("viewer");
    setUpSync();
    const result = await read(`${md5}.s`);
    expect(result.body.rev).toMatch(new RegExp(`^${md5}\\.p\\.[0-9a-f]{8}$`));
    expect(result.body.role.role).toBe("viewer");
    expect(result.body.withSecrets).toBe(false);
    for (const row of result.body.connections) {
      expect(row.password).toBe("");
      expect(row.connection_string).toBe("");
    }
    expect(result.body.connections[0].has_password).toBe(true);
  });

  it("sends nothing to someone whose role cannot see connections", async () => {
    mockAgentPrincipal = principalFor("viewer", { permissions: [] });
    setUpSync();
    const result = await read();
    expect(result.body).toEqual({
      same: false,
      rev: expect.stringMatching(/^none\.p\.[0-9a-f]{8}$/),
      withSecrets: false,
      connections: [],
      role: { role: "viewer", label: "Viewer", permissions: [] },
    });
  });

  it("reads back only a fingerprint shaped like one of ours", () => {
    expect(readRev(`${md5}.s.0123abcd`)).toBe(`${md5}.s.0123abcd`);
    expect(readRev("none.p.0123abcd")).toBe("none.p.0123abcd");
    expect(readRev("'; drop table x")).toBeNull();
    expect(readRev("a".repeat(51))).toBeNull();
    expect(readRev(null)).toBeNull();
    const role = { role: "viewer", label: "Viewer", permissions: [] };
    expect(revOf([{ id: 5, version: 1 }, { id: 4, version: 3 }], true, role)).toMatch(/^[0-9a-f]{32}\.s\.[0-9a-f]{8}$/);
  });
});

describe("saving through the link", () => {
  const NEW = {
    name: "Reporting",
    type: "PostgreSQL",
    host: "db.example.com",
    port: 5432,
    database_name: "app",
    username: "app_owner",
    password: "made-up-typed",
    ssl_mode: "require",
    environment: "dev",
  };
  const add = async (body: unknown) =>
    answer(await addThroughLink(request("http://localhost:3000/api/agent/sync/connections", "POST", body)));

  it("saves a connection the website can reach, as the computer's person", async () => {
    setUp();
    mockTest.mockResolvedValue({ ok: true });
    const result = await add(NEW);
    expect(result.body.saved).toBe(true);
    expect(result.body.connection.id).toBe(9);
    const [insert] = ran(/INSERT INTO connections/);
    expect(insert[1]?.[13]).toBe(TEST_ORG.id);
    expect(insert[1]?.[14]).toBe("A editor");
  });

  it("leaves a connection the website cannot reach on the computer, saying why", async () => {
    setUp();
    mockTest.mockResolvedValue({ ok: false, error: "Could not reach db.example.com." });
    const result = await add(NEW);
    expect(result.body).toEqual({ saved: false, reason: "Could not reach db.example.com." });
    expect(ran(/INSERT INTO connections/)).toHaveLength(0);
  });

  it("refuses a typed local marker before dialling anything", async () => {
    setUp();
    mockTest.mockReset();
    const result = await add({ ...NEW, password: "local:v1:made-up-key:Swinburne server" });
    expect(result.body.saved).toBe(false);
    expect(result.body.reason).toMatch(/can't start with "local:v1:"/);
    expect(mockTest).not.toHaveBeenCalled();
    expect(ran(/INSERT INTO connections/)).toHaveLength(0);
  });

  it("refuses a person whose website role cannot add connections, before testing anything", async () => {
    mockAgentPrincipal = principalFor("viewer");
    const result = await add(NEW);
    expect(result.status).toBe(403);
    expect(mockTest).not.toHaveBeenCalled();
  });

  it("answers 503 when the computer's person cannot be read", async () => {
    mockAgentPrincipal = null;
    expect((await add(NEW)).status).toBe(503);
  });

  it("refuses a body that is not an object", async () => {
    expect((await add([1, 2])).status).toBe(400);
  });

  it("edits with the same version check as the website's own page", async () => {
    setUp();
    const result = await answer(
      await editThroughLink(
        request("http://localhost:3000/api/agent/sync/connections", "PUT", { ...EDIT, base_version: 1 })
      )
    );
    expect(result.status).toBe(409);
    expect(result.body.conflict).toBe(true);
  });
});
