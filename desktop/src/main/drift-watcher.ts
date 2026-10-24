/**
 * Watches the drift log for rows worth a notification.
 *
 * The app's server checks tracked schemas on their own timers, and saves
 * each check that found something different to drift_events
 * (my-app/lib/drift-runner.ts). Every 30 seconds this reads the rows saved
 * since it last looked, with the row before each, and hands what is news
 * (src/core/drift-alerts.ts) to its listeners, which show a notification.
 *
 * The rows already there when the app starts are never told about: they are
 * old news, or came with a restored backup. Two checks can run at once and
 * be saved out of order, so each look goes back a little way past the newest
 * row it has seen, and remembers which rows it has judged already.
 *
 * The server makes the tables the first time it starts. Until then there is
 * nothing to watch, and that is not a problem.
 *
 * Pure apart from the log: the database is asked through `query`, so the
 * tests can play its part, or use a real PostgreSQL.
 * Tested in src/test/drift-watcher.test.ts.
 */
import { driftAlert, readDriftRow, type DriftAlert } from "../core/drift-alerts";
import { logInfo, logWarn } from "./log";

/** Asks the app's database, and gives the rows of its answer. */
export type DriftQuery = (sql: string, values: unknown[]) => Promise<Record<string, unknown>[]>;

export type DriftWatcherOptions = {
  query: DriftQuery;
  /** How long between looks: 30 seconds, unless a test says otherwise. */
  intervalMs?: number;
};

/**
 * How long between looks at the drift log. The server checks a schema every
 * 5 minutes at the most often, so a look this often never falls behind, and
 * a notification is never more than half a minute late.
 */
const INTERVAL_MS = 30_000;

/** How far back past the newest row it has seen each look goes, for rows saved out of order. */
const LOOKBACK = 100;

/**
 * The most rows one look reads. It is more than LOOKBACK, so a look always
 * gets past the rows it has seen already, however many new ones wait.
 */
const LIMIT = 200;

const NEWEST_SQL = "SELECT COALESCE(max(id), 0) AS newest FROM public.drift_events";

// For each new scheduled check: the row just before it for the same schema,
// whatever wrote it, which says whether its status is news, and the last
// check against the same baseline that had a fingerprint, which says whether
// the drift itself changed. Rows a person's action wrote have no fingerprint,
// so they are skipped there. "Before" is in the order the server shows the
// log in: by time, then by number.
const ROWS_SQL = `SELECT e.id, e.tracked_schema_id, e.status, e.source, e.fingerprint, e.detail,
  t.schema_name, t.label, t.connection_id, c.name AS connection_name,
  prev.status AS previous_status, lastfp.fingerprint AS last_fingerprint
FROM public.drift_events e
JOIN public.tracked_schemas t ON t.id = e.tracked_schema_id
LEFT JOIN public.connections c ON c.id = t.connection_id
LEFT JOIN LATERAL (
  SELECT p.status FROM public.drift_events p
  WHERE p.tracked_schema_id = e.tracked_schema_id AND (p.detected_at, p.id) < (e.detected_at, e.id)
  ORDER BY p.detected_at DESC, p.id DESC
  LIMIT 1
) prev ON true
LEFT JOIN LATERAL (
  SELECT f.fingerprint FROM public.drift_events f
  WHERE f.tracked_schema_id = e.tracked_schema_id AND f.fingerprint IS NOT NULL
    AND f.baseline_snapshot_id IS NOT DISTINCT FROM e.baseline_snapshot_id
    AND (f.detected_at, f.id) < (e.detected_at, e.id)
  ORDER BY f.detected_at DESC, f.id DESC
  LIMIT 1
) lastfp ON true
WHERE e.id > $1 AND e.source = 'scheduled'
ORDER BY e.id
LIMIT ${LIMIT}`;

/** Whether PostgreSQL said a table is not there, as before the server first starts. */
function isMissingTable(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "42P01";
}

export class DriftWatcher {
  private readonly query: DriftQuery;
  private readonly intervalMs: number;
  private readonly listeners = new Set<(alerts: DriftAlert[]) => void>();
  /** The newest row when the watcher started. It and the rows before it are never told about. Null until known. */
  private baseline: number | null = null;
  /** The newest row judged so far. */
  private highest = 0;
  /** The rows judged that a look can still read, so that none is told about twice. */
  private readonly seen = new Set<number>();
  private timer: NodeJS.Timeout | null = null;
  /** The look under way, or the last one: each look waits for the one before, so they never overlap. */
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;
  /** Whether reading the drift log failed and has not worked since, so that a failure that keeps happening is logged once. */
  private failing = false;
  /** Whether a row that could not be read has been logged, which happens once. */
  private warnedUnreadable = false;

  constructor(options: DriftWatcherOptions) {
    this.query = options.query;
    this.intervalMs = options.intervalMs ?? INTERVAL_MS;
  }

  /**
   * Notes the newest row there is now, so that only the rows after it are
   * news. The app calls it before its server starts. It never fails: if the
   * log cannot be read now, the first look does this instead.
   */
  async prime(): Promise<void> {
    const newest = await this.readNewest();
    if (newest === null) return;
    this.baseline = newest;
    this.highest = newest;
  }

  /** Calls `listener` with the alerts of each look that found any, until the function it gives back is called. */
  onAlerts(listener: (alerts: DriftAlert[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Looks at the drift log every 30 seconds from now on, until stopped. */
  start(): void {
    if (this.stopped || this.timer !== null) return;
    this.schedule();
  }

  /** Looks at the drift log now, once any look under way has finished. It never fails. */
  poll(): Promise<void> {
    this.queue = this.queue
      .then(() => this.look())
      .catch((error: unknown) => {
        logWarn("Schema Studio could not look for drift.", error);
      });
    return this.queue;
  }

  /** Stops looking, and waits for a look under way to finish. Nothing is told about after this. It never fails. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    await this.queue;
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      void this.poll().then(() => {
        if (!this.stopped) this.schedule();
      });
    }, this.intervalMs);
    // A look that is waiting never keeps the app from quitting.
    this.timer.unref();
  }

  /** The number of the newest row in the drift log, 0 before the server makes it, or null when it could not be read. */
  private async readNewest(): Promise<number | null> {
    let rows: Record<string, unknown>[];
    try {
      rows = await this.query(NEWEST_SQL, []);
    } catch (error) {
      if (isMissingTable(error)) return 0;
      this.problem(error);
      return null;
    }
    const value = rows.length === 0 ? undefined : rows[0].newest;
    // A big number comes as digits.
    const newest = typeof value === "string" && /^[0-9]{1,16}$/.test(value) ? Number(value) : value;
    if (typeof newest !== "number" || !Number.isSafeInteger(newest) || newest < 0) {
      this.problem(new Error(`Expected the newest row of the drift log to be a whole number, but it was ${String(value)}.`));
      return null;
    }
    this.recovered();
    return newest;
  }

  private async look(): Promise<void> {
    if (this.stopped) return;
    if (this.baseline === null) {
      // The start could not see how far the log went, so this look notes
      // that, and the next one reads what came after it.
      await this.prime();
      return;
    }
    const floor = Math.max(this.baseline, this.highest - LOOKBACK);
    let rows: Record<string, unknown>[];
    try {
      rows = await this.query(ROWS_SQL, [floor]);
    } catch (error) {
      if (!isMissingTable(error)) this.problem(error);
      return;
    }
    this.recovered();
    if (this.stopped) return;
    const alerts: DriftAlert[] = [];
    for (const raw of rows) {
      const row = readDriftRow(raw);
      if (row === null) {
        if (!this.warnedUnreadable) logWarn("Schema Studio skipped a row of the drift log that it could not read.");
        this.warnedUnreadable = true;
        continue;
      }
      if (this.seen.has(row.id)) continue;
      this.seen.add(row.id);
      this.highest = Math.max(this.highest, row.id);
      const alert = driftAlert(row);
      if (alert !== null) alerts.push(alert);
    }
    // No look reads the rows at or below the next floor again.
    const nextFloor = Math.max(this.baseline, this.highest - LOOKBACK);
    for (const id of this.seen) {
      if (id <= nextFloor) this.seen.delete(id);
    }
    if (alerts.length > 0) this.emit(alerts);
  }

  private emit(alerts: DriftAlert[]): void {
    for (const listener of this.listeners) {
      try {
        listener(alerts);
      } catch (error) {
        logWarn("Schema Studio could not show a drift alert.", error);
      }
    }
  }

  private problem(error: unknown): void {
    if (this.failing) return;
    this.failing = true;
    logWarn("Schema Studio could not read the drift log, so it cannot tell you about drift for now.", error);
  }

  private recovered(): void {
    if (!this.failing) return;
    this.failing = false;
    logInfo("Schema Studio can read the drift log again.");
  }
}
