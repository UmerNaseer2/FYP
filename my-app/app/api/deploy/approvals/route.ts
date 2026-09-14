import { NextRequest, NextResponse } from "next/server";
import { requireEditor, requireViewer } from "@/lib/auth-guard";
import {
  createApprovalRequest,
  isApprovalAction,
  listApprovals,
  type ApprovalAction,
  type ApprovalScript,
} from "@/lib/approvals-db";
import { MAX_ROLLBACK_VERSIONS } from "@/lib/rollback-plan";
import { analyseRunRisk, type RiskScript } from "@/lib/deploy-risk";

/**
 * Ask for, and read, approval to run a deploy or a rollback on production.
 *
 * The decision half lives in ./[id]/route.ts, because approving is a different
 * action by a different person and deserves its own gate.
 *
 * Both handlers are deliberately quiet about what the migrations do: the SQL
 * goes into a fingerprint and is not stored here. The approver reads the
 * migrations on the Deploy screen, from the registry, which is the copy that
 * will actually run.
 *
 * POST takes an optional `action`: "deploy" (the default, so every caller
 * written before rollbacks needed approval keeps working) or "revert". For a
 * rollback, `scripts` holds the rollback SQL that will run, newest version
 * first, exactly as the revert route will claim it.
 *
 * The breaking count the approver is shown is worked out here, from the SQL
 * (lib/deploy-risk), and never taken from the caller: for a deploy it is the
 * migrations that count as breaking, for a rollback the rollbacks that delete
 * rows. Each script may carry an optional `change_type`, which can raise its
 * grade but never lower it, so a screen can make a run look riskier to the
 * approver, never safer.
 */

/** Narrow one entry of the caller's `scripts` array, or explain what is wrong. */
function parseScript(value: unknown, index: number, action: ApprovalAction): ApprovalScript | string {
  const raw = (value ?? {}) as Record<string, unknown>;
  const scriptName = String(raw.script_name ?? "").trim();
  const version = String(raw.version ?? "").trim();
  const sqlContent = String(raw.sql_content ?? "");
  // For a rollback, `scripts` holds rollbacks, so "Migration 2" would send
  // the reader looking in the wrong list.
  const which = `${action === "revert" ? "Rollback" : "Migration"} ${index + 1}`;

  if (!scriptName) return `${which} has no script name.`;
  if (!version) return `${which} has no version.`;
  if (!sqlContent.trim()) return `${which} has no SQL.`;
  return { scriptName, version, sqlContent };
}

export async function GET(request: NextRequest) {
  const gate = await requireViewer();
  if (!gate.ok) return gate.response;

  const params = request.nextUrl.searchParams;
  const connectionId = Number(params.get("connectionId"));
  const schemaName = (params.get("schemaName") ?? "").trim();
  // Absent means "every group in this schema" — the Deploy screen asks for one
  // group, an audit view can ask for all of them.
  const scriptName = (params.get("scriptName") ?? "").trim() || null;

  if (!Number.isInteger(connectionId) || connectionId <= 0 || !schemaName) {
    return NextResponse.json(
      { error: "connectionId and schemaName are required." },
      { status: 400 }
    );
  }

  try {
    const approvals = await listApprovals(connectionId, schemaName, scriptName);
    return NextResponse.json({ approvals });
  } catch (error) {
    console.error("Approvals — list failed:", error);
    return NextResponse.json(
      { error: "Could not read the approval history for this target." },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  // Requesting is an editor action: it is the same person who would press
  // Deploy, and a viewer cannot deploy.
  const gate = await requireEditor();
  if (!gate.ok) return gate.response;

  let body: {
    connectionId?: number;
    schemaName?: string;
    scriptName?: string;
    targetVersion?: string;
    scripts?: unknown[];
    note?: string;
    action?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body is not valid JSON." }, { status: 400 });
  }

  // Absent or blank means a deploy, so older callers keep working. Anything
  // else must be one of the two values the table accepts: guessing would
  // record an approval that no route can ever spend.
  const rawAction = body.action === undefined || body.action === null || body.action === ""
    ? "deploy"
    : body.action;
  if (!isApprovalAction(rawAction)) {
    return NextResponse.json(
      { error: 'action must be "deploy" or "revert".' },
      { status: 400 }
    );
  }
  const action: ApprovalAction = rawAction;

  const connectionId = Number(body.connectionId);
  const schemaName = (body.schemaName ?? "").trim();
  const scriptName = (body.scriptName ?? "").trim();
  const targetVersion = (body.targetVersion ?? "").trim();

  if (!Number.isInteger(connectionId) || connectionId <= 0) {
    return NextResponse.json({ error: "Pick a connection first." }, { status: 400 });
  }
  if (!schemaName || !scriptName || !targetVersion) {
    return NextResponse.json(
      { error: "Pick a schema, a script group and a target version first." },
      { status: 400 }
    );
  }
  if (!Array.isArray(body.scripts) || body.scripts.length === 0) {
    return NextResponse.json(
      {
        error: action === "revert"
          ? "There are no rollbacks in this request to approve."
          : "There are no migrations in this run to approve.",
      },
      { status: 400 }
    );
  }
  // The revert route refuses a rollback of more than MAX_ROLLBACK_VERSIONS
  // versions, so an approval for one could never be spent. Refuse it here,
  // before a second person spends time approving it.
  if (action === "revert" && body.scripts.length > MAX_ROLLBACK_VERSIONS) {
    return NextResponse.json(
      {
        error:
          `A rollback can undo at most ${MAX_ROLLBACK_VERSIONS} versions at a time, and this ` +
          `request lists ${body.scripts.length}, so it was not sent for approval. Roll back in ` +
          `steps of at most ${MAX_ROLLBACK_VERSIONS} versions, and ask for approval of each.`,
      },
      { status: 400 }
    );
  }

  const scripts: ApprovalScript[] = [];
  // The same scripts as the risk check reads them, each with the change_type
  // the caller sent. Kept apart from `scripts`, whose name, version and SQL are
  // all the fingerprint covers.
  const riskScripts: RiskScript[] = [];
  for (let i = 0; i < body.scripts.length; i++) {
    const parsed = parseScript(body.scripts[i], i, action);
    if (typeof parsed === "string") {
      return NextResponse.json({ error: parsed }, { status: 400 });
    }
    scripts.push(parsed);
    const sent = (body.scripts[i] ?? {}) as Record<string, unknown>;
    riskScripts.push({ ...parsed, changeType: sent.change_type });
  }

  const note = (body.note ?? "").trim().slice(0, 500) || null;
  // Worked out from the SQL; a breakingCount in the body is ignored. For a
  // rollback the risk the approver weighs is lost rows, which deploying again
  // does not bring back.
  const risk = analyseRunRisk(riskScripts);
  const breakingCount = action === "revert" ? risk.dataLoss.length : risk.breaking.length;

  try {
    const approval = await createApprovalRequest({
      connectionId,
      schemaName,
      scriptName,
      targetVersion,
      scripts,
      breakingCount,
      requestedBy: gate.principal.email,
      note,
      action,
    });
    return NextResponse.json({ approval });
  } catch (error) {
    console.error("Approvals — request failed:", error);
    return NextResponse.json(
      { error: "Could not record the approval request." },
      { status: 500 }
    );
  }
}
