// Time limits for deploy and rollback runs, and the Stop button that ends one
// early. Used by app/api/scripts/apply, app/api/scripts/revert and
// app/api/scripts/cancel.
//
// A run is one transaction on a connection of its own, and three limits keep
// it from holding that connection for good:
//
//   - statement_timeout, the longest one statement may take;
//   - the whole-run limit, kept by a timer in this server, which cancels the
//     run's statement once the run as a whole has gone on too long;
//   - idle_in_transaction_session_timeout, so that a run whose server died
//     part way does not leave its locks behind: the database ends the session
//     once it has sat silent that long.
//
// All three are set inside the run's transaction, never on the session. A
// transaction pooler hands the session to someone else once the transaction
// ends, and a session setting would go with it.
//
// The limits are generous on purpose. A real deploy may rebuild a big table
// or an index, so one statement may take half an hour and the whole run an
// hour. They are there only so that a statement like pg_sleep(100000), or a
// query that never finishes, cannot hold a connection forever. A dry run's
// are shorter.
//
// How Stop works. Each run names its session after its run id
// (application_name "schema-studio run <id>") and notes its backend pid. Stop
// calls pg_cancel_backend on it from a second, short connection out of the
// same pool, so under the same login, which PostgreSQL allows for one's own
// sessions. The statement fails with "canceling statement due to user
// request", the run rolls back, and its answer says it was stopped. The run
// is looked up in a list kept in this server process; a Stop that reaches
// another instance of the app (Vercel runs several) finds the session in
// pg_stat_activity by its name instead. A run that has begun its COMMIT is
// never cancelled: by then it is too late, and Stop says so.
//
// A script that renames its own session (SET application_name) hides it from
// Stop and from the whole-run timer, though statement_timeout still ends each
// of its statements.

import type { Pool, PoolClient } from "pg";

export type RunKind = "deploy" | "rollback";
/** Why a run is being stopped: the Stop button, or its whole-run limit. */
export type StopReason = "cancelled" | "run_limit";

export type RunLimits = {
  /** The longest one statement may take (statement_timeout). */
  statementMs: number;
  /** The longest the whole run may take, kept by a timer in this server. */
  runMs: number;
  /** How long the run may sit inside its transaction sending nothing. */
  idleInTransactionMs: number;
};

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** A real deploy or rollback. */
export const REAL_RUN_LIMITS: RunLimits = {
  statementMs: 30 * MINUTE,
  runMs: HOUR,
  idleInTransactionMs: 5 * MINUTE,
};

/** A dry run, which is thrown away whatever happens. */
export const DRY_RUN_LIMITS: RunLimits = {
  statementMs: 5 * MINUTE,
  runMs: 15 * MINUTE,
  idleInTransactionMs: 5 * MINUTE,
};

/** The limits one run goes by. */
export function runLimits(run: { dryRun: boolean }): RunLimits {
  return run.dryRun ? DRY_RUN_LIMITS : REAL_RUN_LIMITS;
}

/** How often Stop tries again while the run is between two statements. */
const CANCEL_RETRY_MS = 2 * SECOND;
/** The longest the cancel connection's one query may take. */
const CANCEL_STATEMENT_TIMEOUT_MS = 10 * SECOND;

/** "canceling statement due to statement timeout", or "due to user request". */
export const QUERY_CANCELED = "57014";
/** "terminating connection due to administrator command". */
const ADMIN_SHUTDOWN = "57P01";
/** "terminating connection due to idle-in-transaction timeout". */
const IDLE_IN_TRANSACTION_TIMEOUT = "25P03";

/** Every run's session name starts with this, and its run id follows. */
export const APPLICATION_NAME_PREFIX = "schema-studio run ";

/** One run's session name: 54 characters, inside PostgreSQL's 63. */
export function runApplicationName(runId: string): string {
  return `${APPLICATION_NAME_PREFIX}${runId}`;
}

export const DUPLICATE_RUN_MESSAGE =
  "A run with this id is already going. Reload the page and try again.";

// ─── The runs going in this server process ─────────────────────────────────

export type RunEntry = {
  runId: string;
  orgId: number;
  connectionId: number;
  /** Who started it (actorFor), so that they may stop it. */
  actor: string;
  kind: RunKind;
  /** The pool the run's connection came from. Stop borrows a second one from it. */
  pool: Pool;
  /** The run's backend pid, once its transaction has begun. */
  pid: number | null;
  startedAt: number;
  /** Set once the run is about to send COMMIT: too late to stop it then. */
  committing: boolean;
  /** Set once the run has ended, one way or the other. */
  done: boolean;
  /** Set once Stop or the whole-run limit has fired. */
  stopReason: StopReason | null;
  /** The whole-run timer, and later the timer that tries the cancel again. */
  timer: ReturnType<typeof setTimeout> | null;
};

export type RunDetails = Pick<
  RunEntry,
  "runId" | "orgId" | "connectionId" | "actor" | "kind" | "pool"
>;

declare global {
  // Kept on globalThis so that a development reload of this module does not
  // lose the runs already going.
  var __schemaStudioRuns: Map<string, RunEntry> | undefined;
}

function registry(): Map<string, RunEntry> {
  if (!globalThis.__schemaStudioRuns) globalThis.__schemaStudioRuns = new Map();
  return globalThis.__schemaStudioRuns;
}

/** A timer that does not keep the process alive on its own. */
function quietTimer(callback: () => void, ms: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(callback, ms);
  const handle: unknown = timer;
  (handle as { unref?: () => void }).unref?.();
  return timer;
}

/**
 * Note a run as going and start its whole-run timer. "duplicate" when a run
 * with that id is already going here.
 */
export function registerRun(details: RunDetails, limits: RunLimits): RunEntry | "duplicate" {
  const runs = registry();
  if (runs.has(details.runId)) return "duplicate";
  const entry: RunEntry = {
    ...details,
    pid: null,
    startedAt: Date.now(),
    committing: false,
    done: false,
    stopReason: null,
    timer: null,
  };
  entry.timer = quietTimer(() => {
    stopRun(entry, "run_limit");
  }, limits.runMs);
  runs.set(details.runId, entry);
  return entry;
}

/** The run has ended: forget it and stop its timers. Safe to call twice. */
export function unregisterRun(entry: RunEntry): void {
  entry.done = true;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
  const runs = registry();
  if (runs.get(entry.runId) === entry) runs.delete(entry.runId);
}

/** The run with this id going in this server process, or null. */
export function findRun(runId: string): RunEntry | null {
  return registry().get(runId) ?? null;
}

/** The stop the run's next step throws, so that it goes no further. */
export class RunStoppedError extends Error {
  readonly reason: StopReason;

  constructor(reason: StopReason) {
    super(reason === "cancelled" ? "The run was stopped, as asked." : "The run took longer than it may.");
    this.name = "RunStoppedError";
    this.reason = reason;
  }
}

/** Throws RunStoppedError once Stop or the whole-run limit has fired. */
export function throwIfStopped(entry: RunEntry | null): void {
  if (entry?.stopReason) throw new RunStoppedError(entry.stopReason);
}

/**
 * Stop a run: its next step throws, and its statement is cancelled now and
 * again every two seconds, since a cancel that lands between two statements
 * is lost. False when it is too late (the run has ended, or begun its
 * COMMIT). Pressing it twice is the same as once.
 */
export function stopRun(entry: RunEntry, reason: StopReason): boolean {
  if (entry.done || entry.committing) return false;
  if (entry.stopReason) return true;
  entry.stopReason = reason;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
  void keepCancelling(entry);
  return true;
}

async function keepCancelling(entry: RunEntry): Promise<void> {
  if (entry.done || entry.committing) return;
  try {
    await cancelRunStatement(entry.pool, entry.runId, entry.pid);
  } catch (error) {
    console.error("Could not cancel a run's statement:", error instanceof Error ? error.message : "unknown error");
  }
  if (entry.done || entry.committing) return;
  entry.timer = quietTimer(() => {
    void keepCancelling(entry);
  }, CANCEL_RETRY_MS);
}

/**
 * Call right before the run's COMMIT. Throws if the run was stopped first;
 * otherwise marks it as committing, so that Stop answers "too late" from now
 * on. Both happen in one go, so on this server a stopped run never commits.
 */
export function beginCommit(entry: RunEntry): void {
  throwIfStopped(entry);
  entry.committing = true;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
}

// ─── The run's connection ──────────────────────────────────────────────────

/**
 * Listen for errors on a run's checked-out connection, and keep the first.
 *
 * A checked-out connection has no "error" listener of its own, and without one
 * the database ending the session while the run waits between two queries (its
 * idle limit, an administrator) would crash the whole server. pg then reports
 * two errors, one after the other (checked on PostgreSQL 18): the database's
 * own reason, with its SQLSTATE code (25P03 for the idle limit), and then
 * "Connection terminated unexpectedly", which has no code. Only the first says
 * why, so it is the one kept. The listener is never taken off: such a
 * connection is closed afterwards, not handed back to the pool.
 *
 * Returns a function that gives the error kept, or null while there is none.
 */
export function keepFirstClientError(client: Pick<PoolClient, "on">): () => unknown {
  let first: unknown = null;
  client.on("error", (error: Error) => {
    if (first === null) first = error;
  });
  return () => first;
}

// ─── Inside the run's transaction ──────────────────────────────────────────

/**
 * Name the session after the run and give it its idle limit, right after
 * BEGIN. Both are set with set_config(..., true), so they last only this
 * transaction. Returns the session's backend pid, for Stop.
 */
export async function prepareRunTransaction(
  client: PoolClient,
  runId: string,
  limits: RunLimits
): Promise<number | null> {
  const { rows } = await client.query<{ pid: unknown }>(
    `SELECT set_config('application_name', $1, true),
            set_config('idle_in_transaction_session_timeout', $2, true),
            pg_backend_pid() AS pid`,
    [runApplicationName(runId), String(limits.idleInTransactionMs)]
  );
  // Lets the database notice that this server has gone away while a long
  // statement runs, and end it then rather than at its time limit. Only
  // PostgreSQL 14 and later know the setting, and Windows refuses it, so it
  // is tried in a savepoint and the run goes on without it when refused.
  try {
    await client.query(
      "SAVEPOINT run_check_interval; " +
        "SELECT set_config('client_connection_check_interval', '10000', true); " +
        "RELEASE SAVEPOINT run_check_interval"
    );
  } catch {
    await client.query("ROLLBACK TO SAVEPOINT run_check_interval; RELEASE SAVEPOINT run_check_interval");
  }
  const pid = rows[0]?.pid;
  return typeof pid === "number" ? pid : null;
}

// ─── Cancelling a run's statement ──────────────────────────────────────────

/**
 * What a cancel found: the run's statement cancelled, the run between two
 * statements (nothing to cancel just then), the run committing (left alone),
 * or no session of that run at all.
 */
export type CancelOutcome = "cancelled" | "idle" | "committing" | "not_found";

const IS_COMMIT = "query ~* '^[[:space:]]*commit([^[:alnum:]_]|$)'";

/**
 * Cancel the statement a run's session is running, from a second connection
 * out of the same pool. The session is found by its name, and by its pid as
 * well when known, so a pid that has since gone to another session is never
 * touched.
 */
export async function cancelRunStatement(
  pool: Pool,
  runId: string,
  pid: number | null
): Promise<CancelOutcome> {
  const client = await pool.connect();
  // A checked-out connection has no error listener, and an error event with
  // none would crash the server. This one goes back to the pool, so the
  // listener comes off again first.
  const onError = (error: Error) => {
    console.error("The connection that cancels a run failed:", error.message);
  };
  client.on("error", onError);
  let broken = false;
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL statement_timeout = ${CANCEL_STATEMENT_TIMEOUT_MS}`);
    const { rows } = await client.query<{
      state: string | null;
      committing: boolean | null;
      cancelled: boolean | null;
    }>(
      `SELECT pid, state, (${IS_COMMIT}) AS committing,
              CASE WHEN state = 'active' AND NOT (${IS_COMMIT})
                   THEN pg_cancel_backend(pid) ELSE false END AS cancelled
         FROM pg_stat_activity
        WHERE application_name = $1 AND usename = current_user
          AND datname = current_database() AND pid <> pg_backend_pid()
          AND ($2::int IS NULL OR pid = $2::int)`,
      [runApplicationName(runId), pid]
    );
    await client.query("COMMIT");
    if (rows.length === 0) return "not_found";
    if (rows.some((row) => row.cancelled === true)) return "cancelled";
    if (rows.some((row) => row.state === "active" && row.committing === true)) return "committing";
    return "idle";
  } catch (error) {
    broken = true;
    throw error;
  } finally {
    client.off("error", onError);
    if (broken) client.release(true);
    else client.release();
  }
}

/**
 * Stop a run that is going on another instance of the app, where its timer
 * and its list entry are out of reach. Tries a few times a moment apart,
 * since a run between two statements has nothing to cancel just then.
 */
export async function cancelRunElsewhere(
  pool: Pool,
  runId: string,
  tries = 8,
  gapMs = 250
): Promise<CancelOutcome> {
  for (let attempt = 1; ; attempt += 1) {
    const outcome = await cancelRunStatement(pool, runId, null);
    if (outcome !== "idle" || attempt >= tries) return outcome;
    await new Promise((resolve) => setTimeout(resolve, gapMs));
  }
}

// ─── What a stopped run says ───────────────────────────────────────────────

/** 1 hour, 30 minutes, 45 seconds. */
export function formatLimit(ms: number): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (ms >= HOUR && ms % HOUR === 0) return plural(ms / HOUR, "hour");
  if (ms >= MINUTE && ms % MINUTE === 0) return plural(ms / MINUTE, "minute");
  return plural(Math.round(ms / SECOND), "second");
}

export type StopContext = {
  kind: RunKind;
  dryRun: boolean;
  limits: RunLimits;
  /** The step that was running, such as `Version 3 of "orders"`, or null. */
  subject: string | null;
};

function sqlStateOf(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

/**
 * The answer for a run that ended because of a time limit, the Stop button or
 * the database ending its session, or null when it ended some other way.
 * `errors` is what the run threw, then any error its connection reported on
 * its own: the database ending an idle session says so between queries.
 */
export function runStopMessage(errors: unknown[], entry: RunEntry | null, ctx: StopContext): string | null {
  const kindWord = ctx.kind;
  const runWord = ctx.dryRun ? "dry run" : kindWord;
  const where = ctx.dryRun ? "in a dry run" : `in a ${kindWord}`;
  const whoMay = ctx.dryRun ? "a dry run" : `a ${kindWord}`;
  const outcome = ctx.dryRun
    ? "Nothing was changed."
    : ctx.kind === "deploy"
      ? "Nothing was applied."
      : "Nothing was changed, and every version in this rollback is still applied.";

  const statementLimit = () => {
    const who = ctx.subject ? `${ctx.subject} had a statement that` : "A statement";
    let text =
      `${who} ran longer than ${formatLimit(ctx.limits.statementMs)}, the most one statement ` +
      `may take ${where}, so the ${runWord} was stopped. ${outcome}`;
    if (ctx.dryRun) {
      text +=
        ` A real ${kindWord} allows each statement ${formatLimit(REAL_RUN_LIMITS.statementMs)}, ` +
        `so the script may still be fine, only slow on this much data.`;
    }
    return text;
  };
  const runLimit = () =>
    `This ${runWord} took longer than ${formatLimit(ctx.limits.runMs)}, the most ${whoMay} ` +
    `may take, so it was stopped. ${outcome}`;
  const cancelled = () => `This ${runWord} was stopped, as asked. ${outcome}`;

  for (const error of errors) {
    if (error instanceof RunStoppedError) {
      return error.reason === "cancelled" ? cancelled() : runLimit();
    }
    const code = sqlStateOf(error);
    if (code === QUERY_CANCELED) {
      const message = error instanceof Error ? error.message : "";
      if (/statement timeout/i.test(message)) return statementLimit();
      if (entry?.stopReason === "cancelled") return cancelled();
      if (entry?.stopReason === "run_limit") return runLimit();
      return (
        `A statement in this ${runWord} was cancelled from outside it, by the Stop button or ` +
        `by another database session, so the ${runWord} was stopped. ${outcome}`
      );
    }
    if (code === IDLE_IN_TRANSACTION_TIMEOUT) {
      return (
        `This ${runWord} sat inside its transaction without sending anything for longer than ` +
        `${formatLimit(ctx.limits.idleInTransactionMs)}, so the database ended its session. ${outcome}`
      );
    }
    if (code === ADMIN_SHUTDOWN) {
      return (
        `The database ended this ${runWord}'s session (an administrator, or another session, ` +
        `stopped it). ${outcome}`
      );
    }
  }
  return null;
}
