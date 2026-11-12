// POST /api/scripts/apply: who may run, the approval somebody without the
// permission needs, the forward-only rule, and the level it stores for each
// migration.
//
// Each refusal is checked for what it says and for what it did not do: no
// connection used, no approval claimed, no BEGIN, no INSERT. The target
// database is the fake client from helpers/fake-pg. Nothing here reaches a
// real database or GitHub.
import { NextRequest } from "next/server";
import { askToRunRefusal } from "@/lib/connection-access";
import { createFakeClient, queriesMatching, queryTexts, type FakeClient, type FakeStep } from "./helpers/fake-pg";
import { FAKE_TOKEN, guardGitHub, type GitHubGuard } from "./helpers/no-github";
import { TEST_ORG } from "./helpers/principals";
import { UNREADABLE_CREDENTIALS_MESSAGE } from "@/lib/secret-store";

// Relative paths on purpose: next/jest rewrites the @/ alias inside import
// statements only, so jest.mock("@/...") would not resolve.
// The caller: an editor on a new install, whose role may run deployments. A
// test sets mockBypass to play the auth bypass's one principal instead, the
// full admin that answers for everyone while sign-in is off.
let mockBypass = false;
jest.mock("../lib/auth-guard", () => {
  const { bypassAdminPrincipal, principalFor } = require("./helpers/principals");
  return {
    requirePermission: async () => ({
      ok: true,
      principal: mockBypass
        ? bypassAdminPrincipal()
        : principalFor("editor", { email: "a@test" }),
    }),
  };
});
afterEach(() => {
  mockBypass = false;
});

// The metadata database: only the saved-connection lookup reaches it.
const mockPoolQuery = jest.fn<Promise<unknown>, unknown[]>(async () => ({ rows: [] }));
jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: { query: (...args: unknown[]) => mockPoolQuery(...args) },
  syncMetadataTables: async () => undefined,
}));

let mockClient: FakeClient;
// Set to make the target turn the connection itself away.
let mockConnectError: Error | null = null;
jest.mock("../lib/postgres", () => ({
  getPoolForConfig: () => ({
    connect: async () => {
      if (mockConnectError) throw mockConnectError;
      return mockClient;
    },
  }),
}));
// Set to throw to play a saved secret this server can't decrypt.
const mockBuildPgConfig = jest.fn<unknown, unknown[]>(() => ({}));
jest.mock("../lib/connection-config", () => ({
  buildPgConfig: (...args: unknown[]) => mockBuildPgConfig(...args),
}));

const mockRecordLineage = jest.fn<Promise<unknown>, unknown[]>(async () => ({ advanced: false }));
jest.mock("../lib/lineage-db", () => ({
  recordAppliedMigrationToLineage: (...args: unknown[]) => mockRecordLineage(...args),
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

const mockClaim = jest.fn<Promise<unknown>, unknown[]>(async () => null);
const mockRelease = jest.fn<Promise<void>, unknown[]>(async () => undefined);
jest.mock("../lib/approvals-db", () => ({
  claimApproval: (...args: unknown[]) => mockClaim(...args),
  mayDecideOwn: jest.requireActual("../lib/approvals-db").mayDecideOwn,
  releaseApproval: (...args: unknown[]) => mockRelease(...args),
}));

type RouteModule = typeof import("../app/api/scripts/apply/route");
let POST: RouteModule["POST"];

function connectionRow(execute_role?: string) {
  return {
    host: "db.test", port: 5432, database_name: "sales", username: "app",
    password: "not-a-real-password", connection_string: null, ssl: false,
    ssl_mode: "disable", name: "Sales dev", execute_role,
  };
}

/** The answers a healthy target gives. `first` steps win over these. */
function target(first: FakeStep[] = []): FakeStep[] {
  return [
    ...first,
    { match: /information_schema\.schemata/, rows: [{ exists: 1 }] },
    { match: /INSERT INTO "sales"\.script_patch/, rows: [{ applied_at: "2026-09-11T00:00:00.000Z" }] },
  ];
}

/** One migration, as the Deploy page sends it. */
function job(version: string, sqlContent: string, extra: Record<string, unknown> = {}) {
  return { script_name: "orders_fix", version, sql_content: sqlContent, ...extra };
}

const BASE = { connectionId: 7, schemaName: "sales" };
// Drops a column: breaking, and it deletes that column's values.
const DROPS = { ...BASE, scripts: [job("2.0.0", "ALTER TABLE orders DROP COLUMN note;")] };
// Adds a table: no risk at all.
const SAFE = { ...BASE, scripts: [job("1.0.0", "CREATE TABLE orders (id int);")] };

async function apply(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await POST(
    new NextRequest("http://localhost/api/scripts/apply", {
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

const count = (client: FakeClient, text: string) => queryTexts(client).filter((t) => t === text).length;

let guard: GitHubGuard;
let consoleSpy: jest.SpyInstance;
let logSpy: jest.SpyInstance;

beforeAll(async () => {
  // Imported after the jest.mock calls above, so the route sees the stand-ins.
  ({ POST } = await import("../app/api/scripts/apply/route"));
});

beforeEach(() => {
  guard = guardGitHub();
  mockPoolQuery.mockReset();
  mockPoolQuery.mockResolvedValue({ rows: [connectionRow()] });
  mockRecordLineage.mockReset();
  mockRecordLineage.mockResolvedValue({ advanced: false });
  mockClaim.mockReset();
  mockClaim.mockResolvedValue(null);
  mockRelease.mockReset();
  mockRelease.mockResolvedValue(undefined);
  mockClient = createFakeClient(target());
  mockConnectError = null;
  mockBuildPgConfig.mockReset();
  mockBuildPgConfig.mockReturnValue({});
  // The route logs its failures; the assertions below read the responses.
  consoleSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  consoleSpy.mockRestore();
  logSpy.mockRestore();
  guard.restore();
  expect(guard.unexpected).toEqual([]);
});

describe("a risky run", () => {
  // The screens show the warnings. The route asks for no tick: a role that
  // may run here runs.
  it("runs a breaking script that deletes rows, with nothing to confirm", async () => {
    const res = await apply(DROPS);
    expect(res.status).toBe(200);
    expect(res.body.needsAcknowledgement).toBeUndefined();
    expect(count(mockClient, "COMMIT")).toBe(1);
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("ignores the tick fields an older screen may still send", async () => {
    const res = await apply({
      ...DROPS,
      acknowledgeProduction: false,
      acknowledgeBreaking: false,
      acknowledgeDataLoss: false,
      acknowledgeDrift: false,
    });
    expect(res.status).toBe(200);
    expect(count(mockClient, "COMMIT")).toBe(1);
  });
});

describe("saved credentials this server can't read", () => {
  it("refuses before the approval is claimed, so none is left spent", async () => {
    // An editor on an admins-only connection, with an approval there to claim.
    mockPoolQuery.mockResolvedValue({ rows: [connectionRow("admin")] });
    mockClaim.mockResolvedValue({ id: 9 });
    // buildPgConfig throws only when it can't decrypt the saved password.
    mockBuildPgConfig.mockImplementation(() => {
      throw new Error("Unsupported state or unable to authenticate data");
    });
    const res = await apply(SAFE);
    expect(res.status).toBe(500);
    expect(res.body.nothingRan).toBe(true);
    expect(res.body.error).toBe(`Nothing ran. ${UNREADABLE_CREDENTIALS_MESSAGE}`);
    // The decrypt error is for the server log, not the page.
    expect(JSON.stringify(res.body)).not.toContain("Unsupported state");
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockClient.queries).toEqual([]);
  });
});

describe("a run by somebody whose role may run here", () => {
  it("needs no approval, and claims none", async () => {
    const res = await apply(SAFE);
    expect(res.status).toBe(200);
    expect(mockClaim).not.toHaveBeenCalled();
    expect(count(mockClient, "COMMIT")).toBe(1);
  });

  it("needs no approval under the auth bypass", async () => {
    mockBypass = true;
    mockPoolQuery.mockResolvedValue({ rows: [connectionRow("admin")] });
    const res = await apply(SAFE);
    expect(res.status).toBe(200);
    expect(mockClaim).not.toHaveBeenCalled();
    expect(count(mockClient, "COMMIT")).toBe(1);
  });

  it("rehearses with a time limit, and spends no approval", async () => {
    const rehearsal = await apply({ ...SAFE, dryRun: true });
    expect(rehearsal.status).toBe(200);
    expect(rehearsal.body.dryRun).toBe(true);
    expect(count(mockClient, "COMMIT")).toBe(0);
    expect(count(mockClient, "ROLLBACK")).toBe(1);
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockRelease).not.toHaveBeenCalled();
    // Only a dry run gets a time limit. See the next test for the real run.
    // The line is sent again before every script (lib/run-settings), so it is
    // there more than once, always with the same limit.
    const limits = queriesMatching(mockClient, /statement_timeout/).map((query) => query.text);
    expect(limits.length).toBeGreaterThan(0);
    expect(new Set(limits)).toEqual(new Set(["SET LOCAL statement_timeout = 300000"]));
  });

  it("sets no time limit on a real run", async () => {
    const real = await apply(SAFE);
    expect(real.status).toBe(200);
    expect(queriesMatching(mockClient, /statement_timeout/)).toEqual([]);
    expect(mockRelease).not.toHaveBeenCalled();
  });
});

describe("forward only", () => {
  it("refuses versions out of order in the run, before touching the target", async () => {
    const res = await apply({
      ...BASE,
      scripts: [job("3.0.0", "CREATE TABLE t3 (id int);"), job("2.0.0", "CREATE TABLE t2 (id int);")],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      "orders_fix v2.0.0 is listed after v3.0.0 in this run. Versions of one script must run in " +
        "ascending order. Nothing ran."
    );
    expect(mockClient.queries).toEqual([]);
  });

  it("refuses '1.2' and '1.2.0' in one run as the same version twice", async () => {
    const res = await apply({
      ...BASE,
      scripts: [job("1.2", "CREATE TABLE a (id int);"), job("1.2.0", "CREATE TABLE b (id int);")],
    });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain("is listed twice in this run");
    expect(mockClient.queries).toEqual([]);
  });

  it("refuses a version below one already applied, before the ledger table, the enum hoist or BEGIN", async () => {
    mockClient = createFakeClient(
      target([
        { match: /to_regclass/, rows: [{ present: true }] },
        { match: /SELECT script_name, version/, rows: [{ script_name: "orders_fix", version: "2.0.0" }] },
      ])
    );
    const res = await apply({ ...BASE, scripts: [job("1.5.0", "ALTER TYPE mood ADD VALUE IF NOT EXISTS 'calm';")] });
    expect(res.status).toBe(409);
    expect(res.body.results).toEqual([
      { script_name: "orders_fix", version: "1.5.0", status: "failed", error: "A higher version is already applied." },
    ]);
    expect(res.body.nothingRan).toBe(true);
    expect(res.body.error).toBe(
      "orders_fix v1.5.0 cannot run: v2.0.0 is already applied and deploys only move forward. " +
        "Check the target database again to see what is pending now. Nothing ran."
    );
    // Only the run's own families are read.
    expect(queriesMatching(mockClient, /SELECT script_name, version/)[0].values).toEqual([["orders_fix"]]);
    const texts = queryTexts(mockClient);
    expect(texts.some((text) => /CREATE TABLE IF NOT EXISTS/.test(text))).toBe(false);
    expect(texts.some((text) => /ALTER TYPE/.test(text))).toBe(false);
    expect(texts).not.toContain("BEGIN");
    expect(mockClient.releaseCount).toBe(1);
  });

  // "constructor" passes the script-name rule (letters only), so it is a name
  // an author can really type. The ledger was gathered into a plain object
  // keyed by script name: reading that key found Object.prototype's built-in
  // function instead of the list being built, and .push on a function threw —
  // a 500 from the deploy route before any check had run.
  it("deploys a script named after a built-in", async () => {
    mockClient = createFakeClient(
      target([
        { match: /to_regclass/, rows: [{ present: true }] },
        { match: /SELECT script_name, version/, rows: [{ script_name: "constructor", version: "1.0.0" }] },
      ])
    );
    const res = await apply({
      ...BASE,
      scripts: [{ script_name: "constructor", version: "2.0.0", sql_content: "CREATE TABLE t (id int);" }],
    });

    expect(res.status).toBe(200);
    expect(res.body.results).toMatchObject([{ script_name: "constructor", status: "applied" }]);
  });

  it("still holds such a script to the forward-only rule", async () => {
    // The ledger for that name has to be read, not just not-crash: 1.0.0 is
    // already applied, so 0.9.0 must be refused like any other rewind.
    mockClient = createFakeClient(
      target([
        { match: /to_regclass/, rows: [{ present: true }] },
        { match: /SELECT script_name, version/, rows: [{ script_name: "constructor", version: "1.0.0" }] },
      ])
    );
    const res = await apply({
      ...BASE,
      scripts: [{ script_name: "constructor", version: "0.9.0", sql_content: "CREATE TABLE t (id int);" }],
    });

    expect(res.status).toBe(409);
    expect(res.body.nothingRan).toBe(true);
    expect(String(res.body.error)).toContain("deploys only move forward");
  });

  it("checks again under the family locks, rolls back, and says a hoisted enum value stays", async () => {
    // The first read (step 6c) finds nothing; by the second (step 8a, under
    // the locks) another deploy has committed the same version.
    let reads = 0;
    mockClient = createFakeClient(
      target([
        { match: /to_regclass/, rows: [{ present: true }] },
        // The type already exists, which is what makes its ADD VALUE eligible for
        // the hoist. A type this run was about to create would be left in the
        // script instead, and nothing of it would stay behind to mention.
        { match: /to_regtype/, rows: [{ present: true }] },
        {
          match: /SELECT script_name, version/,
          when: () => {
            reads += 1;
            return reads >= 2;
          },
          rows: [{ script_name: "orders_fix", version: "1.5.0" }],
        },
      ])
    );
    const res = await apply({ ...BASE, scripts: [job("1.5.0", "ALTER TYPE mood ADD VALUE IF NOT EXISTS 'calm';")] });
    expect(res.status).toBe(409);
    expect(res.body.results).toEqual([
      { script_name: "orders_fix", version: "1.5.0", status: "failed", error: "Already applied to this schema." },
    ]);
    // Step 7 hoisted the enum value before this refusal, so something was
    // written and the answer must not say otherwise.
    expect(res.body.nothingRan).toBeUndefined();
    // The whole answer. It used to end the refusal with "Nothing ran." and
    // then say the enum value stays, which cannot both be true.
    expect(res.body.error).toBe(
      'orders_fix v1.5.0 is already applied (recorded as "1.5.0"). ' +
        "Check the target database again to see what is pending now. " +
        "No migration in this run ran, but the enum value it adds was added before this check and stays, " +
        "because PostgreSQL cannot remove an enum value: ALTER TYPE mood ADD VALUE IF NOT EXISTS 'calm';"
    );
    expect(String(res.body.error)).not.toContain("Nothing ran");

    const texts = queryTexts(mockClient);
    const reread = mockClient.queries.findLastIndex((q) => /SELECT script_name, version/.test(q.text));
    const firstLock = mockClient.queries.findIndex((q) => /pg_advisory_xact_lock/.test(q.text));
    expect(texts.indexOf("BEGIN")).toBeLessThan(firstLock);
    expect(firstLock).toBeLessThan(reread);
    expect(count(mockClient, "ROLLBACK")).toBe(1);
    expect(count(mockClient, "COMMIT")).toBe(0);
    expect(queriesMatching(mockClient, /INSERT INTO "sales"\.script_patch/)).toHaveLength(0);
  });

  it("says 'Nothing ran.' when the same re-check stops a dry run, which hoists no enum value", async () => {
    // The same race as above, on a dry run. A dry run skips step 7, so the
    // enum value was never added and the plain refusal is the true one.
    let reads = 0;
    mockClient = createFakeClient(
      target([
        { match: /to_regclass/, rows: [{ present: true }] },
        {
          match: /SELECT script_name, version/,
          when: () => {
            reads += 1;
            return reads >= 2;
          },
          rows: [{ script_name: "orders_fix", version: "1.5.0" }],
        },
      ])
    );
    const res = await apply({
      ...BASE,
      dryRun: true,
      scripts: [job("1.5.0", "ALTER TYPE mood ADD VALUE IF NOT EXISTS 'calm';")],
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(
      'orders_fix v1.5.0 is already applied (recorded as "1.5.0"). ' +
        "Check the target database again to see what is pending now. Nothing ran."
    );
    expect(queryTexts(mockClient).some((text) => /ALTER TYPE/.test(text))).toBe(false);
    expect(count(mockClient, "ROLLBACK")).toBe(1);
    expect(count(mockClient, "COMMIT")).toBe(0);
  });
});

describe("the level stored", () => {
  it("stores the louder of the SQL's level and the caller's, and hands lineage the loudest", async () => {
    const res = await apply({
      ...BASE,
      scripts: [
        // No change_type: the SQL's own level.
        job("1.0.0", "CREATE TABLE a (id int);"),
        // "additive" cannot quiet a dropped column.
        job("1.1.0", "ALTER TABLE a DROP COLUMN note;", { change_type: "additive" }),
        // "unknown" is not a level, so it is ignored.
        job("1.2.0", "CREATE TABLE b (id int);", { change_type: "unknown" }),
        // "breaking" raises a script the SQL reads as additive.
        job("1.3.0", "CREATE TABLE c (id int);", { change_type: "breaking" }),
      ],
    });
    expect(res.status).toBe(200);
    // change_type is the INSERT's fifth value.
    const stored = queriesMatching(mockClient, /INSERT INTO "sales"\.script_patch/).map((q) => [
      q.values?.[1],
      q.values?.[4],
    ]);
    expect(stored).toEqual([
      ["1.0.0", "additive"],
      ["1.1.0", "breaking"],
      ["1.2.0", "additive"],
      ["1.3.0", "breaking"],
    ]);
    expect(mockRecordLineage).toHaveBeenCalledTimes(1);
    expect(mockRecordLineage.mock.calls[0][0]).toMatchObject({ changeLevel: "breaking" });
  });

  it("hands lineage the loudest level of a run with nothing breaking in it", async () => {
    const res = await apply({
      ...BASE,
      scripts: [
        job("1.0.0", "CREATE TABLE a (id int);", { change_type: "patch" }),
        job("1.1.0", "ALTER TABLE a ALTER COLUMN id SET DEFAULT 0;"),
      ],
    });
    expect(res.status).toBe(200);
    expect(mockRecordLineage.mock.calls[0][0]).toMatchObject({ changeLevel: "additive" });
  });
});

describe("an answer given before the first write", () => {
  // Step 7 (the ledger table and the enum hoist) is the route's first write to
  // the target. Every answer before it says nothingRan, so a screen can tell a
  // run that never started from one that rolled back: a 500 or 503 alone
  // could be either.
  type Case = {
    when: string;
    body: Record<string, unknown>;
    arrange: () => void;
    status: number;
    says: string;
  };
  const cases: Case[] = [
    {
      when: "the saved connection cannot be read",
      body: SAFE,
      arrange: () => mockPoolQuery.mockRejectedValue(new Error("metadata database is down")),
      status: 500,
      says:
        "Could not read the saved connection, so nothing ran. Try again in a moment; if it keeps " +
        "failing, check that the app's metadata database is running.",
    },
    {
      when: "the approval cannot be checked",
      body: SAFE,
      arrange: () => {
        mockPoolQuery.mockResolvedValue({ rows: [connectionRow("admin")] });
        mockClaim.mockRejectedValue(new Error("metadata database is down"));
      },
      status: 500,
      says:
        "Could not check the approval for this run, so nothing ran. Try again in a moment; if it " +
        "keeps failing, check that the app's metadata database is running.",
    },
    {
      when: "the target turns the connection away",
      body: SAFE,
      arrange: () => {
        mockConnectError = new Error("connection refused");
      },
      status: 503,
      says:
        "Could not connect to target database (db.test:5432/sales), so nothing ran. Check that the " +
        "database is running and the credentials are correct, then try again. Details: connection refused",
    },
    {
      when: "the schema check fails",
      body: SAFE,
      arrange: () => {
        mockClient = createFakeClient(
          target([{ match: /information_schema\.schemata/, error: { message: "connection reset" } }])
        );
      },
      status: 503,
      says:
        'Could not check whether schema "sales" exists, so nothing ran. Try again; if it keeps failing, ' +
        "check that the target database is reachable. Details: connection reset",
    },
    {
      when: "the ledger cannot be read",
      body: SAFE,
      arrange: () => {
        mockClient = createFakeClient(target([{ match: /to_regclass/, error: { message: "connection reset" } }]));
      },
      status: 503,
      says:
        'Could not read which versions schema "sales" has already applied, so nothing ran. Try again; ' +
        "if it keeps failing, check that the target database is reachable. Details: connection reset",
    },
  ];

  it.each(cases)("says nothingRan on the $status when $when, and writes nothing", async ({ body, arrange, status, says }) => {
    arrange();
    const res = await apply(body);
    expect(res.status).toBe(status);
    expect(res.body.error).toBe(says);
    expect(res.body.nothingRan).toBe(true);
    expect(res.body.results).toBeUndefined();
    expect(queriesMatching(mockClient, /\b(BEGIN|CREATE|INSERT|ALTER)\b/)).toEqual([]);
  });

  it("says nothingRan on a refusal as well", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [connectionRow("admin")] });
    const unapproved = await apply(SAFE);
    expect(unapproved.status).toBe(403);
    expect(unapproved.body.nothingRan).toBe(true);
    mockPoolQuery.mockResolvedValue({ rows: [connectionRow()] });

    const order = await apply({
      ...BASE,
      scripts: [job("3.0.0", "CREATE TABLE t3 (id int);"), job("2.0.0", "CREATE TABLE t2 (id int);")],
    });
    expect(order.status).toBe(400);
    expect(order.body.nothingRan).toBe(true);

    mockClient = createFakeClient([{ match: /information_schema\.schemata/, rows: [] }]);
    const missing = await apply(SAFE);
    expect(missing.status).toBe(400);
    expect(missing.body.nothingRan).toBe(true);
  });

  it("does not say it once the run has written anything", async () => {
    const done = await apply(SAFE);
    expect(done.status).toBe(200);
    expect(done.body.nothingRan).toBeUndefined();

    mockClient = createFakeClient(
      target([{ match: /CREATE TABLE orders/, error: { message: "permission denied for schema sales" } }])
    );
    const failed = await apply(SAFE);
    expect(failed.status).toBe(500);
    expect(failed.body.nothingRan).toBeUndefined();
    expect(count(mockClient, "ROLLBACK")).toBe(1);
  });
});

describe("per-connection execution setting", () => {
  // Spec feature 02. The gate at the top of the route asked whether this caller
  // may run migrations at all; this asks whether they may run one against THIS
  // database. A role alone cannot say "trusted on dev, not on the reference
  // schema", because the role is a property of the person.

  it("refuses a read-only connection before opening it, dry run included", async () => {
    // Dry run included is the whole point of checking here: a rehearsal really executes the script against the
    // target and only then rolls back, so exempting it would make the quiet
    // way to write to a read-only database the one nobody checks.
    mockPoolQuery.mockResolvedValue({ rows: [connectionRow("none")] });
    for (const dryRun of [false, true]) {
      const res = await apply({ ...SAFE, dryRun });
      expect(res.status).toBe(403);
      expect(String(res.body.error)).toContain("read-only");
    }
    // Not a single statement, not even a connection.
    expect(mockClient.queries).toEqual([]);
  });

  it("refuses an admins-only connection to an editor until an Admin approves the run for them", async () => {
    // An editor may not run here by themselves, but may ask an Admin for this
    // one run. With no approval of theirs to claim, nothing runs.
    mockPoolQuery.mockResolvedValue({ rows: [connectionRow("admin")] });
    const res = await apply(SAFE);
    expect(res.status).toBe(403);
    expect(res.body.askToRun).toBe(true);
    expect(res.body.needsApproval).toBe(true);
    expect(res.body.error).toBe(askToRunRefusal("Sales dev", false));
    // Only an approval this very person asked for counts, in their own
    // organization.
    expect(mockClaim).toHaveBeenCalledTimes(1);
    expect(mockClaim.mock.calls[0][0]).toMatchObject({ orgId: TEST_ORG.id, connectionId: 7, requestedBy: "a@test", action: "deploy" });
    expect(queriesMatching(mockClient, /\b(BEGIN|CREATE|INSERT|ALTER)\b/)).toEqual([]);
  });

  it("refuses that editor a dry run there outright, claiming nothing", async () => {
    // A rehearsal executes the SQL too, and no approval covers one.
    mockPoolQuery.mockResolvedValue({ rows: [connectionRow("admin")] });
    const res = await apply({ ...SAFE, dryRun: true });
    expect(res.status).toBe(403);
    expect(res.body.askToRun).toBe(true);
    expect(res.body.error).toBe(askToRunRefusal("Sales dev", true));
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockClient.queries).toEqual([]);
  });

  it("lets the default setting through, so old rows keep working", async () => {
    // Every connection saved before this column existed is one an editor could
    // already deploy to. If the fallback ever flipped to "none", every install
    // upgrading to this version would stop deploying with no message anybody
    // could act on — so an absent value is pinned here, not just in the unit
    // test for toExecuteRole.
    mockPoolQuery.mockResolvedValue({ rows: [connectionRow(undefined)] });
    const res = await apply(SAFE);
    expect(res.status).toBe(200);
  });
});

describe("another organization's connection", () => {
  // Connection ids are shared by every organization, so anybody can send one
  // that is not theirs. The lookup names the caller's organization, and a
  // connection saved in another one reads as missing: the same 404 a deleted
  // one gets, before its password is decrypted, an approval is claimed or
  // anything is sent to its database.
  it("answers 404 for it, decrypting, claiming and running nothing", async () => {
    // The saved row is in the next organization along, and the stand-in
    // answers the way the lookup's WHERE clause would, so only a lookup that
    // left the caller's organization out would find it.
    const theirs = { ...connectionRow("admin"), id: 7, org_id: TEST_ORG.id + 1 };
    mockPoolQuery.mockImplementation(async (...args: unknown[]) => {
      const [text, values = []] = args as [string, unknown[]?];
      const holds = (column: string, value: unknown) => {
        const param = new RegExp(`\\b${column} = \\$(\\d+)`).exec(text);
        return !param || values[Number(param[1]) - 1] === value;
      };
      const found =
        /FROM connections/.test(text) && holds("id", theirs.id) && holds("org_id", theirs.org_id);
      return { rows: found ? [theirs] : [] };
    });
    mockClaim.mockResolvedValue({ id: 9 });

    const res = await apply(SAFE);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("No saved connection found with id 7.");
    expect(JSON.stringify(res.body)).not.toContain("Sales dev");
    const lookups = mockPoolQuery.mock.calls.filter(([text]) =>
      /FROM connections/.test(String(text))
    );
    expect(lookups.map(([, values]) => values)).toEqual([[7, TEST_ORG.id]]);
    expect(mockBuildPgConfig).not.toHaveBeenCalled();
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockClient.queries).toEqual([]);
  });
});
