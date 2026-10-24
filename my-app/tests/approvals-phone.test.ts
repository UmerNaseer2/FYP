// A paired phone reads deploy and rollback requests, and decides them, through
// the desktop app's phone link.
//
// These tests pin four things:
//   - the copy of its SQL a request keeps (the `scripts` column), which is
//     only ever handed out when it hashes back to the request's fingerprint;
//   - GET /api/deploy/approvals/phone, the queue, which never carries SQL;
//   - GET /api/deploy/approvals/[id]/phone, one request and its SQL;
//   - the two fields the decision route checks for a phone, expectedFingerprint
//     and expectedApprover.
//
// The fingerprints and the approverKey are pinned as hex worked out on their
// own, outside this code, because the desktop app computes the same
// fingerprint (desktop/src/shared/remote/approval.ts) and has to reach the
// same string.
//
// lib/version-db is replaced with a stand-in pool, so nothing reaches the
// metadata database (or pulls in Sequelize).
import { NextRequest } from "next/server";
import type { Principal } from "@/lib/auth-guard";
import {
  MAX_STORED_SQL_CHARS,
  approverKey,
  createApprovalRequest,
  runFingerprint,
  type DeployApproval,
} from "@/lib/approvals-db";
import type { ApprovalScript } from "@/lib/approval-fingerprint";
import { BYPASS_PRINCIPAL } from "@/lib/auth-mode";
import { refusalMessage } from "@/lib/permissions";
import { FAKE_TOKEN, guardGitHub, type GitHubGuard } from "./helpers/no-github";
import { bypassAdminPrincipal, principalFor } from "./helpers/principals";

// Relative paths on purpose: next/jest rewrites the @/ alias inside import
// statements only, so jest.mock("@/...") would not resolve.
const mockPoolQuery = jest.fn<Promise<unknown>, unknown[]>(async () => ({ rows: [] }));
jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: { query: (...args: unknown[]) => mockPoolQuery(...args) },
  syncMetadataTables: async () => undefined,
}));
let mockPrincipal: Principal;
jest.mock("../lib/auth-guard", () => ({
  requirePermission: async () => ({ ok: true, principal: mockPrincipal }),
}));

type ListRoute = typeof import("../app/api/deploy/approvals/phone/route");
type ReadRoute = typeof import("../app/api/deploy/approvals/[id]/phone/route");
type DecideRoute = typeof import("../app/api/deploy/approvals/[id]/route");
let listRoute: ListRoute["GET"];
let readRoute: ReadRoute["GET"];
let decideRoute: DecideRoute["POST"];

// A name and a statement outside ASCII, so the pinned hex also pins that
// lengths count UTF-16 code units and the hash reads UTF-8.
const VECTOR_RUN: ApprovalScript[] = [
  {
    scriptName: "caf" + String.fromCodePoint(0xe9) + "_fix",
    version: "1.0.0",
    sqlContent: "SELECT '" + String.fromCodePoint(0x1f600) + "';",
  },
  { scriptName: "orders", version: "1.1.0", sqlContent: "DROP TABLE t;\n" },
];
const DEPLOY_HEX = "13ebe903a2fef8fc68e82206f4397b2f2318db3d42c22493f5f6185f6e12eb61";
const REVERT_HEX = "50fc1681c9bc0d722a1ee91d09f9fa1ce74142082c569279bdb67b35ecdbc2ad";
const PERSON_HEX = "d45e88263a7d99a043f0b997bef2fd2d48d41d5a7171c34b5663769a80457ac3";

const REQUESTED_AT = new Date("2026-10-20T09:30:00.000Z");

/** A pending deploy request for VECTOR_RUN, as pg hands it back. */
function row(over: Record<string, unknown> = {}): DeployApproval & Record<string, unknown> {
  return {
    id: 12,
    connection_id: 3,
    schema_name: "sales",
    script_name: "orders",
    target_version: "1.1.0",
    run_fingerprint: DEPLOY_HEX,
    migration_count: 2,
    breaking_count: 1,
    requested_by: "editor@test",
    requested_at: REQUESTED_AT as unknown as string,
    status: "pending",
    decided_by: null,
    decided_at: null,
    self_approved: false,
    note: "Ship before Friday",
    used_at: null,
    action: "deploy",
    expires_at: null,
    ...over,
  } as DeployApproval & Record<string, unknown>;
}

/** The SQL text and values of the n-th metadata query. */
function call(n: number): { sql: string; values: unknown[] } {
  const [sql, values] = mockPoolQuery.mock.calls[n] as [string, unknown[]];
  return { sql, values };
}

async function answerOf(res: Response): Promise<{ status: number; body: Record<string, unknown> }> {
  const text = await res.text();
  expect(text).not.toContain(FAKE_TOKEN);
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown> };
}

function newRequest(input: Partial<Parameters<typeof createApprovalRequest>[0]> = {}) {
  return createApprovalRequest({
    connectionId: 3,
    schemaName: "sales",
    scriptName: "orders",
    targetVersion: "1.1.0",
    scripts: VECTOR_RUN,
    breakingCount: 1,
    requestedBy: "editor@test",
    note: null,
    action: "deploy",
    ...input,
  });
}

let guard: GitHubGuard;

beforeAll(async () => {
  ({ GET: listRoute } = await import("../app/api/deploy/approvals/phone/route"));
  ({ GET: readRoute } = await import("../app/api/deploy/approvals/[id]/phone/route"));
  ({ POST: decideRoute } = await import("../app/api/deploy/approvals/[id]/route"));
});

beforeEach(() => {
  guard = guardGitHub();
  mockPoolQuery.mockReset();
  mockPoolQuery.mockResolvedValue({ rows: [] });
  mockPrincipal = principalFor("admin");
});

afterEach(() => {
  guard.restore();
  expect(guard.unexpected).toEqual([]);
  jest.restoreAllMocks();
});

describe("the pinned hashes", () => {
  it("give the hex the desktop app has to reach", () => {
    expect(VECTOR_RUN.map((script) => script.sqlContent.length)).toEqual([12, 14]);
    expect(VECTOR_RUN[0].scriptName.length).toBe(8);
    expect(runFingerprint(VECTOR_RUN, "deploy")).toBe(DEPLOY_HEX);
    expect(runFingerprint(VECTOR_RUN, "revert")).toBe(REVERT_HEX);
  });

  it("make one approverKey of an email however it is written", () => {
    expect(approverKey("Person@Example.test")).toBe(PERSON_HEX);
    expect(approverKey("  person@example.test ")).toBe(PERSON_HEX);
    expect(approverKey("other@example.test")).not.toBe(PERSON_HEX);
  });
});

describe("the copy of the SQL a request keeps", () => {
  it("is exactly the three fields of each script, and hashes back to the fingerprint", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row()] });
    const withExtras = VECTOR_RUN.map((script) => ({ ...script, sha: "abc123", path: "migrations/x.sql" }));
    await newRequest({ scripts: withExtras });

    const insert = call(1);
    expect(insert.sql).toContain("$11::jsonb");
    expect(typeof insert.values[10]).toBe("string");
    const kept = JSON.parse(insert.values[10] as string) as ApprovalScript[];
    expect(kept).toEqual(VECTOR_RUN);
    expect(runFingerprint(kept, "deploy")).toBe(insert.values[4]);
    expect(insert.values[4]).toBe(DEPLOY_HEX);
  });

  it("is kept for a run of exactly the most SQL, and not for one character more", async () => {
    const atCap: ApprovalScript[] = [
      { scriptName: "big", version: "1.0.0", sqlContent: "x".repeat(MAX_STORED_SQL_CHARS - 1) },
      { scriptName: "big", version: "1.0.1", sqlContent: "y" },
    ];
    await newRequest({ scripts: atCap });
    expect(JSON.parse(call(1).values[10] as string)).toEqual(atCap);

    mockPoolQuery.mockClear();
    const overCap: ApprovalScript[] = [
      { scriptName: "big", version: "1.0.0", sqlContent: "x".repeat(MAX_STORED_SQL_CHARS) },
      { scriptName: "big", version: "1.0.1", sqlContent: "y" },
    ];
    await newRequest({ scripts: overCap });
    const insert = call(1);
    // The request is still made, for the same run, just without a copy.
    expect(insert.sql).toContain("INSERT INTO deploy_approvals");
    expect(insert.values[4]).toBe(runFingerprint(overCap, "deploy"));
    expect(insert.values[10]).toBeNull();
  });

  it("is left out when PostgreSQL could not keep it as JSONB, in any field", async () => {
    const nul = String.fromCharCode(0);
    const halfPair = String.fromCharCode(0xd800);
    const runs: ApprovalScript[][] = [
      [{ scriptName: "a", version: "1.0.0", sqlContent: "SELECT 1;" + nul }],
      [{ scriptName: "a", version: "1.0.0", sqlContent: "SELECT '" + halfPair + "';" }],
      [{ scriptName: "a" + halfPair, version: "1.0.0", sqlContent: "SELECT 1;" }],
      [{ scriptName: "a", version: "1.0.0" + nul, sqlContent: "SELECT 1;" }],
    ];
    for (const scripts of runs) {
      mockPoolQuery.mockClear();
      await newRequest({ scripts });
      expect(call(1).sql).toContain("INSERT INTO deploy_approvals");
      expect(call(1).values[10]).toBeNull();
    }
  });

  it("is added to an open request that has none, when the same run is asked for again", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [row({ id: 42 })] });
    const answer = await newRequest();
    expect(answer.id).toBe(42);
    expect(mockPoolQuery).toHaveBeenCalledTimes(2);
    const update = call(1);
    expect(update.sql).toBe(
      "UPDATE deploy_approvals SET scripts = $2::jsonb WHERE id = $1 AND scripts IS NULL"
    );
    expect(update.values).toEqual([42, JSON.stringify(VECTOR_RUN)]);
  });

  it("is not written over an open request when the run is too big to keep", async () => {
    const overCap: ApprovalScript[] = [
      { scriptName: "big", version: "1.0.0", sqlContent: "x".repeat(MAX_STORED_SQL_CHARS + 1) },
    ];
    mockPoolQuery.mockResolvedValueOnce({ rows: [row({ id: 42 })] });
    await newRequest({ scripts: overCap });
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/deploy/approvals/phone", () => {
  it("answers with what the approval panel shows about each request, and no SQL", async () => {
    mockPrincipal = principalFor("admin", { email: "Person@Example.test" });
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        // pg hands a bigint back as a string of digits.
        { ...row({ id: "12", connection_id: "3", migration_count: "2", breaking_count: "1" }), has_sql: true },
        {
          ...row({
            id: 9,
            action: "revert",
            run_fingerprint: REVERT_HEX,
            requested_by: "PERSON@example.test",
            note: null,
          }),
          has_sql: false,
        },
      ],
    });

    const { status, body } = await answerOf(await listRoute());
    expect(status).toBe(200);
    expect(body).toEqual({
      approver: PERSON_HEX,
      canApprove: true,
      approvals: [
        {
          id: 12,
          connectionId: 3,
          schemaName: "sales",
          scriptName: "orders",
          targetVersion: "1.1.0",
          action: "deploy",
          migrationCount: 2,
          breakingCount: 1,
          requestedBy: "editor@test",
          requestedAt: "2026-10-20T09:30:00.000Z",
          note: "Ship before Friday",
          fingerprint: DEPLOY_HEX,
          sql: "kept",
          ownRequest: false,
        },
        {
          id: 9,
          connectionId: 3,
          schemaName: "sales",
          scriptName: "orders",
          targetVersion: "1.1.0",
          action: "revert",
          migrationCount: 2,
          breakingCount: 1,
          requestedBy: "PERSON@example.test",
          requestedAt: "2026-10-20T09:30:00.000Z",
          note: null,
          fingerprint: REVERT_HEX,
          sql: "missing",
          // Whoever asked, however their email was written that time.
          ownRequest: true,
        },
      ],
    });

    const { sql } = call(0);
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain("scripts IS NOT NULL AS has_sql");
    // Whether a copy exists, never the copy itself.
    expect(sql.replace("scripts IS NOT NULL AS has_sql", "")).not.toMatch(/\bscripts\b/);
  });

  it("says a viewer may not decide", async () => {
    mockPrincipal = principalFor("viewer");
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ ...row(), has_sql: true }] });
    const { body } = await answerOf(await listRoute());
    expect(body.canApprove).toBe(false);
    expect(body.approver).toBe(approverKey("viewer@test"));
  });

  it("calls no request the bypass's own, since the bypass may decide those", async () => {
    mockPrincipal = bypassAdminPrincipal();
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ ...row({ requested_by: BYPASS_PRINCIPAL.email }), has_sql: true }],
    });
    const { body } = await answerOf(await listRoute());
    const [approval] = body.approvals as Array<Record<string, unknown>>;
    expect(approval.ownRequest).toBe(false);
  });

  it("logs a database failure here and answers with plain words", async () => {
    const logged = jest.spyOn(console, "error").mockImplementation(() => undefined);
    mockPoolQuery.mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:5433"));
    const { status, body } = await answerOf(await listRoute());
    expect(status).toBe(500);
    expect(body).toEqual({
      error:
        "Could not read the approval requests. If this keeps happening, check that the app's database is running.",
    });
    expect(logged).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/deploy/approvals/[id]/phone", () => {
  function read(id: string) {
    return readRoute(new NextRequest(`http://localhost/api/deploy/approvals/${id}/phone`), {
      params: Promise.resolve({ id }),
    });
  }

  it("hands out the kept SQL of a deploy", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ ...row({ id: "12" }), scripts: VECTOR_RUN }] });
    const { status, body } = await answerOf(await read("12"));
    expect(status).toBe(200);
    expect(body).toEqual({ id: 12, action: "deploy", fingerprint: DEPLOY_HEX, scripts: VECTOR_RUN });
    const { sql, values } = call(0);
    expect(sql).toContain("scripts FROM deploy_approvals WHERE id = $1");
    expect(values).toEqual([12]);
  });

  it("hands out the kept SQL of a rollback, hashed the way rollbacks are", async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ ...row({ action: "revert", run_fingerprint: REVERT_HEX }), scripts: VECTOR_RUN }],
    });
    const { body } = await answerOf(await read("12"));
    expect(body).toEqual({ id: 12, action: "revert", fingerprint: REVERT_HEX, scripts: VECTOR_RUN });
  });

  it("answers null when no copy was kept", async () => {
    const warned = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ ...row(), scripts: null }] });
    const { status, body } = await answerOf(await read("12"));
    expect(status).toBe(200);
    expect(body.scripts).toBeNull();
    expect(warned).not.toHaveBeenCalled();
  });

  it("answers null, and says so in the log, when the copy does not hash back to the request", async () => {
    const warned = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const changed = VECTOR_RUN.map((script) => ({ ...script, sqlContent: "DROP DATABASE prod;" }));
    // A deploy whose copy only matches as a rollback is a mismatch too.
    for (const scripts of [changed, VECTOR_RUN]) {
      warned.mockClear();
      const fingerprint = scripts === VECTOR_RUN ? REVERT_HEX : DEPLOY_HEX;
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ ...row({ run_fingerprint: fingerprint }), scripts }] });
      const { status, body } = await answerOf(await read("12"));
      expect(status).toBe(200);
      expect(body.scripts).toBeNull();
      expect(warned).toHaveBeenCalledTimes(1);
      const words = String(warned.mock.calls[0][0]);
      expect(words).toContain("request 12");
      expect(words).not.toContain("DROP");
      expect(words).not.toContain("SELECT");
    }
  });

  it("answers null for a copy it did not write", async () => {
    const copies: unknown[] = [
      "[]",
      { scriptName: "a", version: "1.0.0", sqlContent: "SELECT 1;" },
      [{ scriptName: "a", version: 1, sqlContent: "SELECT 1;" }],
      [null],
    ];
    for (const scripts of copies) {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ ...row(), scripts }] });
      const { status, body } = await answerOf(await read("12"));
      expect(status).toBe(200);
      expect(body.scripts).toBeNull();
    }
  });

  it("needs Scripts: Read or Deploy: Read as well as Approvals: Read, and asks the database nothing without", async () => {
    mockPrincipal = principalFor("viewer", { permissions: ["approvals:read"] });
    const { status, body } = await answerOf(await read("12"));
    expect(status).toBe(403);
    expect(body).toEqual({ error: refusalMessage(mockPrincipal.roleLabel, "scripts:read") });
    expect(mockPoolQuery).not.toHaveBeenCalled();

    mockPrincipal = principalFor("viewer", { permissions: ["approvals:read", "deploy:read"] });
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ ...row(), scripts: VECTOR_RUN }] });
    expect((await read("12")).status).toBe(200);
  });

  it("turns away an id that is not one, before asking the database", async () => {
    for (const id of ["abc", "0", "-1", "1.5", ""]) {
      const { status, body } = await answerOf(await read(id));
      expect(status).toBe(400);
      expect(body).toEqual({ error: "Unknown approval." });
    }
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it("says so when the request is gone", async () => {
    const { status, body } = await answerOf(await read("12"));
    expect(status).toBe(404);
    expect(body).toEqual({ error: "That approval no longer exists." });
  });

  it("logs a database failure here and answers with plain words", async () => {
    const logged = jest.spyOn(console, "error").mockImplementation(() => undefined);
    mockPoolQuery.mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:5433"));
    const { status, body } = await answerOf(await read("12"));
    expect(status).toBe(500);
    expect(body).toEqual({
      error:
        "Could not read that approval request. If this keeps happening, check that the app's database is running.",
    });
    expect(logged).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/deploy/approvals/[id] from a phone", () => {
  function decide(body: Record<string, unknown>) {
    return decideRoute(
      new NextRequest("http://localhost/api/deploy/approvals/12", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: "12" }) }
    );
  }

  beforeEach(() => {
    mockPrincipal = principalFor("admin", { email: "Person@Example.test" });
  });

  it("records the decision while the run and the person both match, with no note of its own", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [row()] })
      .mockResolvedValueOnce({ rows: [row({ status: "approved", decided_by: "Person@Example.test" })] });
    const { status } = await answerOf(
      await decide({ decision: "approve", expectedFingerprint: DEPLOY_HEX, expectedApprover: PERSON_HEX })
    );
    expect(status).toBe(200);
    const update = call(1);
    expect(update.sql).toContain("UPDATE deploy_approvals");
    expect(update.values.slice(0, 3)).toEqual([12, "approved", "Person@Example.test"]);
    // COALESCE keeps the note the request was made with.
    expect(update.values[4]).toBeNull();
  });

  it("records a rejection the same way", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [row()] })
      .mockResolvedValueOnce({ rows: [row({ status: "rejected" })] });
    const { status } = await answerOf(
      await decide({ decision: "reject", expectedFingerprint: DEPLOY_HEX, expectedApprover: PERSON_HEX })
    );
    expect(status).toBe(200);
    expect(call(1).values[1]).toBe("rejected");
  });

  it("changes nothing when the request is for other SQL than the phone read", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [row()] });
    const { status, body } = await answerOf(
      await decide({ decision: "approve", expectedFingerprint: REVERT_HEX, expectedApprover: PERSON_HEX })
    );
    expect(status).toBe(412);
    expect(body).toEqual({
      error: "This request is not for the SQL that was read before deciding. Read it again, then decide.",
    });
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
  });

  it("changes nothing when somebody else is signed in than the person who set up the phone", async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [row()] });
    const { status, body } = await answerOf(
      await decide({
        decision: "approve",
        expectedFingerprint: DEPLOY_HEX,
        expectedApprover: approverKey("someone-else@example.test"),
      })
    );
    expect(status).toBe(412);
    expect(body).toEqual({
      error:
        "The person signed in is not the one who set up approvals on that phone, so the decision was not recorded.",
    });
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
  });

  it("turns away a field that is not a SHA-256 in lowercase hex, before reading anything", async () => {
    const wrong: unknown[] = [DEPLOY_HEX.toUpperCase(), DEPLOY_HEX.slice(1), 42, null, ""];
    for (const value of wrong) {
      const fingerprint = await answerOf(
        await decide({ decision: "approve", expectedFingerprint: value, expectedApprover: PERSON_HEX })
      );
      expect(fingerprint).toEqual({
        status: 400,
        body: { error: "expectedFingerprint must be 64 lowercase hex characters." },
      });
      const approver = await answerOf(
        await decide({ decision: "approve", expectedFingerprint: DEPLOY_HEX, expectedApprover: value })
      );
      expect(approver).toEqual({
        status: 400,
        body: { error: "expectedApprover must be 64 lowercase hex characters." },
      });
    }
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it("works as before for the Deploy screen, which sends neither field", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [row()] })
      .mockResolvedValueOnce({ rows: [row({ status: "approved" })] });
    const { status } = await answerOf(await decide({ decision: "approve", note: "Looks fine" }));
    expect(status).toBe(200);
    expect(call(1).values[4]).toBe("Looks fine");
  });
});
