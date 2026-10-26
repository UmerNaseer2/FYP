import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/auth-guard";
import { BYPASS_AUTH, VIEW_AS_COOKIE } from "@/lib/auth-mode";
import { ADMIN_ROLE, BUILT_IN_ROLE_INFO } from "@/lib/permissions";
import { getRoleAccess, listRoles } from "@/lib/roles-db";

/**
 * The "View as" switcher on the studio rail (components/studio/ViewAsSwitcher).
 *
 * GET lists the roles there are to pick from. POST picks one, by leaving the
 * cookie that bypassPrincipal in lib/auth-guard.ts reads on every request, or
 * clears it to go back to the full admin. The roles are the default
 * organization's, the one the bypass acts in.
 *
 * Only while authentication is off. With real sign-in a person is their role
 * and nothing else, and this route answers 404 as if it did not exist, before
 * it even looks at who is asking: being signed in must not make a way to wear
 * another role appear.
 */

/** The longest value worth looking up. Role keys are 32 characters at most. */
const ROLE_MAX = 64;

function notAvailable() {
  return NextResponse.json(
    { error: "View as is only available while authentication is off." },
    { status: 404 }
  );
}

export async function GET() {
  if (!BYPASS_AUTH) return notAvailable();
  const gate = await requireMember();
  if (!gate.ok) return gate.response;

  try {
    const roles = await listRoles(gate.principal.orgId);
    return NextResponse.json({
      viewingAs: gate.principal.viewingAs,
      // Names and labels only: what each role may do is the Admin screen's
      // business, and the picker only needs something to show.
      roles: roles.map((role) => ({ name: role.name, label: role.label })),
    });
  } catch (error) {
    console.error("Could not list the roles for View as:", error);
    return NextResponse.json(
      {
        error:
          "Could not load the roles, because the app's database did not answer. " +
          "Try again in a moment.",
      },
      { status: 503 }
    );
  }
}

export async function POST(request: NextRequest) {
  if (!BYPASS_AUTH) return notAvailable();
  const gate = await requireMember();
  if (!gate.ok) return gate.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  // A list is an object to typeof, but it has no role in it, and reading it as
  // "back to Admin" would make a malformed request do something.
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const role = (body as { role?: unknown }).role;

  // Admin, or no role at all, means "stop viewing as anyone": the cookie is
  // cleared and there is no role to look up. The gate above has still read the
  // organization and the role the cookie names, so with the database down this
  // is its 503 like every other request, and going back to Admin would not
  // make anything else work then either.
  if (role === undefined || role === null || role === "" || role === ADMIN_ROLE) {
    const response = NextResponse.json({
      viewingAs: null,
      roleLabel: BUILT_IN_ROLE_INFO.admin.label,
    });
    response.cookies.set(VIEW_AS_COOKIE, "", { path: "/", maxAge: 0 });
    return response;
  }
  if (typeof role !== "string" || role.length > ROLE_MAX) {
    return NextResponse.json({ error: "Choose a role to view the app as." }, { status: 400 });
  }

  let access;
  try {
    access = await getRoleAccess(gate.principal.orgId, role);
  } catch (error) {
    console.error("Could not look up the role picked in View as:", error);
    return NextResponse.json(
      {
        error:
          "Could not switch roles, because the app's database did not answer. " +
          "Try again in a moment.",
      },
      { status: 503 }
    );
  }
  if (!access) {
    return NextResponse.json(
      {
        error:
          "That role does not exist any more. Reload the page to see the roles there are now.",
      },
      { status: 400 }
    );
  }

  const response = NextResponse.json({
    viewingAs: access.role,
    roleLabel: access.roleLabel,
  });
  // Not HttpOnly: the browser reads it too, to know whether to ask /api/me
  // what the role may do (hooks/useUser). No expiry, so it goes when the
  // browser is closed and a tester is not left as a viewer next week
  // wondering where the buttons went.
  response.cookies.set(VIEW_AS_COOKIE, access.role, {
    path: "/",
    sameSite: "lax",
    httpOnly: false,
    secure: request.nextUrl.protocol === "https:",
  });
  return response;
}
