import { NextResponse } from "next/server";
import { requireMember } from "@/lib/auth-guard";
import { approverKey } from "@/lib/approvals-db";
import { hasPermission } from "@/lib/permissions";

/**
 * Who is signed in, as the desktop app needs to know it for a paired phone's
 * passkey.
 *
 * A passkey is kept with this hash of the signer's email, and acts only for
 * that person: when someone else signs in on the computer, the passkey on the
 * phone stops counting. The hash stays on the computer and never reaches a
 * phone. See desktop/src/main/phone-approvals.ts.
 *
 * It is apart from /api/me on purpose. That answer goes to every screen and
 * never says who you are, and this one is for the desktop app alone.
 *
 * Any member may ask, because someone may set up a passkey to deploy without
 * being able to read the approval queue, and that queue's route used to be the
 * only place this hash came from.
 */
export async function GET() {
  const gate = await requireMember();
  if (!gate.ok) return gate.response;

  const { principal } = gate;
  return NextResponse.json({
    approver: approverKey(principal.email),
    canApprove: hasPermission(principal, "approvals:approve"),
    // What a passkey is for besides approving: the actions the phone link signs.
    canControl: hasPermission(principal, "deploy:run", "approvals:create", "performance:update"),
  });
}
