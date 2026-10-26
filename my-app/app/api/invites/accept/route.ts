import { NextRequest, NextResponse } from "next/server";
import { requireSignedIn } from "@/lib/auth-guard";
import { acceptInvite, type InviteAcceptance } from "@/lib/invites-db";

/**
 * Take an invitation: join the organization it is for.
 *
 * The invitation page (app/invite/[token]/page.tsx) posts here when someone
 * presses Join. It opens with requireSignedIn rather than a gate on an
 * organization, because the person asking is not in the organization yet:
 * that is the point of asking. The invitation decides which organization, and
 * lib/invites-db.ts acceptInvite checks everything about it again inside the
 * transaction that joins, so nothing the page showed is trusted.
 *
 * The answers, by what acceptInvite found:
 *
 * - joined, or a member already: 200, with the organization to open. A second
 *   press of Join lands here too, and opening the organization is still the
 *   right thing to do.
 * - No invitation with that token: 404. Cancelled, run out, or used: 410,
 *   because it did exist and will not work again. None of these names the
 *   organization, since a link that does not work could be anybody's.
 * - An invitation to an address this person has not signed in with: 403,
 *   naming the address with most of it hidden, so they can tell which of their
 *   accounts to use.
 *
 * Refused in the desktop app, which keeps one organization of its own, and in
 * the demo, where nobody is signed in to join as.
 */
export async function POST(request: NextRequest) {
  const gate = await requireSignedIn();
  if (!gate.ok) return gate.response;

  const { caller } = gate;
  if (onDesktop()) {
    return NextResponse.json(
      { error: "The desktop app keeps a single organization of its own." },
      { status: 403 }
    );
  }
  if (caller.bypass) {
    return NextResponse.json(
      { error: "Taking an invitation needs a real sign-in. The demo has nobody to join as." },
      { status: 403 }
    );
  }

  let body: { token?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  // acceptInvite checks the token's shape before asking the database, and a
  // malformed one is just an invitation that does not exist.
  const token = typeof body?.token === "string" ? body.token : "";

  try {
    return answer(await acceptInvite(token, caller.profileId));
  } catch (error) {
    console.error("Failed to take an invitation:", error);
    return NextResponse.json(
      {
        error:
          "Could not take the invitation. The app's database may be unreachable. " +
          "Try again in a moment.",
      },
      { status: 503 }
    );
  }
}

function answer(result: InviteAcceptance): NextResponse {
  switch (result.kind) {
    case "joined":
      return NextResponse.json({ organization: result.organization, joined: true });
    case "member":
      return NextResponse.json({ organization: result.organization, joined: false });
    case "invalid":
      return NextResponse.json(
        { error: "This invitation link does not work. Check it was copied whole.", state: "invalid" },
        { status: 404 }
      );
    case "revoked":
      return NextResponse.json(
        { error: "This invitation was cancelled. Ask for a new one.", state: "revoked" },
        { status: 410 }
      );
    case "expired":
      return NextResponse.json(
        { error: "This invitation has run out. Ask for a new one.", state: "expired" },
        { status: 410 }
      );
    case "used":
      return NextResponse.json(
        { error: "This invitation has been used already.", state: "used" },
        { status: 410 }
      );
    case "wrong-account":
      return NextResponse.json(
        {
          error: `This invitation is for ${result.maskedEmail}. Sign in with that address to take it.`,
          state: "wrong-account",
        },
        { status: 403 }
      );
    case "no-profile":
      // The profile was deleted after this person signed in. Signing in again
      // makes them a new one.
      return NextResponse.json({ error: "Sign in again to continue." }, { status: 401 });
  }
}

/** The desktop app starts this server with SCHEMA_STUDIO_DESKTOP=1 (see auth.config.ts). */
function onDesktop(): boolean {
  return process.env.SCHEMA_STUDIO_DESKTOP === "1";
}
