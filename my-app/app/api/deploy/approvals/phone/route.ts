import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth-guard";
import { approverKey, listPendingApprovals, mayDecideOwn } from "@/lib/approvals-db";
import { hasPermission } from "@/lib/permissions";

/**
 * GET /api/deploy/approvals/phone
 *
 * The deploy and rollback requests still waiting for a decision, for a paired
 * phone. The desktop app's phone link calls this when a phone asks for the
 * queue (approvals.list in desktop/src/shared/remote/rpc.ts), then keeps only
 * the requests on connections its owner shared with phones.
 *
 * It answers with what the Deploy screen's approval panel shows about each
 * request, and never its SQL: a phone reads that one request at a time,
 * through ./[id]/phone/route.ts, which asks for more. `fingerprint` is the
 * request's run fingerprint, so the SQL the phone is shown later can be
 * checked against it, and `sql` says whether a copy was kept to show at all.
 *
 * `approver` is for the desktop app alone and never reaches a phone. It is
 * approverKey of whoever is signed in here, so the desktop app can tell when
 * that person changes. `canApprove` says whether they may decide at all, and
 * each request's `ownRequest` whether they asked for it, which the decision
 * route refuses unless they may decide their own (mayDecideOwn), so a phone can leave
 * out buttons that would only be refused.
 *
 * The gate is the one the Deploy screen's list has: Approvals: Read. The queue
 * is the caller's organization's only.
 */
export async function GET() {
  const gate = await requirePermission("approvals:read");
  if (!gate.ok) return gate.response;

  try {
    const rows = await listPendingApprovals(gate.principal.orgId);
    const email = gate.principal.email.toLowerCase();

    return NextResponse.json({
      approver: approverKey(gate.principal.email),
      canApprove: hasPermission(gate.principal, "approvals:approve"),
      approvals: rows.map((row) => ({
        // A bigint id arrives from pg as a string of digits.
        id: Number(row.id),
        connectionId: Number(row.connection_id),
        schemaName: row.schema_name,
        scriptName: row.script_name,
        targetVersion: row.target_version,
        action: row.action,
        migrationCount: Number(row.migration_count),
        breakingCount: Number(row.breaking_count),
        requestedBy: row.requested_by,
        // pg hands a timestamptz back as a Date, whatever the type says.
        requestedAt: new Date(row.requested_at).toISOString(),
        note: row.note,
        fingerprint: row.run_fingerprint,
        sql: row.has_sql ? "kept" : "missing",
        ownRequest: !mayDecideOwn(gate.principal) && row.requested_by.toLowerCase() === email,
      })),
    });
  } catch (error) {
    // Logged here, on the computer. The phone only hears that it failed.
    console.error("GET deploy/approvals/phone error:", error);
    return NextResponse.json(
      {
        error:
          "Could not read the approval requests. If this keeps happening, check that the app's database is running.",
      },
      { status: 500 }
    );
  }
}
