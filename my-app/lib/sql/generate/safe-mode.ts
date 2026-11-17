// Safe mode: finding drops whose object is still in use by something the
// script keeps, and holding those drops back.

import type { CompareReport } from "../../compare/types";
import type { ColumnSnapshot } from "../../postgres";
import { findByName, mentionsName } from "./basics";
import type { SqlStatement } from "./types";

/** Where a column can name a type, a sequence, a function or a collation. */
function columnUses(column: ColumnSnapshot): string[] {
  return [
    column.typeDisplay,
    column.columnDefault ?? "",
    column.generated?.expression ?? "",
    column.collation ?? "",
  ];
}

/**
 * The text of everything safe mode leaves standing in the target because the
 * statement that removes it is commented out: a table that is not dropped, a
 * materialized view that is not dropped, and the columns of a table whose
 * column drop or type change is held back.
 */
function usesKeptBySafeMode(report: CompareReport, statements: SqlStatement[]): string[] {
  const kept: string[] = [];
  for (const statement of statements) {
    if (!statement.destructive && statement.needsArmedDrop !== true) continue;
    if (statement.kind === "DROP_TABLE") {
      const table = report.tablesOnlyInB.find((t) => t.name === statement.tableName);
      if (!table) continue;
      kept.push(...table.columns.flatMap(columnUses));
      // A table that stays keeps its constraints, indexes, triggers and
      // policies as well, and each of them can call a function.
      for (const check of table.checkConstraints) kept.push(check.definition);
      for (const exclude of table.excludeConstraints) kept.push(exclude.definition);
      for (const index of table.indexes ?? []) kept.push(index.definition);
      for (const trigger of table.triggers ?? []) kept.push(trigger.definition);
      for (const policy of table.rowSecurity?.policies ?? []) {
        kept.push(policy.using ?? "", policy.withCheck ?? "");
      }
    } else if (statement.kind === "DROP_VIEW") {
      const view = findByName(report.right.views, statement.tableName);
      if (view) kept.push(view.definition);
    } else if (statement.kind === "DROP_COLUMN" || statement.kind === "ALTER_COLUMN_TYPE") {
      // The statement does not say which column it is, so every column of the
      // table counts. That can only hold back a drop that would have worked.
      const match = report.matchedTables.find((m) => m.left.name === statement.tableName);
      if (match) kept.push(...match.right.columns.flatMap(columnUses));
    }
  }
  return kept;
}

/**
 * Safe mode: hold back the drop of a type, sequence, function or collation
 * that something safe mode leaves in place still uses. Returns how many drops
 * were held back.
 *
 * The target had an extra column `orders.status` of the enum `order_status`.
 * Safe mode commented the column drop out and then ran `DROP TYPE order_status`
 * live. PostgreSQL refuses to drop a type a column still has, and inside the
 * one transaction the apply route uses that took every other change in the
 * script down with it. The same happened with a sequence in a held-back
 * column's default and a function in a held-back table's CHECK.
 *
 * `drops` are the candidate statements, in the order the script runs them.
 * A drop that is held back keeps its own object in the target, and that object
 * can use another one (a function takes an enum, a domain sits on a type), so
 * the search repeats until a pass holds nothing new.
 */
export function holdBackDropsStillInUse(
  report: CompareReport,
  statements: SqlStatement[],
  drops: SqlStatement[]
): number {
  const kept = usesKeptBySafeMode(report, statements);
  if (kept.length === 0) return 0;

  let heldBack = 0;
  let foundOne = true;
  while (foundOne) {
    foundOne = false;
    for (const drop of drops) {
      if (drop.needsArmedDrop === true) continue;
      const name = drop.tableName;
      if (!kept.some((text) => mentionsName(text, name))) continue;
      drop.needsArmedDrop = true;
      heldBack++;
      foundOne = true;
      // What the object that now stays uses in its turn.
      if (drop.kind === "DROP_TYPE") {
        const type = findByName(report.right.types, name);
        if (type) kept.push(type.definition);
      } else if (drop.kind === "DROP_ROUTINE") {
        for (const routine of report.right.routines ?? []) {
          if (routine.name === name) kept.push(routine.definition);
        }
      }
    }
  }
  return heldBack;
}
