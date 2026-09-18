// POST /api/scripts/apply: which ALTER TYPE … ADD VALUE statements run ahead
// of the run's transaction.
//
// PostgreSQL will not let a label added by ALTER TYPE … ADD VALUE be USED later
// in the transaction that added it, so the route runs those statements first,
// on their own. That hoist used to take every such statement in the run —
// including ones naming a type the run itself was about to CREATE. Those fail
// with "type … does not exist" before a single migration has run, and they
// never needed hoisting: a type created inside the transaction can have labels
// added and used there and then. The hoist now asks the target first.
//
// The target database is the fake client from helpers/fake-pg. Nothing here
// reaches a real database or GitHub.
import { NextRequest } from "next/server";
import { createFakeClient, queryTexts, type FakeClient, type FakeStep } from "./helpers/fake-pg";
import { FAKE_TOKEN, guardGitHub, type GitHubGuard } from "./helpers/no-github";

// Relative paths on purpose: next/jest rewrites the @/ alias inside import
// statements only, so jest.mock("@/...") would not resolve.
jest.mock("../lib/auth-guard", () => ({
  requireEditor: async () => ({ ok: true, principal: { email: "a@test", role: "editor", bypass: false } }),
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
jest.mock("../lib/lineage-db", () => ({
  findTrackedSchema: async () => null,
  recordAppliedMigrationToLineage: async () => ({ advanced: false }),
}));

// The GitHub registry. The apply route records every committed version there
// (spec 07), and the real module reads GITHUB_PAT / GITHUB_REPO_OWNER /
// GITHUB_REPO_NAME out of .env.local — which next/jest loads exactly as
// `next dev` does. Left unmocked, a test that reaches COMMIT would write
// migration files into somebody's actual registry repository. Mocked to answer
// "not configured", which is the same answer a server with no GitHub settings
// gives, so the route takes its ordinary path.
jest.mock("../lib/registry-archive", () => ({
  archiveAppliedVersions: async () => null,
}));
jest.mock("../lib/approvals-db", () => ({
  claimApproval: async () => null,
  releaseApproval: async () => undefined,
}));

type RouteModule = typeof import("../app/api/scripts/apply/route");
let POST: RouteModule["POST"];

const CONNECTION = {
  host: "db.test", port: 5432, database_name: "sales", username: "app",
  password: "not-a-real-password", connection_string: null, ssl: false,
  ssl_mode: "disable", environment: "dev",
};

/** A run of one script, named after nothing in particular. */
function run(sqlContent: string): Record<string, unknown> {
  return {
    connectionId: 7,
    schemaName: "sales",
    scripts: [
      { script_name: "enum_fix", version: "1.0.0", sql_content: sqlContent, down_sql: "-- none\n" },
    ],
  };
}

/**
 * The target's answers: the schema exists, the ledger insert works, and
 * to_regtype says which type names are already there.
 *
 * A name not listed is answered NULL, which is what a real server says for a
 * type that does not exist yet.
 */
function target(present: string[], first: FakeStep[] = []): FakeStep[] {
  return [
    ...first,
    {
      match: /to_regtype/,
      when: (values) => present.includes(String(values[0])),
      rows: [{ present: true }],
    },
    { match: /to_regtype/, rows: [{ present: null }] },
    { match: /information_schema\.schemata/, rows: [{ exists: 1 }] },
    {
      match: /INSERT INTO "sales"\.script_patch/,
      rows: [{ applied_at: "2026-09-11T00:00:00.000Z" }],
    },
  ];
}

async function apply(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await POST(
    new NextRequest("http://localhost/api/scripts/apply", {
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

/** The queries sent before BEGIN — everything the hoist is responsible for. */
function beforeTransaction(): string[] {
  const texts = queryTexts(mockClient);
  const begin = texts.indexOf("BEGIN");
  return begin === -1 ? texts : texts.slice(0, begin);
}

let guard: GitHubGuard;
let consoleSpy: jest.SpyInstance;
let logSpy: jest.SpyInstance;

beforeAll(async () => {
  ({ POST } = await import("../app/api/scripts/apply/route"));
});

beforeEach(() => {
  guard = guardGitHub();
  mockPoolQuery.mockReset();
  mockPoolQuery.mockResolvedValue({ rows: [CONNECTION] });
  mockClient = createFakeClient(target([]));
  consoleSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  consoleSpy.mockRestore();
  logSpy.mockRestore();
  guard.restore();
  expect(guard.unexpected).toEqual([]);
});

const EXTEND_EXISTING = [
  "ALTER TYPE order_state ADD VALUE IF NOT EXISTS 'refunded';",
  "CREATE INDEX refunds ON orders (id) WHERE state <> 'refunded';",
].join("\n");

const CREATE_THEN_EXTEND = [
  "CREATE TYPE ship_state AS ENUM ('packing');",
  "ALTER TYPE ship_state ADD VALUE IF NOT EXISTS 'sent';",
].join("\n");

it("hoists an ADD VALUE for a type the target already has", async () => {
  mockClient = createFakeClient(target(["order_state"]));
  const res = await apply(run(EXTEND_EXISTING));

  expect(res.status).toBe(200);
  const early = beforeTransaction();
  // Between the search_path that makes the unqualified name resolve and the
  // RESET that puts the session back for the next borrower of this client.
  expect(early).toContain('SET search_path TO "sales"');
  expect(early).toContain("ALTER TYPE order_state ADD VALUE IF NOT EXISTS 'refunded';");
  expect(early).toContain("RESET search_path");
});

it("leaves an ADD VALUE for a type the same run creates", async () => {
  // Nothing is present, so the ALTER would be the "type does not exist" case.
  // Anchored, so it only answers the hoisted statement: the script body itself
  // arrives as one query that starts with CREATE TYPE.
  mockClient = createFakeClient(
    target([], [
      {
        match: /^\s*ALTER TYPE ship_state ADD VALUE/,
        error: { code: "42704", message: 'type "ship_state" does not exist' },
      },
    ])
  );
  const res = await apply(run(CREATE_THEN_EXTEND));

  expect(res.status).toBe(200);
  expect(beforeTransaction().some((text) => /^ALTER TYPE/.test(text))).toBe(false);
  // The statement is not dropped — it runs inside the transaction, in the
  // script, after the CREATE TYPE that gives it something to alter.
  expect(queryTexts(mockClient)).toContain(CREATE_THEN_EXTEND.replace(/\s+/g, " "));
});

it("hoists only the additions whose type exists when a run does both", async () => {
  mockClient = createFakeClient(target(["order_state"]));
  const res = await apply(run(`${CREATE_THEN_EXTEND}\n${EXTEND_EXISTING}`));

  expect(res.status).toBe(200);
  const hoisted = beforeTransaction().filter((text) => /^ALTER TYPE/.test(text));
  expect(hoisted).toEqual(["ALTER TYPE order_state ADD VALUE IF NOT EXISTS 'refunded';"]);
});

it("asks about the type by the name the statement writes", async () => {
  // Quoted and schema-qualified names have to reach to_regtype as written, or
  // a type called "Order State" would read as two words and never be found.
  mockClient = createFakeClient(target(['sales."Order State"']));
  const res = await apply(
    run(`ALTER TYPE sales."Order State" ADD VALUE IF NOT EXISTS 'refunded';`)
  );

  expect(res.status).toBe(200);
  const asked = mockClient.queries.filter((query) => /to_regtype/.test(query.text));
  expect(asked.map((query) => query.values?.[0])).toEqual(['sales."Order State"']);
  expect(beforeTransaction()).toContain(
    `ALTER TYPE sales."Order State" ADD VALUE IF NOT EXISTS 'refunded';`
  );
});

it("skips the hoist when the target cannot answer whether the type exists", async () => {
  // Better a statement that fails inside the migration, where the reader can
  // see which line it was, than a run that dies before anything has started.
  mockClient = createFakeClient(
    target([], [{ match: /to_regtype/, error: { message: "syntax error at or near" } }])
  );
  const res = await apply(run(EXTEND_EXISTING));

  expect(res.status).toBe(200);
  expect(beforeTransaction().some((text) => /^ALTER TYPE/.test(text))).toBe(false);
  expect(queryTexts(mockClient)).toContain("RESET search_path");
});
