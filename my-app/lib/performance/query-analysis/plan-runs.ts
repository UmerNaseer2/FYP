// Query analysis: how many times each step of an estimated plan will run.
//
// Holds estimateRuns and its helpers. An estimated plan does not say how often
// a step repeats, so this works it out from the steps around it.

import type { PlanStep } from "./plan-types";
import { childrenById, detailValue, isInnerSide, joinSides, outerSide } from "./plan-helpers";
import { readsAllFirst, readStop, runsMayStop } from "./plan-walk";
import { isWord, tokenize } from "./tokens";

/**
 * True when `text` mentions `name`, e.g. "SubPlan 1", as a whole name: the
 * (?!\d) keeps "SubPlan 1" from matching inside "SubPlan 12".
 */
function mentionsName(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}(?!\\d)`).test(text);
}

/** True when `text` mentions "hashed SubPlan 1" for this exact subplan name. */
function mentionsHashed(text: string, name: string): boolean {
  return mentionsName(text, `hashed ${name}`);
}

/**
 * Words after which PostgreSQL may skip the rest of an expression: AND and OR
 * stop once the answer is known (and PostgreSQL puts the cheaper tests of a
 * WHERE first, so an expensive subquery usually comes last), and CASE and
 * COALESCE work out only the branch they need.
 */
const SKIPPING_WORDS = ["AND", "OR", "CASE", "COALESCE"];

/**
 * True when `text`, a Filter or an Output, may skip part of itself for a row
 * (see SKIPPING_WORDS), so a subquery in it may run for fewer rows than it
 * reads. The planner's cost ignores that and charges the subquery for every
 * row. A name that is one of these words comes quoted ("case"), which
 * tokenize keeps apart from the word itself.
 */
function maySkipPart(text: string): boolean {
  return tokenize(text).some((token) => SKIPPING_WORDS.some((word) => isWord(token, word)));
}

/**
 * How many rows `step` reads and runs its Filter on, each time it runs, when
 * the plan says: all of its table for a whole-table read (given the table's
 * size from the catalog), every row its bitmap found for a Bitmap Heap Scan
 * (the Bitmap Index Scan, or BitmapAnd / BitmapOr, below it), all of its
 * input's rows for a Subquery Scan. Null otherwise: an index scan reads only
 * what its Index Cond finds, and a join tests its Join Filter only on the
 * pairs its join condition makes, and the plan gives neither count. For a
 * parallel scan it is one process's share, the same unit as its Plan Rows.
 */
function rowsFilterReads(step: PlanStep, children: PlanStep[]): number | null {
  if (step.filter === null) return null;
  // Its one input, whatever subqueries hang off it: a Bitmap Heap Scan's
  // bitmap, a Subquery Scan's subquery.
  const input = joinSides(children)[0];
  if (step.nodeType === "Seq Scan") {
    if (step.tableRows === null) return null;
    if (!step.parallelAware) return step.tableRows;
    return step.shareDivisor === null ? null : step.tableRows / step.shareDivisor;
  }
  if (step.nodeType === "Bitmap Heap Scan") {
    if (input === undefined) return null;
    if (!step.parallelAware) return input.estimatedRows;
    return step.shareDivisor === null ? null : input.estimatedRows / step.shareDivisor;
  }
  if (step.nodeType === "Subquery Scan") {
    return input === undefined ? null : input.estimatedRows;
  }
  return null;
}

/**
 * Work out how often each step runs, and what it costs on its own.
 *
 * PostgreSQL's Total Cost is the cost of ONE run of a step, children
 * included. That hides the classic slow plan: a nested loop repeating an index
 * lookup 5,000 times shows the lookup at a cost of 8, which looks cheap. So
 * each step gets an estimated number of runs, from the shape of the plan:
 *
 *   - the top step runs once;
 *   - an InitPlan (a subquery with no link to the outer row) runs once;
 *   - the repeated ("Inner") side of a Nested Loop runs once per row of the
 *     other ("Outer") side, times however often the loop itself runs;
 *   - a SubPlan (a subquery that refers to the outer row) runs once for each
 *     row its step reads when the step's filter tests it, and once for each
 *     row the step hands on when only its output uses it; unless PostgreSQL
 *     "hashed" it, in which case it ran once and its rows were kept in a
 *     lookup table;
 *   - every other step runs as often as the step above it.
 *
 * Three exceptions, checked on real PostgreSQL 17 plans. A Materialize on
 * the repeated side of a nested loop fills itself once and then replays its
 * rows. So does a Materialize at the top of a SubPlan, PostgreSQL's sign of
 * a subquery that does not refer to the outer row (x > ALL (SELECT …)). A
 * Memoize runs the step below it only for a value it has not seen yet, and
 * answers a repeat from memory. Each time the step's Total Cost is its first
 * run, and the planner charges every later one (the cheap replays, and a
 * Memoize's further lookups) to the step above: the Nested Loop, or the step
 * that tests the subquery. Multiplying them by the outer rows would make a
 * 40-row cache look like the most expensive step, so they count as running
 * once per run of that step, and in an estimate its own cost includes those
 * later runs.
 *
 * Then a step's own cost = its Total Cost over all its runs, minus its
 * children's Total Cost over all of theirs. This is APPROXIMATE: startup and
 * rescan costs are ignored (a rescan is often cheaper than a first run). The
 * rows a filter reads are known only for a whole-table read given the
 * table's size, a bitmap read and a Subquery Scan (see rowsFilterReads);
 * elsewhere a subquery the filter tests is counted for the rows that pass,
 * usually far fewer than it runs for, so the step's own cost comes out too
 * big. The same goes for a subquery inside an aggregate's sum(…): it runs
 * for each row the aggregate reads, but is counted for each group, like one
 * outside sum(…), which does run once for each group. A filter that may skip
 * the subquery (see maySkipPart) is still counted for every row read, as
 * the planner charges it. Good enough to point at the heavy part of a plan;
 * never shown as a number the reader should trust to the digit.
 *
 * Alongside, each step gets `repeated`: whether the shape of the plan runs
 * it again for each row of something above it, whatever its runs are costed
 * at. A Memoize is costed once but asked again for every outer row. And
 * `runsKnown`: false where the count above is only what the planner charges,
 * or the rows handed on standing in for rows read, so it is not shown as how
 * often the step runs. And `runsMayStop` (see runsMayStop): true where the
 * count is only the most the step may run. And `rowsMayStop`, the same for
 * the rows it hands on (see PlanStep.rowsMayStop).
 */
export function estimateRuns(steps: PlanStep[]): void {
  // Built once, because the loop below needs a step's siblings to find the
  // other side of its join, and a subquery's step's input.
  const children = childrenById(steps);

  // Ids go parents-first, so each parent's runs are known before its children.
  for (const step of steps) {
    if (step.parentId === null) {
      step.estimatedRuns = 1;
      step.repeated = false;
      step.runsKnown = true;
      continue;
    }
    const parent = steps[step.parentId];
    // The planner never guesses fewer than one row; a hand-written plan might.
    const parentRows = Math.max(1, parent.estimatedRows);
    // A step below one whose runs are not known cannot know its own. Only a
    // SubPlan learns less than its parent (below); an InitPlan starts afresh.
    step.runsKnown = parent.runsKnown;

    if (step.parentRelationship === "InitPlan") {
      step.estimatedRuns = 1;
      step.repeated = false;
      step.runsKnown = true;
    } else if (step.parentRelationship === "SubPlan") {
      // The "hashed" marker is not on the subquery's own node: PostgreSQL only
      // writes it where the parent uses the result, e.g. "(hashed SubPlan 1)".
      const where = [parent.filter ?? "", parent.output, ...parent.details].join(" ");
      step.hashedSubplan =
        step.subplanName !== null && mentionsHashed(where, step.subplanName);
      if (step.hashedSubplan || step.nodeType === "Materialize") {
        // Runs once per run of its step. Hashed, its rows went into a lookup
        // table. A Materialize on top is PostgreSQL's sign of a subquery that
        // does not use the outer row: filled once and read again for each
        // row, like the one on the repeated side of a nested loop.
        step.estimatedRuns = parent.estimatedRuns;
        step.repeated = step.hashedSubplan ? parent.repeated : true;
      } else {
        const name = step.subplanName;
        const uses = (text: string | null): text is string =>
          text !== null && name !== null && mentionsName(text, name);
        // Where the subquery's answer is used: a filter that tests it (the
        // step's own Filter, or a join's Join Filter), else the output.
        const tests = [parent.filter, detailValue(parent, "Join Filter")].filter(uses);
        const tested = tests.length > 0;
        const read = tested ? rowsFilterReads(parent, children[parent.id]) : null;
        const usedIn: string[] = tested ? tests : uses(parent.output) ? [parent.output] : [];
        // Once for each row read when a filter tests it: what the planner's
        // cost charges, even for a filter that may skip it. Once for each
        // row handed on when only the output uses it, and when the rows read
        // are not known.
        step.estimatedRuns = parent.estimatedRuns * Math.max(parentRows, read ?? 0);
        step.runsKnown =
          parent.runsKnown &&
          usedIn.length > 0 &&
          (!tested || read !== null) &&
          // An aggregate works out a subquery inside sum(…) for each row it
          // reads, and one outside for each group (see estimateRuns).
          parent.nodeType !== "Aggregate" &&
          !usedIn.some(maySkipPart);
        step.repeated = true;
      }
    } else if (parent.nodeType === "Nested Loop" && isInnerSide(step, children[parent.id])) {
      const outer = outerSide(children[parent.id]);
      const outerRows = Math.max(1, outer?.estimatedRows ?? 1);
      step.estimatedRuns =
        step.nodeType === "Materialize" || step.nodeType === "Memoize"
          ? parent.estimatedRuns
          : parent.estimatedRuns * outerRows;
      // A Materialize or Memoize too: each is asked again for every outer
      // row, though only its first run is costed.
      step.repeated = true;
    } else if (parent.nodeType === "Materialize" && parent.parentId !== null) {
      // A Materialize runs the steps below it once and replays their rows,
      // so they repeat only when whatever reads the Materialize repeats.
      step.estimatedRuns = parent.estimatedRuns;
      step.repeated = steps[parent.parentId].repeated;
    } else {
      step.estimatedRuns = parent.estimatedRuns;
      step.repeated = parent.repeated;
    }
  }

  for (const step of steps) {
    const childCost = children[step.id].reduce(
      (sum, child) => sum + child.estimatedCost * child.estimatedRuns,
      0
    );
    // Clamped at zero: the approximations above can take off a little more
    // than the step's total, and a negative cost reads as a bug.
    step.selfCost = Math.max(0, step.estimatedCost * step.estimatedRuns - childCost);
  }

  // Only once the first loop is done: readStop may look at any subquery's
  // hashedSubplan (a WITH query's readers can be anywhere in the plan), and
  // that loop sets each one only when it gets there.
  for (const step of steps) {
    step.runsMayStop = runsMayStop(steps, step);
    // The same test the walk-through makes before it leaves a count out
    // (scanResult, outputStop), so a box and its sentence agree.
    step.rowsMayStop = !readsAllFirst(step) && readStop(steps, step) !== null;
  }
}
