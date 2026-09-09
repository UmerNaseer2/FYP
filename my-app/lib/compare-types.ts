// ---------------------------------------------------------------------------
// compare-types.ts
// Shared TypeScript types for the schema comparison pipeline.
// Imported by compare.ts (algorithm) and page.tsx (UI renderer).
// ---------------------------------------------------------------------------

import type {
  ColumnSnapshot,
  ConstraintSnapshot,
  ForeignKeySnapshot,
  IndexSnapshot,
  RoutineSnapshot,
  SchemaSnapshot,
  SequenceSnapshot,
  TableSnapshot,
  TriggerSnapshot,
  TypeSnapshot,
  ViewSnapshot,
} from "./postgres";

// Re-export postgres types that the UI also needs directly
export type {
  ColumnSnapshot,
  ConstraintSnapshot,
  ForeignKeySnapshot,
  IndexSnapshot,
  RoutineSnapshot,
  SchemaSnapshot,
  SequenceSnapshot,
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
  | "generated"
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
  | "FUNCTION"
  | "PROCEDURE";

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
   * CREATE OR REPLACE cannot carry this routine change — PostgreSQL rejects a
   * replacement that changes the return type or renames an argument, so the old
   * one has to be dropped first. See routineReplaceNeedsDrop.
   */
  replaceNeedsDrop?: boolean;
};

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
  routines: boolean;
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
  /** Table-scoped object differences: indexes and triggers. */
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
