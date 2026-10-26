import pool, { syncMetadataTables } from "./version-db";
import { mapWithLimit } from "./concurrency";
import { runDriftCheck, type DriftRecordMode } from "./drift-runner";
import { pruneSchemaMetrics, METRIC_RETENTION_DAYS } from "./schema-metrics";
import type { DriftSource } from "./drift-source";
import {
  isDue,
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
 *   • One loop serves every organization. It reads every organization's
 *     schedule, runs each check inside the organization its schema belongs to,
 *     and tells each organization only what happened to its own schemas.
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

/**
 * What the scheduler is doing, as one organization sees it, for
 * /api/lineage/schedule and the UI.
 */
export type SchedulerStatus = {
  /** False when the loop is not running — disabled, or never started. */
  running: boolean;
  /** Why it is not running, when it is not. Null while it is. */
  stoppedReason: string | null;
  /** Ticks completed since the process started. */
  ticks: number;
  /** This organization's schemas checked by the loop since the process started. */
  checksRun: number;
  /** When the last tick finished, ISO. Null before the first one. */
  lastTickAt: string | null;
  /**
   * What the last tick did for this organization, for a status line that is
   * not just a number.
   */
  lastTickSummary: string | null;
  /** How often the loop wakes, in seconds — the resolution of every cadence. */
  tickSeconds: number;
};

/**
 * What one tick did, kept until somebody asks.
 *
 * One tick checks every organization's due schemas together, and the schedule
 * screen belongs to one organization. A line that added the tick up would tell
 * each organization how much drift and how many unreachable databases the
 * others have. So a tick that got as far as checking keeps one line for each
 * organization, about that organization's schemas only. A tick that stopped
 * before then keeps one shared line about the tick itself, which names nobody's
 * schemas.
 */
export type TickReport =
  | { kind: "shared"; line: string }
  | { kind: "by_org"; byOrg: Map<number, string> };

type SchedulerState = {
  timer: ReturnType<typeof setInterval> | null;
  /** True while a tick is in flight, so a slow tick cannot overlap the next. */
  busy: boolean;
  ticks: number;
  /** Checks the loop has run since the process started, per organization. */
  checksRunByOrg: Map<number, number>;
  lastTickAt: string | null;
  lastTick: TickReport | null;
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
      checksRunByOrg: new Map(),
      lastTickAt: null,
      lastTick: null,
      stoppedReason: null,
      lastPruneAt: null,
    };
  }
  const s = globalThis.__driftSchedulerState;
  // The dev server keeps this object across edits, so one made by an older
  // copy of this file can lack a field added since. Fill those in rather than
  // break the schedule screen until the next restart.
  s.checksRunByOrg ??= new Map();
  s.lastTick ??= null;
  return s;
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

/**
 * A schema on a cadence, with the organization it belongs to. The check runs
 * inside that organization, so it can only read and write that one's rows.
 */
type ScheduledSchema = DriftScheduleEntry & { orgId: number };

/**
 * Every tracked schema on a cadence, in every organization, reduced to what
 * scheduling depends on.
 *
 * Across all organizations on purpose: there is one loop per process and one
 * MAX_PER_TICK, so the most overdue schema goes first whoever owns it.
 */
async function loadEntries(): Promise<ScheduledSchema[]> {
  const result = await pool.query<{
    id: number;
    org_id: number;
    drift_check_interval_minutes: number | null;
    last_drift_check_at: string | null;
  }>(
    `-- every organization: one schedule serves them all, and each check is then
     -- run inside the organization its schema belongs to
     SELECT id, org_id, drift_check_interval_minutes, last_drift_check_at
       FROM tracked_schemas
      WHERE drift_check_interval_minutes > 0`
  );
  return result.rows.map((row) => ({
    orgId: row.org_id,
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
 * One pass: find what is due, check it, and write down what happened.
 *
 * Never throws. A failed tick is written down like any other, so it reads as a
 * state on the schedule screen rather than a crash.
 */
export async function runSchedulerTick(now: Date = new Date()): Promise<TickReport> {
  const report = await checkWhatIsDue(now);
  const s = state();
  s.ticks += 1;
  s.lastTickAt = new Date().toISOString();
  s.lastTick = report;
  return report;
}

/** The work of one tick, for runSchedulerTick to write down. */
async function checkWhatIsDue(now: Date): Promise<TickReport> {
  const s = state();
  if (s.busy) {
    return { kind: "shared", line: "Skipped — the previous tick was still running." };
  }
  s.busy = true;
  let lock: TickLock | null = null;
  try {
    // `s.busy` above is a variable in this process, so it says nothing about
    // the copy of the app running next to this one. Two replicas — or a
    // `next dev` left open beside a `next start`, which is the version of this
    // that happens on a laptop — each run the whole schedule against the one
    // metadata database, so every schema is introspected twice a cadence and
    // every "always" drift event is written twice. The database is the only
    // thing both copies can see, so the agreement about whose turn it is has to
    // be made there.
    lock = await takeTickLock();
    if (!lock) {
      return {
        kind: "shared",
        line: "Skipped — another copy of the app is running this tick.",
      };
    }

    await syncMetadataTables();
    const entries = await loadEntries();
    const due = selectDue(entries, now, MAX_PER_TICK);
    await pruneIfDue(now);

    const outcomes = await mapWithLimit(due, CHECK_CONCURRENCY, async (entry) => {
      // "on_change" so a quarter-hourly "still fine" does not push a day of
      // real events out of the audit feed. The check is still stamped.
      const result = await runDriftCheck(
        entry.orgId,
        entry.trackedSchemaId,
        "scheduled",
        "on_change"
      );
      return result.ok ? result.run.status : `problem:${result.problem.kind}`;
    });

    const checked = due.map((entry, index) => ({ entry, outcome: outcomes[index] }));
    for (const { entry } of checked) {
      s.checksRunByOrg.set(entry.orgId, (s.checksRunByOrg.get(entry.orgId) ?? 0) + 1);
    }

    const byOrg = new Map<number, string>();
    for (const orgId of new Set(entries.map((entry) => entry.orgId))) {
      byOrg.set(
        orgId,
        orgTickLine(
          entries.filter((entry) => entry.orgId === orgId),
          checked.filter((item) => item.entry.orgId === orgId),
          now
        )
      );
    }
    return { kind: "by_org", byOrg };
  } catch (error) {
    // The message stays in the server's log. It can come from any
    // organization's check (a database error naming that organization's host,
    // say), and the line below is shown to every organization.
    const message = error instanceof Error ? error.message : String(error);
    console.error("Drift scheduler — tick failed:", message);
    return {
      kind: "shared",
      line: "Tick failed. The server's log says why, and the next tick tries again.",
    };
  } finally {
    if (lock) await releaseTickLock(lock);
    s.busy = false;
  }
}

/**
 * One organization's line about a tick: how many of its own schemas were
 * checked, and what the checks found.
 *
 * `entries` are the organization's schemas on a cadence, and `checked` the ones
 * this tick ran. A schema can be due and still not checked: the tick stops at
 * MAX_PER_TICK, most overdue first across every organization, and the next
 * tick picks up the rest.
 */
function orgTickLine(
  entries: ScheduledSchema[],
  checked: Array<{ entry: ScheduledSchema; outcome: string }>,
  now: Date
): string {
  const waiting = entries.filter(
    (entry) => isDue(entry, now) && !checked.some((item) => item.entry === entry)
  ).length;
  if (checked.length === 0 && waiting === 0) {
    const watched = entries.length;
    return `Nothing due — ${watched} schema${watched === 1 ? "" : "s"} on a cadence.`;
  }
  if (checked.length === 0) return `${waiting} due, waiting for the next tick.`;

  const count = (outcome: string) => checked.filter((item) => item.outcome === outcome).length;
  const drifted = count("drifted");
  const unreachable = count("unreachable");
  const problems = checked.filter((item) => item.outcome.startsWith("problem:")).length;
  const parts = [`Checked ${checked.length}`];
  if (drifted > 0) parts.push(`${drifted} drifted`);
  if (unreachable > 0) parts.push(`${unreachable} unreachable`);
  if (problems > 0) parts.push(`${problems} could not run`);
  if (waiting > 0) parts.push(`${waiting} more waiting for the next tick`);
  return `${parts.join(" · ")}.`;
}

/** A held tick lock: the one connection it lives on, which has to unlock it. */
type TickLock = { client: Awaited<ReturnType<typeof pool.connect>> };

/**
 * The tick lock's key.
 *
 * Two hashtext() values, the same spelling lib/family-lock uses, so every
 * advisory lock this app takes reads the same way in pg_locks. That two-integer
 * form is also a different lock space from the single-bigint
 * `pg_advisory_xact_lock($trackedSchemaId)` the deploy and re-baseline paths
 * take, so this can never accidentally block one of those — or be blocked by
 * one, which would be worse.
 */
const TICK_LOCK_KEY = ["drift-scheduler", "tick"];

/**
 * Claim this tick for this process, or find that another copy has it.
 *
 * `pg_try_advisory_lock` rather than the waiting kind: a tick that queued behind
 * another copy's tick would run the moment it finished and check everything all
 * over again, which is the doubling this is here to prevent. Not getting the
 * lock is a complete answer — the other copy is doing the work.
 *
 * Session-scoped rather than transaction-scoped, so the tick does not have to
 * hold a transaction open on the metadata database for a minute. The safety
 * that buys a transaction is kept a different way: PostgreSQL drops every
 * advisory lock a session held the moment that session ends, so a process that
 * is killed mid-tick releases this on the way out and does not wedge the
 * schedule for everybody else.
 *
 * Returns null on any failure, including a database that is simply not there.
 * A scheduler that stops checking because it could not take a lock would turn
 * a brief outage into a silent permanent one.
 */
async function takeTickLock(): Promise<TickLock | null> {
  let client: Awaited<ReturnType<typeof pool.connect>>;
  try {
    client = await pool.connect();
  } catch (error) {
    console.error("Drift scheduler — could not reach the metadata database:", error);
    return null;
  }
  try {
    const held = await client.query<{ taken: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS taken`,
      TICK_LOCK_KEY
    );
    if (held.rows[0]?.taken === true) return { client };
  } catch (error) {
    console.error("Drift scheduler — could not take the tick lock:", error);
  }
  // Not ours: hand the connection straight back rather than holding one of the
  // five for a tick that is not going to do anything.
  client.release();
  return null;
}

/**
 * Give the tick back, on the same connection that took it.
 *
 * The unlock has to run on that connection — a session lock belongs to a
 * session, and `pool.query` would pick whichever one is free. Releasing without
 * unlocking would hand a connection that still holds the lock back to the pool,
 * where it would sit holding it for as long as the pool keeps it alive, and no
 * copy of the app would ever tick again.
 */
async function releaseTickLock(lock: TickLock): Promise<void> {
  try {
    await lock.client.query(
      `SELECT pg_advisory_unlock(hashtext($1), hashtext($2))`,
      TICK_LOCK_KEY
    );
  } catch (error) {
    // The only realistic cause is a connection that has already broken, and a
    // broken session has had its locks released by the server anyway.
    console.error("Drift scheduler — could not release the tick lock:", error);
  } finally {
    lock.client.release();
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

  // runSchedulerTick never throws and writes down what it did itself, so
  // nothing here waits for it.
  s.timer = setInterval(() => void runSchedulerTick(), TICK_MS);
  // Do not hold the process open for a timer whose job is optional. Without
  // this, `next build` and every test runner would hang for a minute at exit.
  s.timer.unref?.();

  // Run one immediately rather than making the first schema wait a minute for
  // a cadence it is already overdue for.
  void runSchedulerTick();

  console.log(`Drift scheduler — started, waking every ${TICK_MS / 1000}s.`);
}

/** Stop the loop. Only used by tests and by a deliberate restart. */
export function stopDriftScheduler(): void {
  const s = state();
  if (s.timer) clearInterval(s.timer);
  s.timer = null;
  s.stoppedReason = "Stopped.";
}

/**
 * What the loop is doing right now, as organization `orgId` sees it.
 *
 * Whether it runs, how often it wakes and when it last did are the same for
 * everyone, and say nothing about anyone's schemas. The count and the last
 * tick's line are this organization's own: see TickReport for why.
 */
export function driftSchedulerStatus(orgId: number): SchedulerStatus {
  const s = state();
  return {
    running: s.timer !== null,
    stoppedReason: s.timer !== null ? null : (s.stoppedReason ?? "Not started."),
    ticks: s.ticks,
    checksRun: s.checksRunByOrg.get(orgId) ?? 0,
    lastTickAt: s.lastTickAt,
    lastTickSummary: lastTickLine(s.lastTick, orgId),
    tickSeconds: TICK_MS / 1000,
  };
}

/** The last tick's line for one organization, or null before the first tick. */
function lastTickLine(report: TickReport | null, orgId: number): string | null {
  if (!report) return null;
  if (report.kind === "shared") return report.line;
  // Not among the tick's lines: none of this organization's schemas is on a
  // cadence, so the tick had nothing of theirs to look at.
  return (
    report.byOrg.get(orgId) ?? "Nothing scheduled — no tracked schema has an automatic cadence."
  );
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
 *
 * `orgId` is the organization of the person who asked, which owns the schema.
 */
export function requestImmediateCheck(
  orgId: number,
  trackedSchemaId: number,
  source: DriftSource = "tracking",
  mode: DriftRecordMode = "always"
): void {
  if (disabledReason()) return;
  void runDriftCheck(orgId, trackedSchemaId, source, mode).catch((error) => {
    console.error("Drift scheduler — immediate check failed:", error);
  });
}
