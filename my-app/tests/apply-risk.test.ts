// POST /api/scripts/apply: the risks it refuses to run without a tick, the
// forward-only rule, and the level it stores for each migration.
//
// Each refusal is checked for what it says and for what it did not do: no
// connection used, no approval claimed, no BEGIN, no INSERT. The target
// database is the fake client from helpers/fake-pg. Nothing here reaches a
// real database or GitHub.
import { NextRequest } from "next/server";
import { toEnvironment } from "@/lib/environments";
import { createFakeClient, queriesMatching, queryTexts, type FakeClient, type FakeStep } from "./helpers/fake-pg";
import { FAKE_TOKEN, guardGitHub, type GitHubGuard } from "./helpers/no-github";

// Relative paths on purpose: next/jest rewrites the @/ alias inside import
// statements only, so jest.mock("@/...") would not resolve.
// The caller. A test sets mockBypass to play the auth bypass's one principal.
let mockBypass = false;
jest.mock("../lib/auth-guard", () => ({
  requireEditor: async () => ({ ok: true, principal: { email: "a@test", bypass: mockBypass } }),
}));
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

// The tracked-schema record: its environment label and the last drift result.
const mockFindTracked = jest.fn<Promise<unknown>, unknown[]>(async () => null);
const mockRecordLineage = jest.fn<Promise<unknown>, unknown[]>(async () => ({ advanced: false }));
jest.mock("../lib/lineage-db", () => ({
  findTrackedSchema: (...args: unknown[]) => mockFindTracked(...args),
  recordAppliedMigrationToLineage: (...args: unknown[]) => mockRecordLineage(...args),
}));

const mockClaim = jest.fn<Promise<unknown>, unknown[]>(async () => null);
jest.mock("../lib/approvals-db", () => ({
  claimApproval: (...args: unknown[]) => mockClaim(...args),
  releaseApproval: async () => undefined,
}));

type RouteModule = typeof import("../app/api/scripts/apply/route");
let POST: RouteModule["POST"];

function connectionRow(environment: string) {
  return {
    host: "db.test", port: 5432, database_name: "sales", username: "app",
    password: "not-a-real-password", connection_string: null, ssl: false,
    ssl_mode: "disable", environment,
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
  mockPoolQuery.mockResolvedValue({ rows: [connectionRow("dev")] });
  mockFindTracked.mockReset();
  mockFindTracked.mockResolvedValue(null);
  mockRecordLineage.mockReset();
  mockRecordLineage.mockResolvedValue({ advanced: false });
  mockClaim.mockReset();
  mockClaim.mockResolvedValue(null);
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

describe("a risk with no tick", () => {
  it("refuses a breaking run that deletes rows, dry run included, before touching the target", async () => {
    for (const dryRun of [false, true]) {
      mockClient = createFakeClient(target());
      const res = await apply({ ...DROPS, dryRun });
      expect(res.status).toBe(409);
      expect(res.body.needsAcknowledgement).toEqual(["breaking", "data_loss"]);
      expect(res.body.results).toEqual([{ script_name: "orders_fix", version: "2.0.0", status: "skipped" }]);
      expect(res.body.error).toBe(
        `This ${dryRun ? "dry run" : "deploy"} was refused because a risk in it has no tick: ` +
          "orders_fix v2.0.0 is breaking; orders_fix v2.0.0 (DROP COLUMN) deletes rows. Nothing ran. " +
          `Tick the box under each of those warnings, then ${dryRun ? "start the dry run" : "deploy"} again.`
      );
      expect(mockClient.queries).toEqual([]);
    }
  });

  it("asks only for the tick that is missing, and runs once every tick is there", async () => {
    const one = await apply({ ...DROPS, acknowledgeBreaking: true });
    expect(one.status).toBe(409);
    expect(one.body.needsAcknowledgement).toEqual(["data_loss"]);

    mockClient = createFakeClient(target());
    const both = await apply({ ...DROPS, acknowledgeBreaking: true, acknowledgeDataLoss: true });
    expect(both.status).toBe(200);
    expect(count(mockClient, "COMMIT")).toBe(1);
  });

  it("asks for the data-loss tick alone on a TRUNCATE, which moves no structure", async () => {
    const res = await apply({ ...BASE, scripts: [job("1.0.1", "TRUNCATE audit_log;")] });
    expect(res.status).toBe(409);
    expect(res.body.needsAcknowledgement).toEqual(["data_loss"]);
  });

  it("asks for the data-loss tick on a DELETE inside a DO block", async () => {
    const sql =
      "DO $$ BEGIN IF EXISTS (SELECT 1 FROM orders WHERE archived) THEN " +
      "DELETE FROM orders WHERE archived; END IF; END $$;";
    const res = await apply({ ...BASE, scripts: [job("1.0.2", sql)] });
    expect(res.status).toBe(409);
    expect(res.body.needsAcknowledgement).toEqual(["data_loss"]);
    expect(mockClient.queries).toEqual([]);
  });

  it("asks for the breaking tick when the caller sends 'breaking' with a script", async () => {
    const res = await apply({ ...BASE, scripts: [job("1.0.0", "CREATE TABLE orders (id int);", { change_type: "breaking" })] });
    expect(res.status).toBe(409);
    expect(res.body.needsAcknowledgement).toEqual(["breaking"]);
  });

  it("refuses on production before the approval is claimed", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [connectionRow("prod")] });
    mockClaim.mockResolvedValue({ id: 9 });
    const res = await apply({ ...DROPS, acknowledgeProduction: true });
    expect(res.status).toBe(409);
    expect(res.body.needsAcknowledgement).toEqual(["breaking", "data_loss"]);
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockClient.queries).toEqual([]);
  });
});

describe("saved credentials this server can't read", () => {
  it("refuses before the production approval is claimed, so none is left spent", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [connectionRow("prod")] });
    mockClaim.mockResolvedValue({ id: 9 });
    // buildPgConfig throws only when it can't decrypt the saved password.
    mockBuildPgConfig.mockImplementation(() => {
      throw new Error("Unsupported state or unable to authenticate data");
    });
    const res = await apply({ ...SAFE, acknowledgeProduction: true });
    expect(res.status).toBe(500);
    expect(res.body.nothingRan).toBe(true);
    expect(res.body.error).toBe(
      "This connection's stored credentials can't be read on this server, so nothing ran. " +
        "Set APP_ENCRYPTION_KEY to the key they were saved with, or edit the connection on " +
        "the Connections screen and enter its password again."
    );
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockClient.queries).toEqual([]);
  });
});

describe("production approval", () => {
  // A real run on production spends an approval claimed for these exact
  // scripts. With none to claim, the route refuses before the first write and
  // says who can clear one. Under the auth bypass there is one principal and it
  // clears its own request, so "someone other than you" would be untrue.
  beforeEach(() => {
    mockPoolQuery.mockResolvedValue({ rows: [connectionRow("prod")] });
  });

  it("refuses a real run nothing approves, and asks for someone other than you", async () => {
    const res = await apply({ ...SAFE, acknowledgeProduction: true });
    expect(res.status).toBe(403);
    expect(res.body.needsApproval).toBe(true);
    expect(res.body.nothingRan).toBe(true);
    expect(res.body.error).toBe(
      "This target is labelled production, so the run needs an approval from someone other than " +
        "you. No approval covers this exact migration, so nothing ran. Request approval for it on " +
        "the screen you are running it from, or request a new approval if its SQL has changed " +
        "since the last one."
    );
    expect(mockClaim).toHaveBeenCalledTimes(1);
    expect(queriesMatching(mockClient, /\b(BEGIN|CREATE|INSERT|ALTER)\b/)).toEqual([]);
  });

  it("asks for an approval, not a second person, under the auth bypass", async () => {
    mockBypass = true;
    const res = await apply({
      ...BASE,
      acknowledgeProduction: true,
      scripts: [job("1.0.0", "CREATE TABLE a (id int);"), job("1.1.0", "CREATE TABLE b (id int);")],
    });
    expect(res.status).toBe(403);
    expect(res.body.needsApproval).toBe(true);
    expect(res.body.error).toBe(
      "This target is labelled production, so the run needs an approval. No approval covers " +
        "these exact 2 migrations, so nothing ran. Request approval for them on the screen you " +
        "are running them from, or request a new approval if their SQL has changed since the last one."
    );
    expect(queriesMatching(mockClient, /\b(BEGIN|CREATE|INSERT|ALTER)\b/)).toEqual([]);
  });

  it("runs once an approval is claimed, and needs none for a dry run", async () => {
    mockClaim.mockResolvedValue({ id: 9 });
    const real = await apply({ ...SAFE, acknowledgeProduction: true });
    expect(real.status).toBe(200);
    expect(count(mockClient, "COMMIT")).toBe(1);

    mockClaim.mockReset();
    mockClaim.mockResolvedValue(null);
    mockClient = createFakeClient(target());
    const rehearsal = await apply({ ...SAFE, acknowledgeProduction: true, dryRun: true });
    expect(rehearsal.status).toBe(200);
    expect(mockClaim).not.toHaveBeenCalled();
    expect(count(mockClient, "COMMIT")).toBe(0);
  });
});

describe("the last drift check", () => {
  it("needs a tick when it found drift or could not reach the target", async () => {
    for (const driftStatus of ["drifted", "unreachable"] as const) {
      mockFindTracked.mockResolvedValue({ environment: toEnvironment("dev"), driftStatus });
      mockClient = createFakeClient(target());
      const res = await apply(SAFE);
      expect(res.status).toBe(409);
      expect(res.body.needsAcknowledgement).toEqual(["drift"]);
      expect(String(res.body.error)).toContain(
        driftStatus === "drifted"
          ? 'the last drift check found schema "sales" different from its tracked baseline'
          : 'the last drift check could not reach schema "sales"'
      );
      expect(String(res.body.error)).toContain("run the drift check again first.");
      expect(mockClient.queries).toEqual([]);

      const ticked = await apply({ ...SAFE, acknowledgeDrift: true });
      expect(ticked.status).toBe(200);
    }
  });

  it("needs no tick when it was clean", async () => {
    mockFindTracked.mockResolvedValue({ environment: toEnvironment("dev"), driftStatus: "in_sync" });
    const res = await apply(SAFE);
    expect(res.status).toBe(200);
  });

  it("answers 503 and runs nothing when the tracking record cannot be read", async () => {
    mockFindTracked.mockRejectedValue(new Error("metadata database is down"));
    const res = await apply(SAFE);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe(
      "Could not read this schema's tracking record, so its environment label and drift state are " +
        "unknown. Nothing ran. Try again in a moment; if it keeps failing, check that the app's " +
        "metadata database is running."
    );
    expect(res.body.nothingRan).toBe(true);
    expect(mockClient.queries).toEqual([]);
    expect(mockClaim).not.toHaveBeenCalled();
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

  it("checks again under the family locks, rolls back, and says a hoisted enum value stays", async () => {
    // The first read (step 6c) finds nothing; by the second (step 8a, under
    // the locks) another deploy has committed the same version.
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
      acknowledgeBreaking: true,
      acknowledgeDataLoss: true,
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
      when: "the production approval cannot be checked",
      body: { ...SAFE, acknowledgeProduction: true },
      arrange: () => {
        mockPoolQuery.mockResolvedValue({ rows: [connectionRow("prod")] });
        mockClaim.mockRejectedValue(new Error("metadata database is down"));
      },
      status: 500,
      says:
        "Could not check the deploy approval for this production target, so nothing ran. Try again " +
        "in a moment; if it keeps failing, check that the app's metadata database is running.",
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
    const ticks = await apply(DROPS);
    expect(ticks.status).toBe(409);
    expect(ticks.body.nothingRan).toBe(true);

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
