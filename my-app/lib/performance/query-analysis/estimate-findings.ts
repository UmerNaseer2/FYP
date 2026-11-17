// Query analysis: when the planner's row estimate was wrong.
//
// Holds the helpers behind the wrong estimate rule: how far off an estimate
// is (estimateOff), whether a step only inherited the error from its input,
// and what to suggest (estimateAdvice).

import { type FixKind, qualifiedName } from "../sql";
import type { PlanStep } from "./plan-types";
import { detailValue, isInnerSide, joinSides, outerSide } from "./plan-helpers";
import { fmtRows, oneLine } from "./wording";
import { planRelations } from "./catalog";
import { childrenOfStep, hasRunCondition, mayBeCutShort } from "./plan-walk";
import { countingOf, NAME_PASSES_THROUGH } from "./narration-counting";

/**
 * Why an estimate is far off, as a sentence for the finding, and the fix that
 * goes with it, worked out together so the two never disagree. `fewer` says
 * the step produced fewer rows than planned.
 *
 * Most estimates come from table statistics, so a step that reads a table
 * gets the one statement that refreshes them: maintenance, since ANALYZE
 * only samples the table and never blocks other work. Any other step gets
 * the tables its rows come from (stepsFeeding), commented out, as a
 * decision: which one has the stale statistics is a judgement the reader
 * has to make. Some guesses come from no statistics at all, and get a way
 * round the guess instead: the rounds of a recursive WITH query, the rows of
 * each round, and the rows a window step's Run Condition holds back.
 */
export function estimateAdvice(
  steps: PlanStep[],
  step: PlanStep,
  fewer: boolean
): { cause: string; fix: string; fixKind: FixKind } {
  if (step.nodeType === "Recursive Union") {
    return {
      cause:
        "PostgreSQL cannot tell how many rounds a recursive WITH query will take, " +
        "so it always plans for about ten; fresh statistics will not change that.",
      fixKind: "decision",
      fix:
        "-- PostgreSQL plans a recursive WITH query for about ten rounds, whatever\n" +
        "-- the data. If the plan around it is slow, run the WITH query into a\n" +
        "-- temporary table first, run ANALYZE on that table, and read it in the\n" +
        "-- query instead, so the planner starts from the real number of rows.",
    };
  }
  if (step.nodeType === "WorkTable Scan") {
    // PostgreSQL 15 and later: the work table's rows are
    // recursive_worktable_factor times the first part's; before 15 the
    // factor is a fixed 10.
    return {
      cause:
        "PostgreSQL cannot tell how many rows each round of a recursive WITH query " +
        "will find, so it plans for a fixed multiple of the rows it expects the " +
        "query's first part to return (ten; from PostgreSQL 15, the " +
        "recursive_worktable_factor setting); fresh statistics will not change that.",
      fixKind: "decision",
      fix: [
        "-- PostgreSQL plans each round of a recursive WITH query for a fixed",
        "-- multiple of the rows it expects the query's first part (before UNION)",
        "-- to return: ten, which from PostgreSQL 15 is the recursive_worktable_factor",
        "-- setting and before then cannot be changed. If the recursive part's plan",
        "-- is slow, set it nearer the real figure (the rows this step reads each",
        "-- round, divided by the rows the plan expected the first part to return)",
        "-- for this query only, by running the query in a transaction after",
        "--   SET LOCAL recursive_worktable_factor = <figure>;",
        "-- and keep that line if EXPLAIN ANALYZE then shows a faster plan.",
      ].join("\n"),
    };
  }
  if (fewer && hasRunCondition(step)) {
    return {
      cause:
        "PostgreSQL checks this window function's condition as the rows go by (the " +
        "Run Condition line) and hands on no more rows of a window once it fails, " +
        "but it plans the step for every row it reads; fresh statistics will not " +
        "change that.",
      fixKind: "decision",
      fix: [
        "-- PostgreSQL plans this window step for every row it reads, not the fewer",
        "-- its condition (the Run Condition line) lets through, so the steps above",
        "-- it were planned for too many rows. If the plan above it is slow: when",
        "-- the condition is row_number() <= n and the window has no PARTITION BY,",
        "-- write the query as ORDER BY (the window's order) LIMIT n instead, which",
        "-- the planner counts. Otherwise run the windowed query, condition and all,",
        "-- into a temporary table first, run ANALYZE on that table, and read it in",
        "-- the query instead.",
      ].join("\n"),
    };
  }
  if (step.relation !== null) {
    const cause = "Usually this means the table's statistics are stale.";
    return step.relationSchema !== null
      ? {
          cause,
          fixKind: "maintenance",
          fix: `ANALYZE ${qualifiedName(step.relationSchema, step.relation)};`,
        }
      : {
          cause,
          fixKind: "decision",
          fix:
            `-- The plan did not say which schema ${oneLine(step.relation)} is in.\n` +
            `-- Run ANALYZE on that table, with its schema in front.`,
        };
  }
  const feeding = stepsFeeding(steps, step);
  const tables = planRelations(feeding);
  if (tables.names.length === 0) {
    // A plan taken without VERBOSE names its tables but not their schemas.
    if (feeding.some((s) => s.relation !== null)) {
      return {
        cause: "Usually this means the statistics of the tables its rows come from are stale.",
        fixKind: "decision",
        fix:
          "-- The plan did not say which schemas the tables below this step are in.\n" +
          "-- Run ANALYZE on each of them, with its schema in front.",
      };
    }
    return {
      cause:
        "No table statistics are behind this estimate; it comes from the function " +
        "or expression the step reads.",
      fixKind: "decision",
      fix:
        "-- No table's rows reach this step, so there are no table statistics to\n" +
        "-- refresh. Its estimate comes from the function or expression itself. For\n" +
        "-- a set-returning function you wrote, ALTER FUNCTION … ROWS n tells the\n" +
        "-- planner how many rows it returns (it assumes 1,000 otherwise).",
    };
  }
  const analyze = tables.names.map(
    (name, i) => `-- ANALYZE ${oneLine(qualifiedName(tables.schemas[i], name))};`
  );
  // Only a filter makes a CTE Scan's estimate its own: without one it is the
  // WITH query's, which followsOffInput leaves to the WITH query's finding.
  if (step.nodeType === "CTE Scan" && step.filter !== null) {
    return {
      cause:
        "From PostgreSQL 17, a filter on a WITH query's rows is judged by the " +
        "statistics of the tables they come from, so those may be stale; before 17, " +
        "or when it tests a value the WITH query works out, PostgreSQL uses a fixed " +
        "guess that fresh statistics will not change.",
      fixKind: "decision",
      fix: [
        `-- This step filters the rows of the WITH query ${oneLine(step.cteName ?? "")}, which`,
        "-- come from these tables. From PostgreSQL 17 the planner judges a filter",
        "-- on their own columns by their statistics, so refresh those of whichever",
        "-- changed most recently, then analyse again:",
        ...analyze,
        "-- Before 17, or for a value the WITH query works out (a count, a sum), it",
        "-- uses a fixed guess instead, which no statistics change. If the plan",
        "-- above this step is slow, run the WITH query into a temporary table, run",
        "-- ANALYZE on that table, and read it in the query instead.",
      ].join("\n"),
    };
  }
  return {
    cause:
      "Usually this means the statistics of the tables its rows come from are stale" +
      (step.filter !== null
        ? "; if its filter tests a value the query works out (a count, a sum, a " +
          "window function), PostgreSQL has no statistics for that value and uses a " +
          "fixed guess."
        : "."),
    fixKind: "decision",
    fix: [
      "-- This step's rows come from these tables. Refresh the statistics of",
      "-- whichever changed most recently, then analyse again:",
      ...analyze,
      ...(step.filter !== null
        ? [
            "-- A filter on a value the query works out (a count, a sum) uses a",
            "-- fixed guess instead, which fresh statistics will not change.",
          ]
        : []),
    ].join("\n"),
  };
}

/**
 * A measured step's planned and actual rows, counted the same way so the
 * estimate-off rule can compare them, and the words that say how. PostgreSQL
 * gives both per loop, which is right for a step that ran once, one that ran
 * again and again (" each time it ran (40 times)"), and one each helper
 * process ran for itself (" in each of the 3 processes"). A parallel scan's
 * loops are the processes that shared one read, though, and the planner's
 * share for one process (Plan Rows: its total over shareDivisor, 2.4 for two
 * helpers) is not what each process really read (Actual Rows: the total over
 * the loops, 3 for two helpers and the main process). So both are added back
 * up to totals when shareDivisor is known. Null before the step was run.
 */
function estimateAgainstRun(
  step: PlanStep
): { planned: number; actual: number; unit: string } | null {
  if (step.actualRows === null) return null;
  const loops = step.loops ?? 1;
  if (loops > 1 && step.parallelAware && step.shareDivisor !== null) {
    return {
      planned: step.estimatedRows * step.shareDivisor,
      actual: step.actualRows * loops,
      unit: `, split between ${fmtRows(loops)} processes`,
    };
  }
  // Below a Gather, loops count processes as well as repeats; countingOf
  // tells the two apart.
  const unit = countingOf(step, true).perRun
    ? ` each time it ran (${fmtRows(loops)} times)`
    : loops > 1
      ? ` in each of the ${fmtRows(loops)} processes`
      : "";
  return { planned: step.estimatedRows, actual: step.actualRows, unit };
}

/**
 * True for the second side of a merge join, whose measured rows may count
 * some rows more than once. When several rows of the first side share a key,
 * the join goes back to the second side's first row with that key for each
 * of them, and PostgreSQL counts every row it reads again: on PostgreSQL 17,
 * a Sort planned for 10,000 rows counted 99,991 with ten rows to each key on
 * both sides. The join never goes back when it needs only the first match for
 * each row (a Semi or Anti join, or Inner Unique) and every condition of the
 * join is part of the merge (no Join Filter or Filter). Only the step
 * directly below the join is read again; the steps under it are read once.
 */
function mergeRereadsInner(steps: PlanStep[], step: PlanStep): boolean {
  if (step.parentId === null) return false;
  const join = steps[step.parentId];
  if (join.nodeType !== "Merge Join" || !isInnerSide(step, childrenOfStep(steps, join))) {
    return false;
  }
  const firstMatch = join.joinType === "Semi" || join.joinType === "Anti" || join.innerUnique;
  const allMerged = detailValue(join, "Join Filter") === null && join.filter === null;
  return !(firstMatch && allMerged);
}

/**
 * The estimate-off rule's test: a measured step's planned and actual rows,
 * counted as estimateAgainstRun counts them, when they are ten times or more
 * apart with at least 100 rows seen; else null. Left out, because the run
 * can differ from the plan there without the estimate being wrong:
 * - fewer rows than planned from a step the run may have stopped early
 *   (mayBeCutShort), or one PostgreSQL skipped part of while it ran
 *   (skippedPlannedRows);
 * - more rows than planned from the second side of a merge join, which may
 *   count rows twice (mergeRereadsInner);
 * - a Bitmap Index Scan, whose count is not always rows: BRIN reports ten for
 *   every page it matches (1,280 against 101 real rows on PostgreSQL 17), and
 *   GIN can count a whole page as one. The Bitmap Heap Scan above it counts
 *   real rows, so that is the step judged.
 */
export function estimateOff(
  steps: PlanStep[],
  step: PlanStep
): { planned: number; actual: number; unit: string; ratio: number } | null {
  if (step.nodeType === "Bitmap Index Scan") return null;
  const estimate = estimateAgainstRun(step);
  if (estimate === null) return null;
  const { planned, actual } = estimate;
  if (actual < 100 || planned <= 0) return null;
  const ratio = actual > planned ? actual / planned : planned / actual;
  if (ratio < 10) return null;
  if (actual < planned && (mayBeCutShort(steps, step) || skippedPlannedRows(steps, step))) {
    return null;
  }
  if (actual > planned && mergeRereadsInner(steps, step)) return null;
  return { ...estimate, ratio };
}

/**
 * True when PostgreSQL skipped part of what this step's Plan Rows count, for
 * a reason the planner could not know, so fewer rows than planned say nothing
 * about the estimate. The parts that did run are still judged on their own.
 * - An Append or Merge Append left out partitions it ruled out once the run
 *   knew a value the planner did not. "Subplans Removed" counts those left
 *   out as the run started (for a prepared statement's parameter, or now());
 *   one ruled out later, by a subquery's result or the row a nested loop is
 *   on, never ran, or ran fewer times than the Append. On PostgreSQL 17,
 *   WHERE city = (SELECT 3) over 20 partitions was planned for 40,000 rows
 *   and read 2,000, from the one partition that ran.
 * - A One-Time Filter, a condition on no column such as
 *   current_setting('app.kind') = 'x', turned out false, so the step below
 *   it never ran (or ran fewer times). The planner counts such a condition
 *   as always true: on PostgreSQL 17, a UNION ALL of two tables behind two
 *   such conditions was planned for 320,000 rows and gave the 20,000 of the
 *   one whose condition held.
 * - The step's rows are only its inputs' rows (echoedInputs), and one of
 *   them was skipped in part, e.g. a Sort of such an Append.
 */
function skippedPlannedRows(
  steps: PlanStep[],
  step: PlanStep,
  seen = new Set<number>()
): boolean {
  // PostgreSQL never has a WITH query read itself through a CTE Scan, but a
  // pasted plan could claim one; `seen` keeps that from going round forever.
  if (seen.has(step.id)) return false;
  seen.add(step.id);
  const loops = step.loops ?? 1;
  const inputs = joinSides(childrenOfStep(steps, step));
  if (step.nodeType === "Append" || step.nodeType === "Merge Append") {
    if (detailValue(step, "Subplans Removed") !== null) return true;
    // A Parallel Append shares its parts out between the processes, so a
    // part fewer processes ran was not skipped; only one none ran was.
    const skipped = inputs.some((part) =>
      step.parallelAware ? part.loops === 0 : (part.loops ?? loops) < loops
    );
    if (skipped) return true;
  }
  if (
    detailValue(step, "One-Time Filter") !== null &&
    inputs.some((input) => (input.loops ?? loops) < loops)
  ) {
    return true;
  }
  return echoedInputs(steps, step).some((input) => skippedPlannedRows(steps, input, seen));
}

/**
 * The WITH query a CTE Scan or a WorkTable Scan reads: the step PostgreSQL
 * names "CTE <name>", a Recursive Union for a WorkTable Scan. Null when there
 * is none, or more than one of that name in different parts of the query,
 * which cannot be told apart.
 */
function cteBodyOf(steps: PlanStep[], step: PlanStep): PlanStep | null {
  if (step.cteName === null) return null;
  const bodies = steps.filter((s) => s.subplanName === `CTE ${step.cteName}`);
  return bodies.length === 1 ? bodies[0] : null;
}

/**
 * The steps whose estimates this step's is worked out from, so that when one
 * of them is far off, this one is too, for no reason of its own:
 * - a CTE Scan: the WITH query it reads;
 * - a WorkTable Scan: the first part (before UNION) of its recursive WITH
 *   query, since each round is planned for a multiple of that part's rows;
 * - an Append, a Merge Append or a Recursive Union: every part it adds up
 *   (a Recursive Union's own guess, the number of rounds, is judged when
 *   neither part is off);
 * - a Subquery Scan, a Limit, a Result, a window step, a LockRows, or a step
 *   that only sorts, hashes, keeps or gathers its input's rows
 *   (NAME_PASSES_THROUGH): its one input.
 * A filter on the step adds a guess of its own, which followsOffInput still
 * judges when the input is off the other way. Empty for every other step.
 */
function echoedInputs(steps: PlanStep[], step: PlanStep): PlanStep[] {
  if (step.nodeType === "CTE Scan") {
    const body = cteBodyOf(steps, step);
    return body === null ? [] : [body];
  }
  if (step.nodeType === "WorkTable Scan") {
    const union = cteBodyOf(steps, step);
    if (union === null || union.nodeType !== "Recursive Union") return [];
    const first = outerSide(childrenOfStep(steps, union));
    return first === undefined ? [] : [first];
  }
  const inputs = joinSides(childrenOfStep(steps, step));
  if (
    step.nodeType === "Append" ||
    step.nodeType === "Merge Append" ||
    step.nodeType === "Recursive Union"
  ) {
    return inputs;
  }
  const handsOn =
    step.nodeType === "Subquery Scan" ||
    step.nodeType === "Limit" ||
    step.nodeType === "Result" ||
    step.nodeType === "WindowAgg" ||
    step.nodeType === "LockRows" ||
    NAME_PASSES_THROUGH.has(step.nodeType);
  return handsOn && inputs.length === 1 ? inputs : [];
}

/**
 * True when a far-off estimate follows from one of the step's inputs
 * (echoedInputs) that is off the same way, too many rows or too few, so the
 * input's finding already covers it. An input off the other way leaves the
 * step's own guess (its filter's, say) to blame, so the step is reported.
 */
export function followsOffInput(
  steps: PlanStep[],
  step: PlanStep,
  estimate: { planned: number; actual: number }
): boolean {
  const more = estimate.actual > estimate.planned;
  return echoedInputs(steps, step).some((input) => {
    const off = estimateOff(steps, input);
    return off !== null && (off.actual > off.planned) === more;
  });
}

/**
 * The steps a step's rows come from, for naming their tables: the step
 * itself and, going down, the sides of every join and the parts of every
 * Append, plus the WITH query a CTE Scan or a WorkTable Scan reads. A
 * subquery that only hands a value to a condition (an InitPlan or a SubPlan
 * that is not a WITH query) is left out. Each step appears once.
 */
function stepsFeeding(steps: PlanStep[], step: PlanStep): PlanStep[] {
  const feeding: PlanStep[] = [step];
  const added = new Set<number>([step.id]);
  for (let i = 0; i < feeding.length; i += 1) {
    const current = feeding[i];
    const next = joinSides(childrenOfStep(steps, current));
    const readsWith = current.nodeType === "CTE Scan" || current.nodeType === "WorkTable Scan";
    const body = readsWith ? cteBodyOf(steps, current) : null;
    if (body !== null) next.push(body);
    for (const s of next) {
      if (added.has(s.id)) continue;
      added.add(s.id);
      feeding.push(s);
    }
  }
  return feeding;
}
