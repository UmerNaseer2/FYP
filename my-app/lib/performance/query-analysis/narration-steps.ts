// Query analysis: the plan in plain words. This file holds every other step.
//
// Holds the sentences for joins, aggregates, sorts and the rest, and
// sentenceFor, which picks the right one for a step.

import type { PlanStep } from "./plan-types";
import { detailValue, isInnerSide, joinSides, outerSide } from "./plan-helpers";
import { andList, fmtRows } from "./wording";
import { subtreeOf } from "./plan-walk";
import { plainCondition } from "./plain-condition";
import {
  type Counting,
  countingOf,
  countOf,
  countPhrase,
  cteWithAlias,
  givingClause,
  inputName,
  keepsClause,
  type Narration,
  ofStepRows,
  tableWithAlias,
  unitNote,
} from "./narration-counting";
import {
  bitmapScanSentence,
  indexScanSentence,
  outputStop,
  outputTail,
  scanTail,
  seqScanSentence,
} from "./narration-scans";
import { splitOutputList } from "./sql-context";

/** A join: which rows it pairs up, on what, and what came out. */
function joinSentence(n: Narration, step: PlanStep, c: Counting): string {
  const kids = n.children[step.id];
  const outer = outerSide(kids);
  const inner = joinSides(kids).find((k) => k !== outer);
  const outerName = inputName(n, outer);
  const innerName = inputName(n, inner) ?? "the other input";
  const each = outerName === null ? "each incoming row" : `each row of ${outerName}`;
  const hash = step.nodeType === "Hash Join";

  // What the rows are matched on. A hash or merge join can carry a Join
  // Filter on top of its main condition; a nested loop's Join Filter is its
  // only one (flattenPlan already put it in joinCond).
  const extra = step.nodeType === "Nested Loop" ? null : detailValue(step, "Join Filter");
  const conds = [step.joinCond, extra]
    .filter((x): x is string => x !== null)
    .map(plainCondition);
  const cond = conds.length === 0 ? null : conds.join(" and ");
  const on = cond === null ? "" : hash ? ` on ${cond}` : ` where ${cond}`;
  const matchIn = hash ? "the lookup table" : innerName;

  let s: string;
  switch (step.joinType) {
    case "Semi":
      s = `Keeps ${each} that has a match in ${matchIn}${on}`;
      break;
    case "Anti":
      s = `Keeps ${each} that has no match in ${matchIn}${on}`;
      break;
    // "Right" semi and anti joins keep rows of the second input instead.
    case "Right Semi":
      s = `Keeps each row of ${innerName} that has a match in ${outerName ?? "the incoming rows"}${on}`;
      break;
    case "Right Anti":
      s = `Keeps each row of ${innerName} that has no match in ${outerName ?? "the incoming rows"}${on}`;
      break;
    default:
      s = hash
        ? `Matches ${each} against the lookup table${on}`
        : step.nodeType === "Merge Join"
          ? `Walks the two sorted inputs side by side, pairing ${each} with the rows of ${innerName}${on}`
          : `Pairs ${each} with the matching rows of ${innerName}${on}`;
      if (step.joinType === "Left") {
        s += `, keeping ${outerName === null ? "incoming rows" : `the rows of ${outerName}`} ` +
          `that have no match too`;
      } else if (step.joinType === "Right") {
        s += `, keeping the rows of ${innerName} that have no match too`;
      } else if (step.joinType === "Full") {
        s += ", keeping the rows of both sides that have no match too";
      }
  }
  return s + outputTail(n, step, c, step.filter === null ? null : plainCondition(step.filter));
}

/** "count(*), sum(o.total) and 2 more": a list cut to three for a sentence. */
function shortList(items: string[]): string {
  if (items.length <= 3) return andList(items);
  return `${items.slice(0, 3).join(", ")} and ${items.length - 3} more`;
}

/** The entries of a list detail ("Group Key: a, b") in plain SQL. */
function detailList(step: PlanStep, key: string): string[] {
  const value = detailValue(step, key);
  return value === null ? [] : splitOutputList(value).map(plainCondition);
}

/**
 * Grouping columns as one phrase: "o.status", or "(o.status, o.region)" for
 * several, the way SQL writes a row of values. "by a and b and works out …"
 * would trip over its own "and".
 */
function keysPhrase(keys: string[]): string {
  if (keys.length === 1) return keys[0];
  const shown = keys.length > 3 ? [...keys.slice(0, 3), "…"] : keys;
  return `(${shown.join(", ")})`;
}

/** "count(*) DESC, o.id": a Sort Key in plain SQL, keeping each DESC or NULLS. */
function sortKeys(step: PlanStep): string {
  const value = detailValue(step, "Sort Key");
  if (value === null) return "";
  return splitOutputList(value)
    .map((key) => {
      const m = /^(.*?)((?: (?:ASC|DESC|NULLS FIRST|NULLS LAST))*)$/.exec(key);
      return m === null ? plainCondition(key) : plainCondition(m[1]) + m[2];
    })
    .join(", ");
}

/**
 * An aggregate: GROUP BY, a count, a sum. The aggregates come from the
 * step's Output (VERBOSE only); a plan without it still gets its grouping.
 * A HAVING clause shows up as the step's Filter.
 */
function aggregateSentence(n: Narration, step: PlanStep, c: Counting): string {
  const keys = detailList(step, "Group Key");
  const keySet = new Set(keys);
  // Output lists the grouping columns too; an aggregate is a call, with "(".
  // A partial aggregate prints each one as "PARTIAL count(*)".
  const aggs = splitOutputList(step.output)
    .map((entry) => plainCondition(entry.replace(/^PARTIAL /, "")))
    .filter((entry) => entry.includes("(") && !keySet.has(entry));
  const known = step.output.trim() !== "";
  const what = aggs.length > 0 ? shortList(aggs) : null;
  const by = keysPhrase(keys);
  const having = step.filter === null ? null : plainCondition(step.filter);

  if (step.partialMode === "Partial") {
    // The count per process is not worth a number: the Finalize step above
    // says what the query got.
    const partial = what === null ? "partial totals" : `a partial ${what}`;
    return keys.length > 0
      ? `In each process, groups its share of the rows by ${by} and works out ${partial} ` +
          `for each group`
      : `In each process, works out ${partial} over its share of the rows`;
  }
  if (step.partialMode === "Finalize") {
    let s = `Adds up the processes' partial results into the final ${what ?? "totals"}`;
    if (keys.length > 0) s += ` for each ${by}`;
    // No GROUP BY: one answer, so no count worth giving, and nothing for a
    // LIMIT to stop short.
    if (keys.length === 0) return s + (having === null ? "" : keepsClause(c, having)) + unitNote(c);
    return s + outputTail(n, step, c, having, "group");
  }
  let s: string;
  if (keys.length > 0) {
    if (what !== null) s = `Groups those rows by ${by} and works out ${what} for each group`;
    // No Output to read (a plan without VERBOSE): the aggregates are unknown.
    else if (!known) s = `Groups those rows by ${by}`;
    // Grouping with nothing to work out: a GROUP BY or DISTINCT.
    else s = `Keeps one row for each different ${by}`;
    return s + outputTail(n, step, c, having, what !== null || !known ? "group" : "row");
  }
  // No GROUP BY: one answer over every row, so no count worth giving, and
  // nothing for a LIMIT to stop short.
  s = `Works out ${what ?? "the totals"} over all those rows`;
  if (having !== null) s += keepsClause(c, having);
  return s + unitNote(c);
}

/** A sort, with what the measured run says about memory. */
function sortSentence(step: PlanStep, c: Counting): string {
  const keys = sortKeys(step);
  let s = keys === "" ? "Sorts those rows" : `Sorts those rows by ${keys}`;
  if (step.nodeType === "Incremental Sort") {
    s += ", a batch at a time, because they already arrive partly in that order";
  }
  const method = detailValue(step, "Sort Method") ?? "";
  if (method.startsWith("external")) {
    s += ", spilling to disk because they did not fit in the memory a sort may use (work_mem)";
  } else if (method === "top-N heapsort") {
    s += ", keeping only as many as the LIMIT above needs";
  }
  return s + unitNote(c);
}

/** A cache on the repeated side of a nested loop, with its hit count when measured. */
function memoizeSentence(n: Narration, step: PlanStep): string {
  const s =
    "Remembers the result of each lookup, so a repeated lookup is answered from memory " +
    "instead of being run again";
  // Each Memoize loop is one lookup; the step below runs only on a miss.
  const lookups = step.loops;
  const misses = joinSides(n.children[step.id])[0]?.loops ?? null;
  if (!n.measured || lookups === null || lookups === 0 || misses === null) return s;
  const hits = Math.max(0, lookups - misses);
  return (
    `${s}; ${fmtRows(hits)} of the ${countPhrase(lookups, true, "lookup")} ` +
    `${hits === 1 ? "was" : "were"} answered that way`
  );
}

/**
 * A copy kept to be read again, usually for each row of a nested loop's
 * other side, or of the step a subquery hangs off.
 */
function materializeSentence(n: Narration, step: PlanStep): string {
  const s = "Keeps a copy of those rows, so they can be read again";
  if (step.parentId === null) return s;
  const parent = n.steps[step.parentId];
  // At the top of a subquery (x > ALL (SELECT …)): read again for each row
  // of the step that tests it.
  if (step.parentRelationship === "SubPlan") return `${s} for each row${ofStepRows(parent)}`;
  const siblings = n.children[parent.id];
  if (parent.nodeType !== "Nested Loop" || !isInnerSide(step, siblings)) return s;
  const outerName = inputName(n, outerSide(siblings));
  return `${s} for each row of ${outerName ?? "the other side"}`;
}

/** A Result step: a one-time check, a computed answer, or nothing worth a line. */
function resultSentence(n: Narration, step: PlanStep, c: Counting): string | null {
  const oneTime = detailValue(step, "One-Time Filter");
  if (oneTime !== null) {
    const cond = plainCondition(oneTime);
    if (cond === "false") {
      return "Sees that the query's condition can never be true, so it hands back no rows " +
        "without reading anything";
    }
    // "WHERE EXISTS (…)" with no link to the outer row: an InitPlan answers
    // it. PostgreSQL 17 prints "(InitPlan 1).col1", which plainCondition
    // reads as "InitPlan 1" (its brackets go with the ones around the whole
    // condition); a NOT EXISTS is "NOT (InitPlan 1)".
    const sub = /^(NOT )?\(?((?:Init|Sub)Plan \d+)\)?$/.exec(cond);
    if (sub !== null) {
      const answer = sub[1] === undefined ? "true" : "false";
      return `Checks once that the answer of ${sub[2]} is ${answer}; nothing below runs unless it is`;
    }
    return `Checks once that ${cond} holds; nothing below runs unless it does`;
  }
  const kids = n.children[step.id];
  if (joinSides(kids).length === 0) {
    return kids.length > 0
      ? "Hands back the answer"
      : "Works out the answer without reading any table";
  }
  if (step.filter !== null) {
    return "Takes those rows" + outputTail(n, step, c, plainCondition(step.filter));
  }
  // Only computing the output columns of the step below: not worth a line.
  return null;
}

/** "generate_series(1, 10)": the call a Function Scan makes, or its name. */
function functionName(step: PlanStep): string {
  const call = detailValue(step, "Function Call");
  if (call !== null) return plainCondition(call);
  let name = step.label.replace(/^Function Scan on /, "");
  if (step.alias !== null && name.endsWith(` ${step.alias}`)) {
    name = name.slice(0, -(step.alias.length + 1));
  }
  return name;
}

/** The ModifyTable step of an INSERT, UPDATE, DELETE or MERGE. */
function modifySentence(step: PlanStep): string {
  const where = tableWithAlias(step);
  // labelOf puts the verb first: "Insert on orders".
  const verb = step.label.split(" ")[0];
  if (verb === "Insert") return `Inserts those rows into ${where}`;
  if (verb === "Update") return `Writes the changed rows back to ${where}`;
  if (verb === "Delete") return `Deletes those rows from ${where}`;
  return `Applies the ${verb.toUpperCase()} to ${where}`;
}

/**
 * The sentence for one step, or null when the step only passes rows along
 * and a line for it would be noise (the index half of a bitmap scan, a
 * Gather in the middle of a plan, a Result that only picks columns).
 */
function ownSentence(n: Narration, step: PlanStep, c: Counting): string | null {
  const kids = n.children[step.id];
  switch (step.nodeType) {
    case "Seq Scan":
      return seqScanSentence(n, step, c);
    case "Index Scan":
    case "Index Only Scan":
      return indexScanSentence(n, step, c);
    case "Bitmap Heap Scan":
      return bitmapScanSentence(n, step, c);
    case "Bitmap Index Scan":
    case "BitmapAnd":
    case "BitmapOr":
      return null;
    case "Hash Join":
    case "Nested Loop":
    case "Merge Join":
      return joinSentence(n, step, c);
    case "Hash":
      // Without a parallel hash, every process builds the whole table itself.
      return step.parallelAware
        ? "Builds one shared lookup table from those rows, with the processes working together"
        : step.inParallel
          ? "Each process builds its own lookup table from those rows"
          : "Builds a lookup table from those rows";
    case "Sort":
    case "Incremental Sort":
      return sortSentence(step, c);
    case "Aggregate":
    case "HashAggregate":
    case "GroupAggregate":
      return aggregateSentence(n, step, c);
    case "Group": {
      const keys = detailList(step, "Group Key");
      const each = keys.length > 0 ? `each different ${keysPhrase(keys)}` : "each group";
      return `Keeps one row for ${each}` + outputTail(n, step, c, null);
    }
    case "Limit":
      return c.measured && Math.round(c.rows) === 0 && !c.underOne
        ? "Hands back no rows" + unitNote(c)
        : `Stops after handing back ${countOf(c)}` + unitNote(c);
    case "Unique":
      return "Drops the duplicate rows" + outputTail(n, step, c, null);
    case "Append":
      return `Puts the rows of those ${joinSides(kids).length} parts together, one after another` +
        outputTail(n, step, c, null);
    case "Merge Append":
      return `Merges those ${joinSides(kids).length} sorted parts into one sorted list` +
        outputTail(n, step, c, null);
    case "Materialize":
      return materializeSentence(n, step);
    case "Memoize":
      return memoizeSentence(n, step);
    case "Gather":
      // In the middle of a plan the step above says what it does with the
      // rows. At the top, this is where the query's own count lives.
      return step.parentId === null
        ? "Collects the rows from all the processes" + givingClause(c)
        : null;
    case "Gather Merge":
      return "Merges the processes' sorted rows into one sorted list" + outputTail(n, step, c, null);
    case "Result":
      return resultSentence(n, step, c);
    case "CTE Scan":
      return `Reads the saved result of ${cteWithAlias(step)}` +
        scanTail(n, step, c);
    case "Subquery Scan":
      if (step.filter === null) return null;
      return `Takes the rows of the subquery${step.alias === null ? "" : ` ${step.alias}`}` +
        outputTail(n, step, c, plainCondition(step.filter));
    case "Function Scan":
      return `Reads the rows the function ${functionName(step)} returns` +
        scanTail(n, step, c);
    case "Values Scan":
      return "Reads the rows written in the query's VALUES list" +
        scanTail(n, step, c);
    case "Sample Scan":
      return `Reads a random sample of ${tableWithAlias(step)} (TABLESAMPLE)` +
        scanTail(n, step, c);
    case "Tid Scan":
    case "Tid Range Scan":
      return `Fetches rows of ${tableWithAlias(step)} straight from where they are stored ` +
        `(by ctid)` + scanTail(n, step, c);
    case "Foreign Scan":
      return (step.relation === null
        ? "Fetches rows from another server"
        : `Fetches the rows of the foreign table ${tableWithAlias(step)}`) +
        scanTail(n, step, c);
    case "WindowAgg":
      return "Works out the window functions (the OVER clauses) for each of those rows" +
        unitNote(c);
    case "SetOp":
      return "Compares the rows of the two queries and keeps the ones the INTERSECT or " +
        "EXCEPT asks for" + outputTail(n, step, c, null);
    case "LockRows":
      return "Locks each of those rows as it hands them on (FOR UPDATE or FOR SHARE)";
    case "ProjectSet":
      return "Turns each of those rows into several, for a set-returning function in the " +
        "SELECT list" + outputTail(n, step, c, null);
    case "Recursive Union":
      // Stopped early, it ends when no more rows are wanted, whatever it finds.
      return "Repeats the recursive part of the WITH query until it finds no new rows" +
        (outputStop(n, step, c) === null
          ? outputTail(n, step, c, null)
          : " or no more are needed" + unitNote(c));
    case "WorkTable Scan":
      // Its Filter is what ends the recursion (WHERE n < 10), so it is said.
      return "Reads the rows the previous round of the recursive query found" +
        scanTail(n, step, c);
    case "ModifyTable":
      return modifySentence(step);
    default:
      return `Runs a ${step.nodeType} step` + outputTail(n, step, c, null);
  }
}

/**
 * The sentence for one step, as ownSentence builds it, or null for a step
 * with nothing to add.
 *
 * A step the measured run never started (PostgreSQL's "never executed") is
 * the exception: its counts are all zero, and "reads public.customers and
 * finds it empty" would be false. It gets one sentence for itself and
 * everything below it instead, because nothing below a step that never
 * started ran either. That happens when no row ever needed it: the inner
 * side of a nested loop whose outer side came back empty, the lookup table of
 * a hash join with nothing to match against it, a part a LIMIT never reached.
 */
export function sentenceFor(n: Narration, step: PlanStep): string | null {
  const c = countingOf(step, n.measured);
  if (!c.neverRan) return ownSentence(n, step, c);
  const names = [step, ...subtreeOf(n.steps, step)]
    .map((s) => (s.relation !== null ? tableWithAlias(s) : s.cteName !== null ? cteWithAlias(s) : null))
    .filter((name): name is string => name !== null);
  const unique = [...new Set(names)];
  return unique.length === 0
    ? `Did not need the step ${step.label}, so it never ran`
    : `Did not need to read ${andList(unique)}, so that part of the plan never ran`;
}
