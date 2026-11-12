// Asking an Admin for one run.
//
// The rule: if your role allows an action, you just do it. A role that may
// see deployments but not run them (or anybody on a connection kept for
// Admins) can ask an Admin to approve one exact run, and then run that run
// once. These tests follow the rule through the three routes that carry it
// (apply, revert, and the approvals POST that records the asking) and the two
// places in lib/approvals-db that keep a one-off approval with its owner.
//
// The target database is the fake client from helpers/fake-pg, and the
// metadata database a stand-in pool. Nothing here reaches a real database or
// GitHub.
import { NextRequest } from "next/server";
import { askToRunRefusal } from "@/lib/connection-access";
import { hasPermission } from "@/lib/permissions";
import type { Principal } from "@/lib/auth-guard";
import type { DeployApproval } from "@/lib/approvals-db";
import { createFakeClient, queriesMatching, queryTexts, type FakeClient, type FakeStep } from "./helpers/fake-pg";
import { FAKE_TOKEN, guardGitHub, type GitHubGuard } from "./helpers/no-github";
import { principalFor, TEST_ORG } from "./helpers/principals";

// Relative paths on purpose: next/jest rewrites the @/ alias inside import
// statements only, so jest.mock("@/...") would not resolve.
//
// The caller is whoever the test puts in mockPrincipal. The gate here does
// what the real one does with it: lets them in only with the permission the
// route asked for. So a route that still asked for "Deploy: Run" would turn
// the viewer away at the door, and these tests would see it.
let mockPrincipal: Principal;
const mockGateAsked: string[] = [];
jest.mock("../lib/auth-guard", () => {
  const { NextResponse } = require("next/server");
  const permissions = require("../lib/permissions");
  return {
    requirePermission: async (...keys: string[]) => {
      mockGateAsked.push(...keys);
      if (permissions.hasPermission(mockPrincipal, ...keys)) return { ok: true, principal: mockPrincipal };
      return { ok: false, response: NextResponse.json({ error: "gate" }, { status: 403 }) };
    },
  };
});

// The metadata database. With the approvals module's writers replaced below,
// only the saved-connection lookups of the three routes reach it, plus the
// real claimApproval in the last block.
const mockPoolQuery = jest.fn<Promise<unknown>, unknown[]>(async () => ({ rows: [] }));
jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: { query: (...args: unknown[]) => mockPoolQuery(...args) },
  syncMetadataTables: async () => undefined,
}));

// The target database: whatever fake client the test built.
let mockClient: FakeClient;
jest.mock("../lib/postgres", () => ({
  getPoolForConfig: () => ({ connect: async () => mockClient }),
}));
jest.mock("../lib/connection-config", () => ({
  buildPgConfig: () => ({}),
}));
jest.mock("../lib/lineage-db", () => ({
  findTrackedSchema: async () => null,
  recordAppliedMigrationToLineage: async () => ({ advanced: false }),
}));
// Left unmocked, a run that reaches COMMIT would write to a real registry
// repository (see tests/apply-risk.test.ts).
jest.mock("../lib/registry-archive", () => ({
  archiveAppliedVersions: async () => null,
}));
jest.mock("../lib/deploy-attempts-db", () => ({
  recordDeployAttempt: async () => undefined,
}));

// The approvals module, real except for the three calls the routes make that
// would write. The real claimApproval is tested by itself in the last block.
const mockClaim = jest.fn<Promise<unknown>, unknown[]>(async () => null);
const mockRelease = jest.fn<Promise<void>, unknown[]>(async () => undefined);
const mockCreate = jest.fn<Promise<unknown>, unknown[]>(async () => ({ id: 1 }));
jest.mock("../lib/approvals-db", () => ({
  ...jest.requireActual("../lib/approvals-db"),
  claimApproval: (...args: unknown[]) => mockClaim(...args),
  releaseApproval: (...args: unknown[]) => mockRelease(...args),
  createApprovalRequest: (...args: unknown[]) => mockCreate(...args),
}));
const realApprovals = jest.requireActual<typeof import("../lib/approvals-db")>("../lib/approvals-db");

let applyPOST: typeof import("../app/api/scripts/apply/route").POST;
let revertPOST: typeof import("../app/api/scripts/revert/route").POST;
let approvalsPOST: typeof import("../app/api/deploy/approvals/route").POST;

/** A saved connection, as each route's lookup reads it. */
function connectionRow(execute_role: string) {
  return {
    host: "db.test", port: 5432, database_name: "sales", username: "app",
    password: "not-a-real-password", connection_string: null, ssl: false,
    ssl_mode: "disable", name: "Sales dev", execute_role,
  };
}

/** The answers a healthy target gives the apply route. */
function applyTarget(): FakeStep[] {
  return [
    { match: /information_schema\.schemata/, rows: [{ exists: 1 }] },
    { match: /INSERT INTO "sales"\.script_patch/, rows: [{ applied_at: "2026-09-11T00:00:00.000Z" }] },
  ];
}

/** The answers a healthy target gives the revert route: one version applied. */
function revertTarget(): FakeStep[] {
  return [
    { match: /extnamespace/, rows: [] },
    { match: /FROM pg_namespace/, rows: [{ exists: 1 }] },
    { match: /to_regclass/, rows: [{ reg: "script_patch" }] },
    {
      match: /column_name IN \('down_sql', 'applied_by'\)/,
      rows: [{ column_name: "down_sql" }, { column_name: "applied_by" }],
    },
    { match: /script_name <> \$1/, rows: [] },
    {
      match: /SELECT id, version, title, change_type, applied_at/,
      rows: [{
        id: 3, version: "3.0.0", title: "Rename a column", change_type: "patch",
        applied_at: "2026-03-01T00:00:00.000Z", down_sql: "DROP TABLE t3;", applied_by: "bob@test",
      }],
    },
    { match: /DELETE FROM/, rowCount: 1 },
  ];
}

type Answer = { status: number; body: Record<string, unknown> };

async function send(
  handler: (request: NextRequest) => Promise<Response>,
  path: string,
  body: Record<string, unknown>
): Promise<Answer> {
  const res = await handler(
    new NextRequest(`http://localhost${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
  const text = await res.text();
  // Whatever happens, no secret reaches the browser.
  expect(text).not.toContain(FAKE_TOKEN);
  expect(text).not.toContain("not-a-real-password");
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown> };
}

// Adds a table.
const APPLY_BODY = {
  connectionId: 7,
  schemaName: "sales",
  scripts: [{ script_name: "orders_fix", version: "1.0.0", sql_content: "CREATE TABLE orders (id int);" }],
};
const REVERT_BODY = {
  connectionId: 7,
  schemaName: "sales",
  script_name: "orders_fix",
  versions: ["3.0.0"],
};
const REQUEST_BODY = {
  connectionId: 7,
  schemaName: "sales",
  scriptName: "orders_fix",
  targetVersion: "1.0.0",
  scripts: APPLY_BODY.scripts,
};

const apply = (body: Record<string, unknown> = {}) =>
  send((request) => applyPOST(request), "/api/scripts/apply", { ...APPLY_BODY, ...body });
const revert = (body: Record<string, unknown> = {}) =>
  send((request) => revertPOST(request), "/api/scripts/revert", { ...REVERT_BODY, ...body });
const ask = (body: Record<string, unknown> = {}) =>
  send((request) => approvalsPOST(request), "/api/deploy/approvals", { ...REQUEST_BODY, ...body });

const count = (client: FakeClient, text: string) => queryTexts(client).filter((t) => t === text).length;
/** Statements that would change the target. */
const writes = (client: FakeClient) => queriesMatching(client, /\b(CREATE|INSERT|ALTER|DROP|DELETE)\b/);

/** The one argument a mocked approvals call was given. */
const firstArg = (mock: jest.Mock) => mock.mock.calls[0][0] as Record<string, unknown>;

// Somebody who may see deployments and nothing more, and somebody who may run
// them. Both as a new install has them.
const viewer = () => principalFor("viewer", { email: "viewer@test" });
const editor = () => principalFor("editor", { email: "editor@test" });

let guard: GitHubGuard;
let consoleSpy: jest.SpyInstance;
let logSpy: jest.SpyInstance;

beforeAll(async () => {
  // Imported after the jest.mock calls above, so the routes see the stand-ins.
  applyPOST = (await import("../app/api/scripts/apply/route")).POST;
  revertPOST = (await import("../app/api/scripts/revert/route")).POST;
  approvalsPOST = (await import("../app/api/deploy/approvals/route")).POST;
});

beforeEach(() => {
  guard = guardGitHub();
  mockPrincipal = viewer();
  mockGateAsked.length = 0;
  mockPoolQuery.mockReset();
  mockPoolQuery.mockResolvedValue({ rows: [connectionRow("editor")] });
  mockClaim.mockReset();
  mockClaim.mockResolvedValue(null);
  mockRelease.mockReset();
  mockRelease.mockResolvedValue(undefined);
  mockCreate.mockReset();
  mockCreate.mockResolvedValue({ id: 1 });
  mockClient = createFakeClient(applyTarget());
  // The routes log their refusals; the assertions below read the responses.
  consoleSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  consoleSpy.mockRestore();
  logSpy.mockRestore();
  guard.restore();
  expect(guard.unexpected).toEqual([]);
});

describe("the two people in these tests", () => {
  it("are a viewer who may see deployments but not run them, and an editor who may run them", () => {
    expect(hasPermission(viewer(), "deploy:read")).toBe(true);
    expect(hasPermission(viewer(), "deploy:run")).toBe(false);
    expect(hasPermission(editor(), "deploy:run")).toBe(true);
    expect(hasPermission(editor(), "approvals:create")).toBe(true);
  });
});

describe("apply, for a role that may not run migrations", () => {
  it("lets them through the door on 'Deploy: Read'", async () => {
    await apply();
    expect(mockGateAsked).toEqual(["deploy:read"]);
  });

  it("refuses a dry run outright: a rehearsal runs the SQL too", async () => {
    const res = await apply({ dryRun: true });
    expect(res.status).toBe(403);
    expect(res.body.askToRun).toBe(true);
    expect(res.body.error).toBe(askToRunRefusal("Sales dev", true));
    // No approval covers a rehearsal, so none is looked for.
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockClient.queries).toEqual([]);
  });

  it("refuses a real run nobody approved for them, and runs nothing", async () => {
    const res = await apply();
    expect(res.status).toBe(403);
    expect(res.body.askToRun).toBe(true);
    expect(res.body.needsApproval).toBe(true);
    expect(res.body.error).toBe(askToRunRefusal("Sales dev", false));
    // Looked for only among their own requests.
    expect(mockClaim).toHaveBeenCalledTimes(1);
    expect(firstArg(mockClaim)).toMatchObject({
      orgId: TEST_ORG.id,
      connectionId: 7,
      schemaName: "sales",
      action: "deploy",
      requestedBy: "viewer@test",
    });
    expect(writes(mockClient)).toEqual([]);
    expect(count(mockClient, "BEGIN")).toBe(0);
    expect(count(mockClient, "COMMIT")).toBe(0);
  });

  it("runs the run once an approval of theirs is claimed", async () => {
    mockClaim.mockResolvedValue({ id: 9 });
    const res = await apply();
    expect(res.status).toBe(200);
    expect(firstArg(mockClaim)).toMatchObject({ requestedBy: "viewer@test" });
    expect(count(mockClient, "COMMIT")).toBe(1);
    // The approval is spent, not handed back.
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it("refuses a read-only connection without looking for an approval", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [connectionRow("none")] });
    // Even with an approval there to claim, a read-only connection runs nothing.
    mockClaim.mockResolvedValue({ id: 9 });
    for (const dryRun of [false, true]) {
      const res = await apply({ dryRun });
      expect(res.status).toBe(403);
      expect(String(res.body.error)).toContain("read-only");
      expect(res.body.askToRun).toBeUndefined();
    }
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockClient.queries).toEqual([]);
  });
});

describe("apply, for a role that may run migrations", () => {
  it("just runs, claiming nothing", async () => {
    mockPrincipal = editor();
    const res = await apply();
    expect(res.status).toBe(200);
    expect(mockClaim).not.toHaveBeenCalled();
    expect(count(mockClient, "COMMIT")).toBe(1);
  });
});

describe("revert, for a role that may not roll back", () => {
  beforeEach(() => {
    mockClient = createFakeClient(revertTarget());
  });

  it("lets them through the door on 'Deploy: Read'", async () => {
    await revert();
    expect(mockGateAsked).toEqual(["deploy:read"]);
  });

  it("refuses a rollback nobody approved for them, and changes nothing", async () => {
    const res = await revert();
    expect(res.status).toBe(403);
    expect(res.body.askToRun).toBe(true);
    expect(res.body.needsApproval).toBe(true);
    expect(res.body.error).toBe(askToRunRefusal("Sales dev", false, true));
    expect(mockClaim).toHaveBeenCalledTimes(1);
    // The exact rollback, read from the ledger, and only their own request.
    expect(firstArg(mockClaim)).toMatchObject({
      orgId: TEST_ORG.id,
      connectionId: 7,
      action: "revert",
      requestedBy: "viewer@test",
      scripts: [{ scriptName: "orders_fix", version: "3.0.0", sqlContent: "DROP TABLE t3;" }],
    });
    // The ledger was read inside a transaction that was then rolled back.
    expect(writes(mockClient)).toEqual([]);
    expect(count(mockClient, "COMMIT")).toBe(0);
    expect(count(mockClient, "ROLLBACK")).toBe(1);
  });

  it("refuses a dry run outright, before BEGIN", async () => {
    const res = await revert({ dryRun: true });
    expect(res.status).toBe(403);
    expect(res.body.askToRun).toBe(true);
    expect(res.body.error).toBe(askToRunRefusal("Sales dev", true, true));
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockClient.queries).toEqual([]);
  });

  it("rolls back once an approval of theirs is claimed", async () => {
    mockClaim.mockResolvedValue({ id: 42 });
    const res = await revert();
    expect(res.status).toBe(200);
    expect(firstArg(mockClaim)).toMatchObject({ requestedBy: "viewer@test", action: "revert" });
    expect(queryTexts(mockClient)).toContain("DROP TABLE t3;");
    expect(count(mockClient, "COMMIT")).toBe(1);
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it("refuses a read-only connection without looking for an approval", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [connectionRow("none")] });
    mockClaim.mockResolvedValue({ id: 42 });
    const res = await revert();
    expect(res.status).toBe(403);
    expect(String(res.body.error)).toContain("read-only");
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockClient.queries).toEqual([]);
  });
});

describe("asking (POST /api/deploy/approvals)", () => {
  it("looks the connection up in the caller's organization", async () => {
    await ask();
    expect(mockGateAsked).toEqual(["deploy:read"]);
    const [sql, values] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("SELECT name, execute_role FROM connections WHERE id = $1 AND org_id = $2");
    expect(values).toEqual([7, TEST_ORG.id]);
  });

  it("records a viewer's request as a run only they can spend", async () => {
    const res = await ask();
    expect(res.status).toBe(200);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(firstArg(mockCreate)).toMatchObject({
      orgId: TEST_ORG.id,
      connectionId: 7,
      requestedBy: "viewer@test",
      action: "deploy",
      runByRequester: true,
    });
  });

  it("records an editor's request on an Admins-only connection the same way", async () => {
    mockPrincipal = editor();
    mockPoolQuery.mockResolvedValue({ rows: [connectionRow("admin")] });
    const res = await ask();
    expect(res.status).toBe(200);
    expect(firstArg(mockCreate)).toMatchObject({ requestedBy: "editor@test", runByRequester: true });
  });

  it("refuses an editor's request where their role may run: it needs no approval", async () => {
    mockPrincipal = editor();
    for (const action of ["deploy", "revert"]) {
      const res = await ask({ action });
      expect(res.status).toBe(409);
      expect(String(res.body.error)).toContain("needs no approval");
    }
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("refuses everybody on a read-only connection: there is nothing to ask for", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [connectionRow("none")] });
    for (const who of [viewer(), editor(), principalFor("admin")]) {
      mockPrincipal = who;
      const res = await ask();
      expect(res.status).toBe(403);
      expect(String(res.body.error)).toContain("read-only");
    }
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("answers not found for a connection that is not there", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    const res = await ask();
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Connection not found." });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("turns away somebody who may not even see deployments", async () => {
    const all = viewer();
    mockPrincipal = { ...all, permissions: all.permissions.filter((key) => key !== "deploy:read") };
    const res = await ask();
    expect(res.status).toBe(403);
    expect(mockPoolQuery).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe("whose approval a run may spend (lib/approvals-db)", () => {
  const RUN = [{ scriptName: "orders_fix", version: "1.0.0", sqlContent: "CREATE TABLE orders (id int);" }];
  const INPUT = {
    orgId: TEST_ORG.id, connectionId: 3, schemaName: "sales", scripts: RUN, action: "deploy" as const,
  };

  beforeEach(() => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
  });

  it("claimApproval passes the runner's email as $6, and the SQL keeps one-offs with their owner", async () => {
    await realApprovals.claimApproval({ ...INPUT, requestedBy: "viewer@test" });
    const [sql, values] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(values).toEqual([
      3, "sales", realApprovals.runFingerprint(RUN, "deploy"), "deploy", TEST_ORG.id, "viewer@test",
    ]);
    expect(sql).toContain("run_by_requester");
    expect(sql).toContain("lower(requested_by) = lower($6::text)");
    // With no email, only an ordinary approval counts.
    expect(sql).toContain("WHEN $6::text IS NULL THEN NOT run_by_requester");
  });

  it("claimApproval passes null for somebody who may run it themselves", async () => {
    await realApprovals.claimApproval(INPUT);
    expect((mockPoolQuery.mock.calls[0] as [string, unknown[]])[1][5]).toBeNull();
  });

  it("findOpenApproval looks among the same approvals a claim would", async () => {
    await realApprovals.findOpenApproval({ ...INPUT, requestedBy: "viewer@test" });
    const [sql, values] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(values[5]).toBe("viewer@test");
    expect(sql).toContain("run_by_requester");
  });

  it("the lists of runs ready for anybody leave one-offs out", async () => {
    await realApprovals.listRunsReadyToRun(TEST_ORG.id);
    await realApprovals.countRunsReadyToRun(TEST_ORG.id);
    for (const [sql] of mockPoolQuery.mock.calls as [string][]) {
      expect(sql).toContain("AND NOT run_by_requester");
    }
    expect(mockPoolQuery).toHaveBeenCalledTimes(2);
  });

  describe("decisionBlockReason", () => {
    const oneOff = (action: "deploy" | "revert") =>
      ({ status: "pending", requested_by: "viewer@test", action, run_by_requester: true }) as unknown as DeployApproval;

    it("never lets the asker answer their own one-off, even where self-approval is allowed", () => {
      expect(realApprovals.decisionBlockReason(oneOff("deploy"), "viewer@test", true)).toBe(
        "You asked for this run, so somebody else has to approve it."
      );
      // The same person under another spelling of their address.
      expect(realApprovals.decisionBlockReason(oneOff("revert"), "Viewer@Test", true)).toBe(
        "You asked for this rollback, so somebody else has to approve it."
      );
      expect(realApprovals.decisionBlockReason(oneOff("deploy"), "viewer@test", false)).not.toBeNull();
    });

    it("lets another person answer it", () => {
      expect(realApprovals.decisionBlockReason(oneOff("deploy"), "admin@test", true)).toBeNull();
      expect(realApprovals.decisionBlockReason(oneOff("deploy"), "admin@test", false)).toBeNull();
    });

    it("still lets the asker of an ordinary request clear it where self-approval is allowed", () => {
      const ordinary = { ...oneOff("deploy"), run_by_requester: false } as DeployApproval;
      expect(realApprovals.decisionBlockReason(ordinary, "viewer@test", true)).toBeNull();
    });
  });
});
