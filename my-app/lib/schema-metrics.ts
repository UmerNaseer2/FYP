import pool from "./version-db";
import { buildPgConfig } from "./connection-config";
import { getPoolForConfig, type SchemaSnapshot } from "./postgres";
import { countSnapshot, type MetricSample } from "./metrics-series";

/**
 * Spec feature 10 — writing readings down, reading them back, and throwing the
 * old ones away.
 *
 * The sampling deliberately has no schedule of its own. It hangs off the drift
 * check, because the drift check is already the moment this app looks at a live
 * schema, and a second timer reading the same databases on its own cadence
 * would double the load to produce points nobody asked for at times nobody
 * chose. It also means the history is honest about itself: the chart has a
 * point exactly where a check ran, and a gap exactly where one did not.
 *
 * Every function here is best-effort by design. A failed sample must never turn
 * a successful drift check into an error — the check is the thing the user
 * asked for, and a missing point on a chart is a gap, which is a state this
 * feature already knows how to draw.
 */

/**
 * How long readings are kept.
 *
 * Ninety days covers "did this schema grow over the quarter", which is the
 * longest question the screen asks. Beyond that the row costs storage to answer
 * a question nothing in the app poses.
 */
export const METRIC_RETENTION_DAYS = 90;

/** How long the size query gets before it is abandoned. */
const SIZE_TIMEOUT_MS = 5_000;

/** The three numbers that come from the server rather than from the snapshot. */
type SizeReading = {
  totalBytes: number | null;
  indexBytes: number | null;
  estimatedRows: number | null;
};

const NO_SIZES: SizeReading = {
  totalBytes: null,
  indexBytes: null,
  estimatedRows: null,
};

/** What one sample needs from the caller. */
export type MetricSampleInput = {
  trackedSchemaId: number;
  /** The live structure the drift check just read. */
  live: SchemaSnapshot;
  /** Whether that check found the schema drifted from its baseline. */
  drifted: boolean;
};

/**
 * Take one reading and store it.
 *
 * Returns whether it landed rather than throwing, for the same reason
 * `recordDriftEvent` does: the caller has already done the work that mattered.
 */
export async function recordSchemaMetrics(input: MetricSampleInput): Promise<boolean> {
  try {
    const counts = countSnapshot(input.live);
    const sizes = await measureSizes(input.trackedSchemaId, input.live.schema);
    await pool.query(
      `INSERT INTO schema_metrics
         (tracked_schema_id, tables, columns, indexes, foreign_keys, views,
          routines, total_bytes, index_bytes, estimated_rows, drifted)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        input.trackedSchemaId,
        counts.tables,
        counts.columns,
        counts.indexes,
        counts.foreignKeys,
        counts.views,
        counts.routines,
        sizes.totalBytes,
        sizes.indexBytes,
        sizes.estimatedRows,
        input.drifted,
      ]
    );
    return true;
  } catch (error) {
    console.error("Monitoring — failed to record a schema metric:", error);
    return false;
  }
}

/** The connection behind a tracked schema, as the size query needs it. */
type MetricConnRow = {
  type: string | null;
  host: string | null;
  port: number | null;
  database_name: string | null;
  username: string | null;
  password: string | null;
  connection_string: string | null;
  ssl: boolean | null;
  ssl_mode: string | null;
};

/**
 * Ask the server how much room this schema takes up.
 *
 * Nullable on every path that is not a clean answer, and that is the point.
 * `pg_total_relation_size` needs privileges on the relation; `reltuples` is a
 * planner estimate that is -1 until a table has been ANALYZEd. A role that can
 * list a schema's structure but not measure it is ordinary, and the honest
 * record of that is three nulls, not three zeros.
 */
async function measureSizes(
  trackedSchemaId: number,
  schema: string
): Promise<SizeReading> {
  let row: MetricConnRow | undefined;
  try {
    const found = await pool.query<MetricConnRow>(
      `SELECT c.type, c.host, c.port, c.database_name, c.username, c.password,
              c.connection_string, c.ssl, c.ssl_mode
         FROM tracked_schemas ts
         JOIN connections c ON c.id = ts.connection_id
        WHERE ts.id = $1`,
      [trackedSchemaId]
    );
    row = found.rows[0];
  } catch (error) {
    console.error("Monitoring — could not read the connection to measure:", error);
    return NO_SIZES;
  }
  if (!row || row.type !== "PostgreSQL") return NO_SIZES;

  const cfg = buildPgConfig({
    host: row.host,
    port: row.port,
    database: row.database_name,
    user: row.username,
    password: row.password,
    connectionString: row.connection_string,
    ssl: Boolean(row.ssl),
    sslMode: row.ssl_mode,
  });

  try {
    const target = getPoolForConfig(cfg);
    const client = await target.connect();
    try {
      // A background job must not be the reason somebody's database is holding
      // a long-running catalogue scan.
      await client.query(`SET statement_timeout = ${SIZE_TIMEOUT_MS}`);
      const result = await client.query<{
        total_bytes: string | null;
        index_bytes: string | null;
        estimated_rows: string | null;
      }>(
        `SELECT COALESCE(SUM(pg_total_relation_size(c.oid)), 0)::bigint AS total_bytes,
                COALESCE(SUM(pg_indexes_size(c.oid)), 0)::bigint       AS index_bytes,
                COALESCE(SUM(GREATEST(c.reltuples, 0)), 0)::bigint     AS estimated_rows
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1
            AND c.relkind IN ('r', 'p', 'm')`,
        [schema]
      );
      const first = result.rows[0];
      if (!first) return NO_SIZES;
      // node-postgres hands every bigint back as text rather than lose
      // precision above 2^53, so all three arrive as strings.
      return {
        totalBytes: toNumber(first.total_bytes),
        indexBytes: toNumber(first.index_bytes),
        estimatedRows: toNumber(first.estimated_rows),
      };
    } finally {
      client.release();
    }
  } catch (error) {
    console.error(`Monitoring — could not measure "${schema}":`, error);
    return NO_SIZES;
  }
}

/** A row as it comes back out of the metadata database. */
type MetricRow = {
  sampled_at: string | Date;
  tables: number;
  columns: number;
  indexes: number;
  foreign_keys: number;
  views: number;
  routines: number;
  total_bytes: string | null;
  index_bytes: string | null;
  estimated_rows: string | null;
  drifted: boolean;
};

/**
 * Every reading for one schema inside a window, oldest first.
 *
 * Oldest first because that is the order a line is drawn in, and sorting on the
 * way out of the database is cheaper and more reliable than sorting in the
 * browser after JSON has turned the timestamps into strings.
 */
export async function readSchemaMetrics(
  trackedSchemaId: number,
  days: number
): Promise<MetricSample[]> {
  const result = await pool.query<MetricRow>(
    `SELECT sampled_at, tables, columns, indexes, foreign_keys, views, routines,
            total_bytes, index_bytes, estimated_rows, drifted
       FROM schema_metrics
      WHERE tracked_schema_id = $1
        AND sampled_at >= CURRENT_TIMESTAMP - ($2 || ' days')::interval
      ORDER BY sampled_at ASC, id ASC`,
    [trackedSchemaId, String(Math.max(1, Math.floor(days)))]
  );
  return result.rows.map((row) => ({
    at: new Date(row.sampled_at).toISOString(),
    tables: row.tables,
    columns: row.columns,
    indexes: row.indexes,
    foreignKeys: row.foreign_keys,
    views: row.views,
    routines: row.routines,
    totalBytes: toNumber(row.total_bytes),
    indexBytes: toNumber(row.index_bytes),
    estimatedRows: toNumber(row.estimated_rows),
    drifted: row.drifted,
  }));
}

/**
 * Delete readings past the retention window.
 *
 * Returns how many went, so the scheduler's status line can say what it did
 * rather than claiming a number it never checked.
 */
export async function pruneSchemaMetrics(
  days: number = METRIC_RETENTION_DAYS
): Promise<number> {
  try {
    const result = await pool.query(
      `DELETE FROM schema_metrics
        WHERE sampled_at < CURRENT_TIMESTAMP - ($1 || ' days')::interval`,
      [String(Math.max(1, Math.floor(days)))]
    );
    return result.rowCount ?? 0;
  } catch (error) {
    console.error("Monitoring — prune failed:", error);
    return 0;
  }
}

/** A bigint-as-text from node-postgres, or null when it is not a number. */
function toNumber(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
