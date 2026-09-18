import type { ScoreBand } from "./query-score";

/**
 * What the app remembers about a query somebody analysed.
 *
 * Two spec bullets land on one table, on purpose:
 *
 *   • Feature 8 — "Store query history for review and comparison."
 *   • Feature 10 — "Historical Query Monitoring (query, exec_time,
 *     rows_returned, capture_time)". Those four names are the spec's, and the
 *     columns below are named after them so the mapping needs no explaining.
 *
 * They are one table because they are one fact: a query was analysed, here is
 * what came back. Splitting them would mean writing the same row twice and then
 * having to keep the two copies agreeing.
 *
 * This module is deliberately isomorphic — no `pg`, no `node:crypto`, no
 * Sequelize — so the screen can import the types and the fingerprint without
 * dragging server code into the browser bundle. The table itself is declared in
 * lib/db/models.ts and written by the analyse route.
 */

/**
 * How long a row is kept, in days.
 *
 * The same window as schema metrics, and for the same reason: a trend needs a
 * season, and nobody has ever asked what a query did last spring. See
 * METRIC_RETENTION_DAYS in lib/schema-metrics.ts.
 */
export const QUERY_HISTORY_RETENTION_DAYS = 90;

/**
 * The most rows kept for one connection-and-schema, whatever their age.
 *
 * Retention by age alone is not enough here. Metrics are written by a timer, so
 * their rate is known; this table is written by a person pressing Analyse, and
 * somebody iterating on a query writes a row every few seconds. The cap is what
 * stops an afternoon of tuning from becoming most of the table.
 */
export const QUERY_HISTORY_MAX_ROWS = 500;

/** The longest slice of SQL stored. Longer queries are kept truncated. */
export const STORED_SQL_LIMIT = 10_000;

/**
 * One stored analysis, as the screen reads it.
 *
 * `exec_time_ms` and `rows_returned` are nullable because an estimate has
 * neither: nothing ran, so there is no time and no row count. Storing 0 would
 * say the query was instant and returned nothing, which is a different and
 * false claim — and it would poison the trend line that averages them.
 */
export type QueryHistoryRow = {
  id: number;
  connection_id: number;
  connection_name: string;
  schema_name: string;
  /** The SQL as submitted, truncated at STORED_SQL_LIMIT. */
  query_text: string;
  /** Groups re-runs of the same query. See fingerprintQuery. */
  fingerprint: string;
  /** Milliseconds the query really took. Null for an estimate. */
  exec_time_ms: number | null;
  /** Milliseconds spent planning. Null when the plan did not report it. */
  planning_ms: number | null;
  /** Rows the query really returned. Null for an estimate. */
  rows_returned: number | null;
  /** The planner's cost for the whole plan — always present. */
  total_cost: number;
  /** The planner's row estimate — present for both kinds of plan. */
  estimated_rows: number;
  score: number;
  band: ScoreBand;
  /** True when this row came from EXPLAIN ANALYZE rather than EXPLAIN. */
  measured: boolean;
  high_count: number;
  medium_count: number;
  low_count: number;
  /** Who ran it. The bypass principal when auth is off, so a log stays honest. */
  captured_by: string;
  captured_at: string;
};

/**
 * Turn a query into a key that groups its re-runs.
 *
 * "The same query" has to mean something looser than "the same characters", or
 * history is a list of near-duplicates and nothing can ever be compared with
 * anything. What is stripped:
 *
 *   • Comments, both kinds. A note somebody added between two runs does not
 *     make it a different query.
 *   • String and number literals, replaced by `?`. `WHERE id = 41` and
 *     `WHERE id = 42` are the same query asked twice; keeping the literals
 *     would put them in separate groups AND would copy user data into a key
 *     that gets logged and indexed.
 *   • Whitespace and case. Reformatting is not a change.
 *
 * What is NOT stripped: identifiers. `orders` and `customers` are different
 * queries and must never share a group.
 *
 * This is a grouping key, not a security boundary, so the hash below is FNV-1a
 * rather than SHA-256: it is eight characters instead of sixty-four, it needs no
 * import, and it therefore works unchanged in the browser and on the server. A
 * collision would merge two unrelated queries in one screen's grouping, which is
 * a cosmetic bug — and `query_text` is stored beside it either way, so nothing
 * is ever decided from the fingerprint alone.
 */
export function normalizeQuery(sql: string): string {
  return (
    sql
      // Block comments first: a line comment inside one is not a line comment.
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/--[^\n]*/g, " ")
      // Single-quoted strings, doubled quotes inside them included ('it''s').
      .replace(/'(?:[^']|'')*'/g, "?")
      // Dollar-quoted strings, which a function body arrives in.
      .replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, "?")
      // Numbers, but only whole tokens — `col2` must stay `col2`, so the match
      // has to start at a boundary that is not part of an identifier.
      .replace(/\b\d+(?:\.\d+)?\b/g, "?")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase()
  );
}

/** FNV-1a over the normalized text, as eight lowercase hex characters. */
export function fingerprintQuery(sql: string): string {
  const text = normalizeQuery(sql);
  // 32-bit FNV-1a. `Math.imul` is what keeps the multiply inside 32 bits —
  // a plain `*` would overflow into a float and lose the low bits that carry
  // most of the entropy.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // >>> 0 reads the result as unsigned; without it a hash with the top bit set
  // prints with a minus sign.
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Cut stored SQL to the limit, saying so rather than truncating silently. */
export function truncateSql(sql: string): string {
  if (sql.length <= STORED_SQL_LIMIT) return sql;
  return `${sql.slice(0, STORED_SQL_LIMIT)}\n-- … truncated, the query was ${sql.length} characters`;
}

/**
 * How two runs of the same query compare.
 *
 * Spec feature 10 — "Compare historical performance with current database
 * performance." This is that comparison for one query: the newest run against
 * an older one.
 */
export type QueryComparison = {
  /** Positive means the newer run was slower. Null when either is an estimate. */
  execTimeDeltaMs: number | null;
  /** Newer over older, e.g. 1.4 for 40% slower. Null under the same condition. */
  execTimeRatio: number | null;
  /** Positive means the newer run scored better. */
  scoreDelta: number;
  /** Positive means the newer plan costs more. */
  costRatio: number | null;
  /** Rows the newer run returned minus the older. Null when either is missing. */
  rowsDelta: number | null;
  /** One sentence for the screen. Always set. */
  verdict: string;
};

/**
 * How much slower a query has to get before it is called slower.
 *
 * Twenty percent. Below that the difference is cache warmth, another session on
 * the box, or the planner picking a different but equivalent shape — and a tool
 * that cries "regression" at 3% teaches people to ignore it.
 */
export const REGRESSION_RATIO = 1.2;

/** The mirror of REGRESSION_RATIO for an improvement. */
export const IMPROVEMENT_RATIO = 1 / REGRESSION_RATIO;

/**
 * Compare a newer run with an older one.
 *
 * Both are needed; the caller finds the pair by fingerprint. Timings are only
 * compared when BOTH runs were measured — a cost and a millisecond are not the
 * same kind of number, and dividing one by the other would produce a ratio that
 * looks authoritative and means nothing.
 */
export function compareRuns(
  newer: Pick<QueryHistoryRow, "exec_time_ms" | "rows_returned" | "score" | "total_cost" | "measured">,
  older: Pick<QueryHistoryRow, "exec_time_ms" | "rows_returned" | "score" | "total_cost" | "measured">
): QueryComparison {
  const bothMeasured =
    newer.measured && older.measured && newer.exec_time_ms !== null && older.exec_time_ms !== null;

  const execTimeDeltaMs = bothMeasured
    ? (newer.exec_time_ms as number) - (older.exec_time_ms as number)
    : null;

  // Guarded against a zero denominator: a query that timed at 0 ms is real
  // (a cached primary-key lookup), and dividing by it gives Infinity.
  const execTimeRatio =
    bothMeasured && (older.exec_time_ms as number) > 0
      ? (newer.exec_time_ms as number) / (older.exec_time_ms as number)
      : null;

  const costRatio = older.total_cost > 0 ? newer.total_cost / older.total_cost : null;

  const rowsDelta =
    newer.rows_returned !== null && older.rows_returned !== null
      ? newer.rows_returned - older.rows_returned
      : null;

  const scoreDelta = newer.score - older.score;

  // The verdict prefers the measured comparison and falls back to cost, saying
  // which one it used either way.
  let verdict: string;
  if (execTimeRatio !== null) {
    if (execTimeRatio >= REGRESSION_RATIO) {
      verdict = `Slower — ${execTimeRatio.toFixed(1)}× the time it took before.`;
    } else if (execTimeRatio <= IMPROVEMENT_RATIO) {
      verdict = `Faster — ${(1 / execTimeRatio).toFixed(1)}× quicker than before.`;
    } else {
      verdict = "About the same speed as before.";
    }
  } else if (costRatio !== null) {
    const direction =
      costRatio >= REGRESSION_RATIO
        ? `costlier — ${costRatio.toFixed(1)}× the planner's estimate`
        : costRatio <= IMPROVEMENT_RATIO
          ? `cheaper — ${(1 / costRatio).toFixed(1)}× less than before`
          : "about the same cost";
    verdict = `Neither run was timed, so this is the planner's estimate: ${direction}.`;
  } else {
    verdict = "There is not enough in common between these two runs to compare them.";
  }

  // Rows are worth saying out loud when they changed, because a query that got
  // slower while returning ten times more rows did not necessarily regress.
  if (rowsDelta !== null && rowsDelta !== 0) {
    const more = rowsDelta > 0;
    verdict += ` It returned ${Math.abs(rowsDelta).toLocaleString("en-US")} ${
      more ? "more" : "fewer"
    } rows this time.`;
  }

  return { execTimeDeltaMs, execTimeRatio, scoreDelta, costRatio, rowsDelta, verdict };
}
