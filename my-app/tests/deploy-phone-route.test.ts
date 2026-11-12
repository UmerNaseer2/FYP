// What a paired phone reads, through the desktop app, before it starts a deploy
// or a rollback (app/api/deploy/phone/route.ts).
//
// The rules themselves are in lib/phone-deploy.ts and tests/phone-deploy.test.ts.
// These pin what the route adds around them: its gate, staying inside the
// caller's organization, what it does when the registry, the target database or
// the app database do not answer, that no refusal repeats a host name, and that
// a plan carries a way to run or to ask only when that is the next step.
//
// Its two sibling routes are replaced, because the suites of those routes pin
// them already, and nothing here should reach GitHub or a database.
import { NextRequest } from "next/server";
import type { Gate } from "@/lib/auth-guard";
import { runFingerprint } from "@/lib/approvals-db";
import { principalFor, TEST_ORG } from "./helpers/principals";

let mockGate: Gate;
let mockAskedFor: string[][] = [];
jest.mock("../lib/auth-guard", () => ({
  requirePermission: async (...keys: string[]) => {
    mockAskedFor.push(keys);
    return mockGate;
  },
}));

// Relative paths on purpose: next/jest rewrites the @/ alias inside import
// statements only, so jest.mock("@/...") would not resolve.
const mockPoolQuery = jest.fn<Promise<unknown>, unknown[]>();
jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: { query: (...args: unknown[]) => mockPoolQuery(...args) },
  syncMetadataTables: async () => undefined,
}));

const mockFindTracked = jest.fn<Promise<unknown>, unknown[]>();
jest.mock("../lib/lineage-db", () => ({
  findTrackedSchema: (...args: unknown[]) => mockFindTracked(...args),
}));

const mockFindOpenApproval = jest.fn<Promise<unknown>, unknown[]>();
jest.mock("../lib/approvals-db", () => ({
  ...jest.requireActual("../lib/approvals-db"),
  findOpenApproval: (...args: unknown[]) => mockFindOpenApproval(...args),
}));

const mockPull = jest.fn<Promise<Response>, []>();
jest.mock("../app/api/github/pull/route", () => ({ GET: () => mockPull() }));

const mockPreflight = jest.fn<Promise<Response>, [NextRequest]>();
jest.mock("../app/api/scripts/preflight/route", () => ({
  POST: (request: NextRequest) => mockPreflight(request),
}));

import { GET, POST } from "../app/api/deploy/phone/route";

const CONNECTION = { database_name: "bookshop", execute_role: "editor" };

function file(script_name: string, version: string, sql_content: string, schema_name = "public") {
  return {
    database_name: "bookshop",
    schema_name,
    script_name,
    version,
    path: `bookshop/${schema_name}/${script_name}/v${version}.sql`,
    sql_content,
  };
}

const FILES = [
  file("users", "1.0.0", "CREATE TABLE users (id int);"),
  file("users", "1.1.0", "ALTER TABLE users ADD COLUMN name text;"),
  file("users", "1.2.0", "ALTER TABLE users ADD COLUMN age int;"),
  file("orders", "1.0.0", "CREATE TABLE orders (id int);", "shop"),
  { ...file("elsewhere", "1.0.0", "SELECT 1;"), database_name: "another" },
];

const LEDGER = {
  currentVersion: "1.0.0",
  timeline: [{ version: "1.0.0", applied_at: "2026-10-01T00:00:00.000Z", down_sql: "DROP TABLE users;" }],
  applications: { known: false, names: [], source: "none" },
  otherScripts: [],
};

const TARGET = { connectionId: 3, schemaName: "public", scriptName: "users" };
const DEPLOY = { ...TARGET, action: "deploy", targetVersion: "1.2.0" };
const REVERT = { ...TARGET, action: "revert", targetVersion: null };

function getRequest(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/deploy/phone${query}`);
}

function postRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/deploy/phone", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function plan(body: unknown = DEPLOY) {
  const res = await POST(postRequest(body));
  return { status: res.status, json: await res.json() };
}

beforeEach(() => {
  mockAskedFor = [];
  mockGate = { ok: true, principal: principalFor("editor") } as unknown as Gate;
  mockPoolQuery.mockReset();
  mockPoolQuery.mockResolvedValue({ rows: [CONNECTION] });
  mockFindTracked.mockReset();
  mockFindTracked.mockResolvedValue(null);
  mockFindOpenApproval.mockReset();
  mockFindOpenApproval.mockResolvedValue(null);
  mockPull.mockReset();
  mockPull.mockImplementation(async () => Response.json({ ok: true, scripts: FILES, warnings: [] }));
  mockPreflight.mockReset();
  mockPreflight.mockImplementation(async () => Response.json(LEDGER));
});

describe("the gate", () => {
  it("asks for Deploy: Read on both verbs", async () => {
    await GET(getRequest("?connectionId=3"));
    await POST(postRequest(TARGET));
    expect(mockAskedFor).toEqual([["deploy:read"], ["deploy:read"]]);
  });

  it("answers with the gate's refusal and reads nothing", async () => {
    mockGate = { ok: false, response: Response.json({ error: "no" }, { status: 403 }) } as unknown as Gate;
    expect((await GET(getRequest("?connectionId=3"))).status).toBe(403);
    mockGate = { ok: false, response: Response.json({ error: "no" }, { status: 403 }) } as unknown as Gate;
    expect((await POST(postRequest(TARGET))).status).toBe(403);
    expect(mockPoolQuery).not.toHaveBeenCalled();
    expect(mockPull).not.toHaveBeenCalled();
  });
});

describe("GET: the families a connection could run", () => {
  it("lists this connection's database only", async () => {
    const res = await GET(getRequest("?connectionId=3"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      registry: "ok",
      partial: false,
      families: [
        { schemaName: "public", scriptName: "users", newestVersion: "1.2.0", versionCount: 3 },
        { schemaName: "shop", scriptName: "orders", newestVersion: "1.0.0", versionCount: 1 },
      ],
    });
  });

  it("looks for the connection inside the caller's organization", async () => {
    await GET(getRequest("?connectionId=3"));
    expect(mockPoolQuery.mock.calls[0][1]).toEqual([3, TEST_ORG.id]);
  });

  it("says when the registry gave only some of its files", async () => {
    mockPull.mockImplementation(async () => Response.json({ ok: true, scripts: FILES, warnings: ["one file"] }));
    expect((await (await GET(getRequest("?connectionId=3"))).json()).partial).toBe(true);
  });

  it("refuses without a connection number", async () => {
    expect((await GET(getRequest("?connectionId=x"))).status).toBe(400);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it("reads another organization's connection as missing", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    expect((await GET(getRequest("?connectionId=3"))).status).toBe(404);
    expect(mockPull).not.toHaveBeenCalled();
  });

  it("keeps a metadata failure's words to itself", async () => {
    const quiet = jest.spyOn(console, "error").mockImplementation(() => undefined);
    mockPoolQuery.mockRejectedValue(new Error("connect ECONNREFUSED db.example.test:5433"));
    const res = await GET(getRequest("?connectionId=3"));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("example.test");
    quiet.mockRestore();
  });

  it("tells an unconfigured registry from one that did not answer", async () => {
    mockPull.mockImplementation(async () => Response.json({ code: "github_unconfigured" }, { status: 500 }));
    expect(await (await GET(getRequest("?connectionId=3"))).json()).toEqual({
      registry: "unconfigured",
      partial: false,
      families: [],
    });
    mockPull.mockImplementation(async () => Response.json({ code: "github_auth" }, { status: 502 }));
    expect((await (await GET(getRequest("?connectionId=3"))).json()).registry).toBe("unreachable");
    mockPull.mockImplementation(async () => new Response("not json", { status: 502 }));
    expect((await (await GET(getRequest("?connectionId=3"))).json()).registry).toBe("unreachable");
  });
});

describe("POST: what it refuses", () => {
  it.each([
    ["no connection", { schemaName: "public", scriptName: "users" }],
    ["no schema", { connectionId: 3, scriptName: "users" }],
    ["an empty script", { connectionId: 3, schemaName: "public", scriptName: "" }],
    ["an unknown action", { ...TARGET, action: "drop" }],
    ["a version that is not text", { ...TARGET, action: "deploy", targetVersion: 2 }],
    ["an action with no version at all", { ...TARGET, action: "deploy" }],
  ])("%s", async (_name, body) => {
    expect((await plan(body)).status).toBe(400);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it("an unreadable body", async () => {
    expect((await plan("{not json")).status).toBe(400);
  });

  it("another organization's connection", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    expect((await plan()).status).toBe(404);
    expect(mockPull).not.toHaveBeenCalled();
  });

  it("answers 424 when the registry could not be read", async () => {
    mockPull.mockImplementation(async () => Response.json({ code: "github_auth" }, { status: 502 }));
    expect((await plan()).status).toBe(424);
    expect(mockPreflight).not.toHaveBeenCalled();
  });

  it("a family the registry does not hold for this database", async () => {
    expect((await plan({ ...TARGET, scriptName: "elsewhere" })).status).toBe(404);
    expect(mockPreflight).not.toHaveBeenCalled();
  });

  it("answers 502, and names no host, when the target database does not answer", async () => {
    mockPreflight.mockImplementation(async () =>
      Response.json({ error: "Could not reach db.example.test:5432" }, { status: 503 }),
    );
    const { status, json } = await plan();
    expect(status).toBe(502);
    expect(JSON.stringify(json)).not.toContain("example.test");
  });

  it("keeps preflight's other statuses but none of its words", async () => {
    mockPreflight.mockImplementation(async () => Response.json({ error: "secret detail" }, { status: 500 }));
    const failed = await plan();
    expect(failed.status).toBe(500);
    expect(JSON.stringify(failed.json)).not.toContain("secret detail");
    mockPreflight.mockImplementation(async () => Response.json({ error: "gone" }, { status: 404 }));
    expect((await plan()).status).toBe(404);
  });

  it("answers 503 when the app database cannot say how the schema is tracked", async () => {
    const quiet = jest.spyOn(console, "error").mockImplementation(() => undefined);
    mockFindTracked.mockRejectedValue(new Error("connect ECONNREFUSED db.example.test:5433"));
    const { status, json } = await plan();
    expect(status).toBe(503);
    expect(JSON.stringify(json)).not.toContain("example.test");
    quiet.mockRestore();
  });

  it("answers 500 when the approval queue cannot be read", async () => {
    const quiet = jest.spyOn(console, "error").mockImplementation(() => undefined);
    mockPoolQuery.mockResolvedValue({ rows: [{ ...CONNECTION, execute_role: "admin" }] });
    mockFindOpenApproval.mockRejectedValue(new Error("connect ECONNREFUSED db.example.test:5433"));
    const { status, json } = await plan();
    expect(status).toBe(500);
    expect(JSON.stringify(json)).not.toContain("example.test");
    quiet.mockRestore();
  });
});

describe("POST: where one family stands", () => {
  it("gives the current version, what is waiting and what it could go back to", async () => {
    const { status, json } = await plan(TARGET);
    expect(status).toBe(200);
    expect(json).toEqual({
      currentVersion: "1.0.0",
      waiting: ["1.1.0", "1.2.0"],
      undo: [{ target: null, undoCount: 1 }],
      partial: false,
    });
    expect(mockFindTracked).not.toHaveBeenCalled();
  });

  it("asks preflight about that family and no other", async () => {
    await plan(TARGET);
    expect(await mockPreflight.mock.calls[0][0].json()).toEqual(TARGET);
  });
});

describe("POST: the plan for one run", () => {
  it("a role that may run here: the next step is to run it, with the way to do that", async () => {
    const { status, json } = await plan();
    expect(status).toBe(200);
    const scripts = [
      { scriptName: "users", version: "1.1.0", sqlContent: FILES[1].sql_content },
      { scriptName: "users", version: "1.2.0", sqlContent: FILES[2].sql_content },
    ];
    expect(json).toMatchObject({
      action: "deploy",
      connectionId: 3,
      schemaName: "public",
      scriptName: "users",
      targetVersion: "1.2.0",
      partial: false,
      next: "run",
      blockedReason: null,
      approvalRequest: null,
      scripts,
      fingerprint: runFingerprint(scripts, "deploy"),
      risks: { otherScripts: [], drift: null },
    });
    expect(json.run.path).toBe("/api/scripts/apply");
    expect(json.run.body.scripts.map((script: { version: string }) => script.version)).toEqual(["1.1.0", "1.2.0"]);
    expect(mockFindOpenApproval).not.toHaveBeenCalled();
  });

  it("works out a rollback's fingerprint as a rollback", async () => {
    const { json } = await plan(REVERT);
    expect(json.action).toBe("revert");
    expect(json.run.path).toBe("/api/scripts/revert");
    expect(json.scripts).toEqual([{ scriptName: "users", version: "1.0.0", sqlContent: "DROP TABLE users;" }]);
    expect(json.fingerprint).toBe(runFingerprint(json.scripts, "revert"));
    expect(json.fingerprint).not.toBe(runFingerprint(json.scripts, "deploy"));
  });

  it("a role that may only look gets no way to run, only the way to ask", async () => {
    mockGate = { ok: true, principal: principalFor("viewer") } as unknown as Gate;
    const { json } = await plan();
    expect(json).toMatchObject({ next: "ask-approval", blockedReason: null, run: null });
    expect(json.approvalRequest).toMatchObject({ action: "deploy", connectionId: 3 });
  });

  it("a connection nobody may run on is read-only, to an admin as well", async () => {
    mockGate = { ok: true, principal: principalFor("admin") } as unknown as Gate;
    mockPoolQuery.mockResolvedValue({ rows: [{ ...CONNECTION, execute_role: "none" }] });
    const { json } = await plan();
    expect(json).toMatchObject({ next: "blocked", blockedReason: "read-only", run: null, approvalRequest: null });
  });

  it("does not look in the queue for a run that cannot happen", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [{ ...CONNECTION, execute_role: "admin" }] });
    const { json } = await plan({ ...DEPLOY, targetVersion: "1.0.0" });
    expect(json).toMatchObject({ next: "blocked", blockedReason: "nothing-to-do" });
    expect(mockFindOpenApproval).not.toHaveBeenCalled();
  });

  it("only a deploy carries the last drift check", async () => {
    mockFindTracked.mockResolvedValue({
      trackedSchemaId: 9,
      headVersion: "1.0.0",
      driftStatus: "drifted",
    });
    expect((await plan()).json.risks.drift).toBe("drifted");
    expect((await plan(REVERT)).json.risks.drift).toBe(null);
  });
});

describe("POST: a connection only an admin may run on, to an editor", () => {
  beforeEach(() => {
    mockPoolQuery.mockResolvedValue({ rows: [{ ...CONNECTION, execute_role: "admin" }] });
  });

  it("asks for approval first, with the way to ask and no way to run", async () => {
    const { json } = await plan();
    expect(json).toMatchObject({ next: "ask-approval", blockedReason: null, run: null });
    expect(json).not.toHaveProperty("environment");
    expect(json.approvalRequest).toMatchObject({ action: "deploy", connectionId: 3, schemaName: "public" });
    expect(mockFindOpenApproval.mock.calls[0][0]).toMatchObject({
      orgId: TEST_ORG.id,
      connectionId: 3,
      schemaName: "public",
      action: "deploy",
    });
  });

  it("a request nobody has decided is a wait, with no way to run or ask", async () => {
    mockFindOpenApproval.mockResolvedValue("pending");
    const { json } = await plan();
    expect(json).toMatchObject({ next: "waiting", run: null, approvalRequest: null });
  });

  it("an approved run may start", async () => {
    mockFindOpenApproval.mockResolvedValue("approved");
    const { json } = await plan();
    expect(json.next).toBe("run-approved");
    expect(json.run.path).toBe("/api/scripts/apply");
    expect(json.approvalRequest).toBe(null);
  });
});
