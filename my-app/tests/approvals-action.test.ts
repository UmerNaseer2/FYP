// Approvals know whether they clear a deploy or a rollback.
//
// A production rollback needs a second person just like a deploy, and it
// reuses deploy_approvals with an `action` column. These tests pin the three
// places the two kinds must never be confused: the fingerprint, the queries
// that find or spend an approval, and the refusal copy. They also pin the
// organization: every statement names it, and a request can only be written
// for a connection the caller's organization owns.
//
// lib/version-db is replaced with a stand-in pool, so nothing reaches the
// metadata database (or pulls in Sequelize).
import { NextRequest } from "next/server";
import {
  APPROVAL_VALID_HOURS,
  claimApproval,
  createApprovalRequest,
  decideApproval,
  decisionBlockReason,
  mayDecideOwn,
  releaseApproval,
  runFingerprint,
  type DeployApproval,
} from "@/lib/approvals-db";
import { fingerprintBody, rollbackFingerprintBody, type ApprovalScript } from "@/lib/approval-fingerprint";
import { FAKE_TOKEN, guardGitHub, type GitHubGuard } from "./helpers/no-github";
import { TEST_ORG } from "./helpers/principals";

// Relative paths on purpose: next/jest rewrites the @/ alias inside import
// statements only, so jest.mock("@/...") would not resolve.
const mockPoolQuery = jest.fn<Promise<unknown>, unknown[]>(async () => ({ rows: [] }));
jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: { query: (...args: unknown[]) => mockPoolQuery(...args) },
  syncMetadataTables: async () => undefined,
}));
jest.mock("../lib/auth-guard", () => ({
  requirePermission: async () => ({
    ok: true,
    principal: require("./helpers/principals").principalFor("editor", { email: "a@test" }),
  }),
}));

type RouteModule = typeof import("../app/api/deploy/approvals/route");
let GET: RouteModule["GET"];
let POST: RouteModule["POST"];

const RUN: ApprovalScript[] = [
  { scriptName: "orders_fix", version: "3.0.0", sqlContent: "DROP TABLE t3;" },
  { scriptName: "orders_fix", version: "2.0.0", sqlContent: "DROP TABLE t2;" },
];

/** The SQL text and values of the n-th metadata query. */
function call(n: number): { sql: string; values: unknown[] } {
  const [sql, values] = mockPoolQuery.mock.calls[n] as [string, unknown[]];
  return { sql, values };
}

let guard: GitHubGuard;

beforeAll(async () => {
  ({ GET, POST } = await import("../app/api/deploy/approvals/route"));
});

beforeEach(() => {
  guard = guardGitHub();
  mockPoolQuery.mockReset();
  mockPoolQuery.mockResolvedValue({ rows: [] });
});

afterEach(() => {
  guard.restore();
  expect(guard.unexpected).toEqual([]);
});

describe("fingerprints", () => {
  it("differ between a deploy and a rollback of the same scripts", () => {
    const deploy = runFingerprint(RUN, "deploy");
    const revert = runFingerprint(RUN, "revert");
    expect(deploy).toMatch(/^[0-9a-f]{64}$/);
    expect(revert).toMatch(/^[0-9a-f]{64}$/);
    expect(deploy).not.toBe(revert);
  });

  it("name what they cover in the header", () => {
    expect(rollbackFingerprintBody(RUN).startsWith("2 rollbacks")).toBe(true);
    expect(fingerprintBody(RUN).startsWith("2 migrations")).toBe(true);
  });
});

describe("decisionBlockReason", () => {
  const approval = (action: "deploy" | "revert") =>
    ({ status: "pending", requested_by: "a@test", action }) as unknown as DeployApproval;

  it("refuses a self-approval with copy that says which kind it is", () => {
    expect(decisionBlockReason(approval("revert"), "A@test", false)).toBe(
      "You asked for this rollback, so you cannot approve it. A rollback on production needs a second person."
    );
    expect(decisionBlockReason(approval("deploy"), "a@test", false)).toBe(
      "You asked for this deploy, so you cannot approve it. A production run needs a second person."
    );
  });

  it("lets a second person decide either kind", () => {
    expect(decisionBlockReason(approval("revert"), "b@test", false)).toBeNull();
    expect(decisionBlockReason(approval("deploy"), "b@test", false)).toBeNull();
  });

  it("lets the requester decide when self-approval is allowed", () => {
    expect(decisionBlockReason(approval("deploy"), "a@test", true)).toBeNull();
  });
});

describe("mayDecideOwn", () => {
  it("allows a self-approval only under the bypass or with the two-person rule off", () => {
    expect(mayDecideOwn({ bypass: false, orgTwoPersonRule: true })).toBe(false);
    expect(mayDecideOwn({ bypass: true, orgTwoPersonRule: true })).toBe(true);
    expect(mayDecideOwn({ bypass: false, orgTwoPersonRule: false })).toBe(true);
  });
});

describe("queries", () => {
  it("claimApproval only spends an approval of the same action", async () => {
    const claimed = await claimApproval({
      orgId: TEST_ORG.id, connectionId: 3, schemaName: "sales", scripts: RUN, action: "revert",
    });
    expect(claimed).toBeNull();
    const { sql, values } = call(0);
    expect(sql).toContain("action = $4");
    expect(values).toEqual([3, "sales", runFingerprint(RUN, "revert"), "revert", TEST_ORG.id]);
  });

  it("claimApproval only spends an approval given in the run's organization", async () => {
    await claimApproval({
      orgId: TEST_ORG.id, connectionId: 3, schemaName: "sales", scripts: RUN, action: "deploy",
    });
    // In the inner SELECT that picks the row, so a matching approval from
    // another organization is never the one marked used.
    const { sql, values } = call(0);
    expect(sql).toMatch(/SELECT id FROM deploy_approvals[\s\S]*AND org_id = \$5/);
    expect(values[4]).toBe(TEST_ORG.id);
  });

  it("releaseApproval only hands back an approval in the organization", async () => {
    await releaseApproval(TEST_ORG.id, 12);
    const { sql, values } = call(0);
    expect(sql).toContain("WHERE id = $1 AND org_id = $2 AND status = 'used'");
    expect(values).toEqual([12, TEST_ORG.id]);
  });

  it("createApprovalRequest matches and stores the action", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 1, action: "revert" }] });
    await createApprovalRequest({
      orgId: TEST_ORG.id,
      connectionId: 3, schemaName: "sales", scriptName: "orders_fix", targetVersion: "2.0.0",
      scripts: RUN, breakingCount: 1, requestedBy: "a@test", note: null, action: "revert",
    });
    const dedupe = call(0);
    expect(dedupe.sql).toContain("action = $4");
    expect(dedupe.values[3]).toBe("revert");
    const insert = call(1);
    expect(insert.sql).toMatch(/note, action, scripts\)/);
    expect(insert.values[4]).toBe(runFingerprint(RUN, "revert"));
    expect(insert.values[9]).toBe("revert");
  });

  it("createApprovalRequest writes into the connection's organization, and only the caller's", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 1 }] });
    await createApprovalRequest({
      orgId: TEST_ORG.id,
      connectionId: 3, schemaName: "sales", scriptName: "orders_fix", targetVersion: "2.0.0",
      scripts: RUN, breakingCount: 1, requestedBy: "a@test", note: null, action: "deploy",
    });
    // An open request from another organization is never handed back as this one.
    const dedupe = call(0);
    expect(dedupe.sql).toContain("AND org_id = $5");
    expect(dedupe.values[4]).toBe(TEST_ORG.id);
    // The organization is read off the connection row, and the row is only
    // there to read when the caller's organization owns it.
    const insert = call(1);
    expect(insert.sql).toContain("(org_id, connection_id,");
    expect(insert.sql).toContain("SELECT c.org_id, c.id,");
    expect(insert.sql).toContain("FROM connections c");
    expect(insert.sql).toContain("WHERE c.id = $1 AND c.org_id = $12");
    expect(insert.values[0]).toBe(3);
    expect(insert.values[11]).toBe(TEST_ORG.id);
  });

  it("createApprovalRequest answers null when no connection of the organization matched", async () => {
    // What PostgreSQL answers for another organization's connection, or a
    // deleted one: the SELECT finds nothing, so nothing is inserted.
    const made = await createApprovalRequest({
      orgId: TEST_ORG.id,
      connectionId: 3, schemaName: "sales", scriptName: "orders_fix", targetVersion: "2.0.0",
      scripts: RUN, breakingCount: 1, requestedBy: "a@test", note: null, action: "deploy",
    });
    expect(made).toBeNull();
  });
});

describe("POST /api/deploy/approvals", () => {
  async function request(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await POST(
      new NextRequest("http://localhost/api/deploy/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    );
    const text = await res.text();
    expect(text).not.toContain(FAKE_TOKEN);
    return { status: res.status, body: JSON.parse(text) as Record<string, unknown> };
  }

  const BODY = {
    connectionId: 3,
    schemaName: "sales",
    scriptName: "orders_fix",
    targetVersion: "2.0.0",
    scripts: RUN.map((s) => ({ script_name: s.scriptName, version: s.version, sql_content: s.sqlContent })),
  };

  /** Answer the dedupe read and the INSERT, then send the request. */
  async function recorded(body: Record<string, unknown>) {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 1 }] });
    return request(body);
  }

  // breaking_count is the INSERT's seventh value.
  const storedBreakingCount = () => call(1).values[6];

  it("counts the breaking migrations from the SQL, ignoring a count the caller sends", async () => {
    const res = await recorded({
      ...BODY,
      breakingCount: 99,
      scripts: [
        { script_name: "orders_fix", version: "3.0.0", sql_content: "DROP TABLE t3;" },
        { script_name: "orders_fix", version: "2.0.0", sql_content: "CREATE TABLE t2 (id int);" },
      ],
    });
    expect(res.status).toBe(200);
    expect(storedBreakingCount()).toBe(1);
  });

  it("lets a script's change_type raise it to breaking, never lower it", async () => {
    const res = await recorded({
      ...BODY,
      scripts: [
        // "additive" cannot quiet a DROP TABLE...
        { script_name: "orders_fix", version: "3.0.0", sql_content: "DROP TABLE t3;", change_type: "additive" },
        // ...and "breaking" makes a CREATE TABLE count.
        {
          script_name: "orders_fix", version: "2.0.0",
          sql_content: "CREATE TABLE t2 (id int);", change_type: "breaking",
        },
      ],
    });
    expect(res.status).toBe(200);
    expect(storedBreakingCount()).toBe(2);
  });

  it("counts, for a rollback, the rollbacks that delete rows", async () => {
    const res = await recorded({
      ...BODY,
      action: "revert",
      breakingCount: 0,
      scripts: [
        // TRUNCATE deletes rows without being graded breaking; a CREATE INDEX does neither.
        { script_name: "orders_fix", version: "3.0.0", sql_content: "TRUNCATE t3;" },
        { script_name: "orders_fix", version: "2.0.0", sql_content: "CREATE INDEX i2 ON t2 (id);" },
      ],
    });
    expect(res.status).toBe(200);
    expect(storedBreakingCount()).toBe(1);
  });

  it("refuses an action it does not know, before touching the database", async () => {
    const res = await request({ ...BODY, action: "delete" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('action must be "deploy" or "revert".');
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it("passes a rollback request through as 'revert'", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 1, action: "revert" }] });
    const res = await request({ ...BODY, action: "revert" });
    expect(res.status).toBe(200);
    expect(call(1).values[9]).toBe("revert");
    expect(call(1).values[4]).toBe(runFingerprint(RUN, "revert"));
  });

  it("treats a request with no action as a deploy", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 1, action: "deploy" }] });
    const res = await request(BODY);
    expect(res.status).toBe(200);
    expect(call(1).values[9]).toBe("deploy");
  });

  it("refuses a rollback of more versions than the revert route accepts, before touching the database", async () => {
    const scripts = Array.from({ length: 51 }, (_, index) => ({
      script_name: "orders_fix",
      version: `${51 - index}.0.0`,
      sql_content: "DROP TABLE t;",
    }));
    const res = await request({ ...BODY, scripts, action: "revert" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      "A rollback can undo at most 50 versions at a time, and this request lists 51, so it was not " +
        "sent for approval. Roll back in steps of at most 50 versions, and ask for approval of each."
    );
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it("answers not found for a connection the caller's organization does not own", async () => {
    // The dedupe read and the INSERT both find nothing, as they do for
    // another organization's connection.
    const res = await request(BODY);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Connection not found." });
    expect(call(1).sql).toContain("INSERT INTO deploy_approvals");
    expect(call(1).values[11]).toBe(TEST_ORG.id);
  });

  it("says 'rollbacks' when a rollback request has nothing in it", async () => {
    const res = await request({ ...BODY, scripts: [], action: "revert" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("There are no rollbacks in this request to approve.");
  });
});

describe("GET /api/deploy/approvals", () => {
  it("lists only the caller's organization's requests", async () => {
    const res = await GET(
      new NextRequest("http://localhost/api/deploy/approvals?connectionId=3&schemaName=sales")
    );
    expect(res.status).toBe(200);
    const { sql, values } = call(0);
    expect(sql).toContain("AND org_id = $4");
    expect(values).toEqual([3, "sales", null, TEST_ORG.id]);
  });
});

// ─── How long an approval lasts ────────────────────────────────────────────
// The fingerprint pins WHAT was approved but says nothing about WHEN, so an
// approval given a month ago used to still unlock the same production run.
// These read the SQL the module sends, because the predicate is enforced by
// PostgreSQL inside the one race-free UPDATE — there is no branch in
// TypeScript to call instead.

describe("expiry", () => {
  it("lasts a week", () => {
    expect(APPROVAL_VALID_HOURS).toBe(168);
  });

  it("starts the clock when the approval is given, not when it was asked for", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [{ id: 5 }] });
    await decideApproval({
      orgId: TEST_ORG.id, id: 5, approve: true, decidedBy: "b@test", selfApproved: false, note: null,
    });
    const { sql, values } = call(0);
    expect(sql).toContain("expires_at = CASE WHEN $6 THEN now() + make_interval(hours => $7) END");
    expect(values[5]).toBe(true);
    expect(values[6]).toBe(APPROVAL_VALID_HOURS);
    // Only a request in the decider's organization is ever written.
    expect(sql).toContain("WHERE id = $1 AND org_id = $8 AND status = 'pending'");
    expect(values[7]).toBe(TEST_ORG.id);
  });

  it("gives a rejection no expiry, because there is nothing to expire", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [{ id: 5 }] });
    await decideApproval({
      orgId: TEST_ORG.id, id: 5, approve: false, decidedBy: "b@test", selfApproved: false, note: null,
    });
    // The CASE has no ELSE, so a false here writes NULL.
    expect(call(0).values[5]).toBe(false);
  });

  it("will not spend an approval that is past its expiry", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    await claimApproval({
      orgId: TEST_ORG.id, connectionId: 3, schemaName: "sales", scripts: RUN, action: "deploy",
    });
    const { sql } = call(0);
    expect(sql).toContain("(expires_at IS NULL OR expires_at > now())");
    // Inside the same UPDATE as the status check, so an approval cannot expire
    // between being found and being marked used.
    expect(sql.indexOf("expires_at IS NULL")).toBeGreaterThan(sql.indexOf("status = 'approved'"));
  });

  it("leaves an approval decided before expiry existed alone", async () => {
    // A row whose expires_at is NULL was decided when nobody had been told
    // there was a deadline, so the predicate keeps it claimable.
    mockPoolQuery.mockResolvedValue({ rows: [] });
    await claimApproval({
      orgId: TEST_ORG.id, connectionId: 3, schemaName: "sales", scripts: RUN, action: "deploy",
    });
    expect(call(0).sql).toContain("expires_at IS NULL OR");
  });

  it("does not offer an expired approval as an open request", async () => {
    // Otherwise the screen would say "approved" about a run whose Deploy
    // button then asks for approval.
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 1 }] });
    await createApprovalRequest({
      orgId: TEST_ORG.id,
      connectionId: 3, schemaName: "sales", scriptName: "orders_fix", targetVersion: "3.0.0",
      scripts: RUN, breakingCount: 0, requestedBy: "a@test", note: null, action: "deploy",
    });
    expect(call(0).sql).toContain("(expires_at IS NULL OR expires_at > now())");
  });
});
