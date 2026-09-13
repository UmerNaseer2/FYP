// Approvals know whether they clear a deploy or a rollback.
//
// A production rollback needs a second person just like a deploy, and it
// reuses deploy_approvals with an `action` column. These tests pin the three
// places the two kinds must never be confused: the fingerprint, the queries
// that find or spend an approval, and the refusal copy.
//
// lib/version-db is replaced with a stand-in pool, so nothing reaches the
// metadata database (or pulls in Sequelize).
import { NextRequest } from "next/server";
import {
  claimApproval,
  createApprovalRequest,
  decisionBlockReason,
  runFingerprint,
  type DeployApproval,
} from "@/lib/approvals-db";
import { fingerprintBody, rollbackFingerprintBody, type ApprovalScript } from "@/lib/approval-fingerprint";
import { FAKE_TOKEN, guardGitHub, type GitHubGuard } from "./helpers/no-github";

// Relative paths on purpose: next/jest rewrites the @/ alias inside import
// statements only, so jest.mock("@/...") would not resolve.
const mockPoolQuery = jest.fn<Promise<unknown>, unknown[]>(async () => ({ rows: [] }));
jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: { query: (...args: unknown[]) => mockPoolQuery(...args) },
  syncMetadataTables: async () => undefined,
}));
jest.mock("../lib/auth-guard", () => ({
  requireEditor: async () => ({ ok: true, principal: { email: "a@test", bypass: false } }),
  requireViewer: async () => ({ ok: true, principal: null }),
}));

type RouteModule = typeof import("../app/api/deploy/approvals/route");
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
  ({ POST } = await import("../app/api/deploy/approvals/route"));
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
});

describe("queries", () => {
  it("claimApproval only spends an approval of the same action", async () => {
    const claimed = await claimApproval({ connectionId: 7, schemaName: "sales", scripts: RUN, action: "revert" });
    expect(claimed).toBeNull();
    const { sql, values } = call(0);
    expect(sql).toContain("action = $4");
    expect(values).toEqual([7, "sales", runFingerprint(RUN, "revert"), "revert"]);
  });

  it("createApprovalRequest matches and stores the action", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 1, action: "revert" }] });
    await createApprovalRequest({
      connectionId: 7, schemaName: "sales", scriptName: "orders_fix", targetVersion: "2.0.0",
      scripts: RUN, breakingCount: 1, requestedBy: "a@test", note: null, action: "revert",
    });
    const dedupe = call(0);
    expect(dedupe.sql).toContain("action = $4");
    expect(dedupe.values[3]).toBe("revert");
    const insert = call(1);
    expect(insert.sql).toMatch(/note, action\)/);
    expect(insert.values[4]).toBe(runFingerprint(RUN, "revert"));
    expect(insert.values[9]).toBe("revert");
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
    connectionId: 7,
    schemaName: "sales",
    scriptName: "orders_fix",
    targetVersion: "2.0.0",
    breakingCount: 1,
    scripts: RUN.map((s) => ({ script_name: s.scriptName, version: s.version, sql_content: s.sqlContent })),
  };

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

  it("says 'rollbacks' when a rollback request has nothing in it", async () => {
    const res = await request({ ...BODY, scripts: [], action: "revert" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("There are no rollbacks in this request to approve.");
  });
});
