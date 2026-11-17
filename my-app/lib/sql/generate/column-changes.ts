// Questions about a matched table's changing columns: which ones are retyped
// or rebuilt, and which indexes, constraints and expressions name them.

import type { ConstraintDiff, TableMatch } from "../../compare/types";
import type {
  ColumnSnapshot,
  ConstraintSnapshot,
  IndexSnapshot,
  TableSnapshot,
} from "../../postgres";
import { describeComputed } from "../../compare/diff";
import { mentionsName, normalizeType } from "./basics";

// Build a full CREATE TABLE statement for a table that is missing from B.
// FK constraints are intentionally omitted — they are emitted as separate
// ALTER TABLE ADD CONSTRAINT statements later so that the order in which
// tables appear in the script doesn't cause "referenced table doesn't exist yet"
// errors.
//
// The table name is written UNQUALIFIED (no schema prefix). The apply route runs
// `SET LOCAL search_path TO <targetSchema>` (target-only) before executing, so an
// unqualified name always resolves to the schema being applied to — at the
// original apply AND when the stored script is later replayed onto a different
// schema by Version Sync. A hard-coded schema qualifier would ignore search_path
// and silently hit the original schema on replay.
/**
 * Every non-FK constraint on a table, paired with the kind it is reported as.
 *
 * buildCreateTable and lookupConstraintDef both used to walk the four buckets
 * by hand, so adding a fifth kind of constraint meant remembering two separate
 * places. Forgetting either one fails SILENTLY: the constraint is simply never
 * emitted and the migration produces a table that does not match the source.
 * One list, read by both, means a new bucket is added once.
 */
export function nonFkConstraints(
  table: TableSnapshot
): { kind: ConstraintDiff["kind"]; constraint: ConstraintSnapshot }[] {
  const all: { kind: ConstraintDiff["kind"]; constraint: ConstraintSnapshot }[] = [];
  if (table.primaryKey) all.push({ kind: "PRIMARY KEY", constraint: table.primaryKey });
  for (const c of table.uniqueConstraints) all.push({ kind: "UNIQUE", constraint: c });
  for (const c of table.checkConstraints) all.push({ kind: "CHECK", constraint: c });
  for (const c of table.excludeConstraints) all.push({ kind: "EXCLUDE", constraint: c });
  return all;
}

/**
 * The matched columns of a table that the script changes with ALTER COLUMN ...
 * TYPE: a different type, or the same type with a different collation. Same
 * test as the retypedTables walk in objectPhases and the branch that writes the
 * statement.
 *
 * PostgreSQL refuses that statement while a policy, a trigger or a generated
 * column still names the column, so each of those has to be out of the way
 * first. The callers are what moves them.
 */
function retypedColumns(match: TableMatch): TableMatch["columnMatches"] {
  return match.columnMatches.filter(
    (col) =>
      normalizeType(col.left.typeDisplay) !== normalizeType(col.right.typeDisplay) ||
      (col.left.collation !== undefined &&
        col.right.collation !== undefined &&
        col.left.collation !== col.right.collation)
  );
}

/**
 * Does `text` name one of the columns whose type changes? `side` says whose
 * name for the column to look for: text taken from the target uses the
 * target's names, text taken from the source uses the source's.
 *
 * A text search, like expressionCallsRoutine. Matching too much only moves or
 * rebuilds something that could have stayed where it was.
 */
export function namesRetypedColumn(match: TableMatch, text: string, side: "left" | "right"): boolean {
  return retypedColumns(match).some((col) => mentionsName(text, col[side].name));
}

/**
 * A computed column that is the same on both sides, and reads a column whose
 * type changes. PostgreSQL answers "cannot alter type of a column used by a
 * generated column", so the computed column comes off before the type change
 * and goes back on after it. It fills its own rows again from the expression,
 * so nothing is lost.
 */
export function rebuiltForTypeChange(match: TableMatch, col: TableMatch["columnMatches"][number]): boolean {
  const before = describeComputed(col.right);
  return (
    before !== null &&
    before === describeComputed(col.left) &&
    !!col.right.generated &&
    namesRetypedColumn(match, col.right.generated.expression, "right")
  );
}

/**
 * Does `text`, taken from a trigger or a policy in the target, name a column
 * the script retypes or rebuilds? PostgreSQL refuses the type change while the
 * trigger or policy is there ("cannot alter type of a column used in a policy
 * definition"), and the DROP COLUMN ... CASCADE of a rebuild removes it without
 * a word. Either way it has to come off first and go back on afterwards.
 */
export function namesChangingColumn(match: TableMatch, text: string): boolean {
  if (namesRetypedColumn(match, text, "right")) return true;
  const rebuilt = rebuiltComputedColumns(match);
  return match.columnMatches.some(
    (col) => rebuilt.has(col.left.name) && mentionsName(text, col.right.name)
  );
}

/**
 * Type changes that safe mode has to hold back, because a computed column that
 * reads the column is staying where it is. Two computed columns stay in safe
 * mode: one only the target has (its drop is destructive), and a VIRTUAL one
 * that becomes ordinary (its rebuild is destructive, see losesComputedValues).
 *
 * Returns the retyped column, by the source's name for it, and the computed
 * columns in its way.
 */
export function retypesBehindKeptComputedColumns(match: TableMatch): Map<string, string[]> {
  const kept: ColumnSnapshot[] = [
    ...match.columnsOnlyInB,
    ...match.columnMatches
      .filter((col) => col.left.generated === null && !stopsComputingInPlace(col))
      .map((col) => col.right),
  ];
  // A column that is itself rebuilt gets no ALTER COLUMN ... TYPE to hold back.
  const rebuilt = rebuiltComputedColumns(match);
  const held = new Map<string, string[]>();
  for (const col of retypedColumns(match)) {
    if (rebuilt.has(col.left.name)) continue;
    const inTheWay = kept
      .filter((k) => k.generated && mentionsName(k.generated.expression, col.right.name))
      .map((k) => k.name);
    if (inTheWay.length > 0) held.set(col.left.name, inTheWay);
  }
  return held;
}

/**
 * The columns a match rebuilds because their GENERATED ALWAYS AS (…) clause
 * appears, goes, or changes. Named by the SOURCE's name for the column, which
 * is what the table carries once the rename step has run.
 *
 * Three places need this same answer and must not drift apart: the walk that
 * queues cascaded views for rebuild, the index phase that puts back the indexes
 * the CASCADE took with it, and the branch that writes the DROP/ADD pair.
 */
export function rebuiltComputedColumns(match: TableMatch): Set<string> {
  const names = new Set<string>();
  for (const col of match.columnMatches) {
    if (stopsComputingInPlace(col)) continue;
    const before = describeComputed(col.right);
    const after = describeComputed(col.left);
    if (before !== null && after !== null && before !== after) names.add(col.left.name);
    // The same on both sides, but in the way of another column's type change.
    if (rebuiltForTypeChange(match, col)) names.add(col.left.name);
  }
  return names;
}

/**
 * A STORED computed column in the target that the source has as an ordinary
 * column. ALTER COLUMN ... DROP EXPRESSION (PostgreSQL 13 and up) turns it into
 * an ordinary column and keeps every value it holds, so it is not rebuilt.
 * Rebuilding it, the way every other change of a computed column is handled,
 * dropped those values and brought the column back empty.
 *
 * A VIRTUAL one (PostgreSQL 18) holds no values to keep, and DROP EXPRESSION
 * refuses it, so it is still rebuilt.
 */
export function stopsComputingInPlace(col: TableMatch["columnMatches"][number]): boolean {
  return col.left.generated === null && col.right.generated?.storage === "STORED";
}

/**
 * Whether a piece of SQL names this column. Quoted and bare both count, and the
 * match is on whole words so "user_id" is not found inside "user_identity".
 *
 * Case is ignored on purpose, even though a quoted identifier is case-sensitive.
 * That can say yes about a column the statement never touched, and the cost of
 * that is one CREATE INDEX or ADD CONSTRAINT whose guard finds the object still
 * there and skips it. A wrong no is the expensive direction: the index stays
 * dropped and nobody finds out until something is slow.
 */
function mentionsColumn(sql: string, columnName: string): boolean {
  const escaped = columnName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w"])"?${escaped}"?($|[^\\w"])`, "i").test(sql);
}

/**
 * Whether an index reads the column — as one of its keys, or inside an
 * expression. An expression index (`lower(email)`) records no column at all,
 * so the definition text is the only place its name appears.
 */
export function indexTouchesColumn(index: IndexSnapshot, columnName: string): boolean {
  return index.columns.includes(columnName) || mentionsColumn(index.definition, columnName);
}

/** Same question for a constraint, whose columns are a hint the same way. */
export function constraintTouchesColumn(
  columns: string[],
  definition: string,
  columnName: string
): boolean {
  return columns.includes(columnName) || mentionsColumn(definition, columnName);
}
