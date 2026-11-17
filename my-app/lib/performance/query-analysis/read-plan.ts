// Query analysis: readPlan, the way in for a plan.
//
// Holds the functions that take raw EXPLAIN output and return a PlanSummary:
// planSteps, readPlan and describePlan.

import { sortFindings } from "./findings";
import type { PlanStep, PlanSummary, RawPlanNode } from "./plan-types";
import { flattenPlan, numOrNull } from "./plan-flatten";
import { totalActualRows } from "./plan-helpers";
import { fmtMs, fmtRows } from "./wording";
import type { PlanCatalog } from "./catalog";
import { planFindings } from "./plan-findings";

/**
 * Find the plan inside whatever the driver handed back.
 *
 * node-pg returns EXPLAIN (FORMAT JSON) already parsed, as a one-element
 * array. The bare object is accepted too, since that is what a test writes.
 */
function parseEnvelope(raw: unknown): { record: RawPlanNode; root: RawPlanNode } | null {
  const envelope: unknown = Array.isArray(raw) ? raw[0] : raw;
  if (typeof envelope !== "object" || envelope === null) return null;

  const record = envelope as RawPlanNode;
  const rootValue = record["Plan"];
  const root =
    typeof rootValue === "object" && rootValue !== null ? (rootValue as RawPlanNode) : null;
  if (!root || typeof root["Node Type"] !== "string") return null;
  return { record, root };
}

/**
 * Just the flattened steps, for the checks that run before anything else.
 *
 * The route asks checkPlanIsReadOnly and planMentionsDenied about the plain
 * EXPLAIN before it decides whether to run the query for real, and has no use
 * for findings at that point. Null when the reply is not a plan.
 */
export function planSteps(raw: unknown): PlanStep[] | null {
  const parsed = parseEnvelope(raw);
  return parsed ? flattenPlan(parsed.root) : null;
}

/**
 * Turn one `EXPLAIN (FORMAT JSON)` result into something readable.
 *
 * Returns null rather than throwing when the shape is not a plan at all: the
 * caller has just handed over whatever a database replied with, and a driver
 * that returns the JSON as a string, or a version that nests it differently,
 * should show "could not read the plan" rather than a stack trace.
 *
 * `catalog` is optional and sharpens the rules that care how much a step
 * reads rather than how much it returns — see TableRows.
 */
export function readPlan(raw: unknown, catalog: Partial<PlanCatalog> = {}): PlanSummary | null {
  const parsed = parseEnvelope(raw);
  if (!parsed) return null;

  const steps = flattenPlan(parsed.root, catalog.tableRows);
  const measured = steps.some((s) => s.actualRows !== null);

  const { heaviestStepId, basis } = weighSteps(steps, measured);

  return {
    steps,
    totalCost: steps[0]?.estimatedCost ?? 0,
    estimatedRows: steps[0]?.estimatedRows ?? 0,
    planningMs: numOrNull(parsed.record, "Planning Time"),
    executionMs: numOrNull(parsed.record, "Execution Time"),
    measured,
    heaviestStepId,
    basis,
    findings: sortFindings(planFindings(steps, measured, catalog)),
  };
}

/**
 * Set every step's `share` of the whole query, and pick the heaviest step.
 *
 * Measured time wins when there is some: it is what really happened. A plan
 * run with EXPLAIN (ANALYZE, TIMING OFF) has row counts but no times, so it
 * falls back to the planner's cost like an estimate, and says so.
 *
 * Ties go to the first step in plan order, the one nearer the top.
 */
function weighSteps(
  steps: PlanStep[],
  measured: boolean
): { heaviestStepId: number | null; basis: "time" | "cost" } {
  const totalMs = steps.reduce((sum, s) => sum + (s.selfMs ?? 0), 0);
  const basis = measured && totalMs > 0 ? "time" : "cost";
  const weightOf = (s: PlanStep): number => (basis === "time" ? (s.selfMs ?? 0) : s.selfCost);
  const total = steps.reduce((sum, s) => sum + weightOf(s), 0);

  let heaviestStepId: number | null = null;
  let heaviest = 0;
  for (const step of steps) {
    const weight = weightOf(step);
    step.share = total > 0 ? weight / total : 0;
    if (weight > heaviest) {
      heaviest = weight;
      heaviestStepId = step.id;
    }
  }
  return { heaviestStepId, basis };
}

/** A one-line verdict for the top of the screen. */
export function describePlan(summary: PlanSummary): string {
  const head = summary.steps[0];
  if (!head) return "The server returned an empty plan.";
  if (summary.measured) {
    const rows = totalActualRows(head);
    const tail =
      `returned ${fmtRows(rows ?? 0)} row${rows === 1 ? "" : "s"}, in ` +
      `${summary.steps.length} step${summary.steps.length === 1 ? "" : "s"}.`;
    // A measured plan can arrive without a total time — EXPLAIN (ANALYZE,
    // SUMMARY OFF) omits it, and so do some older servers. The query still ran,
    // so it drops the duration rather than falling through to the sentence
    // below, which would tell the reader it was never executed.
    return summary.executionMs === null
      ? `Ran and ${tail}`
      : `Ran in ${fmtMs(summary.executionMs)} and ${tail}`;
  }
  return (
    `Planned in ${summary.steps.length} step${summary.steps.length === 1 ? "" : "s"}, ` +
    `expecting ${fmtRows(summary.estimatedRows)} ` +
    `row${summary.estimatedRows === 1 ? "" : "s"} back. Not run, so these are ` +
    `estimates.`
  );
}
