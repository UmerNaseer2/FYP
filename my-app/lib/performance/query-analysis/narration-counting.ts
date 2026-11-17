// Query analysis: the plan in plain words. This file holds the counting.
//
// Holds the Narration and Counting types and the phrases built from them:
// what a step's row count is a count of, and how to say it.

import type { PlanStep } from "./plan-types";
import { joinSides, tableName } from "./plan-helpers";
import { countInWords, fmtRows } from "./wording";
import type { TableRows } from "./catalog";
import { PASS_THROUGH_NODES } from "./plan-walk";

// ── The plan in plain words ──────────────────────────────────────────────────

/** What the sentence builders (narration-*.ts) need besides the step itself. */
export type Narration = {
  steps: PlanStep[];
  /** Every step's direct children, by the parent's id (see childrenById). */
  children: PlanStep[][];
  measured: boolean;
};

/**
 * What one step's row count is a count of. The same number can mean three
 * different things, and a sentence that got it wrong would be off by a
 * factor of a hundred:
 *
 *   - per run, on a step that runs many times (the repeated side of a nested
 *     loop, a subquery run for each row): "60 rows each time; it ran 100 times";
 *   - per helper process, inside a parallel section, where PostgreSQL reports
 *     one process's share (estimated) or the average over them (measured);
 *   - otherwise one total for the whole query.
 */
export type Counting = {
  measured: boolean;
  /** Rows the step handed on, in the unit the two flags below say. */
  rows: number;
  /** The rows are for one run of a step that ran `runs` times. */
  perRun: boolean;
  /**
   * How often the step ran (measured) or is expected to run (estimate). Null
   * when an estimate cannot say: the planner costs the steps below a Memoize
   * as running once (see estimateRuns), though they run again for every
   * value the cache has not seen yet; and a subquery a filter tests runs for
   * each row the filter reads, which the plan may not count (see
   * PlanStep.runsKnown).
   */
  runs: number | null;
  /**
   * An estimate's `runs` is only the most the step may run: something above
   * may stop early, so fewer rows may ask for it (PlanStep.runsMayStop).
   * Always false when measured, where `runs` is what really happened.
   */
  runsMayStop: boolean;
  /**
   * An estimate's `rows` is only the most the step may hand on
   * (PlanStep.rowsMayStop). Always false when measured.
   */
  rowsMayStop: boolean;
  /** The rows are for one helper process. */
  perProcess: boolean;
  /**
   * Measured, the step ran more than once, and its rows show as 0 only
   * because PostgreSQL rounds the average per run to a whole number. A lookup
   * that finds a row one time in ten averages 0.1, shown as 0, so this count
   * must never read "no rows" (see countOf).
   */
  underOne: boolean;
  /** Measured, and the step never started (no rows ever reached it). */
  neverRan: boolean;
};

export function countingOf(step: PlanStep, measured: boolean): Counting {
  if (!measured || step.actualRows === null) {
    const runs = Math.round(step.estimatedRuns);
    return {
      measured: false,
      rows: step.estimatedRows,
      // Plan Rows are for one run. `repeated` also catches a step the plan
      // repeats that estimatedRuns counts once (a Memoize, say): its count is
      // for one run all the same, but how many runs is not known.
      perRun: runs > 1 || step.repeated,
      // Not shown when an estimate cannot say (see PlanStep.runsKnown).
      runs: runs > 1 && step.runsKnown ? runs : null,
      runsMayStop: step.runsMayStop,
      rowsMayStop: step.rowsMayStop,
      // Every estimate below a Gather is for one process: the planner divides
      // a parallel scan's rows between them, and each runs the rest in full.
      perProcess: step.inParallel,
      underOne: false,
      neverRan: false,
    };
  }
  const loops = step.loops ?? 1;
  // Below a Gather, loops also counts the processes that ran the step, so it
  // is a repeat count only on a step the plan's shape repeats (`repeated`:
  // the repeated side of a nested loop, a subquery run for each row, and the
  // steps below them). A parallel scan's loops are its processes, never repeats.
  const perRun = loops > 1 && !step.parallelAware && (!step.inParallel || step.repeated);
  // Measured Actual Rows is an average per loop. For a step each process ran
  // in full (a hash table every process builds for itself), multiplying it
  // by the processes would count the same rows twice, so it stays per process.
  const perProcess = !perRun && step.inParallel && !step.parallelAware && loops > 1;
  return {
    measured: true,
    rows: perRun || perProcess ? step.actualRows : step.actualRows * loops,
    perRun,
    runs: loops,
    runsMayStop: false,
    rowsMayStop: false,
    perProcess,
    underOne: loops > 1 && Math.round(step.actualRows) === 0,
    neverRan: loops === 0,
  };
}

/** "750 rows", "about 1.2 million rows", "no rows": a count in a sentence. */
export function countPhrase(n: number, measured: boolean, noun = "row"): string {
  const rounded = Math.round(n);
  const word = rounded === 1 ? noun : `${noun}s`;
  if (measured) return rounded === 0 ? `no ${noun}s` : `${fmtRows(n)} ${word}`;
  return `about ${countInWords(n)} ${word}`;
}

/**
 * The most rows a step with Counting.underOne can have found in all, when
 * its count is a total: the processes of a parallel scan each averaged at
 * most half a row, so together they found at most half as many rows as
 * there were processes.
 */
export function mostRowsFound(c: Counting): number {
  return Math.floor((c.runs ?? 0) / 2);
}

/**
 * countPhrase for a step's own count. An average PostgreSQL rounded to 0
 * (Counting.underOne) reads "fewer than one row on average", or "at most 1
 * row" for a parallel scan's total: never "no rows".
 */
export function countOf(c: Counting, noun = "row"): string {
  if (!c.underOne) return countPhrase(c.rows, c.measured, noun);
  if (c.perRun || c.perProcess) return `fewer than one ${noun} on average`;
  const most = mostRowsFound(c);
  return `at most ${most} ${most === 1 ? noun : `${noun}s`}`;
}

/** ", giving 750 rows": what a step handed on. */
export function givingClause(c: Counting): string {
  return `, giving ${countOf(c)}`;
}

/** ", and keeps the 312 where …": what a filter let through. */
export function keepsClause(c: Counting, cond: string): string {
  if (!c.measured || c.underOne) return `, and keeps ${countOf(c)} where ${cond}`;
  const kept = Math.round(c.rows);
  if (kept === 0) return `, and no row meets ${cond}`;
  if (kept === 1) return `, and keeps the one row where ${cond}`;
  return `, and keeps the ${fmtRows(kept)} where ${cond}`;
}

/**
 * The note at the end of a sentence saying what its count is a count of.
 * (A step that never ran never gets this far: sentenceFor words it.)
 */
export function unitNote(c: Counting): string {
  if (c.perRun) {
    if (c.measured) return ` (each time; it ran ${fmtRows(c.runs ?? 0)} times)`;
    return c.runs === null
      ? " (each time it runs)"
      : ` (each time; expected to run ${c.runsMayStop ? "up to " : ""}about ` +
          `${countInWords(c.runs)} times${c.perProcess ? " in each process" : ""})`;
  }
  return c.perProcess ? " (in each process)" : "";
}

/** "public.orders (o)": a table as the query named it. */
export function tableWithAlias(step: PlanStep): string {
  const table = tableName(step);
  return step.alias !== null && step.alias !== step.relation ? `${table} (${step.alias})` : table;
}

/** "the WITH query recent (r)". */
export function cteWithAlias(step: PlanStep): string {
  const name = `the WITH query ${step.cteName ?? ""}`.trim();
  return step.alias !== null && step.alias !== step.cteName ? `${name} (${step.alias})` : name;
}

/**
 * " of public.customers (c)": whose rows a subquery hanging off `step` is run
 * or read again for. Empty when the step reads no table or WITH query, rather
 * than a guess at which rows those are.
 */
export function ofStepRows(step: PlanStep): string {
  if (step.relation !== null) return ` of ${tableWithAlias(step)}`;
  if (step.cteName !== null) return ` of ${cteWithAlias(step)}`;
  return "";
}

/** Steps that hand on their one input's rows as they are, for naming a join side. */
export const NAME_PASSES_THROUGH: ReadonlySet<string> = new Set([
  ...PASS_THROUGH_NODES,
  "Gather",
  "Gather Merge",
]);

/**
 * What one side of a join reads, named for a sentence: "public.orders (o)",
 * or "the WITH query recent (r)". Looks down through steps that pass their
 * input's rows on unchanged (a Hash, a Sort, a Gather) and gives up, with
 * null, at one that makes new rows, such as an aggregate: naming the table
 * under it would say the join matches that table's rows, which it does not.
 */
export function inputName(n: Narration, step: PlanStep | undefined): string | null {
  let current = step;
  while (current !== undefined) {
    if (current.relation !== null) return tableWithAlias(current);
    if (current.cteName !== null) return cteWithAlias(current);
    if (!NAME_PASSES_THROUGH.has(current.nodeType)) return null;
    const inputs = joinSides(n.children[current.id]);
    current = inputs.length === 1 ? inputs[0] : undefined;
  }
  return null;
}

/** The one table size a step carries, in the shape readsManyKeepsFew takes. */
export function stepTableRows(step: PlanStep): TableRows {
  if (step.tableRows === null || step.relation === null || step.relationSchema === null) {
    return {};
  }
  return { [`${step.relationSchema}.${step.relation}`]: step.tableRows };
}
