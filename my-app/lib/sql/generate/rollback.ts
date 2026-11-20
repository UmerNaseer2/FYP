// Rollback (down) scripts: generateRollback() and renderRollbackScript().

import type { CompareReport, ObjectDiff } from "../../compare/types";
import {
  compareSchemas,
  extractBaseType,
  isNarrowingType,
  typeSizeParams,
} from "../../compare/diff";
import { generateMigration } from "./migration";
import { manualNoteCount } from "./render";
import { oneLine } from "./statement-helpers";
import type { MigrationOptions, SqlStatement } from "./types";

// ---------------------------------------------------------------------------
// Rollback / down scripts
// ---------------------------------------------------------------------------

export type RollbackScript = {
  /** The statements that undo the forward migration, in runnable order. */
  statements: SqlStatement[];
  warnings: string[];
  /** Label of the schema the rollback runs against — the same target as the migration. */
  targetSchema: string;
  /** Label of the schema the migration synced from, for the header only. */
  sourceSchema: string;
  /**
   * Structure the rollback puts back but cannot refill. Tables are bare names;
   * columns are written "table.column". These are exactly the things the
   * forward migration's DROP statements removed.
   */
  emptyOnRestore: { tables: string[]; columns: string[] };
  /**
   * What the rollback DROPS because the forward migration created it.
   *
   * Tables and columns are kept apart from the rest because only they can hold
   * rows written since the migration ran — a column is written "table.column".
   * `objects` (views, sequences, types, routines, indexes, triggers, policies)
   * are dropped too, but they carry no rows of their own, so removing them puts
   * the target back exactly as it was.
   *
   * Created columns used to be counted nowhere at all, which is how an add-only
   * migration produced a down script promising it "restores the target exactly
   * as it was" two lines above an armed DROP COLUMN ... CASCADE.
   */
  dropsCreated: { tables: string[]; columns: string[]; objects: string[] };
  /**
   * Columns whose type the migration changed in a way no cast can undo, written
   * "table.column: old → new". The down script still restores the type; these
   * are the columns where it cannot restore the value.
   */
  truncatingTypeChanges: string[];
  /**
   * Columns the migration dropped that were NOT NULL with no default, written
   * "table.column". The down script re-adds each one, but PostgreSQL has no
   * value to put in the rows that are already there, so on a non-empty table
   * the column comes back nullable and the constraint has to be re-applied by
   * hand after a backfill. The list is filled in either mode, but the warning
   * and the header only mention it when the migration really ran its drops
   * (forwardAllowedDataLoss).
   */
  nullableOnRestore: string[];
  /** True when the rollback restores the target exactly, data included. */
  lossless: boolean;
  /** Whether the forward migration this undoes had its drops armed. */
  forwardAllowedDataLoss: boolean;
};

/**
 * Everything besides tables and columns that the forward migration creates, and
 * the rollback therefore drops, labelled the way the report names it.
 *
 * "onlyA" means the object exists in the source and not in the target, so the
 * forward migration is what brings it into being.
 */
function createdObjectLabels(report: CompareReport): string[] {
  const labels: string[] = [];

  function add(diff: ObjectDiff) {
    if (diff.status !== "onlyA") return;
    const kind = diff.kind.toLowerCase();
    labels.push(
      diff.table ? `${kind} ${diff.name} on ${diff.table}` : `${kind} ${diff.name}`,
    );
  }

  for (const diff of report.objectDiffs) add(diff);
  for (const match of report.matchedTables) {
    // Indexes and triggers on a brand-new table are not listed separately —
    // they go away with the table, which is already named in dropsCreated.
    for (const diff of match.objectDiffs) add(diff);
  }
  return labels;
}

/**
 * Type changes that a cast can walk in one direction without losing anything.
 *
 * Each chain reads narrow-to-wide: every value of an earlier entry is
 * representable in every later one, so casting forward along a chain keeps the
 * value and casting back returns it unchanged. Chains only, no cross-links —
 * anything not listed here is treated as lossy, which is the safe answer for a
 * header that makes an absolute claim.
 */
const WIDENING_TYPE_CHAINS: string[][] = [
  ["smallint", "integer", "bigint", "numeric"],
  ["real", "double precision"],
  // A date is midnight, so it survives the trip into a timestamp and back. The
  // reverse is the defect this whole check exists for.
  ["date", "timestamp without time zone"],
  ["date", "timestamp with time zone"],
  // bpchar pads with spaces, varchar and text keep them; casting back re-pads
  // to the same stored value.
  ["character", "character varying", "text"],
];

/**
 * True when the FORWARD migration's change of a column's type keeps every value
 * the target already held, so the rollback's cast back returns the original.
 *
 * The rollback undoes an ALTER COLUMN TYPE by casting the other way. That
 * restores the type; it cannot restore the value, because the forward cast has
 * already run and kept only what the new type could hold. timestamp → date is
 * the plain case: the time of day is gone before the down script exists, and
 * casting back to timestamp yields midnight. numeric(10,4) → numeric(10,2) is
 * the quiet one — it rounds, and nothing errors.
 *
 * So this answers "is the forward cast widening", and anything it cannot prove
 * is widening counts as lossy. A false negative costs a warning nobody needed;
 * a false positive is the header telling the reader their data came back.
 */
function typeChangePreservesValues(fromType: string, toType: string): boolean {
  const from = extractBaseType(fromType);
  const to = extractBaseType(toType);

  // Same base type: the only question left is the size/precision, which the
  // compare engine already knows how to read.
  if (from === to) return !isNarrowingType(fromType, toType);

  // Different base types: widening only, and only along one chain. Losing the
  // size parameters is deliberate — smallint → numeric(4,0) is not something
  // this can prove, and it says so by returning false.
  return WIDENING_TYPE_CHAINS.some((chain) => {
    const fromIndex = chain.indexOf(from);
    const toIndex = chain.indexOf(to);
    return (
      fromIndex !== -1 &&
      toIndex > fromIndex &&
      typeSizeParams(toType) === null
    );
  });
}

/**
 * Every matched column whose type the forward migration changed in a way the
 * rollback cannot undo, written "table.column: old → new".
 *
 * Read off the ORIGINAL report, so `right` is the target as it stood before the
 * migration and `left` is what the migration changed it to.
 */
function truncatingTypeChangeLabels(report: CompareReport): string[] {
  const labels: string[] = [];
  for (const match of report.matchedTables) {
    for (const column of match.columnMatches) {
      const changedType = column.changes.some(
        (change) => change.kind === "type" || change.kind === "size",
      );
      if (!changedType) continue;
      const before = column.right.typeDisplay;
      const after = column.left.typeDisplay;
      if (typeChangePreservesValues(before, after)) continue;
      labels.push(`${match.left.name}.${column.left.name}: ${before} → ${after}`);
    }
  }
  return labels;
}

/**
 * Build the down script for the migration generateMigration() produces from the
 * same report.
 *
 * Undoing "make the target look like the source" is the same problem as the
 * migration itself with the two sides swapped, so this runs the comparison
 * backwards and reuses the whole forward generator on the result instead of
 * hand-writing an inverse for each of the sixteen statement shapes. A dropped
 * column comes back as an ADD COLUMN, a created table becomes a DROP TABLE, a
 * widened type narrows again, a rename renames back.
 *
 * Two things a down script genuinely cannot do, both stated in the rendered
 * header rather than hidden:
 *
 *   - It restores structure, never data. A table the migration dropped comes
 *     back empty; a column comes back full of nulls or its default.
 *   - Dropping a table the migration created destroys anything written into it
 *     since. Those drops are armed, because a rollback that leaves half the
 *     migration in place is not a rollback.
 *
 * Pass the same allowDataLoss the forward migration used. It does not change
 * which statements are emitted — every restoring CREATE and ADD is skipped when
 * its object is already there, so they are inert when the forward script never
 * dropped anything — it only changes what the header claims was lost.
 */
export function generateRollback(
  report: CompareReport,
  options: MigrationOptions = {},
): RollbackScript {
  const forwardAllowedDataLoss = options.allowDataLoss === true;

  // The comparison, backwards: the target's ORIGINAL state becomes the source
  // to restore, and the post-migration state (which matches the source) becomes
  // the thing to change.
  const reverseReport = compareSchemas(report.right, report.left);
  const inverse = generateMigration(reverseReport, {
    allowDataLoss: true,
    // The reversed report has the SOURCE on its right, and this script runs
    // against the target — see the note on the option.
    appliesToSchema: report.right.schema,
  });

  // What the forward migration destroyed, read off the ORIGINAL report so the
  // header describes the migration the user actually ran.
  const emptyTables = report.tablesOnlyInB.map((t) => t.name);
  const emptyColumns: string[] = [];
  for (const match of report.matchedTables) {
    for (const col of match.columnsOnlyInB) {
      emptyColumns.push(`${match.left.name}.${col.name}`);
    }
  }
  // What the forward migration CREATED, and the rollback therefore drops. Named
  // by the post-migration name (match.left) because that is what the target is
  // called by the time this script runs.
  const droppedTables = report.tablesOnlyInA.map((t) => t.name);
  const droppedColumns: string[] = [];
  for (const match of report.matchedTables) {
    for (const col of match.columnsOnlyInA) {
      droppedColumns.push(`${match.left.name}.${col.name}`);
    }
  }
  const droppedObjects = createdObjectLabels(report);
  const dropsCreated = {
    tables: droppedTables,
    columns: droppedColumns,
    objects: droppedObjects,
  };

  const restoredCount = emptyTables.length + emptyColumns.length;
  // Only tables and columns count against losslessness. Dropping a view or an
  // index the migration created restores the target exactly; dropping a table
  // or a column it created destroys whatever was written into it since.
  const destroyedCount = droppedTables.length + droppedColumns.length;
  // A migration made purely of ALTER COLUMN TYPE drops nothing and creates
  // nothing, so both counts above are zero and the header used to promise the
  // target came back exactly as it was. It does not: the down script restores
  // the type, never the values a truncating cast already threw away.
  const truncatingTypeChanges = truncatingTypeChangeLabels(report);
  // Restoring one of these gives the column back but not its NOT NULL — see the
  // DO block restoreNotNullStatement writes.
  const nullableOnRestore: string[] = [];
  for (const match of report.matchedTables) {
    for (const col of match.columnsOnlyInB) {
      if (!col.nullable && col.columnDefault === null && !col.generated && !col.identity) {
        nullableOnRestore.push(`${match.left.name}.${col.name}`);
      }
    }
  }
  // Work the down script cannot do at all. A `-- MANUAL:` note is a sentence
  // describing something PostgreSQL has no DDL for — removing an enum value is
  // the usual one — so the statement next to it is inert and the target is left
  // holding whatever the migration added. Reading the count off the generated
  // statements rather than re-deriving it means nothing new can slip past: any
  // future case that emits a note is covered the day it is written.
  const manualSteps = manualNoteCount(inverse.statements);
  // A sequence the rollback recreates comes back at its configured START WITH,
  // not at the number it had reached — `last_value` is not in the snapshot and
  // could not be restored from one anyway, since the live sequence kept moving
  // after the capture. The structure is identical and the next id is not, which
  // for a sequence is the whole point of it.
  const recreatedSequences = inverse.statements.filter(
    (stmt) => stmt.kind === "CREATE_SEQUENCE",
  ).length;
  const lossless =
    restoredCount === 0 &&
    destroyedCount === 0 &&
    truncatingTypeChanges.length === 0 &&
    manualSteps === 0 &&
    recreatedSequences === 0;

  const warnings: string[] = [];
  if (restoredCount > 0 && forwardAllowedDataLoss) {
    warnings.push(
      `The rollback recreates ${restoredCount} dropped object${restoredCount === 1 ? "" : "s"} ` +
        `but cannot restore the rows they held.`,
    );
  }
  if (restoredCount > 0 && !forwardAllowedDataLoss) {
    warnings.push(
      `The migration ran in safe mode, so nothing was dropped and the ` +
        `${restoredCount} restoring statement${restoredCount === 1 ? "" : "s"} ` +
        `will do nothing.`,
    );
  }
  if (destroyedCount > 0) {
    const parts: string[] = [];
    if (droppedTables.length > 0) {
      parts.push(`${droppedTables.length} table${droppedTables.length === 1 ? "" : "s"}`);
    }
    if (droppedColumns.length > 0) {
      parts.push(`${droppedColumns.length} column${droppedColumns.length === 1 ? "" : "s"}`);
    }
    warnings.push(
      `The rollback drops ${parts.join(" and ")} the migration created. Rows ` +
        `written into ${destroyedCount === 1 ? "it" : "them"} since are lost.`,
    );
  }
  if (truncatingTypeChanges.length > 0) {
    const n = truncatingTypeChanges.length;
    warnings.push(
      `The rollback puts back the original type of ${n} column${n === 1 ? "" : "s"} ` +
        `but not the values: the forward migration's cast could not be undone. ` +
        `Restore ${n === 1 ? "it" : "them"} from a backup if the old values matter.`,
    );
  }

  // Only when the migration really dropped them. In safe mode the columns never
  // left, so they still have their NOT NULL, and the warning above already says
  // the restoring statements do nothing.
  if (nullableOnRestore.length > 0 && forwardAllowedDataLoss) {
    const n = nullableOnRestore.length;
    warnings.push(
      `${n} restored column${n === 1 ? "" : "s"} had NOT NULL and no default. ` +
        `On a table that already holds rows there is no value to give them, so ` +
        `${n === 1 ? "it comes" : "they come"} back without NOT NULL. The script ` +
        `raises a warning with the ALTER to run once you have backfilled ` +
        `${n === 1 ? "it" : "them"}.`,
    );
  }

  if (manualSteps > 0) {
    warnings.push(
      `${manualSteps} step${manualSteps === 1 ? "" : "s"} in this rollback ` +
        `${manualSteps === 1 ? "is" : "are"} a \`-- MANUAL:\` note, not a statement: ` +
        `PostgreSQL has no DDL for ${manualSteps === 1 ? "it" : "them"}. Running the ` +
        `script leaves that work undone — read ${manualSteps === 1 ? "the note" : "each note"} ` +
        `and do it by hand.`,
    );
  }
  if (recreatedSequences > 0) {
    const n = recreatedSequences;
    warnings.push(
      `The rollback recreates ${n} sequence${n === 1 ? "" : "s"} at ${n === 1 ? "its" : "their"} ` +
        `START WITH value, not at the number ${n === 1 ? "it had" : "they had"} reached. ` +
        `Set ${n === 1 ? "it" : "them"} past the highest id already in use with setval() ` +
        `before anything inserts, or the next insert collides with an existing row.`,
    );
  }

  const unconfirmed = reverseReport.possibleTableMatches.length;
  if (unconfirmed > 0) {
    warnings.push(
      `The reverse comparison could not confirm ${unconfirmed} table ` +
        `rename${unconfirmed === 1 ? "" : "s"}. Where it was unsure it emitted a ` +
        `CREATE plus a DROP instead of a RENAME, so the rollback recreates the ` +
        `table empty rather than renaming it back. Read those statements before running.`,
    );
  }

  return {
    statements: inverse.statements,
    warnings,
    targetSchema: `${report.right.database}.${report.right.schema}`,
    sourceSchema: `${report.left.database}.${report.left.schema}`,
    emptyOnRestore: { tables: emptyTables, columns: emptyColumns },
    dropsCreated,
    truncatingTypeChanges,
    nullableOnRestore,
    lossless,
    forwardAllowedDataLoss,
  };
}

// Wrap a comma-joined list so a header comment line stays readable.
function commentList(items: string[], indent: string): string[] {
  const lines: string[] = [];
  let current = "";
  for (const name of items) {
    const item = oneLine(name);
    const next = current ? `${current}, ${item}` : item;
    if (next.length > 64 && current) {
      lines.push(`${indent}${current}`);
      current = item;
    } else {
      current = next;
    }
  }
  if (current) lines.push(`${indent}${current}`);
  return lines;
}

// Word-wrap one generator warning into comment lines of about 76 characters.
// The first line starts "-- WARNING: " and the rest line up under its text.
//
// Splitting on every kind of whitespace is also the safety rule: a line break
// inside a warning would otherwise start a new line that is NOT a comment, and
// that text would run as SQL. A word longer than the line (a long table name)
// gets a line of its own instead of being cut.
function warningCommentLines(text: string): string[] {
  const firstPrefix = "-- WARNING: ";
  const restPrefix = "--          ";
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/)) {
    if (!word) continue;
    const prefix = lines.length === 0 ? firstPrefix : restPrefix;
    const next = current ? `${current} ${word}` : word;
    if (current && prefix.length + next.length > 76) {
      lines.push(`${prefix}${current}`);
      current = word;
    } else {
      current = next;
    }
  }
  lines.push(`${lines.length === 0 ? firstPrefix : restPrefix}${current}`);
  return lines;
}

/**
 * Render a rollback as plain SQL.
 *
 * Nothing here is ever commented out. A rollback whose statements do not run is
 * not a rollback, so the honesty lives in the header instead: it says what the
 * script restores, what it cannot restore, and what it destroys.
 */
export function renderRollbackScript(script: RollbackScript): string {
  const breaking = script.statements.filter((s) => s.severity === "breaking").length;
  const safe = script.statements.filter((s) => s.severity === "safe").length;
  const info = script.statements.filter((s) => s.severity === "info").length;

  const header = [
    `-- ================================================================`,
    `-- ROLLBACK (down script)`,
    `-- Undoes the migration ${oneLine(script.sourceSchema)}  →  ${oneLine(script.targetSchema)}`,
    `-- Runs against: ${oneLine(script.targetSchema)}`,
    `-- Statements: ${script.statements.length}  (${breaking} breaking · ${safe} safe · ${info} info)`,
  ];

  const notes = manualNoteCount(script.statements);
  if (notes > 0) {
    header.push(
      `-- ${notes} of ${notes === 1 ? "those is a MANUAL note" : "those are MANUAL notes"}: ` +
        `${notes === 1 ? "it describes" : "they describe"} work no statement can do, and ` +
        `${notes === 1 ? "runs" : "run"} nothing.`,
    );
  }
  header.push(`--`);

  // The generator's warnings go into the file itself, not only onto the
  // Workbench's Rollback tab. This text is what gets pushed as v<ver>.down.sql
  // and what Deploy shows before a rollback runs, and a warning such as "this
  // recreates the table empty" matters most at exactly that moment. Written
  // before the nothing-to-undo branch below, so every rollback carries them.
  if (script.warnings.length > 0) {
    header.push(`-- Read before running:`);
    for (const warning of script.warnings) header.push(...warningCommentLines(warning));
    header.push(`--`);
  }

  if (script.statements.length === 0) {
    header.push(
      `-- The migration changed nothing, so there is nothing to undo.`,
      `-- ================================================================`,
    );
    return header.join("\n");
  }

  if (script.lossless) {
    header.push(
      `-- This rollback is complete. Nothing it recreates comes back empty, and`,
      `-- nothing it removes can hold rows written since the migration ran, so`,
      `-- running it restores the target exactly as it was.`,
    );
  } else {
    header.push(`-- THIS RESTORES STRUCTURE, NOT DATA.`);
  }

  const { tables, columns } = script.emptyOnRestore;
  if (tables.length > 0 || columns.length > 0) {
    if (script.forwardAllowedDataLoss) {
      header.push(`--`, `-- Recreated EMPTY — the rows they held are gone:`);
    } else {
      header.push(
        `--`,
        `-- The migration ran in SAFE MODE, so it dropped none of the following.`,
        `-- Each statement below is skipped when the object is already there, so`,
        `-- they do nothing unless the drops were armed or run by hand:`,
      );
    }
    if (tables.length > 0) {
      header.push(`--   tables:`, ...commentList(tables, "--     "));
    }
    if (columns.length > 0) {
      header.push(`--   columns:`, ...commentList(columns, "--     "));
    }
  }

  const created = script.dropsCreated;
  if (created.tables.length > 0 || created.columns.length > 0) {
    header.push(
      `--`,
      `-- DROPPED — created by the migration, so any row written into them since`,
      `-- the migration ran is lost:`,
    );
    if (created.tables.length > 0) {
      header.push(`--   tables:`, ...commentList(created.tables, "--     "));
    }
    if (created.columns.length > 0) {
      header.push(`--   columns:`, ...commentList(created.columns, "--     "));
    }
  }

  if (script.truncatingTypeChanges.length > 0) {
    header.push(
      `--`,
      `-- TYPE RESTORED, VALUES NOT. The migration's cast on these columns could`,
      `-- not be undone — the down script gives each column its old type back,`,
      `-- holding whatever the cast left behind:`,
      ...script.truncatingTypeChanges.map((label) => `--     ${oneLine(label)}`),
    );
  }

  // Left out after a safe mode migration: the columns were never dropped, so
  // they still have their NOT NULL and there is nothing to warn about.
  if (script.nullableOnRestore.length > 0 && script.forwardAllowedDataLoss) {
    header.push(
      `--`,
      `-- COLUMN RESTORED WITHOUT ITS NOT NULL. These columns had NOT NULL and no`,
      `-- default, and there is no value to give rows that already exist. On a`,
      `-- table that holds rows each one comes back without NOT NULL, and the`,
      `-- script raises a warning with the ALTER to run after you backfill it:`,
      ...script.nullableOnRestore.map((label) => `--     ${oneLine(label)}`),
    );
  }

  if (created.objects.length > 0) {
    header.push(
      `--`,
      `-- Also dropped — created by the migration and holding no rows of their`,
      `-- own, so removing them puts the target back as it was:`,
      ...commentList(created.objects, "--     "),
    );
  }

  header.push(
    `--`,
    `-- Run this after the migration. A second run skips anything already back the`,
    `-- way it was, except that an object whose definition changed is built again`,
    `-- and a column type is converted back again.`,
    `-- ================================================================`,
  );

  const body = script.statements
    .map((stmt) => `-- [${stmt.severity.toUpperCase()}] ${oneLine(stmt.description)}\n${stmt.sql}`)
    .join("\n\n");

  return `${header.join("\n")}\n\n${body}`;
}
