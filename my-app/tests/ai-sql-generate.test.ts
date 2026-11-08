// Feature 4: write SQL from plain words. The refusals, the checks, the try on
// the database (with a fake client) and the whole run with a fake model. No
// database and no model are reached.

jest.mock("../lib/version-db", () => ({
  __esModule: true,
  default: {},
  syncMetadataTables: async () => undefined,
}));

import type { PoolClient } from "pg";
import type { AiConfig } from "@/lib/ai/config";
import {
  backticksToQuotes,
  buildSqlGenerateTask,
  checkSqlGenerate,
  otherSchemasIn,
  refusedIn,
  type TrialHook,
  type TrialOutcome,
} from "@/lib/ai/features/sql-generate";
import { describeTrialError, makeTrial } from "@/lib/ai/features/sql-generate-trial";
import { isSqlGenerateAnswer, isSqlGenerateChecks, type SqlGenerateAnswer } from "@/lib/ai/features/sql-generate-view";
import { MockProvider } from "@/lib/ai/mock";
import { runAiTask, type AiDeps } from "@/lib/ai/run";
import { AI_OFF } from "@/lib/ai/settings";
import { column, schema, table } from "./helpers/snapshots";

function shop() {
  return schema(
    [
      table("books", [column("id", { isPrimaryKey: true, nullable: false }), column("title", { typeDisplay: "text" }), column("price", { typeDisplay: "numeric(10,2)" })]),
      table("orders", [column("id", { isPrimaryKey: true, nullable: false }), column("book_id"), column("created_at", { typeDisplay: "timestamp with time zone" })]),
    ],
    { database: "secret_shop_db" }
  );
}

function answer(over: Partial<SqlGenerateAnswer> = {}): SqlGenerateAnswer {
  return {
    sql: "-- add a stock count\nALTER TABLE books ADD COLUMN IF NOT EXISTS stock integer NOT NULL DEFAULT 0;",
    rollbackSql: "ALTER TABLE books DROP COLUMN IF EXISTS stock;",
    summary: "Adds `stock` to `books`, starting at 0.",
    assumptions: ["integer is enough for a count"],
    cannot: "",
    ...over,
  };
}

function task(options: { request?: string; trial?: TrialHook | { notTried: string }; serverMajor?: number | null } = {}) {
  return buildSqlGenerateTask({
    request: options.request ?? "Add a stock count to books",
    schemaName: "public",
    snapshot: shop(),
    serverMajor: options.serverMajor === undefined ? 17 : options.serverMajor,
    trial: options.trial ?? { notTried: "Not in tests." },
  });
}

describe("backticksToQuotes", () => {
  it("quotes backticked names, each dotted part apart", () => {
    expect(backticksToQuotes("ALTER TABLE `books` ADD COLUMN `stock` integer;")).toBe('ALTER TABLE "books" ADD COLUMN "stock" integer;');
    expect(backticksToQuotes("SELECT 1 FROM `shop.Order`;")).toBe('SELECT 1 FROM "shop"."Order";');
  });

  it("leaves backticks in strings and comments, and SQL without them, alone", () => {
    const sql = "-- add `stock`\nCOMMENT ON TABLE books IS 'counts `stock`';";
    expect(backticksToQuotes(sql)).toBe(sql);
    expect(backticksToQuotes("SELECT 1;")).toBe("SELECT 1;");
  });
});

describe("refusedIn", () => {
  const refused = [
    ["an extension", "CREATE EXTENSION IF NOT EXISTS pgcrypto;"],
    ["a sleep", "SELECT pg_sleep(5);"],
    ["a quoted sleep", 'SELECT "pg_sleep"(5);'],
    ["a server call in a DO block", "DO $$ BEGIN PERFORM pg_terminate_backend(1); END $$;"],
    ["dynamic SQL", "DO $$ BEGIN EXECUTE 'DROP TABLE books'; END $$;"],
    ["a SET", "ALTER TABLE books ADD COLUMN x int; SET search_path TO other;"],
    ["SECURITY DEFINER", "CREATE FUNCTION f() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;"],
    ["CONCURRENTLY", "CREATE INDEX CONCURRENTLY books_title ON books (title);"],
    ["granting a role", "GRANT admin TO ada;"],
    ["a role", "CREATE ROLE reporter;"],
    ["COPY", "COPY books TO '/tmp/books.csv';"],
    ["ALTER SYSTEM", "ALTER SYSTEM SET work_mem = '1GB';"],
    ["another schema", "ALTER TABLE other.books ADD COLUMN x int;"],
  ] as const;
  test.each(refused)("refuses %s", (_label, sql) => {
    expect(refusedIn(sql, "public").length).toBeGreaterThan(0);
  });

  const allowed = [
    ["a grant on a table", "GRANT SELECT ON books TO reporter;"],
    ["a new column", "ALTER TABLE books ADD COLUMN stock integer NOT NULL DEFAULT 0;"],
    ["a plain index", "CREATE INDEX IF NOT EXISTS books_title ON books (title);"],
    ["a trigger function", "CREATE TRIGGER t BEFORE UPDATE ON books FOR EACH ROW EXECUTE FUNCTION touch();"],
    ["the target schema written out", "ALTER TABLE public.books ADD COLUMN x int;"],
    ["a word in a comment", "-- do not SET anything\nALTER TABLE books ADD COLUMN x int;"],
    ["a word in a string", "COMMENT ON COLUMN books.title IS 'pg_sleep(1) is not called';"],
  ] as const;
  test.each(allowed)("allows %s", (_label, sql) => {
    expect(refusedIn(sql, "public")).toEqual([]);
  });

  test("a server call is reported once, not again as a refused function", () => {
    expect(refusedIn("SELECT pg_terminate_backend(1);", "public")).toHaveLength(1);
  });
});

describe("otherSchemasIn", () => {
  const columns = new Set(["created_at", "title"]);
  test("finds a schema in front of a table", () => {
    expect(otherSchemasIn("SELECT * FROM other.books;", "public")).toEqual(["other"]);
  });
  test("finds a schema in front of an index's table and a type", () => {
    expect(otherSchemasIn("CREATE INDEX i ON other.books (title);", "public")).toEqual(["other"]);
    expect(otherSchemasIn("CREATE TYPE audit.mood AS ENUM ('a');", "public")).toEqual(["audit"]);
  });
  test("an alias and a column after FROM are not a schema", () => {
    expect(otherSchemasIn("SELECT EXTRACT(year FROM o.created_at) FROM orders o;", "public", columns)).toEqual([]);
  });
  test("the catalogs and the target schema are fine", () => {
    expect(otherSchemasIn("SELECT * FROM pg_catalog.pg_class;", "public")).toEqual([]);
    expect(otherSchemasIn("SELECT * FROM information_schema.columns;", "public")).toEqual([]);
    expect(otherSchemasIn("SELECT * FROM public.books;", "public")).toEqual([]);
    expect(otherSchemasIn('SELECT * FROM "Sales".books;', "Sales")).toEqual([]);
  });
});

describe("the prompt", () => {
  test("carries the request, the version and the schema, never the database name", () => {
    const t = task();
    expect(t.spec.prompt).toContain("Add a stock count to books");
    expect(t.spec.prompt).toContain("PostgreSQL 17.");
    expect(t.spec.prompt).toContain("schema public");
    expect(t.spec.prompt).toContain("books");
    expect(t.spec.prompt).not.toContain("secret_shop_db");
    expect(t.spec.system).not.toContain("secret_shop_db");
  });
  test("an unknown version is said so", () => {
    expect(task({ serverMajor: null }).spec.prompt).toContain("PostgreSQL (version unknown)");
  });
  test("generation is never saved and gets two fixes", () => {
    const t = task();
    expect(t.spec.cacheInput).toBeNull();
    expect(t.spec.repairs).toBe(2);
    expect(t.spec.tier).toBe("smart");
  });
  test("data loss is allowed only when the request asks for it", () => {
    expect(task().facts.allowDataLoss).toBe(false);
    expect(task({ request: "Drop the price column from books" }).facts.allowDataLoss).toBe(true);
    expect(task({ request: "get rid of old orders" }).facts.allowDataLoss).toBe(true);
  });
  test("the request is cut to the limit", () => {
    expect(task({ request: "x".repeat(5_000) }).facts.request).toHaveLength(2_000);
  });
});

describe("checkSqlGenerate", () => {
  test("a good script passes with the engine's grade and counts", async () => {
    const { facts } = task();
    const out = await checkSqlGenerate(answer(), facts);
    expect(out.problems).toEqual([]);
    expect(facts.last).toMatchObject({ statements: 1, rollbackStatements: 1, trial: { status: "not-tried", reason: "Not in tests." } });
    expect(facts.last?.level).not.toBeNull();
    expect(isSqlGenerateChecks(facts.last)).toBe(true);
    expect(isSqlGenerateAnswer(out.value)).toBe(true);
  });

  test("dropping a column the request did not ask for is sent back", async () => {
    const { facts } = task();
    const out = await checkSqlGenerate(answer({ sql: "ALTER TABLE books DROP COLUMN price;", rollbackSql: "" }), facts);
    expect(out.problems.join(" ")).toContain("deletes data");
    expect(facts.last).toBeNull();
    expect(facts.lastProblems).toEqual(out.problems);
  });

  test("dropping a column the request asked for passes and is listed", async () => {
    const { facts } = task({ request: "Drop the price column from books" });
    const out = await checkSqlGenerate(answer({ sql: "ALTER TABLE books DROP COLUMN price;", rollbackSql: "", summary: "Drops `books.price`." }), facts);
    expect(out.problems).toEqual([]);
    expect(facts.last?.dataLoss.length).toBeGreaterThan(0);
    expect(facts.last?.level).toBe("breaking");
  });

  test("a table the schema does not have is sent back", async () => {
    const { facts } = task();
    const out = await checkSqlGenerate(answer({ sql: "ALTER TABLE invoices ADD COLUMN due date;", rollbackSql: "", summary: "Adds a due date." }), facts);
    expect(out.problems.join(" ")).toContain("invoices");
  });

  test("the rollback may use what the script creates", async () => {
    const { facts } = task();
    const out = await checkSqlGenerate(
      answer({
        sql: "CREATE TABLE IF NOT EXISTS reviews (id int PRIMARY KEY, book_id int REFERENCES books(id));",
        rollbackSql: "DROP TABLE IF EXISTS reviews;",
        summary: "Adds `reviews` for `books`.",
      }),
      facts
    );
    expect(out.problems).toEqual([]);
  });

  test("transaction control in the rollback is sent back, marked as the rollback's", async () => {
    const { facts } = task();
    const out = await checkSqlGenerate(answer({ rollbackSql: "BEGIN; ALTER TABLE books DROP COLUMN stock; COMMIT;" }), facts);
    expect(out.problems.some((p) => p.startsWith("The rollback: "))).toBe(true);
  });

  test("a summary naming something neither the schema nor the script has is sent back", async () => {
    const { facts } = task();
    const out = await checkSqlGenerate(answer({ summary: "Adds `stock` to `inventory`." }), facts);
    expect(out.problems.join(" ")).toContain("inventory");
  });

  test("cannot alone is a fine answer, with nothing to try", async () => {
    const { facts } = task();
    const out = await checkSqlGenerate(answer({ sql: "", rollbackSql: "", cannot: "The schema has no invoices table." }), facts);
    expect(out.problems).toEqual([]);
    expect(out.value.sql).toBe("");
    expect(facts.last?.trial).toEqual({ status: "not-tried", reason: "There is no script to try." });
  });

  test("no SQL and no reason is sent back", async () => {
    const { facts } = task();
    const out = await checkSqlGenerate(answer({ sql: "-- nothing", rollbackSql: "", cannot: "" }), facts);
    expect(out.problems).toHaveLength(1);
  });

  test("a script and a reason: the script wins and the reason becomes an assumption", async () => {
    const { facts } = task();
    const out = await checkSqlGenerate(answer({ cannot: "Stock might belong in its own table." }), facts);
    expect(out.problems).toEqual([]);
    expect(out.value.cannot).toBe("");
    expect(out.value.assumptions).toContain("Stock might belong in its own table.");
  });
});

describe("the try on the database", () => {
  function withTrial(outcome: TrialOutcome) {
    const calls: [string, string][] = [];
    const trial: TrialHook = async (sql, rollbackSql) => {
      calls.push([sql, rollbackSql]);
      return outcome;
    };
    return { calls, ...task({ trial }) };
  }

  test("a passed try is shown, with whether the rollback was tried", async () => {
    const { calls, facts } = withTrial({ status: "passed" });
    const out = await checkSqlGenerate(answer(), facts);
    expect(out.problems).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(facts.last?.trial).toEqual({ status: "passed", rollbackTried: true });
  });

  test("a failed try goes back to the model", async () => {
    const { facts } = withTrial({ status: "failed", step: "script", message: 'column "stok" does not exist (SQLSTATE 42703).' });
    const out = await checkSqlGenerate(answer(), facts);
    expect(out.problems[0]).toContain("Trying the script on the database failed");
    expect(facts.last).toBeNull();
  });

  test("a failed rollback says so", async () => {
    const { facts } = withTrial({ status: "failed", step: "rollback", message: "x (SQLSTATE 42P01)." });
    const out = await checkSqlGenerate(answer(), facts);
    expect(out.problems[0]).toContain("the rollback failed after it");
  });

  test("a try that could not run is shown, not sent back", async () => {
    const { facts } = withTrial({ status: "not-tried", reason: "Locked." });
    const out = await checkSqlGenerate(answer(), facts);
    expect(out.problems).toEqual([]);
    expect(facts.last?.trial).toEqual({ status: "not-tried", reason: "Locked." });
  });

  test("a script with a static problem is never tried", async () => {
    const { calls, facts } = withTrial({ status: "passed" });
    await checkSqlGenerate(answer({ sql: "SELECT pg_sleep(1);" }), facts);
    expect(calls).toHaveLength(0);
  });
});

describe("the whole run", () => {
  function deps(replies: ConstructorParameters<typeof MockProvider>[0]): AiDeps {
    return {
      config: {
        provider: "openai-compatible",
        baseUrl: "https://example.test/v1",
        apiKey: "k",
        models: { fast: "fast-model", smart: "smart-model" },
      } as unknown as AiConfig,
      provider: new MockProvider(replies),
      readSettings: async () => ({ ...AI_OFF, enabled: true, features: { ...AI_OFF.features } }),
      store: {
        recordAiCall: async () => 1,
        callsToday: async () => 0,
        callsLastMinute: async () => 0,
        readSavedAnswer: (async () => null) as AiDeps["store"]["readSavedAnswer"],
        saveAnswer: async () => undefined,
      },
      now: () => 0,
    };
  }
  const caller = { orgId: 1, email: "ada@example.com" };

  test("two bad answers and a good one: the good one is used", async () => {
    const t = task();
    const result = await runAiTask(
      caller,
      t.spec,
      deps([answer({ sql: "SELECT pg_sleep(1);" }), answer({ sql: "ALTER TABLE invoices ADD COLUMN x int;" }), answer()])
    );
    expect(result).toMatchObject({ kind: "ok", retries: 2 });
    expect(t.facts.last?.statements).toBe(1);
    expect(t.facts.lastProblems).toEqual([]);
  });

  test("three bad answers fail, and the last problem is kept for the message", async () => {
    const t = task();
    const bad = answer({ sql: "SELECT pg_sleep(1);" });
    const result = await runAiTask(caller, t.spec, deps([bad, bad, bad]));
    expect(result.kind).toBe("failed");
    expect(t.facts.last).toBeNull();
    expect(t.facts.lastProblems.join(" ")).toContain("pg_sleep");
  });
});

describe("makeTrial", () => {
  type Step = { text: string; values?: unknown[] };
  function fakeClient(options: { failOn?: RegExp; error?: object; noSchema?: boolean; xids?: string[] } = {}) {
    const steps: Step[] = [];
    const xids = [...(options.xids ?? ["100", "100", "100"])];
    let released: unknown = "not released";
    const client = {
      query: async (text: string, values?: unknown[]) => {
        steps.push({ text, values });
        if (options.failOn && options.failOn.test(text)) throw options.error ?? Object.assign(new Error("boom"), { code: "42703" });
        if (text.includes("txid_current")) return { rows: [{ xid: xids.shift() ?? "100" }] };
        if (text.includes("information_schema.schemata")) return { rows: options.noSchema ? [] : [{ "?column?": 1 }] };
        return { rows: [] };
      },
      release: (arg: unknown) => {
        released = arg;
      },
    } as unknown as PoolClient;
    return { client, steps, released: () => released };
  }
  const UP = "ALTER TABLE books ADD COLUMN stock int;";
  const DOWN = "ALTER TABLE books DROP COLUMN stock;";

  test("sets the session up, runs both parts, and always rolls back and closes", async () => {
    const fake = fakeClient();
    const outcome = await makeTrial({}, "shop", async () => fake.client)(UP, DOWN);
    expect(outcome).toEqual({ status: "passed" });
    const texts = fake.steps.map((s) => s.text);
    expect(texts[0]).toBe("BEGIN");
    expect(texts).toContain("SET LOCAL lock_timeout = 2000");
    expect(texts).toContain("SET LOCAL statement_timeout = 10000");
    expect(texts).toContain('SET LOCAL search_path TO "shop"');
    expect(texts.indexOf(UP)).toBeLessThan(texts.indexOf(DOWN));
    expect(texts.at(-1)).toBe("ROLLBACK");
    expect(fake.released()).toBe(true);
  });

  test("a wrong column fails the script step with the database's words", async () => {
    const fake = fakeClient({ failOn: /ADD COLUMN/, error: Object.assign(new Error('column "stok" does not exist'), { code: "42703" }) });
    const outcome = await makeTrial({}, "public", async () => fake.client)(UP, DOWN);
    expect(outcome).toEqual({ status: "failed", step: "script", message: 'column "stok" does not exist (SQLSTATE 42703).' });
    expect(fake.steps.at(-1)?.text).toBe("ROLLBACK");
    expect(fake.released()).toBe(true);
  });

  test("a failed rollback is the rollback step", async () => {
    const fake = fakeClient({ failOn: /DROP COLUMN/ });
    const outcome = await makeTrial({}, "public", async () => fake.client)(UP, DOWN);
    expect(outcome).toMatchObject({ status: "failed", step: "rollback" });
  });

  test("a lock wait is not tried, not failed", async () => {
    const fake = fakeClient({ failOn: /ADD COLUMN/, error: { code: "55P03", message: "lock" } });
    const outcome = await makeTrial({}, "public", async () => fake.client)(UP, DOWN);
    expect(outcome.status).toBe("not-tried");
  });

  test("a script that ends the transaction itself fails", async () => {
    const fake = fakeClient({ xids: ["100", "101"] });
    const outcome = await makeTrial({}, "public", async () => fake.client)(UP, DOWN);
    expect(outcome).toMatchObject({ status: "failed", step: "script" });
    expect(fake.steps.some((s) => s.text === DOWN)).toBe(false);
  });

  test("no rollback text means only the script is run", async () => {
    const fake = fakeClient();
    await makeTrial({}, "public", async () => fake.client)(UP, "");
    expect(fake.steps.some((s) => s.text === "")).toBe(false);
  });

  test("a schema that is gone is not tried", async () => {
    const fake = fakeClient({ noSchema: true });
    const outcome = await makeTrial({}, "gone", async () => fake.client)(UP, DOWN);
    expect(outcome).toEqual({ status: "not-tried", reason: "The schema gone is not on this database any more." });
    expect(fake.steps.some((s) => s.text === UP)).toBe(false);
    expect(fake.released()).toBe(true);
  });

  test("a setup failure is not tried", async () => {
    const fake = fakeClient({ failOn: /search_path/ });
    const outcome = await makeTrial({}, "public", async () => fake.client)(UP, DOWN);
    expect(outcome).toEqual({ status: "not-tried", reason: "The app could not set up the trial on this database." });
  });

  test("no connection is not tried, and the driver's words are not passed on", async () => {
    const outcome = await makeTrial({}, "public", async () => {
      throw new Error("getaddrinfo ENOTFOUND db.internal.example");
    })(UP, DOWN);
    expect(outcome.status).toBe("not-tried");
    expect(JSON.stringify(outcome)).not.toContain("internal.example");
  });
});

describe("describeTrialError", () => {
  test("a NOT NULL failure gives names, never the row", () => {
    const read = describeTrialError({
      code: "23502",
      message: 'null value in column "stock" of relation "books" violates not-null constraint',
      detail: "Failing row contains (1, Secret Title, 9.99, null).",
      table: "books",
      column: "stock",
    });
    expect(read).toEqual({
      message: "Rows already in the table break the change, SQLSTATE 23502 (table books, column stock). Say what to do with them, or add a DEFAULT.",
    });
    expect(JSON.stringify(read)).not.toContain("Secret Title");
  });

  test("a cast failure leaves the value out", () => {
    const read = describeTrialError({ code: "22P02", message: 'invalid input syntax for type integer: "Secret"', column: "price" });
    expect(JSON.stringify(read)).not.toContain("Secret");
    expect(read).toMatchObject({ message: expect.stringContaining("22P02") });
  });

  test("other errors keep the message and the hint", () => {
    expect(describeTrialError({ code: "42P01", message: 'relation "invoices" does not exist', hint: "Check the name." })).toEqual({
      message: 'relation "invoices" does not exist (SQLSTATE 42P01). Hint: Check the name.',
    });
  });

  test("a statement timeout is not tried", () => {
    expect(describeTrialError({ code: "57014" })).toHaveProperty("notTried");
  });
});
