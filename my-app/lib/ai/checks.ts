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
import { analyseRunRisk, scriptLabel, type RunRisk } from "../deploy-risk";
import { gradeSql, type SqlGrade } from "../change-type";
import {
  codeBodiesIn,
  containsTransactionControl,
  findRowDestroyingStatements,
  hasExecutableSql,
  maskNonCode,
  splitStatements,
} from "../sql-guard";

/**
 * Every name a model may cite: tables, columns as table.column, views, types,
 * routines and the rest. Each object is also there with its own schema in
 * front (public.books, public.books.title), so a name with a schema is only
 * known in the schema that really has it.
 */
export function knownNames(...snapshots: ReadonlyArray<SchemaSnapshot | null | undefined>): Set<string> {
  const names = new Set<string>();
  const add = (name: string | null | undefined) => {
    if (name) names.add(name.toLowerCase());
  };
  for (const snapshot of snapshots) {
    if (!snapshot) continue;
    const schema = snapshot.schema;
    // The name alone and the name with this snapshot's schema in front.
    const addObject = (name: string | null | undefined) => {
      if (!name) return;
      add(name);
      add(`${schema}.${name}`);
    };
    add(`schema:${schema}`);
    for (const table of snapshot.tables) {
      addObject(table.name);
      for (const column of table.columns) {
        // A bare column name, but never schema.column: that is not a name.
        add(column.name);
        addObject(`${table.name}.${column.name}`);
      }
      if (table.primaryKey) addObject(table.primaryKey.name);
      for (const c of [...table.uniqueConstraints, ...table.checkConstraints, ...table.excludeConstraints]) addObject(c.name);
      for (const fk of table.foreignKeys) addObject(fk.name);
      for (const index of table.indexes ?? []) addObject(index.name);
      for (const trigger of table.triggers ?? []) {
        addObject(trigger.name);
        addObject(trigger.functionName);
      }
    }
    for (const view of snapshot.views ?? []) {
      addObject(view.name);
      for (const column of view.columns) addObject(`${view.name}.${column}`);
    }
    for (const sequence of snapshot.sequences ?? []) addObject(sequence.name);
    for (const type of snapshot.types ?? []) addObject(type.name);
    for (const routine of snapshot.routines ?? []) addObject(routine.name);
    for (const extension of snapshot.extensions ?? []) addObject(extension.name);
    for (const collation of snapshot.collations ?? []) addObject(collation.name);
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
 * Whether one cited name exists, looked up whole, quotes off and lower-cased.
 * "books" and "books.title" are known as they are. "public.books" and
 * "public.books.title" count only when public is a schema the model was shown
 * and books is in that schema: knownNames adds each object with its own schema
 * in front. So "orders.title" does not count just because some other table
 * has a title column, "cmp_prod.refunds" does not count when refunds is only
 * in cmp_dev, and "public.title" does not count when title is only a column.
 */
export function isKnownName(raw: string, known: Set<string>): boolean {
  const name = raw
    .trim()
    .replace(/"/g, "")
    .split(".")
    .map((part) => part.trim().toLowerCase())
    .join(".");
  return !name || known.has(name);
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
  // The risk scan reads a DO body only when it is written between $$ marks,
  // and never a function body. A body can also be a '' or E'' string, and a
  // function or trigger deletes rows when it runs later. So every body is read
  // here too, and what it deletes is added to the script's data loss.
  const scriptKinds = new Set(risk.dataLoss.flatMap((d) => d.kinds));
  const kinds = new Set(scriptKinds);
  for (const body of codeBodiesIn(sql).bodies) {
    for (const kind of findRowDestroyingStatements(body.text)) kinds.add(kind);
  }
  if (kinds.size > scriptKinds.size) {
    risk.dataLoss = [{ label: scriptLabel("ai_draft", "0.0.0"), scriptName: "ai_draft", version: "0.0.0", kinds: [...kinds] }];
  }
  if (!options.allowDataLoss && risk.dataLoss.length > 0) {
    problems.push(
      `It deletes data (${risk.dataLoss.flatMap((d) => d.kinds).join(", ")}). Only write that when the request asks for it.`
    );
  }
  return { ok: problems.length === 0, problems, grade, risk, statements: splitStatements(sql).length };
}

/** A table or view a SQL text names, after one of the keywords that introduce one. */
export type TableRef = {
  /** The schema written in front of it, lower-cased, or null. */
  schema: string | null;
  name: string;
  /** True for CREATE TABLE and CREATE VIEW, and for RENAME TO. */
  creates: boolean;
  /** Set when the name is inside a DO block or a function body. */
  inBody?: true;
};

const TABLE_REF =
  /\b(?:create\s+(?:unlogged\s+)?table(?:\s+if\s+not\s+exists)?|create\s+(?:or\s+replace\s+)?(?:materialized\s+)?view(?:\s+if\s+not\s+exists)?|rename\s+to|alter\s+table(?:\s+if\s+exists)?(?:\s+only)?|drop\s+table(?:\s+if\s+exists)?|from|join|into|update|references|truncate(?:\s+table)?)\s+((?:"[^"]+"|[a-z_][a-z0-9_$]*)(?:\s*\.\s*(?:"[^"]+"|[a-z_][a-z0-9_$]*))?)/gi;

/**
 * Words that can follow FROM, UPDATE, INTO and the rest without being a
 * table: ON UPDATE CASCADE, DO UPDATE SET, FOR UPDATE OF, FROM ONLY books.
 */
const NOT_A_TABLE = new Set([
  "select", "lateral", "only", "unnest", "generate_series", "values", "cascade", "set", "restrict",
  "no", "on", "of", "or", "nowait", "skip", "default", "null", "current", "with", "rows",
]);

function unquotePart(part: string): string {
  const trimmed = part.trim();
  return trimmed.startsWith('"') ? trimmed.slice(1, -1) : trimmed.toLowerCase();
}

/** Functions whose parentheses hold FROM as a word: EXTRACT(year FROM d), TRIM(BOTH ' ' FROM name). */
const FROM_AS_A_WORD = /\b(?:extract|substring|trim|overlay)\s*$/i;

/**
 * Whether the FROM at `at` (in masked code) is part of an expression, not the
 * start of a list of tables: x IS DISTINCT FROM y, EXTRACT(year FROM
 * o.created_at), SUBSTRING(name FROM 2). What follows it is a column.
 */
function fromIsInAnExpression(code: string, at: number): boolean {
  if (/\bis\s+(?:not\s+)?distinct\s+$/i.test(code.slice(Math.max(0, at - 40), at))) return true;
  // Walk back to the "(" this FROM is inside, if any, and read the word before it.
  let depth = 0;
  for (let i = at - 1; i >= 0; i -= 1) {
    const ch = code[i];
    if (ch === ";") return false;
    if (ch === ")") depth += 1;
    if (ch === "(") {
      if (depth === 0) return FROM_AS_A_WORD.test(code.slice(Math.max(0, i - 20), i));
      depth -= 1;
    }
  }
  return false;
}

/**
 * The table refs in one piece of code. `inBody` is for the inside of a DO
 * block or a function, which is PL/pgSQL: there INTO also follows SELECT and
 * RETURNING to name a variable, so only INSERT INTO and MERGE INTO count, and
 * FETCH … FROM and MOVE … FROM name a cursor.
 */
function tableRefsInCode(sql: string, inBody: boolean): TableRef[] {
  const text = maskNonCode(sql, { keepQuotedNames: true });
  const refs: TableRef[] = [];
  for (const match of text.matchAll(TABLE_REF)) {
    const keyword = match[0].toLowerCase();
    const parts = match[1].split(".").map(unquotePart);
    const name = parts[parts.length - 1];
    if (NOT_A_TABLE.has(name) && !match[1].includes('"')) continue;
    const before = text.slice(Math.max(0, match.index - 40), match.index);
    const isFrom = keyword.startsWith("from");
    if (isFrom && fromIsInAnExpression(text, match.index)) continue;
    // FROM jsonb_each(x) or JOIN unnest(y): a function call, not a table.
    // A schema in front is kept, so the other-schema check still sees it.
    const afterName = text.slice(match.index + match[0].length);
    if ((isFrom || keyword.startsWith("join")) && parts.length === 1 && /^\s*\(/.test(afterName)) continue;
    if (inBody) {
      if (keyword.startsWith("into") && !/\b(?:insert|merge)\s+$/i.test(before)) continue;
      const statement = text.slice(text.lastIndexOf(";", match.index) + 1, match.index);
      if (isFrom && /(?:^|\b(?:begin|then|else|loop)\b)\s*(?:fetch|move)\b/i.test(statement)) continue;
    }
    const ref: TableRef = {
      schema: parts.length > 1 ? parts[0].toLowerCase() : null,
      name: name.toLowerCase(),
      creates: keyword.startsWith("create") || keyword.startsWith("rename"),
    };
    if (inBody) ref.inBody = true;
    refs.push(ref);
  }
  return refs;
}

/**
 * The tables and views a SQL text names. Strings and comments are skipped
 * (quoted names are kept). DO blocks and function bodies are read too, in any
 * quoting: PostgreSQL does not look up the tables a PL/pgSQL body uses until
 * it runs, so a made-up table there is only found here. Their refs carry
 * inBody.
 */
export function tableRefsInSql(sql: string): TableRef[] {
  const refs = tableRefsInCode(sql, false);
  for (const body of codeBodiesIn(sql).bodies) refs.push(...tableRefsInCode(body.text, true));
  return refs;
}

/** The names a WITH clause gives its parts: WITH recent AS (...), in the script and in its bodies. */
function cteNamesIn(sql: string): string[] {
  const names: string[] = [];
  for (const piece of [sql, ...codeBodiesIn(sql).bodies.map((body) => body.text)]) {
    const text = maskNonCode(piece, { keepQuotedNames: true });
    for (const match of text.matchAll(/("[^"]+"|[a-z_][a-z0-9_$]*)\s+as\s+(?:not\s+)?(?:materialized\s+)?\(/gi)) {
      names.push(unquotePart(match[1]).toLowerCase());
    }
  }
  return names;
}

/** The catalogs every database has, which a script may read. */
const CATALOG_SCHEMAS = new Set(["pg_catalog", "information_schema"]);

/**
 * The table names a SQL text uses that the schema does not have, inside DO
 * blocks and function bodies too.
 * Shallow on purpose: it reads the name after the keywords that introduce a
 * table (FROM, JOIN, TABLE, INTO, UPDATE, REFERENCES) and leaves columns to
 * the dry run, which is the real test. FROM inside EXTRACT(year FROM
 * created_at) or after IS DISTINCT is not read (see tableRefsInSql), so a
 * column there is not taken for a table. The catalogs are let through:
 * information_schema.columns, and pg_constraint without a schema, which a DO
 * block reads to add a constraint only once.
 */
export function unknownTablesInSql(sql: string, snapshot: SchemaSnapshot, createdHere: Set<string> = new Set()): string[] {
  const tables = new Set([
    ...snapshot.tables.map((t) => t.name.toLowerCase()),
    ...(snapshot.views ?? []).map((v) => v.name.toLowerCase()),
  ]);
  const created = new Set([...createdHere, ...cteNamesIn(sql)]);
  const unknown: string[] = [];
  for (const ref of tableRefsInSql(sql)) {
    if (ref.creates) {
      created.add(ref.name);
      continue;
    }
    if (ref.schema ? CATALOG_SCHEMAS.has(ref.schema) : ref.name.startsWith("pg_")) continue;
    if (tables.has(ref.name) || created.has(ref.name) || unknown.includes(ref.name)) continue;
    unknown.push(ref.name);
  }
  return unknown;
}
