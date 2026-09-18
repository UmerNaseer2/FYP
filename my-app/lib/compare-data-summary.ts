// ---------------------------------------------------------------------------
// compare-data-summary.ts
// The row-comparison RESULT — its shape, and the counts read off it.
//
// Split out of compare-data.ts, which opens database connections and therefore
// carries `pg` with it. The screens need the shape and the counts, and nothing
// else; keeping them here means the export bar and the row-compare table can be
// client components without the node-only PostgreSQL driver following them into
// the browser bundle.
//
// compare-data.ts re-exports everything below, so server-side callers are
// unaffected by where it lives.
// ---------------------------------------------------------------------------

import type { RowSample } from "./compare-sample";

// Re-exported so a screen rendering these rows imports one module, not two.
export type { RowSample, SampleRow, RowDifference } from "./compare-sample";

/** One table's data comparison. */
export type TableDataCompare = {
  /** How the table is labelled in the report — "old → new" when renamed. */
  table: string;
  status:
    | "identical"
    | "different"
    /** Only the source has the table, so only its row count is known. */
    | "sourceOnly"
    /** Only the target has the table. */
    | "targetOnly"
    /** Could not be compared — `note` says why. */
    | "skipped";
  leftRows: number | null;
  rightRows: number | null;
  leftChecksum: string | null;
  rightChecksum: string | null;
  /** The columns that were hashed, named as the source calls them. */
  columns: string[];
  /**
   * The columns that were NOT hashed because only one side has them.
   *
   * This is what stops "identical" from being a lie. The checksum can only
   * cover the columns both tables share, so a table whose every difference
   * lives in an unpaired column hashes the same on both sides and comes back
   * identical — which is true of the columns that were read and says nothing
   * about the ones that were not. Recording them here lets the screen say
   * "identical on N shared columns" and name what it left out, instead of a
   * flat "rows match" that the reader has no way to qualify.
   */
  ignoredColumns: string[];
  /** Why it was skipped, or what was left out of an otherwise-good compare. */
  note: string | null;
  /**
   * Which rows differ, and how — null when this run did not look.
   *
   * Only a table that came back "different" has one: on every other verdict
   * there is either nothing to sample or nothing that was read. See
   * compare-sample.ts for what the scan does and does not cover.
   */
  sample: RowSample | null;
  /**
   * True when a full sync drops this table — whether or not its rows were read.
   *
   * `status` alone cannot answer this. A table only the target has is dropped,
   * but if the run hit its table cap or its time budget before reaching it the
   * status is "skipped" and the drop disappears from every total. That is the
   * one fact this module exists to report, so it is recorded separately from
   * whether the read succeeded.
   */
  droppedBySync: boolean;
};

export type DataCompareReport = {
  tables: TableDataCompare[];
  /** A failure that stopped the whole run — no table result is meaningful. */
  error: string | null;
  /** Per-statement timeout actually used, so the UI can say what it was. */
  timeoutMs: number;
};

/** Headline counts for the summary line above the table. */
export function summarizeDataCompare(result: DataCompareReport): {
  identical: number;
  different: number;
  sourceOnly: number;
  targetOnly: number;
  skipped: number;
  /**
   * How many of the identical tables were only compared on part of their
   * columns, because one side has columns the other does not.
   *
   * Kept apart from `identical` rather than folded into `different`: those
   * tables really do match on everything that was read, and calling them
   * different would be the opposite lie. The number exists so the headline can
   * qualify itself instead of claiming a clean match for all of them.
   */
  identicalOnSharedColumns: number;
  /**
   * Rows a full sync would destroy.
   *
   * A table only the TARGET has is the one the migration drops — the source is
   * the desired state, so anything the target has and the source does not is
   * removed. These rows are the ones no down script can bring back.
   *
   * It counts only tables that were actually read. See unreadDrops for the ones
   * the run never got to, whose rows are destroyed just the same.
   */
  rowsAtRiskOfDrop: number;
  /**
   * Tables a full sync drops whose rows were never counted — the run hit its
   * table cap, its time budget, or could not read them.
   *
   * Kept apart from rowsAtRiskOfDrop because there is no number to add: the
   * honest statement is "and N more, count unknown", not a larger total.
   */
  unreadDrops: number;
} {
  let identical = 0;
  let identicalOnSharedColumns = 0;
  let different = 0;
  let sourceOnly = 0;
  let targetOnly = 0;
  let skipped = 0;
  let rowsAtRiskOfDrop = 0;
  let unreadDrops = 0;

  for (const table of result.tables) {
    if (table.status === "identical") {
      identical += 1;
      if (table.ignoredColumns.length > 0) identicalOnSharedColumns += 1;
    } else if (table.status === "different") different += 1;
    else if (table.status === "sourceOnly") sourceOnly += 1;
    else if (table.status === "targetOnly") {
      targetOnly += 1;
      rowsAtRiskOfDrop += table.rightRows ?? 0;
    } else {
      skipped += 1;
      if (table.droppedBySync) unreadDrops += 1;
    }
  }

  return {
    identical,
    identicalOnSharedColumns,
    different,
    sourceOnly,
    targetOnly,
    skipped,
    rowsAtRiskOfDrop,
    unreadDrops,
  };
}
