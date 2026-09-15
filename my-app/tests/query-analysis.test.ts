/**
 * Query analysis — spec feature 08.
 *
 * Three parts are tested here, each for its own reason.
 *
 * The gate (checkAnalysable and the two plan checks) decides what reaches a
 * live server at all, so it is tested from both sides: the ordinary read
 * queries it must let through, and the writes, row locks and server-changing
 * calls it must stop, including the ones hiding behind an innocent first word.
 *
 * The plan reader is tested against hand-written EXPLAIN JSON because the real
 * thing is not available in a unit test and, more to the point, because the
 * interesting cases are the ones a healthy local database will never produce:
 * a sort that spilled to disk, an estimate out by fifty times, a nested loop
 * run ten thousand times. Fixtures are the only way to see them. The ones for
 * the rules follow the VERBOSE shape the route asks for (Schema, Alias,
 * Output, "Parent Relationship"), as PostgreSQL 17 prints it.
 *
 * The text rules are tested against queries that LOOK like they break a rule
 * but do not — the pattern inside a comment, the wildcard inside a string that
 * is not a LIKE pattern — because a linter that cries wolf gets switched off,
 * and every one of these rules is a heuristic.
 */

import {
  MAX_QUERY_LENGTH,
  QUERY_TIMEOUT_SECONDS,
  buildExplainSql,
  catalogFromRows,
  checkAnalysable,
  checkPlanIsReadOnly,
  describePlan,
  describeQueryError,
  explainInWords,
  explainPrefix,
  filterColumns,
  heaviestStepLabel,
  planMentionsDenied,
  planRelations,
  planSteps,
  readPlan as readPlanRaw,
  readSql as readSqlRaw,
  shareBand,
  shareLegend,
  shareText,
  sortFindings,
  sqlContextFromPlan,
  stepFigures,
  subqueryCaption,
  summarizeFindings,
  toQueryError,
  type PlanCatalog,
  type PlanSummary,
  type QueryError,
  type QueryFinding,
  type SqlContext,
  type SqlContextTable,
} from "@/lib/query-analysis";
import type { FixKind } from "@/lib/perf-sql";
import { allFixProblems } from "./helpers/fix-invariants";

/**
 * Every finding readPlan and readSql return anywhere in this file.
 *
 * The two are wrapped so that each call adds its findings here; the last test
 * in the file then holds every one of them to the promises its fix kind makes
 * (tests/helpers/fix-invariants.ts). A rule added later is checked the moment
 * any test produces it, without a test of its own for that.
 */
const collected: QueryFinding[] = [];

function readPlan(...args: Parameters<typeof readPlanRaw>): ReturnType<typeof readPlanRaw> {
  const summary = readPlanRaw(...args);
  if (summary) collected.push(...summary.findings);
  return summary;
}

function readSql(...args: Parameters<typeof readSqlRaw>): ReturnType<typeof readSqlRaw> {
  const findings = readSqlRaw(...args);
  collected.push(...findings);
  return findings;
}

/** Ids of the findings a call produced, so a test can assert on membership. */
function ids(findings: { id: string }[]): string[] {
  return findings.map((f) => f.id);
}

/** True when any finding's id starts with this rule's prefix. */
function hasRule(findings: { id: string }[] | undefined, rule: string): boolean {
  return ids(findings ?? []).some((id) => id.startsWith(`${rule}:`));
}

/** A minimal EXPLAIN (FORMAT JSON) envelope around one plan node. */
function envelope(plan: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return [{ Plan: plan, ...extra }];
}

/** The flattened steps of one fixture, for the checks that take steps. */
function stepsOf(plan: Record<string, unknown>) {
  const steps = planSteps(envelope(plan));
  if (!steps) throw new Error("The fixture is not a plan.");
  return steps;
}

/** What sqlContextFromPlan makes of one fixture, built the way the route builds it. */
function contextOf(plan: Record<string, unknown>, catalog: Partial<PlanCatalog> = {}): SqlContext {
  const summary = readPlan(envelope(plan), catalog);
  if (!summary) throw new Error("The fixture is not a plan.");
  return sqlContextFromPlan(summary, catalog);
}

/**
 * A hand-made context for a text rule: an empty plan that knows nothing,
 * with only the parts a test sets. Lets a test ask "what would the rule say
 * if the plan said this" without building a whole plan for it.
 */
function sqlContext(over: Partial<SqlContext> = {}): SqlContext {
  return {
    expectedRows: 0,
    measured: false,
    tables: [],
    joinedTables: 0,
    outputColumns: [],
    primaryKeys: {},
    settings: null,
    topNodeType: null,
    distinctRows: null,
    repeatsRows: false,
    relationNames: {},
    ...over,
  };
}

/** One table of a hand-made context: public.orders, unless a test says otherwise. */
function contextTable(over: Partial<SqlContextTable> = {}): SqlContextTable {
  return {
    schema: "public",
    name: "orders",
    alias: null,
    rows: 0,
    filter: null,
    readsAll: false,
    feedsPlainAggregate: false,
    selectiveScan: false,
    indexCond: null,
    columnTypes: {},
    ...over,
  };
}

// ── The gate ─────────────────────────────────────────────────────────────────

describe("checkAnalysable — what gets through", () => {
  it.each([
    ["a plain SELECT", "SELECT id FROM orders WHERE id = 7"],
    ["a WITH block that only reads", "WITH recent AS (SELECT id FROM orders) SELECT * FROM recent"],
    ["a bracketed UNION", "(SELECT id FROM a) UNION (SELECT id FROM b)"],
    ["a VALUES list", "VALUES (1, 'a'), (2, 'b')"],
    ["the TABLE shorthand", "TABLE orders"],
    ["a leading comment", "-- the slow one from the report\nSELECT id FROM orders"],
    ["a comment after the semicolon", "SELECT id FROM orders; -- checked on Monday"],
    ["lower-case keywords", "select id from orders"],
  ])("lets %s through in both modes", (_label, sql) => {
    expect(checkAnalysable(sql, false)).toBe(null);
    expect(checkAnalysable(sql, true)).toBe(null);
  });

  it("accepts a query exactly at the length limit", () => {
    const sql = "SELECT " + "1".repeat(MAX_QUERY_LENGTH - "SELECT ".length);
    expect(sql.length).toBe(MAX_QUERY_LENGTH);
    expect(checkAnalysable(sql, false)).toBe(null);
  });

  it("does not mistake INTO inside a string for SELECT … INTO", () => {
    expect(checkAnalysable("SELECT 'INTO' AS word", false)).toBe(null);
  });

  it("leaves a write inside a WITH block to the plan check", () => {
    // The text starts with WITH and its INTO sits inside brackets, so the text
    // alone cannot tell. The plain EXPLAIN's ModifyTable step can: see
    // checkPlanIsReadOnly below, which the route asks next.
    const sql = "WITH x AS (INSERT INTO t VALUES (1) RETURNING id) SELECT * FROM x";
    expect(checkAnalysable(sql, false)).toBe(null);
  });
});

describe("checkAnalysable — what is refused", () => {
  it.each([
    ["UPDATE orders SET status = 'paid'", "UPDATE"],
    ["INSERT INTO orders (id) VALUES (1)", "INSERT"],
    ["DELETE FROM orders WHERE id = 1", "DELETE"],
    ["MERGE INTO orders o USING incoming i ON o.id = i.id WHEN MATCHED THEN DELETE", "MERGE"],
    ["CREATE TABLE orders_copy (id int)", "CREATE"],
    ["-- tidy up\nTRUNCATE orders", "TRUNCATE"],
  ])("refuses %s and names the word it starts with", (sql, word) => {
    const message = checkAnalysable(sql, false);
    expect(message).toContain("Only queries that read data");
    expect(message).toContain(`starts with ${word}.`);
  });

  it("refuses a query that brings its own EXPLAIN", () => {
    // Honouring a pasted EXPLAIN ANALYZE would run the query without the
    // Measure tick-box and its editor-only check.
    expect(checkAnalysable("EXPLAIN SELECT 1", false)).toContain("without EXPLAIN");
    expect(checkAnalysable("explain analyze select 1", true)).toContain("without EXPLAIN");
  });

  it("refuses SELECT … INTO, which creates a table", () => {
    expect(checkAnalysable("SELECT * INTO orders_copy FROM orders", false)).toContain(
      "creates a new table"
    );
  });

  it("refuses two statements and says how many it found", () => {
    expect(checkAnalysable("SELECT 1; SELECT 2", false)).toContain("there are 2 here");
  });

  it("refuses transaction control", () => {
    expect(checkAnalysable("COMMIT", false)).toContain("COMMIT / ROLLBACK");
  });

  it("refuses text over the length limit, and says what the limit is", () => {
    const sql = "SELECT " + "1".repeat(MAX_QUERY_LENGTH);
    expect(checkAnalysable(sql, false)).toContain("up to 50,000");
  });

  it("asks for a query when the box is empty or holds only comments", () => {
    expect(checkAnalysable("   \n ", false)).toBe("Enter a query to analyse.");
    expect(checkAnalysable("-- nothing yet\n/* still nothing */", false)).toContain(
      "only comments"
    );
  });
});

describe("checkAnalysable — calls that act on the server", () => {
  it("refuses pg_terminate_backend only when the query would really run", () => {
    // A plain EXPLAIN plans the call without making it, so estimate mode is
    // harmless. Measured mode runs it, and READ ONLY does not stop it.
    const sql = "SELECT pg_terminate_backend(pid) FROM pg_stat_activity";
    expect(checkAnalysable(sql, false)).toBe(null);
    expect(checkAnalysable(sql, true)).toContain("pg_terminate_backend()");
    expect(checkAnalysable(sql, true)).toContain("Untick Run it and measure");
  });

  it("refuses pg_advisory_lock only when measuring, because its lock outlives the rollback", () => {
    // A session-level advisory lock is not undone by ROLLBACK: the pooled
    // connection would go back to the pool still holding it. A plain EXPLAIN
    // never takes the lock, so estimate mode lets the query through.
    const sql = "SELECT pg_advisory_lock(42)";
    expect(checkAnalysable(sql, false)).toBe(null);
    expect(checkAnalysable(sql, true)).toContain("pg_advisory_lock()");
  });

  it("refuses whole families by the start of their name", () => {
    expect(checkAnalysable("SELECT pg_advisory_lock(42)", true)).toContain("pg_advisory_lock()");
    expect(checkAnalysable("SELECT pg_try_advisory_xact_lock(42)", true)).toContain(
      "pg_try_advisory_xact_lock()"
    );
    expect(
      checkAnalysable("SELECT dblink_exec('dbname=x', 'DELETE FROM t')", true)
    ).toContain("dblink_exec()");
    expect(checkAnalysable("SELECT pg_stat_reset()", true)).toContain("pg_stat_reset()");
  });

  it("matches a call however it is capitalised, or schema-qualified", () => {
    expect(checkAnalysable("SELECT PG_Reload_Conf()", true)).toContain("pg_reload_conf()");
    expect(checkAnalysable("SELECT pg_catalog.pg_switch_wal()", true)).toContain(
      "pg_switch_wal()"
    );
  });

  it("ignores the same names inside a string or a comment", () => {
    expect(checkAnalysable("SELECT 'pg_terminate_backend(1)' AS note", true)).toBe(null);
    expect(checkAnalysable("SELECT 1 -- pg_terminate_backend(1)", true)).toBe(null);
    expect(checkAnalysable("SELECT 1 /* dblink(x) */", true)).toBe(null);
  });

  it("does not read a column that merely shares a prefix as a call", () => {
    expect(checkAnalysable("SELECT dblink_url FROM servers", true)).toBe(null);
  });

  it("refuses a denied call written as a quoted name, only when measuring", () => {
    // PostgreSQL finds the same function through "pg_try_advisory_lock" as
    // through the bare name. In a VALUES list or a LIMIT the plan never writes
    // the call out, so the text is the only place to catch it.
    const inValues = 'VALUES ("pg_try_advisory_lock"(42))';
    expect(checkAnalysable(inValues, true)).toContain("pg_try_advisory_lock()");
    expect(checkAnalysable(inValues, false)).toBe(null);
    expect(
      checkAnalysable('SELECT id FROM orders LIMIT "pg_try_advisory_lock"(1)::int', true)
    ).toContain("pg_try_advisory_lock()");
    expect(checkAnalysable('SELECT pg_catalog."pg_terminate_backend"(1)', true)).toContain(
      "pg_terminate_backend()"
    );
    expect(checkAnalysable('SELECT "pg_catalog"."pg_cancel_backend" (1)', true)).toContain(
      "pg_cancel_backend()"
    );
    expect(checkAnalysable('SELECT "dblink_exec"(\'dbname=x\', \'DELETE FROM t\')', true)).toContain(
      "dblink_exec()"
    );
  });

  it("lets quoted names that are not denied calls through when measuring", () => {
    expect(checkAnalysable('SELECT "Customer Id" FROM orders', true)).toBe(null);
    expect(checkAnalysable('SELECT "dblink" FROM servers', true)).toBe(null);
    expect(checkAnalysable('SELECT "pg_advisory_lock_count" FROM lock_stats', true)).toBe(null);
    expect(checkAnalysable('SELECT lower("Name") FROM people', true)).toBe(null);
    expect(checkAnalysable('SELECT "a""b" FROM t WHERE "x" IN (1)', true)).toBe(null);
    // Quotes inside a string or a comment are not names at all.
    expect(checkAnalysable('SELECT \'"pg_terminate_backend"(1)\' AS note', true)).toBe(null);
    expect(checkAnalysable('SELECT 1 -- "pg_terminate_backend"(1)', true)).toBe(null);
  });

  it("refuses a name spelled with U& escapes when measuring, since no list can read it", () => {
    // U&"pg\0074erminate_backend" is pg_terminate_backend with one letter
    // written as an escape.
    const sql = 'SELECT U&"pg\\0074erminate_backend"(1)';
    expect(checkAnalysable(sql, true)).toContain("U&");
    expect(checkAnalysable(sql, true)).toContain("untick Run it and measure");
    expect(checkAnalysable(sql, false)).toBe(null);
    // A U& string is data, not a name.
    expect(checkAnalysable("SELECT U&'caf\\00e9' AS word", true)).toBe(null);
  });
});

describe("checkPlanIsReadOnly", () => {
  it("refuses a DELETE hidden inside a WITH block, naming the table", () => {
    // The shape PostgreSQL 17 gives `WITH gone AS (DELETE FROM app.orders
    // RETURNING *) SELECT * FROM gone`: the write is an InitPlan under the
    // CTE Scan, and the query text starts with WITH.
    const steps = stepsOf({
      "Node Type": "CTE Scan",
      "CTE Name": "gone",
      Alias: "gone",
      "Plan Rows": 1000,
      "Total Cost": 20,
      Output: ["gone.id"],
      Plans: [
        {
          "Node Type": "ModifyTable",
          Operation: "Delete",
          "Parent Relationship": "InitPlan",
          "Relation Name": "orders",
          Schema: "app",
          Alias: "orders",
          "Plan Rows": 1000,
          "Total Cost": 18,
          Plans: [
            {
              "Node Type": "Seq Scan",
              "Parent Relationship": "Outer",
              "Relation Name": "orders",
              Schema: "app",
              Alias: "orders",
              "Plan Rows": 1000,
              "Total Cost": 18,
              Output: ["ctid"],
            },
          ],
        },
      ],
    });
    const message = checkPlanIsReadOnly(steps);
    expect(message).toContain("a DELETE on app.orders");
    expect(message).toContain("Remove the part that changes data");
  });

  it("says an UPDATE or an INSERT, with the right article", () => {
    const write = (operation: string) =>
      checkPlanIsReadOnly(
        stepsOf({
          "Node Type": "ModifyTable",
          Operation: operation,
          "Relation Name": "orders",
          Schema: "app",
          Alias: "orders",
          "Plan Rows": 0,
          "Total Cost": 8,
          Plans: [{ "Node Type": "Result", "Parent Relationship": "Outer", "Plan Rows": 1, "Total Cost": 0.01 }],
        })
      );
    expect(write("Update")).toContain("runs an UPDATE on app.orders");
    expect(write("Insert")).toContain("runs an INSERT on app.orders");
    expect(write("Merge")).toContain("runs a MERGE on app.orders");
  });

  it("refuses FOR UPDATE, which locks the rows it reads", () => {
    const steps = stepsOf({
      "Node Type": "LockRows",
      "Plan Rows": 1,
      "Total Cost": 8,
      Output: ["id", "ctid"],
      Plans: [
        {
          "Node Type": "Index Scan",
          "Parent Relationship": "Outer",
          "Relation Name": "orders",
          Schema: "app",
          Alias: "orders",
          "Index Name": "orders_pkey",
          "Plan Rows": 1,
          "Total Cost": 8,
        },
      ],
    });
    expect(checkPlanIsReadOnly(steps)).toContain("FOR UPDATE");
  });

  it("lets an ordinary read plan through", () => {
    const steps = stepsOf({
      "Node Type": "Seq Scan",
      "Relation Name": "orders",
      Schema: "app",
      Alias: "orders",
      "Plan Rows": 10,
      "Total Cost": 5,
    });
    expect(checkPlanIsReadOnly(steps)).toBe(null);
  });
});

describe("planMentionsDenied", () => {
  it("finds a call that only the plan shows, such as one inside a view", () => {
    // `SELECT * FROM app.killer`, where the view is `SELECT
    // pg_cancel_backend(0)`: the query text names only the view.
    const steps = stepsOf({
      "Node Type": "Result",
      "Plan Rows": 1,
      "Total Cost": 0.01,
      Output: ["pg_cancel_backend(0)"],
    });
    const message = planMentionsDenied(steps);
    expect(message).toContain("pg_cancel_backend()");
    expect(message).toContain("the plan shows it");
  });

  it("reads filters and function scans as well as output columns", () => {
    const filtered = stepsOf({
      "Node Type": "Seq Scan",
      "Relation Name": "sessions",
      Schema: "app",
      Alias: "sessions",
      Filter: "pg_terminate_backend(pid)",
      "Plan Rows": 1,
      "Total Cost": 1,
    });
    expect(planMentionsDenied(filtered)).toContain("pg_terminate_backend()");

    const functionScan = stepsOf({
      "Node Type": "Function Scan",
      "Function Name": "pg_logical_slot_get_changes",
      "Function Call": "pg_logical_slot_get_changes('s'::name, NULL::pg_lsn, NULL::integer)",
      Alias: "c",
      "Plan Rows": 1000,
      "Total Cost": 10,
    });
    expect(planMentionsDenied(functionScan)).toContain("pg_logical_slot_get_changes()");
  });

  it("ignores a name inside a string literal in the plan", () => {
    const steps = stepsOf({
      "Node Type": "Seq Scan",
      "Relation Name": "notes",
      Schema: "app",
      Alias: "notes",
      Filter: "(body = 'pg_terminate_backend(1)'::text)",
      "Plan Rows": 1,
      "Total Cost": 1,
    });
    expect(planMentionsDenied(steps)).toBe(null);
  });

  it("finds nothing in an ordinary plan", () => {
    const steps = stepsOf({
      "Node Type": "Seq Scan",
      "Relation Name": "orders",
      Schema: "app",
      Alias: "o",
      Filter: "((o.reference)::text = 'R7'::text)",
      Output: ["o.id", "o.total"],
      "Plan Rows": 1,
      "Total Cost": 1,
    });
    expect(planMentionsDenied(steps)).toBe(null);
  });
});

describe("buildExplainSql / explainPrefix", () => {
  it("asks for VERBOSE in both modes, and ANALYZE only when measuring", () => {
    expect(buildExplainSql("SELECT 1", false)).toBe(
      "EXPLAIN (VERBOSE, COSTS, FORMAT JSON) SELECT 1"
    );
    expect(buildExplainSql("SELECT 1", true)).toBe(
      "EXPLAIN (ANALYZE, VERBOSE, COSTS, TIMING, FORMAT JSON) SELECT 1"
    );
  });

  it("puts the query straight after the prefix, so error positions can be mapped back", () => {
    const sql = "SELECT id\n  FROM orders";
    for (const measure of [false, true]) {
      const full = buildExplainSql(sql, measure);
      expect(full.startsWith(explainPrefix(measure))).toBe(true);
      expect(full.length).toBe(explainPrefix(measure).length + sql.length);
    }
  });
});

describe("toQueryError", () => {
  it("keeps the SQLSTATE, position and hint off a driver error", () => {
    const error = Object.assign(new Error("column o.totl does not exist"), {
      code: "42703",
      position: "27",
      hint: 'Perhaps you meant to reference the column "o.total".',
    });
    expect(toQueryError(error)).toEqual({
      code: "42703",
      message: "column o.totl does not exist",
      position: "27",
      hint: 'Perhaps you meant to reference the column "o.total".',
    });
  });

  it("copes with something that is not an Error, or fields of the wrong type", () => {
    expect(toQueryError("socket hang up")).toEqual({ message: "socket hang up" });
    const odd = Object.assign(new Error("odd"), { code: 7, position: { at: 1 } });
    expect(toQueryError(odd)).toEqual({
      code: undefined,
      message: "odd",
      position: undefined,
      hint: undefined,
    });
  });
});

describe("describeQueryError", () => {
  /** The chosen schema in every case below, unless a test says otherwise. */
  const SCHEMA = "app";
  const say = (err: QueryError, source?: { sql: string; prefixLength: number }) =>
    describeQueryError(err, SCHEMA, QUERY_TIMEOUT_SECONDS, source);

  it("names both schemas it searched for a missing table", () => {
    const message = say({ code: "42P01", message: 'relation "orderz" does not exist' });
    expect(message).toContain("orderz");
    expect(message).toContain("in app or in public");
  });

  it("says only public once when public is the chosen schema", () => {
    const message = describeQueryError(
      { code: "42P01", message: 'relation "orderz" does not exist' },
      "public",
      QUERY_TIMEOUT_SECONDS
    );
    expect(message).toContain("in public");
    expect(message).not.toContain("or in public");
  });

  it("asks for both spellings when the missing name was qualified", () => {
    const message = say({ code: "42P01", message: 'relation "nope.orders" does not exist' });
    expect(message).toContain("nope.orders");
    expect(message).toContain("both the schema and the table name");
  });

  it("names a missing schema", () => {
    expect(say({ code: "3F000", message: 'schema "nope" does not exist' })).toContain(
      "no schema called nope"
    );
  });

  it("names a missing column and passes PostgreSQL's suggestion on", () => {
    const message = say({
      code: "42703",
      message: "column o.totl does not exist",
      hint: 'Perhaps you meant to reference the column "o.total".',
    });
    expect(message).toContain("no column called o.totl");
    expect(message).toContain('PostgreSQL suggests: Perhaps you meant to reference the column "o.total".');
  });

  it("points at a syntax error as a line and column of the user's own text", () => {
    // "FRM" parses as a column alias, so the error lands on "orders", which is
    // at index 16: line 2, column 7. PostgreSQL counts from the start of what
    // it was sent, 1-based, so its position includes the EXPLAIN prefix.
    const sql = "SELECT id\n  FRM orders";
    const prefixLength = explainPrefix(false).length;
    const message = say(
      {
        code: "42601",
        message: 'syntax error at or near "orders"',
        position: String(prefixLength + 16 + 1),
      },
      { sql, prefixLength }
    );
    expect(message).toContain('near "orders"');
    expect(message).toContain("line 2, column 7");
  });

  it("does not point anywhere when the position falls inside the prefix", () => {
    const message = say(
      { code: "42601", message: 'syntax error at or near "("', position: "9" },
      { sql: "SELECT 1", prefixLength: explainPrefix(false).length }
    );
    expect(message).not.toContain("line ");
  });

  it("says a query that stops too early is missing its end", () => {
    expect(say({ code: "42601", message: "syntax error at end of input" })).toContain(
      "stops too early"
    );
  });

  it("explains a refused write in plain words", () => {
    const message = say({
      code: "25006",
      message: "cannot execute nextval() in a read-only transaction",
    });
    expect(message).toContain("nextval()");
    expect(message).toContain("Untick Run it and measure");
  });

  it("tells a timeout apart from a cancel", () => {
    const timeout = say({ code: "57014", message: "canceling statement due to statement timeout" });
    expect(timeout).toContain(`after ${QUERY_TIMEOUT_SECONDS} seconds`);

    const cancel = say({ code: "57014", message: "canceling statement due to user request" });
    expect(cancel).toContain("cancelled");
    expect(cancel).not.toContain("seconds");
  });

  it("reports a lock wait as a lock, not as a slow query", () => {
    const message = say({ code: "55P03", message: "canceling statement due to lock timeout" });
    expect(message).toContain("holding a lock");
    expect(message).toContain("Nothing is wrong with the query itself");
  });

  it("says a permission error is about the database user", () => {
    const message = say({ code: "42501", message: "permission denied for table orders" });
    expect(message).toContain("not allowed");
    expect(message).toContain("permission denied for table orders");
  });

  it("tells a missing function from an operator that cannot combine types", () => {
    expect(say({ code: "42883", message: "function nofn(integer) does not exist" })).toContain(
      "no function nofn(integer)"
    );
    const operator = say({ code: "42883", message: "operator does not exist: text - integer" });
    expect(operator).toContain("text - integer");
    expect(operator).toContain("cast");
  });

  it("explains $1 placeholders", () => {
    const message = say({ code: "42P02", message: "there is no parameter $1" });
    expect(message).toContain("$1-style placeholders");
    expect(message).toContain("real value");
  });

  it("passes a data error's own message on", () => {
    expect(say({ code: "22012", message: "division by zero" })).toContain("division by zero");
  });

  it("falls back to PostgreSQL's own words, as full sentences", () => {
    const message = say({ code: "XX000", message: "something odd", hint: "try this" });
    expect(message).toBe(
      "PostgreSQL could not analyse this query. PostgreSQL said: something odd. Hint: try this."
    );
    expect(say({ message: "Connection terminated unexpectedly" })).toContain(
      "PostgreSQL said: Connection terminated unexpectedly."
    );
  });
});

// ── The plan ─────────────────────────────────────────────────────────────────

describe("readPlan", () => {
  it("returns null when handed something that is not a plan at all", () => {
    expect(readPlan(null)).toBe(null);
    expect(readPlan("QUERY PLAN")).toBe(null);
    expect(readPlan([{ notAPlan: true }])).toBe(null);
    expect(readPlan([{ Plan: { "Total Cost": 1 } }])).toBe(null);
  });

  it("accepts both the array envelope postgres sends and a bare plan object", () => {
    const node = { "Node Type": "Result", "Plan Rows": 1, "Total Cost": 0.01 };
    const fromArray = readPlan(envelope(node));
    const fromObject = readPlan({ Plan: node });
    expect(fromArray?.steps.length).toBe(1);
    expect(fromObject?.steps.length).toBe(1);
  });

  it("flattens the tree into parent-before-child order with a depth on each step", () => {
    const summary = readPlan(
      envelope({
        "Node Type": "Hash Join",
        "Plan Rows": 10,
        "Total Cost": 50,
        Plans: [
          { "Node Type": "Seq Scan", "Relation Name": "a", "Plan Rows": 10, "Total Cost": 20 },
          {
            "Node Type": "Hash",
            "Plan Rows": 5,
            "Total Cost": 15,
            Plans: [
              { "Node Type": "Seq Scan", "Relation Name": "b", "Plan Rows": 5, "Total Cost": 10 },
            ],
          },
        ],
      })
    );
    expect(summary?.steps.map((s) => s.nodeType)).toEqual([
      "Hash Join",
      "Seq Scan",
      "Hash",
      "Seq Scan",
    ]);
    expect(summary?.steps.map((s) => s.depth)).toEqual([0, 1, 1, 2]);
  });

  it("names the table and the index in the step label", () => {
    const summary = readPlan(
      envelope({
        "Node Type": "Index Scan",
        "Relation Name": "orders",
        "Index Name": "orders_pkey",
        Alias: "o",
        "Plan Rows": 1,
        "Total Cost": 8,
      })
    );
    expect(summary?.steps[0].label).toBe("Index Scan using orders_pkey on orders o");
  });

  it("leaves the alias out of the label when it only repeats the table name", () => {
    const summary = readPlan(
      envelope({
        "Node Type": "Seq Scan",
        "Relation Name": "orders",
        Alias: "orders",
        "Plan Rows": 1,
        "Total Cost": 8,
      })
    );
    expect(summary?.steps[0].label).toBe("Seq Scan on orders");
  });

  it("puts the verb back into a ModifyTable label", () => {
    const summary = readPlan(
      envelope({
        "Node Type": "ModifyTable",
        Operation: "Update",
        "Relation Name": "orders",
        "Plan Rows": 1,
        "Total Cost": 8,
      })
    );
    expect(summary?.steps[0].label).toBe("Update on orders");
  });

  it("explains the common node types in words", () => {
    const summary = readPlan(
      envelope({ "Node Type": "Seq Scan", "Relation Name": "t", "Plan Rows": 1, "Total Cost": 1 })
    );
    expect(summary?.steps[0].meaning).toContain("every row");
  });

  it("leaves the explanation empty rather than inventing one for an unknown node", () => {
    const summary = readPlan(
      envelope({ "Node Type": "Custom Scan", "Plan Rows": 1, "Total Cost": 1 })
    );
    expect(summary?.steps[0].meaning).toBe("");
  });

  it("reports the plan as unmeasured when it came from a plain EXPLAIN", () => {
    const summary = readPlan(
      envelope({ "Node Type": "Seq Scan", "Relation Name": "t", "Plan Rows": 3, "Total Cost": 9 })
    );
    expect(summary?.measured).toBe(false);
    // Not run, so the heaviest step is picked by the planner's cost, and says so.
    expect(summary?.heaviestStepId).toBe(0);
    expect(summary?.basis).toBe("cost");
    expect(summary?.steps[0].actualRows).toBe(null);
  });

  it("subtracts child time so each step's own cost is what is reported", () => {
    // Parent 10 ms inclusive, child 8 ms — the parent itself did 2 ms of work.
    const summary = readPlan(
      envelope({
        "Node Type": "Hash Join",
        "Plan Rows": 1,
        "Total Cost": 10,
        "Actual Total Time": 10,
        "Actual Rows": 1,
        "Actual Loops": 1,
        Plans: [
          {
            "Node Type": "Seq Scan",
            "Relation Name": "t",
            "Plan Rows": 1,
            "Total Cost": 8,
            "Actual Total Time": 8,
            "Actual Rows": 1,
            "Actual Loops": 1,
          },
        ],
      })
    );
    expect(summary?.measured).toBe(true);
    expect(summary?.steps[0].selfMs).toBe(2);
    expect(summary?.steps[1].selfMs).toBe(8);
    expect(summary?.heaviestStepId).toBe(1);
    expect(summary?.basis).toBe("time");
  });

  it("multiplies a repeated inner step's time by its loop count", () => {
    const summary = readPlan(
      envelope({
        "Node Type": "Nested Loop",
        "Plan Rows": 1,
        "Total Cost": 10,
        "Actual Total Time": 100,
        "Actual Rows": 1,
        "Actual Loops": 1,
        Plans: [
          {
            "Node Type": "Index Scan",
            "Relation Name": "t",
            "Plan Rows": 1,
            "Total Cost": 1,
            "Actual Total Time": 0.05,
            "Actual Rows": 1,
            "Actual Loops": 1000,
          },
        ],
      })
    );
    // 0.05 ms a time, a thousand times, is 50 ms — not 0.05.
    expect(summary?.steps[1].selfMs).toBe(50);
    expect(summary?.steps[0].selfMs).toBe(50);
  });

  it("never reports a negative self time when the reported numbers round badly", () => {
    const summary = readPlan(
      envelope({
        "Node Type": "Limit",
        "Plan Rows": 1,
        "Total Cost": 1,
        "Actual Total Time": 0.5,
        "Actual Rows": 1,
        "Actual Loops": 1,
        Plans: [
          {
            "Node Type": "Seq Scan",
            "Relation Name": "t",
            "Plan Rows": 1,
            "Total Cost": 1,
            "Actual Total Time": 0.6,
            "Actual Rows": 1,
            "Actual Loops": 1,
          },
        ],
      })
    );
    expect(summary?.steps[0].selfMs).toBe(0);
  });

  it("carries the planning and execution times through", () => {
    const summary = readPlan(
      envelope(
        {
          "Node Type": "Seq Scan",
          "Relation Name": "t",
          "Plan Rows": 1,
          "Total Cost": 1,
          "Actual Total Time": 1,
          "Actual Rows": 1,
          "Actual Loops": 1,
        },
        { "Planning Time": 0.3, "Execution Time": 1.2 }
      )
    );
    expect(summary?.planningMs).toBe(0.3);
    expect(summary?.executionMs).toBe(1.2);
  });
});

describe("planSteps", () => {
  it("returns null for anything that is not a plan", () => {
    expect(planSteps(null)).toBe(null);
    expect(planSteps([{ Plan: { "Total Cost": 1 } }])).toBe(null);
  });

  it("reads the VERBOSE fields each rule and check relies on", () => {
    // A two-table join as PostgreSQL 17 prints it with VERBOSE: the filter and
    // the join condition carry the alias, and every step says what it outputs.
    const steps = stepsOf({
      "Node Type": "Hash Join",
      "Plan Rows": 1,
      "Total Cost": 40,
      Output: ["o.id", "c.name"],
      "Hash Cond": "(o.customer_id = c.id)",
      Plans: [
        {
          "Node Type": "Seq Scan",
          "Parent Relationship": "Outer",
          "Relation Name": "orders",
          Schema: "app",
          Alias: "o",
          "Plan Rows": 1,
          "Total Cost": 20,
          Output: ["o.id", "o.customer_id"],
          Filter: "((o.reference)::text = 'R7'::text)",
        },
        {
          "Node Type": "Hash",
          "Parent Relationship": "Inner",
          "Plan Rows": 100,
          "Total Cost": 10,
          Output: ["c.name", "c.id"],
          Plans: [
            {
              "Node Type": "Index Scan",
              "Parent Relationship": "Outer",
              "Relation Name": "customers",
              Schema: "app",
              Alias: "c",
              "Index Name": "customers_pkey",
              "Index Cond": "(c.id > 0)",
              "Plan Rows": 100,
              "Total Cost": 9,
              Output: ["c.name", "c.id"],
            },
          ],
        },
      ],
    });

    expect(steps[0]).toMatchObject({
      parentId: null,
      parentRelationship: null,
      joinCond: "(o.customer_id = c.id)",
      output: "o.id, c.name",
      filter: null,
      alias: null,
    });
    expect(steps[1]).toMatchObject({
      parentId: 0,
      parentRelationship: "Outer",
      relation: "orders",
      relationSchema: "app",
      alias: "o",
      filter: "((o.reference)::text = 'R7'::text)",
      output: "o.id, o.customer_id",
    });
    expect(steps[2]).toMatchObject({ parentId: 0, parentRelationship: "Inner" });
    // An index lookup's condition is what it matches rows on, so it is read
    // as the step's joinCond too.
    expect(steps[3]).toMatchObject({ parentId: 2, joinCond: "(c.id > 0)", alias: "c" });
  });

  it("shows a function scan's call among the details", () => {
    const steps = stepsOf({
      "Node Type": "Function Scan",
      "Function Name": "generate_series",
      "Function Call": "generate_series(1, 10)",
      Alias: "g",
      "Plan Rows": 10,
      "Total Cost": 0.1,
    });
    expect(steps[0].details).toContain("Function Call: generate_series(1, 10)");
  });
});

describe("planRelations", () => {
  it("lists each table once, schema and name side by side", () => {
    const steps = stepsOf({
      "Node Type": "Append",
      "Plan Rows": 3,
      "Total Cost": 30,
      Plans: [
        { "Node Type": "Seq Scan", "Parent Relationship": "Member", "Relation Name": "orders", Schema: "app", Alias: "orders", "Plan Rows": 1, "Total Cost": 10 },
        { "Node Type": "Seq Scan", "Parent Relationship": "Member", "Relation Name": "orders", Schema: "archive", Alias: "orders_1", "Plan Rows": 1, "Total Cost": 10 },
        { "Node Type": "Index Scan", "Parent Relationship": "Member", "Relation Name": "orders", Schema: "app", Alias: "orders_2", "Plan Rows": 1, "Total Cost": 10 },
        // No schema (a plan taken without VERBOSE) and no table at all: both skipped.
        { "Node Type": "Seq Scan", "Parent Relationship": "Member", "Relation Name": "loose", "Plan Rows": 1, "Total Cost": 10 },
        { "Node Type": "Function Scan", "Parent Relationship": "Member", "Function Name": "generate_series", "Plan Rows": 1, "Total Cost": 10 },
      ],
    });
    expect(planRelations(steps)).toEqual({
      schemas: ["app", "archive"],
      names: ["orders", "orders"],
    });
  });
});

describe("catalogFromRows", () => {
  it("builds every lookup the rules use from the catalog query results", () => {
    const catalog = catalogFromRows({
      sizes: [
        // node-pg returns bigint as a string.
        { schema_name: "app", table_name: "orders", row_count: "50000" },
        // Never analysed: reltuples was -1, GREATEST made it 0, and 0 means "unknown".
        { schema_name: "app", table_name: "fresh", row_count: "0" },
      ],
      columns: [
        { schema_name: "app", table_name: "orders", column_name: "id", data_type: "integer", not_null: true },
        { schema_name: "app", table_name: "orders", column_name: "reference", data_type: "character varying(20)", not_null: false },
      ],
      indexes: [
        { schema_name: "app", table_name: "orders", index_name: "orders_pkey", is_primary: true, is_unique: true, is_valid: true, columns: ["id"] },
        { schema_name: "app", table_name: "orders", index_name: "orders_lower_ref", is_primary: false, is_unique: false, is_valid: false, columns: [null, "customer_id"] },
        { schema_name: "app", table_name: "orders", index_name: "odd", is_primary: false, is_unique: false, is_valid: true, columns: "{id}" },
      ],
      relationNames: [
        { schema_name: "app", relname: "orders" },
        { schema_name: "app", relname: "orders_pkey" },
      ],
      settings: { join_collapse_limit: "8", geqo_threshold: "12", geqo: "on" },
    });

    expect(catalog.tableRows).toEqual({ "app.orders": 50000 });
    expect(catalog.columns["app.orders"]).toEqual([
      { name: "id", type: "integer", notNull: true },
      { name: "reference", type: "character varying(20)", notNull: false },
    ]);
    expect(catalog.indexes["app.orders"]).toEqual([
      { name: "orders_pkey", primary: true, unique: true, valid: true, columns: ["id"] },
      // An expression key is null, and an unfinished index is marked invalid.
      { name: "orders_lower_ref", primary: false, unique: false, valid: false, columns: [null, "customer_id"] },
      // Columns that did not arrive as an array are dropped, not guessed at.
      { name: "odd", primary: false, unique: false, valid: true, columns: [] },
    ]);
    expect(catalog.relationNames).toEqual({ app: ["orders", "orders_pkey"] });
    expect(catalog.settings).toEqual({ joinCollapseLimit: 8, geqoThreshold: 12, geqo: true });
  });

  it("reads geqo off as false, and unreadable settings as none at all", () => {
    expect(
      catalogFromRows({ settings: { join_collapse_limit: "8", geqo_threshold: "12", geqo: "off" } })
        .settings
    ).toEqual({ joinCollapseLimit: 8, geqoThreshold: 12, geqo: false });
    expect(
      catalogFromRows({ settings: { join_collapse_limit: "lots", geqo_threshold: "12", geqo: "on" } })
        .settings
    ).toBe(null);
  });

  it("returns empty lookups when nothing could be read", () => {
    expect(catalogFromRows({})).toEqual({
      tableRows: {},
      columns: {},
      indexes: {},
      relationNames: {},
      settings: null,
    });
  });
});

describe("readPlan — findings", () => {
  it("flags a filtered sequential scan over a large table and hands over the index", () => {
    // A million rows read to keep fifty thousand, on one equality column: an
    // index on status is the plain answer, so the fix is the statement
    // itself, and the undo is the DROP INDEX that takes it back out.
    const summary = readPlan(
      envelope({
        "Node Type": "Seq Scan",
        "Relation Name": "orders",
        Schema: "public",
        Alias: "orders",
        Filter: "(status = 'paid'::text)",
        "Plan Rows": 50000,
        "Total Cost": 900,
      }),
      { tableRows: { "public.orders": 1000000 } }
    );
    const finding = summary?.findings.find((f) => f.id === "seq-scan:0");
    expect(finding?.severity).toBe("high");
    expect(finding?.fixKind).toBe("change");
    expect(finding?.title).toBe("Index the column status");
    expect(finding?.fix).toContain(
      'CREATE INDEX "orders_status_idx" ON "public"."orders" ("status");'
    );
    expect(finding?.undo).toBe('DROP INDEX "public"."orders_status_idx";');
    // CREATE INDEX CONCURRENTLY cannot run inside a transaction, so it is
    // only ever mentioned as advice, never as a statement to run.
    const concurrently = (finding?.fix ?? "").split("\n").filter((l) => l.includes("CONCURRENTLY"));
    expect(concurrently.length).toBeGreaterThan(0);
    expect(concurrently.every((line) => line.startsWith("--"))).toBe(true);
  });

  it("adds an estimated parallel scan's share back up before judging its filter", () => {
    // Per process, 83,000 of a million rows looked like a twelfth of the
    // table and passed for selective. In all it is 199,200, a fifth: too many
    // for an index to help.
    const catalog = { tableRows: { "public.readings": 1000000 } };
    const wide = readPlan(envelope(readingsInParallel(83000)), catalog);
    expect(wide?.findings.map((f) => f.id)).not.toContain("seq-scan:1");
    expect(wide?.findings.some((f) => f.title.startsWith("Index"))).toBe(false);
    // One keeping 9,600 in all is still worth an index, and its words give
    // that total rather than one process's share.
    const narrow = readPlan(envelope(readingsInParallel(4000)), catalog);
    const finding = narrow?.findings.find((f) => f.id === "seq-scan:1");
    expect(finding?.severity).toBe("high");
    expect(finding?.title).toBe("Index the column v");
    expect(finding?.detail).toContain("Only about 9,600 rows are expected to match");
  });

  it("does not judge an estimated parallel scan when the Gather gave no planned count", () => {
    // Without "Workers Planned" the share cannot be added back up, so the
    // scan is left alone rather than judged by one process's rows.
    const plan = readingsInParallel(4000);
    delete plan["Workers Planned"];
    const summary = readPlan(envelope(plan), { tableRows: { "public.readings": 1000000 } });
    expect(summary?.findings.map((f) => f.id)).not.toContain("seq-scan:1");
  });

  it("gives the whole-table read a decision when no one index can serve the filter", () => {
    // An OR across two columns needs an index on each side, so which to build
    // is a judgement: every line of the fix is a comment, the filter it would
    // serve is shown on one of them, and there is nothing to undo.
    const summary = readPlan(
      envelope({
        "Node Type": "Seq Scan",
        "Relation Name": "orders",
        Schema: "public",
        Alias: "orders",
        Filter: "((status = 'paid'::text) OR (customer_id = 42))",
        "Plan Rows": 50000,
        "Total Cost": 900,
      }),
      { tableRows: { "public.orders": 1000000 } }
    );
    const finding = summary?.findings.find((f) => f.id === "seq-scan:0");
    expect(finding?.fixKind).toBe("decision");
    expect(finding?.title).toBe("Whole table read to answer this");
    const fix = finding?.fix ?? "";
    expect(fix).toContain("--   ((status = 'paid'::text) OR (customer_id = 42))");
    expect(fix).toContain("An index serves it only when built on what it compares");
    expect(fix.split("\n").every((line) => line.startsWith("--"))).toBe(true);
    expect(fix).not.toContain("CONCURRENTLY");
    expect(finding?.undo).toBeUndefined();
  });

  it("does not flag a sequential scan that has no filter", () => {
    // SELECT * FROM big asks for the whole table; no index can help with that.
    const summary = readPlan(
      envelope({
        "Node Type": "Seq Scan",
        "Relation Name": "orders",
        Schema: "public",
        Alias: "orders",
        "Plan Rows": 50000,
        "Total Cost": 900,
      }),
      { tableRows: { "public.orders": 50000 } }
    );
    expect(summary?.findings).toEqual([]);
  });

  it("leaves a sequential scan of a small table alone", () => {
    // Reading forty rows in order is the right plan and always will be.
    const summary = readPlan(
      envelope({
        "Node Type": "Seq Scan",
        "Relation Name": "currencies",
        Schema: "public",
        Filter: "(code = 'EUR'::bpchar)",
        "Plan Rows": 40,
        "Total Cost": 2,
      })
    );
    expect(summary?.findings).toEqual([]);
  });

  it("flags a selective scan of a large table once told how large it is", () => {
    // The case the whole rule exists for: the plan says one row comes back, so
    // the plan alone reads as harmless. The table's real size is what makes it
    // a whole-table read, and nothing in EXPLAIN carries that.
    const plan = envelope({
      "Node Type": "Seq Scan",
      "Relation Name": "orders",
      Schema: "public",
      Alias: "orders",
      "Plan Rows": 1,
      "Total Cost": 900,
      Filter: "(reference = 'AB-1'::text)",
    });

    expect(readPlan(plan)?.findings).toEqual([]);

    const informed = readPlan(plan, { tableRows: { "public.orders": 400000 } });
    expect(ids(informed?.findings ?? [])).toContain("seq-scan:0");
    expect(informed?.findings[0].detail).toContain("400,000 rows");
    // It should say what the reader is actually getting for that work.
    expect(informed?.findings[0].detail).toContain("1 row is expected to match");
  });

  it("does not lend one schema's row count to a same-named table in another", () => {
    // Two schemas holding an "orders" table is the normal case for this app —
    // dev and prod side by side on one server is what it exists to compare. A
    // size keyed on the bare name would report the busy table's size against a
    // scan of the empty one.
    const summary = readPlan(
      envelope({
        "Node Type": "Seq Scan",
        "Relation Name": "orders",
        Schema: "staging",
        "Plan Rows": 1,
        "Total Cost": 900,
        Filter: "(reference = 'AB-1'::text)",
      }),
      { tableRows: { "public.orders": 400000 } }
    );
    expect(summary?.findings).toEqual([]);
  });

  it("falls back to the plan's own number when the plan names no schema", () => {
    // Nothing to key on means nothing to look up. The weaker reading is the
    // right answer here — picking whichever same-named table happened to be in
    // the map would be inventing the one fact this rule turns on.
    const summary = readPlan(
      envelope({
        "Node Type": "Seq Scan",
        "Relation Name": "orders",
        "Plan Rows": 1,
        "Total Cost": 900,
        Filter: "(reference = 'AB-1'::text)",
      }),
      { tableRows: { "public.orders": 400000 } }
    );
    expect(summary?.findings).toEqual([]);
  });

  it("trusts the rows a run read over a stale table size", () => {
    // reltuples is a stale estimate. When the query ran, the rows the step
    // really read (the ones it kept plus the ones its filter threw away) are
    // the fresher count, however small the statistics say the table is.
    const summary = readPlan(
      envelope({
        "Node Type": "Seq Scan",
        "Relation Name": "orders",
        Schema: "public",
        Filter: "(status = 'paid'::text)",
        "Plan Rows": 500,
        "Actual Rows": 500,
        "Rows Removed by Filter": 59500,
        "Actual Loops": 1,
        "Actual Total Time": 50,
        "Total Cost": 900,
      }),
      { tableRows: { "public.orders": 12 } }
    );
    const detail = summary?.findings.find((f) => f.id === "seq-scan:0")?.detail ?? "";
    expect(detail).toContain("60,000 rows");
    expect(detail).toContain("59,500 of them are thrown away");
  });

  it("does not apply a table size to a step that is not reading that table", () => {
    // "Sort" carries no Relation Name, so nothing should be looked up for it —
    // otherwise a sort of four rows inherits the size of the table below it.
    const summary = readPlan(
      envelope({
        "Node Type": "Sort",
        "Plan Rows": 4,
        "Total Cost": 10,
        Plans: [
          {
            "Node Type": "Index Scan",
            "Parent Relationship": "Outer",
            "Relation Name": "orders",
            Schema: "public",
            "Plan Rows": 4,
          },
        ],
      }),
      { tableRows: { "public.orders": 900000 } }
    );
    // An index scan is not a whole-table read however big the table is, and the
    // sort above it is not a read at all.
    expect(summary?.findings).toEqual([]);
  });

  it("says how many rows a whole-table read threw away, formatted", () => {
    // The plan reports the count as a raw "Rows Removed by Filter: 39999".
    // Repeating that verbatim would put an unseparated number next to a
    // formatted one in the same sentence.
    const summary = readPlan(
      envelope({
        "Node Type": "Seq Scan",
        "Relation Name": "events",
        Schema: "public",
        Filter: "(kind = 'error'::text)",
        "Rows Removed by Filter": 39999,
        "Plan Rows": 1,
        "Total Cost": 900,
        "Actual Total Time": 40,
        "Actual Rows": 1,
        "Actual Loops": 1,
      }),
      { tableRows: { "public.events": 40000 } }
    );
    const seqScan = summary?.findings.find((f) => f.id === "seq-scan:0");
    expect(seqScan?.detail).toContain("39,999 of them are thrown away");
  });

  it("counts every loop of a repeated whole-table read", () => {
    // Actual Rows and Rows Removed by Filter are per loop: 50 loops of
    // (1 kept + 399 removed) is 20,000 rows read, over the threshold, even
    // though no single loop reads more than 400.
    const summary = readPlan(
      envelope({
        "Node Type": "Seq Scan",
        "Relation Name": "events",
        Schema: "public",
        Filter: "(kind = 'error'::text)",
        "Rows Removed by Filter": 399,
        "Plan Rows": 1,
        "Total Cost": 9,
        "Actual Total Time": 0.2,
        "Actual Rows": 1,
        "Actual Loops": 50,
      })
    );
    const seqScan = summary?.findings.find((f) => f.id === "seq-scan:0");
    expect(seqScan?.detail).toContain("20,000 rows");
    expect(seqScan?.detail).toContain("19,950 of them are thrown away");
  });

  it("marks a whole-table read under a LIMIT as possibly cheaper, when only estimated", () => {
    // SELECT … WHERE flag LIMIT 1 may stop at the first match. An estimate
    // cannot know how soon, so the finding drops a step and says so.
    const summary = readPlan(
      envelope({
        "Node Type": "Limit",
        "Plan Rows": 1,
        "Total Cost": 5,
        Plans: [
          {
            "Node Type": "Seq Scan",
            "Parent Relationship": "Outer",
            "Relation Name": "orders",
            Schema: "public",
            Alias: "orders",
            Filter: "(status = 'paid'::text)",
            "Plan Rows": 1,
            "Total Cost": 900,
          },
        ],
      }),
      { tableRows: { "public.orders": 400000 } }
    );
    const seqScan = summary?.findings.find((f) => f.id === "seq-scan:1");
    expect(seqScan?.severity).toBe("medium");
    expect(seqScan?.detail).toContain("A LIMIT above this step may stop the read early");
  });

  it("keeps it serious when a sort between the LIMIT and the scan needs every row", () => {
    const summary = readPlan(
      envelope({
        "Node Type": "Limit",
        "Plan Rows": 1,
        "Total Cost": 5,
        Plans: [
          {
            "Node Type": "Sort",
            "Parent Relationship": "Outer",
            "Plan Rows": 1,
            "Total Cost": 5,
            Plans: [
              {
                "Node Type": "Seq Scan",
                "Parent Relationship": "Outer",
                "Relation Name": "orders",
                Schema: "public",
                Alias: "orders",
                Filter: "(status = 'paid'::text)",
                "Plan Rows": 1,
                "Total Cost": 900,
              },
            ],
          },
        ],
      }),
      { tableRows: { "public.orders": 400000 } }
    );
    expect(summary?.findings.find((f) => f.id === "seq-scan:2")?.severity).toBe("high");
  });

  it("keeps it serious inside a subquery, which runs on its own terms", () => {
    const summary = readPlan(
      envelope({
        "Node Type": "Limit",
        "Plan Rows": 1,
        "Total Cost": 5,
        Plans: [
          {
            "Node Type": "Result",
            "Parent Relationship": "Outer",
            "Plan Rows": 1,
            "Total Cost": 5,
            Plans: [
              {
                "Node Type": "Seq Scan",
                "Parent Relationship": "InitPlan",
                "Relation Name": "orders",
                Schema: "public",
                Alias: "orders",
                Filter: "(status = 'paid'::text)",
                "Plan Rows": 1,
                "Total Cost": 900,
              },
            ],
          },
        ],
      }),
      { tableRows: { "public.orders": 400000 } }
    );
    expect(summary?.findings.find((f) => f.id === "seq-scan:2")?.severity).toBe("high");
  });

  it("keeps it serious under a LIMIT once measured, because the count is then exact", () => {
    const summary = readPlan(
      envelope({
        "Node Type": "Limit",
        "Plan Rows": 1,
        "Total Cost": 5,
        "Actual Total Time": 40,
        "Actual Rows": 1,
        "Actual Loops": 1,
        Plans: [
          {
            "Node Type": "Seq Scan",
            "Parent Relationship": "Outer",
            "Relation Name": "orders",
            Schema: "public",
            Alias: "orders",
            Filter: "(status = 'paid'::text)",
            "Rows Removed by Filter": 39999,
            "Plan Rows": 1,
            "Total Cost": 900,
            "Actual Total Time": 40,
            "Actual Rows": 1,
            "Actual Loops": 1,
          },
        ],
      })
    );
    expect(summary?.findings.find((f) => f.id === "seq-scan:1")?.severity).toBe("high");
  });

  it("flags an index scan whose filter discards nearly everything it fetched", () => {
    const summary = readPlan(
      envelope({
        "Node Type": "Index Scan",
        "Relation Name": "events",
        Schema: "public",
        Alias: "events",
        "Index Name": "events_created_idx",
        "Index Cond": "(created_at > '2024-01-01'::date)",
        Filter: "(kind = 'error'::text)",
        "Rows Removed by Filter": 99000,
        "Plan Rows": 1000,
        "Total Cost": 900,
        "Actual Total Time": 40,
        "Actual Rows": 1000,
        "Actual Loops": 1,
      })
    );
    const finding = summary?.findings.find((f) => f.id === "wasteful-filter:0");
    expect(finding).toBeDefined();
    // The fix shows what the index matched and what the filter then threw
    // away, all as comments: whether to widen the index is a decision.
    expect(finding?.fix).toContain("--   (created_at > '2024-01-01'::date)");
    expect(finding?.fix).toContain("--   (kind = 'error'::text)");
    expect(finding?.fix.split("\n").every((line) => line.startsWith("--"))).toBe(true);
  });

  it("leaves a sequential scan's filter to the whole-table rule", () => {
    // Same numbers on a Seq Scan: the whole-table rule already covers it, and
    // two findings about one scan would read as two problems.
    const summary = readPlan(
      envelope({
        "Node Type": "Seq Scan",
        "Relation Name": "events",
        Schema: "public",
        Filter: "(kind = 'error'::text)",
        "Rows Removed by Filter": 99000,
        "Plan Rows": 1000,
        "Total Cost": 900,
        "Actual Total Time": 40,
        "Actual Rows": 1000,
        "Actual Loops": 1,
      })
    );
    expect(hasRule(summary?.findings, "wasteful-filter")).toBe(false);
    expect(hasRule(summary?.findings, "seq-scan")).toBe(true);
  });

  it("does not flag a wasteful filter on a plan that was never run", () => {
    // Without ANALYZE there is no "rows removed" to compare against — the key
    // is simply absent, and guessing from the estimate would be a fabrication.
    const summary = readPlan(
      envelope({
        "Node Type": "Index Scan",
        "Relation Name": "events",
        Schema: "public",
        "Index Name": "events_created_idx",
        Filter: "(kind = 'error'::text)",
        "Plan Rows": 1000,
        "Total Cost": 900,
      })
    );
    expect(hasRule(summary?.findings, "wasteful-filter")).toBe(false);
  });

  it("flags an estimate that is out by an order of magnitude, with the ANALYZE to run", () => {
    const summary = readPlan(
      envelope({
        "Node Type": "Index Scan",
        "Relation Name": "orders",
        Schema: "public",
        Alias: "o",
        "Index Name": "orders_customer_idx",
        "Plan Rows": 10,
        "Total Cost": 20,
        "Actual Total Time": 30,
        "Actual Rows": 4000,
        "Actual Loops": 1,
      })
    );
    const finding = summary?.findings.find((f) => f.id === "estimate-off:0");
    expect(finding?.detail).toContain("out by about 400×");
    // Built from the schema and table, never the label: the label says "orders o".
    expect(finding?.fix).toBe('ANALYZE "public"."orders";');
  });

  it("does not read a repeated one-row lookup as an estimate out by a thousand", () => {
    // Actual Rows and Plan Rows are both per loop. One row a time, a thousand
    // times, against an estimate of one row, is a perfect estimate.
    const summary = readPlan(
      envelope({
        "Node Type": "Nested Loop",
        "Plan Rows": 1000,
        "Total Cost": 500,
        "Actual Total Time": 20,
        "Actual Rows": 1000,
        "Actual Loops": 1,
        Plans: [
          {
            "Node Type": "Seq Scan",
            "Parent Relationship": "Outer",
            "Relation Name": "customers",
            Schema: "public",
            Alias: "c",
            "Plan Rows": 1000,
            "Total Cost": 20,
            "Actual Total Time": 1,
            "Actual Rows": 1000,
            "Actual Loops": 1,
          },
          {
            "Node Type": "Index Scan",
            "Parent Relationship": "Inner",
            "Relation Name": "orders",
            Schema: "public",
            Alias: "o",
            "Index Name": "orders_customer_idx",
            "Index Cond": "(o.customer_id = c.id)",
            "Plan Rows": 1,
            "Total Cost": 0.3,
            "Actual Total Time": 0.01,
            "Actual Rows": 1,
            "Actual Loops": 1000,
          },
        ],
      })
    );
    expect(hasRule(summary?.findings, "estimate-off")).toBe(false);
  });

  it("names the tables under a join whose estimate is off, as a decision", () => {
    const summary = readPlan(
      envelope({
        "Node Type": "Hash Join",
        "Plan Rows": 10,
        "Total Cost": 100,
        "Actual Total Time": 30,
        "Actual Rows": 5000,
        "Actual Loops": 1,
        Plans: [
          {
            "Node Type": "Seq Scan",
            "Parent Relationship": "Outer",
            "Relation Name": "orders",
            Schema: "public",
            Alias: "o",
            "Plan Rows": 5000,
            "Total Cost": 80,
            "Actual Total Time": 10,
            "Actual Rows": 5000,
            "Actual Loops": 1,
          },
          {
            "Node Type": "Hash",
            "Parent Relationship": "Inner",
            "Plan Rows": 100,
            "Total Cost": 5,
            "Actual Total Time": 1,
            "Actual Rows": 100,
            "Actual Loops": 1,
            Plans: [
              {
                "Node Type": "Seq Scan",
                "Parent Relationship": "Outer",
                "Relation Name": "customers",
                Schema: "public",
                Alias: "c",
                "Plan Rows": 100,
                "Total Cost": 5,
                "Actual Total Time": 1,
                "Actual Rows": 100,
                "Actual Loops": 1,
              },
            ],
          },
        ],
      })
    );
    const fix = summary?.findings.find((f) => f.id === "estimate-off:0")?.fix ?? "";
    expect(fix).toContain('-- ANALYZE "public"."orders";');
    expect(fix).toContain('-- ANALYZE "public"."customers";');
    expect(fix.split("\n").every((line) => line.startsWith("--"))).toBe(true);
  });

  it("ignores an estimate that is off on a handful of rows", () => {
    // Two rows where one was expected is not stale statistics, it is rounding.
    const summary = readPlan(
      envelope({
        "Node Type": "Index Scan",
        "Relation Name": "orders",
        "Index Name": "orders_pkey",
        "Plan Rows": 1,
        "Total Cost": 8,
        "Actual Total Time": 0.1,
        "Actual Rows": 2,
        "Actual Loops": 1,
      })
    );
    expect(hasRule(summary?.findings, "estimate-off")).toBe(false);
  });

  it("flags a sort that spilled to disk", () => {
    const summary = readPlan(
      envelope({
        "Node Type": "Sort",
        "Sort Key": ["created_at"],
        "Sort Method": "external merge  Disk: 4096kB",
        "Plan Rows": 100,
        "Total Cost": 200,
      })
    );
    expect(hasRule(summary?.findings, "sort-on-disk")).toBe(true);
  });

  it("leaves an in-memory sort alone", () => {
    const summary = readPlan(
      envelope({
        "Node Type": "Sort",
        "Sort Key": ["created_at"],
        "Sort Method": "quicksort  Memory: 25kB",
        "Plan Rows": 100,
        "Total Cost": 200,
      })
    );
    expect(hasRule(summary?.findings, "sort-on-disk")).toBe(false);
  });

  it("flags a nested loop that reads its inner table in full on every pass", () => {
    const summary = readPlan(
      envelope({
        "Node Type": "Nested Loop",
        "Plan Rows": 5000,
        "Total Cost": 10,
        "Actual Total Time": 900,
        "Actual Rows": 5000,
        "Actual Loops": 1,
        Plans: [
          {
            "Node Type": "Seq Scan",
            "Parent Relationship": "Outer",
            "Relation Name": "orders",
            Schema: "public",
            Alias: "o",
            "Plan Rows": 5000,
            "Total Cost": 80,
            "Actual Total Time": 5,
            "Actual Rows": 5000,
            "Actual Loops": 1,
          },
          {
            "Node Type": "Seq Scan",
            "Parent Relationship": "Inner",
            "Relation Name": "line_items",
            Schema: "public",
            Alias: "li",
            Filter: "(li.order_id = o.id)",
            "Rows Removed by Filter": 999,
            "Plan Rows": 1,
            "Total Cost": 1,
            "Actual Total Time": 0.1,
            "Actual Rows": 1,
            "Actual Loops": 5000,
          },
        ],
      })
    );
    // The repeated inner read is reported once, by the join's own rule. Its
    // condition compares one column of line_items, so the fix is a plain
    // index on that column, with the DROP INDEX that undoes it.
    expect(ids(summary?.findings ?? [])).toEqual(["nested-loop:0"]);
    const finding = summary?.findings.find((f) => f.id === "nested-loop:0");
    expect(finding?.detail).toContain("public.line_items");
    expect(finding?.fixKind).toBe("change");
    expect(finding?.fix).toContain(
      'CREATE INDEX "line_items_order_id_idx" ON "public"."line_items" ("order_id");'
    );
    expect(finding?.undo).toBe('DROP INDEX "public"."line_items_order_id_idx";');
  });

  it("leaves a nested loop alone when the repeated side is an index lookup", () => {
    // Ten thousand quick lookups is the join working as designed.
    const summary = readPlan(
      envelope({
        "Node Type": "Nested Loop",
        "Plan Rows": 5000,
        "Total Cost": 10,
        "Actual Total Time": 30,
        "Actual Rows": 5000,
        "Actual Loops": 1,
        Plans: [
          {
            "Node Type": "Seq Scan",
            "Parent Relationship": "Outer",
            "Relation Name": "orders",
            Schema: "public",
            Alias: "o",
            "Plan Rows": 5000,
            "Total Cost": 80,
            "Actual Total Time": 5,
            "Actual Rows": 5000,
            "Actual Loops": 1,
          },
          {
            "Node Type": "Index Scan",
            "Parent Relationship": "Inner",
            "Relation Name": "line_items",
            Schema: "public",
            Alias: "li",
            "Index Name": "line_items_order_idx",
            "Index Cond": "(li.order_id = o.id)",
            "Plan Rows": 1,
            "Total Cost": 0.3,
            "Actual Total Time": 0.004,
            "Actual Rows": 1,
            "Actual Loops": 5000,
          },
        ],
      })
    );
    expect(hasRule(summary?.findings, "nested-loop")).toBe(false);
  });

  it("does not blame a nested loop for a busy node under a different join", () => {
    // The busy Seq Scan below sits one level under the OTHER join, at the same
    // depth as this loop's own child. Matching on depth alone across the whole
    // flattened plan attributed it to the quiet loop.
    const summary = readPlan(
      envelope({
        "Node Type": "Hash Join",
        "Plan Rows": 1,
        "Total Cost": 100,
        "Actual Total Time": 900,
        "Actual Rows": 10,
        "Actual Loops": 1,
        Plans: [
          {
            "Node Type": "Nested Loop",
            "Plan Rows": 1,
            "Total Cost": 10,
            "Actual Total Time": 1,
            "Actual Rows": 2,
            "Actual Loops": 1,
            Plans: [
              {
                "Node Type": "Index Scan",
                "Relation Name": "customers",
                "Plan Rows": 1,
                "Total Cost": 1,
                "Actual Total Time": 0.1,
                "Actual Rows": 1,
                "Actual Loops": 2,
              },
            ],
          },
          {
            "Node Type": "Hash",
            "Plan Rows": 1,
            "Total Cost": 80,
            "Actual Total Time": 800,
            "Actual Rows": 1,
            "Actual Loops": 1,
            Plans: [
              {
                "Node Type": "Seq Scan",
                "Relation Name": "line_items",
                "Plan Rows": 1,
                "Total Cost": 79,
                "Actual Total Time": 700,
                "Actual Rows": 1,
                "Actual Loops": 5000,
              },
            ],
          },
        ],
      })
    );
    expect(hasRule(summary?.findings, "nested-loop")).toBe(false);
  });

  it("does not call a function scan a whole-table read", () => {
    // generate_series has no index to have missed.
    const summary = readPlan(
      envelope({
        "Node Type": "Function Scan",
        "Function Name": "generate_series",
        "Function Call": "generate_series(1, 10000)",
        "Plan Rows": 10000,
        "Total Cost": 10,
      })
    );
    expect(hasRule(summary?.findings, "seq-scan")).toBe(false);
  });

  it("flags an index-only scan that kept going back to the table, with a VACUUM that runs", () => {
    // Aliased on purpose: the label reads "… on orders o", and a fix built
    // from the label was `VACUUM (ANALYZE) orders o;`, a syntax error.
    const summary = readPlan(
      envelope({
        "Node Type": "Index Only Scan",
        "Relation Name": "orders",
        Schema: "public",
        Alias: "o",
        "Index Name": "orders_pkey",
        "Heap Fetches": 40000,
        "Plan Rows": 100,
        "Total Cost": 40,
      })
    );
    const finding = summary?.findings.find((f) => f.id === "heap-fetches:0");
    expect(finding?.fix).toBe('VACUUM (ANALYZE) "public"."orders";');
    expect(finding?.object).toBe("public.orders");
  });

  it("gives heap fetches a comment, not a guess, when the plan names no schema", () => {
    const summary = readPlan(
      envelope({
        "Node Type": "Index Only Scan",
        "Relation Name": "orders",
        "Index Name": "orders_pkey",
        "Heap Fetches": 40000,
        "Plan Rows": 100,
        "Total Cost": 40,
      })
    );
    const fix = summary?.findings.find((f) => f.id === "heap-fetches:0")?.fix ?? "";
    expect(fix.split("\n").every((line) => line.startsWith("--"))).toBe(true);
  });

  it("puts the most serious finding first", () => {
    const summary = readPlan(
      envelope({
        "Node Type": "Seq Scan",
        "Relation Name": "events",
        Schema: "public",
        Filter: "(kind = 'error'::text)",
        "Sort Method": "external merge  Disk: 1kB",
        "Plan Rows": 90000,
        "Total Cost": 900,
      }),
      { tableRows: { "public.events": 5000000 } }
    );
    // The sort that spilled is found first in the plan's own order; the
    // whole-table read is the more serious, so it is listed first.
    expect(ids(summary?.findings ?? [])).toEqual(["seq-scan:0", "sort-on-disk:0"]);
    expect(summary?.findings[0].severity).toBe("high");
  });
});

describe("filterColumns", () => {
  // The columns a plain index on the filtered table would be built on: every
  // column compared for equality, in the order written, then at most one
  // compared as a range. Null when no such index could serve the filter.
  type Case = {
    label: string;
    filter: string;
    alias?: string | null;
    types?: Record<string, string>;
    expected: { equality: string[]; range: string | null } | null;
  };

  const served: Case[] = [
    {
      label: "one equality",
      filter: "(o.customer_id = 42)",
      expected: { equality: ["customer_id"], range: null },
    },
    {
      label: "a varchar column the plan casts to text",
      filter: "((o.status)::text = 'paid'::text)",
      types: { status: "character varying(20)" },
      expected: { equality: ["status"], range: null },
    },
    {
      label: "= ANY over a list",
      filter: "(o.id = ANY ('{1,2}'::integer[]))",
      expected: { equality: ["id"], range: null },
    },
    {
      label: "IS NULL",
      filter: "(o.shipped_at IS NULL)",
      expected: { equality: ["shipped_at"], range: null },
    },
    {
      label: "an equality and a range",
      filter: "((o.status = 'x'::text) AND (o.created_at > '2024-01-01'::date))",
      expected: { equality: ["status"], range: "created_at" },
    },
    {
      label: "a bind parameter",
      filter: "(o.customer_id = $1)",
      expected: { equality: ["customer_id"], range: null },
    },
    {
      label: "a quoted column name",
      filter: `(o."Note" = 'x'::text)`,
      expected: { equality: ["Note"], range: null },
    },
    {
      label: "the table's own name when the query gave it no alias",
      filter: "(orders.status = 'x'::text)",
      alias: null,
      expected: { equality: ["status"], range: null },
    },
    {
      label: "the column on the right-hand side",
      filter: "(42 = o.customer_id)",
      expected: { equality: ["customer_id"], range: null },
    },
    {
      label: "the equality beside a LIKE",
      filter: "((o.email ~~ 'a%'::text) AND (o.status = 'x'::text))",
      expected: { equality: ["status"], range: null },
    },
    {
      label: "equality columns in the order they are written",
      filter: "((o.b = 1) AND (o.a = 2))",
      expected: { equality: ["b", "a"], range: null },
    },
    {
      label: "only the first of two ranges",
      filter: "((o.a > 1) AND (o.b < 2))",
      expected: { equality: [], range: "a" },
    },
    {
      label: "a comparison with a value worked out once, before the scan",
      filter: "(o.total > (InitPlan 1).col1)",
      expected: { equality: [], range: "total" },
    },
  ];

  const refused: Case[] = [
    {
      label: "a cast whose column type is not known",
      filter: "((o.status)::text = 'paid'::text)",
      expected: null,
    },
    { label: "an OR", filter: "((o.a = 1) OR (o.b = 2))", expected: null },
    { label: "a pattern that starts with %", filter: "(o.email ~~ '%x'::text)", expected: null },
    {
      label: "a function around the column",
      filter: "(lower((o.email)::text) = 'x'::text)",
      expected: null,
    },
    { label: "two columns compared with each other", filter: "(o.a = o.b)", expected: null },
    { label: "a column of another table", filter: "(c.id = 5)", expected: null },
    {
      label: "a comparison with a subquery run for every row",
      filter: "(o.total > (SubPlan 1))",
      expected: null,
    },
    {
      label: "a column the catalog does not list",
      filter: "(o.ctid = '(0,1)'::tid)",
      types: { id: "integer" },
      expected: null,
    },
  ];

  it.each(served)("reads $label", ({ filter, alias = "o", types = {}, expected }) => {
    expect(filterColumns(filter, alias, "orders", types)).toEqual(expected);
  });

  it.each(refused)("refuses $label", ({ filter, alias = "o", types = {}, expected }) => {
    expect(filterColumns(filter, alias, "orders", types)).toEqual(expected);
  });
});

describe("readPlan — whole-table reads, judged against the table", () => {
  /** A read of all of public.orders that keeps the paid ones. */
  function paidOrders(extra: Record<string, unknown> = {}) {
    return envelope({
      "Node Type": "Seq Scan",
      "Relation Name": "orders",
      Schema: "public",
      Alias: "orders",
      Filter: "(status = 'paid'::text)",
      "Plan Rows": 50000,
      "Total Cost": 900,
      ...extra,
    });
  }

  const millionRows = { "public.orders": 1000000 };

  /** A million-row orders with an index on status, finished building or not. */
  function withStatusIndex(valid: boolean): Partial<PlanCatalog> {
    return {
      tableRows: millionRows,
      indexes: {
        "public.orders": [
          { name: "orders_status_idx", primary: false, unique: false, valid, columns: ["status"] },
        ],
      },
    };
  }

  it("stays quiet when the filter keeps half the table", () => {
    // Reading all of it is the fastest way to hand back half of it.
    const summary = readPlan(paidOrders({ "Plan Rows": 500000 }), { tableRows: millionRows });
    expect(summary?.findings).toEqual([]);
  });

  it("says the index is already there, and hands over ANALYZE instead of a second one", () => {
    const summary = readPlan(paidOrders(), withStatusIndex(true));
    const finding = summary?.findings.find((f) => f.id === "seq-scan:0");
    expect(finding?.fixKind).toBe("maintenance");
    expect(finding?.title).toBe("Whole table read, though an index on status exists");
    expect(finding?.fix).toContain("-- The index orders_status_idx already starts with status");
    expect(finding?.fix).toContain('ANALYZE "public"."orders";');
    expect(finding?.fix).not.toMatch(/^CREATE INDEX/m);
    expect(finding?.undo).toBeUndefined();
  });

  it("does not count an index that never finished building, and picks a free name", () => {
    // A failed CREATE INDEX CONCURRENTLY leaves an invalid index behind: the
    // planner never uses it, but its name is still taken.
    const catalog: Partial<PlanCatalog> = {
      ...withStatusIndex(false),
      relationNames: { public: ["orders", "orders_status_idx"] },
    };
    const finding = readPlan(paidOrders(), catalog)?.findings.find((f) => f.id === "seq-scan:0");
    expect(finding?.fixKind).toBe("change");
    expect(finding?.fix).toContain(
      'CREATE INDEX "orders_status_idx1" ON "public"."orders" ("status");'
    );
    expect(finding?.undo).toBe('DROP INDEX "public"."orders_status_idx1";');
  });

  it("trusts a run that kept most of what it read over the table's size", () => {
    // It read 60,000 rows and kept 50,000 of them, whatever the catalog says.
    const summary = readPlan(
      paidOrders({
        "Actual Rows": 50000,
        "Rows Removed by Filter": 10000,
        "Actual Loops": 1,
        "Actual Total Time": 40,
      }),
      { tableRows: millionRows }
    );
    expect(summary?.findings).toEqual([]);
  });
});

/**
 * All of public.orders (a million rows) hash-joined to the customers the
 * other side keeps. By default those are the ten New Zealand customers, and
 * the fifty orders of theirs come back.
 */
function ordersToCustomers(
  joinRows = 50,
  customerRows = 10,
  customerFilter: string | null = "(c.country = 'NZ'::text)"
): Record<string, unknown> {
  const customers: Record<string, unknown> = {
    "Node Type": "Seq Scan",
    "Parent Relationship": "Outer",
    "Relation Name": "customers",
    Schema: "public",
    Alias: "c",
    "Plan Rows": customerRows,
    "Total Cost": 30,
  };
  if (customerFilter !== null) customers.Filter = customerFilter;
  return {
    "Node Type": "Hash Join",
    "Hash Cond": "(o.customer_id = c.id)",
    Output: ["o.id", "o.status"],
    "Plan Rows": joinRows,
    "Total Cost": 20000,
    Plans: [
      {
        "Node Type": "Seq Scan",
        "Parent Relationship": "Outer",
        "Relation Name": "orders",
        Schema: "public",
        Alias: "o",
        "Plan Rows": 1000000,
        "Total Cost": 15000,
      },
      {
        "Node Type": "Hash",
        "Parent Relationship": "Inner",
        "Plan Rows": customerRows,
        "Total Cost": 30,
        Plans: [customers],
      },
    ],
  };
}

describe("readPlan — a join that reads a whole table for a few rows", () => {
  it("hands over an index on the big table's join column", () => {
    const summary = readPlan(envelope(ordersToCustomers()));
    expect(ids(summary?.findings ?? [])).toEqual(["join-key:0"]);
    const finding = summary?.findings[0];
    expect(finding?.severity).toBe("medium");
    expect(finding?.fixKind).toBe("change");
    expect(finding?.title).toBe("Index the column customer_id for this join");
    expect(finding?.object).toBe("public.orders");
    expect(finding?.detail).toContain("matches 10 rows from one side against public.orders");
    expect(finding?.detail).toContain("all 1,000,000 rows");
    expect(finding?.fix).toContain(
      'CREATE INDEX "orders_customer_id_idx" ON "public"."orders" ("customer_id");'
    );
    expect(finding?.undo).toBe('DROP INDEX "public"."orders_customer_id_idx";');
  });

  it("stays quiet when both sides are big", () => {
    // Two big tables matched against each other: a hash join over both is
    // the right way to do it, and no index would beat it.
    expect(readPlan(envelope(ordersToCustomers(1000000, 200000, null)))?.findings).toEqual([]);
  });

  it("stays quiet when the join hands back a big share of the table", () => {
    const summary = readPlan(envelope(ordersToCustomers(200000)));
    expect(hasRule(summary?.findings, "join-key")).toBe(false);
  });

  it("says the index is already there, and hands over ANALYZE instead of a second one", () => {
    const catalog: Partial<PlanCatalog> = {
      indexes: {
        "public.orders": [
          {
            name: "orders_customer_id_idx",
            primary: false,
            unique: false,
            valid: true,
            columns: ["customer_id"],
          },
        ],
      },
    };
    const summary = readPlan(envelope(ordersToCustomers()), catalog);
    const finding = summary?.findings.find((f) => f.id === "join-key:0");
    expect(finding?.fixKind).toBe("maintenance");
    expect(finding?.title).toBe("A whole table is read to join a few rows");
    expect(finding?.detail).toContain("already exists, and the planner passed it over");
    expect(finding?.fix).toContain('ANALYZE "public"."orders";');
    expect(finding?.fix).not.toMatch(/^CREATE INDEX/m);
  });
});

describe("sqlContextFromPlan", () => {
  it("gathers the tables, sizes, keys and settings the text rules use", () => {
    const catalog: Partial<PlanCatalog> = {
      tableRows: { "public.orders": 800000, "public.customers": 50000 },
      columns: {
        "public.orders": [
          { name: "id", type: "integer", notNull: true },
          { name: "status", type: "text", notNull: false },
        ],
      },
      indexes: {
        "public.orders": [
          { name: "orders_pkey", primary: true, unique: true, valid: true, columns: ["id"] },
        ],
        "public.customers": [
          { name: "customers_pkey", primary: true, unique: true, valid: true, columns: ["id"] },
        ],
      },
      settings: { joinCollapseLimit: 8, geqoThreshold: 12, geqo: true },
    };
    expect(contextOf(ordersToCustomers(), catalog)).toEqual({
      expectedRows: 50,
      measured: false,
      tables: [
        {
          schema: "public",
          name: "orders",
          alias: "o",
          // A whole-table read planned for a million rows is fresher than
          // the catalog's 800,000.
          rows: 1000000,
          filter: null,
          readsAll: true,
          // Its rows go into a join, not a count.
          feedsPlainAggregate: false,
          selectiveScan: false,
          indexCond: null,
          columnTypes: { id: "integer", status: "text" },
        },
        {
          schema: "public",
          name: "customers",
          alias: "c",
          rows: 50000,
          filter: "(c.country = 'NZ'::text)",
          readsAll: false,
          feedsPlainAggregate: false,
          // 50,000 rows read to keep ten.
          selectiveScan: true,
          indexCond: null,
          columnTypes: {},
        },
      ],
      joinedTables: 2,
      outputColumns: ["o.id", "o.status"],
      primaryKeys: { "public.orders": ["id"], "public.customers": ["id"] },
      settings: { joinCollapseLimit: 8, geqoThreshold: 12, geqo: true },
      topNodeType: "Hash Join",
      distinctRows: null,
      repeatsRows: true,
      relationNames: {},
    });
  });

  it("keeps the catalog's count when a whole-table read was planned for fewer rows", () => {
    const context = contextOf(
      {
        "Node Type": "Seq Scan",
        "Relation Name": "orders",
        Schema: "public",
        Alias: "orders",
        "Plan Rows": 100,
        "Total Cost": 5,
      },
      { tableRows: { "public.orders": 5000 } }
    );
    expect(context.tables[0].rows).toBe(5000);
  });

  it("counts an index condition as narrowing the read, and none as reading it all", () => {
    const narrowed = contextOf({
      "Node Type": "Index Scan",
      "Index Name": "orders_pkey",
      "Relation Name": "orders",
      Schema: "public",
      Alias: "orders",
      "Index Cond": "(id = 5)",
      "Plan Rows": 1,
      "Total Cost": 8,
    });
    expect(narrowed.tables[0].readsAll).toBe(false);
    // An index scan with no condition, run for its order, reads every row.
    const whole = contextOf({
      "Node Type": "Index Only Scan",
      "Index Name": "orders_pkey",
      "Relation Name": "orders",
      Schema: "public",
      Alias: "orders",
      "Plan Rows": 1000,
      "Total Cost": 50,
    });
    expect(whole.tables[0].readsAll).toBe(true);
  });

  it("uses the rows the query really returned when it ran", () => {
    const context = contextOf({
      "Node Type": "Seq Scan",
      "Relation Name": "orders",
      Schema: "public",
      Alias: "orders",
      Filter: "(status = 'paid'::text)",
      "Plan Rows": 900,
      "Total Cost": 20,
      "Actual Rows": 40,
      "Rows Removed by Filter": 960,
      "Actual Loops": 1,
      "Actual Total Time": 3,
    });
    expect(context.expectedRows).toBe(40);
    expect(context.measured).toBe(true);
  });

  /** A read of 5,000 orders that ran. */
  function ranScan(): Record<string, unknown> {
    return {
      "Node Type": "Seq Scan",
      "Relation Name": "orders",
      Schema: "public",
      Alias: "orders",
      "Plan Rows": 5000,
      "Total Cost": 100,
      "Actual Rows": 5000,
      "Actual Loops": 1,
      "Actual Total Time": 1,
    };
  }

  /** One step that ran and handed on `rows`, fed by `input`. */
  function ran(
    nodeType: string,
    rows: number,
    input: Record<string, unknown>,
    extra: Record<string, unknown> = {}
  ): Record<string, unknown> {
    return {
      "Node Type": nodeType,
      "Plan Rows": rows,
      "Total Cost": 200,
      "Actual Rows": rows,
      "Actual Loops": 1,
      "Actual Total Time": 5,
      Plans: [{ ...input, "Parent Relationship": "Outer" }],
      ...extra,
    };
  }

  it("counts the rows into and out of a DISTINCT that ran", () => {
    const context = contextOf(ran("Unique", 5000, ran("Sort", 5000, ranScan())));
    expect(context.topNodeType).toBe("Unique");
    expect(context.distinctRows).toEqual({ input: 5000, output: 5000 });
  });

  it("counts a grouping aggregate as a DISTINCT too", () => {
    const grouped = ran("Aggregate", 300, ranScan(), {
      Strategy: "Hashed",
      "Group Key": ["orders.customer_id"],
    });
    expect(contextOf(grouped).distinctRows).toEqual({ input: 5000, output: 300 });
  });

  it("gives no counts when a LIMIT above the DISTINCT stopped it early", () => {
    const context = contextOf(ran("Limit", 20, ran("Unique", 20, ran("Sort", 5000, ranScan()))));
    expect(context.topNodeType).toBe("Unique");
    expect(context.distinctRows).toBeNull();
  });

  it("gives no counts across a Gather, whose workers may have dropped copies already", () => {
    const context = contextOf(
      ran("Unique", 4000, ran("Gather Merge", 4000, ran("Sort", 5000, ranScan())))
    );
    expect(context.distinctRows).toBeNull();
  });

  it("gives no counts for an aggregate that does not group", () => {
    const context = contextOf(ran("Aggregate", 1, ranScan(), { Strategy: "Plain" }));
    expect(context.topNodeType).toBe("Aggregate");
    expect(context.distinctRows).toBeNull();
  });

  it("knows a set-returning function can hand on one row many times", () => {
    expect(contextOf(ran("ProjectSet", 15000, ranScan())).repeatsRows).toBe(true);
    expect(contextOf(ranScan()).repeatsRows).toBe(false);
  });

  it("does not count the partitions of one table as a join", () => {
    const partition = (name: string) => ({
      "Node Type": "Seq Scan",
      "Parent Relationship": "Member",
      "Relation Name": name,
      Schema: "public",
      Alias: name,
      "Plan Rows": 1000,
      "Total Cost": 20,
    });
    const context = contextOf({
      "Node Type": "Append",
      "Plan Rows": 2000,
      "Total Cost": 40,
      Plans: [partition("events_2024"), partition("events_2025")],
    });
    expect(context.tables.map((t) => t.name)).toEqual(["events_2024", "events_2025"]);
    expect(context.joinedTables).toBe(0);
  });
});

describe("describePlan", () => {
  it("says the numbers are estimates when the query was not run", () => {
    const summary = readPlan(
      envelope({ "Node Type": "Seq Scan", "Relation Name": "t", "Plan Rows": 12, "Total Cost": 9 })
    );
    const line = describePlan(summary!);
    expect(line).toContain("estimates");
    expect(line).toContain("12");
  });

  it("reports the measured duration when the query was run", () => {
    const summary = readPlan(
      envelope(
        {
          "Node Type": "Seq Scan",
          "Relation Name": "t",
          "Plan Rows": 1,
          "Total Cost": 9,
          "Actual Total Time": 3,
          "Actual Rows": 42,
          "Actual Loops": 1,
        },
        { "Execution Time": 3.14 }
      )
    );
    const line = describePlan(summary!);
    expect(line).toContain("3.14 ms");
    expect(line).toContain("42 rows");
  });

  it("still says the query ran when the plan carries no total time", () => {
    // EXPLAIN (ANALYZE, SUMMARY OFF) reports the per-step actuals without an
    // "Execution Time", and so do some older servers. Telling the reader their
    // query was not run is the one thing this sentence must never get wrong.
    const summary = readPlan(
      envelope({
        "Node Type": "Seq Scan",
        "Relation Name": "t",
        "Plan Rows": 1,
        "Total Cost": 9,
        "Actual Total Time": 3,
        "Actual Rows": 42,
        "Actual Loops": 1,
      })
    );
    const line = describePlan(summary!);
    expect(line).toContain("Ran and returned");
    expect(line).toContain("42 rows");
    expect(line).not.toContain("estimates");
  });
});

// ── The query text ───────────────────────────────────────────────────────────

describe("readSql", () => {
  it("flags SELECT *", () => {
    expect(ids(readSql("SELECT * FROM orders"))).toContain("select-star");
  });

  it("does not flag a named select list", () => {
    expect(ids(readSql("SELECT id, name FROM orders"))).not.toContain("select-star");
  });

  it("ignores a rule-breaking pattern that only appears in a comment", () => {
    const sql = "-- SELECT * FROM orders\nSELECT id FROM orders";
    expect(ids(readSql(sql))).not.toContain("select-star");
  });

  it("ignores a rule-breaking pattern inside a string literal", () => {
    const sql = "SELECT id FROM logs WHERE message = 'SELECT * FROM orders'";
    expect(ids(readSql(sql))).not.toContain("select-star");
  });

  it("flags a LIKE pattern that starts with a wildcard", () => {
    expect(ids(readSql("SELECT id FROM people WHERE name LIKE '%smith%'"))).toContain(
      "leading-wildcard"
    );
  });

  it("leaves a prefix LIKE alone, because an index can serve it", () => {
    expect(ids(readSql("SELECT id FROM people WHERE name LIKE 'smith%'"))).not.toContain(
      "leading-wildcard"
    );
  });

  it("does not read a percent sign in an unrelated string as a wildcard", () => {
    const sql = "SELECT id FROM reports WHERE title = '%complete' AND kind LIKE 'sales%'";
    expect(ids(readSql(sql))).not.toContain("leading-wildcard");
  });

  it("flags a function wrapped around the column being filtered", () => {
    expect(ids(readSql("SELECT id FROM users WHERE LOWER(email) = 'a@b.com'"))).toContain(
      "function-on-column"
    );
  });

  it("leaves a function on the other side of the comparison alone", () => {
    // LOWER($1) is computed once; the index on email is still usable.
    expect(ids(readSql("SELECT id FROM users WHERE email = LOWER($1)"))).not.toContain(
      "function-on-column"
    );
  });

  it("does not read a function in a later clause as one in the WHERE", () => {
    // HAVING runs after aggregation, so no index could have helped it either
    // way. The old rule matched anything between WHERE and the end of the
    // statement, which meant a following clause fired a finding about a WHERE
    // that wraps nothing.
    const sql =
      "SELECT email FROM users WHERE tenant = $1 GROUP BY email HAVING LOWER(email) = 'a@b.com'";
    expect(ids(readSql(sql))).not.toContain("function-on-column");
  });

  it("still reads the second of two WHERE clauses", () => {
    const sql =
      "SELECT id FROM a WHERE tenant = $1 UNION SELECT id FROM b WHERE LOWER(email) = 'a@b.com'";
    expect(ids(readSql(sql))).toContain("function-on-column");
  });

  it("flags NOT IN over a subquery", () => {
    const sql = "SELECT id FROM a WHERE id NOT IN (SELECT a_id FROM b)";
    expect(ids(readSql(sql))).toContain("not-in-subquery");
  });

  it("leaves NOT IN over a literal list alone", () => {
    expect(ids(readSql("SELECT id FROM a WHERE state NOT IN ('x', 'y')"))).not.toContain(
      "not-in-subquery"
    );
  });

  it("flags a comma join", () => {
    expect(ids(readSql("SELECT a.id FROM a, b WHERE b.a_id = a.id"))).toContain("comma-join");
  });

  it("does not read an explicit JOIN as a comma join", () => {
    expect(ids(readSql("SELECT a.id FROM a JOIN b ON b.a_id = a.id"))).not.toContain("comma-join");
  });

  it("flags an ORDER BY with no LIMIT", () => {
    expect(ids(readSql("SELECT id FROM orders ORDER BY created_at DESC"))).toContain(
      "order-by-no-limit"
    );
  });

  it("leaves a limited ORDER BY alone", () => {
    expect(ids(readSql("SELECT id FROM orders ORDER BY created_at DESC LIMIT 20"))).not.toContain(
      "order-by-no-limit"
    );
  });

  it("does not read a window function's own ordering as the result's", () => {
    // OVER (ORDER BY …) says how the window is numbered, not how many rows come
    // back, so a LIMIT would not change what this sorts.
    const sql = "SELECT id, row_number() OVER (ORDER BY created_at) FROM orders";
    expect(ids(readSql(sql))).not.toContain("order-by-no-limit");
  });

  it("flags a deep OFFSET", () => {
    const sql = "SELECT id FROM orders ORDER BY id LIMIT 20 OFFSET 40000";
    expect(ids(readSql(sql))).toContain("deep-offset");
  });

  it("leaves a shallow OFFSET alone, because page two is not the problem", () => {
    const sql = "SELECT id FROM orders ORDER BY id LIMIT 20 OFFSET 20";
    expect(ids(readSql(sql))).not.toContain("deep-offset");
  });

  it("does not flag SELECT DISTINCT on sight", () => {
    // DISTINCT is often exactly what the query means. Without a plan to say
    // it removed nothing, or a key to say it cannot, there is nothing true
    // to report.
    expect(readSql("SELECT DISTINCT customer_id FROM orders")).toEqual([]);
  });

  it("leaves COUNT(*) alone without a plan to say the table is big", () => {
    // Counting a hundred rows is instant; only the table's size makes an
    // unfiltered count worth a finding, and only the plan knows it.
    expect(readSql("SELECT COUNT(*) FROM orders")).toEqual([]);
  });

  it("leaves a filtered COUNT(*) alone", () => {
    expect(ids(readSql("SELECT COUNT(*) FROM orders WHERE state = 'paid'"))).not.toContain(
      "unfiltered-count"
    );
  });

  it("finds nothing to say about a well-shaped query", () => {
    const sql =
      "SELECT o.id, o.total FROM orders o JOIN customers c ON c.id = o.customer_id " +
      "WHERE o.state = 'paid' ORDER BY o.created_at DESC LIMIT 20";
    expect(readSql(sql)).toEqual([]);
  });
});

/** The finding one rule produced, or undefined when it said nothing. */
function findingOf<T extends { id: string }>(findings: T[], id: string): T | undefined {
  return findings.find((f) => f.id === id);
}

describe("readSql — SELECT *", () => {
  it.each([
    ["an alias's star", "SELECT o.* FROM orders o WHERE o.id = 1"],
    ["a quoted alias's star", `SELECT "o".* FROM orders "o" WHERE "o".id = 1`],
    ["SELECT DISTINCT *", "SELECT DISTINCT * FROM orders WHERE status = 'paid'"],
    // A bracketed branch of a UNION is still the main select list: its star
    // is what comes back.
    ["a star in a bracketed UNION branch", "(SELECT * FROM a) UNION (SELECT * FROM b)"],
    ["a star in the second bracketed branch only", "(SELECT id FROM a) UNION ALL (SELECT * FROM b)"],
    [
      "a star in a branch with its own ORDER BY and LIMIT",
      "(SELECT o.* FROM orders o ORDER BY o.id LIMIT 5) INTERSECT (SELECT o.* FROM orders o)",
    ],
    ["a star in brackets inside brackets", "((SELECT * FROM a) EXCEPT (SELECT * FROM b)) ORDER BY 1"],
    ["a whole statement in brackets", "(SELECT * FROM orders WHERE id = 1)"],
    ["a bracketed statement after a WITH list", "WITH x AS (SELECT 1 AS id) (SELECT * FROM x)"],
  ])("flags %s", (_label, text) => {
    expect(ids(readSql(text))).toContain("select-star");
  });

  it("gives a UNION with a star on both sides one finding, not two", () => {
    const found = readSql("(SELECT * FROM a) UNION (SELECT * FROM b)");
    expect(found.filter((f) => f.id === "select-star")).toHaveLength(1);
  });

  it.each([
    [
      "a star inside EXISTS, which never fetches a column",
      "SELECT id FROM customers c WHERE EXISTS (SELECT * FROM orders o WHERE o.customer_id = c.id)",
    ],
    ["COUNT(*)", "SELECT COUNT(*) FROM orders WHERE status = 'paid'"],
    [
      "a star inside a derived table whose outer list names the columns",
      "SELECT s.id FROM (SELECT * FROM customers) AS s WHERE s.id = 1",
    ],
    ["a whole row handed to a function", "SELECT to_jsonb(o.*) FROM orders o WHERE o.id = 1"],
    // Brackets that look like a UNION branch but are subqueries.
    [
      "a UNION of stars inside a derived table",
      "SELECT s.id FROM ((SELECT * FROM a) UNION (SELECT * FROM b)) AS s",
    ],
    [
      "a bracketed UNION branch inside an IN list",
      "SELECT id FROM a WHERE id IN (SELECT id FROM b UNION (SELECT * FROM c))",
    ],
    ["a star inside a WITH query", "WITH x AS (SELECT * FROM a) (SELECT id FROM x)"],
    [
      "a star in a bracketed subquery after a comparison",
      "SELECT id FROM a WHERE (SELECT * FROM one_column LIMIT 1) = a.id",
    ],
    [
      "a star written in a comment beside a UNION",
      // WHEREs so the missing-where fix, which echoes the query, does not
      // carry the comment into SQL meant to be run.
      "(SELECT id FROM a WHERE id > 0) UNION /* (SELECT * FROM b) */ (SELECT id FROM b WHERE id > 0)",
    ],
  ])("leaves %s alone", (_label, text) => {
    expect(ids(readSql(text))).not.toContain("select-star");
  });

  it("offers the columns the plan says come back, instead of making some up", () => {
    const context = sqlContext({ outputColumns: ["id", "email"] });
    const finding = findingOf(readSql("SELECT * FROM customers", context), "select-star");
    expect(finding?.fixKind).toBe("query");
    expect(finding?.fix).toContain("-- Today the query returns these:\n--   id, email");
  });

  it("lists a join's columns the way the query can write them", () => {
    const context = sqlContext({
      outputColumns: ["o.id", 'l."Note"'],
      tables: [contextTable({ name: "orders", alias: "o" }), contextTable({ name: "Order Lines", alias: "l" })],
    });
    const sql = 'SELECT * FROM orders o JOIN "Order Lines" l ON l."OrderId" = o.id';
    const finding = findingOf(readSql(sql, context), "select-star");
    expect(finding?.fix).toContain('-- Today the query returns these:\n--   o.id, l."Note"');
  });

  // The plan shows what each column is worked out from, not the name the
  // view or subquery gives it, so a list from it would not run in place of *.
  it.each<[string, string, string[], SqlContextTable[]]>([
    ["a view that works a column out", "SELECT * FROM quiet_kill", ["pg_cancel_backend(0)"], []],
    [
      "a view that renames a column",
      "SELECT * FROM order_list",
      ["orders.id", "orders.total"],
      [contextTable({ name: "orders", alias: "orders" })],
    ],
    [
      "a subquery that renames a column",
      "SELECT * FROM (SELECT id AS order_id FROM orders) s",
      ["orders.id"],
      [contextTable({ name: "orders", alias: "orders" })],
    ],
  ])("asks for the columns in words through %s", (_label, text, outputColumns, tables) => {
    const finding = findingOf(readSql(text, sqlContext({ outputColumns, tables })), "select-star");
    expect(finding?.fix).toBe(
      "-- Put the columns the code reading this result uses in place of the *,\n" +
        "-- so the query asks only for those."
    );
  });

  it("asks for the columns in words when there is no plan to list them", () => {
    const finding = findingOf(readSql("SELECT * FROM customers"), "select-star");
    expect(finding?.fix).toBe(
      "-- Put the columns the code reading this result uses in place of the *,\n" +
        "-- so the query asks only for those."
    );
  });
});

describe("readSql — a SELECT with no WHERE", () => {
  const sql = "SELECT id, total FROM orders";

  it("stays quiet when the plan expects a small result", () => {
    expect(ids(readSql(sql, sqlContext({ expectedRows: 500 })))).not.toContain("missing-where");
  });

  it("flags a few thousand rows as low, and hands back the statement with a LIMIT", () => {
    const finding = findingOf(readSql(sql, sqlContext({ expectedRows: 5000 })), "missing-where");
    expect(finding?.severity).toBe("low");
    expect(finding?.fixKind).toBe("query");
    expect(finding?.title).toBe("No WHERE clause: all 5,000 rows come back");
    expect(finding?.detail).toContain("The planner expects about 5,000.");
    expect(finding?.fix).toContain("SELECT id, total FROM orders\nLIMIT 100;");
  });

  it("flags a big result as medium, with the count in words", () => {
    const finding = findingOf(readSql(sql, sqlContext({ expectedRows: 1200000 })), "missing-where");
    expect(finding?.severity).toBe("medium");
    expect(finding?.title).toBe("No WHERE clause: all 1.2 million rows come back");
  });

  it("flags it as low without a plan, and does not guess a count", () => {
    const finding = findingOf(readSql(sql), "missing-where");
    expect(finding?.severity).toBe("low");
    expect(finding?.title).toBe("No WHERE clause: every row comes back");
  });

  it("puts the LIMIT in front of a trailing semicolon", () => {
    const finding = findingOf(readSql(`${sql};`, sqlContext({ expectedRows: 5000 })), "missing-where");
    expect(finding?.fix).toContain("SELECT id, total FROM orders\nLIMIT 100;");
    expect(finding?.fix).not.toContain(";\nLIMIT");
  });

  it("says how many rows came back when the query ran", () => {
    const context = sqlContext({ expectedRows: 5000, measured: true });
    const finding = findingOf(readSql(sql, context), "missing-where");
    expect(finding?.detail).toContain("It returned 5,000 rows when it ran.");
  });

  it.each([
    ["a GROUP BY", "SELECT status, count(*) FROM orders GROUP BY status"],
    ["a LIMIT", "SELECT id FROM orders LIMIT 10"],
    ["an aggregate over the whole table", "SELECT max(total) FROM orders"],
    [
      "a WHERE inside a derived table",
      "SELECT * FROM (SELECT id FROM orders WHERE status = 'paid') AS paid",
    ],
    ["no table at all", "SELECT 1"],
  ])("leaves a query with %s alone", (_label, text) => {
    expect(ids(readSql(text))).not.toContain("missing-where");
  });

  it("still flags a window count, which returns every row", () => {
    // count(*) OVER () looks like an aggregate in the text, but the plan's
    // top step says the rows are not added up.
    const context = sqlContext({ expectedRows: 5000, topNodeType: "WindowAgg" });
    expect(ids(readSql("SELECT id, count(*) OVER () FROM orders", context))).toContain(
      "missing-where"
    );
  });

  it("reads TABLE orders as the SELECT * it stands for", () => {
    const finding = findingOf(readSql("TABLE orders", sqlContext({ expectedRows: 5000 })), "missing-where");
    expect(finding?.fix).toContain("TABLE orders\nLIMIT 100;");
  });

  it("gives SELECT * over a big table both findings, with the columns it really returns", () => {
    // The route merges the plan's findings with the text's, as here.
    const plan = {
      "Node Type": "Seq Scan",
      "Relation Name": "orders",
      Schema: "public",
      Alias: "orders",
      Output: ["orders.id", "orders.status"],
      "Plan Rows": 1200000,
      "Total Cost": 18000,
    };
    const text = "SELECT * FROM orders";
    const merged = sortFindings([
      ...(readPlan(envelope(plan))?.findings ?? []),
      ...readSql(text, contextOf(plan)),
    ]);
    expect(ids(merged)).toEqual(["missing-where", "select-star"]);
    expect(merged[0].title).toBe("No WHERE clause: all 1.2 million rows come back");
    expect(merged[1].fix).toContain("--   orders.id, orders.status");
  });
});

describe("readSql — many tables joined", () => {
  /** t0 JOIN t1 … JOIN t(n-1), each on the one before, with a WHERE. */
  function joined(tables: number): string {
    let text = "SELECT t0.id FROM t0";
    for (let i = 1; i < tables; i += 1) text += ` JOIN t${i} ON t${i}.id = t${i - 1}.id`;
    return `${text} WHERE t0.id = 1`;
  }

  it("mentions six tables as low, with no setting to change", () => {
    const finding = findingOf(readSql(joined(6)), "many-joins");
    expect(finding?.severity).toBe("low");
    expect(finding?.title).toBe("6 tables joined in one query");
    expect(finding?.fix).not.toMatch(/\bSET\b/);
  });

  it("says the written order decides once join_collapse_limit is passed", () => {
    const context = sqlContext({
      settings: { joinCollapseLimit: 8, geqoThreshold: 12, geqo: true },
    });
    const finding = findingOf(readSql(joined(9), context), "many-joins");
    expect(finding?.severity).toBe("medium");
    expect(finding?.title).toBe("9 tables joined: the written JOIN order now matters");
    expect(finding?.detail).toContain("join_collapse_limit (8 on this server)");
    expect(finding?.fix).toContain("-- SET join_collapse_limit = 9;");
    expect(finding?.fix).not.toContain("geqo_threshold =");
  });

  it("says a long comma list is ordered by a randomised search", () => {
    // join_collapse_limit never applies to a comma list, so only
    // geqo_threshold is named, at PostgreSQL's default when none was read.
    const from = Array.from({ length: 12 }, (_, i) => `t${i}`).join(", ");
    const finding = findingOf(readSql(`SELECT t0.id FROM ${from} WHERE t0.id = 1`), "many-joins");
    expect(finding?.title).toBe(
      "12 tables joined: the join order is picked by a randomised search"
    );
    expect(finding?.detail).toContain("geqo_threshold (12, PostgreSQL's default)");
    expect(finding?.fix).toContain("-- SET geqo_threshold = 13;");
    expect(finding?.fix).not.toContain("join_collapse_limit =");
  });

  it("names both settings when lifting one would run into the other", () => {
    // Twelve JOINs in one list reach geqo_threshold, so lifting
    // join_collapse_limit alone would trade a fixed order for a random one.
    const finding = findingOf(readSql(joined(12)), "many-joins");
    expect(finding?.title).toBe("12 tables joined: the written JOIN order now matters");
    expect(finding?.fix).toContain("-- SET join_collapse_limit = 12;");
    expect(finding?.fix).toContain("-- SET geqo_threshold = 13;");
  });

  it("stays low on a server whose limits are above the table count", () => {
    const context = sqlContext({
      settings: { joinCollapseLimit: 20, geqoThreshold: 25, geqo: false },
    });
    const finding = findingOf(readSql(joined(9), context), "many-joins");
    expect(finding?.severity).toBe("low");
    expect(finding?.fix).not.toMatch(/\bSET\b/);
  });

  it("counts the tables a view joins, which only the plan can see", () => {
    const context = sqlContext({ joinedTables: 7 });
    const finding = findingOf(readSql("SELECT * FROM order_report WHERE id = 1", context), "many-joins");
    expect(finding?.title).toBe("7 tables joined in one query");
  });
});

describe("readSql — DISTINCT, judged rather than flagged on sight", () => {
  it("leaves DISTINCT ON alone, which keeps one row per group", () => {
    const text =
      "SELECT DISTINCT ON (customer_id) customer_id, total FROM orders " +
      "ORDER BY customer_id, total DESC";
    expect(ids(readSql(text))).not.toContain("unnecessary-distinct");
  });

  it("says DISTINCT does nothing when the result includes the primary key", () => {
    // How PostgreSQL really plans SELECT DISTINCT id, email FROM customers.
    const plan = {
      "Node Type": "Aggregate",
      Strategy: "Hashed",
      "Group Key": ["customers.id", "customers.email"],
      Output: ["customers.id", "customers.email"],
      "Plan Rows": 5000,
      "Total Cost": 200,
      Plans: [
        {
          "Node Type": "Seq Scan",
          "Parent Relationship": "Outer",
          "Relation Name": "customers",
          Schema: "public",
          Alias: "customers",
          Output: ["customers.id", "customers.email"],
          "Plan Rows": 5000,
          "Total Cost": 100,
        },
      ],
    };
    const catalog: Partial<PlanCatalog> = {
      indexes: {
        "public.customers": [
          { name: "customers_pkey", primary: true, unique: true, valid: true, columns: ["id"] },
        ],
      },
      columns: {
        "public.customers": [
          { name: "id", type: "integer", notNull: true },
          { name: "email", type: "text", notNull: false },
        ],
      },
    };
    const findings = readSql("SELECT DISTINCT id, email FROM customers", contextOf(plan, catalog));
    const finding = findingOf(findings, "unnecessary-distinct");
    expect(finding?.severity).toBe("medium");
    expect(finding?.fixKind).toBe("query");
    expect(finding?.title).toBe("DISTINCT does nothing here: id is the primary key");
    expect(finding?.fix).toContain("SELECT id, email FROM customers;");
  });

  /** One read of line_items, whose primary key is (order_id, line_no). */
  function lineItems(outputColumns: string[], repeatsRows = false): SqlContext {
    return sqlContext({
      tables: [contextTable({ name: "line_items" })],
      outputColumns,
      primaryKeys: { "public.line_items": ["order_id", "line_no"] },
      repeatsRows,
    });
  }
  const wholeKey = ["line_items.order_id", "line_items.line_no", "line_items.qty"];

  it("names every column of a composite primary key", () => {
    const text = "SELECT DISTINCT order_id, line_no, qty FROM line_items";
    const finding = findingOf(readSql(text, lineItems(wholeKey)), "unnecessary-distinct");
    expect(finding?.title).toBe(
      "DISTINCT does nothing here: order_id and line_no make up the primary key"
    );
  });

  it("stays quiet when part of the key is missing from the result", () => {
    const context = lineItems(["line_items.order_id", "line_items.qty"]);
    const text = "SELECT DISTINCT order_id, qty FROM line_items";
    expect(ids(readSql(text, context))).not.toContain("unnecessary-distinct");
  });

  it("stays quiet when the plan can hand on a row more than once", () => {
    // unnest() in the select list, or a join to a VALUES list: the key no
    // longer makes each row of the result different.
    const text = "SELECT DISTINCT order_id, line_no, qty FROM line_items";
    expect(ids(readSql(text, lineItems(wholeKey, true)))).not.toContain("unnecessary-distinct");
  });

  it("says DISTINCT removed nothing when the run shows it", () => {
    const context = sqlContext({
      measured: true,
      expectedRows: 5000,
      topNodeType: "Unique",
      distinctRows: { input: 5000, output: 5000 },
    });
    const text = "SELECT DISTINCT customer_id, total FROM orders";
    const finding = findingOf(readSql(text, context), "unnecessary-distinct");
    expect(finding?.title).toBe("DISTINCT removed no rows: all 5,000 were already different");
    expect(finding?.fix).toContain(
      "-- Only if the rows can never repeat, drop DISTINCT:\nSELECT customer_id, total FROM orders;"
    );
  });

  it("stays quiet when DISTINCT did remove rows", () => {
    const context = sqlContext({
      measured: true,
      expectedRows: 4000,
      topNodeType: "Unique",
      distinctRows: { input: 5000, output: 4000 },
    });
    const text = "SELECT DISTINCT customer_id, total FROM orders";
    expect(ids(readSql(text, context))).not.toContain("unnecessary-distinct");
  });

  it("suspects a DISTINCT over a join of hiding repeated rows", () => {
    const text =
      "SELECT DISTINCT c.id, c.email FROM customers c JOIN orders o ON o.customer_id = c.id";
    const finding = findingOf(readSql(text), "unnecessary-distinct");
    expect(finding?.severity).toBe("low");
    expect(finding?.title).toBe("DISTINCT may be hiding rows a join repeats");
  });

  it("says DISTINCT inside IN changes nothing, and hands back the query without it", () => {
    const text = "SELECT id FROM customers WHERE id IN (SELECT DISTINCT customer_id FROM orders)";
    const finding = findingOf(readSql(text), "unnecessary-distinct");
    expect(finding?.severity).toBe("low");
    expect(finding?.title).toBe("DISTINCT inside IN (…) changes nothing");
    expect(finding?.fix).toContain(
      "SELECT id FROM customers WHERE id IN (SELECT customer_id FROM orders);"
    );
  });

  it("says the same of DISTINCT inside EXISTS", () => {
    const text =
      "SELECT id FROM customers c WHERE EXISTS " +
      "(SELECT DISTINCT o.customer_id FROM orders o WHERE o.customer_id = c.id)";
    expect(findingOf(readSql(text), "unnecessary-distinct")?.title).toBe(
      "DISTINCT inside EXISTS (…) changes nothing"
    );
  });

  it.each([
    [
      "one branch of a UNION",
      "SELECT DISTINCT customer_id FROM orders UNION SELECT id FROM customers",
    ],
    [
      "a derived table",
      "SELECT s.customer_id FROM (SELECT DISTINCT customer_id FROM orders) AS s " +
        "WHERE s.customer_id > 5",
    ],
  ])("leaves a DISTINCT in %s alone", (_label, text) => {
    expect(ids(readSql(text))).not.toContain("unnecessary-distinct");
  });
});

describe("readSql — ORDER BY with no LIMIT, judged by how many rows come back", () => {
  const sql = "SELECT id FROM orders WHERE status = 'paid' ORDER BY created_at DESC";

  it("leaves a grouped result alone", () => {
    const text = "SELECT status, count(*) FROM orders GROUP BY status ORDER BY status";
    expect(ids(readSql(text))).not.toContain("order-by-no-limit");
  });

  it("leaves a result the plan expects to be small alone", () => {
    expect(ids(readSql(sql, sqlContext({ expectedRows: 200 })))).not.toContain(
      "order-by-no-limit"
    );
  });

  it("flags a big one, and hands back the statement with a LIMIT", () => {
    const finding = findingOf(readSql(sql, sqlContext({ expectedRows: 50000 })), "order-by-no-limit");
    expect(finding?.fixKind).toBe("query");
    expect(finding?.fix).toContain(`${sql}\nLIMIT 20;`);
  });

  it("does not take a subquery's LIMIT for the result's", () => {
    const text =
      "SELECT id FROM orders WHERE customer_id IN " +
      "(SELECT id FROM customers ORDER BY created_at DESC LIMIT 5) ORDER BY created_at";
    expect(ids(readSql(text))).toContain("order-by-no-limit");
  });

  it("counts FETCH FIRST as a limit", () => {
    expect(ids(readSql(`${sql} FETCH FIRST 20 ROWS ONLY`))).not.toContain("order-by-no-limit");
  });
});

describe("readSql — COUNT(*) over a whole table", () => {
  const sql = "SELECT count(*) FROM orders";

  /** What the plan says about a count that reads all of one table. */
  function countOf(table: Partial<SqlContextTable> = {}): SqlContext {
    return sqlContext({
      topNodeType: "Aggregate",
      expectedRows: 1,
      tables: [
        contextTable({ readsAll: true, feedsPlainAggregate: true, rows: 1200000, ...table }),
      ],
    });
  }

  it("points a count of a big table at the statistics' own estimate", () => {
    const finding = findingOf(readSql(sql, countOf()), "unfiltered-count");
    expect(finding?.severity).toBe("low");
    expect(finding?.fixKind).toBe("query");
    expect(finding?.detail).toContain("orders holds about 1.2 million rows");
    expect(finding?.fix).toContain(`FROM pg_class WHERE oid = '"public"."orders"'::regclass;`);
  });

  it("leaves a small table's count alone", () => {
    expect(ids(readSql(sql, countOf({ rows: 5000 })))).not.toContain("unfiltered-count");
  });

  it("leaves a count alone when the plan narrows the read", () => {
    // The name may be a view with a WHERE of its own: the plan shows the
    // filter that the text cannot.
    expect(ids(readSql(sql, countOf({ readsAll: false })))).not.toContain("unfiltered-count");
  });

  it("leaves a count alone when its rows pass through something that caps or groups them", () => {
    // The subquery reads orders with no filter, but the count is of ten rows:
    // the plan says the scan's rows do not go straight into the count.
    const text = "SELECT count(*) FROM (SELECT * FROM orders LIMIT 10) s";
    expect(ids(readSql(text, countOf({ feedsPlainAggregate: false })))).not.toContain(
      "unfiltered-count"
    );
  });

  it("doubles a single quote in the schema name inside the string literal", () => {
    const finding = findingOf(readSql(sql, countOf({ schema: "o'brien" })), "unfiltered-count");
    expect(finding?.fix).toContain(`'"o''brien"."orders"'::regclass`);
  });

  it("is the only thing said about a count of a big table, plan and text together", () => {
    // The route merges both lists. A missing-WHERE finding would only say
    // the same thing again, less usefully.
    const plan = {
      "Node Type": "Aggregate",
      Strategy: "Plain",
      "Plan Rows": 1,
      "Total Cost": 20000,
      Plans: [
        {
          "Node Type": "Seq Scan",
          "Parent Relationship": "Outer",
          "Relation Name": "orders",
          Schema: "public",
          Alias: "orders",
          "Plan Rows": 1200000,
          "Total Cost": 18000,
        },
      ],
    };
    const fromPlan = readPlan(envelope(plan))?.findings ?? [];
    const merged = sortFindings([...fromPlan, ...readSql(sql, contextOf(plan))]);
    expect(ids(merged)).toEqual(["unfiltered-count"]);
  });

  // The plans below have the shapes PostgreSQL 17 gives these queries.

  /** public.orders read whole, as the step under a count. */
  function ordersScan(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      "Node Type": "Seq Scan",
      "Parent Relationship": "Outer",
      "Relation Name": "orders",
      Schema: "public",
      Alias: "orders",
      "Plan Rows": 1200000,
      "Total Cost": 18000,
      ...over,
    };
  }

  /** One step of a plan, over the steps under it. */
  function planStep(
    nodeType: string,
    over: Record<string, unknown>,
    ...inputs: Record<string, unknown>[]
  ): Record<string, unknown> {
    return {
      "Node Type": nodeType,
      "Parent Relationship": "Outer",
      "Plan Rows": 1,
      "Total Cost": 20000,
      ...over,
      Plans: inputs,
    };
  }

  /** A total with no GROUP BY, the way PostgreSQL plans count(*). */
  const plain = { Strategy: "Plain", "Partial Mode": "Simple" };

  /** Each helper's share of orders in a parallel plan: 1.2 million in all. */
  const ordersShare = () => ordersScan({ "Parallel Aware": true, "Plan Rows": 500000 });

  /** What readSql says about the text, given the context the plan makes. */
  function saysOf(text: string, plan: Record<string, unknown>): string[] {
    return ids(readSql(text, contextOf(plan)));
  }

  it("follows a parallel count up to the step that finishes the total", () => {
    // Each helper adds up its own share (a Partial aggregate) and the step
    // above the Gather adds the shares together.
    const plan = planStep(
      "Aggregate",
      { ...plain, "Partial Mode": "Finalize" },
      planStep(
        "Gather",
        { "Workers Planned": 2, "Plan Rows": 2 },
        planStep("Aggregate", { ...plain, "Partial Mode": "Partial" }, ordersShare())
      )
    );
    const finding = findingOf(readSql(sql, contextOf(plan)), "unfiltered-count");
    expect(finding?.detail).toContain("orders holds about 1.2 million rows");
  });

  it.each([
    {
      label: "through a sort",
      text: "SELECT count(*) FROM (SELECT * FROM orders ORDER BY amount) s",
      plan: planStep("Aggregate", plain, planStep("Sort", { "Plan Rows": 1200000 }, ordersScan())),
    },
    {
      label: "inside a subquery of its own",
      text: "SELECT (SELECT count(*) FROM orders) AS n",
      plan: planStep(
        "Result",
        {},
        planStep(
          "Aggregate",
          { ...plain, "Parent Relationship": "InitPlan", "Subplan Name": "InitPlan 1" },
          ordersScan()
        )
      ),
    },
  ])("still sees a count of the whole table $label", ({ text, plan }) => {
    expect(saysOf(text, plan)).toContain("unfiltered-count");
  });

  const grouped = planStep(
    "Aggregate",
    plain,
    planStep(
      "Aggregate",
      { Strategy: "Hashed", "Group Key": ["orders.customer_id"], "Plan Rows": 5000 },
      ordersScan()
    )
  );

  it.each([
    {
      label: "a LIMIT",
      text: "SELECT count(*) FROM (SELECT * FROM orders LIMIT 10) s",
      plan: planStep("Aggregate", plain, planStep("Limit", { "Plan Rows": 10 }, ordersScan())),
    },
    {
      label: "an OFFSET",
      text: "SELECT count(*) FROM (SELECT * FROM orders OFFSET 5) s",
      plan: planStep("Aggregate", plain, planStep("Limit", { "Plan Rows": 1199995 }, ordersScan())),
    },
    {
      label: "a GROUP BY",
      text: "SELECT count(*) FROM (SELECT customer_id FROM orders GROUP BY customer_id) s",
      plan: grouped,
    },
    {
      label: "a DISTINCT",
      text: "SELECT count(*) FROM (SELECT DISTINCT customer_id FROM orders) s",
      plan: grouped,
    },
    {
      // Grouping sets name no single Group Key: only the strategy says the
      // rows are grouped.
      label: "a ROLLUP",
      text: "SELECT count(*) FROM (SELECT customer_id FROM orders GROUP BY ROLLUP (customer_id)) s",
      plan: planStep(
        "Aggregate",
        plain,
        planStep(
          "Aggregate",
          {
            Strategy: "Mixed",
            "Grouping Sets": [{ "Hash Keys": [["orders.customer_id"]] }, { "Group Keys": [[]] }],
            "Plan Rows": 5001,
          },
          ordersScan()
        )
      ),
    },
    {
      label: "a join to a function's rows",
      text: "SELECT count(*) FROM orders, generate_series(1, 3)",
      plan: planStep(
        "Aggregate",
        plain,
        planStep(
          "Nested Loop",
          { "Join Type": "Inner", "Plan Rows": 3600000 },
          ordersScan(),
          {
            "Node Type": "Function Scan",
            "Parent Relationship": "Inner",
            "Function Name": "generate_series",
            Alias: "generate_series",
            "Plan Rows": 3,
            "Total Cost": 0.03,
          }
        )
      ),
    },
    {
      label: "a WITH query's LIMIT",
      text: "WITH x AS MATERIALIZED (SELECT * FROM orders LIMIT 10) SELECT count(*) FROM x",
      plan: planStep(
        "Aggregate",
        plain,
        planStep(
          "Limit",
          { "Parent Relationship": "InitPlan", "Subplan Name": "CTE x", "Plan Rows": 10 },
          ordersScan()
        ),
        {
          "Node Type": "CTE Scan",
          "Parent Relationship": "Outer",
          "CTE Name": "x",
          Alias: "x",
          "Plan Rows": 10,
          "Total Cost": 0.2,
        }
      ),
    },
  ])("leaves a count alone when $label stands between it and the table", ({ text, plan }) => {
    expect(saysOf(text, plan)).not.toContain("unfiltered-count");
  });

  it("leaves a count alone that a HAVING then tests", () => {
    // The HAVING is the Filter of the step that finishes the total, above
    // the helpers' partial counts.
    const plan = planStep(
      "Aggregate",
      { ...plain, "Partial Mode": "Finalize", Filter: "(count(*) > 0)" },
      planStep(
        "Gather",
        { "Workers Planned": 2, "Plan Rows": 2 },
        planStep("Aggregate", { ...plain, "Partial Mode": "Partial" }, ordersShare())
      )
    );
    expect(saysOf("SELECT max(amount) FROM orders HAVING count(*) > 0", plan)).not.toContain(
      "unfiltered-count"
    );
  });

  it("leaves count(*) OVER () to the missing-WHERE finding: every row comes back", () => {
    const plan = planStep("WindowAgg", { "Plan Rows": 1200000 }, ordersScan());
    const said = saysOf("SELECT count(*) OVER () FROM orders", plan);
    expect(said).not.toContain("unfiltered-count");
    expect(said).toContain("missing-where");
  });
});

describe("readSql — a pattern that starts with %", () => {
  const sql = "SELECT id FROM customers WHERE email LIKE '%smith'";
  const customers = sqlContext({
    tables: [
      contextTable({
        name: "customers",
        filter: "((customers.email)::text ~~ '%smith'::text)",
        columnTypes: { email: "character varying(200)" },
      }),
    ],
  });

  it("names the column the plan matched, and offers a trigram index as a decision", () => {
    const finding = findingOf(readSql(sql, customers), "leading-wildcard");
    expect(finding?.object).toBe("customers.email");
    expect(finding?.fixKind).toBe("decision");
    expect(finding?.fix).toContain("-- CREATE EXTENSION IF NOT EXISTS pg_trgm;");
    expect(finding?.fix).toContain(
      '-- CREATE INDEX "customers_email_trgm_idx" ON "public"."customers" ' +
        'USING gin ("email" gin_trgm_ops);'
    );
    expect(finding?.undo).toBeUndefined();
  });

  it("says 'the LIKE condition' when there is no plan to name the column", () => {
    expect(findingOf(readSql(sql), "leading-wildcard")?.object).toBe("the LIKE condition");
  });

  it("tells an ILIKE search how an index could serve it", () => {
    const text = "SELECT id FROM customers WHERE email ILIKE '%smith%'";
    expect(findingOf(readSql(text), "leading-wildcard")?.fix).toContain(
      "write lower(column) LIKE 'text%'"
    );
  });

  it("does not take a leading space for a wildcard", () => {
    const text = "SELECT id FROM customers WHERE email LIKE ' %x'";
    expect(ids(readSql(text))).not.toContain("leading-wildcard");
  });

  it("reads an E'…' string too", () => {
    const text = "SELECT id FROM customers WHERE email LIKE E'%x'";
    expect(ids(readSql(text))).toContain("leading-wildcard");
  });
});

describe("readSql — a function wrapped around a filtered column", () => {
  /** A read of all 50,000 customers for the ones whose lower-cased email matches. */
  function lowerEmailScan(planRows: number): Record<string, unknown> {
    return {
      "Node Type": "Seq Scan",
      "Relation Name": "customers",
      Schema: "public",
      Alias: "c",
      Filter: "(lower((c.email)::text) = 'user5@example.com'::text)",
      "Plan Rows": planRows,
      "Total Cost": 1200,
    };
  }
  const catalog: Partial<PlanCatalog> = {
    tableRows: { "public.customers": 50000 },
    columns: {
      "public.customers": [{ name: "email", type: "character varying(200)", notNull: false }],
    },
  };
  const sql = "SELECT id FROM customers c WHERE LOWER(c.email) = 'user5@example.com'";

  it("hands over an index on the expression when the read keeps a few rows", () => {
    const context = contextOf(lowerEmailScan(250), catalog);
    const finding = findingOf(readSql(sql, context), "function-on-column");
    expect(finding?.fixKind).toBe("change");
    expect(finding?.object).toBe("LOWER(c.email)");
    expect(finding?.fix).toContain(
      'CREATE INDEX "customers_lower_email_idx" ON "public"."customers" (lower("email"));'
    );
    expect(finding?.undo).toBe('DROP INDEX "public"."customers_lower_email_idx";');
  });

  it("suggests changing the query instead when the read keeps most of the table", () => {
    const context = contextOf(lowerEmailScan(40000), catalog);
    const finding = findingOf(readSql(sql, context), "function-on-column");
    expect(finding?.fixKind).toBe("query");
    expect(finding?.fix).toContain("When it picks out a few rows of a big table");
    expect(finding?.undo).toBeUndefined();
  });

  it("stays quiet once an index on the expression answers the call", () => {
    // The plan after CREATE INDEX customers_lower_email_idx: a lookup, not a read.
    const lookup = {
      "Node Type": "Index Scan",
      "Index Name": "customers_lower_email_idx",
      "Relation Name": "customers",
      Schema: "public",
      Alias: "c",
      "Index Cond": "(lower((c.email)::text) = 'user5@example.com'::text)",
      "Plan Rows": 1,
      "Total Cost": 8.3,
    };
    expect(findingOf(readSql(sql, contextOf(lookup, catalog)), "function-on-column")).toBeUndefined();
  });

  it("stays quiet when a bitmap scan of that index answers it", () => {
    // Postgres 17 prints this for the same lookup with plain index scans off.
    const bitmap = {
      "Node Type": "Bitmap Heap Scan",
      "Relation Name": "customers",
      Schema: "public",
      Alias: "customers",
      "Recheck Cond": "(lower((customers.email)::text) = 'user5@example.com'::text)",
      "Plan Rows": 1,
      "Total Cost": 12,
      Plans: [
        {
          "Node Type": "Bitmap Index Scan",
          "Parent Relationship": "Outer",
          "Index Name": "customers_lower_email_idx",
          "Index Cond": "(lower((customers.email)::text) = 'user5@example.com'::text)",
          "Plan Rows": 1,
          "Total Cost": 4.3,
        },
      ],
    };
    const text = "SELECT id FROM customers WHERE LOWER(email) = 'user5@example.com'";
    expect(findingOf(readSql(text, contextOf(bitmap, catalog)), "function-on-column")).toBeUndefined();
  });

  it("still speaks about a call the index does not answer", () => {
    // The lookup serves c.email; s.email is still worked out row by row.
    const context = sqlContext({
      tables: [
        contextTable({ name: "customers", alias: "c", indexCond: "(lower((c.email)::text) = 'a@b.c'::text)" }),
        contextTable({ name: "staff", alias: "s" }),
      ],
    });
    const text =
      "SELECT c.id FROM customers c, staff s WHERE LOWER(c.email) = 'a@b.c' AND LOWER(s.email) = 'a@b.c'";
    expect(findingOf(readSql(text, context), "function-on-column")?.object).toBe("LOWER(s.email)");
  });

  it("rewrites a DATE() comparison as a range an index on the bare column can serve", () => {
    const text = "SELECT id FROM orders WHERE DATE(created_at) = '2024-05-01'";
    const fix = findingOf(readSql(text), "function-on-column")?.fix ?? "";
    expect(fix).toContain("DATE(created_at) = d");
    expect(fix).toContain("created_at >= d AND created_at < d + 1");
  });
});

describe("sortFindings", () => {
  it("orders high before medium before low", () => {
    const sorted = sortFindings([
      { id: "c", severity: "low", title: "", object: "", detail: "", fix: "", fixKind: "decision" as const, stepId: null },
      { id: "a", severity: "high", title: "", object: "", detail: "", fix: "", fixKind: "decision" as const, stepId: null },
      { id: "b", severity: "medium", title: "", object: "", detail: "", fix: "", fixKind: "decision" as const, stepId: null },
    ]);
    expect(ids(sorted)).toEqual(["a", "b", "c"]);
  });

  it("leaves the original array untouched", () => {
    const input = [
      { id: "c", severity: "low" as const, title: "", object: "", detail: "", fix: "", fixKind: "decision" as const, stepId: null },
      { id: "a", severity: "high" as const, title: "", object: "", detail: "", fix: "", fixKind: "decision" as const, stepId: null },
    ];
    sortFindings(input);
    expect(ids(input)).toEqual(["c", "a"]);
  });
});

describe("summarizeFindings", () => {
  it("counts each severity and the total", () => {
    const counts = summarizeFindings([
      { id: "a", severity: "high", title: "", object: "", detail: "", fix: "", fixKind: "decision" as const, stepId: null },
      { id: "b", severity: "low", title: "", object: "", detail: "", fix: "", fixKind: "decision" as const, stepId: null },
      { id: "c", severity: "low", title: "", object: "", detail: "", fix: "", fixKind: "decision" as const, stepId: null },
    ]);
    expect(counts).toEqual({ high: 1, medium: 0, low: 2, total: 3 });
  });

  it("counts an empty list as all zeroes", () => {
    expect(summarizeFindings([])).toEqual({ high: 0, medium: 0, low: 0, total: 0 });
  });
});

// ── Each step's share, and the plan in plain words ───────────────────────────

/** readPlan, for a fixture the test knows is a plan. */
function summaryOf(plan: Record<string, unknown>, catalog: Partial<PlanCatalog> = {}): PlanSummary {
  const summary = readPlan(envelope(plan), catalog);
  if (!summary) throw new Error("The fixture is not a plan.");
  return summary;
}

/**
 * An estimated join of a hundred customers to their orders: one index lookup
 * of orders for each customer. One lookup costs 8, but there are a hundred of
 * them, so the lookups are 800 of the join's 830. Read at face value, the 8
 * would make the 10-unit scan of customers look like the heavier step.
 */
function customersThenOrders(): Record<string, unknown> {
  return {
    "Node Type": "Nested Loop",
    "Join Type": "Inner",
    "Plan Rows": 100,
    "Total Cost": 830,
    Plans: [
      {
        "Node Type": "Seq Scan",
        "Parent Relationship": "Outer",
        "Relation Name": "customers",
        Schema: "public",
        Alias: "c",
        "Plan Rows": 100,
        "Total Cost": 10,
      },
      {
        "Node Type": "Index Scan",
        "Parent Relationship": "Inner",
        "Relation Name": "orders",
        Schema: "public",
        Alias: "o",
        "Index Name": "orders_customer_idx",
        "Index Cond": "(o.customer_id = c.id)",
        "Plan Rows": 1,
        "Total Cost": 8,
      },
    ],
  };
}

/**
 * The same join, run. The scan took 1 ms; each of the 100 lookups took
 * 0.06 ms and found 60 orders (6 ms in all); the join itself took the other
 * 3 ms of the 10.
 */
function customersThenOrdersRun(): Record<string, unknown> {
  return {
    "Node Type": "Nested Loop",
    "Join Type": "Inner",
    "Plan Rows": 100,
    "Total Cost": 830,
    "Actual Total Time": 10,
    "Actual Rows": 6000,
    "Actual Loops": 1,
    Plans: [
      {
        "Node Type": "Seq Scan",
        "Parent Relationship": "Outer",
        "Relation Name": "customers",
        Schema: "public",
        Alias: "c",
        "Plan Rows": 100,
        "Total Cost": 10,
        "Actual Total Time": 1,
        "Actual Rows": 100,
        "Actual Loops": 1,
      },
      {
        "Node Type": "Index Scan",
        "Parent Relationship": "Inner",
        "Relation Name": "orders",
        Schema: "public",
        Alias: "o",
        "Index Name": "orders_customer_idx",
        "Index Cond": "(o.customer_id = c.id)",
        "Plan Rows": 1,
        "Total Cost": 8,
        "Actual Total Time": 0.06,
        "Actual Rows": 60,
        "Actual Loops": 100,
      },
    ],
  };
}

/**
 * A run in which no order was 'lost', so the customer lookup the join would
 * have done for each one never started. That is PostgreSQL's "never
 * executed", which JSON gives as zero loops and zero rows.
 */
function neverNeeded(): Record<string, unknown> {
  return {
    "Node Type": "Nested Loop",
    "Join Type": "Inner",
    "Plan Rows": 10,
    "Total Cost": 300,
    "Actual Total Time": 0.5,
    "Actual Rows": 0,
    "Actual Loops": 1,
    Plans: [
      {
        "Node Type": "Seq Scan",
        "Parent Relationship": "Outer",
        "Relation Name": "orders",
        Schema: "public",
        Alias: "o",
        Filter: "(o.status = 'lost'::text)",
        "Rows Removed by Filter": 100,
        "Plan Rows": 10,
        "Total Cost": 20,
        "Actual Total Time": 0.4,
        "Actual Rows": 0,
        "Actual Loops": 1,
      },
      {
        "Node Type": "Index Scan",
        "Parent Relationship": "Inner",
        "Relation Name": "customers",
        Schema: "public",
        Alias: "c",
        "Index Name": "customers_pkey",
        "Index Cond": "(c.id = o.customer_id)",
        "Plan Rows": 1,
        "Total Cost": 8,
        "Actual Total Time": 0,
        "Actual Rows": 0,
        "Actual Loops": 0,
      },
    ],
  };
}

/**
 * An estimate for `SELECT * FROM readings WHERE v < 200` on a table of a
 * million rows, split between two helpers and the main process. The planner
 * divides the rows by 2.4, so the scan's Plan Rows are one process's share of
 * the matches, and the Gather's are all of them.
 */
function readingsInParallel(perProcess: number): Record<string, unknown> {
  return {
    "Node Type": "Gather",
    "Workers Planned": 2,
    "Plan Rows": Math.round(perProcess * 2.4),
    "Total Cost": 12000,
    Plans: [
      {
        "Node Type": "Seq Scan",
        "Parent Relationship": "Outer",
        "Parallel Aware": true,
        "Relation Name": "readings",
        Schema: "public",
        Alias: "readings",
        Filter: "(readings.v < 200)",
        "Plan Rows": perProcess,
        "Total Cost": 11000,
      },
    ],
  };
}

/**
 * A run of a paid-order count in parallel: three processes (two helpers and
 * the main one) each read a third of public.orders and count their share, and
 * the top step adds the three counts up.
 */
function paidCountInParallel(): Record<string, unknown> {
  return {
    "Node Type": "Aggregate",
    Strategy: "Plain",
    "Partial Mode": "Finalize",
    "Plan Rows": 1,
    "Total Cost": 3769,
    "Actual Total Time": 12,
    "Actual Rows": 1,
    "Actual Loops": 1,
    Plans: [
      {
        "Node Type": "Gather",
        "Parent Relationship": "Outer",
        "Workers Planned": 2,
        "Workers Launched": 2,
        "Plan Rows": 2,
        "Total Cost": 3769,
        "Actual Total Time": 11.9,
        "Actual Rows": 3,
        "Actual Loops": 1,
        Plans: [
          {
            "Node Type": "Aggregate",
            Strategy: "Plain",
            "Partial Mode": "Partial",
            "Parent Relationship": "Outer",
            "Plan Rows": 1,
            "Total Cost": 3768.5,
            "Actual Total Time": 7.5,
            "Actual Rows": 1,
            "Actual Loops": 3,
            Plans: [
              {
                "Node Type": "Seq Scan",
                "Parent Relationship": "Outer",
                "Parallel Aware": true,
                "Relation Name": "orders",
                Schema: "public",
                Alias: "orders",
                Filter: "(orders.status = 'paid'::text)",
                "Rows Removed by Filter": 99750,
                "Plan Rows": 246,
                "Total Cost": 3768,
                "Actual Total Time": 7.4,
                "Actual Rows": 250,
                "Actual Loops": 3,
              },
            ],
          },
        ],
      },
    ],
  };
}

/** Orders over the average total: the average is an InitPlan, worked out once. */
function aboveAverage(): Record<string, unknown> {
  return {
    "Node Type": "Seq Scan",
    "Relation Name": "orders",
    Schema: "public",
    Alias: "o",
    Filter: "(o.total > (InitPlan 1).col1)",
    "Plan Rows": 1000,
    "Total Cost": 400,
    Plans: [
      {
        "Node Type": "Aggregate",
        Strategy: "Plain",
        "Parent Relationship": "InitPlan",
        "Subplan Name": "InitPlan 1",
        Output: ["avg(orders.total)"],
        "Plan Rows": 1,
        "Total Cost": 200,
        Plans: [
          {
            "Node Type": "Seq Scan",
            "Parent Relationship": "Outer",
            "Relation Name": "orders",
            Schema: "public",
            Alias: "orders",
            Output: ["orders.total"],
            "Plan Rows": 3000,
            "Total Cost": 150,
          },
        ],
      },
    ],
  };
}

/** Each customer's largest payment: a SubPlan, run once for each customer. */
function largestPayment(): Record<string, unknown> {
  return {
    "Node Type": "Seq Scan",
    "Relation Name": "customers",
    Schema: "public",
    Alias: "c",
    Output: ["c.id", "(SubPlan 1)"],
    "Plan Rows": 5000,
    "Total Cost": 41678,
    Plans: [
      {
        "Node Type": "Aggregate",
        Strategy: "Plain",
        "Parent Relationship": "SubPlan",
        "Subplan Name": "SubPlan 1",
        Output: ["max(p.amount)"],
        "Plan Rows": 1,
        "Total Cost": 8.3,
        Plans: [
          {
            "Node Type": "Index Scan",
            "Parent Relationship": "Outer",
            "Relation Name": "payments",
            Schema: "public",
            Alias: "p",
            "Index Name": "payments_customer_idx",
            "Index Cond": "(p.customer_id = c.id)",
            "Plan Rows": 1,
            "Total Cost": 8.29,
          },
        ],
      },
    ],
  };
}

/**
 * Customers not on the blocked list. PostgreSQL ran this SubPlan once and
 * kept its rows in a lookup table, and says so only in the parent's filter,
 * in PostgreSQL 17's own words.
 */
function notBlocked(): Record<string, unknown> {
  return {
    "Node Type": "Seq Scan",
    "Relation Name": "customers",
    Schema: "public",
    Alias: "c",
    Filter: "(NOT (ANY (c.id = (hashed SubPlan 1).col1)))",
    "Plan Rows": 2500,
    "Total Cost": 92,
    Plans: [
      {
        "Node Type": "Seq Scan",
        "Parent Relationship": "SubPlan",
        "Subplan Name": "SubPlan 1",
        "Relation Name": "blocked",
        Schema: "public",
        Alias: "blocked",
        "Plan Rows": 40,
        "Total Cost": 1.4,
      },
    ],
  };
}

/** A WITH query, worked out once and read back by the main query. */
function recentOrders(): Record<string, unknown> {
  return {
    "Node Type": "CTE Scan",
    "CTE Name": "recent",
    Alias: "r",
    "Plan Rows": 590,
    "Total Cost": 12,
    Plans: [
      {
        "Node Type": "Seq Scan",
        "Parent Relationship": "InitPlan",
        "Subplan Name": "CTE recent",
        "Relation Name": "orders",
        Schema: "public",
        Alias: "orders",
        Filter: "(orders.created_at > '2024-01-01'::date)",
        "Plan Rows": 590,
        "Total Cost": 400,
      },
    ],
  };
}

/** Customers with no orders (NOT EXISTS): the lookup of orders stops at the first match. */
function customersWithoutOrders(): Record<string, unknown> {
  return {
    "Node Type": "Nested Loop",
    "Join Type": "Anti",
    "Plan Rows": 4000,
    "Total Cost": 2400,
    Plans: [
      {
        "Node Type": "Seq Scan",
        "Parent Relationship": "Outer",
        "Relation Name": "customers",
        Schema: "public",
        Alias: "c",
        "Plan Rows": 5000,
        "Total Cost": 78,
      },
      {
        "Node Type": "Index Only Scan",
        "Parent Relationship": "Inner",
        "Relation Name": "orders",
        Schema: "public",
        Alias: "o",
        "Index Name": "orders_customer_idx",
        "Index Cond": "(o.customer_id = c.id)",
        // What a full lookup would find. NOT EXISTS stops at the first one.
        "Plan Rows": 60,
        "Total Cost": 0.45,
      },
    ],
  };
}

describe("readPlan — each step's share of the query", () => {
  it("charges a repeated lookup for every run, which makes it the heaviest step", () => {
    const summary = summaryOf(customersThenOrders());
    // The planner's 8 is for one lookup, and there is one for each customer.
    expect(summary.steps[2].estimatedRuns).toBe(100);
    expect(summary.steps[2].selfCost).toBe(800);
    // The join's own part is what is left of its 830: 830 - 10 - 800.
    expect(summary.steps[0].selfCost).toBe(20);
    expect(summary.heaviestStepId).toBe(2);
    expect(summary.basis).toBe("cost");
    expect(summary.steps[2].share).toBeCloseTo(800 / 830);
    expect(heaviestStepLabel(summary.basis)).toBe("Most expensive step (estimate)");
  });

  it("charges a Materialize, and what it reads, once: later passes replay the saved rows", () => {
    const summary = summaryOf({
      "Node Type": "Nested Loop",
      "Join Type": "Inner",
      "Join Filter": "(a.x < b.y)",
      "Plan Rows": 1000,
      "Total Cost": 58,
      Plans: [
        {
          "Node Type": "Seq Scan",
          "Parent Relationship": "Outer",
          "Relation Name": "a",
          Schema: "public",
          "Plan Rows": 100,
          "Total Cost": 10,
        },
        {
          "Node Type": "Materialize",
          "Parent Relationship": "Inner",
          "Plan Rows": 10,
          "Total Cost": 30,
          Plans: [
            {
              "Node Type": "Seq Scan",
              "Parent Relationship": "Outer",
              "Relation Name": "b",
              Schema: "public",
              "Plan Rows": 10,
              "Total Cost": 25,
            },
          ],
        },
      ],
    });
    expect(summary.steps.map((s) => s.estimatedRuns)).toEqual([1, 1, 1, 1]);
    // The replays are in the join's own cost: 58 - 10 - 30.
    expect(summary.steps[0].selfCost).toBe(18);
  });

  it("charges an InitPlan once, a SubPlan for each row, and a hashed SubPlan once", () => {
    expect(summaryOf(aboveAverage()).steps.map((s) => s.estimatedRuns)).toEqual([1, 1, 1]);
    // The Aggregate and the lookup under it both run once per customer.
    expect(summaryOf(largestPayment()).steps.map((s) => s.estimatedRuns)).toEqual([1, 5000, 5000]);
    expect(summaryOf(notBlocked()).steps.map((s) => s.estimatedRuns)).toEqual([1, 1]);
  });

  it("gives shares that add up to the whole query, estimated or measured", () => {
    const plans = [
      customersThenOrders(),
      customersThenOrdersRun(),
      ordersToCustomers(),
      largestPayment(),
      paidCountInParallel(),
      neverNeeded(),
    ];
    for (const plan of plans) {
      const total = summaryOf(plan).steps.reduce((sum, s) => sum + s.share, 0);
      expect(total).toBeCloseTo(1);
    }
  });

  it("weighs a run by the time each step took, and names the slowest", () => {
    const summary = summaryOf(customersThenOrdersRun());
    expect(summary.basis).toBe("time");
    expect(summary.heaviestStepId).toBe(2);
    // 3 of the 10 ms were the join itself, 1 the scan, 6 the hundred lookups.
    expect(summary.steps.map((s) => Math.round(s.share * 100))).toEqual([30, 10, 60]);
    expect(heaviestStepLabel(summary.basis)).toBe("Slowest step");
  });

  it("falls back to cost, and does not say 'slowest', when a run timed nothing", () => {
    // EXPLAIN (ANALYZE, TIMING OFF) counts rows but times no step, so there
    // is no time to call any step the slowest by.
    const summary = summaryOf({
      "Node Type": "Seq Scan",
      "Relation Name": "t",
      Schema: "public",
      "Plan Rows": 1,
      "Total Cost": 1,
      "Actual Rows": 1,
      "Actual Loops": 1,
    });
    expect(summary.measured).toBe(true);
    expect(summary.basis).toBe("cost");
    expect(heaviestStepLabel(summary.basis)).toBe("Most expensive step (estimate)");
  });
});

describe("shareBand, shareText, heaviestStepLabel and shareLegend", () => {
  it("tints half the query or more hot, a fifth or more warm, and less than that not at all", () => {
    expect(shareBand(0.5)).toBe("hot");
    expect(shareBand(0.2)).toBe("warm");
    expect(shareBand(0.19)).toBe("none");
  });

  it("prints a sliver as <1%, since 0% would say the step did nothing", () => {
    expect(shareText(0)).toBe("0%");
    expect(shareText(0.004)).toBe("<1%");
    expect(shareText(0.38)).toBe("38%");
  });

  it("calls a step the slowest only when it was timed", () => {
    expect(heaviestStepLabel("time")).toBe("Slowest step");
    expect(heaviestStepLabel("cost")).toBe("Most expensive step (estimate)");
  });

  it("says what the percentages are a share of", () => {
    expect(shareLegend("time")).toBe("Share of the query's total time (measured)");
    expect(shareLegend("cost")).toBe(
      "Share of the planner's estimated cost; an estimate, not a timing"
    );
  });
});

describe("readPlan — each finding names its step", () => {
  // One plan for each plan rule, and the step the finding is about. Three of
  // them sit a step down, so a stepId stuck at 0 cannot pass by accident.
  const cases: [string, number, Record<string, unknown>, Partial<PlanCatalog>][] = [
    [
      "seq-scan",
      0,
      {
        "Node Type": "Seq Scan",
        "Relation Name": "orders",
        Schema: "public",
        Alias: "orders",
        Filter: "(status = 'paid'::text)",
        "Plan Rows": 50000,
        "Total Cost": 900,
      },
      { tableRows: { "public.orders": 1000000 } },
    ],
    [
      "wasteful-filter",
      0,
      {
        "Node Type": "Index Scan",
        "Relation Name": "events",
        Schema: "public",
        Alias: "events",
        "Index Name": "events_created_idx",
        "Index Cond": "(created_at > '2024-01-01'::date)",
        Filter: "(kind = 'error'::text)",
        "Rows Removed by Filter": 99000,
        "Plan Rows": 1000,
        "Total Cost": 900,
        "Actual Total Time": 40,
        "Actual Rows": 1000,
        "Actual Loops": 1,
      },
      {},
    ],
    [
      "estimate-off",
      0,
      {
        "Node Type": "Index Scan",
        "Relation Name": "orders",
        Schema: "public",
        Alias: "o",
        "Index Name": "orders_customer_idx",
        "Plan Rows": 10,
        "Total Cost": 20,
        "Actual Total Time": 30,
        "Actual Rows": 4000,
        "Actual Loops": 1,
      },
      {},
    ],
    [
      "sort-on-disk",
      1,
      {
        "Node Type": "Unique",
        "Plan Rows": 100,
        "Total Cost": 21000,
        "Actual Total Time": 95,
        "Actual Rows": 100,
        "Actual Loops": 1,
        Plans: [
          {
            "Node Type": "Sort",
            "Parent Relationship": "Outer",
            "Sort Key": ["created_at"],
            "Sort Method": "external merge  Disk: 4096kB",
            "Plan Rows": 100000,
            "Total Cost": 20000,
            "Actual Total Time": 90,
            "Actual Rows": 100000,
            "Actual Loops": 1,
          },
        ],
      },
      {},
    ],
    [
      "nested-loop",
      0,
      {
        "Node Type": "Nested Loop",
        "Plan Rows": 5000,
        "Total Cost": 10,
        "Actual Total Time": 900,
        "Actual Rows": 5000,
        "Actual Loops": 1,
        Plans: [
          {
            "Node Type": "Seq Scan",
            "Parent Relationship": "Outer",
            "Relation Name": "orders",
            Schema: "public",
            Alias: "o",
            "Plan Rows": 5000,
            "Total Cost": 80,
            "Actual Total Time": 5,
            "Actual Rows": 5000,
            "Actual Loops": 1,
          },
          {
            "Node Type": "Seq Scan",
            "Parent Relationship": "Inner",
            "Relation Name": "line_items",
            Schema: "public",
            Alias: "li",
            Filter: "(li.order_id = o.id)",
            "Rows Removed by Filter": 999,
            "Plan Rows": 1,
            "Total Cost": 1,
            "Actual Total Time": 0.1,
            "Actual Rows": 1,
            "Actual Loops": 5000,
          },
        ],
      },
      {},
    ],
    ["join-key", 0, ordersToCustomers(), {}],
    [
      "lossy-bitmap",
      1,
      {
        "Node Type": "Aggregate",
        Strategy: "Plain",
        "Plan Rows": 1,
        "Total Cost": 5000,
        "Actual Total Time": 60,
        "Actual Rows": 1,
        "Actual Loops": 1,
        Plans: [
          {
            "Node Type": "Bitmap Heap Scan",
            "Parent Relationship": "Outer",
            "Relation Name": "events",
            Schema: "public",
            Alias: "events",
            "Recheck Cond": "(created_at > '2024-01-01'::date)",
            "Rows Removed by Index Recheck": 5000,
            "Exact Heap Blocks": 1200,
            "Lossy Heap Blocks": 800,
            "Plan Rows": 40000,
            "Total Cost": 4900,
            "Actual Total Time": 55,
            "Actual Rows": 40000,
            "Actual Loops": 1,
            Plans: [
              {
                "Node Type": "Bitmap Index Scan",
                "Parent Relationship": "Outer",
                "Index Name": "events_created_idx",
                "Index Cond": "(created_at > '2024-01-01'::date)",
                "Plan Rows": 40000,
                "Total Cost": 400,
                "Actual Total Time": 5,
                "Actual Rows": 40000,
                "Actual Loops": 1,
              },
            ],
          },
        ],
      },
      {},
    ],
    [
      "heap-fetches",
      1,
      {
        "Node Type": "Aggregate",
        Strategy: "Plain",
        "Plan Rows": 1,
        "Total Cost": 1500,
        "Actual Total Time": 30,
        "Actual Rows": 1,
        "Actual Loops": 1,
        Plans: [
          {
            "Node Type": "Index Only Scan",
            "Parent Relationship": "Outer",
            "Relation Name": "orders",
            Schema: "public",
            Alias: "o",
            "Index Name": "orders_pkey",
            "Heap Fetches": 40000,
            "Plan Rows": 50000,
            "Total Cost": 1400,
            "Actual Total Time": 25,
            "Actual Rows": 50000,
            "Actual Loops": 1,
          },
        ],
      },
      {},
    ],
  ];

  it.each(cases)("sets stepId on a %s finding to step %i", (rule, step, plan, catalog) => {
    const findings = summaryOf(plan, catalog).findings;
    expect(ids(findings)).toContain(`${rule}:${step}`);
    // Every finding, not only this rule's: each id ends in its own step.
    for (const f of findings) expect(f.stepId).toBe(Number(f.id.split(":")[1]));
  });

  it("leaves stepId null on a finding about the SQL text, which has no step", () => {
    const findings = [
      ...readSql("SELECT * FROM orders"),
      ...readSql("SELECT id FROM customers WHERE email LIKE '%smith'"),
      ...readSql("SELECT a.id FROM a, b WHERE b.a_id = a.id"),
      ...readSql("SELECT id, total FROM orders", sqlContext({ expectedRows: 5000 })),
    ];
    expect(ids(findings)).toEqual(
      expect.arrayContaining(["select-star", "leading-wildcard", "comma-join", "missing-where"])
    );
    for (const f of findings) expect(f.stepId).toBeNull();
  });
});

describe("explainInWords", () => {
  /** The plan in words, for a fixture. */
  function words(plan: Record<string, unknown>, catalog: Partial<PlanCatalog> = {}): string[] {
    return explainInWords(summaryOf(plan, catalog));
  }

  /** A read of public.orders (o) for the paid orders. */
  function paidScan(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      "Node Type": "Seq Scan",
      "Relation Name": "orders",
      Schema: "public",
      Alias: "o",
      Filter: "(o.status = 'paid'::text)",
      "Plan Rows": 590,
      "Total Cost": 900,
      ...extra,
    };
  }

  it("says what a scan keeps, as a guess when the query was not run", () => {
    expect(words(paidScan())).toEqual([
      "Reads the whole of public.orders (o), and keeps about 590 rows where o.status = 'paid'.",
    ]);
  });

  it("gives the counts the run saw, with no 'about', once measured", () => {
    const run = paidScan({
      "Rows Removed by Filter": 4900,
      "Actual Total Time": 2,
      "Actual Rows": 100,
      "Actual Loops": 1,
    });
    expect(words(run)).toEqual([
      "Reads all 5,000 rows of public.orders (o), and keeps the 100 where o.status = 'paid'.",
    ]);
  });

  it("builds a hash join's lookup table before it reads the side matched against it", () => {
    expect(words(ordersToCustomers())).toEqual([
      "Reads the whole of public.customers (c), and keeps about 10 rows where c.country = 'NZ'.",
      "Builds a lookup table from those rows.",
      "Reads the whole of public.orders (o), about 1 million rows.",
      "Matches each row of public.orders (o) against the lookup table on o.customer_id = c.id, " +
        "giving about 50 rows.",
    ]);
  });

  it("counts one run of a nested loop's repeated side, and says how often it runs", () => {
    expect(words(customersThenOrders())).toEqual([
      "Reads the whole of public.customers (c), about 100 rows.",
      "Looks up the rows of public.orders (o) where o.customer_id = c.id, through the index " +
        "orders_customer_idx, giving about 1 row (each time; expected to run about 100 times).",
      "Pairs each row of public.customers (c) with the matching rows of public.orders (o), " +
        "giving about 100 rows.",
    ]);
    expect(words(customersThenOrdersRun())).toEqual([
      "Reads all 100 rows of public.customers (c).",
      "Looks up the rows of public.orders (o) where o.customer_id = c.id, through the index " +
        "orders_customer_idx, giving 60 rows (each time; it ran 100 times).",
      "Pairs each row of public.customers (c) with the matching rows of public.orders (o), " +
        "giving 6,000 rows.",
    ]);
  });

  it("tells an InitPlan first, and says it runs only once", () => {
    const lines = words(aboveAverage());
    expect(lines[0]).toBe(
      "InitPlan 1, which runs only once: reads the whole of public.orders, about 3,000 rows."
    );
    expect(lines[lines.length - 1]).toMatch(
      /^Reads the whole of public\.orders \(o\), and keeps about 1,000 rows where o\.total > \(InitPlan 1\)/
    );
  });

  it("tells a SubPlan before the step that uses it, and says it runs for each row", () => {
    const lines = words(largestPayment());
    expect(lines[0]).toBe(
      "SubPlan 1, which runs once for each row of public.customers (c): looks up the rows of " +
        "public.payments (p) where p.customer_id = c.id, through the index payments_customer_idx, " +
        "giving about 1 row (each time; expected to run about 5,000 times)."
    );
    expect(lines[lines.length - 1]).toBe("Reads the whole of public.customers (c), about 5,000 rows.");
  });

  it("says a hashed SubPlan runs once and keeps its rows", () => {
    expect(words(notBlocked())).toEqual([
      "SubPlan 1, which runs once and keeps its rows in a lookup table: reads the whole of " +
        "public.blocked, about 40 rows.",
      "Reads the whole of public.customers (c), and keeps about 2,500 rows where " +
        "c.id NOT IN (SubPlan 1).",
    ]);
  });

  it("says a step the run never needed never ran, and does not call its table empty", () => {
    const lines = words(neverNeeded());
    expect(lines).toEqual([
      "Reads all 100 rows of public.orders (o), and no row meets o.status = 'lost'.",
      "Did not need to read public.customers (c), so that part of the plan never ran.",
      "Pairs each row of public.orders (o) with the matching rows of public.customers (c), " +
        "giving no rows.",
    ]);
    expect(lines.join(" ")).not.toContain("empty");
  });

  it("calls a table empty only when the run read it and found nothing", () => {
    const lines = words({
      "Node Type": "Seq Scan",
      "Relation Name": "t",
      Schema: "public",
      Alias: "t",
      Filter: "(t.flag = true)",
      "Rows Removed by Filter": 0,
      "Plan Rows": 1,
      "Total Cost": 25,
      "Actual Total Time": 0.01,
      "Actual Rows": 0,
      "Actual Loops": 1,
    });
    // Not "no row meets t.flag = true": there were no rows to test.
    expect(lines).toEqual(["Reads public.t and finds it empty."]);
  });

  it("gives an estimated parallel scan's rows for one process, and says so", () => {
    // One helper and the main process: the planner gives each 1/1.7 of the
    // 300,000 rows, and that share is the scan's Plan Rows.
    const lines = words({
      "Node Type": "Gather",
      "Workers Planned": 1,
      "Plan Rows": 300000,
      "Total Cost": 5000,
      Plans: [
        {
          "Node Type": "Seq Scan",
          "Parent Relationship": "Outer",
          "Parallel Aware": true,
          "Relation Name": "orders",
          Schema: "public",
          Alias: "orders",
          "Plan Rows": 176471,
          "Total Cost": 3500,
        },
      ],
    });
    expect(lines).toEqual([
      "Reads the whole of public.orders, split between the processes, giving about " +
        "176,471 rows (in each process).",
      "Collects the rows from all the processes, giving about 300,000 rows.",
    ]);
  });

  it("says why an estimated parallel scan keeping a fifth of the table reads it whole", () => {
    // The share is of the 199,200 rows kept in all, not of one process's 83,000.
    const lines = words(readingsInParallel(83000), { tableRows: { "public.readings": 1000000 } });
    expect(lines[0]).toBe(
      "Reads the whole of public.readings, split between the processes, and keeps about " +
        "83,000 rows where readings.v < 200 (in each process); about 20% of its rows match, " +
        "too many for an index to help, so reading the whole table is the right plan."
    );
  });

  it("adds a measured parallel scan's processes up into one count", () => {
    // Measured, each process's rows are averaged per loop, so 250 is a third.
    expect(words(paidCountInParallel())[0]).toBe(
      "Reads all 300,000 rows of public.orders, split between the processes, and keeps the " +
        "750 where orders.status = 'paid'."
    );
  });

  it("gives no count, and no '(in each process)', for a parallel scan a LIMIT may stop", () => {
    const lines = words({
      "Node Type": "Limit",
      "Plan Rows": 10,
      "Total Cost": 12,
      Plans: [
        {
          "Node Type": "Gather",
          "Parent Relationship": "Outer",
          "Workers Planned": 2,
          "Plan Rows": 590,
          "Total Cost": 5000,
          Plans: [
            {
              "Node Type": "Seq Scan",
              "Parent Relationship": "Outer",
              "Parallel Aware": true,
              "Relation Name": "orders",
              Schema: "public",
              Alias: "orders",
              Filter: "(orders.status = 'paid'::text)",
              "Plan Rows": 246,
              "Total Cost": 3768,
            },
          ],
        },
      ],
    });
    expect(lines).toEqual([
      "Reads public.orders from the start until it has enough rows, split between the " +
        "processes, keeping those where orders.status = 'paid'.",
      "Stops after handing back about 10 rows.",
    ]);
  });

  it("does not quote a full lookup's count for a NOT EXISTS that stops at the first match", () => {
    const lines = words(customersWithoutOrders());
    expect(lines[1]).toBe(
      "Looks up the rows of public.orders (o) where o.customer_id = c.id in the index " +
        "orders_customer_idx alone, without reading the table, stopping at the first match " +
        "(each time; expected to run about 5,000 times)."
    );
    expect(lines.join(" ")).not.toContain("giving about 60 rows");
  });

  describe("why reading the whole table is the right plan", () => {
    /** A read of all of public.orders that keeps the paid ones. */
    function paidOrders(planRows: number): Record<string, unknown> {
      return {
        "Node Type": "Seq Scan",
        "Relation Name": "orders",
        Schema: "public",
        Alias: "orders",
        Filter: "(status = 'paid'::text)",
        "Plan Rows": planRows,
        "Total Cost": 18000,
      };
    }
    const millionRows: Partial<PlanCatalog> = { tableRows: { "public.orders": 1000000 } };

    it("says an index would not help when most of the table matches", () => {
      expect(words(paidOrders(800000), millionRows)).toEqual([
        "Reads the whole of public.orders, about 1 million rows, and keeps about 800,000 rows " +
          "where status = 'paid'; most of its rows match (about 80%), so an index would not " +
          "help and reading the whole table is the right plan.",
      ]);
      // And no finding on the Suggestions tab says otherwise.
      expect(summaryOf(paidOrders(800000), millionRows).findings).toEqual([]);
    });

    it("says too many rows match for an index when half of it does", () => {
      expect(words(paidOrders(500000), millionRows)[0]).toContain(
        "; about 50% of its rows match, too many for an index to help, so reading the whole " +
          "table is the right plan."
      );
    });

    it("gives no reason for a small table, or for a filter an index would serve", () => {
      const small = words(paidOrders(4000), { tableRows: { "public.orders": 5000 } });
      expect(small.join(" ")).not.toContain("the right plan");
      // 5% of a million rows: the seq-scan finding offers an index, and the
      // words must not say the opposite.
      const selective = summaryOf(paidOrders(50000), millionRows);
      expect(hasRule(selective.findings, "seq-scan")).toBe(true);
      expect(explainInWords(selective).join(" ")).not.toContain("the right plan");
    });
  });
});

describe("stepFigures", () => {
  it("marks an estimate as one, and says how often a repeated step is expected to run", () => {
    const steps = summaryOf(customersThenOrders()).steps;
    expect(stepFigures(steps[0], false)).toEqual({ rows: "~100 rows (estimate)", runs: null });
    expect(stepFigures(steps[2], false)).toEqual({
      rows: "~1 row each time (estimate)",
      runs: "runs ~100 times (estimate)",
    });
  });

  it("gives a measured repeated step's rows for one run, and how often it ran", () => {
    const steps = summaryOf(customersThenOrdersRun()).steps;
    expect(stepFigures(steps[0], true)).toEqual({ rows: "6,000 rows", runs: null });
    expect(stepFigures(steps[2], true)).toEqual({ rows: "60 rows each time", runs: "ran 100 times" });
  });

  it("says a step the run never needed never ran, rather than that it found nothing", () => {
    const steps = summaryOf(neverNeeded()).steps;
    expect(stepFigures(steps[2], true)).toEqual({ rows: "never ran", runs: null });
  });

  it("gives a step every process ran its own count for one process, and how many there were", () => {
    const steps = summaryOf(paidCountInParallel()).steps;
    expect(stepFigures(steps[2], true)).toEqual({ rows: "1 row per process", runs: "in 3 processes" });
    // The parallel scan split the table between them, so its count is the total.
    expect(stepFigures(steps[3], true)).toEqual({ rows: "750 rows", runs: null });
  });
});

/**
 * The shape PostgreSQL 17 ran for `SELECT c.name, o.total FROM customers c
 * JOIN orders o ON o.customer_id = c.id WHERE c.id < 20` with hash and merge
 * joins off: two processes share the read of orders and look each order's
 * customer up through a Memoize. Below the Gather, loops count both things:
 * the Nested Loop's 2 are the processes, the Memoize's 200,000 are lookups
 * and the Index Scan's 40,000 are the lookups the cache missed. Nearly every
 * lookup finds no customer, so both average under half a row, shown as 0,
 * though 190 rows came out in all.
 */
function ordersToCustomersInParallel(measured: boolean): Record<string, unknown> {
  const run = (rows: number, loops: number) =>
    measured ? { "Actual Total Time": 1, "Actual Rows": rows, "Actual Loops": loops } : {};
  return {
    "Node Type": "Gather",
    "Workers Planned": 1,
    ...(measured ? { "Workers Launched": 1 } : {}),
    "Plan Rows": 190,
    "Total Cost": 5000,
    ...run(190, 1),
    Plans: [
      {
        "Node Type": "Nested Loop",
        "Parent Relationship": "Outer",
        "Join Type": "Inner",
        "Plan Rows": 112,
        "Total Cost": 4900,
        ...run(95, 2),
        Plans: [
          {
            "Node Type": "Seq Scan",
            "Parent Relationship": "Outer",
            "Parallel Aware": true,
            "Relation Name": "orders",
            Schema: "shop",
            Alias: "o",
            "Plan Rows": 117647,
            "Total Cost": 3000,
            ...run(100000, 2),
          },
          {
            "Node Type": "Memoize",
            "Parent Relationship": "Inner",
            "Cache Key": "o.customer_id",
            "Plan Rows": 1,
            "Total Cost": 0.3,
            ...run(0, 200000),
            Plans: [
              {
                "Node Type": "Index Scan",
                "Parent Relationship": "Outer",
                "Index Name": "customers_pkey",
                "Relation Name": "customers",
                Schema: "shop",
                Alias: "c",
                "Index Cond": "((c.id = o.customer_id) AND (c.id < 20))",
                "Plan Rows": 1,
                "Total Cost": 0.29,
                ...run(0, 40000),
              },
            ],
          },
        ],
      },
    ],
  };
}

/**
 * A run of a one-row lookup by an unindexed column, split between three
 * processes: the one that found the row averages to 0 with the two that did
 * not, so the scan shows 0 rows while the Gather above it collected 1.
 */
function oneCustomerByEmailInParallel(): Record<string, unknown> {
  return {
    "Node Type": "Gather",
    "Workers Planned": 2,
    "Workers Launched": 2,
    "Plan Rows": 1,
    "Total Cost": 12000,
    "Actual Total Time": 40,
    "Actual Rows": 1,
    "Actual Loops": 1,
    Plans: [
      {
        "Node Type": "Seq Scan",
        "Parent Relationship": "Outer",
        "Parallel Aware": true,
        "Relation Name": "customers",
        Schema: "shop",
        Alias: "customers",
        Filter: "((customers.email)::text = 'ann@example.com'::text)",
        "Rows Removed by Filter": 333333,
        "Plan Rows": 1,
        "Total Cost": 11000,
        "Actual Total Time": 39,
        "Actual Rows": 0,
        "Actual Loops": 3,
      },
    ],
  };
}

describe("counts below a Gather", () => {
  it("tells a lookup repeated in a parallel section from the processes that ran it", () => {
    const summary = summaryOf(ordersToCustomersInParallel(true));
    const [, loop, scan, memoize, lookup] = summary.steps;
    expect(stepFigures(loop, true)).toEqual({ rows: "95 rows per process", runs: "in 2 processes" });
    expect(stepFigures(scan, true)).toEqual({ rows: "200,000 rows", runs: null });
    // Not "in 200,000 processes": there were two.
    expect(stepFigures(memoize, true)).toEqual({ rows: "under 1 row each time", runs: "ran 200,000 times" });
    expect(stepFigures(lookup, true)).toEqual({ rows: "under 1 row each time", runs: "ran 40,000 times" });
  });

  it("never says a lookup found no rows when its average was only rounded to 0", () => {
    const words = explainInWords(summaryOf(ordersToCustomersInParallel(true)));
    expect(words.join(" ")).toContain(
      "customers_pkey, giving fewer than one row on average (each time; it ran 40,000 times)."
    );
    expect(words.join(" ")).not.toContain("no rows");
    // The Nested Loop's 2 loops are the processes, so its count is per process.
    expect(words.join(" ")).toContain("giving 95 rows (in each process).");
  });

  it("gives an estimated lookup below a Memoize for one run, without a run count it cannot know", () => {
    const summary = summaryOf(ordersToCustomersInParallel(false));
    expect(stepFigures(summary.steps[3], false)).toEqual({ rows: "~1 row each time (estimate)", runs: null });
    expect(stepFigures(summary.steps[4], false)).toEqual({ rows: "~1 row each time (estimate)", runs: null });
    expect(explainInWords(summary).join(" ")).toContain(
      "customers_pkey, giving about 1 row (each time it runs)."
    );
  });

  it("gives a parallel scan whose average was rounded to 0 an upper bound, not 'no rows'", () => {
    const summary = summaryOf(oneCustomerByEmailInParallel());
    expect(stepFigures(summary.steps[1], true)).toEqual({ rows: "at most 1 row", runs: null });
    const words = explainInWords(summary).join(" ");
    expect(words).toContain("split between the processes, and keeps at most 1 row where");
    expect(words).not.toContain("no row meets");
    // The whole-table finding still stands: it read about a million rows for one.
    expect(hasRule(summary.findings, "seq-scan")).toBe(true);
  });
});

/**
 * A measured read of every customer whose filter is `filter`, with the
 * subquery it refers to (`relationship` "SubPlan" or "InitPlan") below it.
 * No customer passes the filter.
 */
function customersFilteredBy(filter: string, relationship: string, name: string): Record<string, unknown> {
  return {
    "Node Type": "Seq Scan",
    "Relation Name": "customers",
    Schema: "shop",
    Alias: "customers",
    Filter: filter,
    "Rows Removed by Filter": 20000,
    "Plan Rows": 10000,
    "Total Cost": 4000,
    "Actual Total Time": 20,
    "Actual Rows": 0,
    "Actual Loops": 1,
    Plans: [
      {
        "Node Type": "Seq Scan",
        "Parent Relationship": relationship,
        "Subplan Name": name,
        "Relation Name": "orders",
        Schema: "shop",
        Alias: "orders",
        "Plan Rows": 200000,
        "Total Cost": 3000,
        "Actual Total Time": 10,
        "Actual Rows": 200000,
        "Actual Loops": 1,
      },
    ],
  };
}

describe("a whole-table read whose filter tests a subquery", () => {
  it("does not suggest an index for a NOT IN, which no index on the table can answer", () => {
    const summary = summaryOf(
      customersFilteredBy("(NOT (ANY (customers.id = (hashed SubPlan 1).col1)))", "SubPlan", "SubPlan 1")
    );
    expect(hasRule(summary.findings, "seq-scan")).toBe(false);
    expect(explainInWords(summary).join(" ")).not.toContain("index");
  });

  it("does not suggest one for a comparison with a subquery run for each row", () => {
    const summary = summaryOf(customersFilteredBy("((SubPlan 1) > 5)", "SubPlan", "SubPlan 1"));
    expect(hasRule(summary.findings, "seq-scan")).toBe(false);
  });

  it("still suggests an index for the ordinary condition beside the subquery test", () => {
    const summary = summaryOf(
      customersFilteredBy(
        // city is a text column, so the plan compares it without a cast.
        "((customers.city = 'Leeds'::text) AND (NOT (ANY (customers.id = (hashed SubPlan 1).col1))))",
        "SubPlan",
        "SubPlan 1"
      )
    );
    const finding = summary.findings.find((f) => f.id === "seq-scan:0");
    expect(finding?.title).toBe("Index the column city");
  });

  it("treats a comparison with an InitPlan's value as ordinary: it is known before the scan", () => {
    const summary = summaryOf(
      customersFilteredBy("(customers.id = (InitPlan 1).col1)", "InitPlan", "InitPlan 1")
    );
    expect(hasRule(summary.findings, "seq-scan")).toBe(true);
  });
});

describe("how often a subquery a filter tests is expected to run", () => {
  /**
   * "(SELECT count(*) FROM items i WHERE i.id = c.id)" as PostgreSQL 17 plans
   * it: one index lookup, 4.32 a run.
   */
  function itemCount(indexCond: string, name = "SubPlan 1", alias = "i"): Record<string, unknown> {
    return {
      "Node Type": "Aggregate",
      Strategy: "Plain",
      "Parent Relationship": "SubPlan",
      "Subplan Name": name,
      Output: ["count(*)"],
      "Plan Rows": 1,
      "Total Cost": 4.32,
      Plans: [
        {
          "Node Type": "Index Only Scan",
          "Parent Relationship": "Outer",
          "Relation Name": "items",
          Schema: "public",
          Alias: alias,
          "Index Name": "items_id_idx",
          "Index Cond": indexCond,
          Output: [`${alias}.id`],
          "Plan Rows": 1,
          "Total Cost": 4.3,
        },
      ],
    };
  }

  /**
   * Customers with no items: a whole-table read whose filter runs the count
   * for each of the 20,000 customers, of whom 100 pass. The Total Cost adds
   * up the way PostgreSQL's does: 20,000 counts at 4.32, and 309 for reading
   * the table. `extra` swaps parts of it, e.g. for another way in.
   */
  function customersWithoutItems(
    filter = "((SubPlan 1) = 0)",
    extra: Record<string, unknown> = {}
  ): Record<string, unknown> {
    return {
      "Node Type": "Seq Scan",
      "Relation Name": "customers",
      Schema: "public",
      Alias: "c",
      Output: ["c.id"],
      Filter: filter,
      "Plan Rows": 100,
      "Total Cost": 86709,
      Plans: [itemCount("(i.id = c.id)")],
      ...extra,
    };
  }

  /** The same, with a cheaper test first that can spare the count. */
  const MAY_SKIP = "((c.name <> 'x'::text) AND ((SubPlan 1) = 0))";

  /** The catalog's size of the customers table. */
  const CUSTOMERS: Partial<PlanCatalog> = { tableRows: { "public.customers": 20000 } };

  /** The top step of the subquery called `name`. */
  function subplanStep(summary: PlanSummary, name = "SubPlan 1") {
    const step = summary.steps.find((s) => s.subplanName === name);
    if (step === undefined) throw new Error(`The fixture has no ${name}.`);
    return step;
  }

  it("counts it for every row the filter reads, as the planner's cost does", () => {
    const summary = summaryOf(customersWithoutItems(), CUSTOMERS);
    const steps = summary.steps;
    expect(steps.map((s) => s.estimatedRuns)).toEqual([1, 20000, 20000]);
    // What is left of the read's 86,709 once the 20,000 counts are taken off.
    expect(Math.round(steps[0].selfCost)).toBe(309);
    // 20,000 lookups at 4.3 are 86,000, against 400 for counting and 309
    // for the table.
    expect(summary.heaviestStepId).toBe(2);
    expect(stepFigures(steps[1], false)).toEqual({
      rows: "~1 row each time (estimate)",
      runs: "runs ~20,000 times (estimate)",
    });
    expect(explainInWords(summary).join(" ")).toContain(
      "(each time; expected to run about 20,000 times)"
    );
  });

  it("gives no count when it cannot tell how many rows the filter reads", () => {
    // Without the table's size only the 100 rows that pass are known, though
    // the count runs for all 20,000 read. 100 stands in for the cost, but is
    // not shown as how often it runs.
    const summary = summaryOf(customersWithoutItems());
    const step = subplanStep(summary);
    expect(step.estimatedRuns).toBe(100);
    expect(step.runsKnown).toBe(false);
    expect(stepFigures(step, false).runs).toBeNull();
    const words = explainInWords(summary).join(" ");
    expect(words).toContain("(each time it runs)");
    expect(words).not.toContain("expected to run about");
  });

  it("still charges a filter that may skip the subquery for every row it reads", () => {
    // PostgreSQL may never run the count for a customer named x, but its
    // planner charges it for all 20,000 (86,759 is PostgreSQL 17's own
    // figure), so the lookups are still the heavy part.
    const summary = summaryOf(customersWithoutItems(MAY_SKIP, { "Total Cost": 86759 }), CUSTOMERS);
    expect(subplanStep(summary).estimatedRuns).toBe(20000);
    expect(summary.heaviestStepId).toBe(2);
    expect(subplanStep(summary).runsKnown).toBe(false);
  });

  it.each([
    {
      label: "a filter that may skip it",
      plan: customersWithoutItems(MAY_SKIP, { "Total Cost": 86759 }),
      runs: 20000,
    },
    {
      // An index scan reads only the rows its Index Cond finds (4,999 by
      // PostgreSQL's reckoning here), and the plan does not give that count.
      label: "a read through an index",
      plan: customersWithoutItems(undefined, {
        "Node Type": "Index Only Scan",
        "Index Name": "customers_pkey",
        "Index Cond": "(c.id < 5000)",
        "Plan Rows": 25,
        "Total Cost": 21743.45,
      }),
      runs: 25,
    },
    {
      // A join tests its Join Filter only on the pairs its Hash Cond makes,
      // which the plan does not count either.
      label: "a join filter",
      plan: {
        "Node Type": "Hash Join",
        "Join Type": "Inner",
        Output: ["c.id"],
        "Hash Cond": "(i.customer_id = c.id)",
        "Join Filter": "((SubPlan 1) = 0)",
        "Plan Rows": 100,
        "Total Cost": 899.24,
        Plans: [
          {
            "Node Type": "Seq Scan",
            "Parent Relationship": "Outer",
            "Relation Name": "items",
            Schema: "public",
            Alias: "i",
            Output: ["i.id", "i.customer_id"],
            "Plan Rows": 19900,
            "Total Cost": 288,
          },
          {
            "Node Type": "Hash",
            "Parent Relationship": "Inner",
            Output: ["c.id"],
            "Plan Rows": 20000,
            "Total Cost": 309,
            Plans: [
              {
                "Node Type": "Seq Scan",
                "Parent Relationship": "Outer",
                "Relation Name": "customers",
                Schema: "public",
                Alias: "c",
                Output: ["c.id"],
                "Plan Rows": 20000,
                "Total Cost": 309,
              },
            ],
          },
          itemCount("(j.id = (c.id + i.id))", "SubPlan 1", "j"),
        ],
      },
      runs: 100,
    },
    {
      // Inside sum(…) the count runs for each of the 20,000 rows read; one
      // outside it would run once for each of the 10 groups.
      label: "a subquery in an aggregate's output",
      plan: {
        "Node Type": "Aggregate",
        Strategy: "Hashed",
        "Group Key": ["(c.id % 10)"],
        Output: ["((c.id % 10))", "sum((SubPlan 1))"],
        "Plan Rows": 10,
        "Total Cost": 87109,
        Plans: [
          {
            "Node Type": "Seq Scan",
            "Parent Relationship": "Outer",
            "Relation Name": "customers",
            Schema: "public",
            Alias: "c",
            Output: ["(c.id % 10)", "c.id"],
            "Plan Rows": 20000,
            "Total Cost": 359,
          },
          itemCount("(i.id = c.id)"),
        ],
      },
      runs: 10,
    },
  ])("gives no count for $label", ({ plan, runs }) => {
    const step = subplanStep(summaryOf(plan, CUSTOMERS));
    expect(step.estimatedRuns).toBe(runs);
    expect(step.runsKnown).toBe(false);
    expect(stepFigures(step, false).runs).toBeNull();
  });

  it("counts it for every row a Subquery Scan reads: all its subquery hands up", () => {
    // "FROM (SELECT … ORDER BY … LIMIT 3000) s WHERE …": the filter runs on
    // the 3,000 rows the subquery hands up, and PostgreSQL 17's cost charges
    // the count 3,000 times.
    const summary = summaryOf(
      {
        "Node Type": "Subquery Scan",
        Alias: "s",
        Output: ["s.id"],
        Filter: "((SubPlan 1) = 0)",
        "Plan Rows": 15,
        "Total Cost": 14561.57,
        Plans: [
          {
            "Node Type": "Limit",
            "Parent Relationship": "Subquery",
            Output: ["customers.id", "customers.name"],
            "Plan Rows": 3000,
            "Total Cost": 1571.57,
            Plans: [
              {
                "Node Type": "Sort",
                "Parent Relationship": "Outer",
                Output: ["customers.id", "customers.name"],
                "Plan Rows": 20000,
                "Total Cost": 1614.07,
                Plans: [
                  {
                    "Node Type": "Seq Scan",
                    "Parent Relationship": "Outer",
                    "Relation Name": "customers",
                    Schema: "public",
                    Alias: "customers",
                    Output: ["customers.id", "customers.name"],
                    "Plan Rows": 20000,
                    "Total Cost": 309,
                  },
                ],
              },
            ],
          },
          itemCount("(i.id = s.id)"),
        ],
      },
      CUSTOMERS
    );
    expect(subplanStep(summary).estimatedRuns).toBe(3000);
    expect(subplanStep(summary).runsKnown).toBe(true);
  });

  it("counts it for every row a bitmap read finds, catalog or not", () => {
    // PostgreSQL 17 charges the count 4,999 times here: once for each
    // customer the bitmap found, before the filter keeps 25.
    const plan = customersWithoutItems(undefined, {
      "Node Type": "Bitmap Heap Scan",
      "Recheck Cond": "(c.id < 5000)",
      "Plan Rows": 25,
      "Total Cost": 21878.7,
      Plans: [
        {
          "Node Type": "Bitmap Index Scan",
          "Parent Relationship": "Outer",
          "Index Name": "customers_pkey",
          "Index Cond": "(c.id < 5000)",
          "Plan Rows": 4999,
          "Total Cost": 97.78,
        },
        itemCount("(i.id = c.id)"),
      ],
    });
    for (const catalog of [CUSTOMERS, {}]) {
      const step = subplanStep(summaryOf(plan, catalog));
      expect(step.estimatedRuns).toBe(4999);
      expect(step.runsKnown).toBe(true);
      expect(stepFigures(step, false).runs).toBe("runs ~4,999 times (estimate)");
    }
  });

  it("runs a subquery with a Materialize on top once, and reads its rows again", () => {
    // "c.id > ALL (SELECT id FROM items WHERE id < 100)" does not use the
    // customer, so PostgreSQL 17 fills a Materialize once and reads it again
    // for each customer. Its cost charges the index read once.
    const summary = summaryOf(
      {
        "Node Type": "Seq Scan",
        "Relation Name": "customers",
        Schema: "public",
        Alias: "c",
        Output: ["c.id"],
        Filter: "(ALL (c.id > (SubPlan 1).col1))",
        "Plan Rows": 10000,
        "Total Cost": 65109.29,
        Plans: [
          {
            "Node Type": "Materialize",
            "Parent Relationship": "SubPlan",
            "Subplan Name": "SubPlan 1",
            Output: ["i.id"],
            "Plan Rows": 99,
            "Total Cost": 6.51,
            Plans: [
              {
                "Node Type": "Index Only Scan",
                "Parent Relationship": "Outer",
                "Relation Name": "items",
                Schema: "public",
                Alias: "i",
                "Index Name": "items_id_idx",
                "Index Cond": "(i.id < 100)",
                Output: ["i.id"],
                "Plan Rows": 99,
                "Total Cost": 6.02,
              },
            ],
          },
        ],
      },
      CUSTOMERS
    );
    const steps = summary.steps;
    expect(steps.map((s) => s.estimatedRuns)).toEqual([1, 1, 1]);
    expect(steps.map((s) => s.repeated)).toEqual([false, true, false]);
    // Reading the kept rows again, for each customer, is in the scan's own cost.
    expect(steps[0].selfCost).toBeCloseTo(65102.78, 2);
    expect(steps[1].selfCost).toBeCloseTo(0.49, 2);
    expect(steps[2].selfCost).toBeCloseTo(6.02, 2);
    expect(summary.heaviestStepId).toBe(0);
    expect(subqueryCaption(steps[1])).toBe("SubPlan 1: runs once, then read again for each row");
    const words = explainInWords(summary).join(" ");
    expect(words).toContain("SubPlan 1, which runs only once");
    expect(words).toContain("so they can be read again for each row of public.customers (c)");
    expect(words).not.toContain("runs once for each row");
  });

  it("tells a subquery the filter tests from one only the output uses", () => {
    // PostgreSQL numbers the output's subquery first. It runs for the 100
    // customers that pass, the filter's for all 20,000 read: 309 for the
    // table, and 20,100 counts at 4.32.
    const summary = summaryOf(
      customersWithoutItems("((SubPlan 2) = 0)", {
        Output: ["c.id", "(SubPlan 1)"],
        "Total Cost": 87141,
        Plans: [itemCount("(i.id = c.id)", "SubPlan 1"), itemCount("(i_1.id = c.id)", "SubPlan 2", "i_1")],
      }),
      CUSTOMERS
    );
    expect(subplanStep(summary, "SubPlan 1").estimatedRuns).toBe(100);
    expect(subplanStep(summary, "SubPlan 1").runsKnown).toBe(true);
    expect(subplanStep(summary, "SubPlan 2").estimatedRuns).toBe(20000);
    expect(subplanStep(summary, "SubPlan 2").runsKnown).toBe(true);
    expect(Math.round(summary.steps[0].selfCost)).toBe(309);
  });

  it("counts it for each process's share of a parallel read", () => {
    // PostgreSQL 17's plan for "c.id > ALL (SELECT g FROM generate_series(1,
    // 100) g)" read in parallel: two helpers and the leader split the 20,000
    // customers, so each is expected to read 20,000 / 2.4.
    const scan = {
      "Node Type": "Seq Scan",
      "Parent Relationship": "Outer",
      "Parallel Aware": true,
      "Relation Name": "customers",
      Schema: "public",
      Alias: "c",
      Output: ["c.id"],
      Filter: "(ALL (c.id > (SubPlan 1).col1))",
      "Plan Rows": 4167,
      "Total Cost": 5421.5,
      Plans: [
        {
          "Node Type": "Function Scan",
          "Parent Relationship": "SubPlan",
          "Subplan Name": "SubPlan 1",
          "Function Name": "generate_series",
          Schema: "pg_catalog",
          Alias: "g",
          Output: ["g.g"],
          "Function Call": "generate_series(1, 100)",
          "Plan Rows": 100,
          "Total Cost": 1,
        },
      ],
    };
    const gather = {
      "Node Type": "Gather",
      "Workers Planned": 2,
      Output: ["c.id"],
      "Plan Rows": 10000,
      "Total Cost": 5421.5,
      Plans: [scan],
    };
    const summary = summaryOf(gather, CUSTOMERS);
    const step = subplanStep(summary);
    expect(step.estimatedRuns).toBeCloseTo(8333.33, 1);
    expect(step.runsKnown).toBe(true);
    expect(stepFigures(step, false).runs).toBe("runs ~8,333 times (estimate)");
    expect(explainInWords(summary).join(" ")).toContain(
      "(each time; expected to run about 8,333 times in each process)"
    );
    // Without the table's size, only the rows each process keeps are known.
    const unknown = subplanStep(summaryOf(gather));
    expect(unknown.estimatedRuns).toBe(4167);
    expect(unknown.runsKnown).toBe(false);
  });
});

describe("subqueryCaption", () => {
  it("says when each kind of subquery runs, over its top box only", () => {
    const init = summaryOf(aboveAverage()).steps;
    expect(subqueryCaption(init[0])).toBeNull();
    expect(subqueryCaption(init[1])).toBe("InitPlan 1: runs only once");
    expect(subqueryCaption(init[2])).toBeNull();
    expect(subqueryCaption(summaryOf(largestPayment()).steps[1])).toBe(
      "SubPlan 1: runs once for each row"
    );
    expect(subqueryCaption(summaryOf(notBlocked()).steps[1])).toBe(
      "SubPlan 1: runs once, kept as a lookup table"
    );
  });

  it("names a WITH query by its own name", () => {
    const summary = summaryOf(recentOrders());
    expect(subqueryCaption(summary.steps[1])).toBe("WITH query recent: worked out once, then kept");
    expect(explainInWords(summary)[0]).toMatch(
      /^The WITH query recent, worked out once and kept for the steps that read it: reads the whole of public\.orders/
    );
  });

  it("does not say 'only once' of an InitPlan the run repeated", () => {
    // An InitPlan inside a SubPlan runs again whenever the outer value it
    // uses changes: here, once for each of three customers.
    const summary = summaryOf({
      "Node Type": "Seq Scan",
      "Relation Name": "customers",
      Schema: "public",
      Alias: "c",
      Output: ["c.id", "(SubPlan 1)"],
      "Plan Rows": 3,
      "Total Cost": 40,
      "Actual Total Time": 0.2,
      "Actual Rows": 3,
      "Actual Loops": 1,
      Plans: [
        {
          "Node Type": "Result",
          "Parent Relationship": "SubPlan",
          "Subplan Name": "SubPlan 1",
          Output: ["(InitPlan 2).col1"],
          "Plan Rows": 1,
          "Total Cost": 8.3,
          "Actual Total Time": 0.03,
          "Actual Rows": 1,
          "Actual Loops": 3,
          Plans: [
            {
              "Node Type": "Aggregate",
              Strategy: "Plain",
              "Parent Relationship": "InitPlan",
              "Subplan Name": "InitPlan 2",
              Output: ["max(p.amount)"],
              "Plan Rows": 1,
              "Total Cost": 8.3,
              "Actual Total Time": 0.02,
              "Actual Rows": 1,
              "Actual Loops": 3,
              Plans: [
                {
                  "Node Type": "Index Scan",
                  "Parent Relationship": "Outer",
                  "Relation Name": "payments",
                  Schema: "public",
                  Alias: "p",
                  "Index Name": "payments_customer_idx",
                  "Index Cond": "(p.customer_id = c.id)",
                  "Plan Rows": 5,
                  "Total Cost": 8.29,
                  "Actual Total Time": 0.01,
                  "Actual Rows": 5,
                  "Actual Loops": 3,
                },
              ],
            },
          ],
        },
      ],
    });
    expect(subqueryCaption(summary.steps[2])).toBe("InitPlan 2: ran 3 times");
    const lines = explainInWords(summary);
    expect(lines.some((line) => line.startsWith("InitPlan 2, which ran 3 times: "))).toBe(true);
    expect(lines.join(" ")).not.toContain("only once");
  });
});

// ── Every fix the tests above produced ───────────────────────────────────────

describe("every finding's fix", () => {
  // Defined last, so these run after every other test in this file and see
  // every finding they produced (readPlan and readSql above collect them).
  // Run the whole file: filtered with -t, they see only what ran.

  it("keeps the promise its kind makes", () => {
    expect(collected.length).toBeGreaterThan(100);
    expect(allFixProblems(collected)).toEqual([]);
  });

  it("gives each rule only the kinds of fix it is meant to have", () => {
    // The kind tells the reader what pasting the fix does, so a rule whose
    // fix changes kind has changed that promise, and should do it on purpose.
    // Keyed by the part of the id before the first colon.
    const expected: Record<string, FixKind[]> = {
      "comma-join": ["query"],
      "deep-offset": ["query"],
      "estimate-off": ["decision", "maintenance"],
      "function-on-column": ["change", "query"],
      "heap-fetches": ["decision", "maintenance"],
      "join-key": ["change", "maintenance"],
      "leading-wildcard": ["decision"],
      "lossy-bitmap": ["decision"],
      "many-joins": ["decision"],
      "missing-where": ["query"],
      "nested-loop": ["change"],
      "not-in-subquery": ["query"],
      "order-by-no-limit": ["query"],
      "select-star": ["query"],
      "seq-scan": ["change", "decision", "maintenance"],
      "sort-on-disk": ["decision"],
      "unfiltered-count": ["query"],
      "unnecessary-distinct": ["query"],
      "wasteful-filter": ["decision"],
    };
    const seen: Record<string, FixKind[]> = {};
    for (const finding of collected) {
      const rule = finding.id.split(":")[0];
      const kinds = new Set([...(seen[rule] ?? []), finding.fixKind]);
      seen[rule] = [...kinds].sort();
    }
    expect(seen).toEqual(expected);
  });
});
