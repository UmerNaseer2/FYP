import { randomUUID } from "node:crypto";
import { after } from "next/server";
import pool, { syncMetadataTables } from "./version-db";
import { mapWithLimit } from "./concurrency";
import { runDriftCheck, type DriftRecordMode } from "./drift-runner";
import { alertDriftChange } from "./push-alerts";
import { pruneSchemaMetrics, METRIC_RETENTION_DAYS } from "./schema-metrics";
import { sweepAgentRows } from "./agent-db";
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
 * page. Something wakes this every so often (each minute, on most hosts), it
 * asks lib/drift-schedule which schemas are due, and it runs the same check the
 * button runs.
 *
 * What wakes it depends on where the app runs (see schedulerMode):
 *
 *   • A timer in the server itself, started from instrumentation.ts, wherever a
 *     process stays up: Docker, the desktop app, `npm run dev`. No cron and no
 *     queue there, because this has to be runnable with `npm run dev` and
 *     nothing else.
 *   • A scheduled call to /api/internal/drift-tick on a serverless host, where a
 *     process lives only while requests come in and a timer has nothing to run in.
 *
 * It is deliberately the smallest thing that can be honest:
 *
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
 *   • Copies of the app agree through one row in the database, a lease with an
 *     expiry, so only one runs a tick and a dead copy cannot stop the schedule.
 */

/** How often this server's own timer wakes the loop. Not the cadence: that is per schema. */
const TICK_MS = 60_000;

/**
 * Most schemas checked in one tick.
 *
 * Each check introspects a whole remote schema, so this is a limit on how much
 * of somebody else's database this app is willing to read per tick. The rest
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
 * How long a copy of the app holds the tick before others may take it over, in
 * seconds, and how often it renews that while it is still working. The gap is
 * what a dead or frozen copy costs: ticks skip for up to this long, then the
 * schedule carries on without it.
 */
const LEASE_SECONDS = 180;
const LEASE_RENEW_MS = 30_000;

/** The one row of drift_scheduler_state. */
const STATE_ROW = "tick";

/**
 * The least time since a tick for scheduled calls to still count as arriving.
 * A missed call or two is not news, so a few minutes, not one. A slower schedule
 * waits longer: see recentCallMinutes.
 */
const RECENT_CALL_MINUTES = 5;

/**
 * The longest gap DRIFT_CALL_MINUTES may name, a day. Beyond that no cadence on
 * offer could be kept, so it is more likely a typo than a schedule.
 */
const MAX_CALL_MINUTES = 1440;

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
  /**
   * This organization's schemas checked by the loop since the process started.
   * Null when calls from outside wake it, because each instance would have a
   * count of its own.
   */
  checksRun: number | null;
  /** When the last tick finished, ISO. Null before the first one. */
  lastTickAt: string | null;
  /**
   * What the last tick did for this organization, for a status line that is
   * not just a number.
   */
  lastTickSummary: string | null;
  /** How often the loop wakes, in seconds — the resolution of every cadence. */
  tickSeconds: number;
  /** True when a scheduled call from outside wakes the checker, not a timer here. */
  external: boolean;
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

/** A TickReport as the database keeps it, where a Map cannot go. */
type StoredReport =
  | { kind: "shared"; line: string }
  | { kind: "by_org"; byOrg: Record<string, string> };

function toStored(report: TickReport): StoredReport {
  return report.kind === "shared"
    ? report
    : { kind: "by_org", byOrg: Object.fromEntries(report.byOrg) };
}

const TICK_FAILED: TickReport = {
  kind: "shared",
  line: "Tick failed. The server's log says why, and the next tick tries again.",
};

type SchedulerState = {
  timer: ReturnType<typeof setInterval> | null;
  /** True while a tick is in flight, so a slow tick cannot overlap the next. */
  busy: boolean;
  ticks: number;
  /** Checks the loop has run since the process started, per organization. */
  checksRunByOrg: Map<number, number>;
  stoppedReason: string | null;
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
      stoppedReason: null,
    };
  }
  const s = globalThis.__driftSchedulerState;
  // The dev server keeps this object across edits, so one made by an older
  // copy of this file can lack a field added since. Fill those in rather than
  // break the schedule screen until the next restart.
  s.checksRunByOrg ??= new Map();
  return s;
}

/**
 * How the checker gets woken on this server, if at all.
 *
 * DRIFT_SCHEDULER=off is the kill switch: for a demo where nobody wants the app
 * touching a database on its own, and for a build machine where the tracked
 * connections point at hosts that no longer exist.
 *
 * "external" means no timer here: a scheduled call to /api/internal/drift-tick
 * does the waking. It is the default on Vercel because a forgotten variable must
 * not start a timer on serverless, where a process lives only while requests
 * come in and startDriftScheduler would fire a tick at every cold start.
 */
function schedulerMode(): "off" | "external" | "timer" {
  const flag = (process.env.DRIFT_SCHEDULER ?? "").trim().toLowerCase();
  if (flag === "off" || flag === "false" || flag === "0") return "off";
  if (flag === "external" || process.env.VERCEL) return "external";
  return "timer";
}

/**
 * How many minutes apart the scheduled calls come, from DRIFT_CALL_MINUTES.
 *
 * The schedule lives with whatever makes the calls, so this server cannot see it,
 * and without being told it could not tell a slow schedule from calls that have
 * stopped. A free hosting plan needs the slow one: deploy/SUPABASE-VERCEL.md says
 * why. Anything that is not a whole number of minutes reads as the usual minute.
 */
function callMinutes(): number {
  const minutes = Number(process.env.DRIFT_CALL_MINUTES);
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= MAX_CALL_MINUTES ? minutes : 1;
}

/** How recently a tick must have happened for scheduled calls to count as arriving. */
function recentCallMinutes(): number {
  return Math.max(RECENT_CALL_MINUTES, callMinutes() * 3);
}

/**
 * How long before its due time a tick may check a schema, in milliseconds.
 *
 * A check is stamped when it finishes, a few seconds into the tick, so one cadence
 * later the schema falls due a few seconds after the matching tick began. Waiting
 * for the next tick costs under a minute when a timer here does the waking. With
 * calls fifteen minutes apart it would turn "every 15 minutes" into every 30, so a
 * schema due within half a gap goes now rather than nearly a whole gap late.
 */
function earlyMs(): number {
  return schedulerMode() === "external" ? (callMinutes() * 60_000) / 2 : 0;
}

/** Why the checker may not run at all, or null when it may. */
export function disabledReason(): string | null {
  return schedulerMode() === "off" ? "Turned off by DRIFT_SCHEDULER." : null;
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
 * exactly one background loop, and so the kill switch that stops the scheduler
 * stops this too. When it last ran is kept in the row with the lease, by the
 * database's clock, because a serverless instance starts knowing nothing and
 * would otherwise prune on every tick. Stamped before pruning, as a failed prune
 * is not worth retrying every minute. Failure is swallowed inside
 * pruneSchemaMetrics: a tick that could not tidy up has still done its real job,
 * and a later one tries again.
 */
async function pruneIfDue(): Promise<void> {
  const claimed = await pool.query(
    `UPDATE drift_scheduler_state
        SET last_prune_at = now()
      WHERE name = $1
        AND (last_prune_at IS NULL OR last_prune_at < now() - make_interval(secs => $2))
      RETURNING name`,
    [STATE_ROW, PRUNE_EVERY_MS / 1000]
  );
  if (claimed.rows.length === 0) return;
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
  state().ticks += 1;
  return report;
}

/** The work of one tick, for runSchedulerTick to count. */
async function checkWhatIsDue(now: Date): Promise<TickReport> {
  const s = state();
  if (s.busy) {
    return { kind: "shared", line: "Skipped — the previous tick was still running." };
  }
  s.busy = true;
  try {
    // Before the lease: with the database down this reads as a failed tick, not
    // as another copy having the work.
    await syncMetadataTables();
    // `s.busy` above is a variable in this process, so it says nothing about
    // the copy of the app running next to this one. Two replicas — or a
    // `next dev` left open beside a `next start`, which is the version of this
    // that happens on a laptop — each run the whole schedule against the one
    // metadata database, so every schema is introspected twice a cadence and
    // every "always" drift event is written twice. The database is the only
    // thing both copies can see, so the agreement about whose turn it is has to
    // be made there.
    const lease = await takeTickLease();
    if (!lease) {
      return {
        kind: "shared",
        line: "Skipped — another copy of the app is running this tick.",
      };
    }
    let report: TickReport = TICK_FAILED;
    try {
      report = await checkUnderLease(now);
      return report;
    } finally {
      await finishTick(lease, report);
    }
  } catch (error) {
    // The message stays in the server's log. It can come from any
    // organization's check (a database error naming that organization's host,
    // say), and the line below is shown to every organization.
    const message = error instanceof Error ? error.message : String(error);
    console.error("Drift scheduler — tick failed:", message);
    return TICK_FAILED;
  } finally {
    s.busy = false;
  }
}

/** What a tick does once it holds the lease. */
async function checkUnderLease(now: Date): Promise<TickReport> {
  const s = state();
  const entries = await loadEntries();
  const due = selectDue(entries, now, MAX_PER_TICK, earlyMs());
  // A tick that could not tidy up can still do its real job.
  await pruneIfDue().catch((error) => {
    console.error("Drift scheduler — prune failed:", error);
  });
  // Every tick rather than once a day: a linked computer's answers are meant to
  // leave this database soon after they are read.
  await sweepAgentRows().catch((error) => {
    console.error("Drift scheduler — agent sweep failed:", error instanceof Error ? error.name : "unknown error");
  });

  const outcomes = await mapWithLimit(due, CHECK_CONCURRENCY, async (entry) => {
    // "on_change" so a quarter-hourly "still fine" does not push a day of
    // real events out of the audit feed. The check is still stamped.
    const result = await runDriftCheck(
      entry.orgId,
      entry.trackedSchemaId,
      "scheduled",
      "on_change"
    );
    // Only scheduled checks alert: someone who presses Check now is looking at the answer.
    if (result.ok) await alertDriftChange(entry.orgId, result.run);
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
    (entry) => isDue(entry, now, earlyMs()) && !checked.some((item) => item.entry === entry)
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

/** A held lease: who holds it, and the timer keeping it alive. */
type TickLease = { holder: string; renew: ReturnType<typeof setInterval> };

/**
 * Claim this tick for this copy of the app, or find that another copy has it.
 *
 * It does not wait: a tick that queued behind another copy's tick would run the
 * moment it finished and check everything all over again, which is the doubling
 * this is here to prevent. Not getting the lease is a complete answer: the other
 * copy is doing the work.
 *
 * A row with an expiry rather than an advisory lock. A session lock does not
 * survive a transaction pooler, which takes the server connection back between
 * statements. A transaction lock would hold a transaction open on the metadata
 * database for the whole tick. And a frozen serverless instance keeps its socket
 * open, so either lock could hold for a long time and silently stop the schedule,
 * whereas a lease runs out by the database's clock. That is also why a process
 * killed mid-tick does not wedge the schedule for everybody else: ticks skip for
 * at most LEASE_SECONDS, then one takes over.
 */
async function takeTickLease(): Promise<TickLease | null> {
  const holder = randomUUID();
  const taken = await pool.query(
    `INSERT INTO drift_scheduler_state (name, holder, lease_until)
     VALUES ($1, $2, now() + make_interval(secs => $3))
     ON CONFLICT (name) DO UPDATE
       SET holder = EXCLUDED.holder, lease_until = EXCLUDED.lease_until
       WHERE drift_scheduler_state.lease_until IS NULL
          OR drift_scheduler_state.lease_until < now()
     RETURNING holder`,
    [STATE_ROW, holder, LEASE_SECONDS]
  );
  if (taken.rows.length === 0) return null;
  const renew = setInterval(() => void renewTickLease(holder), LEASE_RENEW_MS);
  // Same reason as the loop's timer: this must not hold a process open.
  renew.unref?.();
  return { holder, renew };
}

/** Keep the lease while a long tick is still working. Only ever touches our own row. */
async function renewTickLease(holder: string): Promise<void> {
  try {
    await pool.query(
      `UPDATE drift_scheduler_state
          SET lease_until = now() + make_interval(secs => $3)
        WHERE name = $1 AND holder = $2`,
      [STATE_ROW, holder, LEASE_SECONDS]
    );
  } catch (error) {
    // The lease runs out on its own at worst, and the check carries on.
    console.error("Drift scheduler — could not renew the tick lease:", error);
  }
}

/**
 * Give the tick back and write down what it did, in one statement.
 *
 * A failure only logs, because the lease runs out on its own. A lease lost to
 * another copy (this one froze past its expiry) matches nothing, and that copy's
 * report is the one to keep.
 */
async function finishTick(lease: TickLease, report: TickReport): Promise<void> {
  clearInterval(lease.renew);
  try {
    await pool.query(
      `UPDATE drift_scheduler_state
          SET holder = NULL, lease_until = NULL, last_tick_at = now(), last_report = $2::jsonb
        WHERE name = $3 AND holder = $1`,
      [lease.holder, JSON.stringify(toStored(report)), STATE_ROW]
    );
  } catch (error) {
    console.error("Drift scheduler — could not finish the tick:", error);
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
  if (schedulerMode() === "external") {
    // Nothing to start: a scheduled call to /api/internal/drift-tick does the waking.
    console.log("Drift scheduler — no timer here, a scheduled call wakes it.");
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

/** What the schedule screen says when calls from outside have stopped, or never began. */
function noCallYet(minutes: number): string {
  return (
    `Nothing is checking these schemas on its own: no scheduled call has reached this server in the last ${minutes} minutes. ` +
    "Checks still run when you press Check drift now. deploy/SUPABASE-VERCEL.md shows how to set the call up."
  );
}

/**
 * What the loop is doing right now, as organization `orgId` sees it.
 *
 * The last tick is read from the row with the lease, so every copy of the app
 * shows the same pass, including a serverless instance that has never ticked.
 * Whether it runs, how often it wakes and when it last did are the same for
 * everyone, and say nothing about anyone's schemas. The count and the last
 * tick's line are this organization's own: see TickReport for why.
 *
 * With calls from outside there is no timer here to look at, so "running" means
 * a call arrived recently. An unexpired lease counts too, so that a long tick
 * does not flicker to "not running" halfway.
 */
export async function driftSchedulerStatus(orgId: number): Promise<SchedulerStatus> {
  await syncMetadataTables();
  const s = state();
  const external = schedulerMode() === "external";
  const recentMinutes = recentCallMinutes();
  const result = await pool.query(
    `SELECT last_tick_at, last_report,
            COALESCE(lease_until > now(), false)
              OR COALESCE(now() - last_tick_at < make_interval(mins => $2), false) AS recent
       FROM drift_scheduler_state
      WHERE name = $1`,
    [STATE_ROW, recentMinutes]
  );
  const row = result.rows[0] as
    | { last_tick_at: Date | string | null; last_report: StoredReport | null; recent: boolean }
    | undefined;
  const running = external ? row?.recent === true : s.timer !== null;
  return {
    running,
    stoppedReason: running ? null : external ? noCallYet(recentMinutes) : (s.stoppedReason ?? "Not started."),
    ticks: s.ticks,
    checksRun: external ? null : (s.checksRunByOrg.get(orgId) ?? 0),
    lastTickAt: row?.last_tick_at ? new Date(row.last_tick_at).toISOString() : null,
    lastTickSummary: lastTickLine(row?.last_report ?? null, orgId),
    tickSeconds: external ? callMinutes() * 60 : TICK_MS / 1000,
    external,
  };
}

function lastTickLine(report: StoredReport | null, orgId: number): string | null {
  if (!report) return null;
  if (report.kind === "shared") return report.line;
  // Not among the tick's lines: none of this organization's schemas is on a
  // cadence, so the tick had nothing of theirs to look at.
  return (
    report.byOrg[orgId] ?? "Nothing scheduled — no tracked schema has an automatic cadence."
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
  const check = () =>
    runDriftCheck(orgId, trackedSchemaId, source, mode).catch((error) => {
      console.error("Drift scheduler — immediate check failed:", error);
    });
  // A serverless function can be frozen the moment its response is sent, which
  // would stop a floating check partway, and after() keeps it alive. Only in
  // external mode, because after() throws outside a request.
  if (schedulerMode() === "external") after(check);
  else void check();
}
