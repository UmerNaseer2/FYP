// Query analysis: what a finding is.
//
// Holds the QueryFinding type every rule produces, and the two small
// functions that order a list of findings and count it by severity.

import type { FixKind } from "../sql";

export type Severity = "high" | "medium" | "low";

/** One finding, whichever half produced it. Same shape as PerfAdvice by design. */
export type QueryFinding = {
  id: string;
  severity: Severity;
  title: string;
  /** What it is about — a table, a plan step, or the statement itself. */
  object: string;
  detail: string;
  /**
   * What to do: SQL to paste, or comment lines setting out a choice. Never
   * empty; tests/helpers/fix-invariants.ts checks every rule for that.
   */
  fix: string;
  /**
   * What kind of fix `fix` is: the card's header says it in words ("Schema
   * change", "Maintenance", …) so nobody runs a fix without knowing what it
   * does. Required, so a new rule cannot leave its fix unlabelled.
   */
  fixKind: FixKind;
  /** For a `change`: the statement that takes it back out, e.g. DROP INDEX. */
  undo?: string;
  /**
   * For a `change`: every schema its statements alter, e.g. ["sales"] for an
   * index on sales.orders. A query can read tables in any schema, not only
   * the one picked above it, and a migration is made for one schema, so the
   * fix script saves only the changes to that one (FixScriptItem in
   * lib/performance/sql.ts). Left out for every other kind.
   */
  schemas?: string[];
  /**
   * The plan step this finding is about (a PlanStep id), or null when it came
   * from reading the query text. Required rather than optional so a new rule
   * cannot forget to say: the plan tree counts findings per step with it, and
   * the finding card prints "Step N" so the reader can find the box.
   */
  stepId: number | null;
};

/** Highest severity first, then in plan order, so the list reads top-down. */
const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

export function sortFindings(findings: QueryFinding[]): QueryFinding[] {
  return [...findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

/** {high, medium, low, total} across any list of findings. */
export function summarizeFindings(findings: QueryFinding[]): {
  high: number;
  medium: number;
  low: number;
  total: number;
} {
  return {
    high: findings.filter((f) => f.severity === "high").length,
    medium: findings.filter((f) => f.severity === "medium").length,
    low: findings.filter((f) => f.severity === "low").length,
    total: findings.length,
  };
}
