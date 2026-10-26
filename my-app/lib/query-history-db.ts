import pool from "./version-db";
import {
  QUERY_HISTORY_MAX_ROWS,
  QUERY_HISTORY_RETENTION_DAYS,
  fingerprintQuery,
  truncateSql,
  type QueryHistoryRow,
} from "./query-history";
import type { QueryScore } from "./query-score";
import type { ColumnSearch } from "./composite-index";

/**
 * Writing analysed queries down, reading them back, and throwing the old ones
 * away.
 *
 * Spec features 8 and 10 — see lib/query-history.ts for why one table serves
 * both, and for everything that has no database in it.
 *
 * Like lib/schema-metrics.ts, every write here is best-effort: failing to
 * record an analysis must never turn a successful analysis into an error. The
 * user asked what their query does, and they got the answer; that the app could
 * not also file it away is a smaller problem, and one the history screen shows
 * honestly as a gap rather than a lie.
 *
 * Reads are NOT best-effort. A history screen that silently shows an empty list
 * when the table could not be read is telling the user nothing has ever been
 * analysed, which is a different and false claim.
 *
 * Everything here is scoped to one organization: the reads take its id and
 * filter on it, and a row is filed under the organization of the connection it
 * was run against, and only when that connection is in the caller's.
 */

/** What one recorded analysis needs from the caller. */
export type RecordQueryInput = {
  /** The organization the caller acts in. The connection must be in it. */
  orgId: number;
  connectionId: number;
  schema: string;
  sql: string;
  score: QueryScore;
  /** Milliseconds the query really took. Null unless it was measured. */
  execTimeMs: number | null;
  planningMs: number | null;
  /** Rows it really returned. Null unless it was measured. */
  rowsReturned: number | null;
  totalCost: number;
  estimatedRows: number;
  counts: { high: number; medium: number; low: number };
  /** Who ran it — an email, or the bypass principal while auth is off. */
  capturedBy: string;
  /**
   * Which columns of which tables the plan searched on (lib/composite-index.ts),
   * for the composite-index rule on the Suggestions tab. Null when the plan
   * could not be read — which is why the column is nullable rather than
   * defaulting to an empty array.
   */
  searches: ColumnSearch[] | null;
};

/**
 * File one analysis.
 *
 * Returns the new row's id, or null when it could not be written. The caller
 * puts that id in the response so the screen can link straight to the row it
 * just created — and a null there is what tells the screen not to offer a link
 * to something that is not in the table.
 *
 * The row takes its org_id from the connection, through a SELECT that only
 * finds the connection inside `input.orgId`. For a connection in another
 * organization nothing is filed and the answer is null, the same as any other
 * row that could not be written.
 */
export async function recordQuery(input: RecordQueryInput): Promise<number | null> {
  try {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO query_history
         (org_id, connection_id, schema_name, query_text, fingerprint,
          exec_time_ms, planning_ms, rows_returned, total_cost, estimated_rows,
          score, band, measured, high_count, medium_count, low_count, captured_by,
          searched_columns)
       SELECT org_id, id, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17
         FROM connections
        WHERE id = $1 AND org_id = $18
       RETURNING id`,
      [
        input.connectionId,
        input.schema,
        truncateSql(input.sql),
        fingerprintQuery(input.sql),
        // The measured columns are forced to null for an unmeasured run rather
        // than trusted from the caller. The CHECK constraint in bootstrap would
        // refuse the row anyway; doing it here means the analysis is still
        // filed instead of being lost to a constraint violation.
        input.score.measured ? input.execTimeMs : null,
        input.planningMs,
        input.score.measured ? input.rowsReturned : null,
        input.totalCost,
        input.estimatedRows,
        input.score.score,
        input.score.band,
        input.score.measured,
        input.counts.high,
        input.counts.medium,
        input.counts.low,
        input.capturedBy,
        // JSON.stringify, not the array: node-postgres would send a JS array as
        // a PostgreSQL array literal, which JSONB refuses. null stays null — see
        // the column comment for why that is not the same as [].
        input.searches === null ? null : JSON.stringify(input.searches),
        input.orgId,
      ]
    );
    const id = result.rows[0]?.id ?? null;
    // Pruning after the write, not before: the new row is the one that made the
    // table one longer, and pruning first would leave it one over the cap until
    // the next write. Best-effort inside a best-effort path.
    if (id !== null) void pruneQueryHistory(input.orgId, input.connectionId, input.schema);
    return id;
  } catch (error) {
    console.error(
      "Query history — the analysis could not be filed:",
      error instanceof Error ? error.message : error
    );
    return null;
  }
}

/**
 * The SELECT list every read below shares.
 *
 * `connection_name` comes from a LEFT JOIN rather than a stored copy, and the
 * join is LEFT rather than INNER on purpose: `query_history.connection_id` is
 * deliberately not a foreign key (see the note in lib/db/models.ts), so a row
 * whose connection has since been deleted must still read. It says "(deleted
 * connection)" instead of vanishing, because the analysis did happen.
 *
 * BIGINT and DOUBLE both arrive from node-postgres as strings. They are cast
 * here, once, so that every caller downstream has numbers — a string that
 * looks like a number is the kind of thing that survives all the way to a
 * chart and then sorts "1000" before "9".
 *
 * The join also matches the organization, so a row can only ever be named
 * after a connection in its own one. Each read below adds the filter on the
 * history row's own org_id.
 */
const SELECT_ROW = `
  SELECT h.id,
         h.connection_id,
         COALESCE(c.name, '(deleted connection)') AS connection_name,
         h.schema_name,
         h.query_text,
         h.fingerprint,
         h.exec_time_ms,
         h.planning_ms,
         h.rows_returned,
         h.total_cost,
         h.estimated_rows,
         h.score,
         h.band,
         h.measured,
         h.high_count,
         h.medium_count,
         h.low_count,
         h.captured_by,
         h.captured_at
    FROM query_history h
    LEFT JOIN connections c ON c.id = h.connection_id AND c.org_id = h.org_id
`;

/** Raw row shape, before the numeric columns are read out of their strings. */
type RawRow = Omit<
  QueryHistoryRow,
  "exec_time_ms" | "planning_ms" | "rows_returned" | "total_cost" | "estimated_rows" | "captured_at"
> & {
  exec_time_ms: string | number | null;
  planning_ms: string | number | null;
  rows_returned: string | number | null;
  total_cost: string | number;
  estimated_rows: string | number;
  captured_at: Date | string;
};

/** null stays null; anything else becomes a number, or null if it is not one. */
function num(value: string | number | null): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function toRow(raw: RawRow): QueryHistoryRow {
  return {
    ...raw,
    exec_time_ms: num(raw.exec_time_ms),
    planning_ms: num(raw.planning_ms),
    rows_returned: num(raw.rows_returned),
    total_cost: num(raw.total_cost) ?? 0,
    estimated_rows: num(raw.estimated_rows) ?? 0,
    captured_at:
      raw.captured_at instanceof Date ? raw.captured_at.toISOString() : String(raw.captured_at),
  };
}

/** How many rows one page of history holds. */
export const HISTORY_PAGE_SIZE = 50;

/**
 * The history for one connection and schema, newest first.
 *
 * Not best-effort: a failure throws, so the route can say the history could not
 * be read rather than showing an empty list that means "nothing here".
 */
export async function listQueryHistory(
  orgId: number,
  connectionId: number,
  schema: string,
  limit = HISTORY_PAGE_SIZE
): Promise<QueryHistoryRow[]> {
  const result = await pool.query<RawRow>(
    `${SELECT_ROW}
      WHERE h.org_id = $1 AND h.connection_id = $2 AND h.schema_name = $3
      ORDER BY h.captured_at DESC, h.id DESC
      LIMIT $4`,
    [orgId, connectionId, schema, Math.min(Math.max(limit, 1), HISTORY_PAGE_SIZE)]
  );
  return result.rows.map(toRow);
}

/** One row by id, or null. Used to open a stored analysis from the list. */
export async function getQueryHistoryRow(
  orgId: number,
  id: number
): Promise<QueryHistoryRow | null> {
  const result = await pool.query<RawRow>(`${SELECT_ROW} WHERE h.id = $1 AND h.org_id = $2`, [
    id,
    orgId,
  ]);
  const raw = result.rows[0];
  return raw ? toRow(raw) : null;
}

/**
 * Every run of one query, newest first.
 *
 * This is what "comparison" in the spec's feature 8 means, and what feature
 * 10's "compare historical performance with current" is built on: the same
 * query, fingerprinted, over time. Scoped to the connection as well as the
 * fingerprint — the same SQL run against staging and against production is two
 * different measurements, and averaging them would be meaningless.
 */
export async function listRunsOfQuery(
  orgId: number,
  connectionId: number,
  schema: string,
  fingerprint: string,
  limit = HISTORY_PAGE_SIZE
): Promise<QueryHistoryRow[]> {
  const result = await pool.query<RawRow>(
    `${SELECT_ROW}
      WHERE h.org_id = $1 AND h.connection_id = $2 AND h.schema_name = $3
        AND h.fingerprint = $4
      ORDER BY h.captured_at DESC, h.id DESC
      LIMIT $5`,
    [orgId, connectionId, schema, fingerprint, Math.min(Math.max(limit, 1), HISTORY_PAGE_SIZE)]
  );
  return result.rows.map(toRow);
}

/**
 * Throw away what is past the window or past the cap.
 *
 * Two rules, because one is not enough — see the constants in
 * lib/query-history.ts. Both run in one statement per rule rather than one
 * combined statement, because the age rule can use the index on captured_at and
 * the cap rule cannot; fusing them would cost the index.
 *
 * Best-effort like the write: a table that is a few rows over its cap is not
 * worth failing a user's request over.
 *
 * Both rules stay inside the caller's organization. The age rule could safely
 * sweep every organization at once, since the window is the same for all of
 * them, but a request acting in one organization deleting another's rows is
 * the kind of reach this table should never have, whatever the reason.
 */
export async function pruneQueryHistory(
  orgId: number,
  connectionId: number,
  schema: string
): Promise<void> {
  try {
    await pool.query(
      `DELETE FROM query_history
        WHERE org_id = $2 AND captured_at < now() - ($1 || ' days')::interval`,
      [String(QUERY_HISTORY_RETENTION_DAYS), orgId]
    );
    // The cap, per connection-and-schema. `IN (SELECT … OFFSET …)` rather than a
    // window function: the index on (connection_id, schema_name, captured_at)
    // answers the inner query directly, so the OFFSET walks the index instead
    // of sorting the table.
    await pool.query(
      `DELETE FROM query_history
        WHERE org_id = $4 AND id IN (
          SELECT id FROM query_history
           WHERE org_id = $4 AND connection_id = $1 AND schema_name = $2
           ORDER BY captured_at DESC, id DESC
           OFFSET $3
        )`,
      [connectionId, schema, QUERY_HISTORY_MAX_ROWS, orgId]
    );
  } catch (error) {
    console.error(
      "Query history — prune failed:",
      error instanceof Error ? error.message : error
    );
  }
}

/**
 * A day's worth of analysed queries, for the trend chart.
 *
 * Grouped by day rather than returned raw because the chart draws a line over
 * weeks and a point per analysis would be a scribble — somebody tuning a query
 * produces thirty points in ten minutes. The median is preferred to the mean
 * for exactly that reason: those thirty include the first, awful attempt.
 *
 * Only measured runs are counted for the timing series. An estimate has no
 * timing, and including it as a zero is the bug the nullable columns exist to
 * prevent.
 */
export type QueryDayPoint = {
  /** YYYY-MM-DD, in the metadata server's zone. */
  day: string;
  /** Analyses that day, measured and estimated together. */
  runs: number;
  /** Of those, the ones that were really run and timed. */
  measuredRuns: number;
  /** Median milliseconds over the measured runs. Null when there were none. */
  medianExecMs: number | null;
  /** Slowest measured run that day. Null when there were none. */
  maxExecMs: number | null;
  /** Median score over every run that day — estimates have a score too. */
  medianScore: number | null;
};

export async function queryTrend(
  orgId: number,
  connectionId: number,
  schema: string,
  days: number
): Promise<QueryDayPoint[]> {
  const result = await pool.query<{
    day: string;
    runs: string;
    measured_runs: string;
    median_exec_ms: string | null;
    max_exec_ms: string | null;
    median_score: string | null;
  }>(
    `SELECT to_char(date_trunc('day', captured_at), 'YYYY-MM-DD') AS day,
            count(*)                                              AS runs,
            count(*) FILTER (WHERE measured)                      AS measured_runs,
            -- FILTER, not a CASE inside the aggregate: percentile_cont over a
            -- CASE would take the NULLs it produced as values in some versions
            -- and drag the median toward nothing.
            percentile_cont(0.5) WITHIN GROUP (ORDER BY exec_time_ms)
              FILTER (WHERE measured AND exec_time_ms IS NOT NULL)  AS median_exec_ms,
            max(exec_time_ms) FILTER (WHERE measured)             AS max_exec_ms,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY score)     AS median_score
       FROM query_history
      WHERE org_id = $4
        AND connection_id = $1
        AND schema_name = $2
        AND captured_at >= now() - ($3 || ' days')::interval
      GROUP BY 1
      ORDER BY 1 ASC`,
    [
      connectionId,
      schema,
      String(Math.min(Math.max(days, 1), QUERY_HISTORY_RETENTION_DAYS)),
      orgId,
    ]
  );

  return result.rows.map((row) => ({
    day: row.day,
    runs: Number(row.runs),
    measuredRuns: Number(row.measured_runs),
    medianExecMs: num(row.median_exec_ms),
    maxExecMs: num(row.max_exec_ms),
    medianScore: num(row.median_score),
  }));
}

/**
 * How far back the composite-index rule looks.
 *
 * Shorter than the 90 days a row is kept, on purpose: the rule is about how
 * this schema is being queried NOW. A pattern from three months ago may belong
 * to a report that has since been rewritten, and adding an index for it costs
 * every write from here on.
 */
export const SEARCH_PATTERN_DAYS = 30;

/**
 * Every recorded search against one schema, for aggregateSearches.
 *
 * Rows whose searches were never recorded come back with `searches: null`,
 * which the aggregate skips — see the note on the column. This is a read, so
 * a failure throws rather than returning an empty list: the Suggestions screen
 * would otherwise show "no query patterns found", which is a claim about the
 * queries rather than about the app.
 */
export async function listSearches(
  orgId: number,
  connectionId: number,
  schema: string,
  days: number = SEARCH_PATTERN_DAYS
): Promise<{ fingerprint: string; searches: ColumnSearch[] | null }[]> {
  const result = await pool.query<{ fingerprint: string; searched_columns: unknown }>(
    `SELECT fingerprint, searched_columns
       FROM query_history
      WHERE org_id = $5
        AND connection_id = $1
        AND schema_name = $2
        AND captured_at >= now() - ($3 || ' days')::interval
      ORDER BY captured_at DESC
      LIMIT $4`,
    [connectionId, schema, String(days), QUERY_HISTORY_MAX_ROWS, orgId]
  );
  return result.rows.map((row) => ({
    fingerprint: row.fingerprint,
    // JSONB comes back already parsed. Anything that is not an array is
    // treated as "not recorded" rather than trusted — the column is written by
    // this app, but a hand-edited row should not crash the Suggestions screen.
    searches: Array.isArray(row.searched_columns)
      ? (row.searched_columns as ColumnSearch[])
      : null,
  }));
}
