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

export type ColumnMatch = {
  left: ColumnSnapshot;
  right: ColumnSnapshot;
  score: number;
  exact: boolean;
  breakdown: ScoreBreakdown;
  changes: string[];
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
