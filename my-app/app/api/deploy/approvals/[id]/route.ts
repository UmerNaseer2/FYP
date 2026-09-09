import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-guard";
import {
  decideApproval,
  decisionBlockReason,
  getApproval,
} from "@/lib/approvals-db";

/**
 * Approve or reject one deploy request — the second half of the two-person
 * rule.
 *
 * Two things make this a real gate rather than a second checkbox:
 *
 *   - It needs the `admin` role, so the person who can run a deploy (editor)
 *     cannot also clear it.
 *   - It refuses a decision from the person who asked. That check lives here
 *     AND as a CHECK constraint on the table, because a rule enforced only in
 *     application code is one refactor away from not being enforced at all.
 *
 * The bypass is the single documented exception. With NEXT_PUBLIC_AUTH_BYPASS
 * on there is exactly one principal, so "a second person" cannot exist and the
 * whole path would be untestable. The row records that it happened, in
 * `self_approved`, rather than quietly looking like a real two-person approval.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const gate = await requireAdmin();
  if (!gate.ok) return gate.response;

  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Unknown approval." }, { status: 400 });
  }

  let body: { decision?: string; note?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body is not valid JSON." }, { status: 400 });
  }

  const decision = String(body.decision ?? "").trim();
  if (decision !== "approve" && decision !== "reject") {
    return NextResponse.json(
      { error: 'decision must be "approve" or "reject".' },
      { status: 400 }
    );
  }

  try {
    const approval = await getApproval(id);
    if (!approval) {
      return NextResponse.json({ error: "That approval no longer exists." }, { status: 404 });
    }

    const blocked = decisionBlockReason(approval, gate.principal.email, gate.principal.bypass);
    if (blocked) {
      return NextResponse.json({ error: blocked }, { status: 403 });
    }

    const decided = await decideApproval({
      id,
      approve: decision === "approve",
      decidedBy: gate.principal.email,
      // Only ever true under the bypass — see the note above. Outside it, the
      // requester is refused before reaching this line, and the table's CHECK
      // constraint would refuse the write anyway.
      selfApproved:
        gate.principal.bypass &&
        approval.requested_by.toLowerCase() === gate.principal.email.toLowerCase(),
      note: (body.note ?? "").trim().slice(0, 500) || null,
    });

    if (!decided) {
      // Someone decided it between the read and the write. Their decision
      // stands; report what it became rather than overwriting it.
      const current = await getApproval(id);
      return NextResponse.json(
        {
          error: `Someone else already ${current?.status ?? "decided"} this request.`,
          approval: current,
        },
        { status: 409 }
      );
    }

    return NextResponse.json({ approval: decided });
  } catch (error) {
    console.error("Approvals — decision failed:", error);
    return NextResponse.json(
      { error: "Could not record the decision." },
      { status: 500 }
    );
  }
}
