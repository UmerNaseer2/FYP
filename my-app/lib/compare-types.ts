// ---------------------------------------------------------------------------
// compare-types.ts
// Shared TypeScript types for the schema comparison pipeline.
// Imported by compare.ts (algorithm) and page.tsx (UI renderer).
// ---------------------------------------------------------------------------

import type {
  ColumnSnapshot,
  ConstraintSnapshot,
  ForeignKeySnapshot,
  SchemaSnapshot,
  TableSnapshot,
} from "./postgres";

// Re-export postgres types that the UI also needs directly
export type { ColumnSnapshot, ConstraintSnapshot, ForeignKeySnapshot, SchemaSnapshot, TableSnapshot };

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
  summary: {
    tablesOnlyInA: number;
    tablesOnlyInB: number;
    changedTables: number;
    changedConstraints: number;
    likelyRenameCandidates: number;
    identicalTables: number;
  };
};
