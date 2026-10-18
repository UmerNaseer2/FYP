import { NextRequest, NextResponse } from "next/server";
import { requireSignedIn } from "@/lib/auth-guard";
import { BYPASS_AUTH, VIEW_AS_COOKIE } from "@/lib/auth-mode";

/**
 * What the caller may do, in the same words the API routes use to decide.
 *
 * With real sign-in the session already carries this (see the session
 * callback in auth.ts), so the screens read it from there. With the bypass on
 * there is no session, and this is what hooks/useUser asks once "View as" has
 * picked a role: the answer comes from the same getPrincipal every gate
 * calls, so the screens show exactly what the server will allow.
 *
 * It answers even when the role could not be read (`accessUnavailable`), so a
 * screen can say "try again" instead of "your role can't".
 */
export async function GET(request: NextRequest) {
  const gate = await requireSignedIn();
  if (!gate.ok) return gate.response;

  const principal = gate.principal;
  const response = NextResponse.json({
    role: principal.role,
    roleLabel: principal.roleLabel,
    permissions: principal.permissions,
    bypass: principal.bypass,
    viewingAs: principal.viewingAs,
    accessUnavailable: principal.accessUnavailable === true,
  });

  // A View as cookie that did not take: the role it names was deleted after it
  // was picked, or it names admin, which the bypass already is. Either way the
  // server is acting as the full admin. Clearing it means the picker says Admin
  // too, and the browser stops asking about a role that is gone. Not when the
  // database failed to answer, because then the role may well still be there.
  if (
    BYPASS_AUTH &&
    request.cookies.get(VIEW_AS_COOKIE)?.value &&
    principal.viewingAs === null &&
    !principal.accessUnavailable
  ) {
    response.cookies.set(VIEW_AS_COOKIE, "", { path: "/", maxAge: 0 });
  }
  return response;
}
