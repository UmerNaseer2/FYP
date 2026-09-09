// ---------------------------------------------------------------------------
// compare-summary.ts
// The arithmetic behind the object-status matrix.
//
// Pure on purpose: it takes a finished CompareReport and returns rows of
// numbers, with no React in sight, so the counts can be checked against a real
// database without rendering anything. components/studio/SummaryMatrix.tsx is
// the only thing that draws them.
// ---------------------------------------------------------------------------

import type {
  CompareReport,
  NotComparedReason,
  ObjectCategoryKey,
  ObjectDiff,
  ObjectKind,
  TableSnapshot,
} from "./compare-types";
import { isStandaloneSequence } from "./compare";

/** One line of the matrix: a category, and how its objects fared. */
export type SummaryRow = {
  label: string;
  /** False when nothing in this category was compared. See notComparedReason. */
  compared: boolean;
  /**
   * Why `compared` is false — undefined when it is true.
   *
   * The matrix and the export both used to print a single hardcoded cause, and
   * on the tool's most common run (a populated source against an empty target)
   * that cause was false: nothing was stale, there was simply no matched table
   * to count indexes and triggers on.
   */
  notComparedReason?: NotComparedReason;
  /** True when both sides were read and neither holds a single object. */
  absent: boolean;
  inSync: number;
  added: number;
  dropped: number;
  changed: number;
  /**
   * How many of the above are things no statement can do — the script writes a
   * note for each and runs nothing. Counted alongside rather than instead of
   * added/changed, because the work is real and still has to be counted; it
   * just is not work the script performs. See ObjectDiff.needsManualWork.
   *
   * Always 0 on the Tables, Columns and Constraints rows: those are counted
   * from the snapshots rather than from object diffs, and none of the cases
   * the flag covers is a table, a column or a constraint.
   */
  manual: number;
};

/** Which ObjectKinds roll up into each named row of the matrix. */
const VIEW_KINDS: ObjectKind[] = ["VIEW", "MATERIALIZED VIEW"];
const TYPE_KINDS: ObjectKind[] = ["ENUM", "DOMAIN", "COMPOSITE TYPE", "RANGE TYPE"];
const ROUTINE_KINDS: ObjectKind[] = ["FUNCTION", "PROCEDURE"];

/** Split a set of object diffs into the three columns the matrix shows. */
function tallyObjects(diffs: ObjectDiff[], kinds: ObjectKind[]) {
  let added = 0;
  let dropped = 0;
  let changed = 0;
  let manual = 0;
  for (const diff of diffs) {
    if (!kinds.includes(diff.kind)) continue;
    if (diff.status === "onlyA") added += 1;
    else if (diff.status === "onlyB") dropped += 1;
    else changed += 1;
    if (diff.needsManualWork === true) manual += 1;
  }
  return { added, dropped, changed, manual };
}

/**
 * How many of a category matched and came out the same.
 *
 * Every object on the source side ends up in exactly one of three buckets:
 * only-in-source, matched-but-changed, or matched-and-identical. So the third
 * is the first two subtracted from the source-side total — no second pass over
 * the snapshot, and it can never disagree with the diffs beside it. Clamped at
 * zero because a snapshot restored from lineage can be older than its diffs.
 */
/** Whether a table takes part in partitioning or inheritance at all. */
function isPartitioned(table: TableSnapshot): boolean {
  const part = table.partitioning;
  if (!part) return false;
  return (
    part.key !== null || part.partitionOf !== null || part.inherits.length > 0
  );
}

function inSyncCount(sourceTotal: number, added: number, changed: number): number {
  return Math.max(0, sourceTotal - added - changed);
}

/** Constraints of every kind on one table, counted the way compare counts them. */
function constraintTotal(table: TableSnapshot): number {
  return (
    (table.primaryKey ? 1 : 0) +
    table.uniqueConstraints.length +
    table.foreignKeys.length +
    table.checkConstraints.length +
    table.excludeConstraints.length
  );
}

/**
 * Build the whole matrix from a finished report.
 *
 * Deliberately reads report.summary for the table row rather than recounting:
 * those counters already decide the drift wording and the semver suggestion, so
 * recounting here would let this board and the version picker drift apart over
 * the same report.
 */
export function summaryRows(report: CompareReport): SummaryRow[] {
  const rows: SummaryRow[] = [];
  const categories = report.comparedObjectCategories;

  // `reasons` is absent on a report restored from a snapshot taken before this
  // field existed. Undefined then means "compared, or skipped for a reason
  // nobody recorded" — which is exactly what the callers already handle.
  const reasonFor = (key: ObjectCategoryKey): NotComparedReason | undefined =>
    categories.reasons?.[key];

  rows.push({
    label: "Tables",
    compared: true,
    absent: report.left.tables.length === 0 && report.right.tables.length === 0,
    inSync: report.summary.identicalTables,
    added: report.summary.tablesOnlyInA,
    dropped: report.summary.tablesOnlyInB,
    changed: report.summary.changedTables,
    manual: 0,
  });

  // Columns and constraints are counted over MATCHED tables only. A column on a
  // table that exists on one side only is not a column difference — it is
  // created or dropped with its table, and counting it here would report the
  // same work twice on two rows.
  let columnsInSync = 0;
  let columnsChanged = 0;
  let columnsAdded = 0;
  let columnsDropped = 0;
  let constraintTotalLeft = 0;
  let constraintTotalRight = 0;
  let constraintsAdded = 0;
  let constraintsDropped = 0;
  let constraintsChanged = 0;
  let indexTotalLeft = 0;
  let indexTotalRight = 0;
  let triggerTotalLeft = 0;
  let triggerTotalRight = 0;
  // The switch counts as one thing alongside the policies, because it is one
  // thing that can differ: a table with RLS off and a table with RLS on and no
  // policies both have zero policies and behave nothing alike.
  let rowSecurityTotalLeft = 0;
  let rowSecurityUsed = false;
  // Same shape as row security: every table has exactly one answer to "how is
  // this partitioned", so the total is the table count and the row is hidden
  // unless at least one side actually partitions or inherits something.
  let partitioningTotalLeft = 0;
  let partitioningUsed = false;
  const tableScopedDiffs: ObjectDiff[] = [];

  for (const match of report.matchedTables) {
    columnsAdded += match.columnsOnlyInA.length;
    columnsDropped += match.columnsOnlyInB.length;
    for (const column of match.columnMatches) {
      // A rename counts as changed even with no property difference: the
      // migration still has to write an ALTER for it.
      if (column.changes.length > 0 || !column.exact) columnsChanged += 1;
      else columnsInSync += 1;
    }

    constraintTotalLeft += constraintTotal(match.left);
    constraintTotalRight += constraintTotal(match.right);
    for (const diff of match.constraintDiffs) {
      if (diff.status === "onlyA") constraintsAdded += 1;
      else if (diff.status === "onlyB") constraintsDropped += 1;
      else constraintsChanged += 1;
    }

    indexTotalLeft += match.left.indexes?.length ?? 0;
    indexTotalRight += match.right.indexes?.length ?? 0;
    triggerTotalLeft += match.left.triggers?.length ?? 0;
    triggerTotalRight += match.right.triggers?.length ?? 0;

    if (match.left.rowSecurity) {
      rowSecurityTotalLeft += match.left.rowSecurity.policies.length + 1;
      if (match.left.rowSecurity.enabled || match.left.rowSecurity.policies.length > 0) {
        rowSecurityUsed = true;
      }
    }
    if (
      match.right.rowSecurity &&
      (match.right.rowSecurity.enabled || match.right.rowSecurity.policies.length > 0)
    ) {
      rowSecurityUsed = true;
    }

    if (match.left.partitioning) {
      partitioningTotalLeft += 1;
      if (isPartitioned(match.left)) partitioningUsed = true;
    }
    if (isPartitioned(match.right)) partitioningUsed = true;

    tableScopedDiffs.push(...match.objectDiffs);
  }

  // "None on either side" is a claim about the SCHEMA, so it has to look at
  // every table — not just the matched ones the counts are measured over. A
  // schema whose only RLS is on a table the migration creates had this row
  // hidden behind "none on either side", which is a flat contradiction of the
  // ENABLE ROW LEVEL SECURITY the script below it writes. Same for a schema
  // whose only partitioned table is new.
  //
  // The counts stay matched-only on purpose: whatever hangs off a one-sided
  // table is created or dropped with that table, and counting it here as well
  // would report the same work on two rows. The help text under the matrix
  // says so.
  for (const table of [...report.tablesOnlyInA, ...report.tablesOnlyInB]) {
    const rls = table.rowSecurity;
    if (rls && (rls.enabled || rls.policies.length > 0)) rowSecurityUsed = true;
    if (isPartitioned(table)) partitioningUsed = true;
  }

  // Views carry indexes and triggers too — a materialized view is indexed like
  // a table, and INSTEAD OF triggers are what make a view writable — and the
  // comparison files those diffs at schema scope. Counting only the tables here
  // left the Indexes row reading "3 in sync" while the changes list below it
  // showed a fourth, on a view, that the totals had never heard of.
  //
  // Matched by name, which is how the comparison matched them: a view on one
  // side only takes its indexes with it, exactly as a one-sided table does.
  const rightViewsByName = new Map(
    (report.right.views ?? []).map((view) => [view.name, view])
  );
  for (const view of report.left.views ?? []) {
    const peer = rightViewsByName.get(view.name);
    if (!peer) continue;
    if (view.indexes && peer.indexes) {
      indexTotalLeft += view.indexes.length;
      indexTotalRight += peer.indexes.length;
    }
    if (view.triggers && peer.triggers) {
      triggerTotalLeft += view.triggers.length;
      triggerTotalRight += peer.triggers.length;
    }
  }

  rows.push({
    label: "Columns",
    compared: true,
    absent: false,
    inSync: columnsInSync,
    added: columnsAdded,
    dropped: columnsDropped,
    changed: columnsChanged,
    manual: 0,
  });

  rows.push({
    label: "Constraints",
    compared: true,
    absent: constraintTotalLeft === 0 && constraintTotalRight === 0,
    inSync: inSyncCount(constraintTotalLeft, constraintsAdded, constraintsChanged),
    added: constraintsAdded,
    dropped: constraintsDropped,
    changed: constraintsChanged,
    manual: 0,
  });

  // Both lists: a table's indexes are recorded on its match, a view's on the
  // schema. tallyObjects filters by kind, so nothing else in report.objectDiffs
  // is picked up by either of these two.
  const relationScopedDiffs = [...tableScopedDiffs, ...report.objectDiffs];

  const indexes = tallyObjects(relationScopedDiffs, ["INDEX"]);
  rows.push({
    label: "Indexes",
    compared: categories.indexes,
    notComparedReason: reasonFor("indexes"),
    absent: indexTotalLeft === 0 && indexTotalRight === 0,
    inSync: inSyncCount(indexTotalLeft, indexes.added, indexes.changed),
    ...indexes,
  });

  const triggers = tallyObjects(relationScopedDiffs, ["TRIGGER"]);
  rows.push({
    label: "Triggers",
    compared: categories.triggers,
    notComparedReason: reasonFor("triggers"),
    absent: triggerTotalLeft === 0 && triggerTotalRight === 0,
    inSync: inSyncCount(triggerTotalLeft, triggers.added, triggers.changed),
    ...triggers,
  });

  const rowSecurity = tallyObjects(tableScopedDiffs, ["POLICY", "ROW SECURITY"]);
  rows.push({
    label: "Row security",
    compared: categories.rowSecurity,
    notComparedReason: reasonFor("rowSecurity"),
    // Hidden when neither side uses row security at all. Not when the totals
    // are zero — every table contributes a switch, so the totals are never
    // zero once row security is recorded, and a permanent "0 / 0" row on
    // schemas that have never heard of RLS is noise the matrix does not need.
    absent: !rowSecurityUsed,
    inSync: inSyncCount(rowSecurityTotalLeft, rowSecurity.added, rowSecurity.changed),
    ...rowSecurity,
  });

  const partitioning = tallyObjects(tableScopedDiffs, ["PARTITIONING"]);
  rows.push({
    label: "Partitioning",
    compared: categories.partitioning,
    notComparedReason: reasonFor("partitioning"),
    absent: !partitioningUsed,
    inSync: inSyncCount(partitioningTotalLeft, partitioning.added, partitioning.changed),
    ...partitioning,
  });

  const views = tallyObjects(report.objectDiffs, VIEW_KINDS);
  rows.push({
    label: "Views",
    compared: categories.views,
    notComparedReason: reasonFor("views"),
    absent: (report.left.views?.length ?? 0) === 0 && (report.right.views?.length ?? 0) === 0,
    inSync: inSyncCount(report.left.views?.length ?? 0, views.added, views.changed),
    ...views,
  });

  const sequences = tallyObjects(report.objectDiffs, ["SEQUENCE"]);
  // Only sequences the comparison actually looked at. A `serial` or IDENTITY
  // column owns a sequence, and compare skips those because the column itself
  // is already compared — so counting the raw snapshot length here reported six
  // serial primary keys as six sequences "in sync", asserting a comparison that
  // never ran. The same lengths decide the honest "none on either side" cell,
  // which a schema of nothing but serial columns could never reach.
  const leftSequences = (report.left.sequences ?? []).filter(isStandaloneSequence);
  const rightSequences = (report.right.sequences ?? []).filter(isStandaloneSequence);
  rows.push({
    label: "Sequences",
    compared: categories.sequences,
    notComparedReason: reasonFor("sequences"),
    absent: leftSequences.length === 0 && rightSequences.length === 0,
    inSync: inSyncCount(leftSequences.length, sequences.added, sequences.changed),
    ...sequences,
  });

  const types = tallyObjects(report.objectDiffs, TYPE_KINDS);
  rows.push({
    label: "Enums & types",
    compared: categories.types,
    notComparedReason: reasonFor("types"),
    absent: (report.left.types?.length ?? 0) === 0 && (report.right.types?.length ?? 0) === 0,
    inSync: inSyncCount(report.left.types?.length ?? 0, types.added, types.changed),
    ...types,
  });

  const collations = tallyObjects(report.objectDiffs, ["COLLATION"]);
  rows.push({
    label: "Collations",
    compared: categories.collations,
    notComparedReason: reasonFor("collations"),
    absent:
      (report.left.collations?.length ?? 0) === 0 &&
      (report.right.collations?.length ?? 0) === 0,
    inSync: inSyncCount(
      report.left.collations?.length ?? 0,
      collations.added,
      collations.changed
    ),
    ...collations,
  });

  const extensions = tallyObjects(report.objectDiffs, ["EXTENSION"]);
  rows.push({
    label: "Extensions",
    compared: categories.extensions,
    notComparedReason: reasonFor("extensions"),
    absent:
      (report.left.extensions?.length ?? 0) === 0 &&
      (report.right.extensions?.length ?? 0) === 0,
    inSync: inSyncCount(
      report.left.extensions?.length ?? 0,
      extensions.added,
      extensions.changed
    ),
    ...extensions,
  });

  const routines = tallyObjects(report.objectDiffs, ROUTINE_KINDS);
  rows.push({
    label: "Functions",
    compared: categories.routines,
    notComparedReason: reasonFor("routines"),
    absent:
      (report.left.routines?.length ?? 0) === 0 &&
      (report.right.routines?.length ?? 0) === 0,
    inSync: inSyncCount(report.left.routines?.length ?? 0, routines.added, routines.changed),
    ...routines,
  });

  // The "dropped" cell on this row is structurally always zero, and that is
  // not an oversight. A privilege entry the target has and the source does not
  // belongs to an object the script is already dropping, so the comparison
  // leaves it out rather than reporting a revoke on something that will not be
  // there — see the privileges block in compare.ts. Access genuinely taken
  // away shows up under "changed", on the object that survives.
  const privileges = tallyObjects(report.objectDiffs, ["PRIVILEGES"]);
  rows.push({
    label: "Privileges",
    compared: categories.privileges,
    notComparedReason: reasonFor("privileges"),
    // Never true in practice: every schema has an owner, so a snapshot that
    // recorded privileges at all has at least the one entry for the schema
    // itself. Kept for the same reason as every other row — the cell means
    // "neither side had any", and asserting that from the data is honest even
    // where the data cannot say it.
    absent:
      (report.left.privileges?.length ?? 0) === 0 &&
      (report.right.privileges?.length ?? 0) === 0,
    inSync: inSyncCount(
      report.left.privileges?.length ?? 0,
      privileges.added,
      privileges.changed
    ),
    ...privileges,
  });

  return rows;
}
