import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth-guard";
import { actorFor } from "@/lib/auth-mode";
import { hasPermission, refusalMessage } from "@/lib/permissions";
import pool, { syncMetadataTables } from "@/lib/version-db";
import { fetchSchemaSnapshot } from "@/lib/postgres";
import { buildPgConfig } from "@/lib/connection-config";
import { UNREADABLE_CREDENTIALS_MESSAGE } from "@/lib/secret-store";
import { runFingerprint } from "@/lib/approvals-db";
import { aiResponse } from "@/lib/ai/respond";
import { aiGate, defaultAiDeps, runAiTask } from "@/lib/ai/run";
import { readTableSizes } from "@/lib/ai/table-sizes";
import {
  buildMigrationReviewTask,
  listReviewStatements,
  reviewedStatements,
  withAppFindings,
  type ReviewScript,
} from "@/lib/ai/features/migration-review";

const MAX_SCRIPTS = 200;
/** The SQL of one run, in characters. A run past this is not one to read in a prompt. */
const MAX_RUN_CHARS = 400_000;
/** How long the schema capture waits for a lock on the target. */
const SNAPSHOT_LOCK_TIMEOUT_MS = 2_000;

function readScripts(value: unknown): ReviewScript[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SCRIPTS) return null;
  const scripts: ReviewScript[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return null;
    const { scriptName, version, sqlContent } = item as Record<string, unknown>;
    if (typeof scriptName !== "string" || typeof version !== "string" || typeof sqlContent !== "string") return null;
    scripts.push({ scriptName, version, sqlContent });
  }
  return scripts;
}

/**
 * POST /api/scripts/review  { connectionId, schemaName, action, scripts }
 *
 * The AI review of the run the Deploy screen is about to start: `scripts` are
 * the ones it would apply (action "deploy") or the stored down scripts it
 * would run (action "revert"), in order, as the approval request sends them.
 *
 * The target's schema is read here, as are the planner's size estimates for
 * the tables the run touches, so the review is about this target as it is
 * now. Reading them takes no lock a deploy would notice. Nothing is changed
 * and nothing is recorded but the AI call itself: a review is not a run.
 *
 * Needs Read on Deploy or on production approvals (whoever may see the run, or
 * the approval request for it, may read its review), and "Use AI assistance".
 */
export async function POST(request: NextRequest) {
  const gate = await requirePermission("deploy:read", "approvals:read");
  if (!gate.ok) return gate.response;
  // requirePermission lets in any one of the keys it is given, so the AI box
  // is asked for on its own: it is needed as well.
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
  const connectionId = Number(body.connectionId);
  if (!Number.isInteger(connectionId) || connectionId <= 0) {
    return NextResponse.json({ error: "Pick a target connection first." }, { status: 400 });
  }
  const schemaName = typeof body.schemaName === "string" && body.schemaName.trim() ? body.schemaName.trim() : "public";
  const action = body.action === "revert" ? "revert" : body.action === "deploy" ? "deploy" : null;
  if (!action) return NextResponse.json({ error: 'action must be "deploy" or "revert".' }, { status: 400 });
  const scripts = readScripts(body.scripts);
  if (!scripts) {
    return NextResponse.json(
      { error: `Send the run's scripts: 1 to ${MAX_SCRIPTS}, each with scriptName, version and sqlContent.` },
      { status: 400 }
    );
  }
  if (scripts.reduce((sum, s) => sum + s.sqlContent.length, 0) > MAX_RUN_CHARS) {
    return NextResponse.json(
      { error: "This run is too long for an AI review. Review it in smaller runs, or read it yourself." },
      { status: 413 }
    );
  }

  const caller = { orgId: gate.principal.orgId, email: actorFor(gate.principal) };
  const deps = defaultAiDeps();
  // Said before the target is touched: with AI off there is nothing to read it for.
  try {
    const refused = await aiGate(caller, "migration-review", deps);
    if (refused) return aiResponse(refused);
  } catch (error) {
    console.error("POST scripts review: could not read the AI settings:", error);
    return NextResponse.json({ error: "Could not read this organization's AI settings. Is the app database reachable?" }, { status: 500 });
  }

  let row: {
    type: string;
    host: string;
    port: number;
    database_name: string;
    username: string;
    password: string;
    connection_string: string | null;
    ssl: boolean | null;
    ssl_mode: string | null;
  };
  try {
    await syncMetadataTables();
    const result = await pool.query(
      `SELECT type, host, port, database_name, username, password, connection_string, ssl, ssl_mode
         FROM connections
        WHERE id = $1 AND org_id = $2`,
      [connectionId, gate.principal.orgId]
    );
    // Another organization's connection reads as missing, like a deleted one.
    if (result.rows.length === 0) {
      return NextResponse.json({ error: `No saved connection found with id ${connectionId}.` }, { status: 404 });
    }
    row = result.rows[0];
  } catch (error) {
    console.error("POST scripts review: could not read the connection:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Could not read saved connection. Is the app database reachable?" }, { status: 500 });
  }
  if (row.type !== "PostgreSQL") {
    return NextResponse.json({ error: "The AI review reads PostgreSQL targets only." }, { status: 400 });
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
    console.error("POST scripts review: could not read the connection's credentials:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: UNREADABLE_CREDENTIALS_MESSAGE }, { status: 500 });
  }

  try {
    const captured = await fetchSchemaSnapshot(cfg, schemaName, { lockTimeoutMs: SNAPSHOT_LOCK_TIMEOUT_MS });
    if (!captured.ok) {
      return NextResponse.json({ error: `Could not read the target's schema: ${captured.error}` }, { status: 502 });
    }
    const snapshot = captured.data;
    const listing = listReviewStatements(scripts, snapshot);
    if (!listing) {
      return NextResponse.json({ error: "These scripts have no statement that would run, so there is nothing to review." }, { status: 409 });
    }
    const sizes = await readTableSizes(cfg, schemaName, listing.touched.slice(0, 40));
    const task = buildMigrationReviewTask(listing, {
      action,
      snapshot,
      sizes,
      fingerprint: runFingerprint(scripts, action),
    });

    const result = await runAiTask(caller, task.spec, deps);
    if (result.kind !== "ok") return aiResponse(result);
    // The app's own findings are added here, after the check and after a saved
    // answer is read, so every review of this run gets the same ones.
    const { appFindings, ...answer } = withAppFindings(result.value, task.facts);
    return aiResponse({ ...result, value: answer }, { statements: reviewedStatements(answer, task.facts), appFindings });
  } catch (error) {
    console.error("POST scripts review error:", error);
    return NextResponse.json(
      { error: "Could not review this run. If this keeps happening, check that the target and the app's database are running." },
      { status: 500 }
    );
  }
}
