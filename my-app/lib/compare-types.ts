// ---------------------------------------------------------------------------
// compare-types.ts
// Shared TypeScript types for the schema comparison pipeline.
// Imported by compare.ts (algorithm) and page.tsx (UI renderer).
// ---------------------------------------------------------------------------

import type {
  CollationSnapshot,
  ColumnSnapshot,
  ConstraintSnapshot,
  ForeignKeySnapshot,
  IndexSnapshot,
  PolicySnapshot,
  RoutineSnapshot,
  RowSecuritySnapshot,
  SchemaSnapshot,
  SequenceSnapshot,
  TablePartitioning,
  TableSnapshot,
  TriggerSnapshot,
  TypeSnapshot,
  ViewSnapshot,
} from "./postgres";

// Re-export postgres types that the UI also needs directly
export type {
  CollationSnapshot,
  ColumnSnapshot,
  ConstraintSnapshot,
  ForeignKeySnapshot,
  IndexSnapshot,
  PolicySnapshot,
  RoutineSnapshot,
  RowSecuritySnapshot,
  SchemaSnapshot,
  SequenceSnapshot,
  TablePartitioning,
  TableSnapshot,
  TriggerSnapshot,
  TypeSnapshot,
  ViewSnapshot,
};

export type ScoreBreakdown = {
  name: number;
  constraints: number;
  columns?: number;
  type?: number;
  order?: number;
  relationships?: number;
};

export type MatchCandidate = {
  kind: "table" | "column";
  leftName: string;
  rightName: string;
  score: number;
  accepted: boolean;
  breakdown: ScoreBreakdown;
};

/**
 * How dangerous a single change is. Shared by the compare engine, the migration
 * generator and the report so all three grade a change on the same scale.
 *
 *   breaking — can fail outright, or removes something other objects rely on
 *   safe     — always applies cleanly and takes nothing away
 *   info     — worth listing, but neither of the above
 */
export type ChangeSeverity = "breaking" | "safe" | "info";

/** Which property of a column changed. */
export type ColumnChangeKind =
  | "type"
  | "size"
  | "nullability"
  | "collation"
  | "generated"
  | "computed"
  | "default"
  | "primaryKey"
  | "unique"
  | "foreignKey";

/**
 * One difference between a matched pair of columns.
 *
 * `severity` is decided once, in the compare engine, from the snapshot fields
 * themselves — the report must never re-derive it by reading `message`. It used
 * to: DiffReport re-implemented the generator's rules by string-matching this
 * prose, so rewording a message silently mis-coloured the report, and a message
 * with no matching branch (a default change, a unique/FK participation change)
 * quietly graded itself "info". `message` is display text and nothing else.
 */
export type ColumnChange = {
  kind: ColumnChangeKind;
  severity: ChangeSeverity;
  message: string;
};

export type ColumnMatch = {
  left: ColumnSnapshot;
  right: ColumnSnapshot;
  score: number;
  exact: boolean;
  breakdown: ScoreBreakdown;
  changes: ColumnChange[];
};

export type ConstraintDiff = {
  kind:
    | "PRIMARY KEY"
    | "UNIQUE"
    | "FOREIGN KEY"
    | "CHECK"
    | "EXCLUDE";
  status: "onlyA" | "onlyB" | "changedDefinition";
  summary: string;
  leftName?: string;
  rightName?: string;
};

/**
 * Everything in a schema that is neither a table nor a column nor a constraint.
 *
 * These deliberately do NOT ride ConstraintDiff. A dropped index is not a
 * constraint change, and folding it in would make the report, the summary
 * counters and every stored drift record say "constraints changed" when
 * nothing about a constraint moved.
 */
export type ObjectKind =
  | "INDEX"
  | "TRIGGER"
  | "VIEW"
  | "MATERIALIZED VIEW"
  | "SEQUENCE"
  | "ENUM"
  | "DOMAIN"
  | "COMPOSITE TYPE"
  | "RANGE TYPE"
  | "COLLATION"
  | "FUNCTION"
  | "PROCEDURE"
  | "POLICY"
  | "ROW SECURITY"
  | "PARTITIONING";

export type ObjectDiff = {
  kind: ObjectKind;
  /** The name as the user knows it — for a routine, its full signature. */
  name: string;
  status: "onlyA" | "onlyB" | "changedDefinition";
  summary: string;
  /** The definition on each side; absent on the side that lacks the object. */
  leftDefinition?: string;
  rightDefinition?: string;
  /** Set for table-scoped objects (indexes, triggers): the table they hang off. */
  table?: string;
  /**
   * How dangerous this change is, decided where both sides were still in hand.
   *
   * A unique index, a domain that gained a CHECK and a function whose return
   * type moved all look like ordinary definition changes in the text. The
   * report used to restate the generator's rules to tell them apart, from a
   * `Set` of index names each caller had to assemble itself — and one of them
   * assembled it from the wrong side. Deciding it once, at construction, is
   * what stops the pill on screen and the warning on the statement from
   * drifting apart. Read it through objectDiffSeverity().
   */
  severity: ChangeSeverity;
  /**
   * Whether CREATE OR REPLACE can carry this change on its own, or the old
   * object has to be dropped first.
   *
   * Set for routines — PostgreSQL rejects a replacement that changes the return
   * type or renames an argument — and for views, where a changed column list
   * (or a materialized view of any kind) forces a drop but a change confined to
   * the WITH (...) settings does not. `undefined` for every other kind, which
   * means "not a question that applies here".
   *
   * The generator and the report both read this rather than deciding for
   * themselves, so the SQL and the sentence describing it cannot drift apart.
   * See routineReplaceNeedsDrop and viewReplaceNeedsDrop.
   */
  replaceNeedsDrop?: boolean;
  /**
   * True when applying the migration drops an object that holds its own copy of
   * the rows — today that means a materialized view, which stores its result
   * set the way a table does. A plain view is a stored query and holds nothing.
   *
   * The banner that counts what a sync is about to destroy used to look for
   * `kind === "MATERIALIZED VIEW" && status === "onlyB"`, which missed both a
   * matview whose SELECT changed (dropped and rebuilt, so still dropped) and a
   * plain view in the source that is a matview in the target, where `kind` is
   * stamped from the SOURCE and reads "VIEW". Both cases produce a destructive
   * DROP in the script, so the banner said nothing while the generator said
   * "1 destructive statement". Decided here, where both sides are in hand.
   */
  dropDestroysData?: boolean;
  /**
   * True when no statement can carry this change, so a person has to plan it.
   *
   * Set only where the answer is certain from the snapshot or from PostgreSQL
   * itself, never by restating what the generator happens to do today: a range
   * type the snapshot cannot describe well enough to create (asked through
   * rangeTypeIsCreatable, which is also what the generator asks), and a changed
   * collation or range type, neither of which PostgreSQL has any ALTER for.
   *
   * `undefined` is NOT a promise that the script has a runnable statement — it
   * only means this was not one of the cases decided here. The report used to
   * print "only in source — created" over a range type the script could do
   * nothing but describe; this is what stops that sentence being written.
   */
  needsManualWork?: boolean;
};

/** The categories the matrix has a row for, named the way the report names them. */
export type ObjectCategoryKey =
  | "indexes"
  | "triggers"
  | "views"
  | "sequences"
  | "types"
  | "collations"
  | "routines"
  | "rowSecurity"
  | "partitioning";

/**
 * Why a category was skipped. There are two reasons and they are not the same
 * thing, so telling the reader the wrong one is a defect in its own right.
 *
 *   snapshotPredatesCategory — one of the snapshots has no record of it, so the
 *     comparison would read "not recorded" as "none" and report every object on
 *     the other side as newly added. Nothing can be done but re-capture.
 *   noMatchedTables — the category is counted on tables that exist on BOTH
 *     sides, and no table matched. Both snapshots may be perfectly current;
 *     there was simply no pair to compare. This is the normal state of the
 *     tool's most common run, a populated source against an empty target, where
 *     the panel beside the matrix is busy creating every index and trigger.
 */
export type NotComparedReason = "snapshotPredatesCategory" | "noMatchedTables";

/**
 * Which object categories BOTH snapshots recorded, and were therefore compared.
 *
 * A snapshot captured before a category existed has no record of it, which is
 * not the same as having none of them. Comparing "not recorded" against a live
 * schema would report every object in it as newly added, so those categories
 * are skipped — and the report says so rather than implying they matched.
 */
export type ComparedObjectCategories = {
  indexes: boolean;
  triggers: boolean;
  views: boolean;
  sequences: boolean;
  types: boolean;
  collations: boolean;
  routines: boolean;
  rowSecurity: boolean;
  partitioning: boolean;
  /**
   * For each category that is false above, why.
   *
   * Carried rather than re-derived because the reason lives here, where both
   * snapshots and the matched-table list are in hand. Every screen and every
   * export used to attach one hardcoded cause — "captured before this app
   * recorded them" — which is simply untrue when the real cause is that no
   * table matched. A category that WAS compared has no entry.
   */
  reasons: Partial<Record<ObjectCategoryKey, NotComparedReason>>;
};

export type TableMatch = {
  left: TableSnapshot;
  right: TableSnapshot;
  score: number;
  exact: boolean;
  breakdown: ScoreBreakdown;
  columnMatches: ColumnMatch[];
  columnsOnlyInA: ColumnSnapshot[];
  columnsOnlyInB: ColumnSnapshot[];
  possibleColumnMatches: MatchCandidate[];
  constraintDiffs: ConstraintDiff[];
  /**
   * Table-scoped object differences: indexes, triggers, row security and
   * partitioning.
   */
  objectDiffs: ObjectDiff[];
  changedSections: string[];
  hasChanges: boolean;
};

export type CompareReport = {
  left: SchemaSnapshot;
  right: SchemaSnapshot;
  matchedTables: TableMatch[];
  tablesOnlyInA: TableSnapshot[];
  tablesOnlyInB: TableSnapshot[];
  possibleTableMatches: MatchCandidate[];
  /** Schema-scoped object differences: views, sequences, types and routines. */
  objectDiffs: ObjectDiff[];
  comparedObjectCategories: ComparedObjectCategories;
  summary: {
    tablesOnlyInA: number;
    tablesOnlyInB: number;
    changedTables: number;
    changedConstraints: number;
    likelyRenameCandidates: number;
    identicalTables: number;
    /** Table-scoped and schema-scoped object differences added together. */
    changedObjects: number;
  };
};
