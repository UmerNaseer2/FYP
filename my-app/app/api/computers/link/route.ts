import { NextRequest, NextResponse } from "next/server";
import { approveLink, denyLink, readLink } from "@/lib/agent-db";
import { readUserCode } from "@/lib/agent-rules";
import { requirePermission } from "@/lib/auth-guard";
import { TRIAL_REFUSAL, isTrialOrg } from "@/lib/trial-rules";

const NEEDS_ACCOUNT = "Linking a computer needs a signed-in account.";
const NO_SUCH_CODE = "That code has expired or is not right. Start again on the computer.";
const COULD_NOT_READ = "Could not read that code.";
const COULD_NOT_LINK = "Could not link that computer.";

function codeFromBody(body: unknown): string | null {
  return readUserCode((body as { code?: unknown } | null)?.code);
}

function logFailure(what: string, error: unknown) {
  console.error(what, error instanceof Error ? error.name : "unknown error");
}

/**
 * GET /api/computers/link?code=XXXX-XXXX: which computer is asking and when it
 * asked, so the person can check both against the computer in front of them.
 */
export async function GET(request: NextRequest) {
  const gate = await requirePermission("compare:read");
  if (!gate.ok) return gate.response;
  const code = readUserCode(request.nextUrl.searchParams.get("code"));
  if (code === null) return NextResponse.json({ error: NO_SUCH_CODE }, { status: 404 });
  try {
    const link = await readLink(code);
    if (link === null) return NextResponse.json({ error: NO_SUCH_CODE }, { status: 404 });
    return NextResponse.json({ computerName: link.computerName, openedAt: link.openedAt });
  } catch (error) {
    logFailure("Could not read a computer link:", error);
    return NextResponse.json({ error: COULD_NOT_READ }, { status: 500 });
  }
}

/** POST /api/computers/link { code }: link that computer to this person, in this organization. */
export async function POST(request: NextRequest) {
  const gate = await requirePermission("compare:read");
  if (!gate.ok) return gate.response;
  const { principal } = gate;
  if (principal.profileId === null) return NextResponse.json({ error: NEEDS_ACCOUNT }, { status: 409 });
  // Everyone in the trial is the same three people, so a computer linked there
  // would be open to every visitor.
  if (isTrialOrg(principal.orgSlug)) return NextResponse.json({ error: TRIAL_REFUSAL }, { status: 403 });
  const code = codeFromBody(await request.json().catch(() => null));
  if (code === null) return NextResponse.json({ error: NO_SUCH_CODE }, { status: 404 });
  try {
    const approved = await approveLink(code, principal.orgId, principal.profileId);
    if (!approved) return NextResponse.json({ error: NO_SUCH_CODE }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    logFailure("Could not approve a computer link:", error);
    return NextResponse.json({ error: COULD_NOT_LINK }, { status: 500 });
  }
}

/** DELETE /api/computers/link { code }: this is not my computer. */
export async function DELETE(request: NextRequest) {
  const gate = await requirePermission("compare:read");
  if (!gate.ok) return gate.response;
  const code = codeFromBody(await request.json().catch(() => null));
  if (code === null) return NextResponse.json({ ok: true });
  try {
    await denyLink(code);
    return NextResponse.json({ ok: true });
  } catch (error) {
    logFailure("Could not turn away a computer link:", error);
    return NextResponse.json({ error: COULD_NOT_READ }, { status: 500 });
  }
}
