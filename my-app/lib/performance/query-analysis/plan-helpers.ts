// Query analysis: small questions asked of plan steps.
//
// Holds the helpers the rules and the sentence builders share: a step's
// children, the two sides of a join, row totals, and reading a detail value.

import type { PlanStep } from "./plan-types";

/**
 * The direct children of every step, indexed by the parent's id. Uses
 * parentId, so it is exact however the plan is nested.
 */
export function childrenById(steps: PlanStep[]): PlanStep[][] {
  const children: PlanStep[][] = steps.map(() => []);
  for (const step of steps) {
    if (step.parentId !== null) children[step.parentId].push(step);
  }
  return children;
}

/** The two sides of a join, without any InitPlan or SubPlan hanging off it. */
export function joinSides(siblings: PlanStep[]): PlanStep[] {
  return siblings.filter(
    (s) => s.parentRelationship !== "InitPlan" && s.parentRelationship !== "SubPlan"
  );
}

/** The side a join reads once. PostgreSQL labels it "Outer"; else the first. */
export function outerSide(siblings: PlanStep[]): PlanStep | undefined {
  const sides = joinSides(siblings);
  return sides.find((s) => s.parentRelationship === "Outer") ?? sides[0];
}

/** True for the side a nested loop repeats: "Inner", or else the second side. */
export function isInnerSide(step: PlanStep, siblings: PlanStep[]): boolean {
  const sides = joinSides(siblings);
  const inner = sides.find((s) => s.parentRelationship === "Inner") ?? sides[1];
  return inner !== undefined && inner.id === step.id;
}

/** How many rows a step really produced, across all of its loops. */
export function totalActualRows(step: PlanStep): number | null {
  if (step.actualRows === null) return null;
  return step.actualRows * (step.loops ?? 1);
}

/**
 * What the planner divides a parallel scan's rows by to give one process's
 * share, for `workers` helpers: each helper counts as one, and the main
 * process as the time it has left over from collecting their rows, taken to
 * be 1 - 0.3 per helper and nothing from four helpers up. So 1.7 for one
 * helper, 2.4 for two, 3.1 for three and 4 for four (PostgreSQL's
 * get_parallel_divisor). That is with parallel_leader_participation on, the
 * default; with it off the real divisor is smaller, so a total worked out
 * from this one can come out too large, never too small.
 */
export function plannerShareDivisor(workers: number): number {
  const leader = 1 - 0.3 * workers;
  return workers + (leader > 0 ? leader : 0);
}

/**
 * How many rows a step handed on in all. Measured, across its loops (for a
 * parallel scan the loops are the processes). Estimated, Plan Rows, except
 * for a step the helper processes share: its Plan Rows are one process's
 * share, so they are multiplied back up by what the planner divided them by,
 * or null when that is not known. Every step below one Gather is taken to be
 * split the Gather's way; one side of a parallel join planned with a
 * different number of helpers is off by the difference.
 */
export function rowsHandedOn(step: PlanStep): number | null {
  const measured = totalActualRows(step);
  if (measured !== null) return measured;
  if (!step.parallelAware) return step.estimatedRows;
  return step.shareDivisor === null ? null : step.estimatedRows * step.shareDivisor;
}

/** The value of one "Key: value" detail line, or null when the step has none. */
export function detailValue(step: PlanStep, key: string): string | null {
  const prefix = `${key}: `;
  const line = step.details.find((d) => d.startsWith(prefix));
  return line === undefined ? null : line.slice(prefix.length);
}

/**
 * The count off a "Rows Removed by Filter: 39999" plan line, when there is one.
 *
 * PER LOOP, like Actual Rows: PostgreSQL divides both by the loop count before
 * printing them, so the two can be compared directly and multiplied by
 * `loops` together for a total.
 */
export function rowsRemovedByFilter(step: PlanStep): number | null {
  const value = detailValue(step, "Rows Removed by Filter");
  if (value === null) return null;
  const removed = Number(value);
  return Number.isFinite(removed) ? removed : null;
}

/** "public.orders" for the reader, or the bare name when the plan gave no schema. */
export function tableName(step: PlanStep): string {
  if (step.relation === null) return step.label;
  return step.relationSchema === null ? step.relation : `${step.relationSchema}.${step.relation}`;
}
