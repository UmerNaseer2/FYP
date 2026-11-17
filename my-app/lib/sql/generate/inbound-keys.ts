// Foreign keys on other tables that point at a table being changed: finding
// them, dropping them before a key change and putting them back afterwards.

import type { CompareReport, TableMatch } from "../../compare/types";
import type { ForeignKeySnapshot, TableSnapshot } from "../../postgres";
// Severity is NOT decided here. These four helpers live in the compare engine
// and are the single rule for how dangerous each kind of change is, so the
// warning on a statement and the pill in the report are one decision instead of
// two implementations that have to be kept in step by hand.
import { constraintChangeSeverity } from "../../compare/diff";
import { q } from "./basics";
import { nonFkConstraints } from "./column-changes";
import { onlyIfMissing, tableConstraintQuery } from "./statement-helpers";
import { buildFkDef } from "./tables";
import type { SqlStatement } from "./types";

/**
 * A foreign key on ANOTHER table that points at this one.
 *
 * PostgreSQL refuses to drop a PRIMARY KEY or UNIQUE constraint while a foreign
 * key depends on it, and that key is nearly always on a different table — so
 * the drop-FKs-first rule inside one table's own diff never sees it. The
 * migration stopped on "cannot drop constraint … because other objects depend
 * on it", halfway through the one transaction, with nothing applied.
 *
 * Read off the TARGET, because those are the keys actually sitting in the
 * database the script runs against. `tableName` is the name that table carries
 * by the time the ALTERs run — every rename happens in an earlier phase.
 */
export type InboundForeignKey = {
  tableName: string;
  fk: ForeignKeySnapshot;
  /**
   * False for a key on a table the script drops later. It still has to come off
   * before the constraint drop — the doomed table is very much still there at
   * that point — but there is nothing left to put it back on.
   */
  survives: boolean;
  /** The referenced columns under the names they carry once renames have run. */
  referencedColumnsAfterRename: string[];
  /** The ADD that puts it back, with tables and columns under their new names. */
  definition: string;
};

/**
 * Every inbound foreign key, keyed by the referenced table's name IN THE TARGET
 * — which is how the alter step finds its own entry before its rename lands.
 *
 * A key the owning table's own diff already drops is left out: that section
 * drops and re-adds it on its own schedule, and a second copy here would be an
 * ADD racing a DROP of the same constraint.
 */
export function inboundForeignKeysByTable(
  report: CompareReport,
  targetSchema: string
): Map<string, InboundForeignKey[]> {
  const byTable = new Map<string, InboundForeignKey[]>();
  // What each matched table is called before and after the rename phase.
  const renamedTo = new Map<string, string>();
  for (const match of report.matchedTables) renamedTo.set(match.right.name, match.left.name);
  // The same for each matched table's columns, keyed by the table's name in
  // the target. A key put back after a drop has to name the columns as they
  // are called by then, on both its own table and the one it points at.
  const columnsRenamedTo = new Map<string, Map<string, string>>();
  for (const match of report.matchedTables) {
    const names = new Map<string, string>();
    for (const col of match.columnMatches) names.set(col.right.name, col.left.name);
    columnsRenamedTo.set(match.right.name, names);
  }
  const afterRename = (tableName: string, columns: string[]): string[] =>
    columns.map((name) => columnsRenamedTo.get(tableName)?.get(name) ?? name);

  const owners: { table: TableSnapshot; survives: boolean; handled: Set<string> }[] = [
    ...report.matchedTables.map((match) => ({
      table: match.right,
      survives: true,
      handled: new Set(
        match.constraintDiffs
          .filter((diff) => diff.kind === "FOREIGN KEY")
          .map((diff) => diff.rightName ?? "")
      ),
    })),
    ...report.tablesOnlyInB.map((table) => ({
      table,
      survives: false,
      handled: new Set<string>(),
    })),
  ];

  for (const owner of owners) {
    for (const fk of owner.table.foreignKeys) {
      const referenced = fk.referencedTable;
      if (!referenced || !renamedTo.has(referenced)) continue;
      if (owner.handled.has(fk.name)) continue;
      const referencedColumnsAfterRename = afterRename(referenced, fk.referencedColumns);
      const columnsAfterRename = afterRename(owner.table.name, fk.columns);
      const referencedAfterRename = renamedTo.get(referenced) ?? referenced;
      // True when the key's own text names something by a name it no longer has.
      const renamed =
        referencedAfterRename !== referenced ||
        columnsAfterRename.some((name, at) => name !== fk.columns[at]) ||
        referencedColumnsAfterRename.some((name, at) => name !== fk.referencedColumns[at]);
      const entry: InboundForeignKey = {
        tableName: renamedTo.get(owner.table.name) ?? owner.table.name,
        fk,
        survives: owner.survives,
        referencedColumnsAfterRename,
        // The tables and columns may be mid-rename, and then the key cannot go
        // back verbatim: it would name a table or column that no longer exists.
        definition: buildFkDef(
          {
            ...fk,
            columns: columnsAfterRename,
            referencedTable: referencedAfterRename,
            referencedColumns: referencedColumnsAfterRename,
          },
          targetSchema,
          renamed
        ),
      };
      const list = byTable.get(referenced);
      if (list) list.push(entry);
      else byTable.set(referenced, [entry]);
    }
  }
  return byTable;
}

/**
 * The inbound keys that depend on one PRIMARY KEY or UNIQUE constraint.
 *
 * A foreign key names the columns it references, and PostgreSQL only accepts a
 * reference whose column list matches a key exactly — so the column list is
 * what ties the two together, not any name the key has.
 */
export function dependentsOnKey(
  match: TableMatch,
  constraintName: string,
  inboundFks: InboundForeignKey[]
): InboundForeignKey[] {
  const key = nonFkConstraints(match.right).find(
    (entry) => entry.constraint.name === constraintName
  );
  if (!key) return [];
  return inboundFks.filter((entry) =>
    sameColumnList(entry.fk.referencedColumns, key.constraint.columns)
  );
}

/** Whether the source still has a PRIMARY KEY or UNIQUE over exactly these columns. */
export function sourceKeepsKeyFor(match: TableMatch, columns: string[]): boolean {
  return nonFkConstraints(match.left).some(
    (entry) =>
      (entry.kind === "PRIMARY KEY" || entry.kind === "UNIQUE") &&
      sameColumnList(entry.constraint.columns, columns)
  );
}

/** Two column lists naming the same columns, order and all. */
function sameColumnList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

/**
 * One name for an inbound key. Constraint names are only unique within their
 * own table, so two tables can each have a key called "fk_product".
 */
export function inboundKeyId(entry: InboundForeignKey): string {
  return JSON.stringify([entry.tableName, entry.fk.name]);
}

/** The DROP that takes an inbound key off before something it depends on goes. */
export function dropInboundKeyStatement(
  entry: InboundForeignKey,
  reason: string,
  destructive: boolean
): SqlStatement {
  return {
    sql: `ALTER TABLE ${q(entry.tableName)} DROP CONSTRAINT IF EXISTS ${q(entry.fk.name)};`,
    description: `Drop FK "${entry.fk.name}" from "${entry.tableName}" — ${reason}`,
    kind: "DROP_CONSTRAINT",
    severity: constraintChangeSeverity("FOREIGN KEY", "drop"),
    tableName: entry.tableName,
    destructive,
  };
}

/** The ADD that puts an inbound key back once what it points at is back. */
export function restoreInboundKeyStatement(entry: InboundForeignKey): SqlStatement {
  return {
    sql: onlyIfMissing(
      tableConstraintQuery(entry.tableName, entry.fk.name),
      `ALTER TABLE ${q(entry.tableName)} ADD CONSTRAINT ${q(entry.fk.name)} ${entry.definition};`
    ),
    description: `Put FK "${entry.fk.name}" on "${entry.tableName}" back`,
    kind: "ADD_CONSTRAINT",
    severity: constraintChangeSeverity("FOREIGN KEY", "add"),
    tableName: entry.tableName,
    destructive: false,
  };
}
