// The trial's demo database rebuild (rebuildTrialDatabase in
// lib/trial-sandbox.ts), on a stand-in for pg: the settings every connection
// starts with, what it sends and in what order, what it refuses, and what a
// failed rebuild leaves behind: nothing changed, and a message the Trial Admin
// can read, which names no host or user. The same rebuild was also run on a
// throwaway PostgreSQL, with settings planted on its user first.

type FakeClient = { config: Record<string, unknown>; queries: string[]; ended: boolean };
type Answer = (sql: string) => { rows: unknown[] } | Error;

const plainUser: Answer = (sql) =>
  /rolcreaterole/.test(sql) ? { rows: [{ rolsuper: false, rolcreaterole: false }] } : { rows: [] };

const mockPg = {
  clients: [] as FakeClient[],
  events: [] as string[],
  connectErrors: [] as unknown[],
  answer: plainUser,
};

jest.mock("pg", () => {
  class Client {
    queries: string[] = [];
    ended = false;
    constructor(readonly config: Record<string, unknown>) {
      mockPg.clients.push(this);
    }
    private get index() {
      return mockPg.clients.indexOf(this);
    }
    async connect() {
      const error = mockPg.connectErrors.shift();
      mockPg.events.push(`${error ? "refused" : "connect"} ${this.index}`);
      if (error) throw error;
    }
    async query(sql: string) {
      this.queries.push(sql);
      const answer = mockPg.answer(sql);
      if (answer instanceof Error) throw answer;
      return answer;
    }
    async end() {
      this.ended = true;
      mockPg.events.push(`end ${this.index}`);
    }
  }
  class Pool {}
  return { __esModule: true, Client, Pool, default: { Client, Pool } };
});
jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: { query: jest.fn(), connect: jest.fn() },
  syncMetadataTables: jest.fn(),
}));
jest.mock("../lib/db/bootstrap", () => ({ seedBuiltInRoles: jest.fn() }));

import pool from "../lib/version-db";
import { trialSeedSql } from "../lib/trial-seed";
import {
  TRIAL_ROLE_DEFAULTS,
  TrialRebuildError,
  ensureTrialOrganization,
  rebuildTrialDatabase,
  trialRebuildMessage,
  type TrialDatabase,
} from "../lib/trial-sandbox";

const DB: TrialDatabase = {
  host: "db.example.test",
  port: 5432,
  database: "demo",
  user: "trial_user",
  password: "pw",
  sslMode: "require",
};

const saved = { ...process.env };

beforeEach(() => {
  mockPg.clients = [];
  mockPg.events = [];
  mockPg.connectErrors = [];
  mockPg.answer = plainUser;
});

afterEach(() => {
  process.env = { ...saved };
  jest.clearAllMocks();
});

function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** The plain user's answers, with these (checked first, in order) on top. */
function answering(overrides: [RegExp, { rows: unknown[] } | Error][]) {
  mockPg.answer = (sql) => overrides.find(([pattern]) => pattern.test(sql))?.[1] ?? plainUser(sql);
}

/** The `-c name=value` settings a connection was opened with. */
function startupSettings(client: FakeClient): Record<string, string> {
  const words = String(client.config.options).split(/\s+/);
  // Every setting is a "-c" and a name=value of its own, the empty ones too.
  expect(words.length % 2).toBe(0);
  const settings: Record<string, string> = {};
  for (let i = 0; i < words.length; i += 2) {
    expect(words[i]).toBe("-c");
    const [name, value, ...rest] = words[i + 1].split("=");
    expect(rest).toEqual([]);
    expect(value).toBeDefined();
    settings[name] = value;
  }
  return settings;
}

describe("the demo database's rebuild", () => {
  it("starts every connection with settings nothing saved on the user can override", async () => {
    await rebuildTrialDatabase(DB);
    expect(mockPg.clients).toHaveLength(2);
    for (const client of mockPg.clients) {
      expect(startupSettings(client)).toMatchObject({
        default_transaction_read_only: "off",
        local_preload_libraries: "",
        search_path: "pg_catalog",
        default_tablespace: "",
        statement_timeout: "20000",
        lock_timeout: "15000",
        idle_in_transaction_session_timeout: "60000",
        idle_session_timeout: "0",
        transaction_timeout: "0",
      });
      // Only a superuser may set it, so only a superuser could have saved it.
      expect(startupSettings(client)).not.toHaveProperty("session_preload_libraries");
      // Some hosts drop pg's own timeout settings on the way: everything is in options.
      expect(client.config).not.toHaveProperty("statement_timeout");
      expect(client.config).not.toHaveProperty("lock_timeout");
      expect(client.config.connectionTimeoutMillis).toBe(8_000);
    }
  });

  it("clears what was saved on the user, then rebuilds the schemas on a connection of its own", async () => {
    answering([
      [/pg_db_role_setting/, { rows: [{ datname: "demo" }, { datname: 'odd"name' }] }],
      [/pg_namespace/, { rows: [{ nspname: "students_dev" }, { nspname: "made_by_a_tester" }] }],
      [/pg_publication/, { rows: [{ pubname: "everything" }] }],
    ]);
    await rebuildTrialDatabase(DB);

    const [settings, schemas] = mockPg.clients;
    expect(settings.queries).toEqual([
      "SET ROLE NONE",
      expect.stringContaining("rolcreaterole"),
      "BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE",
      "ALTER ROLE SESSION_USER RESET ALL",
      expect.stringContaining("pg_db_role_setting"),
      'ALTER ROLE SESSION_USER IN DATABASE "demo" RESET ALL',
      'ALTER ROLE SESSION_USER IN DATABASE "odd""name" RESET ALL',
      ...TRIAL_ROLE_DEFAULTS.map(({ name, value }) => `ALTER ROLE SESSION_USER SET ${name} = '${value}'`),
      "COMMIT",
    ]);
    expect(TRIAL_ROLE_DEFAULTS).toEqual([
      { name: "statement_timeout", value: "20s" },
      { name: "idle_in_transaction_session_timeout", value: "60s" },
    ]);
    expect(schemas.queries).toEqual([
      "SET ROLE NONE",
      "BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE",
      expect.stringContaining("pg_namespace"),
      'DROP SCHEMA "students_dev", "made_by_a_tester" CASCADE',
      expect.stringContaining("lo_unlink"),
      expect.stringContaining("pg_publication"),
      'DROP PUBLICATION "everything"',
      trialSeedSql(),
      "COMMIT",
    ]);
    // The second connection opens after the first has saved and closed, so it
    // starts with the user's cleared settings.
    expect(mockPg.events).toEqual(["connect 0", "end 0", "connect 1", "end 1"]);
  });

  it("drops nothing when the user owns nothing", async () => {
    await rebuildTrialDatabase(DB);
    expect(mockPg.clients[1].queries.filter((sql) => sql.startsWith("DROP"))).toEqual([]);
    expect(mockPg.clients[1].queries).toContain(trialSeedSql());
  });

  it.each([
    ["a superuser", [{ rolsuper: true, rolcreaterole: false }]],
    ["a user that may create roles", [{ rolsuper: false, rolcreaterole: true }]],
    ["a user it cannot find", []],
  ])("refuses %s, before changing anything", async (_, rows) => {
    answering([[/rolcreaterole/, { rows }]]);
    const error = await rebuildTrialDatabase(DB).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(TrialRebuildError);
    expect((error as Error).message).toMatch(/superuser, or a user that may create roles/);
    expect(mockPg.clients).toHaveLength(1);
    expect(mockPg.clients[0].queries).toEqual(["SET ROLE NONE", expect.stringContaining("rolcreaterole"), "ROLLBACK"]);
    expect(mockPg.clients[0].ended).toBe(true);
  });

  it("asks again without an optional setting the server does not know, once for the whole rebuild", async () => {
    mockPg.connectErrors.push(pgError("42704", 'unrecognized configuration parameter "transaction_timeout"'));
    await rebuildTrialDatabase(DB);
    expect(mockPg.clients).toHaveLength(3);
    const [refused, first, second] = mockPg.clients.map(startupSettings);
    expect(refused).toHaveProperty("transaction_timeout", "0");
    expect(first).not.toHaveProperty("transaction_timeout");
    expect(second).not.toHaveProperty("transaction_timeout");
    expect(first).toEqual(second);
    expect(first).toHaveProperty("idle_session_timeout", "0");
    // pg closes a connection that failed to open by itself.
    expect(mockPg.events).toEqual(["refused 0", "connect 1", "end 1", "connect 2", "end 2"]);
  });

  it("gives up when the server does not know a setting the rebuild needs", async () => {
    const refusal = pgError("42704", 'unrecognized configuration parameter "lock_timeout"');
    mockPg.connectErrors.push(refusal);
    await expect(rebuildTrialDatabase(DB)).rejects.toBe(refusal);
    expect(mockPg.clients).toHaveLength(1);
  });

  it("rolls the schemas back when it fails part way", async () => {
    const busy = pgError("55P03", "canceling statement due to lock timeout");
    answering([
      [/pg_namespace/, { rows: [{ nspname: "students_dev" }] }],
      [/^DROP SCHEMA/, busy],
    ]);
    await expect(rebuildTrialDatabase(DB)).rejects.toBe(busy);
    const schemas = mockPg.clients[1];
    expect(schemas.queries.slice(-2)).toEqual(['DROP SCHEMA "students_dev" CASCADE', "ROLLBACK"]);
    expect(schemas.queries).not.toContain("COMMIT");
    expect(schemas.ended).toBe(true);
  });
});

describe("what the Trial Admin is told when it fails", () => {
  it.each([
    ["ECONNREFUSED", "connect ECONNREFUSED 203.0.113.5:5432", /could not be reached/],
    ["ENOTFOUND", "getaddrinfo ENOTFOUND db.example.test", /could not be reached/],
    ["57P03", "the database system is starting up", /could not be reached/],
    ["", "timeout expired", /could not be reached/],
    ["", "Connection terminated unexpectedly", /could not be reached/],
    ["28P01", 'password authentication failed for user "trial_user"', /refused the saved password/],
    ["3D000", 'database "demo" does not exist', /does not exist/],
    ["57014", "canceling statement due to statement timeout", /took too long/],
    ["55P03", "canceling statement due to lock timeout", /busy/],
    ["40P01", "deadlock detected", /busy/],
    ["25006", "cannot execute DROP SCHEMA in a read-only transaction", /read only/],
    ["42501", "permission denied for database demo", /missing a permission/],
    ["53300", 'too many connections for role "trial_user"', /no free connections/],
    ["08P01", "unsupported startup parameter: options", /connection pooler/],
    ["XX000", "something odd happened on db.example.test", /could not be rebuilt/],
  ])("%s: %s", (code, text, expected) => {
    const message = trialRebuildMessage(code ? pgError(code, text) : new Error(text));
    expect(message).toMatch(expected);
    expect(message).toMatch(/left as it was/);
    expect(message).not.toMatch(/[\u2013\u2014]/);
    expect(message).not.toMatch(/trial_user|db\.example\.test|203\.0\.113\.5/);
  });

  it("keeps a TrialRebuildError's own words, and what went wrong for the log", () => {
    const underlying = new Error("detail");
    const error = new TrialRebuildError("Just this.", underlying);
    expect(error).toBeInstanceOf(TrialRebuildError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("TrialRebuildError");
    expect(error.underlying).toBe(underlying);
    expect(trialRebuildMessage(error)).toBe("Just this.");
  });
});

describe("a reset whose rebuild fails", () => {
  /** The app's database, as ensureTrialOrganization sees it. */
  function metadata(existing: { id: number; created_at: Date } | null) {
    const queries: string[] = [];
    const client = {
      queries,
      release: jest.fn(),
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
        if (/FROM organizations WHERE slug/.test(sql)) return { rows: existing ? [existing] : [] };
        if (/count\(\*\)::int AS n/.test(sql)) return { rows: [{ n: 0 }] };
        return { rows: [] };
      }),
    };
    (pool.connect as unknown as jest.Mock).mockResolvedValueOnce(client);
    return client;
  }

  it.each([
    ["a reset", { id: 7, created_at: new Date(Date.now() - 60 * 60_000) }],
    ["the first build", null],
  ])("changes nothing in %s, and says why without naming the host or user", async (_, existing) => {
    process.env.TRIAL_DATABASE_URL = "postgres://trial_user:pw@db.example.test/demo";
    mockPg.connectErrors.push(pgError("ECONNREFUSED", "connect ECONNREFUSED 203.0.113.5:5432"));
    const app = metadata(existing);
    const logged = jest.spyOn(console, "error").mockImplementation(() => {});

    const error = await ensureTrialOrganization({ reset: true }).catch((thrown: unknown) => thrown);
    // Copied first: restoring the spy forgets its calls.
    const logs = logged.mock.calls.map((call) => [...call]);
    logged.mockRestore();

    expect(error).toBeInstanceOf(TrialRebuildError);
    expect((error as Error).message).toBe(
      "The trial's demo database could not be reached, so the trial was left as it was. Try again in a moment."
    );
    expect((error as TrialRebuildError).underlying).toMatchObject({ code: "ECONNREFUSED" });
    // What went wrong is logged once, with its code, for whoever runs the server.
    expect(logs).toEqual([
      ["Could not rebuild the trial's demo database:", "connect ECONNREFUSED 203.0.113.5:5432", "(ECONNREFUSED)"],
    ]);
    // The organization's transaction rolls back: nothing deleted, nothing made.
    expect(app.queries).toContain("ROLLBACK");
    expect(app.queries).not.toContain("COMMIT");
    expect(app.queries.some((sql) => /INSERT INTO organizations/.test(sql))).toBe(false);
    expect(app.queries.some((sql) => /^DELETE FROM organizations/.test(sql))).toBe(!!existing);
    expect(app.release).toHaveBeenCalledTimes(1);
  });
});
