import { NextRequest, NextResponse } from "next/server";
import { requirePermission, type Principal } from "@/lib/auth-guard";
import { actorFor } from "@/lib/auth-mode";
import { cancelInvite, createEmailInvite, createLinkInvite, listPendingInvites } from "@/lib/invites-db";
import { cleanInviteEmail, inviteEmailProblem, isLinkInviteDays } from "@/lib/invites";

/**
 * Invitations into the caller's organization, from the Users tab.
 *
 * GET lists the ones still waiting to be taken. POST makes one, either to an
 * email address with a role or as a link for Viewers, and answers with its
 * token. That answer is the only time the token leaves the server: the
 * database keeps its hash (lib/invites-db.ts), so the Users tab shows the link
 * once, for the Admin to copy and send, and never again. DELETE cancels one.
 *
 * Reading needs Users: Read, like the member list beside it. Making and
 * cancelling both need Users: Create, because cancelling is part of deciding
 * who gets in, and a role that could cancel but not invite could only ever
 * shut people out.
 *
 * Nobody can be invited in two places, and GET says so with `canInvite`, so
 * the Users tab draws no form that could only be refused:
 *
 * - The desktop app, which keeps one organization of its own that nobody
 *   else can reach.
 * - The demo, with sign-in switched off. Nobody signs in there, so there is no
 *   Admin to have made an invitation and nobody who could take one.
 */

const DESKTOP =
  "Invitations are for the web app. The desktop app keeps a single organization of its own.";
const DEMO =
  "Inviting someone needs a real sign-in. In the demo nobody signs in, so nobody could take an invitation.";

export async function GET() {
  const gate = await requirePermission("users:read");
  if (!gate.ok) return gate.response;

  const canInvite = inviter(gate.principal).ok;
  if (!canInvite) return NextResponse.json({ invites: [], canInvite });
  try {
    const invites = await listPendingInvites(gate.principal.orgId);
    return NextResponse.json({ invites, canInvite });
  } catch (error) {
    console.error("Failed to list invitations:", error);
    return unavailable("Could not read the invitations.");
  }
}

export async function POST(request: NextRequest) {
  const gate = await requirePermission("users:create");
  if (!gate.ok) return gate.response;

  const who = inviter(gate.principal);
  if (!who.ok) return who.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const fields = (typeof body === "object" && body !== null ? body : {}) as Record<
    string,
    unknown
  >;

  const { orgId } = gate.principal;
  const actor = actorFor(gate.principal);

  // Each refusal names the field it is about, so the form can put the message
  // under the box that needs changing.
  if (fields.kind === "email") {
    const email = cleanInviteEmail(typeof fields.email === "string" ? fields.email : "");
    const emailProblem = inviteEmailProblem(email);
    if (emailProblem) {
      return NextResponse.json({ error: emailProblem, field: "email" }, { status: 400 });
    }
    // Whether a role by this name exists is for the roles table to say, as on
    // PUT /api/admin/users: Admins add and delete roles, so there is no fixed
    // list to check it against here.
    const role =
      typeof fields.role === "string" && fields.role.length <= 64
        ? fields.role
        : null;
    if (!role) {
      return NextResponse.json(
        { error: "Choose a role for this person.", field: "role" },
        { status: 400 }
      );
    }

    try {
      const made = await createEmailInvite(orgId, {
        email,
        role,
        invitedBy: who.profileId,
        actor,
      });
      switch (made.kind) {
        case "no-role":
          return NextResponse.json(
            {
              error:
                `There is no role called "${role}". It may have just been deleted: ` +
                "reload the page to see the roles there are now.",
              field: "role",
            },
            { status: 400 }
          );
        case "member":
          return NextResponse.json(
            { error: "Someone with that address is a member here already.", field: "email" },
            { status: 409 }
          );
        case "just-invited":
          return NextResponse.json(
            {
              error:
                "Someone else invited that address a moment ago. " +
                "Reload the page to see their invitation.",
              field: "email",
            },
            { status: 409 }
          );
        case "made":
          return NextResponse.json({ invite: made.invite, token: made.token }, { status: 201 });
      }
    } catch (error) {
      console.error("Failed to make an invitation:", error);
      return unavailable("Could not make the invitation.");
    }
  }

  if (fields.kind === "link") {
    if (!isLinkInviteDays(fields.days)) {
      return NextResponse.json(
        { error: "Choose how long the link lasts: 1, 7 or 30 days.", field: "days" },
        { status: 400 }
      );
    }
    try {
      const made = await createLinkInvite(orgId, {
        days: fields.days,
        invitedBy: who.profileId,
        actor,
      });
      return NextResponse.json({ invite: made.invite, token: made.token }, { status: 201 });
    } catch (error) {
      console.error("Failed to make an invitation link:", error);
      return unavailable("Could not make the invitation link.");
    }
  }

  return NextResponse.json(
    { error: 'Say what to make: "email" for an invitation to an address, or "link".' },
    { status: 400 }
  );
}

export async function DELETE(request: NextRequest) {
  const gate = await requirePermission("users:create");
  if (!gate.ok) return gate.response;

  const who = inviter(gate.principal);
  if (!who.ok) return who.response;

  let body: { id?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const id = Number(body?.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "A valid invitation id is required." }, { status: 400 });
  }

  try {
    const cancelled = await cancelInvite(gate.principal.orgId, id, actorFor(gate.principal));
    if (cancelled.kind === "not-found") {
      // Taken, cancelled already, or never here. The list the Admin is looking
      // at is out of date in every case, so the answer says to reload it.
      return NextResponse.json(
        {
          error:
            "That invitation is not waiting any more. It may have just been taken or cancelled: " +
            "reload the page to see the invitations there are now.",
        },
        { status: 404 }
      );
    }
    return NextResponse.json({ cancelled: true });
  } catch (error) {
    console.error("Failed to cancel an invitation:", error);
    return unavailable("Could not cancel the invitation.");
  }
}

/**
 * The profile an invitation is made in the name of, or the refusal where
 * nobody can invite (see the top of this file).
 */
function inviter(
  principal: Principal
): { ok: true; profileId: number } | { ok: false; response: NextResponse } {
  if (onDesktop()) {
    return { ok: false, response: NextResponse.json({ error: DESKTOP }, { status: 403 }) };
  }
  if (principal.bypass || principal.profileId === null) {
    return { ok: false, response: NextResponse.json({ error: DEMO }, { status: 403 }) };
  }
  return { ok: true, profileId: principal.profileId };
}

/** The desktop app starts this server with SCHEMA_STUDIO_DESKTOP=1 (see auth.config.ts). */
function onDesktop(): boolean {
  return process.env.SCHEMA_STUDIO_DESKTOP === "1";
}

/** A 503 for a database that did not answer, with the reason kept to the log. */
function unavailable(what: string): NextResponse {
  return NextResponse.json(
    { error: `${what} The app's database may be unreachable. Try again in a moment.` },
    { status: 503 }
  );
}
