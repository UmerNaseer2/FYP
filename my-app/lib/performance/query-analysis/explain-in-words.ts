// Query analysis: the plan in plain words. This file puts it together.
//
// Holds explainInWords, which orders the steps and names the subqueries, and
// the per step figures and captions the plan tree shows.

import type { PlanStep, PlanSummary } from "./plan-types";
import { childrenById, detailValue, joinSides } from "./plan-helpers";
import { fmtRows, rowsWord } from "./wording";
import { countingOf, mostRowsFound, type Narration, ofStepRows } from "./narration-counting";
import { sentenceFor } from "./narration-steps";

/**
 * A subquery the walk-through is inside: "InitPlan 1", "SubPlan 2", or a
 * WITH query. A subquery runs on its own schedule, not in the main query's
 * order, so the first sentence from it says when it runs, and every later one
 * carries its name so the reader knows it is still inside it.
 */
type SubqueryPart = {
  /** "InitPlan 1", or "The WITH query recent": as the plan's conditions name it. */
  name: string;
  /** ", which runs only once": when it runs, said once, on its first sentence. */
  when: string;
  /** True once a sentence has said `when`. Set by inPart. */
  introduced: boolean;
};

/**
 * The subquery that starts at this step, or null when the step is not the
 * top of one. PostgreSQL marks the top step of each: "InitPlan" for one with
 * no link to the outer row (it runs once), "SubPlan" for one that uses the
 * outer row (it runs for each row, unless PostgreSQL "hashed" it: then it ran
 * once and its rows were kept in a lookup table). A SubPlan with a
 * Materialize on top does not use the outer row, as in x > ALL (SELECT …):
 * it ran once, and its rows are read again for each row. A WITH query that
 * is kept and read back comes as an InitPlan named "CTE <name>".
 */
function partStartedBy(n: Narration, step: PlanStep): SubqueryPart | null {
  if (step.parentId === null) return null;
  const relationship = step.parentRelationship;
  if (relationship !== "InitPlan" && relationship !== "SubPlan") return null;

  const cte = /^CTE (.+)$/.exec(step.subplanName ?? "");
  if (cte !== null) {
    return {
      name: `The WITH query ${cte[1]}`,
      when: ", worked out once and kept for the steps that read it",
      introduced: false,
    };
  }
  const name = step.subplanName ?? "A subquery";
  if (relationship === "InitPlan") {
    // An InitPlan runs again only when a value it takes from an outer query
    // changes (one inside a SubPlan, say). A measured run shows that as more
    // than one loop, and "runs only once" would then be false.
    const loops = step.loops ?? 1;
    return {
      name,
      when: n.measured && loops > 1 ? `, which ran ${fmtRows(loops)} times` : ", which runs only once",
      introduced: false,
    };
  }
  if (step.hashedSubplan) {
    return {
      name,
      when: ", which runs once and keeps its rows in a lookup table",
      introduced: false,
    };
  }
  // A Materialize on top: the subquery does not use the outer row, so it
  // runs once, and the Materialize's own sentence says what its rows are
  // read again for.
  if (step.nodeType === "Materialize") {
    return { name, when: ", which runs only once", introduced: false };
  }
  // The rows it runs for are the rows of the step it hangs off (ofStepRows).
  return {
    name,
    when: `, which runs once for each row${ofStepRows(n.steps[step.parentId])}`,
    introduced: false,
  };
}

/** "Reads …" → "reads …", for a sentence that follows "InitPlan 1: ". */
function lowerFirst(sentence: string): string {
  return /^[A-Z][a-z]/.test(sentence) ? sentence[0].toLowerCase() + sentence.slice(1) : sentence;
}

/** A sentence inside a subquery, with the subquery's name (and, the first time, when it runs). */
function inPart(part: SubqueryPart | null, sentence: string): string {
  if (part === null) return sentence;
  const head = part.introduced ? part.name : `${part.name}${part.when}`;
  part.introduced = true;
  return `${head}: ${lowerFirst(sentence)}`;
}

/** A full stop, unless the sentence already ends in one or in a cut-short "…". */
function asSentence(text: string): string {
  return /[.…]$/.test(text) ? text : `${text}.`;
}

/**
 * The steps directly below `step`, in the order they do their work.
 *
 *   - Subqueries first. An InitPlan runs once and its answer is used below.
 *     A SubPlan runs for each row, and telling it first means the sentence
 *     that uses it ("keeps the rows where (SubPlan 1) > 5") comes after the
 *     one that says what it is. It also keeps a step's own inputs right
 *     before the step, so its "those rows" always means their rows.
 *   - A hash join's Hash side before the side that probes it: the lookup
 *     table is built in full before any row of the other side is matched.
 *   - Everything else in plan order: a nested loop reads its outer side and
 *     repeats its inner side for each of those rows; a merge join reads its
 *     two sorted inputs side by side; an Append reads its parts in turn.
 */
function executionOrder(
  n: Narration,
  step: PlanStep
): { subqueries: PlanStep[]; inputs: PlanStep[] } {
  const kids = n.children[step.id];
  const initPlans = kids.filter((k) => k.parentRelationship === "InitPlan");
  const subPlans = kids.filter((k) => k.parentRelationship === "SubPlan");
  let inputs = joinSides(kids);
  if (step.nodeType === "Hash Join") {
    const hash = inputs.find((k) => k.nodeType === "Hash");
    if (hash !== undefined) inputs = [hash, ...inputs.filter((k) => k !== hash)];
  }
  return { subqueries: [...initPlans, ...subPlans], inputs };
}

/**
 * The plan as a short account in plain words: one sentence for each step
 * that does something, in the order the server does it, with the query's own
 * tables, conditions, row counts and repeat counts filled in.
 *
 * The screen prints the plan top-down, the way EXPLAIN does, which is the
 * reverse of the order it runs in. Reading it bottom-up is a skill a non-DBA
 * does not have: which side of a hash join is built first, that an InitPlan
 * runs once, that a SubPlan runs for every row. This walks the tree children
 * before parents, in the order executionOrder gives, and says each of those
 * things in words.
 *
 * A measured plan gives the counts the run saw; an estimate says "about". A
 * step that only passes rows along (a Gather in the middle of a plan, a Result
 * that only picks columns, the index half of a bitmap scan) gets no sentence:
 * the sentence next to it already covers what it does.
 */
export function explainInWords(summary: PlanSummary): string[] {
  const steps = summary.steps;
  if (steps.length === 0) return [];
  const n: Narration = { steps, children: childrenById(steps), measured: summary.measured };
  const lines: string[] = [];

  function visit(step: PlanStep, part: SubqueryPart | null): void {
    const started = partStartedBy(n, step);
    const mine = started ?? part;
    const neverRan = countingOf(step, n.measured).neverRan;

    if (neverRan && started !== null) {
      // A whole subquery the run never needed: one sentence, by its name.
      lines.push(asSentence(`${started.name} was never needed, so it never ran`));
      return;
    }
    const say = (): void => {
      const sentence = sentenceFor(n, step);
      if (sentence !== null) lines.push(asSentence(inPart(mine, sentence)));
    };
    // Nothing below a step that never started ran either, and sentenceFor
    // covers the whole of it in one sentence.
    if (neverRan) {
      say();
      return;
    }
    const { subqueries, inputs } = executionOrder(n, step);
    for (const child of subqueries) visit(child, mine);
    // A One-Time Filter (a Result guarding its input, e.g. an uncorrelated
    // WHERE EXISTS) is checked before a single input row is read, and when it
    // fails the input never runs. So that step's sentence comes first.
    const checksFirst = detailValue(step, "One-Time Filter") !== null;
    if (checksFirst) say();
    for (const child of inputs) visit(child, mine);
    if (!checksFirst) say();
  }

  visit(steps[0], null);
  return lines;
}

/** What a plan box prints under its label. */
export type StepFigures = {
  /**
   * "1,204 rows", "~1,204 rows (estimate)", "1 row each time", "never ran",
   * or "up to ~1,204 rows (estimate)" when that is only the most (see
   * PlanStep.rowsMayStop).
   */
  rows: string;
  /**
   * "ran 5,000 times", "in 3 processes", "runs ~5,000 times (estimate)", or
   * "runs up to ~5,000 times (estimate)" when that is only the most (see
   * runsMayStop). Null when the step runs once.
   */
  runs: string | null;
};

/**
 * A step's row count and repeat count, worded for the plan tree and the step
 * list. Uses countingOf, the same reading of the numbers the walk-through
 * uses, so a box and its sentence can never disagree about what a count is a
 * count of: a total, one run of a repeated step, or one helper process.
 */
export function stepFigures(step: PlanStep, measured: boolean): StepFigures {
  const c = countingOf(step, measured);
  if (c.neverRan) return { rows: "never ran", runs: null };
  const unit = c.perRun ? " each time" : c.perProcess ? " per process" : "";
  if (c.measured) {
    const runs = fmtRows(c.runs ?? 0);
    // An average PostgreSQL rounded to 0 is not "0 rows": see countOf.
    const rows = !c.underOne
      ? rowsWord(c.rows)
      : c.perRun || c.perProcess
        ? "under 1 row"
        : `at most ${rowsWord(mostRowsFound(c))}`;
    return {
      rows: `${rows}${unit}`,
      runs: c.perRun ? `ran ${runs} times` : c.perProcess ? `in ${runs} processes` : null,
    };
  }
  return {
    rows: `${c.rowsMayStop ? "up to " : ""}~${rowsWord(c.rows)}${unit} (estimate)`,
    // Null when the plan repeats the step but cannot say how often.
    runs:
      c.perRun && c.runs !== null
        ? `runs ${c.runsMayStop ? "up to " : ""}~${fmtRows(c.runs)} times (estimate)`
        : null,
  };
}

/**
 * The caption over the top box of a subquery in the plan tree, e.g.
 * "SubPlan 1: runs once for each row". Null for any other step. Says the
 * same as the walk-through's first sentence for that subquery, shorter.
 */
export function subqueryCaption(step: PlanStep): string | null {
  const relationship = step.parentRelationship;
  if (relationship !== "InitPlan" && relationship !== "SubPlan") return null;
  const cte = /^CTE (.+)$/.exec(step.subplanName ?? "");
  if (cte !== null) return `WITH query ${cte[1]}: worked out once, then kept`;
  const name = step.subplanName ?? "Subquery";
  if (relationship === "InitPlan") {
    // Measured more than once, it takes a value from an outer query (it sits
    // inside a SubPlan, say), and "only once" would be false. The walk-through
    // says the same (partStartedBy).
    const loops = step.loops ?? 1;
    return loops > 1 ? `${name}: ran ${fmtRows(loops)} times` : `${name}: runs only once`;
  }
  if (step.hashedSubplan) return `${name}: runs once, kept as a lookup table`;
  // A Materialize on top: filled once and read again for each row (see
  // estimateRuns). The walk-through says the same (partStartedBy).
  if (step.nodeType === "Materialize") return `${name}: runs once, then read again for each row`;
  return `${name}: runs once for each row`;
}
