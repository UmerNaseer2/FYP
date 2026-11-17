// Function and procedure statements, plus the checks for which routines a
// new or existing table calls.

import type { CompareReport } from "../../compare/types";
import type { RoutineSnapshot, TableSnapshot } from "../../postgres";
import { q } from "./basics";
import { objectStatement } from "./statement-helpers";
import type { SqlStatement } from "./types";

// ── Functions and procedures ───────────────────────────────────────────────

// pg_get_functiondef returns a complete CREATE OR REPLACE statement, so the
// same text covers both "missing" and "changed".
export function createRoutineStatement(routine: RoutineSnapshot): SqlStatement {
  return objectStatement({
    sql: `${routine.definition.trim()};`,
    description: `Create ${routine.kind.toLowerCase()} "${routine.signature}"`,
    kind: "CREATE_ROUTINE",
    tableName: routine.name,
  });
}

export function dropRoutineStatement(routine: RoutineSnapshot, reason = ""): SqlStatement {
  return objectStatement({
    sql:
      `DROP ${routine.kind} IF EXISTS ${q(routine.name)}` +
      `(${routine.identityArguments});`,
    description:
      `Drop ${routine.kind.toLowerCase()} "${routine.signature}"${reason}` +
      ` — WARNING: anything calling it breaks`,
    kind: "DROP_ROUTINE",
    severity: "breaking",
    tableName: routine.name,
  });
}

/**
 * Every expression a CREATE TABLE evaluates for the tables being created
 * outright — column defaults, generated-column expressions and CHECK bodies.
 *
 * These are the three places where building a table can call a function, and
 * so the three places that decide whether a function has to exist before the
 * table or can wait until after it. A foreign key is not here: those are queued
 * separately and added once every table exists.
 */
function newTableExpressions(tables: TableSnapshot[]): string[] {
  const expressions: string[] = [];
  for (const table of tables) {
    for (const column of table.columns) {
      if (column.columnDefault !== null) expressions.push(column.columnDefault);
      // A generated column's expression lives in its own field, never in
      // columnDefault — the two are mutually exclusive in SQL.
      if (column.generated) expressions.push(column.generated.expression);
    }
    for (const check of table.checkConstraints) expressions.push(check.definition);
  }
  return expressions;
}

/**
 * Does `expression` call a routine named `name`?
 *
 * Deliberately a text search rather than anything cleverer: the snapshot keeps
 * the expression as PostgreSQL printed it, and parsing SQL to answer one
 * ordering question would be far more machinery than the question is worth.
 *
 * Two things keep it from matching too much. The name has to be a whole
 * identifier — `gen_ulid` must not match inside `my_gen_ulid_v2` — and it has
 * to be followed by an open bracket, because a bare `gen_ulid` is a column
 * reference and not a call. The optional quote either side covers a name that
 * needs quoting, and the optional `something.` covers a call written with its
 * schema in front.
 *
 * It can still over-match: a string literal containing the word would count.
 * That is the safe direction. Over-matching creates a function slightly
 * earlier than it strictly had to; under-matching brings back the failure this
 * whole thing exists to stop.
 */
export function expressionCallsRoutine(expression: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Case-insensitive because a quoted "Gen_ULID" keeps its capitals in the
  // catalog while the call site may have been written either way.
  const call = new RegExp(`(^|[^A-Za-z0-9_."])"?${escaped}"?\\s*\\(`, "i");
  return call.test(expression);
}

/**
 * The signatures of the source routines that a brand-new table names in a
 * default, a generated column or a CHECK — the ones that have to be created
 * before the tables rather than after them.
 *
 * Matched on the routine's NAME, not its signature, so every overload of a
 * called function is hoisted together. Working out which overload an
 * expression resolves to needs the type rules PostgreSQL itself applies, and
 * guessing wrong means creating the wrong one; hoisting all of them costs
 * nothing but a slightly earlier CREATE FUNCTION.
 */
export function routinesNeededByNewTables(report: CompareReport): Set<string> {
  const needed = new Set<string>();
  const routines = report.left.routines ?? [];
  if (routines.length === 0 || report.tablesOnlyInA.length === 0) return needed;

  const expressions = newTableExpressions(report.tablesOnlyInA);
  for (const routine of routines) {
    // A PROCEDURE cannot be called from an expression at all — only by CALL —
    // so one can never be the reason a CREATE TABLE fails.
    if (routine.kind !== "FUNCTION") continue;
    if (expressions.some((expression) => expressionCallsRoutine(expression, routine.name))) {
      needed.add(routine.signature);
    }
  }
  return needed;
}

/**
 * What a table or a type in the TARGET still does with the function `name`,
 * as a list of phrases for a note: column defaults, generated columns, CHECK
 * and EXCLUDE constraints, indexes, policies, triggers and domain checks.
 *
 * PostgreSQL records each of these as depending on the function, and refuses
 * DROP FUNCTION while one of them is there. Every table of the target counts,
 * also one the script drops, because DROP TABLE and every ALTER TABLE come
 * after the functions in the script. Same text search as
 * routinesNeededByNewTables, so it matches on the name and covers every
 * overload.
 */
export function tableUsesOfRoutine(report: CompareReport, name: string): string[] {
  const uses: string[] = [];
  const tables = [...report.matchedTables.map((match) => match.right), ...report.tablesOnlyInB];
  for (const table of tables) {
    for (const column of table.columns) {
      if (column.columnDefault !== null && expressionCallsRoutine(column.columnDefault, name)) {
        uses.push(`the default of "${table.name}"."${column.name}"`);
      }
      if (column.generated && expressionCallsRoutine(column.generated.expression, name)) {
        uses.push(`the generated column "${table.name}"."${column.name}"`);
      }
    }
    for (const check of [...table.checkConstraints, ...table.excludeConstraints]) {
      if (expressionCallsRoutine(check.definition, name)) {
        uses.push(`the constraint "${check.name}" on "${table.name}"`);
      }
    }
    for (const index of table.indexes ?? []) {
      if (expressionCallsRoutine(index.definition, name)) uses.push(`the index "${index.name}"`);
    }
    for (const policy of table.rowSecurity?.policies ?? []) {
      if (expressionCallsRoutine(`${policy.using ?? ""} ${policy.withCheck ?? ""}`, name)) {
        uses.push(`the policy "${policy.name}" on "${table.name}"`);
      }
    }
    for (const trigger of table.triggers ?? []) {
      if (expressionCallsRoutine(trigger.definition, name)) {
        uses.push(`the trigger "${trigger.name}" on "${table.name}"`);
      }
    }
  }
  for (const type of report.right.types ?? []) {
    if (expressionCallsRoutine(type.definition, name)) uses.push(`the type "${type.name}"`);
  }
  return uses;
}
