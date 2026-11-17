// Query analysis: the plan in plain words. This file holds the scans.
//
// Holds the sentences for reading a table: sequential, index and bitmap
// scans, and why a scan stopped early.

import { LARGE_TABLE_ROWS } from "../sql";
import type { PlanStep } from "./plan-types";
import { detailValue, rowsHandedOn, rowsRemovedByFilter } from "./plan-helpers";
import { andList } from "./wording";
import { readsAllFirst, readStop, type ReadStop, rowsScanned, subtreeOf } from "./plan-walk";
import { readsManyKeepsFew, testsOnlySubqueries } from "./conditions";
import { plainCondition } from "./plain-condition";
import {
  type Counting,
  countOf,
  countPhrase,
  givingClause,
  keepsClause,
  type Narration,
  stepTableRows,
  tableWithAlias,
  unitNote,
} from "./narration-counting";

/**
 * Why a whole-table read that raised no finding is the right plan, when that
 * is the reason: the filter keeps too large a share of a large table for an
 * index to help. Uses readsManyKeepsFew, the very test the whole-table rule
 * uses, so this sentence and that finding can never disagree.
 *
 * Says nothing for a scan that runs many times (the nested-loop rule has its
 * own view of that), one that may stop early (see readStop), an estimate
 * without the table's size, or an estimated parallel scan whose rows cannot
 * be added up across its processes (see rowsHandedOn).
 */
function wholeReadReason(step: PlanStep, c: Counting, stopsEarly: boolean): string {
  if (step.nodeType !== "Seq Scan" || step.filter === null) return "";
  // No index could answer a filter that only tests a subquery, so there is
  // nothing to weigh the whole read against.
  if (testsOnlySubqueries(step.filter)) return "";
  if (stopsEarly || c.perRun) return "";
  if (!c.measured && step.tableRows === null) return "";
  // A share of the whole table, so the rows kept in all, not in one process.
  const kept = rowsHandedOn(step);
  if (kept === null) return "";
  const tableRows = stepTableRows(step);
  const scanned = rowsScanned(step, tableRows);
  if (scanned < LARGE_TABLE_ROWS || readsManyKeepsFew(step, tableRows)) return "";
  const percent = Math.min(100, Math.round((kept / scanned) * 100));
  return percent > 50
    ? `; most of its rows match (about ${percent}%), so an index would not help ` +
        `and reading the whole table is the right plan`
    : `; about ${percent}% of its rows match, too many for an index to help, so ` +
        `reading the whole table is the right plan`;
}

/**
 * What a scan handed on: ", giving 750 rows", or ", and keeps the 312 where
 * …" when it has a filter. An estimate for a scan that may stop early
 * (readStop) gets no count: its Plan Rows are what a full read would find,
 * not what the stopped one will.
 */
function scanResult(step: PlanStep, c: Counting, stopsEarly: boolean): string {
  const cond = step.filter === null ? null : plainCondition(step.filter);
  if (!c.measured && stopsEarly) return cond === null ? "" : `, keeping those where ${cond}`;
  return cond === null ? givingClause(c) : keepsClause(c, cond);
}

/**
 * The unit note after a scan's count. An estimated scan that may stop early
 * has no count (scanResult leaves it out), and "(in each process)" after no
 * number would qualify nothing; "(each time; …)" still says how often it runs.
 */
function scanNote(c: Counting, stopsEarly: boolean): string {
  return !c.measured && stopsEarly && !c.perRun ? "" : unitNote(c);
}

/**
 * scanResult and scanNote together, for a scan whose sentence says nothing of
 * where it may stop: a CTE, function, VALUES, sample, ctid or foreign scan.
 */
export function scanTail(n: Narration, step: PlanStep, c: Counting): string {
  const stopsEarly = readStop(n.steps, step) !== null;
  return scanResult(step, c, stopsEarly) + scanNote(c, stopsEarly);
}

/**
 * The rows a measured scan read: those it handed on and those its filter
 * threw away, in the unit of its count (see countingOf). That is one run or
 * one process when the count is, and otherwise all of them, which for a
 * parallel scan is every process's share added up.
 */
function rowsRead(step: PlanStep, c: Counting): number {
  const perLoop = (step.actualRows ?? 0) + (rowsRemovedByFilter(step) ?? 0);
  return c.perRun || c.perProcess ? perLoop : perLoop * (step.loops ?? 1);
}

/**
 * True when a measured scan read at least as many rows as a full read would
 * find, so nothing stopped it early, whatever might have. `read` is rowsRead.
 * Only a read of the whole table is weighed: a sequential scan, or an index
 * scan with no Index Cond (the table in the index's order). A lookup reads
 * just the rows its condition finds, and how many those are is a guess.
 * A full read finds the table's rows (PlanStep.tableRows, from the catalog)
 * or, with no filter either, its Plan Rows: the planner's own count of the
 * table, which it scales to the table's current size. With both, the larger,
 * so a table grown since its statistics is not called read to the end too
 * soon. With neither, it is never proven.
 */
function readToTheEnd(step: PlanStep, read: number): boolean {
  const wholeTable =
    step.nodeType === "Seq Scan" ||
    ((step.nodeType === "Index Scan" || step.nodeType === "Index Only Scan") &&
      detailValue(step, "Index Cond") === null);
  if (!wholeTable) return false;
  let full = step.tableRows ?? 0;
  // A parallel scan's Plan Rows are one process's share of the table.
  if (step.filter === null && !step.parallelAware) full = Math.max(full, step.estimatedRows);
  return full > 0 && read >= full;
}

/**
 * Why a scan may stop early (readStop), or null when it reads to the end. A
 * measured scan that read to the end (readToTheEnd) was not stopped, whatever
 * might have stopped it, so it gets the plain sentence and its count.
 */
function scanStop(steps: PlanStep[], step: PlanStep, c: Counting): ReadStop | null {
  const stop = readStop(steps, step);
  if (stop !== null && c.measured && readToTheEnd(step, rowsRead(step, c))) return null;
  return stop;
}

/** How a sequential scan says where it may stop: see readStop. */
const SEQ_SCAN_STOP: Record<ReadStop, string> = {
  limit: " until it has enough rows",
  match: " until it finds a match",
  asked: ", only as far as needed",
};

/** How an index or bitmap scan says where it may stop: see readStop. */
const INDEX_SCAN_STOP: Record<ReadStop, string> = {
  limit: ", stopping once it has enough rows",
  match: ", stopping at the first match",
  asked: ", only as far as needed",
};

/**
 * Why an estimate's count for a step that is not a scan would say more than
 * the step will hand on, or null when it would not: its Plan Rows are what a
 * full run hands on, and the run may stop it early (readStop). A step that
 * makes its whole result before it hands any of it on (readsAllFirst: a hash
 * aggregate, say) keeps its count. It does make all of it; a LIMIT above
 * only takes fewer.
 */
export function outputStop(n: Narration, step: PlanStep, c: Counting): ReadStop | null {
  if (c.measured || readsAllFirst(step)) return null;
  return readStop(n.steps, step);
}

/**
 * What a step that is not a scan handed on, and its unit note: ", giving
 * about 1,500 rows", or ", and keeps about 12 rows where …" for one with a
 * filter (`cond`). `noun` is what it hands on: rows, or groups. An estimate
 * the run may stop early (outputStop) has no count, as a scan has none
 * (scanResult): ", stopping once it has enough rows" under a LIMIT, and
 * otherwise ", only as far as needed". The unit note stays, so a step run
 * in each process still says so.
 */
export function outputTail(
  n: Narration,
  step: PlanStep,
  c: Counting,
  cond: string | null,
  noun = "row"
): string {
  const stop = outputStop(n, step, c);
  if (stop === null) {
    return (cond === null ? `, giving ${countOf(c, noun)}` : keepsClause(c, cond)) + unitNote(c);
  }
  // Not ", stopping at the first match" for "match": it is the loop above
  // that moves on at a match, and on a join or a grouping those words would
  // read as the step's own matching ("has no match …, stopping at the first
  // match").
  const where = stop === "limit" ? `, stopping once it has enough ${noun}s` : INDEX_SCAN_STOP.asked;
  return where + (cond === null ? "" : `, keeping those where ${cond}`) + unitNote(c);
}

/**
 * A sequential scan: the whole table, or its start when something above may
 * stop it early (see readStop).
 */
export function seqScanSentence(n: Narration, step: PlanStep, c: Counting): string {
  const where = tableWithAlias(step);
  const stop = scanStop(n.steps, step, c);
  const stopsEarly = stop !== null;

  // Rows read, in the same unit as c.rows. Measured, what was really read.
  // Estimated, only a number that is known rather than guessed: Plan Rows
  // when there is no filter (the scan hands on everything it reads), the
  // catalog's size when there is one. Never for a parallel scan, whose Plan
  // Rows are one process's share, or for a scan that may stop early.
  let read: number | null = null;
  if (c.measured) {
    read = rowsRead(step, c);
  } else if (!stopsEarly && !step.parallelAware) {
    if (step.filter === null) read = step.estimatedRows;
    else if (step.tableRows !== null) read = rowsScanned(step, stepTableRows(step));
  }

  const empty = c.measured && read !== null && Math.round(read) === 0;
  let s: string;
  if (empty) {
    s = `Reads ${where} and finds it empty`;
  } else if (stop !== null) {
    s = `Reads ${where} from the start${SEQ_SCAN_STOP[stop]}`;
    // "in all" only for a total: a count for one run or one process gets its
    // unit from the note at the end.
    if (c.measured && read !== null) {
      s += `, ${countPhrase(read, true)}${c.perRun || c.perProcess ? "" : " in all"}`;
    }
  } else if (c.measured && read !== null) {
    s = Math.round(read) === 1
      ? `Reads the one row of ${where}`
      : `Reads all ${countPhrase(read, true)} of ${where}`;
  } else {
    s = `Reads the whole of ${where}`;
    if (read !== null) s += `, ${countPhrase(read, false)}`;
  }
  if (step.parallelAware) s += ", split between the processes";
  if (step.filter !== null) {
    // An empty table has nothing for a filter to keep.
    if (!empty) s += scanResult(step, c, stopsEarly);
  } else if (read === null && !stopsEarly) {
    // Without a filter the rows handed on are the rows read, counted above,
    // except in an estimated parallel scan, which has no count of rows read.
    // It gets the rows it hands on instead: one process's share.
    s += givingClause(c);
  }
  return s + scanNote(c, stopsEarly) + wholeReadReason(step, c, stopsEarly);
}

/** An index lookup, or a read of the whole table in the index's order. */
export function indexScanSentence(n: Narration, step: PlanStep, c: Counting): string {
  const where = tableWithAlias(step);
  const index = step.indexName === null ? "an index" : `the index ${step.indexName}`;
  const cond = detailValue(step, "Index Cond");
  const indexOnly = step.nodeType === "Index Only Scan";
  const stop = scanStop(n.steps, step, c);

  let s: string;
  if (cond !== null) {
    s = indexOnly
      ? `Looks up the rows of ${where} where ${plainCondition(cond)} in ${index} alone, ` +
        `without reading the table`
      : `Looks up the rows of ${where} where ${plainCondition(cond)}, through ${index}`;
  } else {
    s = indexOnly
      ? `Reads ${index} of ${where} in order, without reading the table`
      : `Reads ${where} in the order of ${index}`;
  }
  if (stop !== null) s += INDEX_SCAN_STOP[stop];
  if (step.parallelAware) s += ", split between the processes";
  s += scanResult(step, c, stop !== null) + scanNote(c, stop !== null);

  // An index-only scan still visits the table for rows on pages changed since
  // the last VACUUM, and every such visit is the cost it exists to avoid.
  const heapFetches = Number(detailValue(step, "Heap Fetches") ?? "0");
  if (indexOnly && heapFetches > 0) {
    s += "; some rows still had to be checked in the table, because it has changed " +
      "since it was last vacuumed";
  }
  return s;
}

/** A bitmap scan: the index finds the rows, then the table is read for just those. */
export function bitmapScanSentence(n: Narration, step: PlanStep, c: Counting): string {
  const where = tableWithAlias(step);
  // More than one index when PostgreSQL combined them (BitmapAnd / BitmapOr).
  const lookups = subtreeOf(n.steps, step).filter((s) => s.nodeType === "Bitmap Index Scan");
  const names = [
    ...new Set(lookups.map((s) => s.indexName).filter((x): x is string => x !== null)),
  ];
  const index =
    names.length === 0
      ? "an index"
      : names.length === 1
        ? `the index ${names[0]}`
        : `the indexes ${andList(names)}`;
  const cond = detailValue(step, "Recheck Cond") ?? lookups[0]?.joinCond ?? null;
  const stop = scanStop(n.steps, step, c);

  let s =
    `Uses ${index} to find the rows of ${where}` +
    (cond === null ? "" : ` where ${plainCondition(cond)}`) +
    ", then reads just those rows from the table";
  if (stop !== null) s += INDEX_SCAN_STOP[stop];
  if (step.parallelAware) s += ", split between the processes";
  return s + scanResult(step, c, stop !== null) + scanNote(c, stop !== null);
}
