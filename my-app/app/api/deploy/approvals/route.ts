import { NextRequest, NextResponse } from "next/server";
import { requireEditor, requireViewer } from "@/lib/auth-guard";
import {
  createApprovalRequest,
  listApprovals,
  type ApprovalScript,
} from "@/lib/approvals-db";

/**
 * Ask for, and read, approval to run a deploy.
 *
 * The decision half lives in ./[id]/route.ts, because approving is a different
 * action by a different person and deserves its own gate.
 *
 * Both handlers are deliberately quiet about what the migrations do: the SQL
 * goes into a fingerprint and is not stored here. The approver reads the
 * migrations on the Deploy screen, from the registry, which is the copy that
 * will actually run.
 */

/** Narrow one entry of the caller's `scripts` array, or explain what is wrong. */
function parseScript(value: unknown, index: number): ApprovalScript | string {
  const raw = (value ?? {}) as Record<string, unknown>;
  const scriptName = String(raw.script_name ?? "").trim();
  const version = String(raw.version ?? "").trim();
  const sqlContent = String(raw.sql_content ?? "");

  if (!scriptName) return `Migration ${index + 1} has no script name.`;
  if (!version) return `Migration ${index + 1} has no version.`;
  if (!sqlContent.trim()) return `Migration ${index + 1} has no SQL.`;
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
    breakingCount?: number;
    note?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body is not valid JSON." }, { status: 400 });
  }

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
      { error: "There are no migrations in this run to approve." },
      { status: 400 }
    );
  }

  const scripts: ApprovalScript[] = [];
  for (let i = 0; i < body.scripts.length; i++) {
    const parsed = parseScript(body.scripts[i], i);
    if (typeof parsed === "string") {
      return NextResponse.json({ error: parsed }, { status: 400 });
    }
    scripts.push(parsed);
  }

  const note = (body.note ?? "").trim().slice(0, 500) || null;
  const breakingCount = Number.isFinite(Number(body.breakingCount))
    ? Math.max(0, Math.trunc(Number(body.breakingCount)))
    : 0;

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
