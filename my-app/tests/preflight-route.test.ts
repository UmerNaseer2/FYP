// POST /api/scripts/preflight: what Deploy reads before offering a deploy or
// a rollback. These tests cover the rollback half: which versions really have
// a rollback, the rollback history, and later scripts from other families.
//
// The target database is the fake client from helpers/fake-pg. Nothing here
// reaches a real database or GitHub.
import { NextRequest } from "next/server";
import { createFakeClient, queriesMatching, type FakeClient, type FakeStep } from "./helpers/fake-pg";
import { FAKE_TOKEN, guardGitHub, type GitHubGuard } from "./helpers/no-github";

// Relative paths on purpose: next/jest rewrites the @/ alias inside import
// statements only, so jest.mock("@/...") would not resolve.
jest.mock("../lib/auth-guard", () => ({
  requireViewer: async () => ({ ok: true, principal: null }),
}));

const mockPoolQuery = jest.fn<Promise<unknown>, unknown[]>(async () => ({ rows: [] }));
jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: { query: (...args: unknown[]) => mockPoolQuery(...args) },
  syncMetadataTables: async () => undefined,
}));

let mockClient: FakeClient;
jest.mock("../lib/postgres", () => ({
  getPoolForConfig: () => ({ connect: async () => mockClient }),
}));
jest.mock("../lib/connection-config", () => ({ buildPgConfig: () => ({}) }));

type RouteModule = typeof import("../app/api/scripts/preflight/route");
let POST: RouteModule["POST"];

const CONNECTION = {
  host: "db.test", port: 5432, database_name: "sales", username: "app",
  password: "not-a-real-password", connection_string: null, ssl: false,
  ssl_mode: "disable", name: "Sales dev",
};

const REVERTED = [
  {
    script_name: "orders_fix", version: "3.0.0", title: "Rename a column", change_type: "patch",
    applied_at: "2026-03-01T00:00:00.000Z", reverted_at: "2026-04-01T00:00:00.000Z",
  },
];

function timelineRow(version: string, down_sql: string | null) {
  return {
    version, title: `v${version}`, description: null, change_type: "additive",
    applied_at: "2026-01-01T00:00:00.000Z", down_sql,
  };
}

/** A target whose answers the test chooses. */
function target(options: {
  ledger?: boolean;
  revertedTable?: boolean;
  timeline?: Record<string, unknown>[];
  others?: Record<string, unknown>[];
}): FakeStep[] {
  return [
    { match: /information_schema\.tables/, rows: [{ exists: options.ledger !== false }] },
    { match: /to_regclass/, rows: [{ reg: options.revertedTable ? '"sales".script_patch_reverted' : null }] },
    { match: /FROM "sales"\.script_patch_reverted/, rows: options.revertedTable ? REVERTED : [] },
    { match: /column_name = 'down_sql'/, rows: [{ column_name: "down_sql" }] },
    { match: /script_name <> \$1/, rows: options.others ?? [] },
    { match: /SELECT\s+version,\s+title,\s+description/, rows: options.timeline ?? [] },
  ];
}

async function preflight(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await POST(
    new NextRequest("http://localhost/api/scripts/preflight", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
  const text = await res.text();
  expect(text).not.toContain(FAKE_TOKEN);
  expect(text).not.toContain("not-a-real-password");
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown> };
}

const FAMILY = { connectionId: 7, schemaName: "sales", scriptName: "orders_fix" };

let guard: GitHubGuard;

beforeAll(async () => {
  ({ POST } = await import("../app/api/scripts/preflight/route"));
});

beforeEach(() => {
  guard = guardGitHub();
  mockPoolQuery.mockReset();
  mockPoolQuery.mockResolvedValue({ rows: [CONNECTION] });
});

afterEach(() => {
  guard.restore();
  expect(guard.unexpected).toEqual([]);
});

it("counts only a rollback with a statement that runs", async () => {
  mockClient = createFakeClient(
    target({
      timeline: [
        timelineRow("3.0.0", "-- nothing to undo\n"),
        timelineRow("2.0.0", "DROP TABLE t2;"),
        timelineRow("1.0.0", null),
      ],
    })
  );
  const res = await preflight(FAMILY);
  expect(res.status).toBe(200);
  const timeline = res.body.timeline as { version: string; has_down_sql: boolean; down_sql: string | null }[];
  expect(timeline.map((entry) => [entry.version, entry.has_down_sql])).toEqual([
    ["3.0.0", false],
    ["2.0.0", true],
    ["1.0.0", false],
  ]);
  // The text still travels, so the operator can read what would run.
  expect(timeline[1].down_sql).toBe("DROP TABLE t2;");
});

it("returns an empty history when the schema never had a rollback", async () => {
  mockClient = createFakeClient(target({ timeline: [timelineRow("1.0.0", "DROP TABLE t1;")] }));
  const res = await preflight(FAMILY);
  expect(res.body.reverted).toEqual([]);
  expect(queriesMatching(mockClient, /FROM "sales"\.script_patch_reverted/)).toHaveLength(0);
});

it("returns the family's history, newest first, even when nothing is applied now", async () => {
  mockClient = createFakeClient(target({ revertedTable: true, timeline: [] }));
  const res = await preflight(FAMILY);
  expect(res.status).toBe(200);
  expect(res.body.timeline).toEqual([]);
  expect(res.body.reverted).toEqual(REVERTED);
  expect(res.body.otherScripts).toEqual([]);

  const history = queriesMatching(mockClient, /FROM "sales"\.script_patch_reverted/)[0];
  expect(history.values).toEqual(["orders_fix"]);
  expect(history.text).toMatch(/ORDER BY reverted_at DESC, id DESC\s+LIMIT 50/);
  expect(queriesMatching(mockClient, /script_name <> \$1/)).toHaveLength(0);
});

it("returns the history when the schema has no script_patch at all", async () => {
  mockClient = createFakeClient(target({ ledger: false, revertedTable: true }));
  const res = await preflight(FAMILY);
  expect(res.body).toMatchObject({ hasVersionTable: false, timeline: [], otherScripts: [] });
  expect(res.body.reverted).toEqual(REVERTED);
});

it("lists other families applied after this family's first version", async () => {
  const others = [{ script_name: "billing_fix", version: "1.1.0", applied_at: "2026-02-01T00:00:00.000Z" }];
  mockClient = createFakeClient(target({ timeline: [timelineRow("1.0.0", "DROP TABLE t1;")], others }));
  const res = await preflight(FAMILY);
  expect(res.body.otherScripts).toEqual(others);

  // The family itself and anything written before its first apply stay out.
  // Rows one deploy wrote share one applied_at, so the ledger id breaks ties.
  const query = queriesMatching(mockClient, /script_name <> \$1/)[0];
  expect(query.values).toEqual(["orders_fix"]);
  const sql = query.text.replace(/\s+/g, " ");
  expect(sql).toContain("WHERE script_name = $1 AND applied_at IS NOT NULL ORDER BY applied_at, id LIMIT 1");
  expect(sql).toContain("other.applied_at = oldest.applied_at AND other.id > oldest.id");
  expect(sql).toContain("ORDER BY other.applied_at, other.id LIMIT 200");
});

it("reads the whole schema's history and no other-family list without a scriptName", async () => {
  mockClient = createFakeClient(target({ revertedTable: true, timeline: [timelineRow("1.0.0", null)] }));
  const res = await preflight({ connectionId: 7, schemaName: "sales" });
  expect(res.body.otherScripts).toEqual([]);
  expect(queriesMatching(mockClient, /FROM "sales"\.script_patch_reverted/)[0].values).toEqual([null]);
  expect(queriesMatching(mockClient, /script_name <> \$1/)).toHaveLength(0);
});
