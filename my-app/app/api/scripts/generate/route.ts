import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth-guard";
import { actorFor } from "@/lib/auth-mode";
import { ADMIN_ROLE, hasPermission } from "@/lib/permissions";
import { getPoolForConfig } from "@/lib/postgres";
import type { PoolConfig } from "pg";
import { canExecute, toExecuteRole } from "@/lib/connection-access";
import { isProduction, toEnvironment } from "@/lib/environments";
import { configIdentity, findProductionTwin } from "@/lib/environment-guard";
import { approvalsOn } from "@/lib/approvals-db";
import { aiGateRefusal, aiPermissionRefusal, aiResponse } from "@/lib/ai/respond";
import { loadPgTarget, readTargetSnapshot, type PgTargetRow } from "@/lib/ai/pg-target";
import { aiDepsFor, runAiTask } from "@/lib/ai/run";
import { buildSqlGenerateTask, MAX_REQUEST_CHARS, type TrialHook } from "@/lib/ai/features/sql-generate";
import { makeTrial } from "@/lib/ai/features/sql-generate-trial";

/** The saved connection, with the columns chooseTrial reads. */
type ConnectionRow = PgTargetRow;

async function readServerMajor(cfg: PoolConfig): Promise<number | null> {
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
 * Then, when the caller may run scripts on this target and it is not labelled
 * Production, the script and its rollback are tried on it inside a transaction
 * that is always rolled back. A failed try goes back to the AI to be fixed.
 * While approvals are on, a database another connection labels Production is
 * not tried either. Nothing is saved: the editor gets the script and
 * the person decides what to do with it.
 *
 * Needs Read on Scripts and "Use AI assistance".
 */
export async function POST(request: NextRequest) {
  const gate = await requirePermission("scripts:read");
  if (!gate.ok) return gate.response;
  const noAi = aiPermissionRefusal(gate.principal);
  if (noAi) return noAi;

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
  const deps = await aiDepsFor(caller.orgId);
  const off = await aiGateRefusal(caller, "sql-generate", deps, "POST scripts generate");
  if (off) return off;

  const target = await loadPgTarget(orgId, connectionId, {
    notPostgresMessage: "Writing scripts with AI works for PostgreSQL targets only.",
    logPrefix: "POST scripts generate",
  });
  if (!target.ok) return target.response;
  const { row, cfg } = target;

  // Whether to try the script, decided before the AI is asked, the same way a
  // deploy decides whether it may run.
  const trial = await chooseTrial({
    who: { isAdmin: gate.principal.role === ADMIN_ROLE, mayDeploy: hasPermission(gate.principal, "deploy:run") },
    row,
    orgId,
    connectionId,
    schemaName,
    cfg,
    approvalsRequired: approvalsOn(gate.principal),
  });

  try {
    const captured = await readTargetSnapshot(cfg, schemaName);
    if (!captured.ok) return captured.response;
    const task = buildSqlGenerateTask({
      request: words,
      schemaName,
      snapshot: captured.snapshot,
      serverMajor: await readServerMajor(cfg),
      trial,
    });
    const result = await runAiTask(caller, { ...task.spec, signal: request.signal, refresh: body.refresh === true }, deps);
    if (result.kind === "failed" && result.outcome === "failed_check" && task.facts.lastProblems.length > 0) {
      // The runner's message is general. What was still wrong with the last
      // answer is what tells the person how to reword the request. Only when
      // the checks are why it failed: after a timeout or a refused call the
      // problems are from an earlier answer and say nothing about this one.
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
  cfg: PoolConfig;
  approvalsRequired: boolean;
}): Promise<TrialHook | { notTried: string }> {
  const { who, row, orgId, connectionId, schemaName, cfg, approvalsRequired } = options;
  if (!canExecute(who, toExecuteRole(row.execute_role))) {
    return { notTried: "Your role may not run scripts on this database, so the app did not try this one on it." };
  }
  // Tried on anything not labelled Production. The connection's label is the
  // only one; a tracked schema has none of its own.
  if (isProduction(toEnvironment(row.environment))) {
    return {
      notTried:
        `${row.name} is labelled Production, so the app does not try AI scripts on it. ` +
        "Rehearse it with a dry run from the Deploy screen.",
    };
  }
  // A second connection to this database labelled Production counts, but only
  // when approvals are on (the same rule as a deploy).
  if (approvalsRequired) {
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
  }
  return makeTrial(cfg, schemaName);
}
