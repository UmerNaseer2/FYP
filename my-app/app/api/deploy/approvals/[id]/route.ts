import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth-guard";
import {
  approverKey,
  decideApproval,
  decisionBlockReason,
  mayDecideOwn,
  getApproval,
} from "@/lib/approvals-db";

/**
 * Approve or reject one deploy or rollback request — the second half of the
 * two-person rule. The row's `action` says which one it is; the rule is the
 * same for both.
 *
 * Two things make this a real gate rather than a second checkbox:
 *
 *   - It needs Approvals: Approve, a permission of its own, so being allowed
 *     to run a deploy is not enough to clear one. Out of the box only admins
 *     hold it.
 *   - It refuses a decision from the person who asked. That check lives here
 *     AND as a CHECK constraint on the table, because a rule enforced only in
 *     application code is one refactor away from not being enforced at all.
 *
 * There are two documented exceptions (mayDecideOwn in lib/approvals-db). With
 * NEXT_PUBLIC_AUTH_BYPASS on there is exactly one principal, so "a second
 * person" cannot exist and the whole path would be untestable. And an Admin
 * may switch their organization's two-person rule off on the Organization tab,
 * for a team of one. Either way the row records that it happened, in
 * `self_approved`, rather than quietly looking like a real two-person approval.
 *
 * A paired phone decides through here too, by way of the desktop app's phone
 * link (desktop/src/main/phone-approvals.ts). It sends two more fields, and
 * the decision is recorded only while both still hold:
 *
 *   - `expectedFingerprint`: the run the person read on the phone. A request's
 *     fingerprint never changes, so a different one means the phone was shown
 *     some other request (one from before a backup was restored, say).
 *   - `expectedApprover`: approverKey of the person who set up approvals on
 *     that phone, so the phone cannot decide as whoever signs in here next.
 *
 * Either one that does not match gets a 412 and changes nothing. The Deploy
 * screen sends neither, so nothing changes for it.
 *
 * Only a request in the decider's organization can be decided. Another
 * organization's request answers 404, the same as one that was deleted, and
 * the write names the organization too, so it could not land there anyway.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const gate = await requirePermission("approvals:approve");
  if (!gate.ok) return gate.response;

  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Unknown approval." }, { status: 400 });
  }

  let body: {
    decision?: string;
    note?: string;
    expectedFingerprint?: unknown;
    expectedApprover?: unknown;
  };
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

  // Checked before anything is read, so a field the phone link wrote wrongly
  // is never mistaken for a request that changed.
  const { expectedFingerprint, expectedApprover } = body;
  if (expectedFingerprint !== undefined && !isDigest(expectedFingerprint)) {
    return NextResponse.json(
      { error: "expectedFingerprint must be 64 lowercase hex characters." },
      { status: 400 }
    );
  }
  if (expectedApprover !== undefined && !isDigest(expectedApprover)) {
    return NextResponse.json(
      { error: "expectedApprover must be 64 lowercase hex characters." },
      { status: 400 }
    );
  }

  try {
    const approval = await getApproval(gate.principal.orgId, id);
    if (!approval) {
      return NextResponse.json({ error: "That approval no longer exists." }, { status: 404 });
    }

    if (expectedFingerprint !== undefined && approval.run_fingerprint !== expectedFingerprint) {
      return NextResponse.json(
        {
          error:
            "This request is not for the SQL that was read before deciding. Read it again, then decide.",
        },
        { status: 412 }
      );
    }
    if (expectedApprover !== undefined && approverKey(gate.principal.email) !== expectedApprover) {
      return NextResponse.json(
        {
          error:
            "The person signed in is not the one who set up approvals on that phone, so the decision was not recorded.",
        },
        { status: 412 }
      );
    }

    const selfAllowed = mayDecideOwn(gate.principal);
    const blocked = decisionBlockReason(approval, gate.principal.email, selfAllowed);
    if (blocked) {
      return NextResponse.json({ error: blocked }, { status: 403 });
    }

    const decided = await decideApproval({
      orgId: gate.principal.orgId,
      id,
      approve: decision === "approve",
      decidedBy: gate.principal.email,
      // Only ever true under one of the two exceptions in the note above.
      // Outside them, the requester is refused before reaching this line, and
      // the table's CHECK constraint would refuse the write anyway.
      selfApproved:
        selfAllowed &&
        approval.requested_by.toLowerCase() === gate.principal.email.toLowerCase(),
      note: (body.note ?? "").trim().slice(0, 500) || null,
    });

    if (!decided) {
      // Someone decided it between the read and the write. Their decision
      // stands; report what it became rather than overwriting it.
      const current = await getApproval(gate.principal.orgId, id);
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

/** A SHA-256 written the way runFingerprint and approverKey write it. */
function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
