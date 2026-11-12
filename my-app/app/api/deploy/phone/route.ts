import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth-guard";
import { approvalsOn, findOpenApproval, runFingerprint } from "@/lib/approvals-db";
import { canExecute, toExecuteRole } from "@/lib/connection-access";
import { isProduction, toEnvironment } from "@/lib/environments";
import { GITHUB_UNCONFIGURED_CODE } from "@/lib/github-registry";
import { findTrackedSchema } from "@/lib/lineage-db";
import { ADMIN_ROLE, hasPermission } from "@/lib/permissions";
import {
  draftDeploy,
  draftRollback,
  familyChoices,
  familyFiles,
  listFamilies,
  nextStep,
  type LedgerRead,
  type RegistryScript,
} from "@/lib/phone-deploy";
import pool, { syncMetadataTables } from "@/lib/version-db";
import { GET as pullRegistry } from "@/app/api/github/pull/route";
import { POST as preflight } from "@/app/api/scripts/preflight/route";

/**
 * What a paired phone may start of a deploy or a rollback.
 *
 *   GET  ?connectionId=N
 *        The script families that connection's database has in the registry.
 *   POST { connectionId, schemaName, scriptName }
 *        Where one family stands: its current version, what is waiting, what
 *        it could go back to.
 *   POST { connectionId, schemaName, scriptName, action, targetVersion }
 *        The plan for one run: its SQL, its risks, which step comes next and,
 *        for the desktop app alone, exactly what to POST to take that step.
 *
 * Only reading happens here, so Deploy: Read is enough. Running goes through
 * /api/scripts/apply and /api/scripts/revert, and asking through
 * /api/deploy/approvals, as it does from the Deploy screen. Those check it all
 * again, whatever this answered a moment before.
 *
 * The registry and the ledger come from the same two routes the Deploy screen
 * calls, called in-process. They answer for this same request, with its
 * signed-in person and organization, and repeat their own gates.
 *
 * Answers: 400 unreadable; 404 no such connection, or the family is not in the
 * registry; 424 the registry could not be read; 502 the database could not be
 * reached; 503 the app database could not say how that schema is tracked; 500
 * the approval queue could not be read. The messages are plain sentences of
 * ours, with no host or other detail, because they can reach a phone's log.
 */

type Connection = { database_name: string; environment: string | null; execute_role: string | null };

function refuse(status: number, error: string): NextResponse {
  return NextResponse.json({ ok: false, error }, { status });
}

/** The connection, inside the caller's organization, or the answer to give instead. */
async function readConnection(connectionId: number, orgId: number): Promise<Connection | NextResponse> {
  try {
    await syncMetadataTables();
    const result = await pool.query<Connection>(
      "SELECT database_name, environment, execute_role FROM connections WHERE id = $1 AND org_id = $2",
      [connectionId, orgId],
    );
    return result.rows[0] ?? refuse(404, "No saved connection has that id.");
  } catch (error) {
    console.error("Phone deploy — failed to read connection:", error instanceof Error ? error.message : error);
    return refuse(500, "Could not read the saved connection.");
  }
}

type Registry =
  | { state: "ok"; scripts: RegistryScript[]; partial: boolean }
  | { state: "unconfigured" | "unreachable" };

async function readRegistry(): Promise<Registry> {
  const answer = await pullRegistry();
  const body: { scripts?: unknown; warnings?: unknown; code?: unknown } | null = await answer.json().catch(() => null);
  if (answer.ok && Array.isArray(body?.scripts)) {
    return {
      state: "ok",
      scripts: body.scripts as RegistryScript[],
      partial: Array.isArray(body.warnings) && body.warnings.length > 0,
    };
  }
  return { state: body?.code === GITHUB_UNCONFIGURED_CODE ? "unconfigured" : "unreachable" };
}

/** The ledger for one family, or the answer to give instead. */
async function readLedger(connectionId: number, schemaName: string, scriptName: string): Promise<LedgerRead | NextResponse> {
  const answer = await preflight(
    new NextRequest("http://localhost/api/scripts/preflight", {
      method: "POST",
      body: JSON.stringify({ connectionId, schemaName, scriptName }),
    }),
  );
  if (answer.ok) return (await answer.json()) as LedgerRead;
  // Its 503 is the database not answering, and its words name the host, so
  // neither goes further than this. 502 is what the desktop app reads as that.
  if (answer.status === 503) return refuse(502, "Could not reach that database.");
  if (answer.status === 404) return refuse(404, "No saved connection has that id.");
  return refuse(answer.status, "Could not read this schema's version history.");
}

export async function GET(request: NextRequest) {
  const gate = await requirePermission("deploy:read");
  if (!gate.ok) return gate.response;

  const connectionId = Number(request.nextUrl.searchParams.get("connectionId") ?? "");
  if (!Number.isInteger(connectionId)) return refuse(400, "Say which connection.");
  const connection = await readConnection(connectionId, gate.principal.orgId);
  if (connection instanceof NextResponse) return connection;

  const registry = await readRegistry();
  if (registry.state !== "ok") return NextResponse.json({ registry: registry.state, partial: false, families: [] });
  return NextResponse.json({
    registry: "ok",
    partial: registry.partial,
    families: listFamilies(registry.scripts, connection.database_name),
  });
}

export async function POST(request: NextRequest) {
  const gate = await requirePermission("deploy:read");
  if (!gate.ok) return gate.response;
  const { principal } = gate;

  let body: { connectionId?: unknown; schemaName?: unknown; scriptName?: unknown; action?: unknown; targetVersion?: unknown };
  try {
    body = await request.json();
  } catch {
    return refuse(400, "The request could not be read.");
  }
  const { connectionId, schemaName, scriptName, action, targetVersion } = body;
  if (
    !Number.isInteger(connectionId) ||
    typeof schemaName !== "string" ||
    schemaName === "" ||
    typeof scriptName !== "string" ||
    scriptName === ""
  ) {
    return refuse(400, "Say which connection, schema and script.");
  }
  if (action !== undefined && action !== "deploy" && action !== "revert") return refuse(400, "Say deploy or revert.");
  if (action !== undefined && targetVersion !== null && typeof targetVersion !== "string") {
    return refuse(400, "Say which version.");
  }
  const id = connectionId as number;

  const connection = await readConnection(id, principal.orgId);
  if (connection instanceof NextResponse) return connection;

  const registry = await readRegistry();
  if (registry.state !== "ok") return refuse(424, "The script registry could not be read.");
  const family = familyFiles(registry.scripts, connection.database_name, schemaName, scriptName);
  if (family.length === 0) return refuse(404, "That script is not in the registry.");

  const ledger = await readLedger(id, schemaName, scriptName);
  if (ledger instanceof NextResponse) return ledger;

  if (action === undefined) return NextResponse.json({ ...familyChoices(family, ledger), partial: registry.partial });

  let tracked: Awaited<ReturnType<typeof findTrackedSchema>>;
  try {
    tracked = await findTrackedSchema(principal.orgId, id, schemaName);
  } catch (error) {
    console.error("Phone deploy — failed to read the tracked schema:", error instanceof Error ? error.message : error);
    return refuse(503, "Could not read how that schema is tracked.");
  }
  // The connection's label is the only one. A second person is needed only on
  // production, and only when the organization has approvals switched on.
  const environment = toEnvironment(connection.environment);
  const production = isProduction(environment);
  const approvalNeeded = production && approvalsOn(principal);

  const target = { connectionId: id, schemaName, scriptName, targetVersion: targetVersion as string | null };
  const draft =
    action === "deploy"
      ? draftDeploy(target, family, ledger, tracked?.driftStatus ?? null)
      : draftRollback(target, family, ledger);

  let approval: "approved" | "pending" | null = null;
  if (approvalNeeded && draft.problem === null) {
    try {
      approval = await findOpenApproval({
        orgId: principal.orgId,
        connectionId: id,
        schemaName,
        scripts: draft.scripts,
        action,
      });
    } catch (error) {
      console.error("Phone deploy — failed to read the approval queue:", error instanceof Error ? error.message : error);
      return refuse(500, "Could not read the approval queue.");
    }
  }

  const executeRole = toExecuteRole(connection.execute_role);
  const mayRun = hasPermission(principal, "deploy:run");
  const { next, blockedReason } = nextStep(draft.problem, {
    approvalNeeded,
    approval,
    readOnly: executeRole === "none",
    // Both things that let someone run: their role, and the connection's own rule.
    mayRun: canExecute({ isAdmin: principal.role === ADMIN_ROLE, mayDeploy: mayRun }, executeRole),
    mayAsk: hasPermission(principal, "approvals:create"),
  });

  return NextResponse.json({
    action,
    connectionId: id,
    schemaName,
    scriptName,
    targetVersion,
    environment,
    partial: registry.partial,
    fingerprint: runFingerprint(draft.scripts, action),
    scripts: draft.scripts,
    risks: { production, ...draft.risks },
    next,
    blockedReason,
    run: next === "run" || next === "run-approved" ? draft.run : null,
    approvalRequest: next === "ask-approval" ? draft.approvalRequest : null,
  });
}
