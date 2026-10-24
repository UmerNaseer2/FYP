import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth-guard";
import { getApprovalScripts } from "@/lib/approvals-db";
import { hasPermission, refusalMessage } from "@/lib/permissions";

/**
 * GET /api/deploy/approvals/[id]/phone
 *
 * One request and the SQL it covers, for a paired phone to show the person
 * deciding. The desktop app's phone link calls this when a phone opens a
 * request (approvals.read in desktop/src/shared/remote/rpc.ts).
 *
 * `scripts` is the copy kept with the request, and only when it hashes back to
 * the request's fingerprint (getApprovalScripts in lib/approvals-db), so a
 * phone is never shown SQL other than the SQL a yes lets run. It is null when
 * there is no such copy. The desktop app checks the hash again before passing
 * the SQL on, and the phone checks it once more before showing it.
 *
 * Reading the SQL asks for more than reading the queue does. On the Deploy
 * screen an approver reads the migrations from the registry, which needs
 * Scripts: Read or Deploy: Read (the same pair as GET /api/github/pull), so
 * this needs one of those as well as Approvals: Read.
 */
export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const gate = await requirePermission("approvals:read");
  if (!gate.ok) return gate.response;
  if (!hasPermission(gate.principal, "scripts:read", "deploy:read")) {
    return NextResponse.json(
      { error: refusalMessage(gate.principal.roleLabel, "scripts:read") },
      { status: 403 }
    );
  }

  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Unknown approval." }, { status: 400 });
  }

  try {
    const found = await getApprovalScripts(id);
    if (!found) {
      return NextResponse.json({ error: "That approval no longer exists." }, { status: 404 });
    }
    if (found.copy === "does-not-match") {
      // Says which request, never what its SQL is.
      console.warn(
        `Approvals: the SQL kept with request ${found.approval.id} does not match its fingerprint, so a phone is not shown it.`
      );
    }

    return NextResponse.json({
      id: Number(found.approval.id),
      action: found.approval.action,
      fingerprint: found.approval.run_fingerprint,
      scripts: found.scripts,
    });
  } catch (error) {
    // Logged here, on the computer. The phone only hears that it failed.
    console.error("GET deploy/approvals/[id]/phone error:", error);
    return NextResponse.json(
      {
        error:
          "Could not read that approval request. If this keeps happening, check that the app's database is running.",
      },
      { status: 500 }
    );
  }
}
