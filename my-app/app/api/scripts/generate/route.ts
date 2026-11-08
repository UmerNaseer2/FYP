import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth-guard";
import { actorFor } from "@/lib/auth-mode";
import { ADMIN_ROLE, hasPermission, refusalMessage } from "@/lib/permissions";
import pool, { syncMetadataTables } from "@/lib/version-db";
import { fetchSchemaSnapshot, getPoolForConfig } from "@/lib/postgres";
import { buildPgConfig } from "@/lib/connection-config";
import { UNREADABLE_CREDENTIALS_MESSAGE } from "@/lib/secret-store";
import { canExecute, toExecuteRole } from "@/lib/connection-access";
import { louderEnvironment, toEnvironment, type Environment } from "@/lib/environments";
import { configIdentity, findProductionTwin } from "@/lib/environment-guard";
import { findTrackedSchema } from "@/lib/lineage-db";
import { aiResponse } from "@/lib/ai/respond";
import { aiGate, defaultAiDeps, runAiTask } from "@/lib/ai/run";
import { buildSqlGenerateTask, MAX_REQUEST_CHARS, type TrialHook } from "@/lib/ai/features/sql-generate";
import { makeTrial } from "@/lib/ai/features/sql-generate-trial";

/** How long the schema capture waits for a lock on the target. */
const SNAPSHOT_LOCK_TIMEOUT_MS = 2_000;

type ConnectionRow = {
  name: string;
  type: string;
  host: string;
  port: number;
  database_name: string;
  username: string;
  password: string;
  connection_string: string | null;
  ssl: boolean | null;
  ssl_mode: string | null;
  environment: string | null;
  execute_role: string | null;
};

async function readServerMajor(cfg: ReturnType<typeof buildPgConfig>): Promise<number | null> {
  try {
    const result = await getPoolForConfig(cfg).query("SHOW server_version_num");
    const n = Number(result.rows[0]?.server_version_num);
    return Number.isFinite(n) && n > 0 ? Math.floor(n / 10_000) : null;
  } catch {
    return null;
  }
}

/**
 * POST /api/scripts/generate  { connectionId, schemaName, request }
 *
 * Writes a migration script, and its rollback, from plain words, for the
 * schema the Script Editor has picked. The app checks the answer itself: names
 * the schema does not have, statements that act on the server rather than the
 * schema, data loss nobody asked for, and the grade the deploy screen would give.
 *
 * Then, when the caller may run scripts on this target and it is labelled Dev
 * or Staging, the script and its rollback are tried on it inside a transaction
 * that is always rolled back. A failed try goes back to the AI to be fixed.
 * Production, an unlabelled target and a database another connection labels
 * Production are never tried. Nothing is saved: the editor gets the script and
 * the person decides what to do with it.
 *
 * Needs Read on Scripts and "Use AI assistance".
 */
export async function POST(request: NextRequest) {
  const gate = await requirePermission("scripts:read");
  if (!gate.ok) return gate.response;
  if (!hasPermission(gate.principal, "ai:read")) {
    return NextResponse.json({ error: refusalMessage(gate.principal.roleLabel, "ai:read") }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    body = typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return NextResponse.json({ error: "Invalid JSON in request body." }, { status: 400 });
  }
  const words = typeof body.request === "string" ? body.request.trim() : "";
  if (!words) return NextResponse.json({ error: "Say what the script should do." }, { status: 400 });
  if (words.length > MAX_REQUEST_CHARS) {
    return NextResponse.json(
      { error: `Keep the request under ${MAX_REQUEST_CHARS.toLocaleString("en-US")} characters.` },
      { status: 413 }
    );
  }
  const connectionId = Number(body.connectionId);
  if (!Number.isInteger(connectionId) || connectionId <= 0) {
    return NextResponse.json({ error: "Pick a target connection first." }, { status: 400 });
  }
  const schemaName = typeof body.schemaName === "string" && body.schemaName.trim() ? body.schemaName.trim() : "public";

  const orgId = gate.principal.orgId;
  const caller = { orgId, email: actorFor(gate.principal) };
  const deps = defaultAiDeps();
  try {
    const refused = await aiGate(caller, "sql-generate", deps);
    if (refused) return aiResponse(refused);
  } catch (error) {
    console.error("POST scripts generate: could not read the AI settings:", error);
    return NextResponse.json({ error: "Could not read this organization's AI settings. Is the app database reachable?" }, { status: 500 });
  }

  let row: ConnectionRow;
  try {
    await syncMetadataTables();
    const result = await pool.query(
      `SELECT name, type, host, port, database_name, username, password, connection_string, ssl, ssl_mode,
              environment, execute_role
         FROM connections
        WHERE id = $1 AND org_id = $2`,
      [connectionId, orgId]
    );
    if (result.rows.length === 0) {
      return NextResponse.json({ error: `No saved connection found with id ${connectionId}.` }, { status: 404 });
    }
    row = result.rows[0];
  } catch (error) {
    console.error("POST scripts generate: could not read the connection:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Could not read saved connection. Is the app database reachable?" }, { status: 500 });
  }
  if (row.type !== "PostgreSQL") {
    return NextResponse.json({ error: "Writing scripts with AI works for PostgreSQL targets only." }, { status: 400 });
  }

  let cfg: ReturnType<typeof buildPgConfig>;
  try {
    cfg = buildPgConfig({
      host: row.host,
      port: row.port,
      database: row.database_name,
      user: row.username,
      password: row.password,
      connectionString: row.connection_string,
      ssl: Boolean(row.ssl),
      sslMode: row.ssl_mode,
    });
  } catch (error) {
    console.error("POST scripts generate: could not read the connection's credentials:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: UNREADABLE_CREDENTIALS_MESSAGE }, { status: 500 });
  }

  // Whether to try the script, decided before the AI is asked, the same way a
  // deploy decides whether it may run.
  const trial = await chooseTrial({
    who: { isAdmin: gate.principal.role === ADMIN_ROLE, mayDeploy: hasPermission(gate.principal, "deploy:run") },
    row,
    orgId,
    connectionId,
    schemaName,
    cfg,
  });

  try {
    const captured = await fetchSchemaSnapshot(cfg, schemaName, { lockTimeoutMs: SNAPSHOT_LOCK_TIMEOUT_MS });
    if (!captured.ok) {
      return NextResponse.json({ error: `Could not read the target's schema: ${captured.error}` }, { status: 502 });
    }
    const task = buildSqlGenerateTask({
      request: words,
      schemaName,
      snapshot: captured.data,
      serverMajor: await readServerMajor(cfg),
      trial,
    });
    const result = await runAiTask(caller, task.spec, deps);
    if (result.kind === "failed" && task.facts.lastProblems.length > 0) {
      // The runner's message is general. What was still wrong with the last
      // answer is what tells the person how to reword the request.
      const problems = task.facts.lastProblems.slice(0, 5);
      return NextResponse.json(
        { error: `${result.message} The last answer still had this problem: ${problems[0]}`, reason: result.outcome, problems },
        { status: 502 }
      );
    }
    return aiResponse(result, { checks: task.facts.last });
  } catch (error) {
    console.error("POST scripts generate error:", error);
    return NextResponse.json(
      { error: "Could not write a script. If this keeps happening, check that the target and the app's database are running." },
      { status: 500 }
    );
  }
}

async function chooseTrial(options: {
  who: { isAdmin: boolean; mayDeploy: boolean };
  row: ConnectionRow;
  orgId: number;
  connectionId: number;
  schemaName: string;
  cfg: ReturnType<typeof buildPgConfig>;
}): Promise<TrialHook | { notTried: string }> {
  const { who, row, orgId, connectionId, schemaName, cfg } = options;
  if (!canExecute(who, toExecuteRole(row.execute_role))) {
    return { notTried: "Your role may not run scripts on this database, so the app did not try this one on it." };
  }
  let schemaEnvironment: Environment = toEnvironment(null);
  try {
    const tracked = await findTrackedSchema(orgId, connectionId, schemaName);
    if (tracked) schemaEnvironment = tracked.environment;
  } catch {
    return { notTried: "The app could not read this schema's environment label, so it did not try the script." };
  }
  const environment = louderEnvironment(toEnvironment(row.environment), schemaEnvironment);
  if (environment === "prod") {
    return {
      notTried:
        `${row.name} is labelled Production, so the app does not try AI scripts on it. ` +
        "Rehearse it with a dry run from the Deploy screen.",
    };
  }
  if (environment !== "dev" && environment !== "staging") {
    return {
      notTried:
        `${row.name} has no environment label, so the app did not try the script on it. ` +
        "Label it Dev or Staging on the Connections screen to have scripts tried there.",
    };
  }
  try {
    const twin = await findProductionTwin(orgId, connectionId, configIdentity(cfg));
    if (twin) {
      return {
        notTried: `Another saved connection, "${twin.name}", labels this database Production, so the app did not try the script on it.`,
      };
    }
  } catch {
    return { notTried: "The app could not check whether this database is labelled Production elsewhere, so it did not try the script." };
  }
  return makeTrial(cfg, schemaName);
}
