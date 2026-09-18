import type { ThresholdReading } from "./perf-thresholds";

/**
 * How the whole database is doing, from the statistics views.
 *
 * Spec feature 10 — "Table/Database Health Metrics using system catalog and
 * statistical views." The table half of that line was already built: the advice
 * tab reads pg_stat_user_tables and reports per-table problems. The database
 * half was not. Everything here is server-wide and belongs to no schema, which
 * is why it lives beside the activity read rather than beside the advice rules.
 *
 * Three things about pg_stat_database decide almost every choice in this file:
 *
 *   • **The counters are totals since a reset, not a rate.** `blks_hit` is every
 *     block hit since the counters were last thrown away, which on a long-lived
 *     server is months. So a ratio computed from them is a lifetime average and
 *     says very little about the last hour. `since` is carried for exactly this
 *     reason: a number with no window on it invites being read as "right now".
 *   • **A hit is a shared-buffers hit, not a memory hit.** A "read" here only
 *     means PostgreSQL asked the operating system for the block — the OS may
 *     well have served it from its own cache without touching a disk. So the
 *     hit ratio is a floor on how much was in memory, never the whole truth,
 *     and the wording on screen has to stop short of claiming disk I/O.
 *   • **Zero activity is not zero percent.** Right after a reset, `blks_hit` and
 *     `blks_read` are both 0, and dividing gives NaN — which renders as "NaN%"
 *     or, worse, gets coerced to 0 and reports a perfectly healthy server as
 *     having a 0% cache hit ratio. Every ratio here is null when its
 *     denominator is zero, and null means "nothing to measure yet".
 *
 * The module holds the SQL and the shaping and opens nothing, so the route can
 * run it against a target server and the tests can run it against fixtures.
 */

/**
 * One row of database-wide health.
 *
 * `numbackends` is this database's connections only, while max_connections is
 * the whole server's limit — they are deliberately read together anyway,
 * because a server at its limit refuses new connections to every database on
 * it, and the one number a person can act on is "how close are we".
 */
export const DB_HEALTH_SQL = `
  SELECT
    d.blks_hit,
    d.blks_read,
    d.xact_commit,
    d.xact_rollback,
    d.deadlocks,
    d.temp_files,
    d.temp_bytes,
    d.conflicts,
    d.numbackends,
    d.stats_reset,
    pg_database_size(current_database())            AS db_bytes,
    current_setting('max_connections')::int         AS max_connections,
    current_database()                              AS database_name
  FROM pg_stat_database d
  WHERE d.datname = current_database()
`;

/** One row of DB_HEALTH_SQL. Every count arrives as a string — see toNumber. */
export type DbHealthRow = {
  blks_hit: string | number | null;
  blks_read: string | number | null;
  xact_commit: string | number | null;
  xact_rollback: string | number | null;
  deadlocks: string | number | null;
  temp_files: string | number | null;
  temp_bytes: string | number | null;
  conflicts: string | number | null;
  numbackends: string | number | null;
  stats_reset: string | Date | null;
  db_bytes: string | number | null;
  max_connections: string | number | null;
  database_name: string | null;
};

/** How worried to be. The screen colours a metric by this and nothing else. */
export type HealthLevel = "good" | "watch" | "bad" | "unknown";

/** One number on the health panel, already decided and already worded. */
export type HealthMetric = {
  key: string;
  label: string;
  /** Ready to print: "98%", "1.4 GB", "12 of 100". Null when not measurable. */
  display: string | null;
  /** The raw number, for a threshold to compare against. Null when unknown. */
  value: number | null;
  level: HealthLevel;
  /** One sentence saying what the number means and what it does not. */
  note: string;
};

export type DbHealth = {
  database: string;
  /**
   * When these counters last started from zero, ISO, or null when the server
   * has never reset them. Everything below is a total since this moment.
   */
  since: string | null;
  metrics: HealthMetric[];
};

/**
 * PostgreSQL returns bigint and numeric as strings through node-postgres, so
 * that a value past 2^53 is not silently rounded. Everything here wants a
 * number, and a value that will not parse is treated as absent rather than 0 —
 * a missing counter must not read as "none happened".
 */
function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * A share of a total, or null when there is no total to take a share of.
 *
 * The null case is the whole point: 0/0 is NaN, and a NaN that reaches the
 * screen either prints as "NaN%" or is coerced to 0 and reports a healthy
 * server as having no cache hits at all.
 */
export function ratio(part: number | null, rest: number | null): number | null {
  if (part === null || rest === null) return null;
  const total = part + rest;
  if (total <= 0) return null;
  return part / total;
}

/** A byte count as a person reads it. Kept here so every metric matches. */
export function formatBytes(bytes: number): string {
  const units = ["bytes", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // Whole bytes read oddly with a decimal; everything larger is rounded to one.
  const text = unit === 0 ? String(Math.round(value)) : value.toFixed(1);
  return `${text} ${units[unit]}`;
}

/** A percentage for the screen. Rounded, because the extra digits are noise. */
function asPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * Where a ratio sits against two lines, for a metric that is better when high.
 * `null` in means `unknown` out — a level is a claim, and there is nothing to
 * claim about a number that was never measured.
 */
function levelWhenHigherIsBetter(value: number | null, watch: number, bad: number): HealthLevel {
  if (value === null) return "unknown";
  if (value < bad) return "bad";
  if (value < watch) return "watch";
  return "good";
}

/** The same, for a metric that is better when low. */
function levelWhenLowerIsBetter(value: number | null, watch: number, bad: number): HealthLevel {
  if (value === null) return "unknown";
  if (value > bad) return "bad";
  if (value > watch) return "watch";
  return "good";
}

/**
 * The bands these levels use are the ones a person would apply by eye, and they
 * are deliberately not the user's alert thresholds. A threshold is a rule
 * somebody chose and switched on, and it raises a breach; these bands only
 * colour a number that is being shown anyway. Mixing them would mean a schema
 * with no thresholds configured had an uncoloured, unreadable health panel.
 */
const CACHE_WATCH = 0.99;
const CACHE_BAD = 0.9;
const ROLLBACK_WATCH = 0.05;
const ROLLBACK_BAD = 0.2;
const CONNECTIONS_WATCH = 0.7;
const CONNECTIONS_BAD = 0.9;

/** Shape one row into the panel the screen draws. */
export function readDbHealth(row: DbHealthRow): DbHealth {
  const hit = toNumber(row.blks_hit);
  const read = toNumber(row.blks_read);
  const committed = toNumber(row.xact_commit);
  const rolledBack = toNumber(row.xact_rollback);
  const deadlocks = toNumber(row.deadlocks);
  const tempFiles = toNumber(row.temp_files);
  const tempBytes = toNumber(row.temp_bytes);
  const backends = toNumber(row.numbackends);
  const maxConnections = toNumber(row.max_connections);
  const dbBytes = toNumber(row.db_bytes);

  const cacheHit = ratio(hit, read);
  const rollback = ratio(rolledBack, committed);
  const connectionUse =
    backends === null || maxConnections === null || maxConnections <= 0
      ? null
      : backends / maxConnections;

  const metrics: HealthMetric[] = [
    {
      key: "cache_hit_ratio",
      label: "Cache hit ratio",
      display: cacheHit === null ? null : asPercent(cacheHit),
      value: cacheHit,
      level: levelWhenHigherIsBetter(cacheHit, CACHE_WATCH, CACHE_BAD),
      note:
        cacheHit === null
          ? "No blocks have been read since the counters were reset, so there is nothing to take a share of."
          : "The share of block reads PostgreSQL served from its own shared buffers. " +
            "A miss was fetched from the operating system, which may still have had it " +
            "cached — so this is a floor on how much was in memory, not a disk-read count.",
    },
    {
      key: "rollback_ratio",
      label: "Transactions rolled back",
      display: rollback === null ? null : asPercent(rollback),
      value: rollback,
      level: levelWhenLowerIsBetter(rollback, ROLLBACK_WATCH, ROLLBACK_BAD),
      note:
        rollback === null
          ? "No transactions have finished since the counters were reset."
          : "The share of finished transactions that ended in a rollback. Some rollbacks " +
            "are deliberate; a climbing share usually means an application is failing and retrying.",
    },
    {
      key: "connections",
      label: "Connections in use",
      display:
        backends === null || maxConnections === null
          ? null
          : `${backends.toLocaleString("en-US")} of ${maxConnections.toLocaleString("en-US")}`,
      value: connectionUse,
      level: levelWhenLowerIsBetter(connectionUse, CONNECTIONS_WATCH, CONNECTIONS_BAD),
      note:
        "Sessions on this database against the whole server's max_connections. The limit " +
        "is server-wide, so other databases on the same server count against it too and " +
        "this can be under the line while the server is still full.",
    },
    {
      key: "deadlocks",
      label: "Deadlocks",
      display: deadlocks === null ? null : deadlocks.toLocaleString("en-US"),
      value: deadlocks,
      // Any deadlock at all is worth a look, but this is a total over the whole
      // counter window, so a handful across months is not an emergency.
      level: deadlocks === null ? "unknown" : deadlocks === 0 ? "good" : "watch",
      note:
        "Transactions the server had to kill because they were waiting on each other. " +
        "This is a running total since the counters were reset, not a rate.",
    },
    {
      key: "temp_files",
      label: "Temporary files written",
      display:
        tempFiles === null
          ? null
          : tempFiles === 0
            ? "0"
            : `${tempFiles.toLocaleString("en-US")} (${formatBytes(tempBytes ?? 0)})`,
      value: tempFiles,
      level: tempFiles === null ? "unknown" : tempFiles === 0 ? "good" : "watch",
      note:
        "Sorts and hashes too big for work_mem, spilled to disk. A few is normal; a large " +
        "and growing count is the usual sign that work_mem is too small for the queries being run.",
    },
    {
      key: "database_size",
      label: "Database size",
      display: dbBytes === null ? null : formatBytes(dbBytes),
      value: dbBytes,
      // Size is context, not a verdict — there is no size that is wrong.
      level: "good",
      note: "On disk, including indexes and bloat that a vacuum has not yet reclaimed.",
    },
  ];

  return {
    database: row.database_name ?? "",
    since: row.stats_reset === null ? null : new Date(row.stats_reset).toISOString(),
    metrics,
  };
}

/**
 * The health numbers that a stored alert threshold can fire on.
 *
 * Only the cache hit ratio, because it is the only database-wide metric the
 * threshold catalogue has a key for. The others are shown and coloured but
 * cannot raise a breach, which is the honest arrangement: inventing threshold
 * keys nobody has ever seen in the settings screen would give a user alerts
 * they never agreed to.
 *
 * A metric that could not be measured produces no reading at all, so an
 * unmeasurable ratio cannot be compared against a limit and reported as being
 * under it.
 */
export function dbHealthReadings(health: DbHealth): ThresholdReading[] {
  const cache = health.metrics.find((m) => m.key === "cache_hit_ratio");
  if (!cache || cache.value === null) return [];
  return [{ key: "cache_hit_ratio", actual: cache.value, subject: `${health.database} cache` }];
}
