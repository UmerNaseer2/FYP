import { NextRequest, NextResponse } from "next/server";
import { afterResponse, alertRequestMade } from "@/lib/push-alerts";
import { requireMember, type Principal } from "@/lib/auth-guard";
import {
  canAnswerRequests,
  REQUEST_TEXT_MAX,
  WAITING_REQUESTS_MAX,
  type RequestCounts,
  type RequestsPayload,
} from "@/lib/access-requests";
import {
  countRequestInbox,
  countRequestsAnsweredSince,
  createAccessRequest,
  listOwnRequests,
  listRequestInbox,
  readRequestsSeen,
} from "@/lib/access-requests-db";
import {
  countOwnRunsAnsweredSince,
  countRunsReadyToRun,
  countRunsToApprove,
  listOwnRuns,
  listRunsReadyToRun,
  listRunsToApprove,
  mayDecideOwn,
} from "@/lib/approvals-db";
import { hasPermission, isAdminOnly, isPermissionKey } from "@/lib/permissions";

/**
 * The Requests page and the count beside its name in the rail. Any member may
 * ask and read their own; see lib/access-requests.ts for what else they get.
 */

/** The production runs waiting on this person leave out their own unless they may decide those. */
function ownRunsLeftOut(principal: Principal): string | null {
  return mayDecideOwn(principal) ? null : principal.email;
}

async function countsFor(principal: Principal, lastSeenAt: string | null): Promise<RequestCounts> {
  const { orgId, email } = principal;
  const [inbox, toApprove, toRun, answeredRequests, answeredRuns] = await Promise.all([
    canAnswerRequests(principal) ? countRequestInbox(orgId, email) : 0,
    hasPermission(principal, "approvals:approve")
      ? countRunsToApprove(orgId, ownRunsLeftOut(principal))
      : 0,
    hasPermission(principal, "deploy:run") ? countRunsReadyToRun(orgId) : 0,
    // The sign-in bypass has no membership to keep "last seen" on, so nothing
    // could ever clear this count for it.
    principal.profileId === null ? 0 : countRequestsAnsweredSince(orgId, email, lastSeenAt),
    principal.profileId === null ? 0 : countOwnRunsAnsweredSince(orgId, email, lastSeenAt),
  ]);
  return { waiting: inbox + toApprove + toRun, answered: answeredRequests + answeredRuns };
}

export async function GET(request: NextRequest) {
  const gate = await requireMember();
  if (!gate.ok) return gate.response;
  const { principal } = gate;
  const { orgId, email } = principal;

  try {
    const lastSeenAt =
      principal.profileId === null ? null : await readRequestsSeen(orgId, principal.profileId);
    const counts = await countsFor(principal, lastSeenAt);
    if (request.nextUrl.searchParams.get("only") === "counts") {
      return NextResponse.json({ counts });
    }

    const canAnswer = canAnswerRequests(principal);
    const [mine, inbox, runsToApprove, runsToRun, myRuns] = await Promise.all([
      listOwnRequests(orgId, email),
      canAnswer ? listRequestInbox(orgId, email) : [],
      hasPermission(principal, "approvals:approve")
        ? listRunsToApprove(orgId, ownRunsLeftOut(principal))
        : [],
      hasPermission(principal, "deploy:run") ? listRunsReadyToRun(orgId) : [],
      listOwnRuns(orgId, email),
    ]);
    const payload: RequestsPayload = {
      mine,
      inbox,
      runsToApprove,
      runsToRun,
      myRuns,
      canAnswer,
      lastSeenAt,
      counts,
    };
    return NextResponse.json(payload);
  } catch (error) {
    console.error("Could not read requests:", error);
    return NextResponse.json({ error: "Could not load requests." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const gate = await requireMember();
  if (!gate.ok) return gate.response;
  const { principal } = gate;

  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Say what you need." }, { status: 400 });
  }
  const { permission: rawPermission, message: rawMessage } = body as Record<string, unknown>;
  const message = typeof rawMessage === "string" ? rawMessage.trim() : "";
  if (message.length > REQUEST_TEXT_MAX) {
    return NextResponse.json(
      { error: `Keep it to ${REQUEST_TEXT_MAX} characters.` },
      { status: 400 }
    );
  }

  let permission: string | null = null;
  if (rawPermission !== null && rawPermission !== undefined) {
    if (!isPermissionKey(rawPermission)) {
      return NextResponse.json({ error: "Pick something from the list." }, { status: 400 });
    }
    // The grid has no box for these, so nobody could ever allow one.
    if (isAdminOnly(rawPermission)) {
      return NextResponse.json(
        { error: 'Only admins can do that. Choose "Something else" and say what you need.' },
        { status: 400 }
      );
    }
    if (hasPermission(principal, rawPermission)) {
      return NextResponse.json({ error: "Your role can already do that." }, { status: 400 });
    }
    permission = rawPermission;
  } else if (message === "") {
    return NextResponse.json({ error: "Say what you need." }, { status: 400 });
  }

  try {
    const result = await createAccessRequest({
      orgId: principal.orgId,
      email: principal.email,
      name: principal.name,
      permission,
      message: message === "" ? null : message,
    });
    if (result.kind === "too-many") {
      return NextResponse.json(
        {
          error:
            `You have ${WAITING_REQUESTS_MAX} requests waiting. ` +
            "Withdraw one, or wait for an answer, before asking for more.",
        },
        { status: 429 }
      );
    }
    if (result.kind === "already") {
      return NextResponse.json({ request: result.request, already: true });
    }
    afterResponse(() => alertRequestMade(principal, result.request));
    return NextResponse.json({ request: result.request, already: false }, { status: 201 });
  } catch (error) {
    console.error("Could not save a request:", error);
    return NextResponse.json({ error: "Could not send your request." }, { status: 500 });
  }
}
