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
  alreadyThereIn,
  backticksToQuotes,
  buildSqlGenerateTask,
  checkSqlGenerate,
  otherSchemasIn,
  refusedIn,
  requestAsksForDataLoss,
  type TrialHook,
  type TrialOutcome,
} from "@/lib/ai/features/sql-generate";
import {
  describeTrialError,
  makeTrial,
  notPutBack,
  STRUCTURE_SQL,
  TRIAL_TIME_BUDGET_MS,
  trialStatementTimeout,
} from "@/lib/ai/features/sql-generate-trial";
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

  // A DO block or function body can be a '' or E'' string, not only a $$ body.
  const inStringBodies = [
    ["a server call in DO ''", "DO 'BEGIN PERFORM pg_terminate_backend(pid) FROM pg_stat_activity; END';", "pg_terminate_backend"],
    ["a file read in a RAISE in DO ''", "DO 'BEGIN RAISE EXCEPTION ''%'', pg_read_file(''/etc/hostname''); END';", "pg_read_file"],
    ["EXECUTE in DO E''", "DO E'BEGIN EXECUTE ''DROP TABLE books''; END';", "EXECUTE"],
    ["an escaped name in DO E''", "DO E'BEGIN PERFORM pg\\x5fsleep(100); END';", "pg_sleep"],
    ["a wait in a function body written as ''", "CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS 'BEGIN PERFORM pg_sleep(100); END';", "pg_sleep"],
    ["a SET in a DO body inside a DO body", "DO $$ BEGIN EXECUTE 'x'; END $$; DO 'BEGIN DO ''BEGIN SET search_path TO other; END''; END';", "SET or RESET"],
  ] as const;
  test.each(inStringBodies)("refuses %s", (_label, sql, word) => {
    expect(refusedIn(sql, "public").join(" ")).toContain(word);
  });

  test("a body written in a way the app cannot read is refused", () => {
    expect(refusedIn("DO U&'BEGIN PERFORM pg_sleep(1); END';", "public").join(" ")).toContain("cannot read");
  });

  test("a body read twice is reported once", () => {
    expect(refusedIn("DO $$ BEGIN PERFORM pg_sleep(1); END $$;", "public")).toHaveLength(1);
  });

  test("a harmless body written as '' and ON CONFLICT DO NOTHING pass", () => {
    expect(
      refusedIn("CREATE FUNCTION touch() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN NEW.title := ''x''; RETURN NEW; END';", "public")
    ).toEqual([]);
    expect(refusedIn("INSERT INTO books (id) VALUES (1) ON CONFLICT DO NOTHING;", "public")).toEqual([]);
  });

  test("another schema inside a DO block is refused", () => {
    expect(refusedIn("DO $$ BEGIN UPDATE other.books SET id = 1; END $$;", "public").join(" ")).toContain("another schema (other)");
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
    // Without the column names too: the FROM inside EXTRACT and the like is skipped.
    expect(otherSchemasIn("SELECT EXTRACT(year FROM o.created_at) FROM orders o;", "public")).toEqual([]);
    expect(otherSchemasIn("SELECT substring(o.title FROM 2), trim(both ' ' FROM o.title) FROM orders o;", "public")).toEqual([]);
    expect(otherSchemasIn("SELECT * FROM orders o WHERE o.id IS DISTINCT FROM o.book_id;", "public")).toEqual([]);
  });
  test("a table in another schema counts even when the target has a column of that name", () => {
    const withNotes = new Set(["notes", "comments"]);
    expect(otherSchemasIn("DELETE FROM archive.notes;", "public", withNotes)).toEqual(["archive"]);
    expect(otherSchemasIn("UPDATE legacy.comments SET id = 1;", "public", withNotes)).toEqual(["legacy"]);
    expect(refusedIn("DELETE FROM archive.notes;", "public", withNotes).join(" ")).toContain("another schema (archive)");
  });
  test("a schema named inside a DO block or a function body counts", () => {
    expect(otherSchemasIn("DO $$ BEGIN UPDATE other.books SET id = 1; END $$;", "public")).toEqual(["other"]);
    expect(otherSchemasIn("DO 'BEGIN UPDATE other.books SET id = 1; END';", "public")).toEqual(["other"]);
    expect(
      otherSchemasIn("CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN CREATE INDEX i ON audit.log (id); END $$;", "public")
    ).toEqual(["audit"]);
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
    expect(task({ request: "Add a phone column to users, don't delete anything" }).facts.allowDataLoss).toBe(false);
  });
  test("the request is cut to the limit", () => {
    expect(task({ request: "x".repeat(5_000) }).facts.request).toHaveLength(2_000);
  });
});

describe("requestAsksForDataLoss", () => {
  test.each([
    "Drop the price column from books",
    "get rid of old orders",
    "Delete the orders older than a year",
    "Clear out the sessions table",
    "Truncate the logs table",
    "Add a phone column, then drop the fax column",
    "Remove the default from status and delete the rows where status is null",
    "Don't drop the table, just remove the old rows",
  ])("%s asks for it", (request) => {
    expect(requestAsksForDataLoss(request)).toBe(true);
  });

  test.each([
    "Add a stock count to books",
    "Make users.email NOT NULL and remove its default",
    "Add a phone column to users, don't delete anything",
    "Add a phone column to users and do not delete anything",
    "Rename the column but never remove rows",
    "Add an index on title. Do not drop anything.",
    "Add the column without drop or delete",
    "Drop the index on books.title",
    "Remove the NOT NULL from books.price",
    "Drop the unique constraint on users.email",
    "Delete nothing",
    "Make the error message clear",
    "Nothing should be removed",
  ])("%s does not", (request) => {
    expect(requestAsksForDataLoss(request)).toBe(false);
  });

  test("a DELETE before SET NOT NULL is sent back when the request said to keep the data", async () => {
    const { facts } = task({ request: "Make books.title NOT NULL and remove its default" });
    const out = await checkSqlGenerate(
      answer({
        sql: "DELETE FROM books WHERE title IS NULL;\nALTER TABLE books ALTER COLUMN title DROP DEFAULT;\nALTER TABLE books ALTER COLUMN title SET NOT NULL;",
        rollbackSql: "ALTER TABLE books ALTER COLUMN title DROP NOT NULL;",
        summary: "Makes `books.title` required.",
      }),
      facts
    );
    expect(out.problems.join(" ")).toContain("deletes data");
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

  test("a summary naming a made-up schema in front of a new column is sent back", async () => {
    const { facts } = task();
    const out = await checkSqlGenerate(answer({ summary: "Adds `made_up.books.stock`." }), facts);
    expect(out.problems.join(" ")).toContain("made_up.books.stock");
    const fine = await checkSqlGenerate(answer({ summary: "Adds `public.books.stock`." }), task().facts);
    expect(fine.problems).toEqual([]);
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

describe("alreadyThereIn", () => {
  test("a column, table or index the schema already has is found", () => {
    const snap = shop();
    snap.tables[0].indexes = [{ name: "books_title_idx" } as never];
    expect(alreadyThereIn("ALTER TABLE orders ADD COLUMN IF NOT EXISTS created_at timestamptz;", snap)).toEqual(["column orders.created_at"]);
    expect(alreadyThereIn('ALTER TABLE ONLY public."books" ADD IF NOT EXISTS "price" int;', snap)).toEqual(["column books.price"]);
    expect(alreadyThereIn("-- again\nCREATE TABLE IF NOT EXISTS books (id int);", snap)).toEqual(["table books"]);
    expect(alreadyThereIn("CREATE UNIQUE INDEX IF NOT EXISTS books_title_idx ON books (title);", snap)).toEqual(["index books_title_idx"]);
  });
  test("what is new, or added without IF NOT EXISTS, is not", () => {
    const snap = shop();
    expect(alreadyThereIn("ALTER TABLE books ADD COLUMN IF NOT EXISTS stock int, ADD COLUMN IF NOT EXISTS isbn text;", snap)).toEqual([]);
    expect(alreadyThereIn("CREATE TABLE IF NOT EXISTS reviews (id int);", snap)).toEqual([]);
    expect(alreadyThereIn("ALTER TABLE books ADD COLUMN price int;", snap)).toEqual([]);
    expect(alreadyThereIn("-- ALTER TABLE books ADD COLUMN IF NOT EXISTS price int;\nSELECT 1;", snap)).toEqual([]);
    expect(alreadyThereIn("ALTER TABLE invoices ADD COLUMN IF NOT EXISTS price int;", snap)).toEqual([]);
  });
  test("checkSqlGenerate sends a no-op addition back", async () => {
    const { facts } = task({ request: "Add a price to books" });
    const out = await checkSqlGenerate(
      answer({
        sql: "ALTER TABLE books ADD COLUMN IF NOT EXISTS price numeric(10,2);",
        rollbackSql: "ALTER TABLE books DROP COLUMN IF EXISTS price;",
        summary: "Adds `price` to `books`.",
      }),
      facts
    );
    expect(out.problems.join(" ")).toContain("already there: column books.price");
    expect(facts.last).toBeNull();
  });
  test("the prompt says what to do when it is already there", () => {
    expect(task().spec.system).toContain("already in SCHEMA");
    expect(task().spec.system).toContain("rollbackSql undoes only what sql does");
  });
});

describe("notPutBack", () => {
  const before = new Map<string, string | null>([
    ["table orders", null],
    ["column orders.id", "integer"],
    ["column orders.status", "text"],
    ["constraint orders.orders_pkey", null],
    ["table notes", null],
    ["column notes.body", "text"],
  ]);
  test("the same structure, or only new things, is fine", () => {
    expect(notPutBack(before, new Map(before))).toBeNull();
    expect(notPutBack(before, new Map([...before, ["column orders.stock", "integer"]]))).toBeNull();
  });
  test("a gone column is named; a gone table is named without its columns", () => {
    const after = new Map(before);
    after.delete("column orders.status");
    after.delete("table notes");
    after.delete("column notes.body");
    const message = notPutBack(before, after)!;
    expect(message).toContain("gone: column orders.status, table notes.");
    expect(message).not.toContain("notes.body");
  });
  test("a column with another type is named with both types", () => {
    const after = new Map(before);
    after.set("column orders.status", "character varying(10)");
    expect(notPutBack(before, after)).toContain("column orders.status was text, is character varying(10)");
  });
  test("a long list is cut", () => {
    const many = new Map<string, string | null>(Array.from({ length: 12 }, (_, i) => [`index i${i}`, null]));
    expect(notPutBack(many, new Map())).toContain("and 4 more");
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
  type Rows = { item: string; shape: string | null }[];
  function fakeClient(
    options: { failOn?: RegExp; error?: object; noSchema?: boolean; xids?: string[]; structures?: Rows[]; failStructureAfter?: boolean } = {}
  ) {
    const steps: Step[] = [];
    const xids = [...(options.xids ?? ["100", "100", "100"])];
    const structures = [...(options.structures ?? [])];
    let structureReads = 0;
    let released: unknown = "not released";
    const client = {
      query: async (text: string, values?: unknown[]) => {
        steps.push({ text, values });
        if (options.failOn && options.failOn.test(text)) throw options.error ?? Object.assign(new Error("boom"), { code: "42703" });
        if (text.includes("txid_current")) return { rows: [{ xid: xids.shift() ?? "100" }] };
        if (text.includes("information_schema.schemata")) return { rows: options.noSchema ? [] : [{ "?column?": 1 }] };
        if (text === STRUCTURE_SQL) {
          structureReads += 1;
          if (options.failStructureAfter && structureReads > 1) throw Object.assign(new Error("gone"), { code: "57P01" });
          return { rows: structures.shift() ?? [] };
        }
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
    // The 10 second budget is shared by the 2 statements: 5 seconds each.
    expect(texts).toContain("SET LOCAL statement_timeout = 5000");
    expect(texts).toContain('SET LOCAL search_path TO "shop"');
    expect(texts.indexOf(UP)).toBeLessThan(texts.indexOf(DOWN));
    expect(texts.at(-1)).toBe("ROLLBACK");
    expect(fake.released()).toBe(true);
  });

  test("a wrong column fails the script step with a plain description and the script's name", async () => {
    const up = "ALTER TABLE books ADD COLUMN stock int; UPDATE books SET stok = 0;";
    const fake = fakeClient({ failOn: /stok/, error: Object.assign(new Error('column "stok" does not exist'), { code: "42703" }) });
    const outcome = await makeTrial({}, "public", async () => fake.client)(up, DOWN);
    expect(outcome).toEqual({
      status: "failed",
      step: "script",
      message: 'The script uses a column that does not exist, SQLSTATE 42703 ("stok").',
    });
    expect(fake.steps.at(-1)?.text).toBe("ROLLBACK");
    expect(fake.released()).toBe(true);
  });

  test("the time budget is shared by every statement of the script and its rollback", async () => {
    expect(trialStatementTimeout("SELECT 1; SELECT 2; SELECT 3; SELECT 4;", "SELECT 5;")).toBe(TRIAL_TIME_BUDGET_MS / 5);
    const fake = fakeClient();
    await makeTrial({}, "public", async () => fake.client)("SELECT 1; SELECT 2; SELECT 3; SELECT 4;", "SELECT 5;");
    expect(fake.steps.map((s) => s.text)).toContain("SET LOCAL statement_timeout = 2000");
  });

  test("a script with too many statements for the budget is not tried and never connects", async () => {
    const many = Array.from({ length: 41 }, (_, i) => `ALTER TABLE books ADD COLUMN c${i} int;`).join("\n");
    expect(trialStatementTimeout(many, DOWN)).toBeNull();
    let connected = false;
    const outcome = await makeTrial({}, "public", async () => {
      connected = true;
      return fakeClient().client;
    })(many, DOWN);
    expect(outcome).toMatchObject({ status: "not-tried", reason: expect.stringContaining("too many statements") });
    expect(connected).toBe(false);
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
    expect(fake.steps.some((s) => s.text === STRUCTURE_SQL)).toBe(false);
  });

  test("the structure is read before the script and after the rollback, for this schema", async () => {
    const fake = fakeClient();
    const outcome = await makeTrial({}, "shop", async () => fake.client)(UP, DOWN);
    expect(outcome).toEqual({ status: "passed" });
    const texts = fake.steps.map((s) => s.text);
    const reads = texts.flatMap((t, i) => (t === STRUCTURE_SQL ? [i] : []));
    expect(reads).toHaveLength(2);
    expect(reads[0]).toBeLessThan(texts.indexOf(UP));
    expect(reads[1]).toBeGreaterThan(texts.indexOf(DOWN));
    expect(fake.steps[reads[0]].values).toEqual(["shop"]);
  });

  test("a rollback that removes what was there before fails the rollback step", async () => {
    const was: Rows = [
      { item: "table orders", shape: null },
      { item: "column orders.status", shape: "text" },
    ];
    const fake = fakeClient({ structures: [was, [was[0]]] });
    const noop = "ALTER TABLE orders ADD COLUMN IF NOT EXISTS status text;";
    const outcome = await makeTrial({}, "shop", async () => fake.client)(noop, "ALTER TABLE orders DROP COLUMN IF EXISTS status;");
    expect(outcome).toMatchObject({ status: "failed", step: "rollback" });
    expect(outcome.status === "failed" && outcome.message).toContain("gone: column orders.status");
    expect(fake.steps.at(-1)?.text).toBe("ROLLBACK");
  });

  test("the structure not read back is not tried, not failed", async () => {
    const fake = fakeClient({ failStructureAfter: true });
    const outcome = await makeTrial({}, "shop", async () => fake.client)(UP, DOWN);
    expect(outcome).toEqual({ status: "not-tried", reason: "The app could not read the schema back after the rollback." });
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
    const read = describeTrialError(
      {
        code: "23502",
        message: 'null value in column "stock" of relation "books" violates not-null constraint',
        detail: "Failing row contains (1, Secret Title, 9.99, null).",
        table: "books",
        column: "stock",
      },
      "ALTER TABLE books ADD COLUMN stock int NOT NULL;"
    );
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

  test("other errors get a plain description by SQLSTATE, never the message or the hint", () => {
    expect(
      describeTrialError({ code: "42P01", message: 'relation "invoices" does not exist', hint: "Check the name." }, "SELECT * FROM invoices;")
    ).toEqual({ message: 'The script uses a table or view that does not exist, SQLSTATE 42P01 ("invoices").' });
    // With no script text, no name is kept.
    expect(describeTrialError({ code: "42P01", message: 'relation "invoices" does not exist' })).toEqual({
      message: "The script uses a table or view that does not exist, SQLSTATE 42P01.",
    });
  });

  test("a RAISE that carries row values or a file's text gives none of it", () => {
    const script = "DO $$ BEGIN RAISE EXCEPTION 'price % for % is too high', 9.99, 'x' USING HINT = 'x', TABLE = 'x'; END $$;";
    const read = describeTrialError(
      { code: "P0001", message: 'price 9.99 for "Secret Title" is too high', hint: "Ask ada@example.com", table: "ada", column: "Secret Title" },
      script
    );
    expect(read).toEqual({ message: "A RAISE EXCEPTION in the script stopped it, SQLSTATE P0001." });
    expect(JSON.stringify(read)).not.toMatch(/Secret|ada|9\.99/);
  });

  test("a duplicate key keeps the constraint and table, never the key's value", () => {
    const read = describeTrialError(
      {
        code: "23505",
        message: 'could not create unique index "users_email_key"',
        detail: "Key (email)=(ada@example.com) is duplicated.",
        table: "users",
        constraint: "users_email_key",
      },
      "ALTER TABLE users ADD CONSTRAINT users_email_key UNIQUE (email);"
    );
    expect(read).toEqual({
      message:
        "Rows already in the table break the change, SQLSTATE 23505 (table users, constraint users_email_key). Say what to do with them, or add a DEFAULT.",
    });
  });

  test("an unknown code in a known class gets the class's description", () => {
    expect(describeTrialError({ code: "42P99", message: "secret words" })).toEqual({
      message: "The script has a mistake in its SQL or names something wrong, SQLSTATE 42P99.",
    });
  });

  test("a statement timeout is not tried", () => {
    expect(describeTrialError({ code: "57014" })).toHaveProperty("notTried");
  });
});
