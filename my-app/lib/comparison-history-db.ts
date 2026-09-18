// ---------------------------------------------------------------------------
// comparison-history-db.ts
// Storing what a comparison found, and reading back what the last one found.
//
// The rules — what a finding's key is, what counts as drift between two runs,
// how it reads in words — are in comparison-history.ts, which is pure and is
// imported by the screen. This module is the half that touches the metadata
// database, and it is kept apart so that importing the rules into a client
// component cannot drag a connection pool into the browser bundle.
//
// Nothing here is allowed to break a comparison. A comparison is the thing the
// user asked for; the history beside it is a convenience, and a metadata
// database that is down or a table that has not been created yet must cost
// them the history, never the answer. Every function catches and degrades.
// ---------------------------------------------------------------------------

import pool, { syncMetadataTables } from "./version-db";
import { readRunSnapshot, type RunSnapshot } from "./comparison-history";

/** The two schemas a run compared. This is what history is kept per. */
export type RunPair = {
  sourceConnectionId: number;
  sourceSchema: string;
  targetConnectionId: number;
  targetSchema: string;
};

/** A run that already happened. */
export type PreviousRun = {
  /** When it ran, as the database returned it. */
  ranAt: string;
  ranBy: string;
  findings: RunSnapshot;
};

/**
 * How many runs of one pair are kept.
 *
 * Only the most recent is ever read, so this could have been one row per pair
 * kept up to date with an upsert. It is not, because a row that overwrote
 * itself could only ever answer one question — "since the last run" — and
 * "historical comparison changes" means a record of what was found at each
 * point, not a cache of the latest. The cap is what keeps that record from
 * growing without end on a pair somebody compares every few minutes.
 */
export const RUN_HISTORY_LIMIT = 20;

/** Identifies a pair in the maps below. */
export function pairKey(pair: RunPair): string {
  return JSON.stringify([
    pair.sourceConnectionId,
    pair.sourceSchema,
    pair.targetConnectionId,
    pair.targetSchema,
  ]);
}

/**
 * The most recent stored run for each of these pairs.
 *
 * One query for every pair on the screen rather than one per target: a compare
 * of a source against four targets would otherwise make four round trips to the
 * metadata database while four other databases are being introspected.
 *
 * Pairs with no history are simply absent from the map. So is everything, if
 * the read fails — see the note at the top of the file.
 */
export async function readPreviousRuns(
  pairs: ReadonlyArray<RunPair>,
): Promise<Map<string, PreviousRun>> {
  const found = new Map<string, PreviousRun>();
  if (pairs.length === 0) return found;

  try {
    await syncMetadataTables();

    // Four placeholders per pair, as row constructors: ($1,$2,$3,$4),($5,…).
    const values: Array<number | string> = [];
    const tuples = pairs.map((pair) => {
      const at = values.length;
      values.push(
        pair.sourceConnectionId,
        pair.sourceSchema,
        pair.targetConnectionId,
        pair.targetSchema,
      );
      return `($${at + 1}, $${at + 2}, $${at + 3}, $${at + 4})`;
    });

    // DISTINCT ON keeps the first row of each pair, and the ORDER BY makes
    // "first" mean "most recent". Its leading columns are the pair, which is
    // also the order the index is built in, so this reads one row per pair
    // rather than sorting the whole table.
    const result = await pool.query<{
      source_connection_id: number;
      source_schema: string;
      target_connection_id: number;
      target_schema: string;
      ran_at: string;
      ran_by: string;
      findings: unknown;
    }>(
      `SELECT DISTINCT ON
                (source_connection_id, source_schema, target_connection_id, target_schema)
              source_connection_id, source_schema, target_connection_id, target_schema,
              ran_at, ran_by, findings
         FROM comparison_runs
        WHERE (source_connection_id, source_schema, target_connection_id, target_schema)
              IN (${tuples.join(", ")})
        ORDER BY source_connection_id, source_schema, target_connection_id, target_schema,
                 ran_at DESC, id DESC`,
      values,
    );

    for (const row of result.rows) {
      const findings = readRunSnapshot(row.findings);
      // A row this build cannot read is a row with no history in it. Skipping
      // it shows the reader nothing, which is right — the alternative is a
      // "since last time" claim built on numbers that could not be verified.
      if (!findings) continue;
      found.set(
        pairKey({
          sourceConnectionId: row.source_connection_id,
          sourceSchema: row.source_schema,
          targetConnectionId: row.target_connection_id,
          targetSchema: row.target_schema,
        }),
        { ranAt: row.ran_at, ranBy: row.ran_by, findings },
      );
    }
  } catch (error) {
    console.error("Failed to read comparison history:", error);
  }
  return found;
}

/** One run, ready to store. */
export type RunRecord = {
  pair: RunPair;
  /** The saved set this run came from, when one was open. */
  setId: number | null;
  ranBy: string;
  findings: RunSnapshot;
};

/**
 * Store these runs and prune the pairs they belong to.
 *
 * Returns nothing: the screen has already been built from what the comparison
 * found, and whether the row was written changes nothing on it. That is also
 * why the whole body is inside one catch — see the note at the top.
 */
export async function recordRuns(records: ReadonlyArray<RunRecord>): Promise<void> {
  if (records.length === 0) return;

  try {
    await syncMetadataTables();

    const values: Array<number | string | null> = [];
    const rows = records.map((record) => {
      const at = values.length;
      values.push(
        record.setId,
        record.pair.sourceConnectionId,
        record.pair.sourceSchema,
        record.pair.targetConnectionId,
        record.pair.targetSchema,
        record.ranBy,
        record.findings.total,
        record.findings.breaking,
        record.findings.safe,
        record.findings.info,
        record.findings.fingerprint,
        JSON.stringify(record.findings),
      );
      const n = (offset: number) => `$${at + offset}`;
      return (
        `(${n(1)}, ${n(2)}, ${n(3)}, ${n(4)}, ${n(5)}, ${n(6)}, ` +
        `${n(7)}, ${n(8)}, ${n(9)}, ${n(10)}, ${n(11)}, ${n(12)}::jsonb)`
      );
    });

    await pool.query(
      `INSERT INTO comparison_runs
         (set_id, source_connection_id, source_schema, target_connection_id, target_schema,
          ran_by, total_changes, breaking_changes, safe_changes, info_changes,
          fingerprint, findings)
       VALUES ${rows.join(", ")}`,
      values,
    );

    await prune(records.map((record) => record.pair));
  } catch (error) {
    console.error("Failed to record comparison history:", error);
  }
}

/**
 * Drop everything past RUN_HISTORY_LIMIT for these pairs.
 *
 * Numbering the rows per pair and deleting the ones that number past the limit,
 * rather than a DELETE per pair: the run that just finished usually has several
 * targets, and this is one statement whatever the count. `ran_at DESC, id DESC`
 * because two runs of the same pair in the same millisecond are ordered by
 * insertion, and without the tiebreak which of them survives would be arbitrary.
 *
 * Its own try/catch inside recordRuns' catch would be redundant — a failure
 * here means the rows were written and not pruned, which is caught above and
 * costs nothing but a few extra rows until the next run.
 */
async function prune(pairs: ReadonlyArray<RunPair>): Promise<void> {
  const values: Array<number | string> = [];
  const tuples = pairs.map((pair) => {
    const at = values.length;
    values.push(
      pair.sourceConnectionId,
      pair.sourceSchema,
      pair.targetConnectionId,
      pair.targetSchema,
    );
    return `($${at + 1}, $${at + 2}, $${at + 3}, $${at + 4})`;
  });
  values.push(RUN_HISTORY_LIMIT);

  await pool.query(
    `DELETE FROM comparison_runs AS doomed
       USING (
         SELECT id,
                row_number() OVER (
                  PARTITION BY source_connection_id, source_schema,
                               target_connection_id, target_schema
                  ORDER BY ran_at DESC, id DESC
                ) AS place
           FROM comparison_runs
          WHERE (source_connection_id, source_schema,
                 target_connection_id, target_schema)
                IN (${tuples.join(", ")})
       ) AS ranked
      WHERE doomed.id = ranked.id AND ranked.place > $${values.length}`,
    values,
  );
}
