// ---------------------------------------------------------------------------
// lib/ai/features/sql-generate.ts
// Feature 4: write SQL from plain words, in the Script Editor.
//
// The person says what the script should do. The model is shown the schema in
// use (the tables the request names always, then their neighbours, then the
// rest as far as the budget goes) and writes the script, its rollback, a short
// summary and what it had to assume. Then the code checks it, the same way a
// person's script is checked, and more strictly:
//   - no transaction control, no deleting data unless the request asks for it;
//   - nothing that acts on the server rather than the schema: roles, databases,
//     tablespaces, settings, COPY, file and sleep functions, dynamic EXECUTE;
//   - no table the schema does not have, no other schema named;
//   - then, when the caller may run scripts on this target and it is labelled
//     Dev or Staging, the script and its rollback are tried on the database in
//     a transaction that is always rolled back (see sql-generate-trial.ts).
// A problem goes back to the model to fix, twice at most. The grade (breaking,
// additive, patch) and the risks always come from the engine, never the model.
// Nothing is saved: the editor gets a draft, and the person saves it.
// Only structure goes in the prompt: no rows, no hosts, no database names.
// ---------------------------------------------------------------------------

import { z } from "zod";
import type { SchemaSnapshot } from "../../postgres";
import { serverActingCallIn } from "../../query-analysis";
import { quoteIdent } from "../../perf-sql";
import { hasExecutableSql, maskNonCode, splitStatements } from "../../sql-guard";
import { bareName, checkGeneratedSql, knownNames, tableRefsInSql, unknownTablesInSql } from "../checks";
import { mentionedObjects, schemaSlice } from "../context";
import { estimateTokens } from "../provider";
import type { AiTaskSpec } from "../run";
import { unknownTickedNames } from "./compare-summary";
import type { SqlGenerateAnswer, SqlGenerateChecks, SqlTrial } from "./sql-generate-view";

/** The longest request the editor sends. */
export const MAX_REQUEST_CHARS = 2_000;
const SCHEMA_TOKENS = 10_000;
const MAX_ASSUMPTIONS = 5;

export const sqlGenerateSchema = z.object({
  sql: z.string().max(20_000),
  rollbackSql: z.string().max(20_000),
  summary: z.string().max(600),
  assumptions: z.array(z.string().min(1).max(300)).max(8),
  cannot: z.string().max(600),
});

export const SQL_GENERATE_SYSTEM = [
  "You write a PostgreSQL migration script for the schema shown, from the request a person typed.",
  "Use only the tables, columns and types in SCHEMA, plus anything your own script creates. Do not put a schema name in front of any name: the app sets the search path to the schema shown.",
  "sql: the script, one statement after another, each ending with a semicolon. Put a short -- comment above each part saying what it does.",
  "rollbackSql: the script that undoes sql, in reverse order. Leave it empty when it cannot be undone (a deleted row cannot come back).",
  "summary: at most 50 words on what the script does, with every table, column and type name in backticks.",
  "assumptions: at most 5 short items, each a thing the request left open and you had to choose, such as a type, a length or a default. Empty when nothing was guessed.",
  "cannot: when the request cannot be done with this schema, or asks for something outside these rules, say why in one or two sentences and leave sql and rollbackSql empty. Otherwise leave it empty.",
  "Rules for the SQL:",
  "- Never write BEGIN, COMMIT, ROLLBACK, SAVEPOINT or END for a transaction. The app runs the script as one transaction.",
  "- Never delete rows, drop a table or drop a column unless the request asks for it.",
  "- Never act on the server rather than the schema: no roles, users, databases, tablespaces, extensions or other schemas, no ALTER SYSTEM, no SET or RESET, no COPY, VACUUM or CHECKPOINT, no pg_terminate_backend, pg_sleep, pg_read_file, set_config or dblink.",
  "- No CREATE INDEX CONCURRENTLY: it cannot run inside a transaction. A plain CREATE INDEX is fine.",
  "- No dynamic SQL: no EXECUTE of a built string in a DO block or a function.",
  "- No SECURITY DEFINER functions.",
  "- A NOT NULL column added to a table that may have rows needs a DEFAULT, or the script fails on the first row.",
  "- When what the request asks for is already in SCHEMA (the column, table or index is there), write no SQL: leave sql and rollbackSql empty and say in cannot that it is already there.",
  "- Do not use IF NOT EXISTS to step over something SCHEMA already has.",
  "- rollbackSql undoes only what sql does. It never drops or changes anything that was in SCHEMA before the script, unless sql changed it, and then it puts it back as it was.",
].join("\n");

/** Words in a request that ask for data to be removed. */
const ASKS_FOR_DATA_LOSS = /\b(?:drop|delete|remove|truncate|purge|clear|wipe|erase|get\s+rid\s+of)\b/i;

/** Functions the generator refuses on top of serverActingCallIn's list. */
const REFUSED_FUNCTIONS =
  /\b(pg_read_file|pg_read_binary_file|pg_ls_[a-z_]+|pg_stat_file|pg_sleep(?:_for|_until)?|set_config|lo_[a-z_]+|pg_file_[a-z_]+)\s*\(/i;

/** EXECUTE as a command; GRANT EXECUTE ON and EXECUTE FUNCTION in a trigger are fine. */
const DYNAMIC_EXECUTE = /\bEXECUTE\b(?!\s*(?:,|FUNCTION\b|PROCEDURE\b|ON\b))/i;

/** Where a statement can start: the top of the script, after a semicolon, or a block keyword. */
const STATEMENT_START = String.raw`(?:^|;|\bBEGIN\b|\bTHEN\b|\bELSE\b|\bLOOP\b|\bDECLARE\b)\s*`;

/** Statements that act on the server, its sessions or other schemas, with the reason the screen shows. */
const REFUSED_STATEMENTS: [RegExp, string][] = [
  [
    /\b(?:CREATE|ALTER|DROP)\s+(?:ROLE|USER|GROUP|DATABASE|TABLESPACE|EXTENSION|SCHEMA|SERVER|FOREIGN\s+DATA\s+WRAPPER|USER\s+MAPPING|PUBLICATION|SUBSCRIPTION|EVENT\s+TRIGGER)\b/i,
    "It creates, changes or drops a role, database, tablespace, extension or schema. Those belong to the whole server, so the generator does not write them.",
  ],
  [/\bALTER\s+SYSTEM\b/i, "It uses ALTER SYSTEM, which changes the server's settings."],
  [/\b(?:REASSIGN|DROP)\s+OWNED\b/i, "It uses REASSIGN OWNED or DROP OWNED, which act on a role's objects everywhere."],
  [/\bSECURITY\s+DEFINER\b/i, "It makes a SECURITY DEFINER function, which runs with its owner's rights. Write that by hand if you mean it."],
  [/\bCONCURRENTLY\b/i, "It uses CONCURRENTLY, which cannot run inside the transaction the app wraps every script in. Use a plain CREATE INDEX."],
  [/\bCOPY\b/i, "It uses COPY, which reads or writes files and streams. The generator does not write it."],
  [/\bPREPARE\s+TRANSACTION\b|\bCOMMIT\s+PREPARED\b/i, "It uses a prepared transaction. The app runs the script as one transaction of its own."],
  [new RegExp(`${STATEMENT_START}(?:SET|RESET)\\b`, "i"), "It changes a session setting with SET or RESET. The app sets the run's own settings, so leave those out."],
  [new RegExp(`${STATEMENT_START}(?:LOAD|CHECKPOINT|VACUUM|CLUSTER|DISCARD|LISTEN|UNLISTEN)\\b`, "i"), "It runs a server command (LOAD, CHECKPOINT, VACUUM, CLUSTER, DISCARD or LISTEN)."],
  [new RegExp(`${STATEMENT_START}(?:GRANT|REVOKE)\\b(?![^;]*\\bON\\b)`, "i"), "It grants or revokes a role, which changes who can do what on the whole server."],
];

/** Names after ON or CREATE that may carry a schema in front, for the other-schema check. */
const QUALIFIED_OBJECT =
  /\b(?:create\s+(?:unique\s+)?index\b[^;]*?\bon(?:\s+only)?|create\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\b[^;]*?\bon|create\s+policy\b[^;]*?\bon|create\s+(?:or\s+replace\s+)?(?:function|procedure|type|sequence|domain|aggregate)|(?:alter|drop)\s+(?:type|sequence|function|procedure|view|materialized\s+view|index|domain|trigger\b[^;]*?\bon)(?:\s+if\s+(?:not\s+)?exists)?|comment\s+on\s+(?:table|view|materialized\s+view|type|function|index|sequence))\s+("[^"]+"|[a-z_][a-z0-9_$]*)\s*\.\s*(?:"[^"]+"|[a-z_][a-z0-9_$]*)/gi;

const ALWAYS_READABLE_SCHEMAS = new Set(["pg_catalog", "information_schema"]);

/** What a try on the database came to. */
export type TrialOutcome =
  | { status: "passed" }
  | { status: "failed"; step: "script" | "rollback"; message: string }
  | { status: "not-tried"; reason: string };

/** Tries the script, then its rollback, on the target, and always rolls back. */
export type TrialHook = (sql: string, rollbackSql: string) => Promise<TrialOutcome>;

export type SqlGenerateFacts = {
  request: string;
  schemaName: string;
  snapshot: SchemaSnapshot;
  focus: string[];
  allowDataLoss: boolean;
  /** The try on the database, or why there is none. */
  trial: TrialHook | { notTried: string };
  /** Set by the check when an answer passes: the app's own reading, for the screen. */
  last: SqlGenerateChecks | null;
  /** Set by the check every time: the problems of the latest answer, for the failure message. */
  lastProblems: string[];
};

function sameSchema(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The schemas a SQL text writes in front of a name, other than the target and
 * the catalogs. `columns` are the schema's column names: EXTRACT(year FROM
 * o.created_at) puts an alias and a column after FROM, not a schema and a table.
 */
export function otherSchemasIn(sql: string, schemaName: string, columns: ReadonlySet<string> = new Set()): string[] {
  const found = new Set<string>();
  for (const ref of tableRefsInSql(sql)) {
    if (!ref.schema || columns.has(ref.name)) continue;
    if (!sameSchema(ref.schema, schemaName) && !ALWAYS_READABLE_SCHEMAS.has(ref.schema)) found.add(ref.schema);
  }
  const text = maskNonCode(sql, { keepQuotedNames: true });
  for (const match of text.matchAll(QUALIFIED_OBJECT)) {
    const raw = match[1];
    const schema = raw.startsWith('"') ? raw.slice(1, -1) : raw.toLowerCase();
    if (!sameSchema(schema, schemaName) && !ALWAYS_READABLE_SCHEMAS.has(schema.toLowerCase())) found.add(schema);
  }
  return [...found];
}

/**
 * The problems a script has that no database needs to be asked about: what it
 * may never do, whatever it is for. Empty when it is fine.
 */
/**
 * PostgreSQL does not read `name`: backticks are MySQL's quotes. The AI is asked
 * to put names in backticks in its prose, and the habit slips into its SQL.
 * Outside strings and comments, each backticked name becomes a quoted one (each
 * dotted part apart), which names exactly what the AI wrote.
 */
export function backticksToQuotes(sql: string): string {
  const code = maskNonCode(sql);
  let out = "";
  let from = 0;
  for (const match of code.matchAll(/`([^`\n]+)`/g)) {
    const start = match.index;
    const end = start + match[0].length;
    const inner = sql.slice(start + 1, end - 1);
    out += sql.slice(from, start) + inner.split(".").map((part) => quoteIdent(part.trim())).join(".");
    from = end;
  }
  return out + sql.slice(from);
}

export function refusedIn(sql: string, schemaName: string, columns: ReadonlySet<string> = new Set()): string[] {
  const problems: string[] = [];
  const serverCall = serverActingCallIn(sql);
  if (serverCall) problems.push(`It calls ${serverCall}, which acts on the server rather than the schema.`);
  // Quotes come off so "pg_sleep"(1) and pg_catalog.pg_sleep(1) read the same.
  const names = maskNonCode(sql, { keepQuotedNames: true, readDollarBodies: true }).replace(/"/g, "");
  const call = names.match(REFUSED_FUNCTIONS);
  if (call && call[1].toLowerCase() !== serverCall) {
    problems.push(`It calls ${call[1].toLowerCase()}, which reads files, waits or changes settings. The generator does not write that.`);
  }
  const code = maskNonCode(sql, { readDollarBodies: true });
  if (DYNAMIC_EXECUTE.test(code)) {
    problems.push("It runs SQL built from a string with EXECUTE. Write the statements out instead, so the app can read them.");
  }
  for (const [pattern, reason] of REFUSED_STATEMENTS) {
    if (pattern.test(code) && !problems.includes(reason)) problems.push(reason);
  }
  const others = otherSchemasIn(sql, schemaName, columns);
  if (others.length > 0) {
    problems.push(
      `It names another schema (${others.join(", ")}). Write every name without a schema in front: the script runs in ${schemaName}.`
    );
  }
  return problems;
}

/** A name as PostgreSQL reads it: quoted exactly, otherwise lower-cased. */
const NAME = String.raw`(?:"(?:[^"]|"")+"|[a-z_][a-z0-9_$]*)`;

function readName(raw: string): string {
  return raw.startsWith('"') ? raw.slice(1, -1).replace(/""/g, '"') : raw.toLowerCase();
}

/** The last part of a dotted name: the schema in front is refusedIn's business. */
function lastPart(raw: string): string {
  const parts = raw.match(new RegExp(NAME, "gi")) ?? [raw];
  return readName(parts[parts.length - 1]);
}

const ALTER_TABLE = new RegExp(String.raw`^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${NAME}(?:\s*\.\s*${NAME})?)`, "i");
const ADD_IF_NOT_EXISTS = new RegExp(String.raw`\bADD\s+(?:COLUMN\s+)?IF\s+NOT\s+EXISTS\s+(${NAME})`, "gi");
const CREATE_TABLE_IF_NOT_EXISTS = new RegExp(
  String.raw`^\s*CREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?(?:(?:TEMP|TEMPORARY|UNLOGGED)\s+)?TABLE\s+IF\s+NOT\s+EXISTS\s+(${NAME}(?:\s*\.\s*${NAME})?)`,
  "i"
);
const CREATE_INDEX_IF_NOT_EXISTS = new RegExp(String.raw`^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+(${NAME})`, "i");

/**
 * What a script adds with IF NOT EXISTS that the schema already has. Such a
 * statement does nothing, and its rollback (DROP ... IF EXISTS) would remove
 * the thing that was there before, with its data. Empty when there is none.
 */
export function alreadyThereIn(sql: string, snapshot: SchemaSnapshot): string[] {
  const tables = new Map(snapshot.tables.map((t) => [t.name, new Set(t.columns.map((c) => c.name))]));
  const indexes = new Set(snapshot.tables.flatMap((t) => (t.indexes ?? []).map((i) => i.name)));
  const found: string[] = [];
  for (const statement of splitStatements(sql)) {
    const code = maskNonCode(statement, { keepQuotedNames: true });
    const created = CREATE_TABLE_IF_NOT_EXISTS.exec(code);
    if (created && tables.has(lastPart(created[1]))) found.push(`table ${lastPart(created[1])}`);
    const index = CREATE_INDEX_IF_NOT_EXISTS.exec(code);
    if (index && indexes.has(readName(index[1]))) found.push(`index ${readName(index[1])}`);
    const altered = ALTER_TABLE.exec(code);
    const columns = altered ? tables.get(lastPart(altered[1])) : undefined;
    if (altered && columns) {
      for (const match of code.slice(altered[0].length).matchAll(ADD_IF_NOT_EXISTS)) {
        const name = readName(match[1]);
        if (columns.has(name)) found.push(`column ${lastPart(altered[1])}.${name}`);
      }
    }
  }
  return [...new Set(found)];
}

/** The tables and views a script creates, for reading its rollback. */
function createdBy(sql: string): Set<string> {
  return new Set(tableRefsInSql(sql).filter((r) => r.creates).map((r) => r.name));
}

/** Every name a SQL text uses, lower-cased, for the summary's backticked names. */
function namesIn(sql: string): Set<string> {
  const code = maskNonCode(sql, { keepQuotedNames: true, readDollarBodies: true });
  const words = new Set<string>();
  for (const match of code.matchAll(/"([^"]+)"|([a-z_][a-z0-9_$]*)/gi)) words.add((match[1] ?? match[2]).toLowerCase());
  return words;
}

function countStatements(sql: string): number {
  return splitStatements(sql).filter((s) => hasExecutableSql(s)).length;
}

function tidy(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

export function buildSqlGenerateTask(options: {
  request: string;
  schemaName: string;
  snapshot: SchemaSnapshot;
  /** The server's major version, when it could be read. */
  serverMajor: number | null;
  trial: TrialHook | { notTried: string };
}): { spec: AiTaskSpec<SqlGenerateAnswer>; facts: SqlGenerateFacts; inputTokens: number } {
  const request = options.request.trim().slice(0, MAX_REQUEST_CHARS);
  const focus = mentionedObjects(options.snapshot, request);
  const slice = schemaSlice(options.snapshot, { focus, maxTokens: SCHEMA_TOKENS });
  const version = options.serverMajor ? `PostgreSQL ${options.serverMajor}` : "PostgreSQL (version unknown)";
  const prompt = [
    "THE REQUEST",
    request,
    "",
    "THE DATABASE",
    `${version}. The script runs in schema ${options.schemaName}, with only that schema on the search path, as one transaction.`,
    "",
    "SCHEMA",
    slice.text,
  ].join("\n");

  const facts: SqlGenerateFacts = {
    request,
    schemaName: options.schemaName,
    snapshot: options.snapshot,
    focus,
    allowDataLoss: ASKS_FOR_DATA_LOSS.test(request),
    trial: options.trial,
    last: null,
    lastProblems: [],
  };

  return {
    facts,
    inputTokens: estimateTokens(`${SQL_GENERATE_SYSTEM}\n${prompt}`),
    spec: {
      feature: "sql-generate",
      tier: "smart",
      system: SQL_GENERATE_SYSTEM,
      prompt,
      schema: sqlGenerateSchema,
      // Never saved: the same words on a changed schema need a new script, and
      // the try on the database is part of the answer.
      cacheInput: null,
      maxOutputTokens: 2_000,
      repairs: 2,
      check: (value) => checkSqlGenerate(value, facts),
    },
  };
}

function notTried(reason: string): SqlTrial {
  return { status: "not-tried", reason };
}

export async function checkSqlGenerate(
  answer: SqlGenerateAnswer,
  facts: SqlGenerateFacts
): Promise<{ value: SqlGenerateAnswer; problems: string[] }> {
  const value: SqlGenerateAnswer = {
    sql: tidy(answer.sql),
    rollbackSql: tidy(answer.rollbackSql),
    summary: answer.summary.trim(),
    assumptions: answer.assumptions.map((a) => a.trim()).filter(Boolean).slice(0, MAX_ASSUMPTIONS),
    cannot: answer.cannot.trim(),
  };
  const finish = (problems: string[], checks: SqlGenerateChecks | null) => {
    facts.lastProblems = problems;
    facts.last = problems.length === 0 ? checks : null;
    return { value, problems };
  };

  value.sql = backticksToQuotes(value.sql);
  value.rollbackSql = backticksToQuotes(value.rollbackSql);
  if (!hasExecutableSql(value.sql)) {
    if (!value.cannot) return finish(["The answer has no SQL statement in it, and cannot says nothing."], null);
    value.sql = "";
    value.rollbackSql = "";
    return finish([], {
      level: null,
      levelBecause: null,
      statements: 0,
      rollbackStatements: 0,
      dataLoss: [],
      mightFail: [],
      enumAdditions: 0,
      trial: notTried("There is no script to try."),
      focus: facts.focus,
    });
  }
  // A script and a reason it cannot be done: the script wins, the reason is kept.
  if (value.cannot) {
    value.assumptions = [...value.assumptions, value.cannot].slice(0, MAX_ASSUMPTIONS + 1);
    value.cannot = "";
  }

  const problems: string[] = [];
  const up = checkGeneratedSql(value.sql, { allowDataLoss: facts.allowDataLoss });
  problems.push(...up.problems);
  const columns = new Set(facts.snapshot.tables.flatMap((t) => t.columns.map((c) => c.name.toLowerCase())));
  problems.push(...refusedIn(value.sql, facts.schemaName, columns));
  const unknown = unknownTablesInSql(value.sql, facts.snapshot);
  if (unknown.length > 0) {
    problems.push(`It uses tables the schema does not have: ${unknown.join(", ")}. Use only the tables in SCHEMA.`);
  }
  const already = alreadyThereIn(value.sql, facts.snapshot);
  if (already.length > 0) {
    problems.push(
      `These statements would do nothing, because what they add is already there: ${already.join(", ")}. ` +
        "Leave them out, and keep the rollback off what was there before. If nothing is left to do, leave sql and rollbackSql empty and say in cannot that it is already there."
    );
  }

  const hasRollback = hasExecutableSql(value.rollbackSql);
  if (!hasRollback) value.rollbackSql = "";
  if (hasRollback) {
    const down = checkGeneratedSql(value.rollbackSql, { allowDataLoss: true });
    problems.push(...down.problems.map((p) => `The rollback: ${p}`));
    problems.push(...refusedIn(value.rollbackSql, facts.schemaName, columns).map((p) => `The rollback: ${p}`));
    const downUnknown = unknownTablesInSql(value.rollbackSql, facts.snapshot, createdBy(value.sql));
    if (downUnknown.length > 0) {
      problems.push(`The rollback uses tables neither the schema nor the script has: ${downUnknown.join(", ")}.`);
    }
  }

  const known = knownNames(facts.snapshot);
  const scriptNames = namesIn(value.sql);
  const summaryUnknown = unknownTickedNames(value.summary, known, (name) =>
    bareName(name)
      .split(".")
      .every((part) => scriptNames.has(part))
  );
  if (summaryUnknown.length > 0) {
    problems.push(`The summary names things that are neither in the schema nor in the script: ${summaryUnknown.join(", ")}.`);
  }

  if (problems.length > 0) return finish(problems, null);

  // Only a script with no static problem is tried: the database is never
  // asked to run something the app would refuse anyway.
  let trial: SqlTrial;
  if ("notTried" in facts.trial) {
    trial = notTried(facts.trial.notTried);
  } else {
    const outcome = await facts.trial(value.sql, value.rollbackSql);
    if (outcome.status === "failed") {
      return finish(
        [
          outcome.step === "script"
            ? `Trying the script on the database failed: ${outcome.message}`
            : `The script ran, but the rollback failed after it: ${outcome.message}`,
        ],
        null
      );
    }
    trial = outcome.status === "passed" ? { status: "passed", rollbackTried: hasRollback } : notTried(outcome.reason);
  }

  const risk = up.risk!;
  return finish([], {
    level: up.grade?.level ?? null,
    levelBecause: up.grade?.because ?? null,
    statements: countStatements(value.sql),
    rollbackStatements: hasRollback ? countStatements(value.rollbackSql) : 0,
    dataLoss: risk.dataLoss.flatMap((d) => d.kinds),
    mightFail: risk.mightFail.flatMap((m) => m.kinds),
    enumAdditions: risk.enumAdditions.length,
    trial,
    focus: facts.focus,
  });
}
