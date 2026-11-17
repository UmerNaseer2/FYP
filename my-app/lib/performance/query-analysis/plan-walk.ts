// Query analysis: walking the plan.
//
// Holds the helpers that look up and down the step list: how many rows a scan
// reads, a step's subtree, and whether a step may stop before reading all of
// its input (readStop, runsMayStop).

import type { PlanStep } from "./plan-types";
import { detailValue, isInnerSide, rowsRemovedByFilter } from "./plan-helpers";
import type { TableRows } from "./catalog";

/**
 * How many rows this step actually reads, in total across its loops.
 *
 * Measured: the rows it kept plus the rows its filter threw away, per loop,
 * times the loops. That is exactly what was read, including when a LIMIT
 * above stopped the scan early.
 *
 * Estimated: for a sequential scan with a filter, the table's real size from
 * the catalog. The scan reads the whole table whatever the filter keeps, and
 * Plan Rows only counts what survives. Everything else gets Plan Rows, the
 * best number available.
 */
export function rowsScanned(step: PlanStep, tableRows: TableRows): number {
  if (step.actualRows !== null) {
    const removed = rowsRemovedByFilter(step) ?? 0;
    return (step.actualRows + removed) * (step.loops ?? 1);
  }
  const planRows = step.estimatedRows;
  if (step.nodeType !== "Seq Scan" || step.filter === null) return planRows;
  // The key is schema-qualified, so a step reading reporting.orders is never
  // measured against public.orders. A plan without "Schema" (one taken
  // without VERBOSE) has no key to look up, and gets the plan's own number
  // rather than a guess at which same-named table it meant.
  if (step.relation === null || step.relationSchema === null) return planRows;
  const known = tableRows[`${step.relationSchema}.${step.relation}`];
  // reltuples is itself an estimate. When the planner expects more rows than
  // the statistics claim exist, the planner is the fresher of the two.
  return typeof known === "number" && known > planRows ? known : planRows;
}

/**
 * The direct children of one flattened plan step.
 *
 * flattenPlan walks depth-first, so a step's subtree is the contiguous run of
 * ids after it, ending at the first step back at its own depth or shallower.
 * Matching on `depth === step.depth + 1` alone across the whole plan picked up
 * nodes under a completely different join.
 */
export function childrenOfStep(steps: PlanStep[], step: PlanStep): PlanStep[] {
  return subtreeOf(steps, step).filter((s) => s.depth === step.depth + 1);
}

/** Every step below this one, at any depth, in plan order. */
export function subtreeOf(steps: PlanStep[], step: PlanStep): PlanStep[] {
  const below: PlanStep[] = [];
  for (let i = step.id + 1; i < steps.length; i += 1) {
    if (steps[i].depth <= step.depth) break;
    below.push(steps[i]);
  }
  return below;
}

/**
 * True for a nested loop that moves on to its next row at the first match on
 * its repeated side: a Semi join (EXISTS, IN) or an Anti join (NOT EXISTS)
 * only asks whether there is one, and a side PostgreSQL proved can match each
 * row at most once (Inner Unique) has no second match to look for.
 */
function firstMatchOnly(join: PlanStep): boolean {
  return (
    join.nodeType === "Nested Loop" &&
    (join.joinType === "Semi" || join.joinType === "Anti" || join.innerUnique)
  );
}

/**
 * Steps whose own rows always come out complete, however few the step above
 * wants: a hash table holds every row of its input, a bitmap every match in
 * its index, and an INSERT, UPDATE, DELETE or MERGE ("ModifyTable") runs to
 * its end even in a WITH query read only in part, because PostgreSQL always
 * finishes one. So they, and everything below them, are read in full.
 */
const READ_WHOLE: ReadonlySet<string> = new Set([
  "Hash",
  "Bitmap Index Scan",
  "BitmapAnd",
  "BitmapOr",
  "ModifyTable",
]);

/**
 * True for a step that reads every row of its input before it hands one on:
 * a sort, or an aggregate or set operation that keeps one running total or a
 * hash table of groups ("Plain" or "Hashed"). A sorted one hands each group
 * on as soon as the next begins, so it does not.
 */
export function readsAllFirst(step: PlanStep): boolean {
  if (step.nodeType === "Sort" || step.nodeType === "HashAggregate") return true;
  if (step.nodeType !== "Aggregate" && step.nodeType !== "SetOp") return false;
  return step.strategy === "Plain" || step.strategy === "Hashed";
}

/**
 * True for a window step with a condition it checks as the rows go by
 * ("Run Condition", PostgreSQL 15 and later), which PostgreSQL adds for a
 * query like WHERE rn <= 10 around row_number() OVER (…) AS rn. Once the
 * condition fails, the step hands on no more rows of that window, and with
 * no PARTITION BY it stops reading altogether. The planner still plans it
 * for every row it reads: on PostgreSQL 17, rn <= 1000 over 300,000 rows was
 * planned for 300,000 and handed on 1,000.
 */
export function hasRunCondition(step: PlanStep): boolean {
  return step.nodeType === "WindowAgg" && detailValue(step, "Run Condition") !== null;
}

/**
 * True when the run may have stopped reading this step before it handed on
 * everything a full read would, so fewer rows than its Plan Rows (always a
 * full read's) say nothing about the estimate. The estimate-off rule needs
 * every way that happens. Walking up from the step, whatever reads it may
 * stop:
 * - a Limit, once it has enough rows;
 * - a window step with a Run Condition (hasRunCondition), once the condition
 *   fails, when the window has no PARTITION BY; the plan does not say
 *   whether it has one, so any such step counts;
 * - a Merge Join, reading one side once the other runs out, unless it must
 *   hand that side on in full: the first side of a Left, Full or Anti join,
 *   the second of a Right, Full or Right Anti one;
 * - a nested loop that moves on at the first match (firstMatchOnly), reading
 *   its repeated side;
 * - the query around a subquery: EXISTS, IN, ANY and ALL stop at the first
 *   row that settles the answer. Before PostgreSQL 17 every kind is named
 *   "SubPlan 1", so any subquery not kept as a lookup table counts;
 * - the CTE Scans reading a WITH query, which runs only as far as they ask:
 *   it may have stopped when every one of them may have.
 * A step that always comes out whole (READ_WHOLE), or one read by a step that
 * takes every row first (readsAllFirst), was read in full. A window step or a
 * sorted aggregate on the way up does not end the walk: a sorted aggregate
 * hands each group on as it goes, and a window step may, so a LIMIT may stop
 * either. The walk-through asks much the same question, and says more about
 * the answer: see readStop.
 */
export function mayBeCutShort(steps: PlanStep[], step: PlanStep, seen = new Set<number>()): boolean {
  let current = step;
  while (current.parentId !== null) {
    if (READ_WHOLE.has(current.nodeType)) return false;
    if (current.parentRelationship === "InitPlan" || current.parentRelationship === "SubPlan") {
      const cte = /^CTE (.+)$/.exec(current.subplanName ?? "");
      if (cte === null) return !current.hashedSubplan;
      // Two WITH queries of one name, in different parts of the query, cannot
      // be told apart by their readers: either may have been the one stopped.
      const name = current.subplanName;
      if (steps.filter((s) => s.subplanName === name).length > 1) return true;
      // A reader inside another WITH query leads on to that query's readers.
      // PostgreSQL never has two WITH queries read each other (a recursive
      // one reads itself through a WorkTable Scan), so this ends; `seen` only
      // keeps a plan that claims otherwise from going round forever.
      if (seen.has(current.id)) return true;
      seen.add(current.id);
      // A reader the run never started asked for nothing.
      const readers = steps.filter(
        (s) => s.nodeType === "CTE Scan" && s.cteName === cte[1] && s.loops !== 0
      );
      return readers.length > 0 && readers.every((r) => mayBeCutShort(steps, r, seen));
    }
    const parent = steps[current.parentId];
    if (parent.nodeType === "Limit" || hasRunCondition(parent)) return true;
    if (readsAllFirst(parent)) return false;
    const sides = childrenOfStep(steps, parent);
    if (parent.nodeType === "Merge Join") {
      const keptWhole = isInnerSide(current, sides)
        ? ["Right", "Full", "Right Anti"]
        : ["Left", "Full", "Anti"];
      if (!keptWhole.includes(parent.joinType ?? "")) return true;
    }
    if (firstMatchOnly(parent) && isInnerSide(current, sides)) return true;
    current = parent;
  }
  return false;
}

/**
 * Steps that only hand on their one input's rows: build a hash table of them,
 * sort them, or keep a copy. The table read happens in the step below.
 */
export const PASS_THROUGH_NODES: ReadonlySet<string> = new Set([
  "Hash",
  "Sort",
  "Incremental Sort",
  "Materialize",
  "Memoize",
]);

/** The step that really reads the rows, below any pass-through steps. */
export function unwrapScan(steps: PlanStep[], step: PlanStep): PlanStep {
  let current = step;
  while (PASS_THROUGH_NODES.has(current.nodeType)) {
    const children = childrenOfStep(steps, current);
    if (children.length !== 1) break;
    current = children[0];
  }
  return current;
}

/** Scans that go through an index, whose extra Filter is a missed column. */
export const INDEX_SCANS: ReadonlySet<string> = new Set([
  "Index Scan",
  "Index Only Scan",
  "Bitmap Heap Scan",
]);

/**
 * An index lookup that finds at most one row, by the plan's guess and by the
 * run's count: once it has found one, it has nothing left to read.
 */
function oneRowLookup(step: PlanStep): boolean {
  return (
    INDEX_SCANS.has(step.nodeType) && Math.max(step.estimatedRows, step.actualRows ?? 0) <= 1
  );
}

/**
 * Why the run may stop reading a step early, as the walk-through says it:
 * - "limit": a LIMIT above it has enough rows and asks for no more;
 * - "match": it is the repeated side of a nested loop that moves on at the
 *   first match (firstMatchOnly), so each search ends at a match;
 * - "asked": whatever reads it may stop for another reason, so it is read
 *   only as far as that needs.
 */
export type ReadStop = "limit" | "match" | "asked";

/**
 * Why the run may stop reading this step before a full read's end, or null
 * when nothing can. Its Plan Rows are what a full read would find, so an
 * estimate for a step that may stop must not quote them as what it hands on.
 *
 * The walk up is mayBeCutShort's, and "asked" is every reason it finds beyond
 * a LIMIT and a first-match loop: a window step's Run Condition, a Merge Join
 * whose other side ran out, a subquery that stops at the row that settles its
 * answer, a WITH query whose readers all may stop. Two more are "asked" too,
 * because the plan cannot say more:
 * - a LIMIT reached through a window step, which, depending on its frame (the
 *   plan does not show it), may need every row of a window before it hands
 *   one on;
 * - a first-match loop reading the step through anything but a Memoize: a
 *   Materialize, say, keeps what it read for the next search, so the step is
 *   read only as far as the furthest search went.
 * It parts from mayBeCutShort twice. A nested loop's repeated side is read to
 * the end on every run but perhaps the last, unless the loop moves on at the
 * first match: what is above the loop sets how many runs there are, not how
 * far each one goes, so the walk ends at the loop. And an index lookup of at
 * most one row (oneRowLookup) is left as it is, except under a LIMIT or as
 * the repeated side of an EXISTS or NOT EXISTS, where stopping is the point:
 * it stops there anyway, and saying it may stop early would only hide its
 * count.
 */
export function readStop(steps: PlanStep[], step: PlanStep): ReadStop | null {
  const asked: ReadStop | null = oneRowLookup(step) ? null : "asked";
  let throughWindow = false;
  let current = step;
  while (current.parentId !== null) {
    if (READ_WHOLE.has(current.nodeType)) return null;
    if (current.parentRelationship === "InitPlan" || current.parentRelationship === "SubPlan") {
      return mayBeCutShort(steps, current) ? asked : null;
    }
    const parent = steps[current.parentId];
    if (parent.nodeType === "Limit") return throughWindow ? asked : "limit";
    if (hasRunCondition(parent)) return asked;
    if (readsAllFirst(parent)) return null;
    if (parent.nodeType === "WindowAgg") throughWindow = true;
    if (parent.nodeType === "Merge Join") {
      const keptWhole = isInnerSide(current, childrenOfStep(steps, parent))
        ? ["Right", "Full", "Right Anti"]
        : ["Left", "Full", "Anti"];
      if (!keptWhole.includes(parent.joinType ?? "")) return asked;
    }
    if (parent.nodeType === "Nested Loop" && isInnerSide(current, childrenOfStep(steps, parent))) {
      if (!firstMatchOnly(parent)) return null;
      // Straight from the loop, or through a Memoize: under a loop that moves
      // on at the first match, a Memoize keeps one row for each value, so it
      // stops its own read at the first match too.
      const direct =
        current.id === step.id || (current.nodeType === "Memoize" && current.id === step.parentId);
      if (!direct) return asked;
      if (parent.joinType === "Semi" || parent.joinType === "Anti") return "match";
      return oneRowLookup(step) ? null : "match";
    }
    current = parent;
  }
  return null;
}

/**
 * True when an estimate's count of how often this step runs (estimatedRuns)
 * is only the most it may run. The count multiplies where a step runs again
 * for each row of another (see estimateRuns): the repeated side of a nested
 * loop, once for each row of the loop's first side, and a subquery run for
 * each row, once for each row of the step it hangs off. When that loop, or
 * that step, may itself be stopped early (readStop), fewer rows come through
 * than the plan counts, and so fewer runs. The walk goes on up to the top, or
 * to an InitPlan, where the count starts again at 1, because every repeat on
 * the way multiplies it: a step inside two nested loops runs for each pair.
 */
export function runsMayStop(steps: PlanStep[], step: PlanStep): boolean {
  let current = step;
  while (current.parentId !== null) {
    if (current.parentRelationship === "InitPlan") return false;
    const parent = steps[current.parentId];
    // As estimateRuns counts: a Materialize or Memoize on a nested loop's
    // repeated side, a hashed subquery and one with a Materialize on top run
    // once for each run of the step above, so the count does not multiply.
    const multiplies =
      current.parentRelationship === "SubPlan"
        ? !current.hashedSubplan && current.nodeType !== "Materialize"
        : parent.nodeType === "Nested Loop" &&
          current.nodeType !== "Materialize" &&
          current.nodeType !== "Memoize" &&
          isInnerSide(current, childrenOfStep(steps, parent));
    if (multiplies && readStop(steps, parent) !== null) return true;
    current = parent;
  }
  return false;
}
