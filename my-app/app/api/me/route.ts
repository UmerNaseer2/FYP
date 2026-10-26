import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/auth-guard";
import { BYPASS_AUTH, VIEW_AS_COOKIE } from "@/lib/auth-mode";

/**
 * What the caller may do, in the same words the API routes use to decide.
 *
 * Every screen asks this, with real sign-in as much as with the bypass. The
 * sign-in session only says who someone is (see auth.ts). Their role is on
 * their membership, and this answer comes from the same gate every API route
 * calls (lib/auth-guard.ts), read fresh each time, so the screens show exactly
 * what the server will allow rather than whatever was true at sign-in.
 *
 * It names the organization the answer is about, so a screen can say where
 * you are. It never says who you are: the browser has the session for that,
 * and the desktop app reads it to answer a paired phone
 * (desktop/src/main/phone-requests.ts), which has no need of it.
 *
 * Someone who is not a member gets the gate's 404, and someone whose role
 * could not be read its 503, so a screen can tell "you do not belong here"
 * from "try again in a moment".
 */
export async function GET(request: NextRequest) {
  const gate = await requireMember();
  if (!gate.ok) return gate.response;

  const principal = gate.principal;
  const response = NextResponse.json({
    role: principal.role,
    roleLabel: principal.roleLabel,
    permissions: principal.permissions,
    bypass: principal.bypass,
    viewingAs: principal.viewingAs,
    org: { slug: principal.orgSlug, name: principal.orgName },
  });

  // A View as cookie that did not take: the role it names was deleted after it
  // was picked, or it names admin, which the bypass already is. Either way the
  // server is acting as the full admin. Clearing it means the picker says Admin
  // too, and the browser stops asking about a role that is gone. A database
  // that did not answer never gets this far: the gate has already said 503,
  // and the cookie stays, because the role may well still be there.
  if (BYPASS_AUTH && request.cookies.get(VIEW_AS_COOKIE)?.value && principal.viewingAs === null) {
    response.cookies.set(VIEW_AS_COOKIE, "", { path: "/", maxAge: 0 });
  }
  return response;
}
