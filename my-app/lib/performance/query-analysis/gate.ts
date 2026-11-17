// Query analysis, part one: the gate.
//
// Decides whether a query may be analysed at all (checkAnalysable), checks
// the plan it produced a second time (checkPlanIsReadOnly, planMentionsDenied)
// and builds the EXPLAIN statement the route runs.

import { containsTransactionControl, maskNonCode, splitStatements } from "../../sql/guard";
import type { PlanStep } from "./plan-types";
import { fmtRows } from "./wording";
import { codeMatches, parenDepthAt } from "./sql-text";

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
 * Functions that read a file or a folder on the database server.
 *
 * They change nothing, so READ ONLY lets them run, and a superuser (or a role
 * in pg_read_server_files) can read any file the server can. An analysis is
 * meant to return a plan and timings, never a server's files, so measured
 * mode refuses them by name too. The pg_ls_ family (pg_ls_dir, pg_ls_logdir,
 * pg_ls_waldir and the rest) is matched by the start of its name.
 */
const FILE_READING_FUNCTIONS: ReadonlySet<string> = new Set([
  "pg_read_file",
  "pg_read_binary_file",
  "pg_stat_file",
]);
const FILE_READING_PREFIX = "pg_ls_";

/** Whether a function called `name` (lower-cased) reads the server's files. */
function readsServerFiles(name: string): boolean {
  return FILE_READING_FUNCTIONS.has(name) || name.startsWith(FILE_READING_PREFIX);
}

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
    if (isDenied(name)) return name;
    match = call.exec(text);
  }
  return null;
}

/** Whether a function called `name` (lower-cased) is one measured mode refuses. */
function isDenied(name: string): boolean {
  return (
    DENIED_FUNCTIONS.has(name) ||
    DENIED_PREFIXES.some((p) => name.startsWith(p)) ||
    readsServerFiles(name)
  );
}

/**
 * The first denied function called through a quoted name, lower-cased, or null.
 *
 * `"pg_try_advisory_lock"(42)` calls the same function as the bare name, and
 * the ordinary mask blanks quoted names, so deniedFunctionIn never sees it.
 * `names` is the query masked with its quoted names kept (strings and comments
 * still blanked), so every `"` left in it opens or closes a name. Reading the
 * names one after the other keeps each opening quote paired with its own
 * closing one.
 */
function deniedQuotedCallIn(names: string): string | null {
  const quoted = /"((?:[^"]|"")*)"/g;
  const openingBracket = /\s*\(/y;
  let match = quoted.exec(names);
  while (match !== null) {
    openingBracket.lastIndex = quoted.lastIndex;
    if (openingBracket.test(names)) {
      // "" inside a quoted name stands for one quote character.
      const name = match[1].replace(/""/g, '"').toLowerCase();
      if (isDenied(name)) return name;
    }
    match = quoted.exec(names);
  }
  return null;
}

/**
 * The first call in `sql` that acts on the server itself (the same list the
 * measured mode refuses), lower-cased, or null. Reads bare names, quoted names
 * and the bodies of dollar-quoted blocks such as DO $$ ... $$, since a script
 * the AI writes runs whatever is in them. A U& escaped name cannot be read, so
 * it counts as one: the answer is "u&".
 */
export function serverActingCallIn(sql: string): string | null {
  const bare = deniedFunctionIn(maskNonCode(sql, { readDollarBodies: true }));
  if (bare) return bare;
  const names = maskNonCode(sql, { keepQuotedNames: true, readDollarBodies: true });
  if (/\bU&"/i.test(names)) return "u&";
  return deniedQuotedCallIn(names);
}

/** The refusal for a denied call, worded for someone who is not a DBA. */
function deniedMessage(name: string, foundIn: "query" | "plan"): string {
  const where =
    foundIn === "query"
      ? `This query calls ${name}()`
      : `This query ends up calling ${name}() (the plan shows it, for example inside a view the query reads)`;
  const what = readsServerFiles(name)
    ? "which reads files on the database server rather than data in tables"
    : "which acts on the server itself rather than reading data";
  return (
    `${where}, ${what}. A ` +
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

    // The mask above blanks quoted names, and a quoted name can call a denied
    // function too. So they are read from a second mask that keeps them. The
    // plan check cannot stand in for this: a call inside a VALUES list or a
    // LIMIT never appears in the plan's lines.
    const names = maskNonCode(sql, { keepQuotedNames: true });
    // U&"…" spells a name with escapes (U&"pg\0074erminate_backend"), which no
    // list of names can recognise, so measured mode refuses it outright.
    if (/\bU&"/i.test(names)) {
      return (
        `This query spells a name with U& escapes, so it cannot be checked ` +
        `for calls that act on the server itself, and cannot be measured here. ` +
        `Write the name out plainly, or untick Run it and measure to see the ` +
        `plan without running the query.`
      );
    }
    const quotedDenied = deniedQuotedCallIn(names);
    if (quotedDenied) return deniedMessage(quotedDenied, "query");
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
 * The text check reads plain and quoted names alike, but it only sees what was
 * typed. The plan writes each call out plainly, schema and quotes resolved,
 * and a view is expanded in it, so `SELECT * FROM innocent_looking_view` that
 * wraps pg_cancel_backend shows the call here and nowhere else. VERBOSE writes
 * every expression out in full, in each step's Output, Filter and condition
 * lines. Not every call reaches a plan line (one in VALUES or LIMIT may be
 * worked out before the plan is written), which is why the text check comes
 * first. Measured mode only, for the same reason as the text check.
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
 * each step's output columns out; the plan rules and the plan checks above
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
