import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/auth-guard";
import {
  canAnswerRequests,
  REQUEST_ANSWERS,
  REQUEST_TEXT_MAX,
  type RequestAnswer,
} from "@/lib/access-requests";
import {
  answerAccessRequest,
  getAccessRequest,
  withdrawAccessRequest,
} from "@/lib/access-requests-db";

const UNKNOWN = "That request does not exist.";
const ALREADY = "That request has already been answered.";

/**
 * Answer a request, or take back your own.
 *
 *   { action: "answer", answer: "allowed" | "declined" | "done", note? }
 *   { action: "withdraw" }
 *
 * This only records what happened. Allowing something is done first, through the
 * Roles or Users routes with their own guards, by the page that calls this.
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
  if (action !== "answer" && action !== "withdraw") {
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
    if (!REQUEST_ANSWERS.includes(answer as RequestAnswer)) {
      return NextResponse.json({ error: "Say how you are answering." }, { status: 400 });
    }
    const note = typeof rawNote === "string" ? rawNote.trim() : "";
    if (note.length > REQUEST_TEXT_MAX) {
      return NextResponse.json(
        { error: `Keep the note to ${REQUEST_TEXT_MAX} characters.` },
        { status: 400 }
      );
    }
    const answered = await answerAccessRequest(
      principal.orgId,
      id,
      answer as RequestAnswer,
      principal.email,
      note === "" ? null : note
    );
    if (!answered) return NextResponse.json({ error: ALREADY }, { status: 409 });
    return NextResponse.json({ request: answered });
  } catch (error) {
    console.error("Could not update a request:", error);
    return NextResponse.json({ error: "Could not update this request." }, { status: 500 });
  }
}
