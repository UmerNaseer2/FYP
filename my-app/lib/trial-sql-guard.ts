// What a run in the shared trial organization refuses, on top of everything
// every run refuses (containsTransactionControl in lib/sql-guard.ts).
//
// Every visitor to the trial signs in as one of three shared accounts, and
// every run reaches the trial database as ONE database user. So whatever a
// script changes about that user, its session, or the database outside the
// trial's own schemas reaches every later visitor, and the reset cannot always
// put it back. Two found in review:
//
//   ALTER ROLE CURRENT_USER PASSWORD '...'
//     The app's saved password stops working, so every visitor's run, and the
//     reset itself, fails to connect until someone fixes it by hand.
//   ALTER ROLE CURRENT_USER SET default_transaction_read_only = on
//     Every later connection starts read only, so every run and the reset fail.
//
// So, before anything is sent to the database, a trial run refuses:
//   - statements about roles, databases, tablespaces and the server, and about
//     objects that live outside a schema (extensions, languages, publications,
//     large objects), which the reset's DROP SCHEMA would not remove;
//   - DROP OWNED, which would also take away the user's right to create the
//     schemas the reset rebuilds;
//   - changes to the session's timeouts, transaction settings and memory,
//     which the run's own limits depend on (lib/run-limits.ts);
//   - every way of running SQL written in a string (EXECUTE, query_to_xml and
//     the like), since nothing here can read inside one;
//   - the calls the query analyser refuses, such as pg_terminate_backend,
//     which here would reach another visitor's connection.
//
// What it does not try to stop: anything inside the trial's schemas. A visitor
// can drop another visitor's table, as in any shared sandbox, and the reset
// puts the demo back.
//
// The scan reads the script the way PostgreSQL's lexer does (maskNonCode), and
// reads the decoded body of every DO block and function too (codeBodiesIn), so
// a statement in a comment or a string does not count and one in a body does.
// A body it cannot decode is refused.

import { codeBodiesIn, maskNonCode } from "@/lib/sql-guard";
import { serverActingCallIn } from "@/lib/query-analysis";

/**
 * Where a statement can start: at the start of the text, after a `;`, or after
 * a PL/pgSQL word that a statement may follow (BEGIN, THEN, ELSE, LOOP,
 * DECLARE) or BEGIN ATOMIC. No m flag, so ^ is the start of the whole text.
 * Statements are only looked for here, so `ALTER TABLE t ALTER role TYPE text`
 * (a column called role) is not taken for ALTER ROLE.
 */
const START = String.raw`(?:^|;|\bBEGIN\b|\bTHEN\b|\bELSE\b|\bLOOP\b|\bDECLARE\b|\bATOMIC\b)\s*`;

/** The settings that say how much memory one statement may take. */
const MEMORY_SETTINGS = [
  "work_mem",
  "maintenance_work_mem",
  "hash_mem_multiplier",
  "temp_buffers",
  "max_parallel_workers_per_gather",
  "max_parallel_maintenance_workers",
];

/**
 * Settings a trial script may not SET or RESET. The timeouts are the run's
 * own limits; the transaction ones would carry into the next script (or, for
 * the default_ ones, any later transaction); role and session authorization
 * change who the run is; client_encoding (and SET NAMES) would make the server
 * read the next script's text differently from this check; the preload ones
 * name libraries for a connection to load; the memory ones would let one
 * visitor's statement take the memory every visitor shares. `all` is RESET
 * ALL, which puts every one of them back to its default.
 */
const PROTECTED_SETTINGS = [
  "statement_timeout",
  "idle_in_transaction_session_timeout",
  "idle_session_timeout",
  "transaction_timeout",
  "client_connection_check_interval",
  String.raw`default_transaction_\w+`,
  String.raw`transaction_\w+`,
  String.raw`session\s+authorization`,
  "role",
  "all",
  "client_encoding",
  "names",
  "local_preload_libraries",
  "session_preload_libraries",
  ...MEMORY_SETTINGS,
].join("|");

/** EXECUTE that runs a string, not EXECUTE FUNCTION in a trigger or GRANT EXECUTE ON (as in lib/ai/features/sql-generate.ts). */
const DYNAMIC_EXECUTE = /\bEXECUTE\b(?!\s*(?:,|FUNCTION\b|PROCEDURE\b|ON\b))/i;

type Rule = { pattern: RegExp; problem: (match: RegExpExecArray) => string };

/** A matched keyword run as one upper-case line: `drop\n  owned` reads DROP OWNED. */
function words(text: string): string {
  return text.replace(/\s+/g, " ").trim().toUpperCase();
}

/**
 * Read on the code alone: strings, comments and quoted names blanked. Each
 * problem completes the sentence "The script ...".
 */
const CODE_RULES: Rule[] = [
  {
    // USER and GROUP are other names for ROLE. USER also covers USER MAPPING.
    pattern: new RegExp(`${START}(CREATE|ALTER|DROP)\\s+(ROLE|USER|GROUP|DATABASE|TABLESPACE)\\b`, "i"),
    problem: (m) => `runs ${words(m[1])} ${words(m[2])}`,
  },
  {
    pattern: new RegExp(
      `${START}(CREATE(?:\\s+OR\\s+REPLACE)?|ALTER|DROP)\\s+` +
        `((?:(?:TRUSTED|PROCEDURAL)\\s+)*LANGUAGE|EXTENSION|PUBLICATION|SUBSCRIPTION|` +
        `EVENT\\s+TRIGGER|SERVER|FOREIGN\\s+DATA\\s+WRAPPER)\\b`,
      "i"
    ),
    problem: (m) => `runs ${words(m[1])} ${words(m[2])}`,
  },
  { pattern: new RegExp(`${START}(ALTER\\s+SYSTEM|LOAD)\\b`, "i"), problem: (m) => `runs ${words(m[1])}` },
  {
    // An operator or an aggregate runs a function it names in its options, and
    // may name it in a string (FUNCTION = 'set_config', SFUNC = 'ts_stat'), so
    // which function it runs cannot be read here. OPERATOR covers CLASS and
    // FAMILY too.
    pattern: new RegExp(
      `${START}(CREATE(?:\\s+OR\\s+REPLACE)?\\s+AGGREGATE|(?:CREATE|ALTER)\\s+OPERATOR)\\b`,
      "i"
    ),
    problem: (m) => `runs ${words(m[1])}, which can call a function this check cannot see`,
  },
  {
    // A GRANT or REVOKE of a privilege always says what it is ON; one of a
    // role (GRANT some_role TO someone) never does.
    pattern: new RegExp(`${START}(GRANT|REVOKE)\\b(?![^;]*\\bON\\b)`, "i"),
    problem: (m) => `runs ${words(m[1])} of a role`,
  },
  {
    pattern: new RegExp(
      `${START}SET\\s+(?:(?:SESSION|LOCAL)\\s+)?(TRANSACTION|SESSION\\s+CHARACTERISTICS)\\b`,
      "i"
    ),
    problem: (m) => `runs SET ${words(m[1])}`,
  },
  { pattern: /\b(REASSIGN|DROP)\s+OWNED\s+BY\b/i, problem: (m) => `runs ${words(m[1])} OWNED` },
  { pattern: /\bALTER\s+DEFAULT\s+PRIVILEGES\b/i, problem: () => "runs ALTER DEFAULT PRIVILEGES" },
  { pattern: /\bLARGE\s+OBJECTS?\b/i, problem: () => "uses large objects" },
  { pattern: DYNAMIC_EXECUTE, problem: () => "runs SQL written in a string (EXECUTE)" },
];

/**
 * Read with quoted names kept, their quotes turned to spaces, so
 * `SET "statement_timeout"` and `"lo_create"(...)` are seen. Turning a quote
 * into a space keeps every offset, so the raw text can be read at the same
 * place (setConfigProblem does).
 */
const NAME_RULES: Rule[] = [
  {
    pattern: new RegExp(`${START}(SET|RESET)\\s+(?:(?:SESSION|LOCAL)\\s+)?(${PROTECTED_SETTINGS})\\b`, "i"),
    problem: (m) => {
      const name = m[2].replace(/\s+/g, " ").toLowerCase();
      // These four are statements of their own, not settings with a value.
      if (["all", "role", "session authorization", "names"].includes(name)) {
        return `runs ${words(m[1])} ${name.toUpperCase()}`;
      }
      return `changes the setting ${name}`;
    },
  },
  {
    // A function's own SET clause (CREATE FUNCTION ... SET work_mem = '4GB')
    // holds while the function runs. That cannot stretch a time limit, which
    // is set when a statement starts, but it does hand the function the
    // memory, so the memory settings are refused wherever they are set.
    pattern: new RegExp(String.raw`\bSET\s+(${MEMORY_SETTINGS.join("|")})\b`, "i"),
    problem: (m) => `changes the setting ${m[1].toLowerCase()}`,
  },
  {
    pattern: /\b(lo_\w+|loread|lowrite)\s*\(/i,
    problem: (m) => `calls ${m[1].toLowerCase()}(), which uses large objects`,
  },
  {
    // Matched as a word, not only as a call: a script has no other reason to
    // name these, and a name without a bracket can still say what to run.
    pattern: /\b(query_to_xml(?:schema|_and_xmlschema)?|ts_stat|ts_rewrite)\b/i,
    problem: (m) => `calls ${m[1].toLowerCase()}(), which runs SQL written in a string`,
  },
  {
    // UPDATE pg_settings is another way to write SET.
    pattern: /\bpg_settings\b/i,
    problem: () => "uses pg_settings, which can change the session's settings",
  },
  {
    // The Cancel button finds a run by its application_name (lib/run-limits.ts).
    // A function's SET clause could change it while the function runs.
    pattern: /\bapplication_name\b/i,
    problem: () => "uses application_name, which the trial uses to find a run it has to stop",
  },
];

/**
 * set_config() is SET written as a call. One that sets search_path is let
 * through, written exactly as pg_dump writes it, set_config('search_path', ...):
 * a run puts search_path back before every script anyway. Any other mention is
 * refused, a name built some other way and a mention without a call included.
 * In `names` a quoted name's quotes are spaces, so `"set_config"(` is read in
 * the raw text with its closing quote still there.
 */
function setConfigProblem(raw: string, names: string): string | null {
  for (const match of names.matchAll(/\bset_config\b/gi)) {
    const after = raw.slice(match.index + match[0].length);
    if (!/^"?\s*\(\s*'search_path'\s*,/i.test(after)) return "changes a setting with set_config()";
  }
  return null;
}

function problemIn(text: string): string | null {
  const serverCall = serverActingCallIn(text);
  if (serverCall === "u&") return "uses a U& escaped name, which the trial cannot read";
  if (serverCall) return `calls ${serverCall}(), which acts on the server or on another visitor's connection`;

  const code = maskNonCode(text, { readDollarBodies: true });
  for (const rule of CODE_RULES) {
    const match = rule.pattern.exec(code);
    if (match) return rule.problem(match);
  }
  const names = maskNonCode(text, { keepQuotedNames: true, readDollarBodies: true }).replace(/"/g, " ");
  for (const rule of NAME_RULES) {
    const match = rule.pattern.exec(names);
    if (match) return rule.problem(match);
  }
  return setConfigProblem(text, names);
}

/**
 * What in `sql` a trial run will not run, as the end of a sentence that begins
 * "The script" (for example "runs ALTER ROLE"), or null when it may run.
 * Reads the script and every DO and function body in it. Pure, so a route
 * calls it before it opens any connection.
 */
export function trialSqlProblem(sql: string): string | null {
  const { bodies, unreadable } = codeBodiesIn(sql);
  if (unreadable) return "has a DO block or function body written in a way the trial cannot read";
  for (const text of [sql, ...bodies.map((body) => body.text)]) {
    const problem = problemIn(text);
    if (problem) return problem;
  }
  return null;
}

/**
 * The refusal shown to the visitor. `subject` names what was read, for example
 * `The script "add_orders.sql"` or `The rollback for version 1.2.0`.
 */
export function trialSqlRefusal(subject: string, problem: string): string {
  return (
    `${subject} ${problem}. Every visitor to the trial shares one database user, ` +
    "so the trial does not run that. Nothing was run."
  );
}
