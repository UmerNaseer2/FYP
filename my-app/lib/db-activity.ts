/**
 * What the target server is doing right now.
 *
 * Spec feature 10 — "Long-Running Query Detection".
 *
 * This reads `pg_stat_activity`, which is the only place a server says what its
 * other sessions are up to. Three things about that view shape everything here,
 * and each one is a way the screen could lie if it were ignored:
 *
 *   • **The query text is privileged.** An ordinary role sees its OWN sessions'
 *     SQL and gets NULL for everybody else's. So a row with no query text is the
 *     normal case, not an error, and the screen has to say "not visible to this
 *     login" rather than showing a blank and letting it read as an empty query.
 *   • **`state` is not "is it working".** `idle in transaction` is a session
 *     doing nothing at all while holding its locks open, which is usually worse
 *     than a slow query — it blocks other people and stops autovacuum cleaning
 *     up. It is reported here as its own kind rather than filtered out.
 *   • **The clock is the server's.** Duration is computed as `now() - query_start`
 *     ON THE SERVER, not by subtracting from the app's own clock. The app and
 *     the database are routinely minutes apart, and a negative duration on
 *     screen is the giveaway that somebody did that subtraction in the wrong
 *     place.
 *
 * The module holds the SQL and the shaping. The route opens the connection.
 */

/** A session's own connection is never reported — it would always be the newest. */
export const ACTIVITY_SQL = `
  SELECT
    pid,
    usename                                        AS username,
    application_name,
    client_addr::text                              AS client_addr,
    state,
    wait_event_type,
    wait_event,
    backend_type,
    query,
    EXTRACT(EPOCH FROM (now() - query_start))      AS query_seconds,
    EXTRACT(EPOCH FROM (now() - xact_start))       AS xact_seconds,
    EXTRACT(EPOCH FROM (now() - state_change))     AS state_seconds
  FROM pg_stat_activity
  WHERE pid <> pg_backend_pid()
    AND backend_type = 'client backend'
    AND state IS NOT NULL
    AND state <> 'idle'
  ORDER BY query_start ASC NULLS LAST
  LIMIT 200
`;

/** One row of ACTIVITY_SQL, before shaping. Every field can come back null. */
export type ActivityRow = {
  pid: number;
  username: string | null;
  application_name: string | null;
  client_addr: string | null;
  state: string | null;
  wait_event_type: string | null;
  wait_event: string | null;
  backend_type: string | null;
  query: string | null;
  query_seconds: string | number | null;
  xact_seconds: string | number | null;
  state_seconds: string | number | null;
};

/**
 * What kind of problem a session is, if any.
 *
 * Ordered by how much somebody should care, worst first — `blocked` outranks
 * `long-running` because a blocked session is somebody ELSE's fault and there
 * is a second session to go and find.
 */
export type ActivityKind = "blocked" | "idle-in-transaction" | "long-running" | "running";

export const ACTIVITY_KIND_LABEL: Record<ActivityKind, string> = {
  blocked: "Waiting for a lock",
  "idle-in-transaction": "Idle in a transaction",
  "long-running": "Long-running",
  running: "Running",
};

/** One session, shaped for the screen. */
export type ActivitySession = {
  pid: number;
  kind: ActivityKind;
  /** How long it has been on this statement, in seconds. Null if never started. */
  querySeconds: number | null;
  /** How long its transaction has been open. Null when not in one. */
  xactSeconds: number | null;
  username: string | null;
  applicationName: string | null;
  clientAddr: string | null;
  state: string;
  /** "Lock: transactionid", or null when it is not waiting on anything. */
  waitingOn: string | null;
  /**
   * The SQL, or null when this login is not allowed to see it. The screen must
   * distinguish the two — see the note at the top of this file.
   */
  query: string | null;
  /** True when the text was withheld by the server rather than absent. */
  queryHidden: boolean;
};

/**
 * PostgreSQL hands a numeric/interval back as a string through node-postgres,
 * to avoid losing precision. Everything here wants a number.
 */
function toSeconds(value: string | number | null): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The text a server uses when it will not show a query.
 *
 * Postgres writes `<insufficient privilege>` into the column rather than NULL
 * for a session the caller may not inspect. Matching it is what lets the screen
 * say "hidden" instead of printing that string as if it were SQL.
 */
const HIDDEN_QUERY = "<insufficient privilege>";

/** Shape one row, deciding what kind of session it is. */
export function toSession(row: ActivityRow, longRunningSeconds: number): ActivitySession {
  const querySeconds = toSeconds(row.query_seconds);
  const xactSeconds = toSeconds(row.xact_seconds);
  const stateSeconds = toSeconds(row.state_seconds);
  const state = row.state ?? "unknown";

  const waitingOn =
    row.wait_event_type && row.wait_event
      ? `${row.wait_event_type}: ${row.wait_event}`
      : null;

  const queryHidden = row.query === HIDDEN_QUERY;
  const query = queryHidden || !row.query ? null : row.query;

  // A session waiting on a Lock is blocked BY somebody. Other wait types
  // (ClientRead, IO) are ordinary and do not make a session a problem.
  const kind: ActivityKind = (() => {
    if (row.wait_event_type === "Lock") return "blocked";
    if (state.startsWith("idle in transaction")) return "idle-in-transaction";
    // For an idle-in-transaction session query_start is when its LAST statement
    // began, which is not how long it has been idle — state_change is. This
    // branch is only reached for a running session, so query_seconds is right.
    if (querySeconds !== null && querySeconds >= longRunningSeconds) return "long-running";
    return "running";
  })();

  return {
    pid: row.pid,
    kind,
    // For an idle-in-transaction session, how long it has been idle is the
    // number that matters, and that is state_change.
    querySeconds: kind === "idle-in-transaction" ? stateSeconds : querySeconds,
    xactSeconds,
    username: row.username,
    applicationName: row.application_name || null,
    clientAddr: row.client_addr,
    state,
    waitingOn,
    query,
    queryHidden,
  };
}

const KIND_RANK: Record<ActivityKind, number> = {
  blocked: 0,
  "idle-in-transaction": 1,
  "long-running": 2,
  running: 3,
};

/**
 * Shape and rank a whole result set.
 *
 * Worst kind first, and longest first within a kind — which is the order
 * somebody scanning the screen for "what do I kill" reads in.
 */
export function readActivity(
  rows: ActivityRow[],
  longRunningSeconds: number
): ActivitySession[] {
  return rows
    .map((row) => toSession(row, longRunningSeconds))
    .sort(
      (a, b) =>
        KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
        (b.querySeconds ?? 0) - (a.querySeconds ?? 0)
    );
}

/** The counts the screen puts above the list. */
export function summarizeActivity(sessions: ActivitySession[]): {
  total: number;
  blocked: number;
  idleInTransaction: number;
  longRunning: number;
  /** True when at least one session's SQL was withheld from this login. */
  anyHidden: boolean;
} {
  return {
    total: sessions.length,
    blocked: sessions.filter((s) => s.kind === "blocked").length,
    idleInTransaction: sessions.filter((s) => s.kind === "idle-in-transaction").length,
    longRunning: sessions.filter((s) => s.kind === "long-running").length,
    anyHidden: sessions.some((s) => s.queryHidden),
  };
}

/**
 * The sentence shown when nothing came back.
 *
 * "No long-running queries" would be a stronger claim than the data supports:
 * this login may simply not be allowed to see other sessions. The wording says
 * what was actually observed.
 */
export const NOTHING_ACTIVE =
  "No other session on this server is running a statement right now.";

/** Said above the list when some rows came back with their SQL withheld. */
export const SOME_HIDDEN =
  "Some sessions belong to other database users, and PostgreSQL only shows a " +
  "session's SQL to the role that owns it, to a superuser, or to a member of " +
  "pg_read_all_stats. Those rows are listed with everything except their query " +
  "text.";
