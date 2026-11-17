// Query analysis: the rules that read the plan.
//
// Holds planFindings, one long function with a rule per problem a plan can
// show. readPlan calls it.

import {
  createIndexSql,
  type FixKind,
  type IndexStatement,
  LARGE_TABLE_ROWS,
  qualifiedName,
} from "../sql";
import type { QueryFinding } from "./findings";
import type { PlanStep } from "./plan-types";
import {
  detailValue,
  rowsHandedOn,
  rowsRemovedByFilter,
  tableName,
  totalActualRows,
} from "./plan-helpers";
import { asCommentLine, columnsPhrase, fmtRows, oneLine, rowsWord } from "./wording";
import type { PlanCatalog } from "./catalog";
import {
  childrenOfStep,
  INDEX_SCANS,
  readStop,
  rowsScanned,
  subtreeOf,
  unwrapScan,
} from "./plan-walk";
import {
  columnTypesFor,
  filterColumns,
  INDEX_ON_WHAT,
  JOIN_OUTPUT_SHARE,
  JOIN_SMALL_SIDE_SHARE,
  readsManyKeepsFew,
  testsOnlySubqueries,
} from "./conditions";
import { lossyBitmapFix, sortSpillFix } from "./memory-fixes";
import { estimateAdvice, estimateOff, followsOffInput } from "./estimate-findings";
import { countingOf } from "./narration-counting";

/**
 * Rules that read the plan. Ordered as they are written, sorted on the way out.
 *
 * `catalog` is whatever the route managed to read about the plan's tables.
 * Every rule works without it, just less sharply.
 */
export function planFindings(
  steps: PlanStep[],
  measured: boolean,
  catalog: Partial<PlanCatalog>
): QueryFinding[] {
  const tableRows = catalog.tableRows ?? {};
  const out: QueryFinding[] = [];

  // Steps a finding has already covered. The scan a slow nested loop repeats
  // is the loop's problem, and one finding with one fix reads better than two
  // suggesting the same index.
  const covered = new Set<number>();

  // Index names handed out in this report, per schema, on top of every name
  // the schema already uses, so two suggestions never share a name. The same
  // suggestion twice (same table, same columns) is one index and keeps one.
  const suggestions = new Map<string, IndexStatement>();
  const takenNames = new Map<string, string[]>();
  function suggestIndex(schema: string, table: string, columns: string[]): IndexStatement {
    const key = JSON.stringify([schema, table, columns]);
    const earlier = suggestions.get(key);
    if (earlier) return earlier;
    const taken = takenNames.get(schema) ?? [...(catalog.relationNames?.[schema] ?? [])];
    const statement = createIndexSql(schema, table, columns, taken);
    taken.push(statement.name);
    takenNames.set(schema, taken);
    suggestions.set(key, statement);
    return statement;
  }

  /**
   * The fix for "this step reads a whole table", given the conditions it
   * searches by:
   *   • change       a named CREATE INDEX on the columns read off the
   *                  conditions, with the DROP INDEX that undoes it and the
   *                  schema it goes in (the table's own);
   *   • maintenance  ANALYZE, when a usable index on the first of those
   *                  columns already exists and the planner passed it over,
   *                  which usually means its statistics are stale;
   *   • decision     `fallback` (comments only), when no column can be read
   *                  off the conditions or the plan gave no schema.
   */
  function indexAdvice(
    step: PlanStep,
    conditions: (string | null)[],
    fallback: string
  ): { columns: string[]; fix: string; fixKind: FixKind; undo?: string; schemas?: string[] } {
    const schema = step.relationSchema;
    const table = step.relation;
    if (schema === null || table === null) {
      return { columns: [], fix: fallback, fixKind: "decision" };
    }

    const types = columnTypesFor(catalog, schema, table);
    const columns: string[] = [];
    let range: string | null = null;
    for (const condition of conditions) {
      if (condition === null) continue;
      const found = filterColumns(condition, step.alias, table, types);
      if (found === null) continue;
      for (const column of found.equality) {
        if (!columns.includes(column)) columns.push(column);
      }
      range ??= found.range;
    }
    // Equality columns first, the one range column last: see filterColumns.
    if (range !== null && !columns.includes(range)) columns.push(range);
    if (columns.length === 0) return { columns, fix: fallback, fixKind: "decision" };

    const tableIndexes = catalog.indexes?.[`${schema}.${table}`] ?? [];
    const existing = tableIndexes.find(
      (index) => index.valid && index.columns[0] === columns[0]
    );

    // An index on the same column that is marked invalid is one the planner
    // cannot use, usually left behind by a CREATE INDEX CONCURRENTLY that
    // failed. It still slows every write, and a reader who sees it in the
    // table's index list would wonder why the advice ignores it, so one
    // sentence names it and says what clears it.
    const invalid = tableIndexes.find(
      (index) => !index.valid && index.columns[0] === columns[0]
    );
    const invalidName = invalid ? oneLine(qualifiedName(schema, invalid.name)) : "";
    const invalidNote = invalid
      ? `-- The index ${oneLine(invalid.name)} on ${oneLine(columns[0])} is marked invalid, so the\n` +
        `-- planner cannot use it (a CREATE INDEX CONCURRENTLY that failed, or is\n` +
        `-- still running, leaves it that way); REINDEX INDEX ${invalidName};\n` +
        `-- or DROP INDEX ${invalidName}; clears it.`
      : "";

    if (existing) {
      return {
        columns,
        fixKind: "maintenance",
        fix:
          `-- The index ${oneLine(existing.name)} already starts with ${oneLine(columns[0])},\n` +
          `-- yet the planner read the whole table. Stale statistics are the usual\n` +
          `-- reason. Refreshing them only samples the table and blocks nothing:\n` +
          `ANALYZE ${qualifiedName(schema, table)};\n` +
          `-- If the plan is the same afterwards, that index does not narrow this\n` +
          `-- search enough for the planner to prefer it.` +
          (invalid ? `\n${invalidNote}` : ""),
      };
    }

    const index = suggestIndex(schema, table, columns);
    return {
      columns,
      fixKind: "change",
      fix:
        // Before the CREATE INDEX, so the reader can choose to repair the
        // broken index rather than add a second one.
        (invalid ? `${invalidNote}\n` : "") +
        `-- With this index the server can find the matching rows of\n` +
        `-- ${oneLine(tableName(step))} without reading the whole table. Build it, then analyse again.\n` +
        index.sql,
      undo: index.undo,
      schemas: [schema],
    };
  }

  for (const step of steps) {
    // Per-loop and total counts are kept apart on purpose. PostgreSQL reports
    // Actual Rows, Plan Rows and Rows Removed by Filter per loop, so a rule
    // comparing two of them compares per-loop values, and a rule saying "how
    // much work" multiplies by the loops.
    const loops = step.loops ?? 1;
    const actualTotal = totalActualRows(step);
    const removedPerLoop = rowsRemovedByFilter(step);

    // ── A sequential scan with a filter, over a large table ──
    // Without a filter the query is asking for the whole table and no index
    // can help, so there is nothing to say here (the text rules can still
    // comment on a missing WHERE). Nor can one when the filter only tests a
    // subquery's result: see testsOnlySubqueries.
    if (
      step.nodeType === "Seq Scan" &&
      step.filter !== null &&
      !covered.has(step.id) &&
      !testsOnlySubqueries(step.filter)
    ) {
      const table = tableName(step);
      const scanned = rowsScanned(step, tableRows);
      // In all, as readsManyKeepsFew counts it: an estimated parallel scan's
      // Plan Rows are only one process's share.
      const kept = rowsHandedOn(step) ?? step.estimatedRows;
      const removedTotal = removedPerLoop === null ? null : removedPerLoop * loops;

      // Only a filter that keeps a small share of the table is worth an
      // index. One that keeps most of it needs most of the table read
      // whatever indexes exist, so the whole-table read is the right plan.
      if (readsManyKeepsFew(step, tableRows)) {
        // Only an estimate can be wrong about stopping early. A measured plan
        // already counted exactly what was read. And only a LIMIT's stop, the
        // one the detail below names, makes it less serious (see readStop).
        const limited = !measured && readStop(steps, step) === "limit";
        // A decision, not a statement, when the columns cannot be read off
        // the filter: an unfinished CREATE INDEX would be a placeholder
        // dressed up as runnable SQL.
        const advice = indexAdvice(
          step,
          [step.filter],
          `-- Decide whether to index what this filter compares:\n` +
            `${asCommentLine(step.filter)}\n` +
            INDEX_ON_WHAT +
            `-- With one, the server can jump straight to the rows it needs\n` +
            `-- instead of reading all of ${oneLine(table)}. Then analyse again.`
        );
        out.push({
          id: `seq-scan:${step.id}`,
          stepId: step.id,
          severity: limited ? "medium" : "high",
          title:
            advice.fixKind === "change"
              ? `Index ${columnsPhrase(advice.columns)}`
              : advice.fixKind === "maintenance"
                ? `Whole table read, though an index on ${advice.columns[0]} exists`
                : "Whole table read to answer this",
          object: table,
          detail:
            `Step ${step.id + 1} reads ${fmtRows(scanned)} rows out of ${table} one ` +
            `after another, with no index involved. ` +
            (removedTotal !== null
              ? `${fmtRows(removedTotal)} of them are thrown away again immediately, ` +
                `having been read only to fail the filter. `
              : scanned - kept >= kept && scanned > kept
                ? `Only about ${rowsWord(kept)} ${Math.round(kept) === 1 ? "is" : "are"} ` +
                  `expected to match, so most of the reading is thrown away. `
                : "") +
            (limited
              ? `A LIMIT above this step may stop the read early, so the real cost ` +
                `can be lower; tick Run it and measure to see how much is actually read. `
              : "") +
            `Reading every row is cheap below roughly ${fmtRows(LARGE_TABLE_ROWS)} rows, ` +
            `but the cost grows with the number of rows read.`,
          fix: advice.fix,
          fixKind: advice.fixKind,
          undo: advice.undo,
          schemas: advice.schemas,
        });
      }
    }

    // ── An index scan whose extra filter throws most rows away ──
    // A sequential scan is covered above, index and all. Here an index WAS
    // used, but it only narrows the search by some of the conditions, and the
    // rest are checked row by row after each row is fetched from the table.
    if (
      measured &&
      INDEX_SCANS.has(step.nodeType) &&
      removedPerLoop !== null &&
      step.actualRows !== null &&
      removedPerLoop > step.actualRows * 10 &&
      removedPerLoop * loops >= 1000
    ) {
      const indexCond = step.joinCond ?? detailValue(step, "Recheck Cond");
      // Both counts are per loop. A parallel scan's loops are the processes
      // that shared one read, so its counts are added up into totals. A step
      // run again and again, or by each process for itself, is counted one
      // run at a time, with the total thrown away beside it (see countingOf).
      const shared = loops > 1 && step.parallelAware;
      const counted = (perLoop: number) => fmtRows(shared ? perLoop * loops : perLoop);
      const thrownAway = `${fmtRows(removedPerLoop * loops)} thrown away in all`;
      const counting = countingOf(step, true);
      const runs = shared
        ? `, split between ${fmtRows(loops)} processes`
        : counting.perRun
          ? `, each time it ran (${fmtRows(loops)} times, ${thrownAway})`
          : counting.perProcess
            ? ` in each of the ${fmtRows(loops)} processes (${thrownAway})`
            : "";
      out.push({
        id: `wasteful-filter:${step.id}`,
        stepId: step.id,
        severity: "high",
        title: "The index finds rows the filter then throws away",
        object: step.label,
        detail:
          `Step ${step.id + 1} used an index, then fetched ` +
          `${counted(removedPerLoop + step.actualRows)} rows from the table and kept ` +
          `${counted(step.actualRows)}${runs}. The index matches only part of the ` +
          `condition; the rest is checked one row at a time after each row has ` +
          `been read. An index that also covers the filtered columns would skip ` +
          `those rows without reading them.`,
        fix:
          (indexCond !== null
            ? `-- The index finds rows by:\n${asCommentLine(indexCond)}\n`
            : "") +
          `-- and then this filter throws most of them away:\n` +
          `${asCommentLine(step.filter ?? "(the filter on the plan line above)")}\n` +
          `-- Decide whether an index that also covers the filtered column(s)\n` +
          `-- is worth its upkeep for this query, then analyse again.`,
        // A decision: which columns to add, and whether the extra index is
        // worth slowing every write for, depends on the other queries too.
        fixKind: "decision",
      });
    }

    // ── The planner's estimate is out by an order of magnitude ──
    // The planner chooses a plan from its estimates. When one is out by ten
    // times or more, the plan was chosen for a query that does not exist, and
    // no amount of indexing fixes that — the statistics usually do.
    //
    // estimateOff counts both numbers the same way: per loop, so a 1-row
    // lookup repeated a thousand times is a correct estimate of 1, not one
    // out by a thousand; and in all for a parallel scan. It leaves out a step
    // the run only stopped early, skipped part of or read twice. A step whose
    // estimate follows from its inputs' (a Hash, a Gather, a CTE Scan, an
    // Append, …) is reported only when none of them is off the same way: one
    // wrong estimate, one finding.
    const estimate = measured ? estimateOff(steps, step) : null;
    if (estimate !== null && !followsOffInput(steps, step, estimate)) {
      const { planned, actual, ratio } = estimate;
      const advice = estimateAdvice(steps, step, actual < planned);
      out.push({
        id: `estimate-off:${step.id}`,
        stepId: step.id,
        severity: "medium",
        title: "The planner's row estimate is far off",
        object: step.label,
        detail:
          `Step ${step.id + 1} was planned for ${rowsWord(planned)} and ` +
          `produced ${fmtRows(actual)}${estimate.unit}` +
          ` — out by about ${Math.round(ratio)}×. Everything above this step was ` +
          `planned around the wrong number, so the join order and join methods may ` +
          `be wrong too. ${advice.cause}`,
        fix: advice.fix,
        fixKind: advice.fixKind,
      });
    }

    // ── A sort that did not fit in memory and wrote to temporary files ──
    const sortMethod = detailValue(step, "Sort Method");
    if (sortMethod !== null && /external/i.test(sortMethod)) {
      out.push({
        id: `sort-on-disk:${step.id}`,
        stepId: step.id,
        severity: "medium",
        title: "The sort ran out of memory and used the disk",
        object: step.label,
        detail:
          `Step ${step.id + 1} reports "${sortMethod}", which means the rows did not ` +
          `fit in the memory one sort may use (the work_mem setting) and were written ` +
          `to temporary files. Sorting on disk is far slower than sorting in memory.`,
        fix: sortSpillFix(sortMethod, detailValue(step, "Sort Key")),
        // A decision: more memory for one query is a trade against memory for
        // every other connection, and only the reader knows the server's load.
        fixKind: "decision",
      });
    }

    // ── A nested loop that re-reads a whole table on every pass ──
    // A nested loop searches its Inner side once per outer row. An index scan
    // there, run ten thousand times, is the join working as designed: each
    // search is a quick lookup. A sequential scan there reads the whole inner
    // table every time, and that is the accidental rows × rows.
    if (measured && step.nodeType === "Nested Loop") {
      const children = childrenOfStep(steps, step);
      const inner = children.find((c) => c.parentRelationship === "Inner") ?? children[1];
      const repeated = inner
        ? [inner, ...subtreeOf(steps, inner)].find(
            (s) => s.nodeType === "Seq Scan" && (s.loops ?? 1) >= 1000
          )
        : undefined;
      if (repeated) {
        const table = tableName(repeated);
        // In a nested loop the join condition usually sits on the inner scan
        // as its Filter; otherwise on the loop itself as a Join Filter.
        const cond = repeated.filter ?? step.joinCond;
        // This finding explains the repeated scan, so the whole-table rule
        // above leaves it alone rather than suggesting the same index again.
        covered.add(repeated.id);
        const advice = indexAdvice(
          repeated,
          [repeated.filter, step.joinCond],
          `-- Each repeated search reads ${oneLine(table)} in full. An index on\n` +
            `-- what this join matches on would turn every search into a quick lookup` +
            (cond !== null ? `:\n${asCommentLine(cond)}\n` + INDEX_ON_WHAT : `.\n`) +
            `-- Decide whether to add one, then analyse again.`
        );
        out.push({
          id: `nested-loop:${step.id}`,
          stepId: step.id,
          severity: "medium",
          title: "One side of this join is read in full, thousands of times",
          object: step.label,
          detail:
            `Step ${step.id + 1} searches ${table} once for every row from the other ` +
            `side, and it did so ${fmtRows(repeated.loops ?? 0)} times. Each search ` +
            `reads ${table} from start to finish, with no index involved, so the ` +
            `work is the rows on one side times the rows on the other.`,
          fix: advice.fix,
          fixKind: advice.fixKind,
          undo: advice.undo,
          schemas: advice.schemas,
        });
      }
    }

    // ── A hash or merge join that reads a big table to match a few rows ──
    // Both of these joins read each side in full. That is right when both
    // sides are big. When one side is a handful of rows and the other a large
    // table read with no filter at all, an index on the big table's join
    // column lets the server look the handful up instead; the planner can
    // only choose that once the index exists.
    if ((step.nodeType === "Hash Join" || step.nodeType === "Merge Join") && step.joinCond !== null) {
      const sides = childrenOfStep(steps, step);
      for (const side of sides) {
        const big = unwrapScan(steps, side);
        const other = sides.find((s) => s !== side);
        if (other === undefined || big.nodeType !== "Seq Scan" || big.filter !== null) continue;
        if (big.relation === null || big.relationSchema === null) continue;

        const known = tableRows[`${big.relationSchema}.${big.relation}`] ?? 0;
        const bigRows = measured ? totalActualRows(big) ?? 0 : Math.max(big.estimatedRows, known);
        const otherRows = measured ? totalActualRows(other) ?? 0 : other.estimatedRows;
        const joinRows = measured ? actualTotal ?? 0 : step.estimatedRows;
        if (bigRows < LARGE_TABLE_ROWS) continue;
        if (otherRows > bigRows * JOIN_SMALL_SIDE_SHARE) continue;
        if (joinRows > bigRows * JOIN_OUTPUT_SHARE) continue;

        // Without a column read off the join condition there is no index to
        // name, and "read a big table" alone is not news: say nothing.
        const advice = indexAdvice(big, [step.joinCond], "");
        if (advice.fixKind === "decision") continue;

        const table = tableName(big);
        out.push({
          id: `join-key:${step.id}`,
          stepId: step.id,
          severity: "medium",
          title:
            advice.fixKind === "change"
              ? `Index ${columnsPhrase(advice.columns)} for this join`
              : "A whole table is read to join a few rows",
          object: table,
          detail:
            `Step ${step.id + 1} matches ${rowsWord(otherRows)} from one side against ` +
            `${table}, and ${measured ? "reads" : "is planned to read"} all ` +
            `${fmtRows(bigRows)} rows of ${table} to do it. The join returns ` +
            `${rowsWord(joinRows)}. ` +
            (advice.fixKind === "change"
              ? `With an index on the column the join matches on, the server can ` +
                `look up just the matching rows of ${table} instead.`
              : `An index the server could use to look up just the matching rows ` +
                `already exists, and the planner passed it over.`),
          fix: advice.fix,
          fixKind: advice.fixKind,
          undo: advice.undo,
          schemas: advice.schemas,
        });
        break;
      }
    }

    // ── A bitmap that ran out of memory and fell back to whole pages ──
    // "Rows Removed by Index Recheck" alone proves nothing: some index types
    // (BRIN always; GIN and GiST for some operators) need every row rechecked
    // whatever the memory. "Lossy Heap Blocks" counts the pages the bitmap
    // stopped tracking row by row for lack of memory, and more memory helps
    // only when that count is above zero.
    const lost = Number(detailValue(step, "Rows Removed by Index Recheck"));
    const lossyPages = Number(detailValue(step, "Lossy Heap Blocks"));
    if (Number.isFinite(lost) && lost > 0 && Number.isFinite(lossyPages) && lossyPages > 0) {
      out.push({
        id: `lossy-bitmap:${step.id}`,
        stepId: step.id,
        severity: "low",
        title: "The index lookup ran out of memory and had to recheck rows",
        object: step.label,
        detail:
          `The bitmap of matching rows outgrew the memory it may use (work_mem), so on ` +
          `${fmtRows(lossyPages)} pages it kept only "something here matches", and every ` +
          `row on those pages was read and tested again: ${fmtRows(lost)} rows were ` +
          `dropped on that second look. With more memory the bitmap stays exact.`,
        fix: lossyBitmapFix(lossyPages),
        fixKind: "decision",
      });
    }

    // Heap Fetches is a total across loops, unlike the row counts above.
    const fetches = Number(detailValue(step, "Heap Fetches"));
    if (step.nodeType === "Index Only Scan" && Number.isFinite(fetches) && fetches >= 1000) {
      const table = tableName(step);
      out.push({
        id: `heap-fetches:${step.id}`,
        stepId: step.id,
        severity: "low",
        title: "An index-only scan kept having to open the table anyway",
        object: table,
        detail:
          `This step should have been answered by the index alone, but it went to ` +
          `the table ${fmtRows(fetches)} times because the rows had been changed too ` +
          `recently for the visibility map to vouch for them. Vacuuming refreshes it.`,
        // Built from the schema and table, never from the label: the label
        // carries the alias ("orders o"), which would make the statement a
        // syntax error.
        fix:
          step.relation !== null && step.relationSchema !== null
            ? `VACUUM (ANALYZE) ${qualifiedName(step.relationSchema, step.relation)};`
            : `-- The plan did not say which schema ${oneLine(table)} is in.\n` +
              `-- Run VACUUM (ANALYZE) on that table, with its schema in front.`,
        // Maintenance when there is a statement to run; VACUUM cannot run
        // inside a transaction, so it can never be part of a migration.
        fixKind:
          step.relation !== null && step.relationSchema !== null ? "maintenance" : "decision",
      });
    }
  }

  return out;
}
