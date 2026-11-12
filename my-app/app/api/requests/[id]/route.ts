import { NextRequest, NextResponse } from "next/server";
import { afterResponse, alertRequestAnswered } from "@/lib/push-alerts";
import { requireMember } from "@/lib/auth-guard";
import {
  canAnswerRequests,
  grantProblem,
  REQUEST_ANSWERS,
  REQUEST_TEXT_MAX,
  type RequestAnswer,
} from "@/lib/access-requests";
import {
  answerAccessRequest,
  endGrant,
  getAccessRequest,
  grantAccessRequest,
  withdrawAccessRequest,
} from "@/lib/access-requests-db";

const UNKNOWN = "That request does not exist.";
const ALREADY = "That request has already been answered.";

/**
 * Answer a request, or take back your own.
 *
 *   { action: "answer", answer: "allowed" | "declined" | "done", note? }
 *   { action: "grant", note? }      allow just the asker, for GRANT_HOURS
 *   { action: "end-grant" }         end such a grant early
 *   { action: "withdraw" }
 *
 * "answer" only records what happened. Allowing something for a whole role is
 * done first, through the Roles or Users routes with their own guards, by the
 * page that calls this. "grant" is the change itself: the asker holds the
 * permission on top of their role until the grant ends (lib/auth-guard.ts).
 *
 * Membership is the gate because anyone may withdraw their own, so answering
 * asks for its rights below. Another organization's request answers 404, the
 * same as one that does not exist.
 */
export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const gate = await requireMember();
  if (!gate.ok) return gate.response;
  const { principal } = gate;

  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: UNKNOWN }, { status: 404 });
  }
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Say what to do with this request." }, { status: 400 });
  }
  const { action, answer, note: rawNote } = body as Record<string, unknown>;
  if (action !== "answer" && action !== "withdraw" && action !== "grant" && action !== "end-grant") {
    return NextResponse.json({ error: "Say what to do with this request." }, { status: 400 });
  }

  try {
    const existing = await getAccessRequest(principal.orgId, id);
    if (!existing) return NextResponse.json({ error: UNKNOWN }, { status: 404 });
    const own = existing.requested_by.toLowerCase() === principal.email.toLowerCase();

    if (action === "withdraw") {
      if (!own) {
        return NextResponse.json({ error: "Only the person who asked can withdraw this." }, { status: 403 });
      }
      const withdrawn = await withdrawAccessRequest(principal.orgId, id, principal.email);
      if (!withdrawn) return NextResponse.json({ error: ALREADY }, { status: 409 });
      return NextResponse.json({ request: withdrawn });
    }

    if (!canAnswerRequests(principal)) {
      return NextResponse.json(
        { error: `Your role (${principal.roleLabel}) can't answer requests.` },
        { status: 403 }
      );
    }
    if (own) {
      return NextResponse.json({ error: "You can't answer your own request." }, { status: 403 });
    }

    if (action === "end-grant") {
      const ended = await endGrant(principal.orgId, id);
      if (!ended) return NextResponse.json({ error: "That has already ended." }, { status: 409 });
      return NextResponse.json({ request: ended });
    }

    if (action === "answer" && !REQUEST_ANSWERS.includes(answer as RequestAnswer)) {
      return NextResponse.json({ error: "Say how you are answering." }, { status: 400 });
    }
    const note = typeof rawNote === "string" ? rawNote.trim() : "";
    if (note.length > REQUEST_TEXT_MAX) {
      return NextResponse.json(
        { error: `Keep the note to ${REQUEST_TEXT_MAX} characters.` },
        { status: 400 }
      );
    }
    if (action === "grant") {
      const problem = grantProblem(principal, existing.permission);
      if (problem) return NextResponse.json({ error: problem }, { status: 403 });
    }
    const answered =
      action === "grant"
        ? await grantAccessRequest(principal.orgId, id, principal.email, note === "" ? null : note)
        : await answerAccessRequest(
            principal.orgId,
            id,
            answer as RequestAnswer,
            principal.email,
            note === "" ? null : note
          );
    if (!answered) return NextResponse.json({ error: ALREADY }, { status: 409 });
    afterResponse(() => alertRequestAnswered(principal, answered));
    return NextResponse.json({ request: answered });
  } catch (error) {
    console.error("Could not update a request:", error);
    return NextResponse.json({ error: "Could not update this request." }, { status: 500 });
  }
}
