// ---------------------------------------------------------------------------
// lib/ai/checks.ts
// The code checks every AI answer goes through before anyone sees it.
//
// The rule for the whole AI layer is "the engine decides, the AI explains".
// These checks are where that rule is enforced:
//   - every object name the model cites must exist in the schemas it was shown,
//     so a made-up table never reaches the screen;
//   - a grade the engine already worked out (breaking, additive, patch) is
//     locked: the model's own opinion of the level is thrown away;
//   - SQL the model writes is read by the same guards a person's SQL meets:
//     no transaction control, the engine's grade, the deploy risk checks.
// ---------------------------------------------------------------------------

import type { SchemaSnapshot } from "../postgres";
import { analyseRunRisk, type RunRisk } from "../deploy-risk";
import { gradeSql, type SqlGrade } from "../change-type";
import { containsTransactionControl, hasExecutableSql, splitStatements } from "../sql-guard";

/** Every name a model may cite: tables, columns as table.column, views, types, routines and the rest. */
export function knownNames(...snapshots: ReadonlyArray<SchemaSnapshot | null | undefined>): Set<string> {
  const names = new Set<string>();
  const add = (name: string | null | undefined) => {
    if (name) names.add(name.toLowerCase());
  };
  for (const snapshot of snapshots) {
    if (!snapshot) continue;
    add(`schema:${snapshot.schema}`);
    for (const table of snapshot.tables) {
      add(table.name);
      for (const column of table.columns) {
        add(column.name);
        add(`${table.name}.${column.name}`);
      }
      if (table.primaryKey) add(table.primaryKey.name);
      for (const c of [...table.uniqueConstraints, ...table.checkConstraints, ...table.excludeConstraints]) add(c.name);
      for (const fk of table.foreignKeys) add(fk.name);
      for (const index of table.indexes ?? []) add(index.name);
      for (const trigger of table.triggers ?? []) {
        add(trigger.name);
        add(trigger.functionName);
      }
    }
    for (const view of snapshot.views ?? []) {
      add(view.name);
      for (const column of view.columns) add(`${view.name}.${column}`);
    }
    for (const sequence of snapshot.sequences ?? []) add(sequence.name);
    for (const type of snapshot.types ?? []) add(type.name);
    for (const routine of snapshot.routines ?? []) add(routine.name);
    for (const extension of snapshot.extensions ?? []) add(extension.name);
    for (const collation of snapshot.collations ?? []) add(collation.name);
  }
  return names;
}

/** Strip a schema prefix and quotes: `"public"."Books"` reads as books. */
export function bareName(name: string): string {
  const parts = name.trim().replace(/"/g, "").split(".");
  const lower = parts.map((p) => p.toLowerCase());
  // schema.table.column keeps table.column; schema.table keeps table.
  if (lower.length >= 3) return `${lower[lower.length - 2]}.${lower[lower.length - 1]}`;
  return lower.join(".");
}

/**
 * Whether one cited name exists. "books" and "books.title" are looked up as
 * they are. "public.books" counts when public is a schema the model was shown
 * and books is in it. "orders.title" does not count just because some other
 * table has a title column: a pair is only known as a pair.
 */
export function isKnownName(raw: string, known: Set<string>): boolean {
  const name = bareName(raw);
  if (!name || known.has(name)) return true;
  const parts = name.split(".");
  return parts.length === 2 && known.has(`schema:${parts[0]}`) && known.has(parts[1]);
}

export type NameCheck<T> = {
  kept: T[];
  /** Items dropped because they named something that does not exist. */
  dropped: { item: T; unknown: string[] }[];
};

/**
 * Keep the items whose cited names all exist. `namesOf` returns the names one
 * item cites. A name with a schema prefix is checked without it, and
 * "table.column" is checked as a pair first, then as the table alone.
 */
export function checkCitedNames<T>(
  items: readonly T[],
  namesOf: (item: T) => readonly string[],
  known: Set<string>
): NameCheck<T> {
  const kept: T[] = [];
  const dropped: NameCheck<T>["dropped"] = [];
  for (const item of items) {
    const unknown = namesOf(item).filter((raw) => !isKnownName(raw, known));
    if (unknown.length === 0) kept.push(item);
    else dropped.push({ item, unknown });
  }
  return { kept, dropped };
}

/** The levels the engine uses, in rising order. */
export const LEVELS = ["patch", "additive", "breaking"] as const;
export type Level = (typeof LEVELS)[number];

/**
 * The grade lock. The engine's level wins every time; this only reports
 * whether the model disagreed, so the screen and the benchmark can count it.
 */
export function lockLevel(engineLevel: Level, modelLevel: unknown): { level: Level; modelDisagreed: boolean } {
  const said = typeof modelLevel === "string" ? modelLevel.toLowerCase() : null;
  return { level: engineLevel, modelDisagreed: said !== null && said !== engineLevel };
}

export type SqlCheck = {
  /** False when the SQL cannot be offered at all. */
  ok: boolean;
  /** Why it cannot, in a sentence for the screen and for the retry prompt. */
  problems: string[];
  grade: SqlGrade | null;
  risk: RunRisk | null;
  statements: number;
};

/**
 * The checks SQL written by the model has to pass before it is shown.
 * Transaction control is refused because the app wraps every run in its own
 * transaction. The grade and the risk come from the engine, never the model.
 */
export function checkGeneratedSql(sql: string, options: { allowDataLoss?: boolean } = {}): SqlCheck {
  const problems: string[] = [];
  if (!hasExecutableSql(sql)) {
    return { ok: false, problems: ["The answer has no SQL statement in it."], grade: null, risk: null, statements: 0 };
  }
  if (containsTransactionControl(sql)) {
    problems.push("It uses BEGIN, COMMIT or ROLLBACK. Schema Studio wraps every run in its own transaction, so leave those out.");
  }
  const grade = gradeSql(sql);
  const risk = analyseRunRisk([{ scriptName: "ai_draft", version: "0.0.0", sqlContent: sql }]);
  if (!options.allowDataLoss && risk.dataLoss.length > 0) {
    problems.push(
      `It deletes data (${risk.dataLoss.flatMap((d) => d.kinds).join(", ")}). Only write that when the request asks for it.`
    );
  }
  return { ok: problems.length === 0, problems, grade, risk, statements: splitStatements(sql).length };
}

/**
 * The table and column names a SQL text uses that the schema does not have.
 * Shallow on purpose: it reads identifiers after the keywords that introduce a
 * table (FROM, JOIN, TABLE, INTO, UPDATE, REFERENCES, ON) and leaves column
 * checking to the dry run, which is the real test.
 */
export function unknownTablesInSql(sql: string, snapshot: SchemaSnapshot, createdHere: Set<string> = new Set()): string[] {
  const tables = new Set([
    ...snapshot.tables.map((t) => t.name.toLowerCase()),
    ...(snapshot.views ?? []).map((v) => v.name.toLowerCase()),
  ]);
  const created = new Set(createdHere);
  const pattern =
    /\b(?:create\s+(?:unlogged\s+)?table(?:\s+if\s+not\s+exists)?|create\s+(?:materialized\s+)?view|alter\s+table(?:\s+if\s+exists)?(?:\s+only)?|drop\s+table(?:\s+if\s+exists)?|from|join|into|update|references|truncate(?:\s+table)?)\s+((?:"[^"]+"|[a-z_][a-z0-9_$]*)(?:\s*\.\s*(?:"[^"]+"|[a-z_][a-z0-9_$]*))?)/gi;
  const unknown: string[] = [];
  const text = sql.replace(/--[^\n]*/g, " ");
  for (const match of text.matchAll(pattern)) {
    const keyword = match[0].toLowerCase();
    const name = bareName(match[1]).split(".").slice(-1)[0];
    if (keyword.startsWith("create")) {
      created.add(name);
      continue;
    }
    if (["select", "lateral", "only", "unnest", "generate_series", "values"].includes(name)) continue;
    if (!tables.has(name) && !created.has(name) && !unknown.includes(name)) unknown.push(name);
  }
  return unknown;
}
