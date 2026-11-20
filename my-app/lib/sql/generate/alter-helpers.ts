// Smaller pieces of the per-table ALTER work: constraints lost to a column
// rebuild, possible-rename notes, dropping a target-only column, and renaming
// owned sequences.

import type { CompareReport, TableMatch } from "../../compare/types";
import type { ColumnSnapshot } from "../../postgres";
// Severity is NOT decided here. These four helpers live in the compare engine
// and are the single rule for how dangerous each kind of change is, so the
// warning on a statement and the pill in the report are one decision instead of
// two implementations that have to be kept in step by hand.
import { constraintChangeSeverity, columnMatchPercent } from "../../compare/diff";
import { sequenceOwnerTable } from "../../postgres/snapshot-facts";
import { q } from "./basics";
import { constraintTouchesColumn, nonFkConstraints } from "./column-changes";
import { manualNote, onlyIfMissing, onlyIfPresent, ownedSequenceQuery, tableConstraintQuery } from "./statement-helpers";
import { buildFkDef } from "./tables";
import type { SqlStatement } from "./types";

// ---------------------------------------------------------------------------
// Per-table ALTER statements
// ---------------------------------------------------------------------------

/**
 * The constraints a column rebuild has to put back.
 *
 * DROP COLUMN ... CASCADE takes every constraint that names the column with it.
 * One that DIFFERS between the schemas is re-added by the constraint section
 * of alterStatementsForMatch, but one that is identical in both is in no diff at all — so without
 * this it is simply gone: the CHECK that kept the column sane, or the UNIQUE
 * that kept it unique, and the next comparison still calls the target in sync.
 *
 * Foreign keys come back in their own list because they run last, once every
 * table has all of its columns (see fkStmts in alterStatementsForMatch).
 */
export function constraintsAfterColumnRebuild(
  match: TableMatch,
  columnName: string,
  tName: string,
  sourceSchema: string
): { stmts: SqlStatement[]; fkStmts: SqlStatement[] } {
  const stmts: SqlStatement[] = [];
  const fkStmts: SqlStatement[] = [];
  // Anything the constraint section is already going to write. Adding it here
  // as well would be a second copy of the same ADD, and ahead of the DROP that
  // has to come first.
  const alreadyHandled = new Set(
    match.constraintDiffs
      .map((diff) => diff.leftName)
      .filter((name): name is string => Boolean(name))
  );
  for (const { kind, constraint } of nonFkConstraints(match.left)) {
    if (alreadyHandled.has(constraint.name)) continue;
    if (!constraintTouchesColumn(constraint.columns, constraint.definition, columnName)) continue;
    stmts.push({
      sql: onlyIfMissing(
        tableConstraintQuery(tName, constraint.name),
        `ALTER TABLE ${q(tName)} ADD CONSTRAINT ${q(constraint.name)} ${constraint.definition};`
      ),
      description:
        `Put ${kind} "${constraint.name}" on "${tName}" back — CASCADE took it ` +
        `with the rebuilt column "${columnName}"`,
      kind: "ADD_CONSTRAINT",
      severity: constraintChangeSeverity(kind, "add"),
      tableName: tName,
      destructive: false,
    });
  }
  for (const fk of match.left.foreignKeys) {
    if (alreadyHandled.has(fk.name)) continue;
    if (!constraintTouchesColumn(fk.columns, fk.definition, columnName)) continue;
    fkStmts.push({
      sql: onlyIfMissing(
        tableConstraintQuery(tName, fk.name),
        `ALTER TABLE ${q(tName)} ADD CONSTRAINT ${q(fk.name)} ${buildFkDef(fk, sourceSchema)};`
      ),
      description:
        `Put FK "${fk.name}" on "${tName}" back — CASCADE took it with the ` +
        `rebuilt column "${columnName}"`,
      kind: "ADD_CONSTRAINT",
      severity: constraintChangeSeverity("FOREIGN KEY", "add"),
      tableName: tName,
      destructive: false,
    });
  }
  return { stmts, fkStmts };
}

/**
 * The note written beside an ADD COLUMN when the comparison thinks the new
 * column may be an old one under a new name, but was not sure enough to write
 * a RENAME itself.
 *
 * Without it the script only shows an ADD and a DROP. Run as they are, the new
 * column starts empty and the values stay behind in the old one (or go with it
 * when data loss is allowed). The note says so and gives the ready RENAME, so
 * the reader who knows it is a rename has the statement to use.
 */
export function possibleColumnRenameNote(
  match: TableMatch,
  newColumn: string,
  tName: string
): SqlStatement | null {
  const guess = match.possibleColumnMatches.find((candidate) => candidate.leftName === newColumn);
  if (!guess) return null;
  // Only a pair this script really adds and drops.
  if (!match.columnsOnlyInB.some((col) => col.name === guess.rightName)) return null;
  const rename =
    `ALTER TABLE ${q(tName)} RENAME COLUMN ${q(guess.rightName)} TO ${q(guess.leftName)};`;
  return manualNote(
    `"${guess.rightName}" and "${guess.leftName}" in "${tName}" may be one column that was ` +
      `renamed (${columnMatchPercent(guess.score)}% match). This script adds ` +
      `"${guess.leftName}" as a new, empty column and drops "${guess.rightName}" (the drop ` +
      `is held back in safe mode), so the values are not carried over. If it is a rename, run this in place of that ADD COLUMN ` +
      `and DROP COLUMN pair, then compare again: ${rename}`,
    `Possible rename of column "${guess.rightName}" to "${guess.leftName}" in "${tName}"`,
    tName
  );
}

/** The same note for a table: see possibleColumnRenameNote. */
export function possibleTableRenameNote(report: CompareReport, newTable: string): SqlStatement | null {
  const guess = report.possibleTableMatches.find((candidate) => candidate.leftName === newTable);
  if (!guess) return null;
  if (!report.tablesOnlyInB.some((table) => table.name === guess.rightName)) return null;
  const rename = `ALTER TABLE ${q(guess.rightName)} RENAME TO ${q(guess.leftName)};`;
  return manualNote(
    `"${guess.rightName}" and "${guess.leftName}" may be one table that was renamed ` +
      `(${guess.score}% match). This script creates "${guess.leftName}" as a new, empty ` +
      `table and drops "${guess.rightName}" (the drop is held back in safe mode), so the ` +
      `rows are not carried over. If it is a ` +
      `rename, run this on the target first, then compare again: ${rename}`,
    `Possible rename of table "${guess.rightName}" to "${guess.leftName}"`,
    newTable
  );
}

/** The drop of a column that only the target has. Section e of alterStatementsForMatch (alter-table.ts) explains it. */
export function dropColumnOnlyInTarget(col: ColumnSnapshot, tName: string): SqlStatement {
  return {
    sql: `ALTER TABLE ${q(tName)} DROP COLUMN IF EXISTS ${q(col.name)} CASCADE;`,
    description: `Drop column "${col.name}" from "${tName}" — WARNING: removes the column and all its data`,
    kind: "DROP_COLUMN",
    severity: "breaking",
    tableName: tName,
    destructive: true,
  };
}

/**
 * Renames for the sequences behind serial and identity columns, where the two
 * sides call the same column's sequence by different names.
 *
 * It happens when the source was built fresh under a new table name and the
 * target was not: the source has "customers" with "customers_id_seq", the
 * target has "customer" with "customer_id_seq". Renaming the table (or having
 * renamed it by hand earlier) leaves the target's sequence under its old name,
 * while the owner and grant statements at the end of the script name it the
 * way the source does. PostgreSQL then stops on "relation customers_id_seq
 * does not exist" and the whole run rolls back.
 *
 * So the sequence is renamed too, which is also what makes the two schemas
 * level afterwards. The column's default follows the sequence itself, not its
 * name, so nothing else has to change. See ownedSequenceRenameStatement for
 * when a run skips one.
 */
export interface OwnedSequenceRename {
  /** The target's name for the sequence. */
  from: string;
  /** The source's name for it. */
  to: string;
  /** The table's name once the table renames have run (the source's). */
  tableName: string;
  /** The column, by the source's name. */
  columnName: string;
}

/** The renames themselves, as data: migration.ts also needs the old names. */
export function ownedSequenceRenamePairs(
  report: CompareReport,
  // Names name-clashes.ts moved out of the way first, so free again by now.
  freed: Set<string> = new Set()
): OwnedSequenceRename[] {
  const sourceSequences = report.left.sequences ?? [];
  const targetSequences = report.right.sequences ?? [];
  // Tables, views and sequences share one set of names in a schema, so a new
  // name that something in the target already has cannot be taken.
  const taken = new Set<string>([
    ...report.right.tables.map((table) => table.name),
    ...(report.right.views ?? []).map((view) => view.name),
    ...targetSequences.map((sequence) => sequence.name),
  ]);
  for (const name of freed) taken.delete(name);

  const pairs: OwnedSequenceRename[] = [];
  for (const match of report.matchedTables) {
    for (const col of match.columnMatches) {
      // Read the owner as a name: it comes back quoted when it needs quotes.
      const source = sourceSequences.filter(
        (seq) =>
          sequenceOwnerTable(seq, report.left.schema) === match.left.name &&
          seq.ownedByColumn === col.left.name
      );
      const target = targetSequences.filter(
        (seq) =>
          sequenceOwnerTable(seq, report.right.schema) === match.right.name &&
          seq.ownedByColumn === col.right.name
      );
      // A column owns one sequence in practice. With none or several on either
      // side there is no pair to rename, so leave it alone.
      if (source.length !== 1 || target.length !== 1) continue;
      const from = target[0].name;
      const to = source[0].name;
      if (from === to || taken.has(to)) continue;
      taken.add(to);
      pairs.push({ from, to, tableName: match.left.name, columnName: col.left.name });
    }
  }
  return pairs;
}

/**
 * One rename from ownedSequenceRenamePairs.
 *
 * It runs only while the old name is still a sequence tied to that table. A
 * second run finds the old name gone and skips it. So does a database where
 * the old name is something else by now, such as the loose sequence a
 * rollback finds when the forward script had to keep one (see the SEQUENCE
 * drops in object-phases.ts): renaming that one would take the name the
 * table's own sequence already has and stop the whole run.
 */
export function ownedSequenceRenameStatement(pair: OwnedSequenceRename): SqlStatement {
  return {
    sql: onlyIfPresent(
      ownedSequenceQuery(pair.from, pair.tableName, "'a', 'i'"),
      `ALTER SEQUENCE ${q(pair.from)} RENAME TO ${q(pair.to)};`
    ),
    description:
      `Rename sequence "${pair.from}" → "${pair.to}" (the sequence behind ` +
      `"${pair.tableName}"."${pair.columnName}", to match the source)`,
    kind: "ALTER_SEQUENCE",
    severity: "info",
    tableName: pair.tableName,
    destructive: false,
  };
}
