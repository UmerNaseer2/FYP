import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth-guard";
import pool, { syncMetadataTables } from "@/lib/version-db";
import { buildPgConfig } from "@/lib/connection-config";
import { canExecute, toExecuteRole } from "@/lib/connection-access";
import { UNREADABLE_CREDENTIALS_MESSAGE } from "@/lib/secret-store";
import { getPoolForConfig } from "@/lib/postgres";
import { ADMIN_ROLE } from "@/lib/permissions";
import type { PoolClient } from "pg";
import { CANCEL_SQL } from "@/lib/db-activity";

/**
 * POST /api/performance/cancel, with { connectionId, pid, queryStart }
 *
 * Stop one stuck query. Only the phone link uses this today: the desktop app
 * calls it for a paired phone, once that phone has signed the request with its
 * passkey (desktop/src/main/phone-control.ts), and keeps the record in its
 * action log.
 *
 * Unlike a deploy, this does not go through the approval queue on production.
 * A stuck query is the emergency the approval queue would only slow down, and
 * stopping a statement changes nothing that statement had not committed.
 *
 * Answers:
 *   200 { status: "cancelled" }  the database took the cancel
 *   200 { status: "gone" }       that statement is not running any more
 *   409 { code: "database_refused" }  this connection's login may not cancel it
 *   423  the connection's settings do not let this role change anything on it.
 *        Not 403: that is what the gate answers about the role itself, and the
 *        desktop app tells a person different things for the two.
 */

/** How long the cancel may take before it gives up. */
const CANCEL_STATEMENT_TIMEOUT_MS = 10_000;

/** The largest number pg_stat_activity.pid can hold. */
const MAX_PID = 2_147_483_647;

/** The exact text of queryStart in lib/db-activity.ts. */
const QUERY_START = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

/** PostgreSQL's insufficient_privilege: another role's session, for a login without pg_signal_backend. */
const NOT_PERMITTED = "42501";

export async function POST(request: NextRequest) {
  const gate = await requirePermission("performance:update");
  if (!gate.ok) return gate.response;

  let body: { connectionId?: unknown; pid?: unknown; queryStart?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "The request could not be read." }, { status: 400 });
  }
  const { connectionId, pid, queryStart } = body;
  if (
    !Number.isInteger(connectionId) ||
    !Number.isInteger(pid) ||
    (pid as number) <= 0 ||
    (pid as number) > MAX_PID ||
    typeof queryStart !== "string" ||
    !QUERY_START.test(queryStart) ||
    Number.isNaN(Date.parse(queryStart))
  ) {
    return NextResponse.json(
      { ok: false, error: "Say which connection, and which session and statement to cancel." },
      { status: 400 },
    );
  }

  let conn: {
    name: string;
    type: string;
    host: string;
    port: number;
    database_name: string;
    username: string;
    password: string;
    connection_string: string | null;
    ssl: boolean;
    ssl_mode: string | null;
    execute_role: string | null;
  };
  try {
    await syncMetadataTables();
    const result = await pool.query<typeof conn>(
      `SELECT name, type, host, port, database_name, username, password,
              connection_string, ssl, ssl_mode, execute_role
         FROM connections WHERE id = $1 AND org_id = $2`,
      [connectionId, gate.principal.orgId],
    );
    if (result.rows.length === 0) {
      return NextResponse.json({ ok: false, error: `No saved connection found with id ${connectionId}.` }, { status: 404 });
    }
    conn = result.rows[0];
  } catch (error) {
    console.error("Cancel — failed to read connection:", error);
    return NextResponse.json(
      { ok: false, error: "Could not read the saved connection. Is the app database reachable?" },
      { status: 500 },
    );
  }

  // A connection's own rule about who may change things on it applies here too.
  // mayDeploy is true because Performance: Update, which the gate just checked,
  // stands in for Deploy: Run on this one action. Otherwise someone allowed to
  // stop queries but not to deploy could never use this at all.
  const who = { isAdmin: gate.principal.role === ADMIN_ROLE, mayDeploy: true };
  if (!canExecute(who, toExecuteRole(conn.execute_role))) {
    return NextResponse.json(
      { ok: false, error: `The settings of ${conn.name} do not let your role change anything on it.` },
      { status: 423 },
    );
  }

  if (conn.type !== "PostgreSQL") {
    return NextResponse.json({ ok: false, error: "Only a PostgreSQL connection has queries to cancel here." }, { status: 400 });
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
      "Cancel — could not read the saved connection's credentials:",
      error instanceof Error ? error.message : error,
    );
    return NextResponse.json({ ok: false, error: UNREADABLE_CREDENTIALS_MESSAGE }, { status: 500 });
  }

  let client: PoolClient | null = null;
  try {
    client = await getPoolForConfig(cfg).connect();
    await client.query("BEGIN");
    await client.query(`SET LOCAL statement_timeout = ${CANCEL_STATEMENT_TIMEOUT_MS}`);
    const result = await client.query<{ cancelled: boolean }>(CANCEL_SQL, [pid, queryStart]);
    await client.query("COMMIT");
    return NextResponse.json({ status: result.rows[0]?.cancelled === true ? "cancelled" : "gone" });
  } catch (error) {
    await client?.query("ROLLBACK").catch(() => undefined);
    if ((error as { code?: unknown } | null)?.code === NOT_PERMITTED) {
      return NextResponse.json(
        { ok: false, code: "database_refused", error: "This connection's login may not cancel that query." },
        { status: 409 },
      );
    }
    console.error("Cancel — the database did not answer:", error instanceof Error ? error.message : error);
    return NextResponse.json({ ok: false, error: "Could not reach that database." }, { status: 502 });
  } finally {
    client?.release();
  }
}
