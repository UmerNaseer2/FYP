// Names the script needs while the target still has them on something else.
//
// PostgreSQL keeps index names unique across a whole schema, not per table, and
// every primary key, unique and exclusion constraint is backed by an index with
// the constraint's own name. Sequences share that set of names too. So a name
// the script creates can still belong to another table in the target. Two ways
// it happens:
//
// - a key or index moves between tables ("orders_code_key" now belongs to
//   "orders", not "orders_old");
// - a table was renamed in the source database after it was made, so its key
//   and its sequence kept their first names ("b_pkey" and "b_id_seq" on table
//   "a"), while the target still has the old table with both.
//
// The script creates and adds before it drops, which is the right order for
// everything else, so the new table or key was refused with
// 'relation "..." already exists' and the whole deploy rolled back. A client
// tester hit it with a table renamed in a staging database.
//
// The fix moves the old holder out of the way before anything is created.
// These statements run before the table renames, so they name tables the way
// the target does. Renaming an index that backs a constraint renames the
// constraint with it, and every foreign key that leans on it keeps working.
// Each holder is one of these kinds:
//
// - a key the script drops further down: it gets a parked name ("..._old"),
//   and the drop later in the script uses that name;
// - a key or index on a table the script drops: it gets a parked name too, so
//   it does not matter whether that drop runs or safe mode keeps the table;
// - a key the script keeps: it takes the name the source gives it, which is
//   where it belongs anyway, or a parked name when that one is taken as well;
// - a sequence that belongs to a table the script drops, when the source uses
//   its name: parked when the new owner cannot take it over (an identity
//   column, or a serial that would quietly pick another name), untied from the
//   old table when the source keeps it as a sequence of its own (so dropping
//   that table no longer takes the sequence with it, nor the defaults of other
//   tables that read it), and otherwise left for the new column to take over,
//   counter and all;
// - a sequence of its own (tied to no column) whose name the source gives to
//   an identity or serial column: parked, and its drop further down uses the
//   parked name.
//
// A sequence of its own that the source ties to a new column is not in the
// way: the column takes it over, so the script keeps it instead of dropping
// it. Wherever an old sequence lives on like this, its bounds are brought in
// line with the source's.

import type { ChangeSeverity, CompareReport, ConstraintDiff, TableMatch } from "../../compare/types";
import type { ConstraintSnapshot, SchemaSnapshot, SequenceSnapshot, TableSnapshot } from "../../postgres";
import { sequenceOwnerTable } from "../../postgres/snapshot-facts";
import { q } from "./basics";
import { nonFkConstraints } from "./column-changes";
import type { SequencePlan } from "./columns";
import { usesSerialShorthand } from "./columns";
import { ownedSequenceRenamePairs } from "./alter-helpers";
import { sequencesTiedToColumns } from "./object-phase-types";
import { alterSequenceStatement, nextvalSequenceName } from "./sequences";
import { literal, objectStatement, onlyIfPresent, ownedSequenceQuery, tableIndexQuery } from "./statement-helpers";
import type { SqlStatement } from "./types";

export type NameClashPlan = {
  /** The moves. They run before the table renames and before anything is created. */
  statements: SqlStatement[];
  /**
   * For each matched table, by its name in the source: the target's name of a
   * key the script drops, mapped to the name it was moved to first. The drop
   * further down has to use the new name.
   */
  parkedKeys: Map<string, Map<string, string>>;
  /** Sequence names moved away, so a matched table's own sequence can take them. */
  freedNames: Set<string>;
  /** Sequences parked so the script builds or names them afresh: their grants are written in full. */
  parkedSequences: Set<string>;
  /** Sequences of their own moved aside for a new column, mapped to the name their drop has to use. */
  parkedDrops: Map<string, string>;
  /** Sequences of their own that a new column takes over, so the script keeps them. */
  adoptedSequences: Set<string>;
  warnings: string[];
};

/** Whether two sequences have the same type and bounds, so an old one can stand in for the source's. */
function sameSequenceOptions(a: SequenceSnapshot, b: SequenceSnapshot): boolean {
  return (
    a.dataType === b.dataType &&
    a.startValue === b.startValue &&
    a.increment === b.increment &&
    a.minValue === b.minValue &&
    a.maxValue === b.maxValue &&
    a.cycles === b.cycles &&
    a.cacheSize === b.cacheSize
  );
}

/** PostgreSQL cuts every name to 63 bytes, so a longer one would quietly become another. */
const MAX_NAME_BYTES = 63;
const encoder = new TextEncoder();

function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/**
 * `base` with `suffix` on the end, cutting `base` short to fit in 63 bytes.
 * The cut is between characters, never inside one, the same way PostgreSQL
 * cuts a name that is too long.
 */
export function withSuffix(base: string, suffix: string): string {
  const chars = Array.from(base);
  while (chars.length > 0 && byteLength(chars.join("")) + byteLength(suffix) > MAX_NAME_BYTES) {
    chars.pop();
  }
  return chars.join("") + suffix;
}

/** The first of "<name>_old", "<name>_old2", ... that nothing has. Marked as taken. */
function parkingName(name: string, taken: Set<string>): string {
  for (let n = 1; ; n++) {
    const candidate = withSuffix(name, n === 1 ? "_old" : `_old${n}`);
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

/** The keys backed by an index of their own name: primary key, unique and exclusion. */
function indexedKeys(table: TableSnapshot): { kind: ConstraintDiff["kind"]; constraint: ConstraintSnapshot }[] {
  return nonFkConstraints(table).filter(({ kind }) => kind !== "CHECK");
}

/** Every relation name: tables, key indexes, plain indexes, views and their indexes, sequences, types. */
function addRelationNamesIn(snapshot: SchemaSnapshot, into: Set<string>): void {
  for (const table of snapshot.tables) {
    into.add(table.name);
    for (const { constraint } of indexedKeys(table)) into.add(constraint.name);
    for (const index of table.indexes ?? []) into.add(index.name);
  }
  for (const view of snapshot.views ?? []) {
    into.add(view.name);
    for (const index of view.indexes ?? []) into.add(index.name);
  }
  for (const sequence of snapshot.sequences ?? []) into.add(sequence.name);
  for (const type of snapshot.types ?? []) into.add(type.name);
}

/** The relation names plus every constraint name, which a parked name must also avoid on its table. */
function addNamesIn(snapshot: SchemaSnapshot, into: Set<string>): void {
  addRelationNamesIn(snapshot, into);
  for (const table of snapshot.tables) {
    for (const { constraint } of nonFkConstraints(table)) into.add(constraint.name);
    for (const fk of table.foreignKeys) into.add(fk.name);
  }
}

/**
 * Every index-backed name the script creates, mapped to the table (by its
 * source name) that gets it. `early` names are made before the old tables are
 * dropped: the keys of new tables and the keys added to matched ones. `late`
 * names come after every drop: plain indexes. A foreign key or a CHECK is left
 * out, as their names only have to be unique on their own table.
 */
function namesTheScriptCreates(report: CompareReport): { early: Map<string, string>; late: Map<string, string> } {
  const early = new Map<string, string>();
  const late = new Map<string, string>();
  for (const table of report.tablesOnlyInA) {
    for (const { constraint } of indexedKeys(table)) early.set(constraint.name, table.name);
    for (const index of table.indexes ?? []) late.set(index.name, table.name);
  }
  for (const match of report.matchedTables) {
    for (const diff of match.constraintDiffs) {
      if (diff.status === "onlyB" || !diff.leftName) continue;
      if (diff.kind === "FOREIGN KEY" || diff.kind === "CHECK") continue;
      early.set(diff.leftName, match.left.name);
    }
    for (const diff of match.objectDiffs) {
      if (diff.kind === "INDEX" && diff.status !== "onlyB") late.set(diff.name, match.left.name);
    }
  }
  return { early, late };
}

/** The target's names of the keys this matched table drops further down. */
function keysTheTableDrops(match: TableMatch): Set<string> {
  const names = new Set<string>();
  for (const diff of match.constraintDiffs) {
    if (diff.status === "onlyA" || !diff.rightName) continue;
    if (diff.kind === "FOREIGN KEY" || diff.kind === "CHECK") continue;
    names.add(diff.rightName);
  }
  return names;
}

/**
 * What the source calls a key the comparison found on both sides. A primary
 * key is paired whatever its name; a unique or exclusion constraint under
 * another name was paired by its definition.
 */
function sourceNameOfKeptKey(
  match: TableMatch,
  kind: ConstraintDiff["kind"],
  key: ConstraintSnapshot
): string | null {
  if (kind === "PRIMARY KEY") return match.left.primaryKey?.name ?? null;
  const candidates = kind === "UNIQUE" ? match.left.uniqueConstraints : match.left.excludeConstraints;
  return candidates.find((c) => c.normalizedDefinition === key.normalizedDefinition)?.name ?? null;
}

function renameIndexStatement(
  tableName: string,
  from: string,
  to: string,
  why: string,
  severity: ChangeSeverity
): SqlStatement {
  return objectStatement({
    // Guarded by the table it sits on: on a second run of the same script the
    // old name may already belong to the new key, which must stay as it is.
    // Skipped, not failed, if the new name has been taken by then.
    sql: onlyIfPresent(
      `${tableIndexQuery(tableName, from)} AND NOT EXISTS ` +
        `(SELECT 1 FROM pg_class o WHERE o.relnamespace = c.relnamespace AND o.relname = ${literal(to)})`,
      `ALTER INDEX ${q(from)} RENAME TO ${q(to)};`
    ),
    description: `Rename "${from}" on "${tableName}" to "${to}" (${why})`,
    kind: "RENAME_INDEX",
    severity,
    tableName,
  });
}

/** "t", or "t"."c" when the holder is one column the script drops. */
function holderLabel(tableName: string, columnName: string | null): string {
  return columnName === null ? `"${tableName}"` : `"${tableName}"."${columnName}"`;
}

function parkSequenceStatement(
  tableName: string,
  from: string,
  to: string,
  why: string,
  severity: ChangeSeverity,
  columnName: string | null = null
): SqlStatement {
  return objectStatement({
    // Guarded by the table it belongs to, for the same reason as an index.
    sql: onlyIfPresent(
      `${ownedSequenceQuery(from, tableName, "'a', 'i'", columnName)} AND to_regclass(${literal(q(to))}) IS NULL`,
      `ALTER SEQUENCE ${q(from)} RENAME TO ${q(to)};`
    ),
    description: `Rename sequence "${from}" of ${holderLabel(tableName, columnName)} to "${to}" (${why})`,
    kind: "ALTER_SEQUENCE",
    severity,
    tableName,
  });
}

function untieSequenceStatement(tableName: string, name: string, columnName: string | null = null): SqlStatement {
  return objectStatement({
    sql: onlyIfPresent(
      ownedSequenceQuery(name, tableName, "'a'", columnName),
      `ALTER SEQUENCE ${q(name)} OWNED BY NONE;`
    ),
    description:
      `Untie sequence "${name}" from ${holderLabel(tableName, columnName)}, which the source no longer has, ` +
      `so the sequence outlives that ${columnName === null ? "table" : "column"} as it does in the source`,
    kind: "ALTER_SEQUENCE",
    severity: "info",
    tableName,
  });
}

function parkLooseSequenceStatement(from: string, to: string, newOwner: string): SqlStatement {
  return objectStatement({
    // Only while it is still a sequence of its own. On a second run of the same
    // script the name already belongs to the new column's sequence, which must
    // stay as it is. Skipped, not failed, if the new name has been taken by then.
    sql: onlyIfPresent(
      `SELECT 1 FROM pg_class c WHERE c.oid = to_regclass(${literal(q(from))}) AND c.relkind = 'S' ` +
        `AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass ` +
        `AND d.objid = c.oid AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')) ` +
        `AND to_regclass(${literal(q(to))}) IS NULL`,
      `ALTER SEQUENCE ${q(from)} RENAME TO ${q(to)};`
    ),
    description:
      `Rename sequence "${from}" to "${to}" (the source gives the name to ${newOwner}, ` +
      `and the old sequence is dropped further down)`,
    kind: "ALTER_SEQUENCE",
    severity: "info",
    tableName: from,
  });
}

/**
 * The moves that free every name the script needs while the target still has
 * it on something else. See the top of this file. It also takes an identity
 * column's own sequence name back out of `plan` when that name stays taken.
 */
export function freeReusedNames(report: CompareReport, allowDataLoss: boolean, plan: SequencePlan): NameClashPlan {
  const result: NameClashPlan = {
    statements: [],
    parkedKeys: new Map(),
    freedNames: new Set(),
    parkedSequences: new Set(),
    parkedDrops: new Map(),
    adoptedSequences: new Set(),
    warnings: [],
  };
  const { early, late } = namesTheScriptCreates(report);
  const wanterOf = (name: string) => early.get(name) ?? late.get(name);

  // A parked name must be new to both sides, so it can neither collide now nor
  // with anything the script creates later.
  const taken = new Set<string>();
  addNamesIn(report.left, taken);
  addNamesIn(report.right, taken);
  // What the target has right now. A kept key can only take its source name
  // when nothing here has it.
  const inTarget = new Set<string>();
  addNamesIn(report.right, inTarget);
  // The target's relation names once these moves are done, for the identity
  // sequence names at the end.
  const relations = new Set<string>();
  addRelationNamesIn(report.right, relations);

  const move = (statement: SqlStatement, from: string, to: string) => {
    result.statements.push(statement);
    inTarget.delete(from);
    inTarget.add(to);
    relations.delete(from);
    relations.add(to);
    taken.add(to);
  };

  for (const match of report.matchedTables) {
    // These run before the table renames, so the table still has its target name.
    const tableName = match.right.name;
    const dropping = keysTheTableDrops(match);
    for (const { kind, constraint } of indexedKeys(match.right)) {
      const name = constraint.name;
      if (dropping.has(name)) {
        // A table drops its own keys before it adds any, and plain indexes are
        // made after every drop, so only a key another table adds needs the
        // name this early.
        const wanter = early.get(name);
        if (wanter === undefined || wanter === match.left.name) continue;
        const parked = parkingName(name, taken);
        move(
          renameIndexStatement(tableName, name, parked, `it is dropped further down, and "${wanter}" needs the name first`, "info"),
          name,
          parked
        );
        const parkedHere = result.parkedKeys.get(match.left.name) ?? new Map<string, string>();
        parkedHere.set(name, parked);
        result.parkedKeys.set(match.left.name, parkedHere);
        continue;
      }
      const wanter = wanterOf(name);
      if (wanter === undefined) continue;
      // A key the script keeps. The comparison pairs keys by what they do, not
      // by name, so the source can give this name to another key, even one on
      // this same table.
      const sourceName = sourceNameOfKeptKey(match, kind, constraint);
      const to =
        sourceName !== null && sourceName !== name && !inTarget.has(sourceName)
          ? sourceName
          : parkingName(name, taken);
      move(
        renameIndexStatement(
          tableName,
          name,
          to,
          `${to === sourceName ? "its name in the source" : "a free name"}, so "${wanter}" can have "${name}"`,
          // The key stays, under a new name. Code that names it, as
          // ON CONFLICT ON CONSTRAINT does, has to follow.
          "breaking"
        ),
        name,
        to
      );
    }
  }

  for (const table of report.tablesOnlyInB) {
    const names = [
      ...indexedKeys(table).map(({ constraint }) => constraint.name),
      ...(table.indexes ?? []).map((index) => index.name),
    ];
    for (const name of names) {
      const wanter = wanterOf(name);
      if (wanter === undefined) continue;
      // Moved even when the table is dropped further down: safe mode, or a
      // view still reading it, can hold that drop back.
      const parked = parkingName(name, taken);
      move(
        renameIndexStatement(
          table.name,
          name,
          parked,
          `"${table.name}" is not in the source, and "${wanter}" needs the name`,
          allowDataLoss ? "info" : "breaking"
        ),
        name,
        parked
      );
      if (!allowDataLoss) {
        result.warnings.push(
          `"${table.name}" is not in the source, but safe mode keeps it, so its "${name}" is ` +
            `renamed to "${parked}" to free the name for "${wanter}".`
        );
      }
    }
  }

  // Sequences of tables the script drops, or of columns it drops from tables
  // it keeps, when the source uses the same name.
  const doomed = new Map(report.tablesOnlyInB.map((table) => [table.name, table] as const));
  const newTables = new Map(report.tablesOnlyInA.map((table) => [table.name, table] as const));
  const sourceSequences = report.left.sequences ?? [];
  const targetSequences = report.right.sequences ?? [];
  for (const held of targetSequences) {
    const holderName = sequenceOwnerTable(held, report.right.schema);
    if (holderName === null) continue;
    const doomedTable = doomed.get(holderName);
    const keptTable = doomedTable
      ? undefined
      : report.matchedTables.find(
          (m) => m.right.name === holderName && m.columnsOnlyInB.some((col) => col.name === held.ownedByColumn)
        )?.right;
    const holder = doomedTable ?? keptTable;
    if (!holder) continue;
    // Set when the holder is one column the script drops: its table stays.
    const droppedColumn = keptTable ? held.ownedByColumn : null;
    const wanted = sourceSequences.find((sequence) => sequence.name === held.name);
    if (!wanted) continue;
    // Something else in the target reads it too.
    const readByAnother = report.right.tables.some((other) =>
      other.columns.some(
        (col) =>
          nextvalSequenceName(col.columnDefault) === held.name &&
          (other.name !== holder.name || (droppedColumn !== null && col.name !== droppedColumn))
      )
    );
    const holderIsIdentity = Boolean(holder.columns.find((col) => col.name === held.ownedByColumn)?.identity);
    const ownerName = sequenceOwnerTable(wanted, report.left.schema);

    let action: "park" | "untie" | "free" | null = null;
    if (ownerName === null) {
      // The source keeps it as a sequence of its own. Untied, it outlives the
      // old table, and so does every default that reads it. An identity
      // sequence cannot be untied, so a new one is made, unless another table
      // still reads the old one: moving it would change what that table reads.
      if (!holderIsIdentity) action = "untie";
      else if (!readByAnother) action = "park";
      else continue;
    } else {
      // A table the script keeps still reads it. The old table's drop could not
      // run anyway, and moving the sequence would change what that table reads.
      if (readByAnother && droppedColumn === null) continue;
      const newTable = newTables.get(ownerName);
      const match = report.matchedTables.find((m) => m.left.name === ownerName);
      const sourceColumn = (newTable ?? match?.left)?.columns.find((col) => col.name === wanted.ownedByColumn);
      if (!sourceColumn) continue;
      const targetColumn = match?.columnMatches.find((cm) => cm.left.name === sourceColumn.name)?.right.name;
      const targetOwnsOne =
        match !== undefined &&
        targetColumn !== undefined &&
        targetSequences.some(
          (sequence) =>
            sequenceOwnerTable(sequence, report.right.schema) === match.right.name &&
            sequence.ownedByColumn === targetColumn
        );
      if (targetOwnsOne) {
        // ownedSequenceRenamePairs gives the kept table's own sequence this name.
        action = "free";
      } else if (
        sourceColumn.identity ||
        holderIsIdentity ||
        (usesSerialShorthand(plan, ownerName, sourceColumn.name) &&
          (newTable !== undefined || match?.columnsOnlyInA.some((col) => col.name === sourceColumn.name)))
      ) {
        // An identity or serial column makes a sequence of its own, so the old
        // one has to make room. A serial would otherwise quietly take "..._seq1".
        action = "park";
      }
      // Otherwise the new column takes the old sequence over, counter and all:
      // CREATE SEQUENCE IF NOT EXISTS keeps it, and OWNED BY moves it across.
      if (droppedColumn !== null) {
        // A dropped column goes in the table changes, which may come before or
        // after the new column's: untied first, the sequence is there either way.
        if (action === null) action = "untie";
        else if (readByAnother) continue;
      }
    }
    if (action === null || action === "untie") {
      if (action === "untie") result.statements.push(untieSequenceStatement(holder.name, held.name, droppedColumn));
      // It lives on as the source's sequence, so it takes the source's bounds.
      if (!sameSequenceOptions(held, wanted)) result.statements.push(alterSequenceStatement(wanted));
      continue;
    }
    const parked = parkingName(held.name, taken);
    const newOwner = ownerName === null ? "a sequence of its own" : `"${ownerName}"`;
    const label = holderLabel(holder.name, droppedColumn);
    move(
      parkSequenceStatement(
        holder.name,
        held.name,
        parked,
        `${label} is not in the source, and the source gives the name to ${newOwner}`,
        allowDataLoss ? "info" : "breaking",
        droppedColumn
      ),
      held.name,
      parked
    );
    result.parkedSequences.add(held.name);
    if (action === "free") result.freedNames.add(held.name);
    if (!allowDataLoss) {
      result.warnings.push(
        `${label} is not in the source, but safe mode keeps it, so its sequence ` +
          `"${held.name}" is renamed to "${parked}" to free the name.`
      );
    }
  }

  // Sequences of their own in the target that the source ties to a new column.
  // The column's own statements take it over (CREATE SEQUENCE IF NOT EXISTS
  // keeps it, OWNED BY ties it), so it is kept. Dropping it further down would
  // be refused anyway: the column's default reads it.
  const newColumns = [
    ...report.tablesOnlyInA.flatMap((table) => table.columns.map((col) => ({ tableName: table.name, col }))),
    ...report.matchedTables.flatMap((match) =>
      match.columnsOnlyInA.map((col) => ({ tableName: match.left.name, col }))
    ),
  ];
  for (const { tableName, col } of newColumns) {
    if (col.identity || usesSerialShorthand(plan, tableName, col.name)) continue;
    const name = nextvalSequenceName(col.columnDefault);
    if (name === null) continue;
    const wanted = sourceSequences.find((sequence) => sequence.name === name);
    if (!wanted || sequenceOwnerTable(wanted, report.left.schema) !== tableName) continue;
    if (wanted.ownedByColumn !== col.name) continue;
    const held = targetSequences.find((sequence) => sequence.name === name);
    if (!held || held.ownedByTable !== null) continue;
    result.adoptedSequences.add(name);
    if (!sameSequenceOptions(held, wanted)) result.statements.push(alterSequenceStatement(wanted));
  }

  // Sequences of their own in the target whose name the source gives to an
  // identity or serial column. That column makes a new sequence, under that
  // name only when it is free (PostgreSQL quietly picks another one when it is
  // not), so the old one moves aside first and is dropped under its new name.
  // The same goes when a kept column already has a sequence of its own that is
  // renamed to this name (ownedSequenceRenamePairs), as long as no column in
  // the target reads this one: moving it would change what that column reads.
  const tied = sequencesTiedToColumns(report);
  const readInTarget = new Set(
    report.right.tables.flatMap((table) => table.columns.map((col) => nextvalSequenceName(col.columnDefault)))
  );
  for (const held of targetSequences) {
    if (held.ownedByTable !== null || tied.has(held.name) || result.adoptedSequences.has(held.name)) continue;
    const wanted = sourceSequences.find((sequence) => sequence.name === held.name);
    if (!wanted || wanted.ownedByColumn === null) continue;
    const ownerName = sequenceOwnerTable(wanted, report.left.schema);
    if (ownerName === null) continue;
    const owner = newTables.get(ownerName) ?? report.matchedTables.find((m) => m.left.name === ownerName)?.left;
    const column = owner?.columns.find((col) => col.name === wanted.ownedByColumn);
    if (!column) continue;
    const makesItsOwn = column.identity || usesSerialShorthand(plan, ownerName, column.name);
    const renamedOnto =
      !makesItsOwn &&
      !readInTarget.has(held.name) &&
      ownedSequenceRenamePairs(report, new Set([...result.freedNames, held.name])).some(
        (pair) => pair.to === held.name
      );
    if (!makesItsOwn && !renamedOnto) continue;
    const parked = parkingName(held.name, taken);
    move(parkLooseSequenceStatement(held.name, parked, `"${ownerName}"."${column.name}"`), held.name, parked);
    result.parkedSequences.add(held.name);
    result.freedNames.add(held.name);
    result.parkedDrops.set(held.name, parked);
  }

  // An identity column asks for its source sequence name only when nothing in
  // the target has that name any more. Otherwise PostgreSQL picks its usual one.
  for (const [tableName, columns] of plan.identityNames) {
    for (const [columnName, sequenceName] of columns) {
      if (relations.has(sequenceName)) columns.delete(columnName);
    }
    if (columns.size === 0) plan.identityNames.delete(tableName);
  }
  return result;
}
