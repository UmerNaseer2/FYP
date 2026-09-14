// Spec feature 08 — query execution analysis.
//
// Dependency-free on purpose, like lib/sql-guard.ts and lib/perf-advice.ts:
// nothing here opens a connection, so the whole module runs in a test, in a
// route handler, and in the browser. The route next door is the only thing
// that talks to a database; it hands the EXPLAIN output in here as plain JSON
// and gets a summary back.
//
// Three parts, kept apart because they answer different questions:
//
//   • The gate     checkAnalysable(), checkPlanIsReadOnly() and friends decide
//                  whether a query may be analysed at all. Only queries that
//                  read data get through, and the route asks these BEFORE it
//                  runs anything for real.
//   • readPlan()   reads what THIS server would actually do with THIS query
//                  against the data it has right now. Correct, and perishable.
//   • readSql()    reads the query text alone. Weaker, but it holds regardless
//                  of what is in the tables, and it still says something when
//                  the database cannot be reached at all.

import { containsTransactionControl, maskNonCode, splitStatements } from "./sql-guard";
import {
  LARGE_TABLE_ROWS,
  createExpressionIndexSql,
  createIndexSql,
  indexName,
  qualifiedName,
  quoteIdent,
  type FixKind,
  type IndexStatement,
} from "./perf-sql";

export type Severity = "high" | "medium" | "low";

// FixKind is defined once, in lib/perf-sql.ts, because the Suggestions tab
// uses it too. Re-exported so existing imports from this file keep working.
export type { FixKind };

/** One finding, whichever half produced it. Same shape as PerfAdvice by design. */
export type QueryFinding = {
  id: string;
  severity: Severity;
  title: string;
  /** What it is about — a table, a plan step, or the statement itself. */
  object: string;
  detail: string;
  /**
   * What to do: SQL to paste, or comment lines setting out a choice. Never
   * empty; tests/helpers/fix-invariants.ts checks every rule for that.
   */
  fix: string;
  /**
   * What kind of fix `fix` is: the card's header says it in words ("Schema
   * change", "Maintenance", …) so nobody runs a fix without knowing what it
   * does. Required, so a new rule cannot leave its fix unlabelled.
   */
  fixKind: FixKind;
  /** For a `change`: the statement that takes it back out, e.g. DROP INDEX. */
  undo?: string;
  /**
   * The plan step this finding is about (a PlanStep id), or null when it came
   * from reading the query text. Required rather than optional so a new rule
   * cannot forget to say: the plan tree counts findings per step with it, and
   * the finding card prints "Step N" so the reader can find the box.
   */
  stepId: number | null;
};

// ── Part one: the gate ───────────────────────────────────────────────────────

/**
 * The longest query this screen accepts, in characters.
 *
 * Far longer than any hand-written query, so nobody meets it by accident. It is
 * there so a pasted log file or data dump is refused with a sentence instead
 * of being shipped to a database server whole.
 */
export const MAX_QUERY_LENGTH = 50_000;

/**
 * How long a query may run before the server is told to stop it.
 *
 * Generous enough that a genuinely slow query still produces the measurement
 * that proves it is slow (the whole point of asking) and short enough that a
 * runaway one gives the connection back. Kept here, not in the route, so the
 * screen's copy ("stopped after 15 seconds") and the route's SET LOCAL can
 * never disagree.
 */
export const QUERY_TIMEOUT_SECONDS = 15;

/**
 * The words a query that only reads data can start with.
 *
 * SELECT and WITH are the everyday ones. VALUES and TABLE are rarer, but they
 * are complete read queries on their own (`TABLE orders` means
 * `SELECT * FROM orders`). A WITH block that hides a DELETE also starts with
 * WITH, which is why the plan is checked as well (checkPlanIsReadOnly).
 */
const READ_QUERY_STARTS: ReadonlySet<string> = new Set(["SELECT", "WITH", "VALUES", "TABLE"]);

/**
 * Functions that act on the server itself rather than read data.
 *
 * Every one of these was checked to run inside BEGIN READ ONLY: a read-only
 * transaction stops writes to tables, and nothing else. Ending other sessions,
 * reloading the configuration or writing files still happens, and a
 * session-level advisory lock even survives the ROLLBACK and goes back to the
 * connection pool still held. So measured mode, which really runs the query,
 * refuses them by name.
 *
 * This is a list of known cases, not a guarantee. A user-defined function that
 * calls one of these internally is invisible from here, which is why the
 * screen's copy says the database user's permissions are the real limit.
 * The replication-slot functions are listed as a precaution; they were not run
 * to check, because running them would itself change the server.
 */
const DENIED_FUNCTIONS: ReadonlySet<string> = new Set([
  "pg_terminate_backend",
  "pg_cancel_backend",
  "pg_reload_conf",
  "pg_rotate_logfile",
  "pg_switch_wal",
  "pg_create_restore_point",
  "pg_promote",
  "lo_import",
  "lo_export",
  "pg_file_write",
  "pg_create_physical_replication_slot",
  "pg_create_logical_replication_slot",
  "pg_drop_replication_slot",
  "pg_copy_physical_replication_slot",
  "pg_copy_logical_replication_slot",
  "pg_replication_slot_advance",
  "pg_logical_slot_get_changes",
  "pg_logical_slot_get_binary_changes",
]);

/**
 * Whole families refused by the start of their name: every advisory-lock
 * function (pg_advisory_lock, pg_advisory_xact_lock, pg_try_advisory_lock, …),
 * every dblink function (they open a second connection that READ ONLY does not
 * cover), and every pg_stat_reset* (they wipe the counters the Suggestions tab
 * reads).
 */
const DENIED_PREFIXES: readonly string[] = [
  "pg_advisory_",
  "pg_try_advisory_",
  "dblink",
  "pg_stat_reset",
];

/**
 * The first denied function called anywhere in `text`, lower-cased, or null.
 *
 * Matches a name followed by an opening bracket, so a column that happens to
 * be called `dblink_url` is not mistaken for a call. Callers pass either the
 * masked query (so a name inside a string literal or a comment never counts)
 * or a line of the plan (where PostgreSQL has already written every call out).
 */
function deniedFunctionIn(text: string): string | null {
  const call = /\b([A-Za-z_][A-Za-z0-9_$]*)\s*\(/g;
  let match = call.exec(text);
  while (match !== null) {
    const name = match[1].toLowerCase();
    if (DENIED_FUNCTIONS.has(name) || DENIED_PREFIXES.some((p) => name.startsWith(p))) {
      return name;
    }
    match = call.exec(text);
  }
  return null;
}

/** The refusal for a denied call, worded for someone who is not a DBA. */
function deniedMessage(name: string, foundIn: "query" | "plan"): string {
  const where =
    foundIn === "query"
      ? `This query calls ${name}()`
      : `This query ends up calling ${name}() (the plan shows it, for example inside a view the query reads)`;
  return (
    `${where}, which acts on the server itself rather than reading data. A ` +
    `read-only transaction does not stop that, so it cannot be measured here. ` +
    `Untick Run it and measure to see the plan without running the query.`
  );
}

/**
 * Decide whether a query may be sent to the server at all.
 *
 * Returns a sentence for the user, or null when the query can go ahead. Pure
 * and run before any connection is opened, so a refusal costs nothing and the
 * target server never sees the text.
 *
 * The checks run in order and the first one that fails wins, so a query with
 * two problems is told about the most basic one first.
 */
export function checkAnalysable(sql: string, measure: boolean): string | null {
  if (!sql.trim()) return "Enter a query to analyse.";

  if (sql.length > MAX_QUERY_LENGTH) {
    return (
      `This text is ${fmtRows(sql.length)} characters long, and this screen accepts ` +
      `up to ${fmtRows(MAX_QUERY_LENGTH)}. Paste only the one query you want analysed.`
    );
  }

  // splitStatements keeps a chunk that is nothing but a comment, because its
  // other callers need the statement text exactly as written. Here the question
  // is how many statements PostgreSQL would RUN, and a trailing "-- note" is
  // not one of them — counting it would refuse an ordinary annotated query.
  const statements = splitStatements(sql).filter(
    (statement) => maskNonCode(statement).trim().length > 0
  );
  if (statements.length === 0) {
    return "There is no SQL here, only comments. Paste the query you want analysed.";
  }
  if (statements.length > 1) {
    return (
      `This analyses one query at a time, and there are ${statements.length} here. ` +
      `Remove the extra statements, or the semicolons between them.`
    );
  }
  if (containsTransactionControl(sql)) {
    return (
      "Remove the COMMIT / ROLLBACK. The plan is taken inside a transaction " +
      "that is always rolled back, and ending it early would defeat that."
    );
  }

  // The mask has comments, string literals and quoted names blanked out, so
  // the first word found here is the first word PostgreSQL would read. Opening
  // brackets are skipped so `(SELECT …) UNION (SELECT …)` counts as a SELECT.
  const mask = maskNonCode(sql);
  const first = /^[\s(]*([A-Za-z_]+)/.exec(mask);
  const word = first ? first[1].toUpperCase() : "";

  // Refused rather than stripped: honouring a pasted EXPLAIN ANALYZE would
  // run the query without the Measure tick-box and its editor-only check, and
  // quietly dropping the options would answer a different question.
  if (word === "EXPLAIN") {
    return (
      "Paste the query without EXPLAIN. This screen adds it; tick Run it and " +
      "measure for EXPLAIN ANALYZE."
    );
  }
  if (!READ_QUERY_STARTS.has(word)) {
    return (
      `Only queries that read data can be analysed here. This one starts with ` +
      `${word || "something other than a keyword"}. Paste a query that starts ` +
      `with SELECT, WITH, VALUES or TABLE.`
    );
  }

  // SELECT … INTO new_table is CREATE TABLE AS in disguise. INTO only ever
  // appears at the top level of a read query in that form, so an INTO outside
  // every bracket is the tell. (An INSERT INTO inside a WITH block sits inside
  // brackets, and the plan check below catches that one.)
  const topLevelInto = codeMatches(mask, /\bINTO\b/i).some(
    (m) => parenDepthAt(mask, m.index) === 0
  );
  if (topLevelInto) {
    return (
      "SELECT … INTO creates a new table from the result, so it changes the " +
      "database. Remove the INTO clause to analyse the query that reads the data."
    );
  }

  // Only measured mode runs the query, so only measured mode needs to worry
  // about what a called function does. A plain EXPLAIN of pg_terminate_backend
  // is harmless: nothing is executed.
  if (measure) {
    const denied = deniedFunctionIn(mask);
    if (denied) return deniedMessage(denied, "query");
  }

  return null;
}

/**
 * Refuse a plan that writes or locks, whatever the query text looked like.
 *
 * The text check above stops UPDATE and friends at the door, but two kinds of
 * write start with an innocent word:
 *
 *   • `WITH gone AS (DELETE FROM orders RETURNING *) SELECT …` starts with
 *     WITH, and its plan carries a ModifyTable step.
 *   • `SELECT … FOR UPDATE` starts with SELECT, and its plan carries a
 *     LockRows step. Row locks make other sessions wait, which is not
 *     something an analysis screen should do to a live server.
 *
 * The plan is the authority here: PostgreSQL has already worked out exactly
 * what the statement does. Applies in both modes, and the route asks it after
 * the plain EXPLAIN and before anything is run for real.
 */
export function checkPlanIsReadOnly(steps: PlanStep[]): string | null {
  const write = steps.find((s) => s.nodeType === "ModifyTable");
  if (write) {
    // labelOf puts the verb first for a ModifyTable step: "Delete on orders".
    const verb = /^(Insert|Update|Delete|Merge)\b/i.exec(write.label);
    // "an INSERT" and "an UPDATE", but "a DELETE" and "a MERGE".
    const action = verb
      ? `${/^[IU]/i.test(verb[1]) ? "an" : "a"} ${verb[1].toUpperCase()}`
      : "a write";
    const table =
      write.relation === null
        ? "a table"
        : write.relationSchema === null
          ? write.relation
          : `${write.relationSchema}.${write.relation}`;
    return (
      `This query changes data: part of it runs ${action} on ${table} ` +
      `(for example inside a WITH block). Only queries that read data can be ` +
      `analysed here. Remove the part that changes data and try again.`
    );
  }
  if (steps.some((s) => s.nodeType === "LockRows")) {
    return (
      "This query locks the rows it reads (FOR UPDATE or FOR SHARE), which makes " +
      "other sessions wait for it. Only queries that read data can be analysed " +
      "here. Remove the FOR UPDATE / FOR SHARE clause and try again."
    );
  }
  return null;
}

/**
 * The denied-function check again, this time against the plan.
 *
 * The query text only shows what was typed, and the text check skips a quoted
 * name (`"pg_terminate_backend"(1)`) along with every other quoted thing. The
 * plan writes each call out plainly, schema and quotes resolved. A view is expanded in the plan, so
 * `SELECT * FROM innocent_looking_view` that wraps pg_cancel_backend shows the
 * call here and nowhere else. VERBOSE writes every expression out in full, in
 * each step's Output, Filter and condition lines. Measured mode only, for the
 * same reason as the text check.
 */
export function planMentionsDenied(steps: PlanStep[]): string | null {
  for (const step of steps) {
    const lines = [step.output, step.filter ?? "", step.joinCond ?? "", ...step.details];
    for (const line of lines) {
      // Plan lines are SQL expressions, so the same mask applies: a name
      // inside a string literal ('pg_terminate_backend(1)') is data, not a call.
      const denied = deniedFunctionIn(maskNonCode(line));
      if (denied) return deniedMessage(denied, "plan");
    }
  }
  return null;
}

/**
 * The EXPLAIN in front of the user's query.
 *
 * VERBOSE is what makes PostgreSQL name each table's schema and alias and write
 * each step's output columns out; the rules below and the plan checks above
 * depend on all three. Exported on its own because an error's position counts
 * characters from the start of the whole text sent, and turning that into a
 * line and column in the user's query means subtracting this prefix.
 */
export function explainPrefix(measure: boolean): string {
  return measure
    ? "EXPLAIN (ANALYZE, VERBOSE, COSTS, TIMING, FORMAT JSON) "
    : "EXPLAIN (VERBOSE, COSTS, FORMAT JSON) ";
}

/** The full statement the route sends: the prefix above, then the query as typed. */
export function buildExplainSql(sql: string, measure: boolean): string {
  return explainPrefix(measure) + sql;
}

/**
 * The parts of a PostgreSQL error this module reads.
 *
 * node-pg's DatabaseError carries all four; a network error carries only a
 * message (and a Node.js code such as ECONNRESET, which matches no SQLSTATE
 * below and so falls through to the general sentence).
 */
export type QueryError = {
  /** The five-character SQLSTATE, e.g. "42P01". */
  code?: string;
  message: string;
  /** 1-based character position in the text sent. node-pg gives a string. */
  position?: string | number;
  hint?: string;
};

/** Pull the fields above out of whatever a query threw. */
export function toQueryError(error: unknown): QueryError {
  if (error instanceof Error) {
    const e = error as Error & { code?: unknown; position?: unknown; hint?: unknown };
    return {
      code: typeof e.code === "string" ? e.code : undefined,
      message: e.message,
      position:
        typeof e.position === "string" || typeof e.position === "number" ? e.position : undefined,
      hint: typeof e.hint === "string" ? e.hint : undefined,
    };
  }
  return { message: String(error) };
}

/**
 * "line 2, column 8" for the place PostgreSQL pointed at, or null.
 *
 * PostgreSQL counts from the start of everything it was sent, EXPLAIN prefix
 * included, starting at 1. The user only ever saw their own query, so the
 * prefix is taken off before counting lines.
 */
function locateError(
  err: QueryError,
  source: { sql: string; prefixLength: number } | undefined
): string | null {
  if (!source || err.position === undefined) return null;
  const position = Number(err.position);
  if (!Number.isFinite(position)) return null;
  const index = position - 1 - source.prefixLength;
  // Outside the user's text means the error is about the prefix, which the
  // user cannot see or change; pointing at it would only confuse.
  if (index < 0 || index > source.sql.length) return null;
  const before = source.sql.slice(0, index);
  const line = before.split("\n").length;
  const column = index - (before.lastIndexOf("\n") + 1) + 1;
  return `line ${line}, column ${column}`;
}

/** Text as a sentence. PostgreSQL's own messages usually have no full stop. */
function withStop(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * Turn a PostgreSQL error into a sentence an IT person can act on.
 *
 * Mapped by SQLSTATE, the stable code PostgreSQL attaches to every error,
 * rather than by searching the message: messages are translated when the
 * server runs in another language, and "canceling statement" alone cannot
 * tell a timeout from an administrator cancelling the query.
 *
 * `schema` is the one chosen on screen; unqualified names are looked up there
 * and then in public, so a missing table names both. `source` is the query as
 * typed plus the length of the EXPLAIN prefix, for pointing at a line.
 */
export function describeQueryError(
  err: QueryError,
  schema: string,
  timeoutSeconds: number,
  source?: { sql: string; prefixLength: number }
): string {
  const message = err.message;
  const where = locateError(err, source);
  const at = where ? ` (at ${where} of your query)` : "";
  const searched = schema === "public" ? "in public" : `in ${schema} or in public`;

  switch (err.code) {
    case "42P01": {
      // relation "orderz" does not exist / relation "nope.orders" does not exist
      const name = /relation "([^"]+)" does not exist/.exec(message)?.[1] ?? "that name";
      if (name.includes(".")) {
        return (
          `There is no table or view called ${name}${at}. Check the spelling of ` +
          `both the schema and the table name.`
        );
      }
      return (
        `There is no table or view called ${name} ${searched}, the schemas this ` +
        `screen searches${at}. Check the spelling, or put the schema in front of ` +
        `the name (for example other_schema.${name}).`
      );
    }
    case "3F000": {
      const name = /schema "([^"]+)" does not exist/.exec(message)?.[1];
      return (
        `There is no schema called ${name ?? "that"} on this server${at}. Check ` +
        `the spelling of the schema name.`
      );
    }
    case "42703": {
      // column o.totl does not exist / column "totl" does not exist
      const found = /column (?:"([^"]+)"|(\S+)) does not exist/.exec(message);
      const name = found ? (found[1] ?? found[2]) : "that name";
      return (
        `There is no column called ${name}${at}. Check the spelling, and which ` +
        `table it belongs to.` +
        (err.hint ? ` PostgreSQL suggests: ${withStop(err.hint)}` : "")
      );
    }
    case "42601": {
      if (/at end of input/.test(message)) {
        return (
          "The query stops too early: something is missing at the end, such as " +
          "a closing bracket or the rest of a clause."
        );
      }
      const near = /at or near "([^"]*)"/.exec(message)?.[1];
      return (
        `There is a syntax error${near !== undefined ? ` near "${near}"` : ""}` +
        `${at}. Look just before that point for a missing comma, bracket or keyword.`
      );
    }
    case "25006": {
      const what = /cannot execute (.+) in a read-only transaction/.exec(message)?.[1];
      return (
        `This query tries to change something${what ? ` (${what})` : ""}, and ` +
        `queries run read-only here, so it was stopped. Only queries that read ` +
        `data can be analysed. Untick Run it and measure to see the plan without ` +
        `running it.`
      );
    }
    case "57014":
      // Both a timeout and a manual cancel arrive as 57014; only the message
      // tells them apart, and it is the one case where that is unavoidable.
      if (/statement timeout/i.test(message)) {
        return (
          `PostgreSQL was still working on this query after ${timeoutSeconds} ` +
          `seconds, so it was stopped. If Run it and measure is ticked, untick it to ` +
          `see the plan without waiting for the query to finish. Or narrow the ` +
          `query down (a tighter WHERE, fewer joins, or a LIMIT) and try again.`
        );
      }
      return (
        "The query was cancelled before it finished, by an administrator or " +
        "another session. Try again; if it keeps happening, ask whoever looks " +
        "after this server."
      );
    case "55P03":
      return (
        "Another session is holding a lock on a table this query reads (often a " +
        "schema change that is still running), and the query gave up waiting for " +
        "it. Nothing is wrong with the query itself. Try again in a moment."
      );
    case "42501":
      return (
        `The database user this connection signs in as is not allowed to do this ` +
        `(PostgreSQL said: ${message}). Ask whoever manages the database to grant ` +
        `access, or use a connection whose user has it.`
      );
    case "42883": {
      if (/^operator does not exist/.test(message)) {
        const op = /operator does not exist: (.+)$/.exec(message)?.[1];
        return (
          `The operator in ${op ?? "this expression"}${at} cannot combine these ` +
          `types of value. Add a cast so both sides are the same type, for ` +
          `example some_column::integer.`
        );
      }
      const fn = /function (.+) does not exist/.exec(message)?.[1];
      return (
        `There is no function ${fn ?? "with that name"} that accepts these types ` +
        `of value${at}. Check the function's name, or add casts (for example ` +
        `::integer) so the values match what it expects.`
      );
    }
    case "42P02": {
      const param = /there is no parameter (\$\d+)/.exec(message)?.[1] ?? "$1";
      return (
        `This query uses ${param}-style placeholders, which an application fills ` +
        `in when it runs the query. Replace each one with a real value (for ` +
        `example 42 or 'paid') and analyse again.`
      );
    }
  }

  // Class 22 is "data exception": division by zero, a value that is not a
  // valid number or date, and so on. The message itself is already specific.
  if (err.code?.startsWith("22")) {
    return (
      `The query ran into a problem with a value${at}: ${message}. Fix the value, ` +
      `or the expression it comes from, and try again.`
    );
  }

  return (
    `PostgreSQL could not analyse this query${at}. PostgreSQL said: ` +
    withStop(message) +
    (err.hint ? ` Hint: ${withStop(err.hint)}` : "")
  );
}

// ── Part two: the plan ───────────────────────────────────────────────────────

/**
 * A node of `EXPLAIN (FORMAT JSON)` output.
 *
 * Typed as an open record rather than an exhaustive list of PostgreSQL's plan
 * keys: the set changes between major versions and between node types, and a
 * missing key here would be a crash rather than a shrug. Every read goes
 * through the accessors below, which treat "absent" and "wrong type" the same.
 */
export type RawPlanNode = { [key: string]: unknown };

/** One line of the plan, already flattened out of the nested JSON. */
export type PlanStep = {
  /** Position in the flattened list — parents before children. */
  id: number;
  /** How deep this node sits, so the UI can indent without walking a tree. */
  depth: number;
  /**
   * The id of the step directly above this one, or null for the top step.
   * Lets a rule walk up the tree ("is there a LIMIT above me?") without
   * searching the flattened list.
   */
  parentId: number | null;
  /**
   * How the step above uses this one, verbatim from PostgreSQL: "Outer" and
   * "Inner" for the two sides of a join (Inner is the side a nested loop
   * repeats), "InitPlan" and "SubPlan" for a subquery, "Member" for one input
   * of an Append, "Subquery" for a subquery scan. Null for the top step.
   */
  parentRelationship: string | null;
  /** "Seq Scan", "Hash Join", … verbatim from PostgreSQL. */
  nodeType: string;
  /** "Seq Scan on orders o" — the line as a person reads it. */
  label: string;
  /**
   * The table this step reads, when it reads one — separate from `label`,
   * which has the alias and the index name folded into it. Kept apart because
   * it is the key a caller looks a table's real size up by.
   */
  relation: string | null;
  /**
   * The schema `relation` lives in, as the plan reported it. Kept beside the
   * table name because the name alone is not a key — two schemas on one server
   * routinely hold a table called `orders`.
   */
  relationSchema: string | null;
  /** The name the query gave the table ("o" in `FROM orders o`), or null. */
  alias: string | null;
  /**
   * The step's Filter, verbatim, or null. With VERBOSE, PostgreSQL writes each
   * column with the name the query knows its table by, even in a query over a
   * single table: the alias when there is one ("(o.customer_id = 42)"),
   * otherwise the table's own name ("(orders.customer_id = 42)"). A varchar
   * column compared with text gets a cast: "((o.status)::text = 'paid'::text)".
   * Only a plan taken without VERBOSE writes columns bare ("(status = 'paid')").
   */
  filter: string | null;
  /**
   * The condition this step matches rows on: Hash Cond, Merge Cond or Join
   * Filter for a join, Index Cond for an index lookup. Null when there is none.
   */
  joinCond: string | null;
  /** What this step hands up, e.g. "o.id, o.total". Empty without VERBOSE. */
  output: string;
  /** One plain sentence saying what this step does. Empty if we have no words. */
  meaning: string;
  /** "Filter: (status = 'paid')" and friends, already flattened to strings. */
  details: string[];
  /** The planner's guess at rows handed on, PER LOOP. */
  estimatedRows: number;
  estimatedCost: number;
  /**
   * Measured rows handed on, PER LOOP, as PostgreSQL reports them. Null unless
   * the plan came from EXPLAIN ANALYZE. Multiply by `loops` for the total.
   */
  actualRows: number | null;
  /** Milliseconds spent in this step ALONE, children excluded. */
  selfMs: number | null;
  loops: number | null;
  /**
   * How many times the planner expects this step to run, worked out from the
   * shape of the plan (see estimateRuns). 1 for most steps; the repeated side
   * of a nested loop runs once per row of the other side. Needed because Total
   * Cost is the cost of ONE run, so a cheap step run 5,000 times can be the
   * most expensive thing in the query.
   */
  estimatedRuns: number;
  /**
   * True when the plan's shape runs this step again for each row of a step
   * above it: the repeated side of a nested loop (a Memoize or Materialize
   * there included), a subquery PostgreSQL runs for each row, and the steps
   * below them. Set by estimateRuns. Below a Gather this is what tells a
   * repeat from one of the processes, since measured loops count both.
   */
  repeated: boolean;
  /**
   * The planner's cost for this step alone, over all its runs, with its
   * children's cost taken off. An approximation: see estimateRuns.
   */
  selfCost: number;
  /**
   * This step's part of the whole query, 0 to 1: its selfMs over the total of
   * every step's selfMs when the query was run, otherwise its selfCost over
   * the total of every selfCost. Filled in by readPlan; 0 until then.
   */
  share: number;
  /**
   * How many rows the table `relation` holds, from the catalog, or null when
   * the step reads no table or the catalog was not given. Filled in by readPlan.
   */
  tableRows: number | null;
  /**
   * True when this step runs inside a parallel section (below a Gather). Its
   * row counts are then per helper process, not for the whole query.
   */
  inParallel: boolean;
  /**
   * True when the helper processes share this step's work between them, e.g.
   * a parallel scan where each process reads part of the table. Its measured
   * loops are then the processes, not repeats. False for a step every process
   * runs in full, such as the lookup side of a join.
   */
  parallelAware: boolean;
  /** The index an index or bitmap scan reads, e.g. "orders_customer_idx". */
  indexName: string | null;
  /** For a join: "Inner", "Left", "Semi", "Anti", … verbatim. Null otherwise. */
  joinType: string | null;
  /**
   * For a subquery step: its name as the rest of the plan refers to it, e.g.
   * "InitPlan 1", "SubPlan 2", or "CTE recent" for a WITH query.
   */
  subplanName: string | null;
  /** For a CTE Scan: the WITH query it reads, e.g. "recent". */
  cteName: string | null;
  /**
   * For an aggregate split across parallel helpers: "Partial" (each helper
   * counts its own share) or "Finalize" (the shares are added up). Null or
   * "Simple" for an ordinary aggregate.
   */
  partialMode: string | null;
  /**
   * For a Gather: the helper processes launched (measured) or planned
   * (estimate). Null for every other step.
   */
  workers: number | null;
  /**
   * True for a subquery PostgreSQL runs once and keeps in an in-memory lookup
   * table ("hashed SubPlan 1"), rather than once per row of the step above.
   */
  hashedSubplan: boolean;
};

export type PlanSummary = {
  steps: PlanStep[];
  /** The planner's own cost for the whole plan, in its arbitrary units. */
  totalCost: number;
  /** How many rows the planner expects the query to return. */
  estimatedRows: number;
  planningMs: number | null;
  executionMs: number | null;
  /** True when the query was actually run, so the actuals above are measured. */
  measured: boolean;
  /**
   * The step with the largest share: the slowest step when the query was run,
   * the most expensive by the planner's estimate otherwise. Null only when
   * every share is 0 (nothing timed, nothing costed).
   */
  heaviestStepId: number | null;
  /**
   * What every step's `share` is a share of: "time" when the query was run and
   * timed, "cost" when it is the planner's estimate. The screen words its
   * legend from this, because a cost is a guess and must not read as a timing.
   */
  basis: "time" | "cost";
  findings: QueryFinding[];
};

/** What the plan is worth: the planner's estimates, or a real, measured run. */
export type AnalyzeMode = "estimate" | "measured";

/**
 * The whole response of POST /api/performance/analyze.
 *
 * Defined here, not in the route, so the route and the screen
 * (components/studio/QueryAnalyzer.tsx) share one definition. The screen
 * imports it with `import type`, which is erased at build time.
 */
export type AnalyzeView = {
  connectionName: string;
  database: string;
  schema: string;
  mode: AnalyzeMode;
  /** The one-line verdict, e.g. "Ran in 3.1 ms and returned 42 rows…". */
  headline: string;
  plan: PlanSummary;
  /** Findings from the plan and from the query text, merged and ranked. */
  findings: QueryFinding[];
  counts: { high: number; medium: number; low: number; total: number };
};

/**
 * What each kind of plan node does, in one sentence.
 *
 * The point of this screen is that somebody who has never read a query plan can
 * still act on one, and "Bitmap Heap Scan" tells them nothing. Anything not in
 * this map simply shows no sentence — an invented explanation would be worse
 * than none.
 */
const NODE_MEANINGS: Record<string, string> = {
  "Seq Scan": "Reads every row in the table and throws away the ones that do not match.",
  "Index Scan":
    "Walks an index to find the matching rows, then fetches each one from the table.",
  "Index Only Scan":
    "Answers straight from the index — the table itself is never opened.",
  "Bitmap Index Scan":
    "Collects the locations of matching rows from an index, without reading them yet.",
  "Bitmap Heap Scan":
    "Reads the rows the index pointed at, in physical order so the disk is not seeking about.",
  "Tid Scan": "Fetches rows by their physical position, given directly.",
  "Nested Loop":
    "For every row on one side, searches the other side. Fast when one side is tiny.",
  "Hash Join": "Builds a lookup table out of one side, then probes it once per row of the other.",
  Hash: "Builds the lookup table the join above it will probe.",
  "Merge Join": "Walks both sides in sorted order at once, matching as it goes.",
  Sort: "Puts rows in order. Nothing above it can start until every row has arrived.",
  "Incremental Sort": "Sorts within groups that are already partly in order, so it can start early.",
  Aggregate: "Reduces the rows to a single result — a count, a sum, an average.",
  HashAggregate: "Groups rows using a lookup table, so they do not need sorting first.",
  GroupAggregate: "Groups rows that are already in order.",
  Limit: "Stops once it has enough rows.",
  Unique: "Drops neighbouring duplicates from already-sorted rows.",
  Materialize: "Keeps a copy of its rows in memory so they can be replayed cheaply.",
  Memoize: "Remembers answers it has already looked up, in case the same key comes round again.",
  Gather: "Collects rows from parallel worker processes.",
  "Gather Merge": "Collects rows from parallel workers, keeping them in order.",
  Append: "Runs several sources one after another and returns all their rows.",
  "Merge Append": "Runs several sorted sources at once and keeps the combined output sorted.",
  "Subquery Scan": "Reads the rows of a subquery.",
  "CTE Scan": "Reads a WITH block that was computed separately and stored.",
  "Function Scan": "Reads the rows a function returned.",
  "Values Scan": "Reads a literal list of rows written into the query.",
  Result: "Produces rows without reading a table — a constant, or a computed value.",
  WindowAgg: "Computes window functions over rows that are already in the right order.",
  SetOp: "Applies INTERSECT or EXCEPT to two sorted inputs.",
  LockRows: "Takes row locks for SELECT … FOR UPDATE.",
  "ModifyTable": "Writes the rows — the INSERT, UPDATE or DELETE itself.",
};

/** Plan keys worth showing verbatim, in the order they read best. */
const DETAIL_KEYS: string[] = [
  "Index Cond",
  "Recheck Cond",
  "Filter",
  "One-Time Filter",
  "Hash Cond",
  "Merge Cond",
  "Join Filter",
  // The call a Function Scan makes, e.g. generate_series(1, 10). Shown so the
  // reader sees the arguments, and read by planMentionsDenied, because a
  // function called in FROM appears nowhere else in the plan.
  "Function Call",
  "Sort Key",
  "Group Key",
  "Sort Method",
  "Rows Removed by Filter",
  "Rows Removed by Index Recheck",
  // Pages a bitmap stopped tracking row by row because it ran out of memory.
  // Shown only when above zero (see the details list below); read by the
  // lossy-bitmap rule to tell "out of memory" from an index type that always
  // needs rows rechecked.
  "Lossy Heap Blocks",
  "Rows Removed by Join Filter",
  "Heap Fetches",
];

function str(node: RawPlanNode, key: string): string | null {
  const value = node[key];
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map((v) => String(v)).join(", ");
  return null;
}

function numOrNull(node: RawPlanNode, key: string): number | null {
  const value = node[key];
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function num(node: RawPlanNode, key: string): number {
  return numOrNull(node, key) ?? 0;
}

/**
 * "external merge  Disk: 4096kB": a sort's method and the space it used, on
 * one line, the way the text form of EXPLAIN prints it.
 *
 * The JSON form splits this over three keys (Sort Method, Sort Space Used in
 * kB, Sort Space Type). Put back together, the reader sees in one line how
 * much a sort needed, and the sort-on-disk rule can size its advice from the
 * disk figure. A method that already carries its size is left as it is.
 */
function sortMethodText(node: RawPlanNode): string | null {
  const method = str(node, "Sort Method");
  if (method === null) return null;
  const used = numOrNull(node, "Sort Space Used");
  const type = str(node, "Sort Space Type");
  if (used === null || type === null || /\d\s*kB/i.test(method)) return method;
  return `${method}  ${type}: ${used}kB`;
}

/** The children of a node. `Plans` is what PostgreSQL calls the array. */
function childrenOf(node: RawPlanNode): RawPlanNode[] {
  const plans = node["Plans"];
  if (!Array.isArray(plans)) return [];
  return plans.filter((p): p is RawPlanNode => typeof p === "object" && p !== null);
}

/** "Seq Scan on orders o" / "Index Scan using orders_pkey on orders". */
function labelOf(node: RawPlanNode): string {
  const type = str(node, "Node Type") ?? "Step";
  const relation = str(node, "Relation Name");
  const index = str(node, "Index Name");
  const cte = str(node, "CTE Name");
  const fn = str(node, "Function Name");
  const alias = str(node, "Alias");

  // ModifyTable reports itself as "ModifyTable" with the verb — Insert, Update,
  // Delete — in a separate key, which reads as gibberish unless the two are put
  // back together.
  const operation = str(node, "Operation");
  let label = type === "ModifyTable" && operation ? operation : type;

  if (index) label += ` using ${index}`;
  const target = relation ?? cte ?? fn;
  if (target) {
    label += ` on ${target}`;
    // The alias only earns its place when it is not just the table name again.
    if (alias && alias !== target) label += ` ${alias}`;
  }
  return label;
}

/**
 * Flatten the plan tree into a list, computing each step's own time.
 *
 * PostgreSQL reports `Actual Total Time` per loop and INCLUSIVE of everything
 * below the node, which is why a plan's top line always shows the whole
 * duration. Subtracting the children gives the time the step spent on its own
 * work — the number that actually points at what to fix.
 *
 * It is an approximation for plans containing InitPlan / SubPlan nodes, whose
 * time is counted in their parent as well. Better an approximate answer to the
 * right question than an exact answer to the wrong one.
 */
function flattenPlan(root: RawPlanNode): PlanStep[] {
  const steps: PlanStep[] = [];

  // `inParallel` is passed down rather than looked up later: everything below
  // a Gather runs in the helper processes, and a step only knows that by
  // having been told on the way down.
  function walk(
    node: RawPlanNode,
    depth: number,
    parentId: number | null,
    inParallel: boolean
  ): void {
    const id = steps.length;
    const nodeType = str(node, "Node Type") ?? "Step";
    const loops = numOrNull(node, "Actual Loops");
    const perLoopMs = numOrNull(node, "Actual Total Time");
    const inclusiveMs = perLoopMs === null ? null : perLoopMs * (loops ?? 1);

    const details = DETAIL_KEYS.map((key) => {
      const value = key === "Sort Method" ? sortMethodText(node) : str(node, key);
      // A measured bitmap scan reports "Lossy Heap Blocks" even when it is 0,
      // which says nothing; printing it on every such step would be noise.
      if (key === "Lossy Heap Blocks" && value === "0") return null;
      return value === null ? null : `${key}: ${value}`;
    }).filter((line): line is string => line !== null);

    const step: PlanStep = {
      id,
      depth,
      parentId,
      parentRelationship: parentId === null ? null : str(node, "Parent Relationship"),
      nodeType,
      label: labelOf(node),
      relation: str(node, "Relation Name"),
      relationSchema: str(node, "Schema"),
      alias: str(node, "Alias"),
      filter: str(node, "Filter"),
      // A step has at most one of these in practice; the order only decides
      // which one wins on the rare node that carries two.
      joinCond:
        str(node, "Hash Cond") ??
        str(node, "Merge Cond") ??
        str(node, "Join Filter") ??
        str(node, "Index Cond"),
      output: str(node, "Output") ?? "",
      meaning: NODE_MEANINGS[nodeType] ?? "",
      details,
      estimatedRows: num(node, "Plan Rows"),
      estimatedCost: num(node, "Total Cost"),
      actualRows: numOrNull(node, "Actual Rows"),
      selfMs: inclusiveMs,
      loops,
      // The next four are worked out once the whole tree is known: runs,
      // repeats and own cost by estimateRuns below, share by weighSteps in
      // readPlan.
      estimatedRuns: 1,
      repeated: false,
      selfCost: 0,
      share: 0,
      // Filled in by readPlan, which is the one holding the catalog.
      tableRows: null,
      inParallel,
      parallelAware: node["Parallel Aware"] === true,
      indexName: str(node, "Index Name"),
      joinType: str(node, "Join Type"),
      subplanName: str(node, "Subplan Name"),
      cteName: str(node, "CTE Name"),
      partialMode: str(node, "Partial Mode"),
      // Launched is what really happened; Planned is all an estimate has.
      workers: numOrNull(node, "Workers Launched") ?? numOrNull(node, "Workers Planned"),
      // Needs the parent's expressions, so estimateRuns sets it.
      hashedSubplan: false,
    };
    steps.push(step);

    const startsParallel = nodeType === "Gather" || nodeType === "Gather Merge";
    let childInclusive = 0;
    for (const child of childrenOf(node)) {
      walk(child, depth + 1, id, inParallel || startsParallel);
      const childLoops = numOrNull(child, "Actual Loops");
      const childPerLoop = numOrNull(child, "Actual Total Time");
      if (childPerLoop !== null) childInclusive += childPerLoop * (childLoops ?? 1);
    }

    if (step.selfMs !== null) {
      // Clamped at zero: rounding in the reported milliseconds can otherwise
      // hand back a step that took negative time, which reads as a bug.
      step.selfMs = Math.max(0, step.selfMs - childInclusive);
    }
  }

  walk(root, 0, null, false);
  estimateRuns(steps);
  return steps;
}

/** True when `text` mentions "hashed SubPlan 1" for this exact subplan name. */
function mentionsHashed(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // (?!\d) so "SubPlan 1" does not match inside "hashed SubPlan 12".
  return new RegExp(`hashed ${escaped}(?!\\d)`).test(text);
}

/**
 * Work out how often each step runs, and what it costs on its own.
 *
 * PostgreSQL's Total Cost is the cost of ONE run of a step, children
 * included. That hides the classic slow plan: a nested loop repeating an index
 * lookup 5,000 times shows the lookup at a cost of 8, which looks cheap. So
 * each step gets an estimated number of runs, from the shape of the plan:
 *
 *   - the top step runs once;
 *   - an InitPlan (a subquery with no link to the outer row) runs once;
 *   - the repeated ("Inner") side of a Nested Loop runs once per row of the
 *     other ("Outer") side, times however often the loop itself runs;
 *   - a SubPlan (a subquery that refers to the outer row) runs once per row
 *     of the step it belongs to, unless PostgreSQL "hashed" it, in which case
 *     it ran once and its rows were kept in a lookup table;
 *   - every other step runs as often as the step above it.
 *
 * Two exceptions, checked on real PostgreSQL 17 plans, both on the repeated
 * side of a nested loop. A Materialize fills itself once and then replays its
 * rows. A Memoize runs the step below it only for a value it has not seen
 * yet, and answers a repeat from memory. Either way the step's Total Cost is
 * its first run, and the planner charges every later one (the cheap replays,
 * and a Memoize's further lookups) to the Nested Loop. Multiplying them by
 * the outer rows would make a 40-row cache look like the most expensive
 * step, so they count as running once per run of the loop, and in an
 * estimate the Nested Loop's own cost includes those later runs.
 *
 * Then a step's own cost = its Total Cost over all its runs, minus its
 * children's Total Cost over all of theirs. This is APPROXIMATE: startup and
 * rescan costs are ignored (a rescan is often cheaper than a first run), and
 * a SubPlan in a Filter runs once per row READ, which can be more than the
 * rows the step hands on. Good enough to point at the heavy part of a plan;
 * never shown as a number the reader should trust to the digit.
 *
 * Alongside, each step gets `repeated`: whether the shape of the plan runs
 * it again for each row of something above it, whatever its runs are costed
 * at. A Memoize is costed once but asked again for every outer row.
 */
function estimateRuns(steps: PlanStep[]): void {
  // Built once, because the loop below needs a step's siblings to find the
  // other side of its join.
  const children = childrenById(steps);

  // Ids go parents-first, so each parent's runs are known before its children.
  for (const step of steps) {
    if (step.parentId === null) {
      step.estimatedRuns = 1;
      step.repeated = false;
      continue;
    }
    const parent = steps[step.parentId];
    // The planner never guesses fewer than one row; a hand-written plan might.
    const parentRows = Math.max(1, parent.estimatedRows);

    if (step.parentRelationship === "InitPlan") {
      step.estimatedRuns = 1;
      step.repeated = false;
    } else if (step.parentRelationship === "SubPlan") {
      // The "hashed" marker is not on the subquery's own node: PostgreSQL only
      // writes it where the parent uses the result, e.g. "(hashed SubPlan 1)".
      const where = [parent.filter ?? "", parent.output, ...parent.details].join(" ");
      step.hashedSubplan =
        step.subplanName !== null && mentionsHashed(where, step.subplanName);
      step.estimatedRuns = step.hashedSubplan
        ? parent.estimatedRuns
        : parent.estimatedRuns * parentRows;
      step.repeated = step.hashedSubplan ? parent.repeated : true;
    } else if (parent.nodeType === "Nested Loop" && isInnerSide(step, children[parent.id])) {
      const outer = outerSide(children[parent.id]);
      const outerRows = Math.max(1, outer?.estimatedRows ?? 1);
      step.estimatedRuns =
        step.nodeType === "Materialize" || step.nodeType === "Memoize"
          ? parent.estimatedRuns
          : parent.estimatedRuns * outerRows;
      // A Materialize or Memoize too: each is asked again for every outer
      // row, though only its first run is costed.
      step.repeated = true;
    } else if (parent.nodeType === "Materialize" && parent.parentId !== null) {
      // A Materialize runs the steps below it once and replays their rows,
      // so they repeat only when whatever reads the Materialize repeats.
      step.estimatedRuns = parent.estimatedRuns;
      step.repeated = steps[parent.parentId].repeated;
    } else {
      step.estimatedRuns = parent.estimatedRuns;
      step.repeated = parent.repeated;
    }
  }

  for (const step of steps) {
    const childCost = children[step.id].reduce(
      (sum, child) => sum + child.estimatedCost * child.estimatedRuns,
      0
    );
    // Clamped at zero: the approximations above can take off a little more
    // than the step's total, and a negative cost reads as a bug.
    step.selfCost = Math.max(0, step.estimatedCost * step.estimatedRuns - childCost);
  }
}

/**
 * The direct children of every step, indexed by the parent's id. Uses
 * parentId, so it is exact however the plan is nested.
 */
function childrenById(steps: PlanStep[]): PlanStep[][] {
  const children: PlanStep[][] = steps.map(() => []);
  for (const step of steps) {
    if (step.parentId !== null) children[step.parentId].push(step);
  }
  return children;
}

/** The two sides of a join, without any InitPlan or SubPlan hanging off it. */
function joinSides(siblings: PlanStep[]): PlanStep[] {
  return siblings.filter(
    (s) => s.parentRelationship !== "InitPlan" && s.parentRelationship !== "SubPlan"
  );
}

/** The side a join reads once. PostgreSQL labels it "Outer"; else the first. */
function outerSide(siblings: PlanStep[]): PlanStep | undefined {
  const sides = joinSides(siblings);
  return sides.find((s) => s.parentRelationship === "Outer") ?? sides[0];
}

/** True for the side a nested loop repeats: "Inner", or else the second side. */
function isInnerSide(step: PlanStep, siblings: PlanStep[]): boolean {
  const sides = joinSides(siblings);
  const inner = sides.find((s) => s.parentRelationship === "Inner") ?? sides[1];
  return inner !== undefined && inner.id === step.id;
}

/** How many rows a step really produced, across all of its loops. */
function totalActualRows(step: PlanStep): number | null {
  if (step.actualRows === null) return null;
  return step.actualRows * (step.loops ?? 1);
}

/** "1,204" — thousands separators, because plan numbers get long. */
function fmtRows(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** "1 row" / "2 rows", formatted. */
function rowsWord(n: number): string {
  return `${fmtRows(n)} row${Math.round(n) === 1 ? "" : "s"}`;
}

/** Round to at most two decimals without printing "12.00". */
function fmtMs(n: number): string {
  return `${Math.round(n * 100) / 100} ms`;
}

/** The value of one "Key: value" detail line, or null when the step has none. */
function detailValue(step: PlanStep, key: string): string | null {
  const prefix = `${key}: `;
  const line = step.details.find((d) => d.startsWith(prefix));
  return line === undefined ? null : line.slice(prefix.length);
}

/**
 * The count off a "Rows Removed by Filter: 39999" plan line, when there is one.
 *
 * PER LOOP, like Actual Rows: PostgreSQL divides both by the loop count before
 * printing them, so the two can be compared directly and multiplied by
 * `loops` together for a total.
 */
function rowsRemovedByFilter(step: PlanStep): number | null {
  const value = detailValue(step, "Rows Removed by Filter");
  if (value === null) return null;
  const removed = Number(value);
  return Number.isFinite(removed) ? removed : null;
}

/** "public.orders" for the reader, or the bare name when the plan gave no schema. */
function tableName(step: PlanStep): string {
  if (step.relation === null) return step.label;
  return step.relationSchema === null ? step.relation : `${step.relationSchema}.${step.relation}`;
}

/**
 * The text on one line. A name or condition printed inside a `--` comment
 * must not carry a line break: the rest of it would land outside the comment
 * and run as SQL.
 */
function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ");
}

/** A plan condition on one comment line, however it was written. */
function asCommentLine(text: string): string {
  return `--   ${oneLine(text)}`;
}

/** "a", "a and b", "a, b and c". */
function andList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** "the column status", "the columns status and created_at". */
function columnsPhrase(columns: string[]): string {
  return columns.length === 1 ? `the column ${columns[0]}` : `the columns ${andList(columns)}`;
}

/**
 * How many rows each table actually holds, keyed `"schema.table"`.
 *
 * A plan says how many rows a step will HAND ON, not how many it will READ.
 * `SELECT * FROM orders WHERE id = 7` shows a sequential scan expecting one
 * row — which is exactly the query the whole-table rule below exists to catch,
 * and exactly the one it would miss reading the plan alone. Nothing in EXPLAIN
 * carries the table's size, so the route reads it from the catalog and passes
 * it in; a caller that cannot gets the weaker reading rather than an invented
 * one.
 */
export type TableRows = Record<string, number>;

/** One column of a table the plan reads. */
export type CatalogColumn = {
  name: string;
  /** As format_type prints it: "integer", "character varying(40)", … */
  type: string;
  notNull: boolean;
};

/** One index on a table the plan reads. */
export type CatalogIndex = {
  name: string;
  primary: boolean;
  unique: boolean;
  /**
   * False while a CREATE INDEX CONCURRENTLY is unfinished or has failed. The
   * planner does not use such an index, so it must not count as "already
   * indexed".
   */
  valid: boolean;
  /**
   * Key columns in index order. INCLUDE columns are left out, because they
   * cannot be searched on; an expression key (LOWER(email)) is null.
   */
  columns: (string | null)[];
};

/** The server settings that decide how hard the planner tries with many joins. */
export type PlannerSettings = {
  joinCollapseLimit: number;
  geqoThreshold: number;
  geqo: boolean;
};

/**
 * Everything the route reads from the target's catalog about the tables in
 * one plan. Every part is optional to readPlan: a rule that needs a missing
 * part falls back to the plan's own numbers, or stays quiet.
 */
export type PlanCatalog = {
  /** Rows per table, keyed "schema.table". */
  tableRows: TableRows;
  /** Columns per table, keyed "schema.table", in table order. */
  columns: Record<string, CatalogColumn[]>;
  /** Indexes per table, keyed "schema.table". */
  indexes: Record<string, CatalogIndex[]>;
  /**
   * Every relation name (tables, indexes, views, sequences, …) in each schema
   * the plan touches, keyed by schema. A new index needs a name nothing else
   * in the schema already has.
   */
  relationNames: Record<string, string[]>;
  /** The planner's join settings, or null when they could not be read. */
  settings: PlannerSettings | null;
};

/**
 * The catalog query results, row for row, as node-pg returns them.
 *
 * Column names match the SELECTs in app/api/performance/analyze/route.ts.
 * bigint arrives as a string (node-pg keeps values past 2^53 intact that way),
 * and current_setting always returns text, which is why the types below are
 * looser than PlanCatalog's.
 */
export type CatalogRows = {
  sizes: { schema_name: string; table_name: string; row_count: string | number }[];
  columns: {
    schema_name: string;
    table_name: string;
    column_name: string;
    data_type: string;
    not_null: boolean;
  }[];
  indexes: {
    schema_name: string;
    table_name: string;
    index_name: string;
    is_primary: boolean;
    is_unique: boolean;
    is_valid: boolean;
    columns: unknown;
  }[];
  relationNames: { schema_name: string; relname: string }[];
  settings: { join_collapse_limit: string; geqo_threshold: string; geqo: string } | null;
};

/**
 * Turn the catalog query results into the lookup maps readPlan uses.
 *
 * Pure, so the conversions (bigint strings, "on"/"off", an unanalysed table's
 * size) are tested without a server. Any part may be missing, because the
 * route stops reading at the first failure and keeps what it already has.
 */
export function catalogFromRows(rows: Partial<CatalogRows>): PlanCatalog {
  const catalog: PlanCatalog = {
    tableRows: {},
    columns: {},
    indexes: {},
    relationNames: {},
    settings: null,
  };

  for (const row of rows.sizes ?? []) {
    // reltuples is -1 until a table has been analysed, and the query's
    // GREATEST has already turned that into 0 — which means "unknown", and
    // falls through to the plan's own number rather than claiming the table is
    // empty.
    const count = Number(row.row_count);
    if (Number.isFinite(count) && count > 0) {
      catalog.tableRows[`${row.schema_name}.${row.table_name}`] = count;
    }
  }

  for (const row of rows.columns ?? []) {
    const key = `${row.schema_name}.${row.table_name}`;
    (catalog.columns[key] ??= []).push({
      name: row.column_name,
      type: row.data_type,
      notNull: Boolean(row.not_null),
    });
  }

  for (const row of rows.indexes ?? []) {
    const key = `${row.schema_name}.${row.table_name}`;
    const columns = Array.isArray(row.columns)
      ? row.columns.map((c) => (typeof c === "string" ? c : null))
      : [];
    (catalog.indexes[key] ??= []).push({
      name: row.index_name,
      primary: Boolean(row.is_primary),
      unique: Boolean(row.is_unique),
      valid: Boolean(row.is_valid),
      columns,
    });
  }

  for (const row of rows.relationNames ?? []) {
    (catalog.relationNames[row.schema_name] ??= []).push(row.relname);
  }

  if (rows.settings) {
    const joinCollapseLimit = Number(rows.settings.join_collapse_limit);
    const geqoThreshold = Number(rows.settings.geqo_threshold);
    if (Number.isFinite(joinCollapseLimit) && Number.isFinite(geqoThreshold)) {
      catalog.settings = {
        joinCollapseLimit,
        geqoThreshold,
        geqo: rows.settings.geqo === "on",
      };
    }
  }

  return catalog;
}

/**
 * The tables a plan reads, as two parallel lists: schemas[i] holds names[i].
 *
 * Two lists rather than one list of pairs because that is what the route's
 * catalog queries take — `unnest($1::text[], $2::text[])` pairs them back up
 * on the server, and the names never become part of the SQL text. Each table
 * appears once, however many steps read it.
 */
export function planRelations(steps: PlanStep[]): { schemas: string[]; names: string[] } {
  const seen = new Set<string>();
  const schemas: string[] = [];
  const names: string[] = [];
  for (const step of steps) {
    if (step.relation === null || step.relationSchema === null) continue;
    const key = `${step.relationSchema}.${step.relation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    schemas.push(step.relationSchema);
    names.push(step.relation);
  }
  return { schemas, names };
}

/**
 * How many rows this step actually reads, in total across its loops.
 *
 * Measured: the rows it kept plus the rows its filter threw away, per loop,
 * times the loops. That is exactly what was read, including when a LIMIT
 * above stopped the scan early.
 *
 * Estimated: for a sequential scan with a filter, the table's real size from
 * the catalog. The scan reads the whole table whatever the filter keeps, and
 * Plan Rows only counts what survives. Everything else gets Plan Rows, the
 * best number available.
 */
function rowsScanned(step: PlanStep, tableRows: TableRows): number {
  if (step.actualRows !== null) {
    const removed = rowsRemovedByFilter(step) ?? 0;
    return (step.actualRows + removed) * (step.loops ?? 1);
  }
  const planRows = step.estimatedRows;
  if (step.nodeType !== "Seq Scan" || step.filter === null) return planRows;
  // The key is schema-qualified, so a step reading reporting.orders is never
  // measured against public.orders. A plan without "Schema" (one taken
  // without VERBOSE) has no key to look up, and gets the plan's own number
  // rather than a guess at which same-named table it meant.
  if (step.relation === null || step.relationSchema === null) return planRows;
  const known = tableRows[`${step.relationSchema}.${step.relation}`];
  // reltuples is itself an estimate. When the planner expects more rows than
  // the statistics claim exist, the planner is the fresher of the two.
  return typeof known === "number" && known > planRows ? known : planRows;
}

/**
 * The direct children of one flattened plan step.
 *
 * flattenPlan walks depth-first, so a step's subtree is the contiguous run of
 * ids after it, ending at the first step back at its own depth or shallower.
 * Matching on `depth === step.depth + 1` alone across the whole plan picked up
 * nodes under a completely different join.
 */
function childrenOfStep(steps: PlanStep[], step: PlanStep): PlanStep[] {
  return subtreeOf(steps, step).filter((s) => s.depth === step.depth + 1);
}

/** Every step below this one, at any depth, in plan order. */
function subtreeOf(steps: PlanStep[], step: PlanStep): PlanStep[] {
  const below: PlanStep[] = [];
  for (let i = step.id + 1; i < steps.length; i += 1) {
    if (steps[i].depth <= step.depth) break;
    below.push(steps[i]);
  }
  return below;
}

/**
 * Steps that must see every input row before they hand anything up.
 *
 * A LIMIT above one of these cannot stop the scan below it early: the sort,
 * the hash table or the aggregate needs all the rows first. In JSON plans every
 * kind of aggregate is "Aggregate", with the strategy in a separate key.
 */
const BLOCKING_NODES: ReadonlySet<string> = new Set([
  "Sort",
  "Hash",
  "Aggregate",
  "HashAggregate",
  "SetOp",
  "WindowAgg",
]);

/**
 * True when a LIMIT above this step may stop it before it reads everything.
 *
 * `SELECT * FROM big WHERE flag LIMIT 1` plans a sequential scan of the whole
 * table, but the scan stops at the first match. Walking up from the scan: a
 * Limit reached first means it may stop early; a blocking step reached first
 * means it cannot. A subquery (InitPlan, SubPlan) runs on its own terms, not
 * the Limit's.
 */
function mayStopEarly(steps: PlanStep[], step: PlanStep): boolean {
  let current = step;
  while (current.parentId !== null) {
    if (current.parentRelationship === "InitPlan" || current.parentRelationship === "SubPlan") {
      return false;
    }
    const parent = steps[current.parentId];
    if (parent.nodeType === "Limit") return true;
    if (BLOCKING_NODES.has(parent.nodeType)) return false;
    current = parent;
  }
  return false;
}

/**
 * Steps that only hand on their one input's rows: build a hash table of them,
 * sort them, or keep a copy. The table read happens in the step below.
 */
const PASS_THROUGH_NODES: ReadonlySet<string> = new Set([
  "Hash",
  "Sort",
  "Incremental Sort",
  "Materialize",
  "Memoize",
]);

/** The step that really reads the rows, below any pass-through steps. */
function unwrapScan(steps: PlanStep[], step: PlanStep): PlanStep {
  let current = step;
  while (PASS_THROUGH_NODES.has(current.nodeType)) {
    const children = childrenOfStep(steps, current);
    if (children.length !== 1) break;
    current = children[0];
  }
  return current;
}

/** Scans that go through an index, whose extra Filter is a missed column. */
const INDEX_SCANS: ReadonlySet<string> = new Set([
  "Index Scan",
  "Index Only Scan",
  "Bitmap Heap Scan",
]);

// ── Reading a plan condition ─────────────────────────────────────────────────

/**
 * The largest share of a table a filter may keep and still be worth an index.
 *
 * An index pays off when it lets the server skip most of the table. Around a
 * tenth of the rows is where that stops: past it, hopping around the table
 * through an index costs more than reading it from start to finish, and the
 * planner rightly picks the whole-table read. An index suggested there would
 * be built, kept up to date on every write, and then ignored.
 */
export const SELECTIVE_SHARE = 0.1;

/**
 * How small one side of a join must be, as a share of the other, before an
 * index on the big side's join column is worth suggesting.
 *
 * A hash join reads both sides in full. That is the right plan when both are
 * big. When one side is a handful of rows and the other a whole large table,
 * looking the handful up through an index reads far less.
 */
export const JOIN_SMALL_SIDE_SHARE = 0.01;

/**
 * The largest share of the big side a join may return and still count as a
 * lookup. A join that keeps most of the big table needs most of it read, and
 * an index would not change that.
 */
export const JOIN_OUTPUT_SHARE = 0.1;

/** One piece of a plan condition, as tokenize() cuts it. */
type Token = {
  kind: "str" | "ident" | "qident" | "num" | "param" | "punct" | "op" | "other";
  /** The text as written, except a quoted name ("Note"), which is unquoted. */
  text: string;
};

/**
 * The shapes a plan condition is written in, tried in this order.
 *
 * A plan's conditions are PostgreSQL's own printout of the query, so they come
 * in a small, regular set of shapes: names, 'literals'::types, $1 parameters,
 * operators with spaces around them, and brackets. Anything else becomes an
 * "other" token, and a side containing one is treated as unreadable.
 */
const TOKEN_PATTERNS: [Token["kind"], RegExp][] = [
  ["str", /^[Ee]?'(?:[^']|'')*'/],
  ["qident", /^"(?:[^"]|"")*"/],
  ["num", /^\d+(?:\.\d+)?/],
  ["param", /^\$\d+/],
  ["ident", /^[A-Za-z_][\w$]*/],
  ["punct", /^(?:::|[(),.[\]])/],
  ["op", /^[+\-*/<>=~!@#%^&|`?]+/],
];

/** Cut a plan condition into tokens, dropping the spaces between them. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let rest = text.trim();
  while (rest.length > 0) {
    let matched = false;
    for (const [kind, pattern] of TOKEN_PATTERNS) {
      const m = pattern.exec(rest);
      if (m === null) continue;
      const raw = m[0];
      tokens.push({ kind, text: kind === "qident" ? raw.slice(1, -1).replace(/""/g, '"') : raw });
      rest = rest.slice(raw.length).trimStart();
      matched = true;
      break;
    }
    if (!matched) {
      tokens.push({ kind: "other", text: rest[0] });
      rest = rest.slice(1).trimStart();
    }
  }
  return tokens;
}

function isOpen(token: Token | undefined): boolean {
  return token?.kind === "punct" && (token.text === "(" || token.text === "[");
}

function isClose(token: Token | undefined): boolean {
  return token?.kind === "punct" && (token.text === ")" || token.text === "]");
}

function isWord(token: Token | undefined, word: string): boolean {
  return token?.kind === "ident" && token.text.toUpperCase() === word;
}

/** Where the bracket opened at `open` closes, or -1 when it never does. */
function closingIndex(tokens: Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i += 1) {
    if (isOpen(tokens[i])) depth += 1;
    else if (isClose(tokens[i])) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** "((a = 1))" → "a = 1": drop brackets that wrap the whole thing. */
function stripOuterParens(tokens: Token[]): Token[] {
  let inner = tokens;
  while (inner.length >= 2 && inner[0].text === "(" && closingIndex(inner, 0) === inner.length - 1) {
    inner = inner.slice(1, -1);
  }
  return inner;
}

/** Split at every AND (or OR) outside brackets. One part when there is none. */
function splitTop(tokens: Token[], word: "AND" | "OR"): Token[][] {
  const parts: Token[][] = [[]];
  let depth = 0;
  for (const token of tokens) {
    if (isOpen(token)) depth += 1;
    else if (isClose(token)) depth -= 1;
    if (depth === 0 && isWord(token, word)) parts.push([]);
    else parts[parts.length - 1].push(token);
  }
  return parts;
}

/**
 * The conditions ANDed together, however PostgreSQL bracketed them.
 * It prints `a AND b AND c` as "((a) AND (b) AND (c))", with brackets nested
 * as deep as the query had them.
 */
function andParts(tokens: Token[]): Token[][] {
  const inner = stripOuterParens(tokens);
  const parts = splitTop(inner, "AND");
  return parts.length === 1 ? [inner] : parts.flatMap(andParts);
}

/**
 * Every single comparison in a condition, whether ANDed, ORed or under NOT.
 * For rules that ask "is this shape anywhere", not "can an index use it".
 */
function conditionAtoms(tokens: Token[]): Token[][] {
  const inner = stripOuterParens(tokens);
  for (const word of ["OR", "AND"] as const) {
    const parts = splitTop(inner, word);
    if (parts.length > 1) return parts.flatMap(conditionAtoms);
  }
  if (isWord(inner[0], "NOT")) return conditionAtoms(inner.slice(1));
  return [inner];
}

/** One comparison split at its operator, or null when it is not one comparison. */
function comparisonOf(tokens: Token[]): { left: Token[]; op: string; right: Token[] } | null {
  const t = stripOuterParens(tokens);
  let depth = 0;
  let at = -1;
  for (let i = 0; i < t.length; i += 1) {
    if (isOpen(t[i])) depth += 1;
    else if (isClose(t[i])) depth -= 1;
    else if (depth === 0 && t[i].kind === "op") {
      // PostgreSQL brackets every inner operation, so a second operator
      // outside brackets means a shape this reader does not know.
      if (at !== -1) return null;
      at = i;
    }
  }
  if (at <= 0 || at === t.length - 1) return null;
  return { left: t.slice(0, at), op: t[at].text, right: t.slice(at + 1) };
}

/** The type the catalog gives a column, or null when the column is not listed. */
function typeOf(columnTypes: Record<string, string>, column: string): string | null {
  return Object.prototype.hasOwnProperty.call(columnTypes, column) ? columnTypes[column] : null;
}

/**
 * The names a plan puts in front of this table's columns.
 *
 * With VERBOSE, PostgreSQL writes the alias when the query gave one ("o" in
 * `FROM orders o`) and the table's own name otherwise; its JSON sets Alias to
 * the table name in that case, so one name is always enough.
 */
function qualifiersFor(alias: string | null, relation: string | null): string[] {
  const name = alias ?? relation;
  return name === null ? [] : [name];
}

/**
 * The column named by one side of a comparison, when that side is a plain
 * column of this table, or null.
 *
 * Accepted: `status`, `o.status`, `orders."Note"`, and `(o.status)::text` for
 * a character varying column only. That last one is how PostgreSQL compares
 * a varchar with a text value, and an index on the column still serves it.
 * Any other cast, or a function around the column, changes the value being
 * compared, and an index on the plain column cannot find it.
 */
function columnOf(side: Token[], quals: string[], columnTypes: Record<string, string>): string | null {
  const t = stripOuterParens(side);
  const n = t.length;
  if (n >= 5 && t[0].text === "(" && closingIndex(t, 0) === n - 3 && t[n - 2].text === "::") {
    if (!isWord(t[n - 1], "TEXT")) return null;
    const column = columnOf(t.slice(1, n - 3), quals, columnTypes);
    const type = column === null ? null : typeOf(columnTypes, column);
    return type !== null && type.startsWith("character varying") ? column : null;
  }

  let column: string | null = null;
  const isName = (token: Token) => token.kind === "ident" || token.kind === "qident";
  if (n === 1 && isName(t[0])) {
    // A bare name is this table's column in a plan taken without VERBOSE,
    // unless it is a word such as NULL or TRUE.
    if (t[0].kind === "ident" && VALUE_WORDS.has(t[0].text.toUpperCase())) return null;
    column = t[0].text;
  } else if (n === 3 && isName(t[0]) && t[1].text === "." && isName(t[2])) {
    column = quals.includes(t[0].text) ? t[2].text : null;
  }
  if (column === null) return null;
  // With the column list known, a name that is not on it is not a plain
  // column (ctid, say) and cannot be indexed like one.
  if (Object.keys(columnTypes).length > 0 && typeOf(columnTypes, column) === null) return null;
  return column;
}

/**
 * Words that stand for a value rather than a column.
 * InitPlan is a subquery run once before the scan, so its result is fixed.
 * SubPlan is not on this list: it runs again for every row.
 */
const VALUE_WORDS: ReadonlySet<string> = new Set([
  "NULL",
  "TRUE",
  "FALSE",
  "ANY",
  "ALL",
  "SOME",
  "ARRAY",
  "INITPLAN",
  "CURRENT_DATE",
  "CURRENT_TIME",
  "CURRENT_TIMESTAMP",
  "LOCALTIME",
  "LOCALTIMESTAMP",
  "CURRENT_USER",
  "CURRENT_ROLE",
  "SESSION_USER",
]);

/** Skip the type written after `::`, e.g. `character varying(40)[]`. */
function afterType(tokens: Token[], start: number): number {
  let i = start;
  while (tokens[i] && (tokens[i].kind === "ident" || tokens[i].kind === "qident" || tokens[i].text === ".")) {
    i += 1;
  }
  if (tokens[i]?.text === "(") {
    const close = closingIndex(tokens, i);
    // An unclosed bracket: nothing after it can be read, so stop here.
    if (close === -1) return tokens.length;
    i = close + 1;
  }
  while (tokens[i]?.text === "[" && tokens[i + 1]?.text === "]") i += 2;
  return i;
}

/**
 * True when one side of a comparison has the same value for every row of this
 * table: a constant, a $1 parameter, another table's column (a join), or a
 * function of those. Only then can an index look the value up.
 *
 * `o.a = o.b` compares two columns of the same row, and no index finds rows
 * by that; `o.a = c.id` looks up the other table's value, which it can.
 */
function valueIsFixed(side: Token[], quals: string[]): boolean {
  if (side.length === 0) return false;
  let i = 0;
  while (i < side.length) {
    const token = side[i];
    const next = side[i + 1];
    if (token.kind === "other") return false;
    if (token.text === "::") {
      i = afterType(side, i + 1);
    } else if (token.text === ".") {
      // The name after (InitPlan 1).col1 or a qualifier already judged.
      i += 2;
    } else if (token.kind === "ident" || token.kind === "qident") {
      if (next?.text === ".") {
        if (quals.includes(token.text)) return false;
        i += 3;
      } else if (next?.text === "(") {
        i += 1;
      } else if (token.kind === "ident" && VALUE_WORDS.has(token.text.toUpperCase())) {
        i += 1;
      } else {
        // A bare name is a column of this table, or a SubPlan run per row.
        return false;
      }
    } else {
      i += 1;
    }
  }
  return true;
}

/** The comparison operators a B-tree index can serve. */
const INDEXABLE_OPERATORS: ReadonlySet<string> = new Set(["=", "<", ">", "<=", ">="]);

/** The column one ANDed condition lets an index search on, and how. */
function searchableColumn(
  part: Token[],
  quals: string[],
  columnTypes: Record<string, string>
): { column: string; kind: "equality" | "range" } | null {
  const t = stripOuterParens(part);
  const n = t.length;
  // x IS NULL: a B-tree index stores NULLs too, and can find them.
  if (n >= 3 && isWord(t[n - 2], "IS") && isWord(t[n - 1], "NULL")) {
    const column = columnOf(t.slice(0, n - 2), quals, columnTypes);
    return column === null ? null : { column, kind: "equality" };
  }
  const cmp = comparisonOf(t);
  if (cmp === null || !INDEXABLE_OPERATORS.has(cmp.op)) return null;
  // `= ANY (…)` is an equality too: it looks each listed value up.
  const kind = cmp.op === "=" ? "equality" : "range";
  // The column may sit on either side; "(42 = orders.customer_id)" is
  // printed the way the query wrote it.
  const left = columnOf(cmp.left, quals, columnTypes);
  if (left !== null && valueIsFixed(cmp.right, quals)) return { column: left, kind };
  const right = columnOf(cmp.right, quals, columnTypes);
  if (right !== null && valueIsFixed(cmp.left, quals)) return { column: right, kind };
  return null;
}

/**
 * The columns of one table a plan condition searches on, in the order an
 * index on them should list them, or null when there are none.
 *
 * `filter` is a Filter, Hash Cond, Merge Cond or Join Filter exactly as the
 * plan printed it; `alias` and `relation` say which table's columns to pick
 * out; `columnTypes` (column → type) comes from the catalog and may be empty.
 *
 * Equality columns come first, in the order written, then at most one range
 * column (<, >, <=, >=): an index can narrow by every equality but only by
 * the first range after them, so a second range column would only make the
 * index bigger. Null when an OR joins the top-level conditions, because an
 * index on either side alone cannot answer an OR.
 *
 *   filterColumns("((o.status)::text = 'paid'::text)", "o", "orders", { status: "character varying(20)" })
 *     →  { equality: ["status"], range: null }
 */
export function filterColumns(
  filter: string,
  alias: string | null,
  relation: string | null,
  columnTypes: Record<string, string>
): { equality: string[]; range: string | null } | null {
  const quals = qualifiersFor(alias, relation);
  const top = stripOuterParens(tokenize(filter));
  if (splitTop(top, "OR").length > 1) return null;

  const equality: string[] = [];
  const ranges: string[] = [];
  for (const part of andParts(top)) {
    const found = searchableColumn(part, quals, columnTypes);
    if (found === null) continue;
    if (found.kind === "range") ranges.push(found.column);
    else if (!equality.includes(found.column)) equality.push(found.column);
  }
  const range = ranges.find((column) => !equality.includes(column)) ?? null;
  if (equality.length === 0 && range === null) return null;
  return { equality, range };
}

/**
 * For the comment-only index fixes. A condition that wraps a column in a
 * function, lower(email) = …, is served only by an index on that same
 * expression; an index on the column alone does nothing for it.
 */
const INDEX_ON_WHAT =
  "-- An index serves it only when built on what it compares: the column\n" +
  "-- itself or, when the condition wraps the column in a function such as\n" +
  "-- lower(), that same expression.\n";

/**
 * True when every ANDed part of a filter tests a subquery's result, as in
 * `(NOT (ANY (c.id = (hashed SubPlan 1).col1)))` for a NOT IN, or
 * `((SubPlan 1) > 5)`. No index on the scanned table can answer such a test:
 * the work is in the subquery, whose own steps get their own findings. An
 * InitPlan's value is known before the scan starts, so a comparison with
 * `(InitPlan 1).col1` is an ordinary one and does not count here.
 */
function testsOnlySubqueries(filter: string): boolean {
  return andParts(tokenize(filter)).every((part) =>
    part.some((token) => token.kind === "ident" && token.text === "SubPlan")
  );
}

/**
 * True when a sequential scan reads a large table to keep only a small
 * share of it: the case where an index on what its Filter compares would let
 * the server look those rows up instead. A filter that keeps most of the
 * table needs most of it read whatever indexes exist.
 *
 * Both counts are totals across loops, so a scan a nested loop repeats, or
 * one split between parallel workers, is judged by the same share.
 */
function readsManyKeepsFew(step: PlanStep, tableRows: TableRows): boolean {
  if (step.nodeType !== "Seq Scan" || step.filter === null) return false;
  const scanned = rowsScanned(step, tableRows);
  const kept = totalActualRows(step) ?? step.estimatedRows;
  return scanned >= LARGE_TABLE_ROWS && kept <= scanned * SELECTIVE_SHARE;
}

/** Column name → type for one table, from the catalog. Empty when unknown. */
function columnTypesFor(
  catalog: Partial<PlanCatalog>,
  schema: string | null,
  table: string | null
): Record<string, string> {
  const types: Record<string, string> = {};
  if (schema === null || table === null) return types;
  for (const column of catalog.columns?.[`${schema}.${table}`] ?? []) {
    types[column.name] = column.type;
  }
  return types;
}

/**
 * Rules that read the plan. Ordered as they are written, sorted on the way out.
 *
 * `catalog` is whatever the route managed to read about the plan's tables.
 * Every rule works without it, just less sharply.
 */
function planFindings(
  steps: PlanStep[],
  measured: boolean,
  catalog: Partial<PlanCatalog>
): QueryFinding[] {
  const tableRows = catalog.tableRows ?? {};
  const out: QueryFinding[] = [];

  // Steps a finding has already covered. The scan a slow nested loop repeats
  // is the loop's problem, and one finding with one fix reads better than two
  // suggesting the same index.
  const covered = new Set<number>();

  // Index names handed out in this report, per schema, on top of every name
  // the schema already uses, so two suggestions never share a name. The same
  // suggestion twice (same table, same columns) is one index and keeps one.
  const suggestions = new Map<string, IndexStatement>();
  const takenNames = new Map<string, string[]>();
  function suggestIndex(schema: string, table: string, columns: string[]): IndexStatement {
    const key = JSON.stringify([schema, table, columns]);
    const earlier = suggestions.get(key);
    if (earlier) return earlier;
    const taken = takenNames.get(schema) ?? [...(catalog.relationNames?.[schema] ?? [])];
    const statement = createIndexSql(schema, table, columns, taken);
    taken.push(statement.name);
    takenNames.set(schema, taken);
    suggestions.set(key, statement);
    return statement;
  }

  /**
   * The fix for "this step reads a whole table", given the conditions it
   * searches by:
   *   • change       a named CREATE INDEX on the columns read off the
   *                  conditions, with the DROP INDEX that undoes it;
   *   • maintenance  ANALYZE, when a usable index on the first of those
   *                  columns already exists and the planner passed it over,
   *                  which usually means its statistics are stale;
   *   • decision     `fallback` (comments only), when no column can be read
   *                  off the conditions or the plan gave no schema.
   */
  function indexAdvice(
    step: PlanStep,
    conditions: (string | null)[],
    fallback: string
  ): { columns: string[]; fix: string; fixKind: FixKind; undo?: string } {
    const schema = step.relationSchema;
    const table = step.relation;
    if (schema === null || table === null) {
      return { columns: [], fix: fallback, fixKind: "decision" };
    }

    const types = columnTypesFor(catalog, schema, table);
    const columns: string[] = [];
    let range: string | null = null;
    for (const condition of conditions) {
      if (condition === null) continue;
      const found = filterColumns(condition, step.alias, table, types);
      if (found === null) continue;
      for (const column of found.equality) {
        if (!columns.includes(column)) columns.push(column);
      }
      range ??= found.range;
    }
    // Equality columns first, the one range column last: see filterColumns.
    if (range !== null && !columns.includes(range)) columns.push(range);
    if (columns.length === 0) return { columns, fix: fallback, fixKind: "decision" };

    const tableIndexes = catalog.indexes?.[`${schema}.${table}`] ?? [];
    const existing = tableIndexes.find(
      (index) => index.valid && index.columns[0] === columns[0]
    );

    // An index on the same column that is marked invalid is one the planner
    // cannot use, usually left behind by a CREATE INDEX CONCURRENTLY that
    // failed. It still slows every write, and a reader who sees it in the
    // table's index list would wonder why the advice ignores it, so one
    // sentence names it and says what clears it.
    const invalid = tableIndexes.find(
      (index) => !index.valid && index.columns[0] === columns[0]
    );
    const invalidName = invalid ? oneLine(qualifiedName(schema, invalid.name)) : "";
    const invalidNote = invalid
      ? `-- The index ${oneLine(invalid.name)} on ${oneLine(columns[0])} is marked invalid, so the\n` +
        `-- planner cannot use it (a CREATE INDEX CONCURRENTLY that failed, or is\n` +
        `-- still running, leaves it that way); REINDEX INDEX ${invalidName};\n` +
        `-- or DROP INDEX ${invalidName}; clears it.`
      : "";

    if (existing) {
      return {
        columns,
        fixKind: "maintenance",
        fix:
          `-- The index ${oneLine(existing.name)} already starts with ${oneLine(columns[0])},\n` +
          `-- yet the planner read the whole table. Stale statistics are the usual\n` +
          `-- reason. Refreshing them only samples the table and blocks nothing:\n` +
          `ANALYZE ${qualifiedName(schema, table)};\n` +
          `-- If the plan is the same afterwards, that index does not narrow this\n` +
          `-- search enough for the planner to prefer it.` +
          (invalid ? `\n${invalidNote}` : ""),
      };
    }

    const index = suggestIndex(schema, table, columns);
    return {
      columns,
      fixKind: "change",
      fix:
        // Before the CREATE INDEX, so the reader can choose to repair the
        // broken index rather than add a second one.
        (invalid ? `${invalidNote}\n` : "") +
        `-- With this index the server can find the matching rows of\n` +
        `-- ${oneLine(tableName(step))} without reading the whole table. Build it, then analyse again.\n` +
        index.sql,
      undo: index.undo,
    };
  }

  for (const step of steps) {
    // Per-loop and total counts are kept apart on purpose. PostgreSQL reports
    // Actual Rows, Plan Rows and Rows Removed by Filter per loop, so a rule
    // comparing two of them compares per-loop values, and a rule saying "how
    // much work" multiplies by the loops.
    const loops = step.loops ?? 1;
    const actualTotal = totalActualRows(step);
    const removedPerLoop = rowsRemovedByFilter(step);

    // ── A sequential scan with a filter, over a large table ──
    // Without a filter the query is asking for the whole table and no index
    // can help, so there is nothing to say here (the text rules can still
    // comment on a missing WHERE). Nor can one when the filter only tests a
    // subquery's result: see testsOnlySubqueries.
    if (
      step.nodeType === "Seq Scan" &&
      step.filter !== null &&
      !covered.has(step.id) &&
      !testsOnlySubqueries(step.filter)
    ) {
      const table = tableName(step);
      const scanned = rowsScanned(step, tableRows);
      const kept = actualTotal ?? step.estimatedRows;
      const removedTotal = removedPerLoop === null ? null : removedPerLoop * loops;

      // Only a filter that keeps a small share of the table is worth an
      // index. One that keeps most of it needs most of the table read
      // whatever indexes exist, so the whole-table read is the right plan.
      if (readsManyKeepsFew(step, tableRows)) {
        // Only an estimate can be wrong about stopping early. A measured plan
        // already counted exactly what was read.
        const limited = !measured && mayStopEarly(steps, step);
        // A decision, not a statement, when the columns cannot be read off
        // the filter: an unfinished CREATE INDEX would be a placeholder
        // dressed up as runnable SQL.
        const advice = indexAdvice(
          step,
          [step.filter],
          `-- Decide whether to index what this filter compares:\n` +
            `${asCommentLine(step.filter)}\n` +
            INDEX_ON_WHAT +
            `-- With one, the server can jump straight to the rows it needs\n` +
            `-- instead of reading all of ${oneLine(table)}. Then analyse again.`
        );
        out.push({
          id: `seq-scan:${step.id}`,
          stepId: step.id,
          severity: limited ? "medium" : "high",
          title:
            advice.fixKind === "change"
              ? `Index ${columnsPhrase(advice.columns)}`
              : advice.fixKind === "maintenance"
                ? `Whole table read, though an index on ${advice.columns[0]} exists`
                : "Whole table read to answer this",
          object: table,
          detail:
            `Step ${step.id + 1} reads ${fmtRows(scanned)} rows out of ${table} one ` +
            `after another, with no index involved. ` +
            (removedTotal !== null
              ? `${fmtRows(removedTotal)} of them are thrown away again immediately, ` +
                `having been read only to fail the filter. `
              : scanned - kept >= kept && scanned > kept
                ? `Only about ${rowsWord(kept)} ${Math.round(kept) === 1 ? "is" : "are"} ` +
                  `expected to match, so most of the reading is thrown away. `
                : "") +
            (limited
              ? `A LIMIT above this step may stop the read early, so the real cost ` +
                `can be lower; tick Run it and measure to see how much is actually read. `
              : "") +
            `Reading every row is cheap below roughly ${fmtRows(LARGE_TABLE_ROWS)} rows, ` +
            `but the cost grows with the number of rows read.`,
          fix: advice.fix,
          fixKind: advice.fixKind,
          undo: advice.undo,
        });
      }
    }

    // ── An index scan whose extra filter throws most rows away ──
    // A sequential scan is covered above, index and all. Here an index WAS
    // used, but it only narrows the search by some of the conditions, and the
    // rest are checked row by row after each row is fetched from the table.
    if (
      measured &&
      INDEX_SCANS.has(step.nodeType) &&
      removedPerLoop !== null &&
      step.actualRows !== null &&
      removedPerLoop > step.actualRows * 10 &&
      removedPerLoop * loops >= 1000
    ) {
      const indexCond = step.joinCond ?? detailValue(step, "Recheck Cond");
      const runs =
        loops > 1
          ? `, each time it ran (${fmtRows(loops)} times, ${fmtRows(removedPerLoop * loops)} ` +
            `thrown away in all)`
          : "";
      out.push({
        id: `wasteful-filter:${step.id}`,
        stepId: step.id,
        severity: "high",
        title: "The index finds rows the filter then throws away",
        object: step.label,
        detail:
          `Step ${step.id + 1} used an index, then fetched ` +
          `${fmtRows(removedPerLoop + step.actualRows)} rows from the table and kept ` +
          `${fmtRows(step.actualRows)}${runs}. The index matches only part of the ` +
          `condition; the rest is checked one row at a time after each row has ` +
          `been read. An index that also covers the filtered columns would skip ` +
          `those rows without reading them.`,
        fix:
          (indexCond !== null
            ? `-- The index finds rows by:\n${asCommentLine(indexCond)}\n`
            : "") +
          `-- and then this filter throws most of them away:\n` +
          `${asCommentLine(step.filter ?? "(the filter on the plan line above)")}\n` +
          `-- Decide whether an index that also covers the filtered column(s)\n` +
          `-- is worth its upkeep for this query, then analyse again.`,
        // A decision: which columns to add, and whether the extra index is
        // worth slowing every write for, depends on the other queries too.
        fixKind: "decision",
      });
    }

    // ── The planner's estimate is out by an order of magnitude ──
    // The planner chooses a plan from its estimates. When one is out by ten
    // times or more, the plan was chosen for a query that does not exist, and
    // no amount of indexing fixes that — the statistics do.
    //
    // Both numbers are per loop. A 1-row lookup repeated a thousand times is
    // a correct estimate of 1, not an estimate out by a thousand.
    if (measured && step.actualRows !== null && step.actualRows >= 100 && step.estimatedRows > 0) {
      const actual = step.actualRows;
      const ratio =
        actual > step.estimatedRows ? actual / step.estimatedRows : step.estimatedRows / actual;
      if (ratio >= 10) {
        out.push({
          id: `estimate-off:${step.id}`,
          stepId: step.id,
          severity: "medium",
          title: "The planner's row estimate is far off",
          object: step.label,
          detail:
            `Step ${step.id + 1} was planned for ${rowsWord(step.estimatedRows)} and ` +
            `produced ${fmtRows(actual)}` +
            (loops > 1 ? ` each time it ran (${fmtRows(loops)} times)` : "") +
            ` — out by about ${Math.round(ratio)}×. Everything above this step was ` +
            `planned around the wrong number, so the join order and join methods may ` +
            `be wrong too. Usually this means the table's statistics are stale.`,
          ...estimateFix(steps, step),
        });
      }
    }

    // ── A sort that did not fit in memory and wrote to temporary files ──
    const sortMethod = detailValue(step, "Sort Method");
    if (sortMethod !== null && /external/i.test(sortMethod)) {
      out.push({
        id: `sort-on-disk:${step.id}`,
        stepId: step.id,
        severity: "medium",
        title: "The sort ran out of memory and used the disk",
        object: step.label,
        detail:
          `Step ${step.id + 1} reports "${sortMethod}", which means the rows did not ` +
          `fit in the memory one sort may use (the work_mem setting) and were written ` +
          `to temporary files. Sorting on disk is far slower than sorting in memory.`,
        fix: sortSpillFix(sortMethod, detailValue(step, "Sort Key")),
        // A decision: more memory for one query is a trade against memory for
        // every other connection, and only the reader knows the server's load.
        fixKind: "decision",
      });
    }

    // ── A nested loop that re-reads a whole table on every pass ──
    // A nested loop searches its Inner side once per outer row. An index scan
    // there, run ten thousand times, is the join working as designed: each
    // search is a quick lookup. A sequential scan there reads the whole inner
    // table every time, and that is the accidental rows × rows.
    if (measured && step.nodeType === "Nested Loop") {
      const children = childrenOfStep(steps, step);
      const inner = children.find((c) => c.parentRelationship === "Inner") ?? children[1];
      const repeated = inner
        ? [inner, ...subtreeOf(steps, inner)].find(
            (s) => s.nodeType === "Seq Scan" && (s.loops ?? 1) >= 1000
          )
        : undefined;
      if (repeated) {
        const table = tableName(repeated);
        // In a nested loop the join condition usually sits on the inner scan
        // as its Filter; otherwise on the loop itself as a Join Filter.
        const cond = repeated.filter ?? step.joinCond;
        // This finding explains the repeated scan, so the whole-table rule
        // above leaves it alone rather than suggesting the same index again.
        covered.add(repeated.id);
        const advice = indexAdvice(
          repeated,
          [repeated.filter, step.joinCond],
          `-- Each repeated search reads ${oneLine(table)} in full. An index on\n` +
            `-- what this join matches on would turn every search into a quick lookup` +
            (cond !== null ? `:\n${asCommentLine(cond)}\n` + INDEX_ON_WHAT : `.\n`) +
            `-- Decide whether to add one, then analyse again.`
        );
        out.push({
          id: `nested-loop:${step.id}`,
          stepId: step.id,
          severity: "medium",
          title: "One side of this join is read in full, thousands of times",
          object: step.label,
          detail:
            `Step ${step.id + 1} searches ${table} once for every row from the other ` +
            `side, and it did so ${fmtRows(repeated.loops ?? 0)} times. Each search ` +
            `reads ${table} from start to finish, with no index involved, so the ` +
            `work is the rows on one side times the rows on the other.`,
          fix: advice.fix,
          fixKind: advice.fixKind,
          undo: advice.undo,
        });
      }
    }

    // ── A hash or merge join that reads a big table to match a few rows ──
    // Both of these joins read each side in full. That is right when both
    // sides are big. When one side is a handful of rows and the other a large
    // table read with no filter at all, an index on the big table's join
    // column lets the server look the handful up instead; the planner can
    // only choose that once the index exists.
    if ((step.nodeType === "Hash Join" || step.nodeType === "Merge Join") && step.joinCond !== null) {
      const sides = childrenOfStep(steps, step);
      for (const side of sides) {
        const big = unwrapScan(steps, side);
        const other = sides.find((s) => s !== side);
        if (other === undefined || big.nodeType !== "Seq Scan" || big.filter !== null) continue;
        if (big.relation === null || big.relationSchema === null) continue;

        const known = tableRows[`${big.relationSchema}.${big.relation}`] ?? 0;
        const bigRows = measured ? totalActualRows(big) ?? 0 : Math.max(big.estimatedRows, known);
        const otherRows = measured ? totalActualRows(other) ?? 0 : other.estimatedRows;
        const joinRows = measured ? actualTotal ?? 0 : step.estimatedRows;
        if (bigRows < LARGE_TABLE_ROWS) continue;
        if (otherRows > bigRows * JOIN_SMALL_SIDE_SHARE) continue;
        if (joinRows > bigRows * JOIN_OUTPUT_SHARE) continue;

        // Without a column read off the join condition there is no index to
        // name, and "read a big table" alone is not news: say nothing.
        const advice = indexAdvice(big, [step.joinCond], "");
        if (advice.fixKind === "decision") continue;

        const table = tableName(big);
        out.push({
          id: `join-key:${step.id}`,
          stepId: step.id,
          severity: "medium",
          title:
            advice.fixKind === "change"
              ? `Index ${columnsPhrase(advice.columns)} for this join`
              : "A whole table is read to join a few rows",
          object: table,
          detail:
            `Step ${step.id + 1} matches ${rowsWord(otherRows)} from one side against ` +
            `${table}, and ${measured ? "reads" : "is planned to read"} all ` +
            `${fmtRows(bigRows)} rows of ${table} to do it. The join returns ` +
            `${rowsWord(joinRows)}. ` +
            (advice.fixKind === "change"
              ? `With an index on the column the join matches on, the server can ` +
                `look up just the matching rows of ${table} instead.`
              : `An index the server could use to look up just the matching rows ` +
                `already exists, and the planner passed it over.`),
          fix: advice.fix,
          fixKind: advice.fixKind,
          undo: advice.undo,
        });
        break;
      }
    }

    // ── A bitmap that ran out of memory and fell back to whole pages ──
    // "Rows Removed by Index Recheck" alone proves nothing: some index types
    // (BRIN always; GIN and GiST for some operators) need every row rechecked
    // whatever the memory. "Lossy Heap Blocks" counts the pages the bitmap
    // stopped tracking row by row for lack of memory, and more memory helps
    // only when that count is above zero.
    const lost = Number(detailValue(step, "Rows Removed by Index Recheck"));
    const lossyPages = Number(detailValue(step, "Lossy Heap Blocks"));
    if (Number.isFinite(lost) && lost > 0 && Number.isFinite(lossyPages) && lossyPages > 0) {
      out.push({
        id: `lossy-bitmap:${step.id}`,
        stepId: step.id,
        severity: "low",
        title: "The index lookup ran out of memory and had to recheck rows",
        object: step.label,
        detail:
          `The bitmap of matching rows outgrew the memory it may use (work_mem), so on ` +
          `${fmtRows(lossyPages)} pages it kept only "something here matches", and every ` +
          `row on those pages was read and tested again: ${fmtRows(lost)} rows were ` +
          `dropped on that second look. With more memory the bitmap stays exact.`,
        fix: lossyBitmapFix(lossyPages),
        fixKind: "decision",
      });
    }

    // Heap Fetches is a total across loops, unlike the row counts above.
    const fetches = Number(detailValue(step, "Heap Fetches"));
    if (step.nodeType === "Index Only Scan" && Number.isFinite(fetches) && fetches >= 1000) {
      const table = tableName(step);
      out.push({
        id: `heap-fetches:${step.id}`,
        stepId: step.id,
        severity: "low",
        title: "An index-only scan kept having to open the table anyway",
        object: table,
        detail:
          `This step should have been answered by the index alone, but it went to ` +
          `the table ${fmtRows(fetches)} times because the rows had been changed too ` +
          `recently for the visibility map to vouch for them. Vacuuming refreshes it.`,
        // Built from the schema and table, never from the label: the label
        // carries the alias ("orders o"), which would make the statement a
        // syntax error.
        fix:
          step.relation !== null && step.relationSchema !== null
            ? `VACUUM (ANALYZE) ${qualifiedName(step.relationSchema, step.relation)};`
            : `-- The plan did not say which schema ${oneLine(table)} is in.\n` +
              `-- Run VACUUM (ANALYZE) on that table, with its schema in front.`,
        // Maintenance when there is a statement to run; VACUUM cannot run
        // inside a transaction, so it can never be part of a migration.
        fixKind:
          step.relation !== null && step.relationSchema !== null ? "maintenance" : "decision",
      });
    }
  }

  return out;
}

/**
 * "4 MB" or "900 kB", for the sizes a plan reports in kB. Whole megabytes
 * from 10 MB up, one decimal below that.
 */
function kbText(kb: number): string {
  if (kb < 1024) return `${kb} kB`;
  const mb = kb / 1024;
  return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}

/**
 * The two narrow ways to raise work_mem to `size`, as comment lines.
 *
 * Narrow on purpose: work_mem is the memory EACH sort, hash or bitmap in each
 * running query may use, so a server-wide increase multiplies across every
 * busy connection and can run the server out of memory. One query (SET LOCAL,
 * which ends with its transaction) or one role is the safe scope. Commented,
 * because both findings that use this are decisions.
 */
function workMemLines(size: string): string[] {
  return [
    "-- work_mem is the memory each sort, hash or bitmap in each running query",
    "-- may use, so raising it for the whole server multiplies across every busy",
    "-- connection. Raise it only where it is needed:",
    "--   for this query only, run it in a transaction after",
    `--     SET LOCAL work_mem = '${size}';`,
    "--   for everything one role runs (a reporting login, say)",
    `--     ALTER ROLE "<role name>" SET work_mem = '${size}';`,
  ];
}

/**
 * The fix for a sort that spilled to disk: a decision, sized from what the
 * sort wrote when the plan says so ("external merge  Disk: 4096kB").
 *
 * In memory the same rows take more room than on disk, up to about three
 * times as much, so three times the disk figure (in whole megabytes, never
 * below the 4MB default) is the starting point. Without a figure the text
 * says so, rather than presenting a guess as a measurement.
 */
function sortSpillFix(method: string, sortKey: string | null): string {
  const diskKb = Number(/Disk:\s*(\d+)\s*kB/i.exec(method)?.[1]);
  const sized = Number.isFinite(diskKb) && diskKb > 0;
  const size = sized ? `${Math.max(4, Math.ceil((diskKb * 3) / 1024))}MB` : "64MB";
  const lines = [
    "-- Decide whether to give this sort more memory (the work_mem setting).",
    ...(sized
      ? [
          `-- The sort wrote about ${kbText(diskKb)} to disk. In memory the same rows need`,
          `-- more room, up to about three times as much, so ${size} is a starting point.`,
        ]
      : [
          `-- The plan does not say how much the sort wrote to disk, so ${size} is only`,
          "-- a first guess.",
        ]),
    ...workMemLines(size),
    "-- The sort fitted when EXPLAIN ANALYZE of the query shows its Sort Method",
    '-- as "quicksort" instead of "external merge".',
  ];
  if (sortKey !== null) {
    lines.push(
      `-- Or avoid the sort: an index on ${oneLine(sortKey)} can return the rows`,
      "-- already in that order, when they come straight from one table."
    );
  }
  return lines.join("\n");
}

/**
 * The fix for a bitmap that ran out of memory: a decision. Unlike a sort, the
 * plan gives no size to start from, so the advice is to raise work_mem a step
 * at a time and watch the lossy pages go.
 */
function lossyBitmapFix(lossyPages: number): string {
  return [
    "-- Decide whether to give this query more memory (the work_mem setting).",
    `-- The bitmap stopped tracking single rows on ${fmtRows(lossyPages)} pages. The plan does`,
    "-- not say how much memory would have been enough, so raise work_mem a step",
    "-- at a time (it is 4MB unless someone changed it; 16MB is a first step)",
    "-- until EXPLAIN ANALYZE of the query reports no lossy heap blocks.",
    ...workMemLines("16MB"),
  ].join("\n");
}

/**
 * The fix for an estimate that is far off, with its kind.
 *
 * A step that reads a table gets the one statement that refreshes that
 * table's statistics: maintenance, since ANALYZE only samples the table and
 * never blocks other work. A join or any other step above several tables
 * gets their names instead, commented out, as a decision: which one has the
 * stale statistics is a judgement the reader has to make.
 */
function estimateFix(steps: PlanStep[], step: PlanStep): { fix: string; fixKind: FixKind } {
  if (step.relation !== null) {
    return step.relationSchema !== null
      ? {
          fixKind: "maintenance",
          fix: `ANALYZE ${qualifiedName(step.relationSchema, step.relation)};`,
        }
      : {
          fixKind: "decision",
          fix:
            `-- The plan did not say which schema ${oneLine(step.relation)} is in.\n` +
            `-- Run ANALYZE on that table, with its schema in front.`,
        };
  }
  const tables = planRelations(subtreeOf(steps, step));
  if (tables.names.length === 0) {
    return {
      fixKind: "decision",
      fix:
        "-- This step reads no table directly, so there are no table statistics\n" +
        "-- to refresh. Its estimate comes from the function or expression itself.",
    };
  }
  const lines = tables.names.map(
    (name, i) => `-- ANALYZE ${oneLine(qualifiedName(tables.schemas[i], name))};`
  );
  return {
    fixKind: "decision",
    fix:
      `-- This step combines rows from the tables below it. Refresh the\n` +
      `-- statistics of whichever changed most recently, then analyse again:\n` +
      lines.join("\n"),
  };
}

/** Highest severity first, then in plan order, so the list reads top-down. */
const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

export function sortFindings(findings: QueryFinding[]): QueryFinding[] {
  return [...findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

/**
 * Find the plan inside whatever the driver handed back.
 *
 * node-pg returns EXPLAIN (FORMAT JSON) already parsed, as a one-element
 * array. The bare object is accepted too, since that is what a test writes.
 */
function parseEnvelope(raw: unknown): { record: RawPlanNode; root: RawPlanNode } | null {
  const envelope: unknown = Array.isArray(raw) ? raw[0] : raw;
  if (typeof envelope !== "object" || envelope === null) return null;

  const record = envelope as RawPlanNode;
  const rootValue = record["Plan"];
  const root =
    typeof rootValue === "object" && rootValue !== null ? (rootValue as RawPlanNode) : null;
  if (!root || typeof root["Node Type"] !== "string") return null;
  return { record, root };
}

/**
 * Just the flattened steps, for the checks that run before anything else.
 *
 * The route asks checkPlanIsReadOnly and planMentionsDenied about the plain
 * EXPLAIN before it decides whether to run the query for real, and has no use
 * for findings at that point. Null when the reply is not a plan.
 */
export function planSteps(raw: unknown): PlanStep[] | null {
  const parsed = parseEnvelope(raw);
  return parsed ? flattenPlan(parsed.root) : null;
}

/**
 * Turn one `EXPLAIN (FORMAT JSON)` result into something readable.
 *
 * Returns null rather than throwing when the shape is not a plan at all: the
 * caller has just handed over whatever a database replied with, and a driver
 * that returns the JSON as a string, or a version that nests it differently,
 * should show "could not read the plan" rather than a stack trace.
 *
 * `catalog` is optional and sharpens the rules that care how much a step
 * reads rather than how much it returns — see TableRows.
 */
export function readPlan(raw: unknown, catalog: Partial<PlanCatalog> = {}): PlanSummary | null {
  const parsed = parseEnvelope(raw);
  if (!parsed) return null;

  const steps = flattenPlan(parsed.root);
  const measured = steps.some((s) => s.actualRows !== null);

  // The table's real size rides on the step, so the plain-words walk-through
  // can say "reads the whole of public.orders (1.2 million rows)" without
  // being handed the catalog as well.
  for (const step of steps) {
    if (step.relation === null || step.relationSchema === null) continue;
    const known = catalog.tableRows?.[`${step.relationSchema}.${step.relation}`];
    if (typeof known === "number") step.tableRows = known;
  }

  const { heaviestStepId, basis } = weighSteps(steps, measured);

  return {
    steps,
    totalCost: steps[0]?.estimatedCost ?? 0,
    estimatedRows: steps[0]?.estimatedRows ?? 0,
    planningMs: numOrNull(parsed.record, "Planning Time"),
    executionMs: numOrNull(parsed.record, "Execution Time"),
    measured,
    heaviestStepId,
    basis,
    findings: sortFindings(planFindings(steps, measured, catalog)),
  };
}

/**
 * Set every step's `share` of the whole query, and pick the heaviest step.
 *
 * Measured time wins when there is some: it is what really happened. A plan
 * run with EXPLAIN (ANALYZE, TIMING OFF) has row counts but no times, so it
 * falls back to the planner's cost like an estimate, and says so.
 *
 * Ties go to the first step in plan order, the one nearer the top.
 */
function weighSteps(
  steps: PlanStep[],
  measured: boolean
): { heaviestStepId: number | null; basis: "time" | "cost" } {
  const totalMs = steps.reduce((sum, s) => sum + (s.selfMs ?? 0), 0);
  const basis = measured && totalMs > 0 ? "time" : "cost";
  const weightOf = (s: PlanStep): number => (basis === "time" ? (s.selfMs ?? 0) : s.selfCost);
  const total = steps.reduce((sum, s) => sum + weightOf(s), 0);

  let heaviestStepId: number | null = null;
  let heaviest = 0;
  for (const step of steps) {
    const weight = weightOf(step);
    step.share = total > 0 ? weight / total : 0;
    if (weight > heaviest) {
      heaviest = weight;
      heaviestStepId = step.id;
    }
  }
  return { heaviestStepId, basis };
}

/** A one-line verdict for the top of the screen. */
export function describePlan(summary: PlanSummary): string {
  const head = summary.steps[0];
  if (!head) return "The server returned an empty plan.";
  if (summary.measured) {
    const rows = totalActualRows(head);
    const tail =
      `returned ${fmtRows(rows ?? 0)} row${rows === 1 ? "" : "s"}, in ` +
      `${summary.steps.length} step${summary.steps.length === 1 ? "" : "s"}.`;
    // A measured plan can arrive without a total time — EXPLAIN (ANALYZE,
    // SUMMARY OFF) omits it, and so do some older servers. The query still ran,
    // so it drops the duration rather than falling through to the sentence
    // below, which would tell the reader it was never executed.
    return summary.executionMs === null
      ? `Ran and ${tail}`
      : `Ran in ${fmtMs(summary.executionMs)} and ${tail}`;
  }
  return (
    `Planned in ${summary.steps.length} step${summary.steps.length === 1 ? "" : "s"}, ` +
    `expecting ${fmtRows(summary.estimatedRows)} ` +
    `row${summary.estimatedRows === 1 ? "" : "s"} back. Not run, so these are ` +
    `estimates.`
  );
}

// ── How heavy a step is, for the screen ──────────────────────────────────────

/** How strongly the screen tints a step for its share of the query. */
export type ShareBand = "hot" | "warm" | "none";

/**
 * The tint for a step's share: "hot" at half the query or more, "warm" at a
 * fifth or more, "none" below that.
 *
 * Two bands rather than a colour scale: "this step is most of the query" and
 * "this step is a big part of it" are the two things worth seeing at a
 * glance, and a finer scale would claim a precision the planner's cost does
 * not have.
 */
export function shareBand(share: number): ShareBand {
  if (share >= 0.5) return "hot";
  if (share >= 0.2) return "warm";
  return "none";
}

/**
 * A share as the screen prints it: "63%". A step with a sliver of the query
 * reads "<1%" rather than "0%", which would say it did nothing at all.
 */
export function shareText(share: number): string {
  if (share <= 0) return "0%";
  if (share < 0.005) return "<1%";
  return `${Math.round(share * 100)}%`;
}

/**
 * The name of the heaviest step's badge. A cost is the planner's guess, so
 * the badge must not call it "slowest": nothing was timed.
 */
export function heaviestStepLabel(basis: PlanSummary["basis"]): string {
  return basis === "time" ? "Slowest step" : "Most expensive step (estimate)";
}

/** What the percentages on the plan are a share of, for the line above it. */
export function shareLegend(basis: PlanSummary["basis"]): string {
  return basis === "time"
    ? "Share of the query's total time (measured)"
    : "Share of the planner's estimated cost; an estimate, not a timing";
}

// ── A plan condition in plain SQL ────────────────────────────────────────────

/** The longest condition quoted in a sentence before it is cut short. */
const PLAIN_CONDITION_MAX = 140;

/**
 * Stand-ins for the string literals while a condition is rewritten. Private-
 * use characters, because no real condition contains them.
 */
const LITERAL_OPEN = "\uE000";
const LITERAL_CLOSE = "\uE001";

/** A column name, maybe qualified ("o.status"), or a literal's stand-in. */
const PLAIN_ATOM =
  String.raw`(?:[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)*|` +
  `${LITERAL_OPEN}\\d+${LITERAL_CLOSE})`;

/**
 * A pair of brackets with nothing but one column or value inside. The
 * lookbehind keeps the brackets of a function call (`lower(email)`) and of
 * an `IN (...)`, `ANY (...)` or `NOT (...)`, whose meaning needs them.
 */
const LONE_ATOM_IN_BRACKETS = new RegExp(
  String.raw`(?<![\w$]|NOT |IN |ANY |ALL )\((${PLAIN_ATOM})\)`,
  "g"
);

/** Innermost brackets, with the same exceptions as above. */
const INNERMOST_BRACKETS = /(?<![\w$]|NOT |IN |ANY |ALL )\(([^()]*)\)/g;

/**
 * The items of an array literal's body, as SQL values: `1,2,3` stays as it is,
 * `paid,"on hold"` becomes `'paid', 'on hold'`.
 */
function arrayItems(body: string): string[] {
  const items: string[] = [];
  // The body is still inside a SQL string, so a quote in it is doubled.
  const unescaped = body.replace(/''/g, "'");
  for (const match of unescaped.matchAll(/"((?:[^"\\]|\\.)*)"|([^,]+)/g)) {
    const quoted = match[1] !== undefined;
    const value = quoted ? match[1].replace(/\\(.)/g, "$1") : match[2].trim();
    if (!quoted && value === "NULL") items.push("NULL");
    else if (!quoted && /^-?\d+(\.\d+)?$/.test(value)) items.push(value);
    else items.push(`'${value.replace(/'/g, "''")}'`);
  }
  return items;
}

/** Where the bracket opened at `open` closes, or -1. */
function closingBracket(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * A plan condition the way a person would write it in a WHERE clause.
 *
 * PostgreSQL prints conditions for its own benefit, with every cast spelled
 * out: `((o.status)::text = 'paid'::text)` is `o.status = 'paid'`, `~~` is
 * LIKE, an IN list is `= ANY ('{1,2,3}'::integer[])`, and a NOT IN subquery
 * is `(NOT (ANY (c.id = (hashed SubPlan 1).col1)))`. Each is rewritten here.
 * The result is display text only, never run, so reading it a little more
 * loosely than the server would (a dropped cast) is safe.
 *
 * String literals are set aside first and put back last, so nothing inside a
 * quoted value ('50% off', 'a ~~ b') is ever rewritten.
 */
function plainCondition(text: string): string {
  // An IN list first: its values sit inside a literal, which is set aside next.
  let s = text.replace(
    /(=|<>) (ANY|ALL) \('\{((?:[^'}]|'')*)\}'(?:::[\w ]+(?:\[\])?)?\)/g,
    (match: string, op: string, which: string, body: string) => {
      if (op === "=" && which === "ANY") return `IN (${arrayItems(body).join(", ")})`;
      if (op === "<>" && which === "ALL") return `NOT IN (${arrayItems(body).join(", ")})`;
      return match;
    }
  );

  const literals: string[] = [];
  s = s.replace(/'(?:[^']|'')*'/g, (literal) => {
    literals.push(literal);
    return `${LITERAL_OPEN}${literals.length - 1}${LITERAL_CLOSE}`;
  });

  // Casts: "::text", "::character varying(20)", "::timestamp without time
  // zone", "::integer[]". The value reads the same without them.
  s = s.replace(
    /::(?:"[^"]+"|[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)(?:\(\d+(?:, ?\d+)?\))?(?: (?:varying|precision|with(?:out)? time zone))*(?:\(\d+(?:, ?\d+)?\))?(?:\[\])*/g,
    ""
  );

  // The pattern operators under their SQL names. Longest first, so "!~~*"
  // is not read as "!~~" followed by a stray "*".
  s = s
    .replace(/!~~\*/g, "NOT ILIKE")
    .replace(/~~\*/g, "ILIKE")
    .replace(/!~~/g, "NOT LIKE")
    .replace(/~~/g, "LIKE");

  // "(hashed SubPlan 1).col1" and "(InitPlan 1).col1" name the subquery the
  // walk-through describes, so they read as "(SubPlan 1)" and "(InitPlan 1)".
  s = s.replace(/\((?:hashed )?((?:Init|Sub)Plan \d+)\)(?:\.col1(?!\d))?/g, "($1)");

  s = s.replace(LONE_ATOM_IN_BRACKETS, "$1");

  // A NOT IN subquery: "NOT (ANY (c.id = (SubPlan 1)))" → "c.id NOT IN (SubPlan 1)".
  s = s.replace(/ANY \(([^()]+?) = (\((?:Init|Sub)Plan \d+\))\)/g, "$1 IN $2");
  s = s.replace(/NOT \(([^()]+?) IN (\((?:Init|Sub)Plan \d+\))\)/g, "$1 NOT IN $2");

  // Brackets around one comparison, innermost first, until none are left.
  // Those around an AND or OR stay: "a AND (b OR c)" needs them.
  for (let pass = 0; pass < 20; pass += 1) {
    const next = s.replace(INNERMOST_BRACKETS, (match: string, inner: string) =>
      /[=<>]| I?LIKE | IS /.test(inner) && !/ AND | OR |,/.test(inner) ? inner : match
    );
    if (next === s) break;
    s = next;
  }

  // Brackets around the whole condition.
  s = s.trim();
  while (s.startsWith("(") && closingBracket(s, 0) === s.length - 1) {
    s = s.slice(1, -1).trim();
  }

  s = s
    .replace(new RegExp(`${LITERAL_OPEN}(\\d+)${LITERAL_CLOSE}`, "g"), (_m, i: string) =>
      literals[Number(i)] ?? ""
    )
    .replace(/\s+/g, " ")
    .trim();
  return s.length > PLAIN_CONDITION_MAX
    ? `${s.slice(0, PLAIN_CONDITION_MAX - 1).trimEnd()}…`
    : s;
}

// ── The plan in plain words ──────────────────────────────────────────────────

/** What the sentence builders below need besides the step itself. */
type Narration = {
  steps: PlanStep[];
  /** Every step's direct children, by the parent's id (see childrenById). */
  children: PlanStep[][];
  measured: boolean;
};

/**
 * What one step's row count is a count of. The same number can mean three
 * different things, and a sentence that got it wrong would be off by a
 * factor of a hundred:
 *
 *   - per run, on a step that runs many times (the repeated side of a nested
 *     loop, a subquery run for each row): "60 rows each time; it ran 100 times";
 *   - per helper process, inside a parallel section, where PostgreSQL reports
 *     one process's share (estimated) or the average over them (measured);
 *   - otherwise one total for the whole query.
 */
type Counting = {
  measured: boolean;
  /** Rows the step handed on, in the unit the two flags below say. */
  rows: number;
  /** The rows are for one run of a step that ran `runs` times. */
  perRun: boolean;
  /**
   * How often the step ran (measured) or is expected to run (estimate). Null
   * when an estimate cannot say: the planner costs the steps below a Memoize
   * as running once (see estimateRuns), though they run again for every
   * value the cache has not seen yet.
   */
  runs: number | null;
  /** The rows are for one helper process. */
  perProcess: boolean;
  /**
   * Measured, the step ran more than once, and its rows show as 0 only
   * because PostgreSQL rounds the average per run to a whole number. A lookup
   * that finds a row one time in ten averages 0.1, shown as 0, so this count
   * must never read "no rows" (see countOf).
   */
  underOne: boolean;
  /** Measured, and the step never started (no rows ever reached it). */
  neverRan: boolean;
};

function countingOf(step: PlanStep, measured: boolean): Counting {
  if (!measured || step.actualRows === null) {
    const runs = Math.round(step.estimatedRuns);
    return {
      measured: false,
      rows: step.estimatedRows,
      // Plan Rows are for one run. `repeated` also catches a step the plan
      // repeats that estimatedRuns counts once (a Memoize, say): its count is
      // for one run all the same, but how many runs is not known.
      perRun: runs > 1 || step.repeated,
      runs: runs > 1 ? runs : null,
      // Every estimate below a Gather is for one process: the planner divides
      // a parallel scan's rows between them, and each runs the rest in full.
      perProcess: step.inParallel,
      underOne: false,
      neverRan: false,
    };
  }
  const loops = step.loops ?? 1;
  // Below a Gather, loops also counts the processes that ran the step, so it
  // is a repeat count only on a step the plan's shape repeats (`repeated`:
  // the repeated side of a nested loop, a subquery run for each row, and the
  // steps below them). A parallel scan's loops are its processes, never repeats.
  const perRun = loops > 1 && !step.parallelAware && (!step.inParallel || step.repeated);
  // Measured Actual Rows is an average per loop. For a step each process ran
  // in full (a hash table every process builds for itself), multiplying it
  // by the processes would count the same rows twice, so it stays per process.
  const perProcess = !perRun && step.inParallel && !step.parallelAware && loops > 1;
  return {
    measured: true,
    rows: perRun || perProcess ? step.actualRows : step.actualRows * loops,
    perRun,
    runs: loops,
    perProcess,
    underOne: loops > 1 && Math.round(step.actualRows) === 0,
    neverRan: loops === 0,
  };
}

/** "750 rows", "about 1.2 million rows", "no rows": a count in a sentence. */
function countPhrase(n: number, measured: boolean, noun = "row"): string {
  const rounded = Math.round(n);
  const word = rounded === 1 ? noun : `${noun}s`;
  if (measured) return rounded === 0 ? `no ${noun}s` : `${fmtRows(n)} ${word}`;
  return `about ${countInWords(n)} ${word}`;
}

/**
 * The most rows a step with Counting.underOne can have found in all, when
 * its count is a total: the processes of a parallel scan each averaged at
 * most half a row, so together they found at most half as many rows as
 * there were processes.
 */
function mostRowsFound(c: Counting): number {
  return Math.floor((c.runs ?? 0) / 2);
}

/**
 * countPhrase for a step's own count. An average PostgreSQL rounded to 0
 * (Counting.underOne) reads "fewer than one row on average", or "at most 1
 * row" for a parallel scan's total: never "no rows".
 */
function countOf(c: Counting, noun = "row"): string {
  if (!c.underOne) return countPhrase(c.rows, c.measured, noun);
  if (c.perRun || c.perProcess) return `fewer than one ${noun} on average`;
  const most = mostRowsFound(c);
  return `at most ${most} ${most === 1 ? noun : `${noun}s`}`;
}

/** ", giving 750 rows": what a step handed on. */
function givingClause(c: Counting): string {
  return `, giving ${countOf(c)}`;
}

/** ", and keeps the 312 where …": what a filter let through. */
function keepsClause(c: Counting, cond: string): string {
  if (!c.measured || c.underOne) return `, and keeps ${countOf(c)} where ${cond}`;
  const kept = Math.round(c.rows);
  if (kept === 0) return `, and no row meets ${cond}`;
  if (kept === 1) return `, and keeps the one row where ${cond}`;
  return `, and keeps the ${fmtRows(kept)} where ${cond}`;
}

/**
 * The note at the end of a sentence saying what its count is a count of.
 * (A step that never ran never gets this far: sentenceFor words it.)
 */
function unitNote(c: Counting): string {
  if (c.perRun) {
    if (c.measured) return ` (each time; it ran ${fmtRows(c.runs ?? 0)} times)`;
    return c.runs === null
      ? " (each time it runs)"
      : ` (each time; expected to run about ${countInWords(c.runs)} times` +
          `${c.perProcess ? " in each process" : ""})`;
  }
  return c.perProcess ? " (in each process)" : "";
}

/** "public.orders (o)": a table as the query named it. */
function tableWithAlias(step: PlanStep): string {
  const table = tableName(step);
  return step.alias !== null && step.alias !== step.relation ? `${table} (${step.alias})` : table;
}

/** "the WITH query recent (r)". */
function cteWithAlias(step: PlanStep): string {
  const name = `the WITH query ${step.cteName ?? ""}`.trim();
  return step.alias !== null && step.alias !== step.cteName ? `${name} (${step.alias})` : name;
}

/** Steps that hand on their one input's rows as they are, for naming a join side. */
const NAME_PASSES_THROUGH: ReadonlySet<string> = new Set([
  ...PASS_THROUGH_NODES,
  "Gather",
  "Gather Merge",
]);

/**
 * What one side of a join reads, named for a sentence: "public.orders (o)",
 * or "the WITH query recent (r)". Looks down through steps that pass their
 * input's rows on unchanged (a Hash, a Sort, a Gather) and gives up, with
 * null, at one that makes new rows, such as an aggregate: naming the table
 * under it would say the join matches that table's rows, which it does not.
 */
function inputName(n: Narration, step: PlanStep | undefined): string | null {
  let current = step;
  while (current !== undefined) {
    if (current.relation !== null) return tableWithAlias(current);
    if (current.cteName !== null) return cteWithAlias(current);
    if (!NAME_PASSES_THROUGH.has(current.nodeType)) return null;
    const inputs = joinSides(n.children[current.id]);
    current = inputs.length === 1 ? inputs[0] : undefined;
  }
  return null;
}

/** The one table size a step carries, in the shape readsManyKeepsFew takes. */
function stepTableRows(step: PlanStep): TableRows {
  if (step.tableRows === null || step.relation === null || step.relationSchema === null) {
    return {};
  }
  return { [`${step.relationSchema}.${step.relation}`]: step.tableRows };
}

/**
 * Why a whole-table read that raised no finding is the right plan, when that
 * is the reason: the filter keeps too large a share of a large table for an
 * index to help. Uses readsManyKeepsFew, the very test the whole-table rule
 * uses, so this sentence and that finding can never disagree.
 *
 * Says nothing for a scan that runs many times (the nested-loop rule has its
 * own view of that), one a LIMIT may stop early, or an estimated parallel
 * scan: its Plan Rows are one process's share while the table size is the
 * whole table, so the share worked out from them would be too small.
 */
function wholeReadReason(step: PlanStep, c: Counting, stopsEarly: boolean): string {
  if (step.nodeType !== "Seq Scan" || step.filter === null) return "";
  // No index could answer a filter that only tests a subquery, so there is
  // nothing to weigh the whole read against.
  if (testsOnlySubqueries(step.filter)) return "";
  if (stopsEarly || c.perRun) return "";
  if (!c.measured && (step.parallelAware || step.tableRows === null)) return "";
  const tableRows = stepTableRows(step);
  const scanned = rowsScanned(step, tableRows);
  if (scanned < LARGE_TABLE_ROWS || readsManyKeepsFew(step, tableRows)) return "";
  const kept = totalActualRows(step) ?? step.estimatedRows;
  const percent = Math.min(100, Math.round((kept / scanned) * 100));
  return percent > 50
    ? `; most of its rows match (about ${percent}%), so an index would not help ` +
        `and reading the whole table is the right plan`
    : `; about ${percent}% of its rows match, too many for an index to help, so ` +
        `reading the whole table is the right plan`;
}

/**
 * What a scan handed on: ", giving 750 rows", or ", and keeps the 312 where
 * …" when it has a filter. An estimate for a scan a LIMIT may stop early gets
 * no count: its Plan Rows are what a full read would find, not what the
 * stopped one will.
 */
function scanResult(step: PlanStep, c: Counting, stopsEarly: boolean): string {
  const cond = step.filter === null ? null : plainCondition(step.filter);
  if (!c.measured && stopsEarly) return cond === null ? "" : `, keeping those where ${cond}`;
  return cond === null ? givingClause(c) : keepsClause(c, cond);
}

/**
 * True for the repeated side of a nested loop that only asks whether a match
 * exists: a Semi join (EXISTS, IN) or an Anti join (NOT EXISTS). PostgreSQL
 * stops reading it at the first matching row. Its Plan Rows are what a full
 * read would find, so an estimate must not quote them as what it hands on.
 */
function stopsAtFirstMatch(n: Narration, step: PlanStep): boolean {
  if (step.parentId === null) return false;
  const parent = n.steps[step.parentId];
  if (parent.nodeType !== "Nested Loop") return false;
  if (parent.joinType !== "Semi" && parent.joinType !== "Anti") return false;
  return isInnerSide(step, n.children[parent.id]);
}

/**
 * The unit note after a scan's count. An estimated scan that may stop early
 * has no count (scanResult leaves it out), and "(in each process)" after no
 * number would qualify nothing; "(each time; …)" still says how often it runs.
 */
function scanNote(c: Counting, stopsEarly: boolean): string {
  return !c.measured && stopsEarly && !c.perRun ? "" : unitNote(c);
}

/**
 * A sequential scan: the whole table, or its start when it may stop early (a
 * LIMIT above it, or the repeated side of an EXISTS that stops at a match).
 */
function seqScanSentence(n: Narration, step: PlanStep, c: Counting): string {
  const where = tableWithAlias(step);
  const firstMatch = stopsAtFirstMatch(n, step);
  const stopsEarly = mayStopEarly(n.steps, step) || firstMatch;

  // Rows read, in the same unit as c.rows. Measured, what was really read.
  // Estimated, only a number that is known rather than guessed: Plan Rows
  // when there is no filter (the scan hands on everything it reads), the
  // catalog's size when there is one. Never for a parallel scan, whose Plan
  // Rows are one process's share, or for a scan that may stop early.
  let read: number | null = null;
  if (c.measured) {
    const perLoop = (step.actualRows ?? 0) + (rowsRemovedByFilter(step) ?? 0);
    read = c.perRun || c.perProcess ? perLoop : perLoop * (step.loops ?? 1);
  } else if (!stopsEarly && !step.parallelAware) {
    if (step.filter === null) read = step.estimatedRows;
    else if (step.tableRows !== null) read = rowsScanned(step, stepTableRows(step));
  }

  const empty = c.measured && read !== null && Math.round(read) === 0;
  let s: string;
  if (empty) {
    s = `Reads ${where} and finds it empty`;
  } else if (stopsEarly) {
    s = `Reads ${where} from the start until it ` +
      (firstMatch ? "finds a match" : "has enough rows");
    // "in all" only for a total: a count for one run or one process gets its
    // unit from the note at the end.
    if (c.measured && read !== null) {
      s += `, ${countPhrase(read, true)}${c.perRun || c.perProcess ? "" : " in all"}`;
    }
  } else if (c.measured && read !== null) {
    s = Math.round(read) === 1
      ? `Reads the one row of ${where}`
      : `Reads all ${countPhrase(read, true)} of ${where}`;
  } else {
    s = `Reads the whole of ${where}`;
    if (read !== null) s += `, ${countPhrase(read, false)}`;
  }
  if (step.parallelAware) s += ", split between the processes";
  if (step.filter !== null) {
    // An empty table has nothing for a filter to keep.
    if (!empty) s += scanResult(step, c, stopsEarly);
  } else if (read === null && !stopsEarly) {
    // Without a filter the rows handed on are the rows read, counted above,
    // except in an estimated parallel scan, which has no count of rows read.
    // It gets the rows it hands on instead: one process's share.
    s += givingClause(c);
  }
  return s + scanNote(c, stopsEarly) + wholeReadReason(step, c, stopsEarly);
}

/** An index lookup, or a read of the whole table in the index's order. */
function indexScanSentence(n: Narration, step: PlanStep, c: Counting): string {
  const where = tableWithAlias(step);
  const index = step.indexName === null ? "an index" : `the index ${step.indexName}`;
  const cond = detailValue(step, "Index Cond");
  const indexOnly = step.nodeType === "Index Only Scan";
  const firstMatch = stopsAtFirstMatch(n, step);
  const stopsEarly = mayStopEarly(n.steps, step) || firstMatch;

  let s: string;
  if (cond !== null) {
    s = indexOnly
      ? `Looks up the rows of ${where} where ${plainCondition(cond)} in ${index} alone, ` +
        `without reading the table`
      : `Looks up the rows of ${where} where ${plainCondition(cond)}, through ${index}`;
  } else {
    s = indexOnly
      ? `Reads ${index} of ${where} in order, without reading the table`
      : `Reads ${where} in the order of ${index}`;
  }
  if (firstMatch) s += ", stopping at the first match";
  else if (stopsEarly) s += ", stopping once it has enough rows";
  if (step.parallelAware) s += ", split between the processes";
  s += scanResult(step, c, stopsEarly) + scanNote(c, stopsEarly);

  // An index-only scan still visits the table for rows on pages changed since
  // the last VACUUM, and every such visit is the cost it exists to avoid.
  const heapFetches = Number(detailValue(step, "Heap Fetches") ?? "0");
  if (indexOnly && heapFetches > 0) {
    s += "; some rows still had to be checked in the table, because it has changed " +
      "since it was last vacuumed";
  }
  return s;
}

/** A bitmap scan: the index finds the rows, then the table is read for just those. */
function bitmapScanSentence(n: Narration, step: PlanStep, c: Counting): string {
  const where = tableWithAlias(step);
  // More than one index when PostgreSQL combined them (BitmapAnd / BitmapOr).
  const lookups = subtreeOf(n.steps, step).filter((s) => s.nodeType === "Bitmap Index Scan");
  const names = [
    ...new Set(lookups.map((s) => s.indexName).filter((x): x is string => x !== null)),
  ];
  const index =
    names.length === 0
      ? "an index"
      : names.length === 1
        ? `the index ${names[0]}`
        : `the indexes ${andList(names)}`;
  const cond = detailValue(step, "Recheck Cond") ?? lookups[0]?.joinCond ?? null;
  const firstMatch = stopsAtFirstMatch(n, step);
  const stopsEarly = mayStopEarly(n.steps, step) || firstMatch;

  let s =
    `Uses ${index} to find the rows of ${where}` +
    (cond === null ? "" : ` where ${plainCondition(cond)}`) +
    ", then reads just those rows from the table";
  if (firstMatch) s += ", stopping at the first match";
  if (step.parallelAware) s += ", split between the processes";
  return s + scanResult(step, c, stopsEarly) + scanNote(c, stopsEarly);
}

/** A join: which rows it pairs up, on what, and what came out. */
function joinSentence(n: Narration, step: PlanStep, c: Counting): string {
  const kids = n.children[step.id];
  const outer = outerSide(kids);
  const inner = joinSides(kids).find((k) => k !== outer);
  const outerName = inputName(n, outer);
  const innerName = inputName(n, inner) ?? "the other input";
  const each = outerName === null ? "each incoming row" : `each row of ${outerName}`;
  const hash = step.nodeType === "Hash Join";

  // What the rows are matched on. A hash or merge join can carry a Join
  // Filter on top of its main condition; a nested loop's Join Filter is its
  // only one (flattenPlan already put it in joinCond).
  const extra = step.nodeType === "Nested Loop" ? null : detailValue(step, "Join Filter");
  const conds = [step.joinCond, extra]
    .filter((x): x is string => x !== null)
    .map(plainCondition);
  const cond = conds.length === 0 ? null : conds.join(" and ");
  const on = cond === null ? "" : hash ? ` on ${cond}` : ` where ${cond}`;
  const matchIn = hash ? "the lookup table" : innerName;

  let s: string;
  switch (step.joinType) {
    case "Semi":
      s = `Keeps ${each} that has a match in ${matchIn}${on}`;
      break;
    case "Anti":
      s = `Keeps ${each} that has no match in ${matchIn}${on}`;
      break;
    // "Right" semi and anti joins keep rows of the second input instead.
    case "Right Semi":
      s = `Keeps each row of ${innerName} that has a match in ${outerName ?? "the incoming rows"}${on}`;
      break;
    case "Right Anti":
      s = `Keeps each row of ${innerName} that has no match in ${outerName ?? "the incoming rows"}${on}`;
      break;
    default:
      s = hash
        ? `Matches ${each} against the lookup table${on}`
        : step.nodeType === "Merge Join"
          ? `Walks the two sorted inputs side by side, pairing ${each} with the rows of ${innerName}${on}`
          : `Pairs ${each} with the matching rows of ${innerName}${on}`;
      if (step.joinType === "Left") {
        s += `, keeping ${outerName === null ? "incoming rows" : `the rows of ${outerName}`} ` +
          `that have no match too`;
      } else if (step.joinType === "Right") {
        s += `, keeping the rows of ${innerName} that have no match too`;
      } else if (step.joinType === "Full") {
        s += ", keeping the rows of both sides that have no match too";
      }
  }
  s += step.filter === null ? givingClause(c) : keepsClause(c, plainCondition(step.filter));
  return s + unitNote(c);
}

/** "count(*), sum(o.total) and 2 more": a list cut to three for a sentence. */
function shortList(items: string[]): string {
  if (items.length <= 3) return andList(items);
  return `${items.slice(0, 3).join(", ")} and ${items.length - 3} more`;
}

/** The entries of a list detail ("Group Key: a, b") in plain SQL. */
function detailList(step: PlanStep, key: string): string[] {
  const value = detailValue(step, key);
  return value === null ? [] : splitOutputList(value).map(plainCondition);
}

/**
 * Grouping columns as one phrase: "o.status", or "(o.status, o.region)" for
 * several, the way SQL writes a row of values. "by a and b and works out …"
 * would trip over its own "and".
 */
function keysPhrase(keys: string[]): string {
  if (keys.length === 1) return keys[0];
  const shown = keys.length > 3 ? [...keys.slice(0, 3), "…"] : keys;
  return `(${shown.join(", ")})`;
}

/** "count(*) DESC, o.id": a Sort Key in plain SQL, keeping each DESC or NULLS. */
function sortKeys(step: PlanStep): string {
  const value = detailValue(step, "Sort Key");
  if (value === null) return "";
  return splitOutputList(value)
    .map((key) => {
      const m = /^(.*?)((?: (?:ASC|DESC|NULLS FIRST|NULLS LAST))*)$/.exec(key);
      return m === null ? plainCondition(key) : plainCondition(m[1]) + m[2];
    })
    .join(", ");
}

/** ", giving 12 groups", counted in groups rather than rows. */
function groupsClause(c: Counting): string {
  return `, giving ${countOf(c, "group")}`;
}

/**
 * An aggregate: GROUP BY, a count, a sum. The aggregates come from the
 * step's Output (VERBOSE only); a plan without it still gets its grouping.
 * A HAVING clause shows up as the step's Filter.
 */
function aggregateSentence(step: PlanStep, c: Counting): string {
  const keys = detailList(step, "Group Key");
  const keySet = new Set(keys);
  // Output lists the grouping columns too; an aggregate is a call, with "(".
  // A partial aggregate prints each one as "PARTIAL count(*)".
  const aggs = splitOutputList(step.output)
    .map((entry) => plainCondition(entry.replace(/^PARTIAL /, "")))
    .filter((entry) => entry.includes("(") && !keySet.has(entry));
  const known = step.output.trim() !== "";
  const what = aggs.length > 0 ? shortList(aggs) : null;
  const by = keysPhrase(keys);
  const having = step.filter === null ? null : plainCondition(step.filter);

  if (step.partialMode === "Partial") {
    // The count per process is not worth a number: the Finalize step above
    // says what the query got.
    const partial = what === null ? "partial totals" : `a partial ${what}`;
    return keys.length > 0
      ? `In each process, groups its share of the rows by ${by} and works out ${partial} ` +
          `for each group`
      : `In each process, works out ${partial} over its share of the rows`;
  }
  if (step.partialMode === "Finalize") {
    let s = `Adds up the processes' partial results into the final ${what ?? "totals"}`;
    if (keys.length > 0) s += ` for each ${by}`;
    if (having !== null) s += keepsClause(c, having);
    else if (keys.length > 0) s += groupsClause(c);
    return s + unitNote(c);
  }
  let s: string;
  if (keys.length > 0) {
    if (what !== null) s = `Groups those rows by ${by} and works out ${what} for each group`;
    // No Output to read (a plan without VERBOSE): the aggregates are unknown.
    else if (!known) s = `Groups those rows by ${by}`;
    // Grouping with nothing to work out: a GROUP BY or DISTINCT.
    else s = `Keeps one row for each different ${by}`;
    s += having !== null ? keepsClause(c, having) : what !== null || !known ? groupsClause(c) : givingClause(c);
  } else {
    // No GROUP BY: one answer over every row, so no count worth giving.
    s = `Works out ${what ?? "the totals"} over all those rows`;
    if (having !== null) s += keepsClause(c, having);
  }
  return s + unitNote(c);
}

/** A sort, with what the measured run says about memory. */
function sortSentence(step: PlanStep, c: Counting): string {
  const keys = sortKeys(step);
  let s = keys === "" ? "Sorts those rows" : `Sorts those rows by ${keys}`;
  if (step.nodeType === "Incremental Sort") {
    s += ", a batch at a time, because they already arrive partly in that order";
  }
  const method = detailValue(step, "Sort Method") ?? "";
  if (method.startsWith("external")) {
    s += ", spilling to disk because they did not fit in the memory a sort may use (work_mem)";
  } else if (method === "top-N heapsort") {
    s += ", keeping only as many as the LIMIT above needs";
  }
  return s + unitNote(c);
}

/** A cache on the repeated side of a nested loop, with its hit count when measured. */
function memoizeSentence(n: Narration, step: PlanStep): string {
  const s =
    "Remembers the result of each lookup, so a repeated lookup is answered from memory " +
    "instead of being run again";
  // Each Memoize loop is one lookup; the step below runs only on a miss.
  const lookups = step.loops;
  const misses = joinSides(n.children[step.id])[0]?.loops ?? null;
  if (!n.measured || lookups === null || lookups === 0 || misses === null) return s;
  const hits = Math.max(0, lookups - misses);
  return (
    `${s}; ${fmtRows(hits)} of the ${countPhrase(lookups, true, "lookup")} ` +
    `${hits === 1 ? "was" : "were"} answered that way`
  );
}

/** A copy kept to be read again, usually for each row of a nested loop's other side. */
function materializeSentence(n: Narration, step: PlanStep): string {
  const s = "Keeps a copy of those rows, so they can be read again";
  if (step.parentId === null) return s;
  const parent = n.steps[step.parentId];
  const siblings = n.children[parent.id];
  if (parent.nodeType !== "Nested Loop" || !isInnerSide(step, siblings)) return s;
  const outerName = inputName(n, outerSide(siblings));
  return `${s} for each row of ${outerName ?? "the other side"}`;
}

/** A Result step: a one-time check, a computed answer, or nothing worth a line. */
function resultSentence(n: Narration, step: PlanStep, c: Counting): string | null {
  const oneTime = detailValue(step, "One-Time Filter");
  if (oneTime !== null) {
    const cond = plainCondition(oneTime);
    if (cond === "false") {
      return "Sees that the query's condition can never be true, so it hands back no rows " +
        "without reading anything";
    }
    // "WHERE EXISTS (…)" with no link to the outer row: an InitPlan answers
    // it. PostgreSQL 17 prints "(InitPlan 1).col1", which plainCondition
    // reads as "InitPlan 1" (its brackets go with the ones around the whole
    // condition); a NOT EXISTS is "NOT (InitPlan 1)".
    const sub = /^(NOT )?\(?((?:Init|Sub)Plan \d+)\)?$/.exec(cond);
    if (sub !== null) {
      const answer = sub[1] === undefined ? "true" : "false";
      return `Checks once that the answer of ${sub[2]} is ${answer}; nothing below runs unless it is`;
    }
    return `Checks once that ${cond} holds; nothing below runs unless it does`;
  }
  const kids = n.children[step.id];
  if (joinSides(kids).length === 0) {
    return kids.length > 0
      ? "Hands back the answer"
      : "Works out the answer without reading any table";
  }
  if (step.filter !== null) {
    return "Takes those rows" + keepsClause(c, plainCondition(step.filter)) + unitNote(c);
  }
  // Only computing the output columns of the step below: not worth a line.
  return null;
}

/** "generate_series(1, 10)": the call a Function Scan makes, or its name. */
function functionName(step: PlanStep): string {
  const call = detailValue(step, "Function Call");
  if (call !== null) return plainCondition(call);
  let name = step.label.replace(/^Function Scan on /, "");
  if (step.alias !== null && name.endsWith(` ${step.alias}`)) {
    name = name.slice(0, -(step.alias.length + 1));
  }
  return name;
}

/** The ModifyTable step of an INSERT, UPDATE, DELETE or MERGE. */
function modifySentence(step: PlanStep): string {
  const where = tableWithAlias(step);
  // labelOf puts the verb first: "Insert on orders".
  const verb = step.label.split(" ")[0];
  if (verb === "Insert") return `Inserts those rows into ${where}`;
  if (verb === "Update") return `Writes the changed rows back to ${where}`;
  if (verb === "Delete") return `Deletes those rows from ${where}`;
  return `Applies the ${verb.toUpperCase()} to ${where}`;
}

/**
 * The sentence for one step, or null when the step only passes rows along
 * and a line for it would be noise (the index half of a bitmap scan, a
 * Gather in the middle of a plan, a Result that only picks columns).
 */
function ownSentence(n: Narration, step: PlanStep, c: Counting): string | null {
  const kids = n.children[step.id];
  const stopsEarly = mayStopEarly(n.steps, step);
  switch (step.nodeType) {
    case "Seq Scan":
      return seqScanSentence(n, step, c);
    case "Index Scan":
    case "Index Only Scan":
      return indexScanSentence(n, step, c);
    case "Bitmap Heap Scan":
      return bitmapScanSentence(n, step, c);
    case "Bitmap Index Scan":
    case "BitmapAnd":
    case "BitmapOr":
      return null;
    case "Hash Join":
    case "Nested Loop":
    case "Merge Join":
      return joinSentence(n, step, c);
    case "Hash":
      // Without a parallel hash, every process builds the whole table itself.
      return step.parallelAware
        ? "Builds one shared lookup table from those rows, with the processes working together"
        : step.inParallel
          ? "Each process builds its own lookup table from those rows"
          : "Builds a lookup table from those rows";
    case "Sort":
    case "Incremental Sort":
      return sortSentence(step, c);
    case "Aggregate":
    case "HashAggregate":
    case "GroupAggregate":
      return aggregateSentence(step, c);
    case "Group": {
      const keys = detailList(step, "Group Key");
      const each = keys.length > 0 ? `each different ${keysPhrase(keys)}` : "each group";
      return `Keeps one row for ${each}` + givingClause(c) + unitNote(c);
    }
    case "Limit":
      return c.measured && Math.round(c.rows) === 0 && !c.underOne
        ? "Hands back no rows" + unitNote(c)
        : `Stops after handing back ${countOf(c)}` + unitNote(c);
    case "Unique":
      return "Drops the duplicate rows" + givingClause(c) + unitNote(c);
    case "Append":
      return `Puts the rows of those ${joinSides(kids).length} parts together, one after another` +
        givingClause(c) + unitNote(c);
    case "Merge Append":
      return `Merges those ${joinSides(kids).length} sorted parts into one sorted list` +
        givingClause(c) + unitNote(c);
    case "Materialize":
      return materializeSentence(n, step);
    case "Memoize":
      return memoizeSentence(n, step);
    case "Gather":
      // In the middle of a plan the step above says what it does with the
      // rows. At the top, this is where the query's own count lives.
      return step.parentId === null
        ? "Collects the rows from all the processes" + givingClause(c)
        : null;
    case "Gather Merge":
      return "Merges the processes' sorted rows into one sorted list" + givingClause(c);
    case "Result":
      return resultSentence(n, step, c);
    case "CTE Scan":
      return `Reads the saved result of ${cteWithAlias(step)}` +
        scanResult(step, c, stopsEarly) + scanNote(c, stopsEarly);
    case "Subquery Scan":
      if (step.filter === null) return null;
      return `Takes the rows of the subquery${step.alias === null ? "" : ` ${step.alias}`}` +
        keepsClause(c, plainCondition(step.filter)) + unitNote(c);
    case "Function Scan":
      return `Reads the rows the function ${functionName(step)} returns` +
        scanResult(step, c, stopsEarly) + scanNote(c, stopsEarly);
    case "Values Scan":
      return "Reads the rows written in the query's VALUES list" +
        scanResult(step, c, stopsEarly) + scanNote(c, stopsEarly);
    case "Sample Scan":
      return `Reads a random sample of ${tableWithAlias(step)} (TABLESAMPLE)` +
        scanResult(step, c, stopsEarly) + scanNote(c, stopsEarly);
    case "Tid Scan":
    case "Tid Range Scan":
      return `Fetches rows of ${tableWithAlias(step)} straight from where they are stored ` +
        `(by ctid)` + scanResult(step, c, stopsEarly) + scanNote(c, stopsEarly);
    case "Foreign Scan":
      return (step.relation === null
        ? "Fetches rows from another server"
        : `Fetches the rows of the foreign table ${tableWithAlias(step)}`) +
        scanResult(step, c, stopsEarly) + scanNote(c, stopsEarly);
    case "WindowAgg":
      return "Works out the window functions (the OVER clauses) for each of those rows" +
        unitNote(c);
    case "SetOp":
      return "Compares the rows of the two queries and keeps the ones the INTERSECT or " +
        "EXCEPT asks for" + givingClause(c) + unitNote(c);
    case "LockRows":
      return "Locks each of those rows as it hands them on (FOR UPDATE or FOR SHARE)";
    case "ProjectSet":
      return "Turns each of those rows into several, for a set-returning function in the " +
        "SELECT list" + givingClause(c) + unitNote(c);
    case "Recursive Union":
      return "Repeats the recursive part of the WITH query until it finds no new rows" +
        givingClause(c);
    case "WorkTable Scan":
      return "Reads the rows the previous round of the recursive query found" +
        givingClause(c) + unitNote(c);
    case "ModifyTable":
      return modifySentence(step);
    default:
      return `Runs a ${step.nodeType} step` + givingClause(c) + unitNote(c);
  }
}

/**
 * The sentence for one step, as ownSentence builds it, or null for a step
 * with nothing to add.
 *
 * A step the measured run never started (PostgreSQL's "never executed") is
 * the exception: its counts are all zero, and "reads public.customers and
 * finds it empty" would be false. It gets one sentence for itself and
 * everything below it instead, because nothing below a step that never
 * started ran either. That happens when no row ever needed it: the inner
 * side of a nested loop whose outer side came back empty, the lookup table of
 * a hash join with nothing to match against it, a part a LIMIT never reached.
 */
function sentenceFor(n: Narration, step: PlanStep): string | null {
  const c = countingOf(step, n.measured);
  if (!c.neverRan) return ownSentence(n, step, c);
  const names = [step, ...subtreeOf(n.steps, step)]
    .map((s) => (s.relation !== null ? tableWithAlias(s) : s.cteName !== null ? cteWithAlias(s) : null))
    .filter((name): name is string => name !== null);
  const unique = [...new Set(names)];
  return unique.length === 0
    ? `Did not need the step ${step.label}, so it never ran`
    : `Did not need to read ${andList(unique)}, so that part of the plan never ran`;
}

/**
 * A subquery the walk-through is inside: "InitPlan 1", "SubPlan 2", or a
 * WITH query. A subquery runs on its own schedule, not in the main query's
 * order, so the first sentence from it says when it runs, and every later one
 * carries its name so the reader knows it is still inside it.
 */
type SubqueryPart = {
  /** "InitPlan 1", or "The WITH query recent": as the plan's conditions name it. */
  name: string;
  /** ", which runs only once": when it runs, said once, on its first sentence. */
  when: string;
  /** True once a sentence has said `when`. Set by inPart. */
  introduced: boolean;
};

/**
 * The subquery that starts at this step, or null when the step is not the
 * top of one. PostgreSQL marks the top step of each: "InitPlan" for one with
 * no link to the outer row (it runs once), "SubPlan" for one that uses the
 * outer row (it runs for each row, unless PostgreSQL "hashed" it: then it ran
 * once and its rows were kept in a lookup table). A WITH query that is kept
 * and read back comes as an InitPlan named "CTE <name>".
 */
function partStartedBy(n: Narration, step: PlanStep): SubqueryPart | null {
  if (step.parentId === null) return null;
  const relationship = step.parentRelationship;
  if (relationship !== "InitPlan" && relationship !== "SubPlan") return null;

  const cte = /^CTE (.+)$/.exec(step.subplanName ?? "");
  if (cte !== null) {
    return {
      name: `The WITH query ${cte[1]}`,
      when: ", worked out once and kept for the steps that read it",
      introduced: false,
    };
  }
  const name = step.subplanName ?? "A subquery";
  if (relationship === "InitPlan") {
    // An InitPlan runs again only when a value it takes from an outer query
    // changes (one inside a SubPlan, say). A measured run shows that as more
    // than one loop, and "runs only once" would then be false.
    const loops = step.loops ?? 1;
    return {
      name,
      when: n.measured && loops > 1 ? `, which ran ${fmtRows(loops)} times` : ", which runs only once",
      introduced: false,
    };
  }
  if (step.hashedSubplan) {
    return {
      name,
      when: ", which runs once and keeps its rows in a lookup table",
      introduced: false,
    };
  }
  // The rows it runs for are the rows of the step it hangs off. Named when
  // that step reads a table; "for each row" alone otherwise, rather than a
  // guess at which rows those are.
  const parent = n.steps[step.parentId];
  const of =
    parent.relation !== null
      ? ` of ${tableWithAlias(parent)}`
      : parent.cteName !== null
        ? ` of ${cteWithAlias(parent)}`
        : "";
  return { name, when: `, which runs once for each row${of}`, introduced: false };
}

/** "Reads …" → "reads …", for a sentence that follows "InitPlan 1: ". */
function lowerFirst(sentence: string): string {
  return /^[A-Z][a-z]/.test(sentence) ? sentence[0].toLowerCase() + sentence.slice(1) : sentence;
}

/** A sentence inside a subquery, with the subquery's name (and, the first time, when it runs). */
function inPart(part: SubqueryPart | null, sentence: string): string {
  if (part === null) return sentence;
  const head = part.introduced ? part.name : `${part.name}${part.when}`;
  part.introduced = true;
  return `${head}: ${lowerFirst(sentence)}`;
}

/** A full stop, unless the sentence already ends in one or in a cut-short "…". */
function asSentence(text: string): string {
  return /[.…]$/.test(text) ? text : `${text}.`;
}

/**
 * The steps directly below `step`, in the order they do their work.
 *
 *   - Subqueries first. An InitPlan runs once and its answer is used below.
 *     A SubPlan runs for each row, and telling it first means the sentence
 *     that uses it ("keeps the rows where (SubPlan 1) > 5") comes after the
 *     one that says what it is. It also keeps a step's own inputs right
 *     before the step, so its "those rows" always means their rows.
 *   - A hash join's Hash side before the side that probes it: the lookup
 *     table is built in full before any row of the other side is matched.
 *   - Everything else in plan order: a nested loop reads its outer side and
 *     repeats its inner side for each of those rows; a merge join reads its
 *     two sorted inputs side by side; an Append reads its parts in turn.
 */
function executionOrder(
  n: Narration,
  step: PlanStep
): { subqueries: PlanStep[]; inputs: PlanStep[] } {
  const kids = n.children[step.id];
  const initPlans = kids.filter((k) => k.parentRelationship === "InitPlan");
  const subPlans = kids.filter((k) => k.parentRelationship === "SubPlan");
  let inputs = joinSides(kids);
  if (step.nodeType === "Hash Join") {
    const hash = inputs.find((k) => k.nodeType === "Hash");
    if (hash !== undefined) inputs = [hash, ...inputs.filter((k) => k !== hash)];
  }
  return { subqueries: [...initPlans, ...subPlans], inputs };
}

/**
 * The plan as a short account in plain words: one sentence for each step
 * that does something, in the order the server does it, with the query's own
 * tables, conditions, row counts and repeat counts filled in.
 *
 * The screen prints the plan top-down, the way EXPLAIN does, which is the
 * reverse of the order it runs in. Reading it bottom-up is a skill a non-DBA
 * does not have: which side of a hash join is built first, that an InitPlan
 * runs once, that a SubPlan runs for every row. This walks the tree children
 * before parents, in the order executionOrder gives, and says each of those
 * things in words.
 *
 * A measured plan gives the counts the run saw; an estimate says "about". A
 * step that only passes rows along (a Gather in the middle of a plan, a Result
 * that only picks columns, the index half of a bitmap scan) gets no sentence:
 * the sentence next to it already covers what it does.
 */
export function explainInWords(summary: PlanSummary): string[] {
  const steps = summary.steps;
  if (steps.length === 0) return [];
  const n: Narration = { steps, children: childrenById(steps), measured: summary.measured };
  const lines: string[] = [];

  function visit(step: PlanStep, part: SubqueryPart | null): void {
    const started = partStartedBy(n, step);
    const mine = started ?? part;
    const neverRan = countingOf(step, n.measured).neverRan;

    if (neverRan && started !== null) {
      // A whole subquery the run never needed: one sentence, by its name.
      lines.push(asSentence(`${started.name} was never needed, so it never ran`));
      return;
    }
    const say = (): void => {
      const sentence = sentenceFor(n, step);
      if (sentence !== null) lines.push(asSentence(inPart(mine, sentence)));
    };
    // Nothing below a step that never started ran either, and sentenceFor
    // covers the whole of it in one sentence.
    if (neverRan) {
      say();
      return;
    }
    const { subqueries, inputs } = executionOrder(n, step);
    for (const child of subqueries) visit(child, mine);
    // A One-Time Filter (a Result guarding its input, e.g. an uncorrelated
    // WHERE EXISTS) is checked before a single input row is read, and when it
    // fails the input never runs. So that step's sentence comes first.
    const checksFirst = detailValue(step, "One-Time Filter") !== null;
    if (checksFirst) say();
    for (const child of inputs) visit(child, mine);
    if (!checksFirst) say();
  }

  visit(steps[0], null);
  return lines;
}

/** What a plan box prints under its label. */
export type StepFigures = {
  /** "1,204 rows", "~1,204 rows (estimate)", "1 row each time", "never ran". */
  rows: string;
  /** "ran 5,000 times", "in 3 processes", "runs ~5,000 times (estimate)", or null. */
  runs: string | null;
};

/**
 * A step's row count and repeat count, worded for the plan tree and the step
 * list. Uses countingOf, the same reading of the numbers the walk-through
 * uses, so a box and its sentence can never disagree about what a count is a
 * count of: a total, one run of a repeated step, or one helper process.
 */
export function stepFigures(step: PlanStep, measured: boolean): StepFigures {
  const c = countingOf(step, measured);
  if (c.neverRan) return { rows: "never ran", runs: null };
  const unit = c.perRun ? " each time" : c.perProcess ? " per process" : "";
  if (c.measured) {
    const runs = fmtRows(c.runs ?? 0);
    // An average PostgreSQL rounded to 0 is not "0 rows": see countOf.
    const rows = !c.underOne
      ? rowsWord(c.rows)
      : c.perRun || c.perProcess
        ? "under 1 row"
        : `at most ${rowsWord(mostRowsFound(c))}`;
    return {
      rows: `${rows}${unit}`,
      runs: c.perRun ? `ran ${runs} times` : c.perProcess ? `in ${runs} processes` : null,
    };
  }
  return {
    rows: `~${rowsWord(c.rows)}${unit} (estimate)`,
    // Null when the plan repeats the step but cannot say how often.
    runs: c.perRun && c.runs !== null ? `runs ~${fmtRows(c.runs)} times (estimate)` : null,
  };
}

/**
 * The caption over the top box of a subquery in the plan tree, e.g.
 * "SubPlan 1: runs once for each row". Null for any other step. Says the
 * same as the walk-through's first sentence for that subquery, shorter.
 */
export function subqueryCaption(step: PlanStep): string | null {
  const relationship = step.parentRelationship;
  if (relationship !== "InitPlan" && relationship !== "SubPlan") return null;
  const cte = /^CTE (.+)$/.exec(step.subplanName ?? "");
  if (cte !== null) return `WITH query ${cte[1]}: worked out once, then kept`;
  const name = step.subplanName ?? "Subquery";
  if (relationship === "InitPlan") {
    // Measured more than once, it takes a value from an outer query (it sits
    // inside a SubPlan, say), and "only once" would be false. The walk-through
    // says the same (partStartedBy).
    const loops = step.loops ?? 1;
    return loops > 1 ? `${name}: ran ${fmtRows(loops)} times` : `${name}: runs only once`;
  }
  return step.hashedSubplan
    ? `${name}: runs once, kept as a lookup table`
    : `${name}: runs once for each row`;
}

// ── What the plan tells the text rules ───────────────────────────────────────

/** One table the plan reads, as the text rules need it. */
export type SqlContextTable = {
  /** Null when the plan was taken without VERBOSE and gave no schema. */
  schema: string | null;
  name: string;
  /** The name the query gave it ("o" in `FROM orders o`), or null. */
  alias: string | null;
  /**
   * Roughly how many rows the table holds: the catalog's count, or what a
   * whole-table read of it handed on, whichever is larger (the fresher one).
   */
  rows: number;
  /** The step's Filter, verbatim, or null. */
  filter: string | null;
  /**
   * True when the step reads every row of the table: a sequential or index
   * scan with no Filter and no index condition to narrow it.
   */
  readsAll: boolean;
  /**
   * True when the plan reads this table in full to keep a small share of it,
   * judged as the seq-scan rule judges it: where an index on what the Filter
   * compares would pay.
   */
  selectiveScan: boolean;
  /**
   * The condition an index answers for this step, verbatim: an index scan's
   * Index Cond, or a bitmap heap scan's Recheck Cond. Null when no index
   * narrows the read.
   */
  indexCond: string | null;
  /** Column name → type, from the catalog. Empty when unknown. */
  columnTypes: Record<string, string>;
};

/**
 * What the plan and the catalog say about a query that its text cannot:
 * how many rows come back, how big each table is, which columns are primary
 * keys, and how hard the planner tries with many joins.
 *
 * The route builds it with sqlContextFromPlan and hands it to readSql, so a
 * text rule can judge the query by its real size rather than its shape alone.
 * Every rule works without one, taking its quietest reading.
 */
export type SqlContext = {
  /** Rows the query returns: counted when it ran, else the planner's estimate. */
  expectedRows: number;
  /** True when the query actually ran, so expectedRows was counted. */
  measured: boolean;
  /** Every table the plan reads, once per name it is read under. */
  tables: SqlContextTable[];
  /**
   * How many of those tables the query joins together. Leaves out the
   * partitions of one partitioned table and the branches of a UNION ALL:
   * the server reads those one after another, it does not join them.
   */
  joinedTables: number;
  /** What the top step hands back, one entry per column, as the plan writes it. */
  outputColumns: string[];
  /** Primary-key columns per table, keyed "schema.table". */
  primaryKeys: Record<string, string[]>;
  /** The planner's join settings, or null when they could not be read. */
  settings: PlannerSettings | null;
  /** The top step's type, below any Limit or Sort: "Aggregate", "Unique", … */
  topNodeType: string | null;
  /**
   * Rows into and out of a DISTINCT at the top of the plan, when the query
   * ran and no LIMIT above it cut the run short.
   */
  distinctRows: { input: number; output: number } | null;
  /**
   * True when a step can hand on one row of a table more than once: any join
   * (a join to generate_series or a VALUES list reads no table, so the table
   * count misses it), or a set-returning function in the select list
   * (`unnest(tags)`), which the plan shows as a ProjectSet step.
   */
  repeatsRows: boolean;
  /** Every relation name in each schema, for naming a new index. */
  relationNames: Record<string, string[]>;
};

/** Steps that only reorder or cut the result, and say nothing about its shape. */
const RESULT_ORDER_NODES: ReadonlySet<string> = new Set(["Limit", "Sort", "Incremental Sort"]);

/**
 * Scans that read every row of a table when nothing narrows them. A Sample
 * Scan (TABLESAMPLE) reads only part of one, and a bitmap scan always has a
 * condition.
 */
const WHOLE_TABLE_SCANS: ReadonlySet<string> = new Set(["Seq Scan", "Index Scan", "Index Only Scan"]);

/** Steps that can hand on one input row more than once. */
const REPEATING_STEPS: ReadonlySet<string> = new Set([
  "Nested Loop",
  "Hash Join",
  "Merge Join",
  "ProjectSet",
]);

/** The step feeding this one: its Outer input, or its only one. */
function mainInput(steps: PlanStep[], step: PlanStep): PlanStep | undefined {
  const children = childrenOfStep(steps, step);
  return children.find((c) => c.parentRelationship === "Outer") ?? children[0];
}

/**
 * "o.id, lower((o.email)::text), 'a, b'::text" → its three entries.
 * Splits at commas outside brackets and quotes.
 */
function splitOutputList(output: string): string[] {
  const entries: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < output.length; i += 1) {
    const ch = output[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "(" || ch === "[") {
      depth += 1;
    } else if (ch === ")" || ch === "]") {
      depth -= 1;
    } else if (ch === "," && depth === 0) {
      entries.push(output.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = output.slice(start).trim();
  if (last !== "") entries.push(last);
  return entries;
}

/**
 * The columns the select-star fix lists, or [] to ask for them in words.
 *
 * The plan's Output says what the top of the query hands back. When the
 * query reads its tables directly, each entry is a column as the query can
 * write it: id, or o.id in a join. Through a view or a subquery in FROM it is
 * what the column is worked out from instead: a column of a table the query
 * never names, or an expression such as pg_cancel_backend(0). The name the
 * view or subquery gives the column is not in the plan at all, and putting
 * those entries in place of the * would not run. So the list is offered only
 * when every entry is a plain column, of a table the query itself names
 * outside any brackets.
 */
function starColumns(sql: string, context: SqlContext | undefined): string[] {
  const columns = context?.outputColumns ?? [];
  if (context === undefined || columns.length === 0) return [];

  // Every name the query writes outside brackets, as the server knows it:
  // an unquoted name folds to lower case, a quoted one keeps its own.
  const topNames = new Set<string>();
  let depth = 0;
  for (const token of tokenize(maskNonCode(sql, { keepQuotedNames: true }))) {
    if (token.text === "(") depth += 1;
    else if (token.text === ")") depth -= 1;
    else if (depth === 0 && token.kind === "ident") topNames.add(token.text.toLowerCase());
    else if (depth === 0 && token.kind === "qident") topNames.add(token.text);
  }

  const tablesNamed = context.tables.every(
    (table) => topNames.has(table.name) || (table.alias !== null && topNames.has(table.alias))
  );
  const isName = (token: Token) => token.kind === "ident" || token.kind === "qident";
  const allPlain = columns.every((entry) => {
    const t = tokenize(entry);
    if (t.length === 1) return isName(t[0]);
    return (
      t.length === 3 && isName(t[0]) && t[1].text === "." && isName(t[2]) && topNames.has(t[0].text)
    );
  });
  return tablesNamed && allPlain ? columns : [];
}

/**
 * Gather what the text rules can use from a plan the route has already read.
 *
 * Pure: everything comes from `plan` and `catalog`, so it runs in a test the
 * same way it runs in the route, and adds no query against the server.
 */
export function sqlContextFromPlan(
  plan: PlanSummary,
  catalog: Partial<PlanCatalog> = {}
): SqlContext {
  const steps = plan.steps;
  const head = steps[0];
  const tableRows = catalog.tableRows ?? {};

  const tables: SqlContextTable[] = [];
  const seen = new Set<string>();
  let joinedTables = 0;
  for (const step of steps) {
    if (step.relation === null) continue;
    const key = JSON.stringify([step.relationSchema, step.relation, step.alias]);
    if (seen.has(key)) continue;
    seen.add(key);
    // "Member" marks one input of an Append: a partition, or one branch of
    // a UNION ALL. Those are read in turn, not joined, so they are not
    // counted as tables in a join.
    if (step.parentRelationship !== "Member") joinedTables += 1;
    const known =
      step.relationSchema === null ? undefined : tableRows[`${step.relationSchema}.${step.relation}`];
    // A whole-table read with no filter hands on every row it reads, so
    // what it handed on is the table's size, and fresher than the catalog.
    const wholeTable = step.nodeType === "Seq Scan" && step.filter === null;
    const handedOn = totalActualRows(step) ?? step.estimatedRows;
    tables.push({
      schema: step.relationSchema,
      name: step.relation,
      alias: step.alias,
      rows: wholeTable ? Math.max(known ?? 0, handedOn) : (known ?? step.estimatedRows),
      filter: step.filter,
      // joinCond holds an index scan's Index Cond, which narrows it too.
      readsAll: WHOLE_TABLE_SCANS.has(step.nodeType) && step.filter === null && step.joinCond === null,
      selectiveScan: readsManyKeepsFew(step, tableRows),
      // A bitmap heap scan keeps its index's condition as the Recheck Cond.
      indexCond: step.joinCond ?? detailValue(step, "Recheck Cond"),
      columnTypes: columnTypesFor(catalog, step.relationSchema, step.relation),
    });
  }

  const primaryKeys: Record<string, string[]> = {};
  for (const [key, indexes] of Object.entries(catalog.indexes ?? {})) {
    const primary = indexes.find((index) => index.primary);
    if (!primary) continue;
    const columns = primary.columns.filter((c): c is string => c !== null);
    if (columns.length > 0 && columns.length === primary.columns.length) primaryKeys[key] = columns;
  }

  let top: PlanStep | undefined = head;
  let limited = false;
  while (top !== undefined && RESULT_ORDER_NODES.has(top.nodeType)) {
    if (top.nodeType === "Limit") limited = true;
    top = mainInput(steps, top);
  }

  // Rows in and out of a top-level DISTINCT, which PostgreSQL runs as a
  // Unique step or as a grouping Aggregate. Not across a Gather: the
  // parallel workers below it may already have dropped duplicates, and the
  // two counts would then match even though DISTINCT did real work.
  let distinctRows: SqlContext["distinctRows"] = null;
  const groups =
    top !== undefined &&
    (top.nodeType === "Unique" ||
      (top.nodeType === "Aggregate" && detailValue(top, "Group Key") !== null));
  // Nor under a LIMIT, which stops the DISTINCT once it has enough rows: its
  // counts then cover only the rows read up to that point.
  if (plan.measured && !limited && top !== undefined && groups) {
    const input = mainInput(steps, top);
    const inRows = input === undefined ? null : totalActualRows(input);
    const outRows = totalActualRows(top);
    const gathered = input !== undefined && input.nodeType.startsWith("Gather");
    if (inRows !== null && outRows !== null && !gathered) {
      distinctRows = { input: inRows, output: outRows };
    }
  }

  return {
    expectedRows: plan.measured ? (head ? totalActualRows(head) ?? 0 : 0) : plan.estimatedRows,
    measured: plan.measured,
    tables,
    joinedTables,
    outputColumns: head ? splitOutputList(head.output) : [],
    primaryKeys,
    settings: catalog.settings ?? null,
    topNodeType: top?.nodeType ?? null,
    distinctRows,
    repeatsRows: steps.some((step) => REPEATING_STEPS.has(step.nodeType)),
    relationNames: catalog.relationNames ?? {},
  };
}

// ── Part three: the query text ───────────────────────────────────────────────

/**
 * Find every place a keyword appears as real code.
 *
 * Scanning happens on the masked copy — comments, string literals and quoted
 * identifiers are blanked there — while the positions it returns are equally
 * valid in the original, because maskNonCode preserves length. That is what
 * lets a rule below look at what a literal actually CONTAINS (the wildcard
 * rule needs to) without ever mistaking a commented-out line for live SQL.
 */
function codeMatches(mask: string, pattern: RegExp): CodeMatch[] {
  const flags = pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g";
  const re = new RegExp(pattern.source, flags);
  const out: CodeMatch[] = [];
  let match = re.exec(mask);
  while (match !== null) {
    out.push({ index: match.index, end: match.index + match[0].length });
    // A zero-width match would otherwise spin here forever.
    if (match.index === re.lastIndex) re.lastIndex += 1;
    match = re.exec(mask);
  }
  return out;
}

/** Where a keyword sits, and where it stops — both valid in the original too. */
type CodeMatch = { index: number; end: number };

/** True when the keyword appears anywhere outside a comment or a literal. */
function inCode(mask: string, pattern: RegExp): boolean {
  return codeMatches(mask, pattern).length > 0;
}

/**
 * How deep in parentheses a position is, counting from the start of the mask.
 *
 * The mask has already blanked string literals and comments, so every bracket
 * left is real syntax.
 */
function parenDepthAt(mask: string, index: number): number {
  let depth = 0;
  for (let i = 0; i < index && i < mask.length; i += 1) {
    if (mask[i] === "(") depth += 1;
    else if (mask[i] === ")") depth = Math.max(0, depth - 1);
  }
  return depth;
}

/** Where a WHERE clause stops. Anything past one of these is a different clause. */
const CLAUSE_END = /\b(?:GROUP\s+BY|HAVING|WINDOW|ORDER\s+BY|LIMIT|OFFSET|FETCH|UNION|INTERSECT|EXCEPT|RETURNING)\b/i;

/**
 * Where each WHERE clause in the statement starts and stops.
 *
 * A clause runs from the keyword to whichever comes first: the next clause
 * keyword, a semicolon, or the end. Rules that ask "is this condition shaped
 * badly" have to read one clause, not the whole statement. Positions, not
 * text, so a rule can quote the original words back.
 */
function whereClauses(mask: string): { start: number; end: number }[] {
  return codeMatches(mask, /\bWHERE\b/i).map((m) => {
    const rest = mask.slice(m.end);
    const stop = CLAUSE_END.exec(rest);
    const semi = rest.indexOf(";");
    const length = Math.min(stop ? stop.index : rest.length, semi === -1 ? rest.length : semi);
    return { start: m.end, end: m.end + length };
  });
}

/** Matches outside every bracket: the main statement's own clauses. */
function topLevelMatches(mask: string, pattern: RegExp): CodeMatch[] {
  return codeMatches(mask, pattern).filter((m) => parenDepthAt(mask, m.index) === 0);
}

/** True when the keyword appears outside every bracket. */
function atTopLevel(mask: string, pattern: RegExp): boolean {
  return topLevelMatches(mask, pattern).length > 0;
}

/**
 * Where the bracket around a position opens: the index just after its "(",
 * or 0 when the position is inside no bracket at all.
 */
function groupStart(mask: string, index: number): number {
  let depth = 0;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (mask[i] === ")") depth += 1;
    else if (mask[i] === "(") {
      if (depth === 0) return i + 1;
      depth -= 1;
    }
  }
  return 0;
}

/**
 * The word written just before the bracket around a position, in capitals:
 * "EXISTS" for the SELECT in `EXISTS (SELECT …)`. Null outside brackets.
 */
function wordBeforeGroup(mask: string, index: number): string | null {
  const start = groupStart(mask, index);
  if (start === 0) return null;
  const word = /([A-Za-z_]+)\s*$/.exec(mask.slice(0, start - 1));
  return word ? word[1].toUpperCase() : null;
}

/**
 * True when a position sits in the SELECT of a bracketed branch of the main
 * statement: either side of `(SELECT * FROM a) UNION (SELECT * FROM b)`, or a
 * whole statement written in brackets. Such a branch's select list is what
 * comes back, just as if the brackets were not there.
 *
 * A bracket after FROM, IN, EXISTS, AS, JOIN and so on is a subquery instead,
 * and does not count; nor does a branch of a UNION that is itself inside one.
 */
function inSetOperationBranch(mask: string, index: number): boolean {
  let start = groupStart(mask, index);
  // The bracket right around the position has to open the SELECT itself.
  if (start === 0 || !/^\s*SELECT\b/i.test(mask.slice(start))) return false;
  // Then every bracket out to the top has to stand where a branch can: first
  // in the statement (or in an outer branch), straight after UNION,
  // INTERSECT or EXCEPT (with ALL or DISTINCT), or after a WITH list, as in
  // `WITH x AS (…) (SELECT * FROM x)`.
  while (start > 0) {
    const open = start - 1; // the "(" itself
    const outer = groupStart(mask, open);
    const before = mask.slice(outer, open);
    const first = /^\s*$/.test(before);
    const afterSetOperation = /(?:^|[^\w$])(?:UNION|INTERSECT|EXCEPT)(?:\s+(?:ALL|DISTINCT))?\s*$/i.test(
      before
    );
    const afterWithList = /^\s*WITH\b/i.test(before) && /\)\s*$/.test(before);
    if (!first && !afterSetOperation && !afterWithList) return false;
    start = outer;
  }
  return true;
}

/** Where one FROM list stops: the next clause, tried at one position. */
const FROM_LIST_END =
  /(?:WHERE|GROUP\s+BY|HAVING|WINDOW|ORDER\s+BY|LIMIT|OFFSET|FETCH|UNION|INTERSECT|EXCEPT|FOR)\b/iy;

/** True when the text at `from` opens a subquery: `(SELECT …)` or `LATERAL (…)`. */
function startsSubquery(mask: string, from: number): boolean {
  return /^\s*(?:LATERAL\s*)?\(/i.test(mask.slice(from, from + 200));
}

/**
 * How many items the FROM list starting at `start` names. Subqueries are
 * left out unless `countSubqueries` is set.
 */
function fromItems(mask: string, start: number, countSubqueries = false): number {
  let items = 0;
  let itemStart = start;
  let depth = 0;
  for (let i = start; i < mask.length; i += 1) {
    const ch = mask[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      // A bracket closing the group the FROM list sits in ends the list.
      if (depth === 0) break;
      depth -= 1;
    } else if (depth === 0) {
      if (ch === ";") break;
      if (ch === ",") {
        if (countSubqueries || !startsSubquery(mask, itemStart)) items += 1;
        itemStart = i + 1;
        continue;
      }
      FROM_LIST_END.lastIndex = i;
      if (!/\w/.test(mask[i - 1] ?? "") && FROM_LIST_END.test(mask)) break;
    }
  }
  if (countSubqueries || !startsSubquery(mask, itemStart)) items += 1;
  return items;
}

/**
 * How many tables the text names in its FROM lists and JOINs.
 *
 * A heuristic, used beside the plan's own count: each FROM that belongs to a
 * SELECT adds one per comma-separated item, and each JOIN adds one. An item
 * or JOIN that opens a subquery is not counted, because the subquery's own
 * FROM counts its tables. The FROM in `EXTRACT(YEAR FROM d)` or
 * `IS DISTINCT FROM` is not a table list at all, and is skipped.
 */
function tablesInText(mask: string): number {
  let count = 0;
  for (const join of codeMatches(mask, /\bJOIN\b/i)) {
    if (!startsSubquery(mask, join.end)) count += 1;
  }
  for (const from of codeMatches(mask, /\bFROM\b/i)) {
    if (/\bDISTINCT\s*$/i.test(mask.slice(Math.max(0, from.index - 40), from.index))) continue;
    // Only a FROM with a SELECT of its own, inside the same brackets.
    const before = mask.slice(groupStart(mask, from.index), from.index);
    const ownSelect = codeMatches(before, /\bSELECT\b/i).some(
      (m) => parenDepthAt(before, m.index) === 0
    );
    if (ownSelect) count += fromItems(mask, from.end);
  }
  return count;
}

/**
 * True when the main statement's FROM list joins one thing to another: a
 * JOIN outside every bracket, or a comma between two items of a top-level
 * FROM list. Here a subquery, a function or VALUES counts as an item, since
 * each can repeat the rows it is joined to. The FROM of `IS DISTINCT FROM`
 * is not a FROM list, and is skipped.
 */
function joinsAtTopLevel(mask: string): boolean {
  if (atTopLevel(mask, /\bJOIN\b/i)) return true;
  return topLevelMatches(mask, /\bFROM\b/i).some(
    (m) =>
      !/\bDISTINCT\s*$/i.test(mask.slice(Math.max(0, m.index - 40), m.index)) &&
      fromItems(mask, m.end, true) > 1
  );
}

/**
 * The statement ready to paste, ending in one semicolon, with `clause`
 * ("LIMIT 100", say) added on a line of its own when one is given.
 *
 * Null when something other than comments follows the first semicolon: that
 * is a second statement, and an added clause would land in the wrong one.
 */
function finishedStatement(sql: string, clause: string | null = null): string | null {
  const mask = maskNonCode(sql);
  const semi = mask.indexOf(";");
  if (semi !== -1 && mask.slice(semi + 1).trim() !== "") return null;
  const body = (semi === -1 ? sql : sql.slice(0, semi)).trimEnd();
  // Anything added goes on a new line when the last line might end in a
  // `--` comment, which would otherwise swallow it.
  if (clause !== null) return `${body}\n${clause};`;
  return /--[^\n]*$/.test(body) ? `${body}\n;` : `${body};`;
}

/** The statement with the DISTINCT keyword that ends at `end` taken out. */
function withoutDistinct(sql: string, end: number): string {
  const start = end - "DISTINCT".length;
  return sql.slice(0, start) + sql.slice(end).replace(/^[ \t]+/, "");
}

/** "1.2 million", "48,000": a row count the way a person says it. */
function countInWords(n: number): string {
  const oneDecimal = (x: number) => String(Math.round(x * 10) / 10);
  if (n >= 1e9) return `${oneDecimal(n / 1e9)} billion`;
  if (n >= 1e6) return `${oneDecimal(n / 1e6)} million`;
  return fmtRows(n);
}

/** A list as `--` comment lines of about 72 characters, broken after commas. */
function commentLines(items: string[]): string {
  const lines: string[] = [];
  let line = "";
  for (const item of items.map(oneLine)) {
    const next = line === "" ? item : `${line}, ${item}`;
    if (line !== "" && next.length > 68) {
      lines.push(`${line},`);
      line = item;
    } else {
      line = next;
    }
  }
  if (line !== "") lines.push(line);
  return lines.map((l) => `--   ${l}`).join("\n");
}

/**
 * A result this small comes back in one go. Returning all of it, or sorting
 * all of it, costs too little to be worth a finding, so the missing-WHERE and
 * ORDER BY rules stay quiet below it.
 */
export const SMALL_RESULT_ROWS = 1_000;

/**
 * Tables in one query from which the join order is worth a look. Six tables
 * can be joined in hundreds of orders, and a wrong row estimate for an early
 * join is carried through every join after it.
 */
export const MANY_JOINS = 6;

/**
 * PostgreSQL's own defaults for the settings that decide how hard the planner
 * works on many joins. Used, and named as the defaults, when the server's
 * values could not be read.
 */
export const DEFAULT_PLANNER_SETTINGS: PlannerSettings = {
  joinCollapseLimit: 8,
  geqoThreshold: 12,
  geqo: true,
};

/** One comparison in a Filter the plan applies, and the table it filters. */
type FilterAtom = { table: SqlContextTable; left: Token[]; op: string; right: Token[] };

/**
 * Every comparison in every Filter the plan applies, as `split` cuts each
 * Filter into conditions. None without a context.
 */
function filterAtoms(
  context: SqlContext | undefined,
  split: (tokens: Token[]) => Token[][]
): FilterAtom[] {
  const atoms: FilterAtom[] = [];
  for (const table of context?.tables ?? []) {
    if (table.filter === null) continue;
    for (const condition of split(tokenize(table.filter))) {
      const cmp = comparisonOf(condition);
      if (cmp !== null) atoms.push({ table, ...cmp });
    }
  }
  return atoms;
}

/** The ANDed conditions, or none when an OR joins them: no one index answers an OR. */
function andedConditions(tokens: Token[]): Token[][] {
  const top = stripOuterParens(tokens);
  return splitTop(top, "OR").length > 1 ? [] : andParts(top);
}

/**
 * `lower(o.email)` or `upper((o.code)::text)` → the function and the column,
 * when one side of a comparison is exactly that, or null.
 */
function wrappedColumn(
  side: Token[],
  quals: string[],
  columnTypes: Record<string, string>
): { fn: "lower" | "upper"; column: string } | null {
  const t = stripOuterParens(side);
  if (t.length < 4 || t[0].kind !== "ident" || t[1].text !== "(") return null;
  if (closingIndex(t, 1) !== t.length - 1) return null;
  const name = t[0].text.toLowerCase();
  const fn = name === "lower" || name === "upper" ? name : null;
  if (fn === null) return null;
  const column = columnOf(t.slice(2, -1), quals, columnTypes);
  return column === null ? null : { fn, column };
}

/** record[key], but only a key the record holds itself, never a built-in such as "constructor". */
function ownValue<T>(record: Record<string, T> | undefined, key: string): T | undefined {
  if (record === undefined || !Object.prototype.hasOwnProperty.call(record, key)) return undefined;
  return record[key];
}

/** The aggregate functions people use most, as they appear in a select list. */
const AGGREGATE_CALL =
  /\b(?:COUNT|SUM|AVG|MIN|MAX|ARRAY_AGG|STRING_AGG|JSON_AGG|JSONB_AGG|BOOL_AND|BOOL_OR|EVERY)\s*\(/i;

/**
 * A function wrapped round a bare column and then compared: LOWER(email) = ….
 * The function, the column and the comparison are captured so the advice can
 * name them. Global, because a WHERE clause can hold more than one.
 */
const FUNCTION_ON_COLUMN =
  /\b(LOWER|UPPER|DATE|CAST|COALESCE|SUBSTRING)\s*\(\s*([A-Za-z_][\w.]*)\s*\)\s*(=|<|>|LIKE\b)/gi;

/** A function wrapped round a column in a WHERE clause, as the query wrote it. */
type WrappedCall = {
  /** The function's name in capitals: "LOWER", "DATE", … */
  fn: string;
  /** The column as written inside the call: "email", "o.created_at". */
  column: string;
  /** The whole call, for quoting back: "LOWER(email)". */
  call: string;
  /** How the call is compared: "=", "<", ">" or "LIKE". */
  op: string;
};

/**
 * True when the plan shows an index answering this very call: a table's
 * index condition applies the same function to the same column, so an index
 * on the expression exists and the plan looks the value up with it. The
 * plan prints the call its own way ("lower((c.email)::text)",
 * "date(events.at)"), so it is matched token by token: the function's name,
 * its bracket, and the column somewhere inside that bracket.
 */
function answeredByIndex(call: WrappedCall, context: SqlContext | undefined): boolean {
  // "LOWER(c.email)" gives qualifier "c" and column "email". Unquoted names
  // fold to lower case, which is how the plan prints them.
  const parts = call.column.toLowerCase().split(".");
  const column = parts[parts.length - 1];
  const qualifier = parts.length > 1 ? parts[parts.length - 2] : null;
  return (context?.tables ?? []).some((table) => {
    if (table.indexCond === null) return false;
    const names = [table.name, table.alias];
    // "c.email" is about the table the query calls c, not any table with an email.
    if (qualifier !== null && !names.includes(qualifier)) return false;
    const tokens = tokenize(table.indexCond);
    return tokens.some((token, i) => {
      if (token.kind !== "ident" || token.text.toUpperCase() !== call.fn) return false;
      if (tokens[i + 1]?.text !== "(") return false;
      const close = closingIndex(tokens, i + 1);
      for (let j = i + 2; j < (close === -1 ? tokens.length : close); j += 1) {
        if (tokens[j].kind !== "ident" || tokens[j].text !== column) continue;
        // "::text" names a type, not a column.
        if (tokens[j - 1].text === "::") continue;
        // A qualified name must be this table's: the other side of a join's
        // condition can wrap another table's column in the same function.
        if (tokens[j - 1].text === "." && !names.includes(tokens[j - 2]?.text ?? null)) continue;
        return true;
      }
      return false;
    });
  });
}

/**
 * Comment-only advice for a function round a filtered column, for when the
 * plan does not show which table to index. In the query's own words, so the
 * reader sees their own condition rather than an example.
 */
function rewriteAdvice({ fn, column, call, op }: WrappedCall): string {
  const intro = `-- The condition compares ${call}, so an index on ${column} is no use here.\n`;
  if (fn === "DATE") {
    // A day starts at midnight, so each comparison of the day becomes a
    // comparison of the bare column with a midnight: d + 1 is the next day.
    const pairs = [
      [`${call} = d`, `${column} >= d AND ${column} < d + 1`],
      [`${call} >= d`, `${column} >= d`],
      [`${call} > d`, `${column} >= d + 1`],
      [`${call} < d`, `${column} < d`],
      [`${call} <= d`, `${column} < d + 1`],
    ];
    const width = Math.max(...pairs.map(([from]) => from.length));
    return (
      intro +
      "-- Compare the bare column with the start of a day instead, d being the\n" +
      "-- day you want, as a date:\n" +
      pairs.map(([from, to]) => `--   ${from.padEnd(width)}  becomes  ${to}`).join("\n")
    );
  }
  if ((fn === "LOWER" || fn === "UPPER") && op === "LIKE") {
    // A plain B-tree index only serves LIKE under the "C" collation;
    // text_pattern_ops makes it serve a pattern with a fixed start in any.
    return (
      intro +
      `-- For a pattern with a fixed start ('abc%'), an index on ${fn}(${column})\n` +
      `-- built with text_pattern_ops, on the table that holds ${column}, can serve\n` +
      "-- it. A pattern that starts with % cannot use an ordinary index at all."
    );
  }
  if (fn === "LOWER" || fn === "UPPER") {
    return (
      intro +
      `-- When it picks out a few rows of a big table, an index on ${fn}(${column})\n` +
      `-- itself, on the table that holds ${column}, lets the server look them up.\n` +
      "-- Or store the value in one case already, and compare the bare column."
    );
  }
  return (
    intro +
    "-- Rewrite the condition so the bare column is compared, doing the work\n" +
    "-- on the value's side of the comparison instead."
  );
}

/**
 * Whether the DISTINCT at the top of the query does any work, when that can
 * be told. Null when it cannot, or when DISTINCT may well be needed.
 *
 * `distinctEnd` is where the DISTINCT keyword ends in `sql`; `textTables` is
 * how many tables the text names; `joins` is whether the main FROM list joins
 * one thing to another (joinsAtTopLevel).
 */
function topDistinctFinding(
  sql: string,
  distinctEnd: number,
  textTables: number,
  joins: boolean,
  context: SqlContext | undefined
): QueryFinding | null {
  const without = finishedStatement(withoutDistinct(sql, distinctEnd));
  const withoutFix = (lead: string) =>
    lead + (without ?? "-- Take DISTINCT out of the select list.");

  // One table, and the result includes its whole primary key: every row is
  // different already, so DISTINCT can never remove one. Only when nothing
  // can repeat a row of that table: no join or second FROM item in the text,
  // no join in the plan (one to generate_series reads no table, yet repeats
  // rows), and no set-returning function in the select list (unnest(tags)
  // gives one row per array element).
  if (
    context !== undefined &&
    context.tables.length === 1 &&
    textTables <= 1 &&
    !joins &&
    !context.repeatsRows
  ) {
    const only = context.tables[0];
    const primaryKey =
      only.schema === null ? [] : (ownValue(context.primaryKeys, `${only.schema}.${only.name}`) ?? []);
    // The plan writes each returned column as the query knows it
    // ("customers.id"); columnOf turns that back into the bare name.
    const quals = qualifiersFor(only.alias, only.name);
    const returned = context.outputColumns.map((entry) =>
      columnOf(tokenize(entry), quals, only.columnTypes)
    );
    if (primaryKey.length > 0 && primaryKey.every((column) => returned.includes(column))) {
      const verb = primaryKey.length === 1 ? "is" : "make up";
      return {
        id: "unnecessary-distinct",
        stepId: null,
        severity: "medium",
        title: `DISTINCT does nothing here: ${andList(primaryKey)} ${verb} the primary key`,
        object: "the select list",
        detail:
          `Every row of ${only.name} has its own primary key, and the result includes ` +
          "it, so no two rows can be the same. DISTINCT still makes the server look " +
          "for copies across the whole result, by sorting it, hashing it or comparing " +
          "each row with the one before.",
        fix: withoutFix("-- The same rows, without the check:\n"),
        fixKind: "query",
      };
    }
  }

  // It ran, and DISTINCT took nothing out.
  const counts = context?.distinctRows ?? null;
  if (counts !== null && counts.input >= 2 && counts.input === counts.output) {
    return {
      id: "unnecessary-distinct",
      stepId: null,
      severity: "medium",
      title: `DISTINCT removed no rows: all ${countInWords(counts.input)} were already different`,
      object: "the select list",
      detail:
        `When the query ran, DISTINCT checked ${fmtRows(counts.input)} rows and ` +
        "removed none. If the rows can never repeat, for example because a key is " +
        "among the columns, that check is wasted work on every run. If they can, " +
        "keep it.",
      fix: withoutFix("-- Only if the rows can never repeat, drop DISTINCT:\n"),
      fixKind: "query",
    };
  }

  // A join repeating rows is the usual reason a DISTINCT gets added. Only a
  // join the query writes itself: one inside a view is not the reader's to
  // rewrite, and a subquery under IN or EXISTS never repeats a row.
  if (joins) {
    return {
      id: "unnecessary-distinct",
      stepId: null,
      severity: "low",
      title: "DISTINCT may be hiding rows a join repeats",
      object: "the select list",
      detail:
        "When one row matches several rows of a joined table, the join repeats it, " +
        "and DISTINCT then has to look through the whole result to take the copies " +
        "out again. If the joined table is only there as a filter, EXISTS keeps the " +
        "filter without making the copies.",
      fix:
        "-- If a joined table is only there to filter the rows, test it with EXISTS\n" +
        "-- instead of joining it, and drop DISTINCT. The shape, with a the table\n" +
        "-- the rows come from and b the one that filters them:\n" +
        "--   SELECT … FROM a WHERE EXISTS (SELECT 1 FROM b WHERE b.a_id = a.id);",
      fixKind: "query",
    };
  }
  return null;
}

/**
 * The finding for a query that joins `count` tables.
 *
 * `serverSettings` are the server's own join settings, or null when they could
 * not be read; PostgreSQL's defaults stand in then, and the text says so.
 * `explicitJoins` is whether the query writes JOIN: join_collapse_limit only
 * fixes the order of JOINs, never of a comma-separated FROM list.
 */
function manyJoinsFinding(
  count: number,
  serverSettings: PlannerSettings | null,
  explicitJoins: boolean
): QueryFinding {
  const s = serverSettings ?? DEFAULT_PLANNER_SETTINGS;
  const setting = (value: number) =>
    serverSettings === null ? `${value}, PostgreSQL's default` : `${value} on this server`;
  const fixedOrder = explicitJoins && count > s.joinCollapseLimit;
  // The planner orders one list of tables at a time. Past the limit, JOINs
  // come in lists of at most join_collapse_limit tables, so the randomised
  // search only starts when a list that long reaches geqo_threshold.
  const longestList = fixedOrder ? s.joinCollapseLimit : count;
  const randomSearch = s.geqo && longestList >= s.geqoThreshold;
  // Lifting join_collapse_limit to `count` puts every table in one list,
  // which the randomised search takes over from geqo_threshold on.
  const randomOnceLifted = s.geqo && count >= s.geqoThreshold;

  let detail =
    `This query joins ${count} tables. Each one added multiplies the join orders ` +
    "the planner can choose between, and a wrong row estimate for an early join " +
    "is carried through every join after it.";
  if (fixedOrder) {
    detail +=
      ` Past join_collapse_limit (${setting(s.joinCollapseLimit)}) the planner no ` +
      "longer considers every join order: it splits the JOINs into groups of at " +
      "most that many, following the order the query writes them, so the " +
      "written order limits the plans it can pick.";
  }
  if (randomSearch) {
    detail +=
      ` From geqo_threshold (${setting(s.geqoThreshold)}) tables in one list ` +
      "on, it also switches to a randomised search, so the same query can get " +
      "a different plan from one run to the next.";
  }

  const checks = [
    "-- 1. Each join column on the bigger side of its join has an index.",
    "-- 2. Tick Run it and measure, and look for a join whose row estimate is\n" +
      "--    far off: that is where the plan starts to go wrong.",
  ];
  if (fixedOrder) {
    checks.push(
      "-- 3. The joins that cut the rows down most are written first: past\n" +
        "--    join_collapse_limit the written order limits the plans it can pick."
    );
  }
  // For this session only, and commented out: searching every join order of
  // a many-table query makes planning slower, a trade made query by query.
  // Lowering a setting never helps, so a line appears only past its value.
  const sets: string[] = [];
  if (fixedOrder) sets.push(`-- SET join_collapse_limit = ${count};`);
  if (randomOnceLifted && (fixedOrder || randomSearch)) {
    sets.push(`-- SET geqo_threshold = ${count + 1};`);
  }
  if (sets.length > 0) {
    checks.push(
      `-- ${checks.length + 1}. For this session only, let the planner search every join\n` +
        "--    order. Planning then takes longer, so compare the plans before\n" +
        "--    and after:\n" +
        sets.join("\n")
    );
  }

  return {
    id: "many-joins",
    stepId: null,
    severity: fixedOrder || randomSearch ? "medium" : "low",
    title: fixedOrder
      ? `${count} tables joined: the written JOIN order now matters`
      : randomSearch
        ? `${count} tables joined: the join order is picked by a randomised search`
        : `${count} tables joined in one query`,
    object: "the FROM clause",
    detail,
    fix: "-- Worth checking, from least to most effort:\n" + checks.join("\n"),
    fixKind: "decision",
  };
}

/**
 * Rules that read only the query text.
 *
 * Every one of these is a heuristic and is written to be wrong in the safe
 * direction: it says "this shape usually costs you X", never "your query is
 * broken". The plan above is the authority on what this server will actually
 * do; these hold when there is no server to ask.
 *
 * `context` is what the plan and the catalog said about the same query
 * (sqlContextFromPlan). With it a rule judges the query by its real size and
 * names the real tables and columns: returning every row of a 40-row table is
 * fine, of a 4-million-row one it is not. Without it every rule takes its
 * quietest reading, and names nothing it cannot see.
 *
 * Only read queries reach this far (checkAnalysable), so there is no rule for
 * an UPDATE or DELETE without a WHERE: such a statement is refused before it
 * is analysed.
 */
export function readSql(sql: string, context?: SqlContext): QueryFinding[] {
  const mask = maskNonCode(sql);
  const out: QueryFinding[] = [];
  const hasWhere = inCode(mask, /\bWHERE\b/i);
  const groupedAtTop = atTopLevel(mask, /\bGROUP\s+BY\b/i);
  const textTables = tablesInText(mask);
  // Index names suggested in this report, so two suggestions never share one.
  const suggested: string[] = [];
  const takenIn = (schema: string) => [
    ...(ownValue(context?.relationNames, schema) ?? []),
    ...suggested,
  ];

  // SELECT *, SELECT DISTINCT * and alias.*: each asks for every column. The
  // mask has blanked a quoted alias ("o".*), so the name in front of the dot
  // is checked in the original text.
  //
  // Only a star in the main select list is what the query sends back: one
  // outside every bracket, or one in a bracketed branch of the statement's
  // own UNION, INTERSECT or EXCEPT. Inside EXISTS (…) the star is never
  // fetched: EXISTS only asks whether a row is there. Inside a derived table
  // or a WITH query, the outer select list decides what comes back, and
  // PostgreSQL usually fetches only the columns that list uses. Inside a
  // function call (count(o.*), to_jsonb(o.*)) the whole row is what the
  // call is for.
  const stars = [
    ...codeMatches(mask, /\bSELECT\s+(?:DISTINCT\s+|ALL\s+)?\*/i),
    ...codeMatches(mask, /\.\s*\*/).filter((m) =>
      /(?:^|[^\w$"])(?:[A-Za-z_][\w$]*|"(?:[^"]|"")+")\s*$/.test(
        sql.slice(Math.max(0, m.index - 200), m.index)
      )
    ),
  ].filter((m) => parenDepthAt(mask, m.index) === 0 || inSetOperationBranch(mask, m.index));
  if (stars.length > 0) {
    // The plan's Output is what the top of the query really returns, so it
    // is offered as the list to choose from, and nothing is made up.
    const columns = starColumns(sql, context);
    out.push({
      id: "select-star",
      stepId: null,
      severity: "low",
      title: "SELECT * asks for every column",
      object: "the select list",
      detail:
        "Every column is fetched and sent back, including ones this query never " +
        "looks at, and an index that covers the columns you do use cannot be used " +
        "on its own. It also means adding a column to the table silently changes " +
        "what this query returns.",
      fix:
        columns.length > 0
          ? "-- Put the columns the code reading this result uses in place of the *.\n" +
            "-- Today the query returns these:\n" +
            commentLines(columns)
          : "-- Put the columns the code reading this result uses in place of the *,\n" +
            "-- so the query asks only for those.",
      fixKind: "query",
    });
  }

  // The wildcard lives inside a string literal, which the mask blanks — so the
  // keyword is located in code and the pattern is then read from the original.
  // E'…' is the escape-string form of the same literal.
  const leading = codeMatches(mask, /\b(?:I?LIKE|SIMILAR\s+TO)\b/i).filter((m) =>
    /^\s*[Ee]?'%/.test(sql.slice(m.end, m.end + 40))
  );
  if (leading.length > 0) {
    // ILIKE ignores case, and an index built with text_pattern_ops does not.
    const ilike = leading.some((m) => /^ILIKE$/i.test(mask.slice(m.index, m.end)));
    // The plan prints LIKE as ~~ and ILIKE as ~~*, with the real column and
    // table, so the advice can name what the pattern is matched against.
    const searched = new Map<string, { table: SqlContextTable; column: string }>();
    for (const atom of filterAtoms(context, conditionAtoms)) {
      if (atom.op !== "~~" && atom.op !== "~~*") continue;
      const pattern = atom.right[0];
      if (pattern?.kind !== "str" || !/^[Ee]?'%/.test(pattern.text)) continue;
      const quals = qualifiersFor(atom.table.alias, atom.table.name);
      const column = columnOf(atom.left, quals, atom.table.columnTypes);
      if (column === null) continue;
      const key = JSON.stringify([atom.table.schema, atom.table.name, column]);
      searched.set(key, { table: atom.table, column });
    }
    const named = [...searched.values()];

    // Commented out on purpose: pg_trgm is an extension for the whole server,
    // and a trigram index is large to keep up to date, so building one is a
    // choice for whoever runs the server, not a statement to paste.
    const statements: string[] = [];
    for (const { table, column } of named) {
      if (table.schema === null) continue;
      const name = indexName(table.name, `${column}_trgm`, takenIn(table.schema));
      suggested.push(name);
      const target = qualifiedName(table.schema, table.name);
      statements.push(
        "-- " +
          oneLine(`CREATE INDEX ${quoteIdent(name)} ON ${target} USING gin (${quoteIdent(column)} gin_trgm_ops);`)
      );
    }
    out.push({
      id: "leading-wildcard",
      stepId: null,
      severity: "medium",
      title: "A pattern starting with % cannot use an ordinary index",
      object:
        named.length > 0
          ? andList(named.map(({ table, column }) => `${table.name}.${column}`))
          : "the LIKE condition",
      detail:
        "A B-tree index is sorted by the start of the value, so it can find " +
        "everything beginning with \"smith\" but nothing about what ends with it. " +
        "A leading % forces the server to test every row.",
      fix:
        "-- Two ways out; which one fits depends on what people search for.\n" +
        (ilike
          ? "-- 1. Values that START with the text: drop the leading %. As ILIKE\n" +
            "--    ignores case, write lower(column) LIKE 'text%', with the text in\n" +
            "--    lower case: an index on lower(column) built with text_pattern_ops\n" +
            "--    can then find them.\n"
          : "-- 1. Values that START with the text: drop the leading %. An index on\n" +
            "--    the column built with text_pattern_ops can then find them.\n") +
        "-- 2. The text ANYWHERE in the value: a trigram index can serve that.\n" +
        "--    It needs the pg_trgm extension, a change to the whole server, and\n" +
        "--    it is a large index to keep up to date, so agree it with whoever\n" +
        (statements.length > 0
          ? "--    runs the server:\n-- CREATE EXTENSION IF NOT EXISTS pg_trgm;\n" + statements.join("\n")
          : "--    runs the server, and build it on the column the pattern is\n" +
            "--    matched against."),
      fixKind: "decision",
    });
  }

  // LOWER(email) = … and friends: the index is on the column, the condition is
  // on the result of a function, and those are two different things.
  //
  // Searched inside each WHERE clause rather than across the whole statement:
  // a single regex with `[\s\S]*` between WHERE and the call was satisfied by a
  // function call anywhere later — a SELECT list, an ORDER BY, a following
  // subquery — so the finding fired on statements that wrap nothing.
  const calls: WrappedCall[] = [];
  for (const clause of whereClauses(mask)) {
    for (const m of mask.slice(clause.start, clause.end).matchAll(FUNCTION_ON_COLUMN)) {
      const call = m[0].slice(0, m[0].lastIndexOf(")") + 1).replace(/\s+/g, " ");
      calls.push({ fn: m[1].toUpperCase(), column: m[2], call, op: m[3].toUpperCase() });
    }
  }
  // A call an index on the expression already answers needs no advice: the
  // plan looks the value up instead of working it out for every row.
  const open = calls.filter((call) => !answeredByIndex(call, context));
  if (open.length > 0) {
    // With the plan: lower() or upper() round a column in the Filter of a
    // step that reads a big table to keep few of its rows is exactly what
    // an index on that expression serves. Only for conditions ANDed
    // together (no one index answers an OR) that compare with a value fixed
    // for the whole scan, and only for a call the text wrote too, so the
    // finding's words and its fix are about the same condition. The text's
    // column may carry a qualifier ("c.email"); unquoted, it folds to lower
    // case, as the plan prints it.
    const indexes: IndexStatement[] = [];
    const indexedCalls: WrappedCall[] = [];
    const seen: string[] = [];
    for (const atom of filterAtoms(context, andedConditions)) {
      const { table } = atom;
      if (!INDEXABLE_OPERATORS.has(atom.op)) continue;
      if (table.schema === null || !table.selectiveScan) continue;
      const quals = qualifiersFor(table.alias, table.name);
      const left = wrappedColumn(atom.left, quals, table.columnTypes);
      const right = wrappedColumn(atom.right, quals, table.columnTypes);
      let found: { fn: "lower" | "upper"; column: string } | null = null;
      if (left !== null && valueIsFixed(atom.right, quals)) found = left;
      else if (right !== null && valueIsFixed(atom.left, quals)) found = right;
      if (found === null) continue;
      const { fn, column } = found;
      const written = open.find(
        (c) =>
          c.fn === fn.toUpperCase() &&
          c.op !== "LIKE" &&
          c.column.slice(c.column.lastIndexOf(".") + 1).toLowerCase() === column
      );
      if (written === undefined) continue;
      const key = JSON.stringify([table.schema, table.name, fn, column]);
      if (seen.includes(key)) continue;
      seen.push(key);
      const index = createExpressionIndexSql(table.schema, table.name, fn, column, takenIn(table.schema));
      suggested.push(index.name);
      indexes.push(index);
      indexedCalls.push(written);
    }

    // The call the finding is about: one the plan let us index, else the
    // first one written.
    const wrapped = indexedCalls[0] ?? open[0];
    const finding: QueryFinding = {
      id: "function-on-column",
      stepId: null,
      severity: "medium",
      title: "A function is applied to the column being filtered",
      object: wrapped.call,
      detail:
        `An index stores the column's values, not the results of ${wrapped.call}, ` +
        `so this condition cannot use an index on ${wrapped.column}. The server has ` +
        `to work out ${wrapped.fn}() for every row before it can compare anything.`,
      fix: rewriteAdvice(wrapped),
      fixKind: "query",
    };
    if (indexes.length > 0) {
      finding.fix =
        "-- An index on the expression itself lets the server look the value up\n" +
        "-- instead of working it out for every row. Build it, then analyse again.\n" +
        indexes.map((index) => index.sql).join("\n\n");
      finding.fixKind = "change";
      finding.undo = indexes.map((index) => index.undo).join("\n");
    }
    out.push(finding);
  }

  if (inCode(mask, /\bNOT\s+IN\s*\(\s*SELECT\b/i)) {
    out.push({
      id: "not-in-subquery",
      stepId: null,
      severity: "medium",
      title: "NOT IN (SELECT …) returns nothing if the subquery has a NULL",
      object: "the NOT IN condition",
      detail:
        "This is a correctness trap before it is a speed one: if a single row of " +
        "the subquery is NULL, the comparison is never true for anything and the " +
        "whole query returns no rows at all. NOT EXISTS does not have that rule, " +
        "and usually plans better as well.",
      fix:
        "-- The same intent without the NULL trap. The shape, with a the table\n" +
        "-- the rows come from and b the one the subquery reads:\n" +
        "--   SELECT … FROM a WHERE a.b_id NOT IN (SELECT b.id FROM b)\n" +
        "-- becomes\n" +
        "--   SELECT … FROM a WHERE NOT EXISTS (SELECT 1 FROM b WHERE b.id = a.b_id)\n" +
        "-- Unlike NOT IN, it also keeps the rows of a whose a.b_id is NULL.",
      fixKind: "query",
    });
  }

  // FROM a, b — a join whose condition, if it exists at all, is buried in the
  // WHERE clause. Deliberately narrow: only a comma directly between two
  // table-ish names right after FROM.
  if (inCode(mask, /\bFROM\s+[A-Za-z_][\w.]*(?:\s+(?!WHERE|JOIN|GROUP|ORDER|LIMIT|UNION|ON)[A-Za-z_]\w*)?\s*,\s*[A-Za-z_][\w.]*/i)) {
    out.push({
      id: "comma-join",
      stepId: null,
      severity: "low",
      title: "Tables are joined with a comma",
      object: "the FROM clause",
      detail:
        "The join condition, if there is one, is somewhere in the WHERE clause " +
        "mixed in with the filters. Forget it and this becomes every row of one " +
        "table paired with every row of the other. An explicit JOIN … ON puts the " +
        "condition where it cannot be lost.",
      fix:
        "-- Move each join condition out of the WHERE clause, next to its table.\n" +
        "-- The shape, with a and b two of the tables:\n" +
        "--   SELECT … FROM a, b WHERE b.a_id = a.id AND …\n" +
        "-- becomes\n" +
        "--   SELECT … FROM a JOIN b ON b.a_id = a.id WHERE …",
      fixKind: "query",
    });
  }

  // Only an ORDER BY that orders the result set. A window function's
  // `OVER (ORDER BY …)` and a subquery's own ordering both sit inside
  // parentheses, and neither has anything to do with how many rows come back.
  // Not after a GROUP BY either, whose result is one row per group and
  // usually short, and not when the plan expects a small result: sorting a
  // few hundred rows costs nothing worth a finding.
  const topLevelOrderBy = atTopLevel(mask, /\bORDER\s+BY\b/i);
  const smallResult = context !== undefined && context.expectedRows < SMALL_RESULT_ROWS;
  // A LIMIT inside a subquery limits that subquery, not the result.
  const limitedAlready = atTopLevel(mask, /\bLIMIT\b|\bFETCH\s+(?:FIRST|NEXT)\b/i);
  if (topLevelOrderBy && !limitedAlready && !groupedAtTop && !smallResult) {
    const limited = finishedStatement(sql, "LIMIT 20");
    out.push({
      id: "order-by-no-limit",
      stepId: null,
      severity: "low",
      title: "Everything is sorted, and all of it is returned",
      object: "the ORDER BY clause",
      detail:
        "Without a LIMIT the server has to sort every matching row before it can " +
        "return the first one, and then send all of them. If this is feeding a " +
        "screen that shows twenty rows, it is doing far more work than the screen needs.",
      fix:
        "-- If a screen shows these a page at a time, fetch one page:\n" +
        (limited ?? "-- Add LIMIT 20 at the end of the statement."),
      fixKind: "query",
    });
  }

  const bigOffset = codeMatches(mask, /\bOFFSET\s+\d+/i).some((m) => {
    const digits = /(\d+)/.exec(mask.slice(m.index, m.end));
    return digits ? Number(digits[1]) >= 1000 : false;
  });
  if (bigOffset) {
    out.push({
      id: "deep-offset",
      stepId: null,
      severity: "medium",
      title: "A large OFFSET still reads everything it skips",
      object: "the OFFSET clause",
      detail:
        "OFFSET does not jump — the server produces the skipped rows and then " +
        "discards them. Page 1 is instant and page 500 is slow, on the same query. " +
        "Remembering where the last page ended avoids the whole problem.",
      fix:
        "-- Keyset pagination: remember the sort key of the last row on a page,\n" +
        "-- and start the next page after it. The shape, for a list sorted\n" +
        "-- newest first, with the last row's values in place of the ? marks:\n" +
        "--   SELECT … FROM t\n" +
        "--    WHERE (created_at, id) < (?, ?)\n" +
        "--    ORDER BY created_at DESC, id DESC\n" +
        "--    LIMIT 20;\n" +
        "-- An index on (created_at, id) lets each page start straight at its row.",
      fixKind: "query",
    });
  }

  // DISTINCT, judged rather than flagged on sight. DISTINCT ON is a different
  // feature (one row per group) and is left alone. At most one finding: the
  // DISTINCT on the whole result if there is one, else one inside IN or
  // EXISTS.
  const distincts = codeMatches(mask, /\bSELECT\s+DISTINCT\b(?!\s+ON\b)/i);
  // Not beside UNION, INTERSECT or EXCEPT: the plan's top step then removes
  // the set operation's duplicates rather than this DISTINCT's, so its counts
  // and the primary-key reading would be about something else.
  const setOperation = atTopLevel(mask, /\b(?:UNION|INTERSECT|EXCEPT)\b/i);
  const topDistinct = setOperation
    ? undefined
    : distincts.find((m) => parenDepthAt(mask, m.index) === 0);
  let distinct =
    topDistinct === undefined
      ? null
      : topDistinctFinding(sql, topDistinct.end, textTables, joinsAtTopLevel(mask), context);
  const innerDistinct = distincts.find((m) => {
    const word = wordBeforeGroup(mask, m.index);
    return word === "IN" || word === "EXISTS";
  });
  if (distinct === null && innerDistinct !== undefined) {
    const word = wordBeforeGroup(mask, innerDistinct.index);
    const without = finishedStatement(withoutDistinct(sql, innerDistinct.end));
    distinct = {
      id: "unnecessary-distinct",
      stepId: null,
      severity: "low",
      title: `DISTINCT inside ${word} (…) changes nothing`,
      object: `the ${word} subquery`,
      detail:
        "IN (…) and EXISTS (…) only ask whether a matching row is there, so " +
        "repeated rows in the subquery never change the result. Under IN, " +
        "DISTINCT can still make the server sort or hash the subquery's rows " +
        "first; under EXISTS the server ignores it, and it only misleads the reader.",
      fix:
        "-- The same result, without the DISTINCT:\n" +
        (without ?? "-- Take DISTINCT out of the subquery."),
      fixKind: "query",
    };
  }
  if (distinct !== null) out.push(distinct);

  // COUNT(*) over one big table with no WHERE: PostgreSQL keeps no stored
  // row count, so it reads the whole table. Only with the plan to say how
  // big the table is, and only for one table: across a join the count is of
  // joined rows, which no statistic holds. And only when the plan reads all
  // of it: a view with its own WHERE counts fewer rows than the table's
  // statistic holds.
  const counted = context !== undefined && context.tables.length === 1 ? context.tables[0] : null;
  const countsAll = inCode(mask, /\bCOUNT\s*\(\s*\*\s*\)/i) && !hasWhere && !groupedAtTop;
  if (counted !== null && counted.readsAll && counted.rows >= LARGE_TABLE_ROWS && countsAll) {
    // Single quotes doubled: the name sits inside a string literal.
    const literal =
      counted.schema === null ? null : qualifiedName(counted.schema, counted.name).replace(/'/g, "''");
    out.push({
      id: "unfiltered-count",
      stepId: null,
      severity: "low",
      title: "Counting every row means reading every row",
      object: "the COUNT(*)",
      detail:
        `${counted.name} holds about ${countInWords(counted.rows)} rows. PostgreSQL ` +
        "keeps no stored row count, because two sessions can rightly disagree about " +
        "how many rows exist, so an unfiltered COUNT(*) reads the whole table every " +
        "time it is asked.",
      fix:
        "-- Good enough for \"about how many\", and instant: the count the server's\n" +
        "-- statistics hold, as fresh as the table's last ANALYZE. A result of -1\n" +
        "-- means the table has never been analysed.\n" +
        (literal === null
          ? "-- Ask pg_class.reltuples for this table."
          : "SELECT reltuples::bigint AS approx_rows\n" +
            `  FROM pg_class WHERE oid = '${literal}'::regclass;`),
      fixKind: "query",
    });
  }

  // A SELECT with no WHERE anywhere returns every row it reads. Not when
  // something already caps or shrinks the result (LIMIT, GROUP BY, HAVING,
  // DISTINCT, an aggregate), and not when the result is small anyway.
  // `TABLE orders` is shorthand for SELECT * FROM orders, so it counts.
  //
  // A WHERE at any depth, even one inside a subquery, keeps the rule quiet on
  // purpose: from the text alone it cannot tell whether that WHERE shrinks
  // the result. So it speaks only when there is no WHERE at all, which is
  // the one thing its title says.
  const readsTable = textTables > 0 || atTopLevel(mask, /\bTABLE\b/i);
  const capped = atTopLevel(mask, /\b(?:LIMIT|FETCH|HAVING|DISTINCT)\b|\bGROUP\s+BY\b/i);
  // With a plan, its top step says whether rows are really added up:
  // count(*) OVER () looks like an aggregate in the text, but returns every row.
  const aggregated =
    context !== undefined ? context.topNodeType === "Aggregate" : atTopLevel(mask, AGGREGATE_CALL);
  if (!hasWhere && readsTable && !capped && !aggregated) {
    const rows = context === undefined ? null : context.expectedRows;
    let severity: Severity | null = "low";
    if (rows !== null && rows < SMALL_RESULT_ROWS) severity = null;
    else if (rows !== null && rows >= LARGE_TABLE_ROWS) severity = "medium";

    if (severity !== null) {
      let title = "No WHERE clause: every row comes back";
      let size = "";
      if (rows !== null) {
        title = `No WHERE clause: all ${countInWords(rows)} rows come back`;
        size = context?.measured
          ? ` It returned ${fmtRows(rows)} rows when it ran.`
          : ` The planner expects about ${fmtRows(rows)}.`;
      }
      const limited = finishedStatement(sql, "LIMIT 100");
      out.push({
        id: "missing-where",
        stepId: null,
        severity,
        title,
        object: "the whole query",
        detail:
          "With no WHERE clause the server reads and sends back every row, and " +
          "whatever reads the result has to hold all of them. On a big table that " +
          "is slow long before anyone looks past the first screen." +
          size,
        fix:
          "-- Ask only for the rows you need: a WHERE clause goes after the FROM\n" +
          "-- list, before any GROUP BY or ORDER BY. While you look at the data,\n" +
          "-- cap how much comes back:\n" +
          (limited ?? "-- Add LIMIT 100 at the end of the statement."),
        fixKind: "query",
      });
    }
  }

  // Many tables in one query: the planner's search for a join order gets
  // harder, and past two server settings it changes how it searches. The
  // plan's count sees through views; the text's sees tables the planner
  // removed as unused. The larger of the two is used.
  const tableCount = Math.max(context?.joinedTables ?? 0, textTables);
  if (tableCount >= MANY_JOINS) {
    const explicitJoins = inCode(mask, /\bJOIN\b/i);
    out.push(manyJoinsFinding(tableCount, context?.settings ?? null, explicitJoins));
  }

  return sortFindings(out);
}

/** {high, medium, low, total} across any list of findings. */
export function summarizeFindings(findings: QueryFinding[]): {
  high: number;
  medium: number;
  low: number;
  total: number;
} {
  return {
    high: findings.filter((f) => f.severity === "high").length,
    medium: findings.filter((f) => f.severity === "medium").length,
    low: findings.filter((f) => f.severity === "low").length,
    total: findings.length,
  };
}
