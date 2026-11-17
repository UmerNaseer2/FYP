import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/guard";
import { actorFor } from "@/lib/auth/mode";
import pool, { syncMetadataTables } from "@/lib/db/version-db";
import { buildPgConfig } from "@/lib/connections/config";
import { canExecute, toExecuteRole } from "@/lib/connections/access";
import { credentialsMessage } from "@/lib/connections/secret-store";
import { getPoolForConfig } from "@/lib/postgres";
import { ADMIN_ROLE, hasPermission } from "@/lib/roles/permissions";
import { isRunId } from "@/lib/deploy/run-id";
import { cancelRunElsewhere, findRun, stopRun, type CancelOutcome } from "@/lib/deploy/run-limits";

/**
 * POST /api/scripts/cancel, with { runId, connectionId }
 *
 * The Stop button on the Deploy page: ends a deploy or rollback that is still
 * going. The run rolls back, so nothing it did is kept, and its own answer
 * says it was stopped. See lib/deploy/run-limits.ts for how.
 *
 * Who may stop a run: the person who started it, an Admin, or anyone who may
 * run scripts on that connection (and so could stop it with a script of their
 * own anyway). A run going on another instance of the app is out of this
 * server's reach, so who started it is not known here: only an Admin or
 * someone who may run scripts on the connection can stop that one.
 *
 * Answers:
 *   200 { status: "stopping" }        the run is being stopped
 *   404 { code: "not_running" }       no such run is going (it may have just ended)
 *   409 { code: "too_late" }          the run is already saving its changes
 *   409 { code: "between_steps" }     another instance's run had nothing to cancel just then
 *   409 { code: "database_refused" }  this connection's login may not cancel that query
 */

/** PostgreSQL's insufficient_privilege. */
const NOT_PERMITTED = "42501";

const NOT_RUNNING = "That run is not going any more. It may have just finished.";
const TOO_LATE = "Too late to stop: the run is already saving its changes.";
const NOT_ALLOWED =
  "Only the person who started this run, an Admin, or someone who may run scripts on " +
  "this connection can stop it.";

function refuse(status: number, payload: { code?: string; error: string }) {
  return NextResponse.json({ ok: false, ...payload }, { status });
}

export async function POST(request: NextRequest) {
  const gate = await requirePermission("deploy:read");
  if (!gate.ok) return gate.response;
  const { principal } = gate;

  let body: { runId?: unknown; connectionId?: unknown };
  try {
    body = await request.json();
  } catch {
    return refuse(400, { error: "The request could not be read." });
  }
  const { runId: rawRunId, connectionId } = body ?? {};
  if (!isRunId(rawRunId) || !Number.isInteger(connectionId) || (connectionId as number) <= 0) {
    return refuse(400, { error: "The request could not be read." });
  }
  const runId = rawRunId.toLowerCase();

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
      [connectionId, principal.orgId],
    );
    if (result.rows.length === 0) {
      return refuse(404, { error: `No saved connection found with id ${connectionId}.` });
    }
    conn = result.rows[0];
  } catch (error) {
    console.error("Stop: failed to read connection:", error instanceof Error ? error.message : error);
    return refuse(500, { error: "Could not read the saved connection. Is the app database reachable?" });
  }

  if (conn.type !== "PostgreSQL") {
    return refuse(400, { error: "Only a PostgreSQL connection has queries to cancel here." });
  }

  const isAdmin = principal.role === ADMIN_ROLE;
  const mayRunHere = canExecute(
    { isAdmin, mayDeploy: hasPermission(principal, "deploy:run") },
    toExecuteRole(conn.execute_role),
  );

  // ─── A run going in this server process ──────────────────────────────────
  const entry = findRun(runId);
  if (entry) {
    // Another organization's run, or one on another connection, is not one
    // this request may name: it is answered as if there were none.
    if (entry.orgId !== principal.orgId || entry.connectionId !== connectionId) {
      return refuse(404, { code: "not_running", error: NOT_RUNNING });
    }
    if (entry.actor !== actorFor(principal) && !isAdmin && !mayRunHere) {
      return refuse(403, { error: NOT_ALLOWED });
    }
    if (entry.done) return refuse(404, { code: "not_running", error: NOT_RUNNING });
    if (entry.committing) return refuse(409, { code: "too_late", error: TOO_LATE });
    if (!stopRun(entry, "cancelled")) {
      // It ended, or began its COMMIT, in the moment since the checks above.
      return entry.committing
        ? refuse(409, { code: "too_late", error: TOO_LATE })
        : refuse(404, { code: "not_running", error: NOT_RUNNING });
    }
    return NextResponse.json({ status: "stopping" });
  }

  // ─── A run going on another instance of the app, or none at all ──────────
  if (!isAdmin && !mayRunHere) {
    return refuse(403, { error: NOT_ALLOWED });
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
      "Stop: could not read the saved connection's credentials:",
      error instanceof Error ? error.message : error,
    );
    return refuse(500, { error: credentialsMessage(error) });
  }

  let outcome: CancelOutcome;
  try {
    outcome = await cancelRunElsewhere(getPoolForConfig(cfg), runId);
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === NOT_PERMITTED) {
      return refuse(409, { code: "database_refused", error: "This connection's login may not cancel that query." });
    }
    console.error("Stop: the database did not answer:", error instanceof Error ? error.message : error);
    return refuse(502, { error: "Could not reach that database." });
  }

  switch (outcome) {
    case "cancelled":
      return NextResponse.json({ status: "stopping" });
    case "committing":
      return refuse(409, { code: "too_late", error: TOO_LATE });
    case "not_found":
      return refuse(404, { code: "not_running", error: NOT_RUNNING });
    case "idle":
      return refuse(409, {
        code: "between_steps",
        error:
          "The run is between two steps and could not be stopped just now. Try again, or let " +
          "its time limit end it.",
      });
  }
}
