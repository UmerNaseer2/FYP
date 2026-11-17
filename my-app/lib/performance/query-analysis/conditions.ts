// Query analysis: reading a plan condition.
//
// Holds the thresholds for when an index is worth suggesting, and the helpers
// that work out which columns a filter compares (filterColumns).

import { LARGE_TABLE_ROWS } from "../sql";
import type { PlanStep } from "./plan-types";
import { rowsHandedOn } from "./plan-helpers";
import type { PlanCatalog, TableRows } from "./catalog";
import { rowsScanned } from "./plan-walk";
import {
  andParts,
  closingIndex,
  comparisonOf,
  isWord,
  splitTop,
  stripOuterParens,
  type Token,
  tokenize,
} from "./tokens";

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
export function qualifiersFor(alias: string | null, relation: string | null): string[] {
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
export function columnOf(side: Token[], quals: string[], columnTypes: Record<string, string>): string | null {
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
export function valueIsFixed(side: Token[], quals: string[]): boolean {
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
export const INDEXABLE_OPERATORS: ReadonlySet<string> = new Set(["=", "<", ">", "<=", ">="]);

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
export const INDEX_ON_WHAT =
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
export function testsOnlySubqueries(filter: string): boolean {
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
 * one split between parallel workers, is judged by the same share. An
 * estimated parallel scan's Plan Rows are one process's share, so
 * rowsHandedOn multiplies them back up: judged per process, a filter keeping
 * a fifth of the table looked like one keeping a twelfth. When that cannot
 * be done, the scan is not judged at all.
 */
export function readsManyKeepsFew(step: PlanStep, tableRows: TableRows): boolean {
  if (step.nodeType !== "Seq Scan" || step.filter === null) return false;
  const kept = rowsHandedOn(step);
  if (kept === null) return false;
  const scanned = rowsScanned(step, tableRows);
  return scanned >= LARGE_TABLE_ROWS && kept <= scanned * SELECTIVE_SHARE;
}

/** Column name → type for one table, from the catalog. Empty when unknown. */
export function columnTypesFor(
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
