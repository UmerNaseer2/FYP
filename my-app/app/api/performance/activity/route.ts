import { NextRequest, NextResponse } from "next/server";
import { requireViewer } from "@/lib/auth-guard";
import pool, { syncMetadataTables } from "@/lib/version-db";
import { buildPgConfig } from "@/lib/connection-config";
import { UNREADABLE_CREDENTIALS_MESSAGE } from "@/lib/secret-store";
import { getPoolForConfig } from "@/lib/postgres";
import type { PoolClient } from "pg";
import {
  ACTIVITY_SQL,
  NOTHING_ACTIVE,
  SOME_HIDDEN,
  readActivity,
  summarizeActivity,
  type ActivityRow,
  type ActivitySession,
} from "@/lib/db-activity";
import { evaluateThresholds, type ThresholdBreach, type ThresholdReading } from "@/lib/perf-thresholds";
import { getThresholdsOrDefaults } from "@/lib/perf-thresholds-db";

/**
 * GET /api/performance/activity?connectionId=<id>&schema=<name>
 *
 * Spec feature 10 — "Long-Running Query Detection".
 *
 * This is the one Performance endpoint whose answer is only true for the
 * instant it was asked. Everything it reports is gone by the time somebody
 * reads it if the query finished, which is why the response carries the moment
 * it was taken: a list of "long-running queries" with no timestamp on it is a
 * screen that ages into a lie.
 *
 * `schema` is not a filter here — pg_stat_activity is server-wide and a session
 * has no schema. It is carried because the alert threshold for what counts as
 * long-running is stored per connection-and-schema, and the screen already has
 * a schema selected.
 */

export type ActivityView = {
  connectionName: string;
  database: string;
  /** When this reading was taken, ISO. The screen shows it as "as of …". */
  takenAt: string;
  /** The threshold in force for "long-running", in seconds. */
  longRunningSeconds: number;
  /** True when that number came from a saved rule rather than the fallback. */
  thresholdConfigured: boolean;
  sessions: ActivitySession[];
  summary: ReturnType<typeof summarizeActivity>;
  /** Shown when the list is empty — says what was observed, not what is true. */
  emptyMessage: string;
  /** Shown when the server withheld some SQL. Null when it withheld none. */
  hiddenNote: string | null;
  /** Alert rules this reading broke. Empty unless some are switched on. */
  breaches: ThresholdBreach[];
};

/**
 * What counts as long-running when nobody has set a rule.
 *
 * Only used for the colour on the screen, never to fire an alert — an unset
 * threshold fires nothing (see lib/perf-thresholds.ts). Sixty seconds because
 * a minute is the point at which somebody watching a page starts reloading it.
 */
const FALLBACK_LONG_RUNNING_SECONDS = 60;

/** How long the activity read may take before it gives up. */
const ACTIVITY_STATEMENT_TIMEOUT_MS = 10_000;

export async function GET(request: NextRequest) {
  // Reading who else is connected is a read, but it is a read of other people's
  // sessions, so it is gated rather than open.
  const gate = await requireViewer();
  if (!gate.ok) return gate.response;

  const connectionId = Number(request.nextUrl.searchParams.get("connectionId") ?? "");
  const schema = (request.nextUrl.searchParams.get("schema") ?? "").trim();

  if (!connectionId) {
    return NextResponse.json(
      { ok: false, error: "A connectionId query parameter is required." },
      { status: 400 }
    );
  }
  if (!schema) {
    return NextResponse.json(
      { ok: false, error: "A schema query parameter is required." },
      { status: 400 }
    );
  }

  let conn: {
    name: string;
    type: string;
    host: string | null;
    port: number | null;
    database_name: string;
    username: string | null;
    password: string | null;
    connection_string: string | null;
    ssl: boolean | null;
    ssl_mode: string | null;
  };
  try {
    await syncMetadataTables();
    const result = await pool.query<typeof conn>(
      `SELECT name, type, host, port, database_name, username, password,
              connection_string, ssl, ssl_mode
         FROM connections WHERE id = $1`,
      [connectionId]
    );
    if (result.rows.length === 0) {
      return NextResponse.json(
        { ok: false, error: `No saved connection found with id ${connectionId}.` },
        { status: 404 }
      );
    }
    conn = result.rows[0];
  } catch (error) {
    console.error("Activity — failed to read connection:", error);
    return NextResponse.json(
      { ok: false, error: "Could not read the saved connection. Is the app database reachable?" },
      { status: 500 }
    );
  }

  if (conn.type !== "PostgreSQL") {
    return NextResponse.json(
      { ok: false, error: "Live activity is only available for PostgreSQL connections." },
      { status: 400 }
    );
  }

  let cfg: ReturnType<typeof buildPgConfig>;
  try {
    cfg = buildPgConfig({
      host: conn.host,
      port: conn.port,
      database: conn.database_name,
      user: conn.username,
      password: conn.password,
      connectionString: conn.connection_string,
      ssl: Boolean(conn.ssl),
      sslMode: conn.ssl_mode,
    });
  } catch (error) {
    console.error(
      "Activity — could not read the saved connection's credentials:",
      error instanceof Error ? error.message : error
    );
    return NextResponse.json({ ok: false, error: UNREADABLE_CREDENTIALS_MESSAGE }, { status: 500 });
  }

  // The threshold is read before the target connection is opened, so a slow or
  // unreachable app database does not hold a connection to somebody else's
  // server open while it is waited on.
  const settings = await getThresholdsOrDefaults(connectionId, schema);
  const longRunning = settings.find((s) => s.key === "long_running_seconds");
  const longRunningSeconds =
    longRunning && longRunning.enabled ? longRunning.value : FALLBACK_LONG_RUNNING_SECONDS;

  let rows: ActivityRow[];
  let client: PoolClient | null = null;
  try {
    client = await getPoolForConfig(cfg).connect();
    // READ ONLY and a timeout, like the advice route: this is a catalogue read
    // and nothing here should ever be able to wait on another session's lock.
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${ACTIVITY_STATEMENT_TIMEOUT_MS}`);
    const result = await client.query<ActivityRow>(ACTIVITY_SQL);
    await client.query("COMMIT");
    rows = result.rows;
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    console.error("Activity — could not read pg_stat_activity:", message);
    return NextResponse.json(
      {
        ok: false,
        error:
          `Could not read what ${conn.name} is doing right now. ` +
          `PostgreSQL reported: ${message}`,
      },
      { status: 502 }
    );
  } finally {
    client?.release();
  }

  const sessions = readActivity(rows, longRunningSeconds);
  const summary = summarizeActivity(sessions);

  // Only the slowest session is offered as a reading. Every long-running
  // session breaks the same rule by definition, and a list that repeats the
  // same sentence once per session buries the one that matters.
  const slowest = sessions.reduce<ActivitySession | null>(
    (worst, s) => ((s.querySeconds ?? 0) > (worst?.querySeconds ?? 0) ? s : worst),
    null
  );
  const readings: ThresholdReading[] =
    slowest && slowest.querySeconds !== null
      ? [
          {
            key: "long_running_seconds",
            actual: slowest.querySeconds,
            subject: `Session ${slowest.pid}`,
          },
        ]
      : [];

  const view: ActivityView = {
    connectionName: conn.name,
    database: conn.database_name,
    // The app's clock, and only for "when did I ask" — every duration in the
    // list was computed by the server itself. See lib/db-activity.ts.
    takenAt: new Date().toISOString(),
    longRunningSeconds,
    thresholdConfigured: Boolean(longRunning?.enabled),
    sessions,
    summary,
    emptyMessage: NOTHING_ACTIVE,
    hiddenNote: summary.anyHidden ? SOME_HIDDEN : null,
    breaches: evaluateThresholds(readings, settings),
  };
  return NextResponse.json(view);
}
