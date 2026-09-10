import pool, { syncMetadataTables } from "./version-db";
import { mapWithLimit } from "./concurrency";
import { runDriftCheck, type DriftRecordMode } from "./drift-runner";
import { pruneSchemaMetrics, METRIC_RETENTION_DAYS } from "./schema-metrics";
import type { DriftSource } from "./drift-source";
import {
  normalizeDriftInterval,
  selectDue,
  type DriftScheduleEntry,
} from "./drift-schedule";

/**
 * The background loop that makes "continuously watching for drift" true.
 *
 * Until this existed, every drift check in the app was a button press, and the
 * only thing watching a tracked schema was the user remembering to open the
 * page. This is one interval timer in the Node process, started from
 * instrumentation.ts, that wakes once a minute, asks lib/drift-schedule which
 * schemas are due, and runs the same check the button runs.
 *
 * It is deliberately the smallest thing that can be honest:
 *
 *   • No cron, no queue, no worker process. One timer, in the server the app
 *     is already running. A queue would be the right answer for many machines
 *     sharing one database, and the wrong answer for a project that has to be
 *     runnable with `npm run dev` and nothing else.
 *   • All the arithmetic — due, overdue, cadence — lives in lib/drift-schedule
 *     where it can be unit-tested without waiting fifteen minutes. Everything
 *     here is I/O and guards.
 *   • Every tick is bounded: at most MAX_PER_TICK schemas, at most
 *     CHECK_CONCURRENCY at a time. A backlog drains over several ticks rather
 *     than opening thirty connections to other people's databases at once.
 *   • It never throws. A tick that fails logs and the next one tries again;
 *     a scheduler that can kill the server is worse than no scheduler.
 */

/** How often the loop wakes. Not the cadence — that is per schema. */
const TICK_MS = 60_000;

/**
 * Most schemas checked in one tick.
 *
 * Each check introspects a whole remote schema, so this is a limit on how much
 * of somebody else's database this app is willing to read per minute. The rest
 * are picked up next tick, most-overdue first, so nothing starves.
 */
const MAX_PER_TICK = 6;

/**
 * How many checks run at once.
 *
 * Two, matching lib/compare-run's target concurrency: the metadata pool holds
 * five connections and a check borrows one at several points, so a wider fan-out
 * would have the scheduler competing with the requests it is supposed to be
 * invisible to.
 */
const CHECK_CONCURRENCY = 2;

/**
 * How often the monitoring readings are pruned.
 *
 * Not every tick: the delete scans an index over ninety days of rows, and doing
 * that once a minute to remove nothing is a cost with no answer attached. Six
 * hours keeps the table inside its window to within a quarter of a day, which
 * is far tighter than any question the trend screen asks.
 */
const PRUNE_EVERY_MS = 6 * 60 * 60 * 1000;

/** What the scheduler is doing, for /api/drift/schedule and the UI. */
export type SchedulerStatus = {
  /** False when the loop is not running — disabled, or never started. */
  running: boolean;
  /** Why it is not running, when it is not. Null while it is. */
  stoppedReason: string | null;
  /** Ticks completed since the process started. */
  ticks: number;
  /** Checks run since the process started. */
  checksRun: number;
  /** When the last tick finished, ISO. Null before the first one. */
  lastTickAt: string | null;
  /** What the last tick did, for a status line that is not just a number. */
  lastTickSummary: string | null;
  /** How often the loop wakes, in seconds — the resolution of every cadence. */
  tickSeconds: number;
};

type SchedulerState = {
  timer: ReturnType<typeof setInterval> | null;
  /** True while a tick is in flight, so a slow tick cannot overlap the next. */
  busy: boolean;
  ticks: number;
  checksRun: number;
  lastTickAt: string | null;
  lastTickSummary: string | null;
  stoppedReason: string | null;
  /** When the monitoring readings were last pruned, ms. Null before the first. */
  lastPruneAt: number | null;
};

declare global {
  var __driftSchedulerState: SchedulerState | undefined;
}

/**
 * One state object per process, parked on globalThis.
 *
 * Next's dev server re-evaluates modules on every edit, so a module-level
 * variable would give us a second timer per save and, an afternoon later, a
 * schema being checked twenty times a minute. Same trick lib/postgres uses for
 * its pool map, and for the same reason.
 */
function state(): SchedulerState {
  if (!globalThis.__driftSchedulerState) {
    globalThis.__driftSchedulerState = {
      timer: null,
      busy: false,
      ticks: 0,
      checksRun: 0,
      lastTickAt: null,
      lastTickSummary: null,
      stoppedReason: null,
      lastPruneAt: null,
    };
  }
  return globalThis.__driftSchedulerState;
}

/**
 * Whether the loop is allowed to run at all.
 *
 * DRIFT_SCHEDULER=off is the kill switch — for a demo where nobody wants the
 * app touching a database on its own, and for a build machine where the tracked
 * connections point at hosts that no longer exist.
 */
function disabledReason(): string | null {
  const flag = (process.env.DRIFT_SCHEDULER ?? "").trim().toLowerCase();
  if (flag === "off" || flag === "false" || flag === "0") {
    return "Turned off by DRIFT_SCHEDULER.";
  }
  return null;
}

/** Every tracked schema, reduced to what scheduling depends on. */
async function loadEntries(): Promise<DriftScheduleEntry[]> {
  const result = await pool.query<{
    id: number;
    drift_check_interval_minutes: number | null;
    last_drift_check_at: string | null;
  }>(
    `SELECT id, drift_check_interval_minutes, last_drift_check_at
       FROM tracked_schemas
      WHERE drift_check_interval_minutes > 0`
  );
  return result.rows.map((row) => ({
    trackedSchemaId: row.id,
    intervalMinutes: normalizeDriftInterval(row.drift_check_interval_minutes),
    lastCheckedAt: row.last_drift_check_at ? new Date(row.last_drift_check_at) : null,
  }));
}

/**
 * Throw away monitoring readings past the retention window, occasionally.
 *
 * Runs inside the tick rather than on a timer of its own, so there is still
 * exactly one background loop in this process — and so the kill switch that
 * stops the scheduler stops this too. Failure is swallowed inside
 * pruneSchemaMetrics: a tick that could not tidy up has still done its real
 * job, and the next one tries again.
 */
async function pruneIfDue(now: Date): Promise<void> {
  const s = state();
  const at = now.getTime();
  if (s.lastPruneAt !== null && at - s.lastPruneAt < PRUNE_EVERY_MS) return;
  s.lastPruneAt = at;
  const removed = await pruneSchemaMetrics(METRIC_RETENTION_DAYS);
  if (removed > 0) {
    console.log(
      `Drift scheduler — pruned ${removed} monitoring reading` +
        `${removed === 1 ? "" : "s"} older than ${METRIC_RETENTION_DAYS} days.`
    );
  }
}

/**
 * One pass: find what is due, check it, write down what happened.
 *
 * Returns a one-line summary rather than throwing, so the caller can put it on
 * a status endpoint and a failed tick reads as a state rather than a crash.
 */
export async function runSchedulerTick(now: Date = new Date()): Promise<string> {
  const s = state();
  if (s.busy) return "Skipped — the previous tick was still running.";
  s.busy = true;
  try {
    await syncMetadataTables();
    const entries = await loadEntries();
    const due = selectDue(entries, now, MAX_PER_TICK);
    await pruneIfDue(now);

    if (due.length === 0) {
      const watched = entries.length;
      return watched === 0
        ? "Nothing scheduled — no tracked schema has an automatic cadence."
        : `Nothing due — ${watched} schema${watched === 1 ? "" : "s"} on a cadence.`;
    }

    const outcomes = await mapWithLimit(due, CHECK_CONCURRENCY, async (entry) => {
      // "on_change" so a quarter-hourly "still fine" does not push a day of
      // real events out of the audit feed. The check is still stamped.
      const result = await runDriftCheck(entry.trackedSchemaId, "scheduled", "on_change");
      return result.ok ? result.run.status : `problem:${result.problem.kind}`;
    });

    s.checksRun += outcomes.length;

    const drifted = outcomes.filter((o) => o === "drifted").length;
    const unreachable = outcomes.filter((o) => o === "unreachable").length;
    const problems = outcomes.filter((o) => String(o).startsWith("problem:")).length;
    const parts = [`Checked ${outcomes.length}`];
    if (drifted > 0) parts.push(`${drifted} drifted`);
    if (unreachable > 0) parts.push(`${unreachable} unreachable`);
    if (problems > 0) parts.push(`${problems} could not run`);
    const backlog = entries.filter((e) => !due.includes(e)).length;
    if (due.length === MAX_PER_TICK && backlog > 0) {
      parts.push(`capped at ${MAX_PER_TICK} — the rest run next tick`);
    }
    return `${parts.join(" · ")}.`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Drift scheduler — tick failed:", message);
    return `Tick failed: ${message}`;
  } finally {
    s.busy = false;
  }
}

/**
 * Start the loop, once per process.
 *
 * Safe to call repeatedly: a second call while a timer already exists does
 * nothing, which is what makes the dev server's module reloading harmless.
 */
export function startDriftScheduler(): void {
  const s = state();
  const reason = disabledReason();
  if (reason) {
    s.stoppedReason = reason;
    console.log(`Drift scheduler — not started. ${reason}`);
    return;
  }
  if (s.timer) return;
  s.stoppedReason = null;

  const tick = async () => {
    const summary = await runSchedulerTick();
    s.ticks += 1;
    s.lastTickAt = new Date().toISOString();
    s.lastTickSummary = summary;
  };

  s.timer = setInterval(() => void tick(), TICK_MS);
  // Do not hold the process open for a timer whose job is optional. Without
  // this, `next build` and every test runner would hang for a minute at exit.
  s.timer.unref?.();

  // Run one immediately rather than making the first schema wait a minute for
  // a cadence it is already overdue for.
  void tick();

  console.log(`Drift scheduler — started, waking every ${TICK_MS / 1000}s.`);
}

/** Stop the loop. Only used by tests and by a deliberate restart. */
export function stopDriftScheduler(): void {
  const s = state();
  if (s.timer) clearInterval(s.timer);
  s.timer = null;
  s.stoppedReason = "Stopped.";
}

/** What the loop is doing right now. */
export function driftSchedulerStatus(): SchedulerStatus {
  const s = state();
  return {
    running: s.timer !== null,
    stoppedReason: s.timer !== null ? null : (s.stoppedReason ?? "Not started."),
    ticks: s.ticks,
    checksRun: s.checksRun,
    lastTickAt: s.lastTickAt,
    lastTickSummary: s.lastTickSummary,
    tickSeconds: TICK_MS / 1000,
  };
}

/**
 * Check one schema now, without waiting for the next tick.
 *
 * Two callers, both of which have just promised the user that checking starts
 * now: the tracking route ("we are watching this schema") and the cadence
 * setting ("checked every 15 minutes"). Waiting up to a minute to make either
 * true would be correct and would still feel broken.
 *
 * Deliberately fire-and-forget: the user is waiting on a response, and if this
 * fails nothing is lost — the schema stays due and the next tick picks it up.
 */
export function requestImmediateCheck(
  trackedSchemaId: number,
  source: DriftSource = "tracking",
  mode: DriftRecordMode = "always"
): void {
  if (disabledReason()) return;
  void runDriftCheck(trackedSchemaId, source, mode).catch((error) => {
    console.error("Drift scheduler — immediate check failed:", error);
  });
}
