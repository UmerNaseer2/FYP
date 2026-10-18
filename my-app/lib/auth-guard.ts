import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { auth } from "@/auth";
import { BYPASS_AUTH, BYPASS_PRINCIPAL, VIEW_AS_COOKIE } from "./auth-mode";
import {
  ADMIN_ROLE,
  ALL_PERMISSIONS,
  BUILT_IN_ROLE_INFO,
  DEFAULT_ROLE,
  hasPermission,
  isPermissionKey,
  refusalMessage,
  type PermissionKey,
} from "./permissions";
import { getRoleAccess } from "./roles-db";

/**
 * Server-side authentication and permission checks for API routes.
 *
 * Before this existed, exactly one of the twenty-one route handlers checked a
 * session (`/api/admin/users`). Everything else — saving credentials, running
 * DDL against a target database, reverting a migration, pushing to the script
 * registry — was reachable by anyone who could reach the app. The client-side
 * <AuthGuard> protected none of it, because a route handler never runs React.
 *
 * Every route now opens with one of these gates, naming the permission it
 * needs (`requirePermission("connections:create")`, see lib/permissions.ts for
 * the full list). What a role may do is whatever the admin ticked for it on
 * the Roles tab, read fresh on every request, so a change there applies to
 * the very next call. tests/permissions-coverage.test.ts fails the build for
 * a route method that opens without a gate.
 *
 * The gates honour the same BYPASS_AUTH switch as the UI (lib/auth-mode). With
 * the bypass on, the caller is a full admin, unless "View as" on the studio
 * rail has picked a role to try the app as (see bypassPrincipal below).
 */

export type Principal = {
  email: string;
  name: string;
  /** The role's key: "viewer", "editor", "admin", or a custom role's. */
  role: string;
  /** The role's name as people read it, for messages: "Editor", "QA Lead". */
  roleLabel: string;
  /** What this caller may do. Ask with hasPermission, never by role name. */
  permissions: readonly PermissionKey[];
  /** True when this principal came from the bypass, not from a real session. */
  bypass: boolean;
  /**
   * The role "View as" is showing the app as, while the bypass is on. Null
   * when the bypass is acting as the full admin it normally is, and always
   * null with real sign-in.
   */
  viewingAs: string | null;
  /**
   * True when the database could not say what this role may do. The gates
   * answer 503 for it: refusing with "your role can't" would blame a role
   * nobody could read.
   */
  accessUnavailable?: boolean;
};

export type Gate =
  | { ok: true; principal: Principal }
  | { ok: false; response: NextResponse };

const SIGN_IN_FIRST = "Sign in to continue.";
const ACCESS_UNAVAILABLE =
  "Could not check what your role can do, because the app's database did not answer. " +
  "Try again in a moment.";

/** The bypass's normal self: everything, as the Admin role. */
function bypassAdmin(): Principal {
  return {
    ...BYPASS_PRINCIPAL,
    roleLabel: BUILT_IN_ROLE_INFO.admin.label,
    permissions: ALL_PERMISSIONS,
    bypass: true,
    viewingAs: null,
  };
}

/**
 * Who the bypass is acting as.
 *
 * With no sign-in there is no way to see the app as a viewer or an editor
 * sees it, which is how anyone checks that a role's boxes do what they say.
 * "View as" fills that gap: it leaves a cookie naming a role, and while the
 * cookie is there this answers with that role's permissions instead of
 * everything. It only exists with the bypass on. With real sign-in a person is
 * their role and nothing else, and the cookie is never read.
 *
 * The email and name stay the bypass's own, so an audit row written while
 * viewing as a role still says authentication was off (see actorFor).
 */
async function bypassPrincipal(): Promise<Principal> {
  let picked: string | undefined;
  try {
    picked = (await cookies()).get(VIEW_AS_COOKIE)?.value;
  } catch {
    // cookies() only works while a request is being answered. Outside one
    // there is no switcher to read, so the bypass is the admin it always was.
    return bypassAdmin();
  }
  // "Admin (everything)" clears the cookie rather than setting it, so one that
  // names admin was set by hand. It means the bypass's normal self, and it is
  // answered as that, with viewingAs null, so /api/me clears it like any
  // other cookie that did not take.
  if (!picked || picked === ADMIN_ROLE) return bypassAdmin();

  try {
    const access = await getRoleAccess(picked);
    // A role deleted since it was picked: the switcher shows Admin again too.
    if (!access) return bypassAdmin();
    return {
      ...bypassAdmin(),
      role: access.role,
      roleLabel: access.roleLabel,
      permissions: access.permissions,
      viewingAs: access.role,
    };
  } catch (error) {
    console.error("Could not read the role picked in View as:", error);
    // Not the full admin: someone who picked a role to see what it cannot do
    // must not be quietly handed everything because the read failed.
    // The cookie is whatever the browser sent, so it is cut to a role key's
    // length before it is repeated anywhere.
    const role = picked.slice(0, 32);
    return {
      ...bypassAdmin(),
      role,
      roleLabel: role,
      permissions: [],
      viewingAs: role,
      accessUnavailable: true,
    };
  }
}

/**
 * Resolve who is calling. Returns null when there is no session (and the bypass
 * is off). Never throws — an auth backend that is down must read as "not signed
 * in", not as a 500 that leaks the reason.
 */
export async function getPrincipal(): Promise<Principal | null> {
  if (BYPASS_AUTH) return bypassPrincipal();

  try {
    const session = await auth();
    const email = session?.user?.email;
    if (!email) return null;

    const role = session.user.role ?? DEFAULT_ROLE;
    return {
      email,
      name: session.user.name ?? email,
      role,
      roleLabel: session.user.roleLabel ?? role,
      // Filtered so that a permission the catalogue no longer has can never
      // match a check, whatever an old session carried.
      permissions: (session.user.permissions ?? []).filter(isPermissionKey),
      bypass: false,
      viewingAs: null,
      accessUnavailable: session.user.accessError === true,
    };
  } catch (error) {
    console.error("Session lookup failed:", error);
    return null;
  }
}

function refuse(status: number, error: string): Gate {
  return { ok: false, response: NextResponse.json({ error }, { status }) };
}

/**
 * Require a session whose role holds at least ONE of these permissions.
 *
 * Returns a discriminated union rather than throwing, so the call site reads:
 *
 *     const gate = await requirePermission("connections:create");
 *     if (!gate.ok) return gate.response;
 *
 * Using a union (rather than `instanceof NextResponse`) means TypeScript
 * narrows `gate.principal` for you and a forgotten check is a type error at the
 * point of use, not a silent hole.
 *
 * Several keys mean any of them will do. The connection list, for one, is
 * read by seven screens, and a role that may open any one of them needs it.
 * The refusal names the first key, so list the one that reads best in
 * "Your role can't ..." first.
 *
 * Always written with the keys as plain strings at the call site:
 * tests/permissions-coverage.test.ts reads them from the source to prove
 * every permission is checked somewhere.
 */
export async function requirePermission(
  ...keys: [PermissionKey, ...PermissionKey[]]
): Promise<Gate> {
  const principal = await getPrincipal();
  if (!principal) return refuse(401, SIGN_IN_FIRST);
  if (principal.accessUnavailable) return refuse(503, ACCESS_UNAVAILABLE);
  if (!hasPermission(principal, ...keys)) {
    return refuse(403, refusalMessage(principal.roleLabel, keys[0]));
  }
  return { ok: true, principal };
}

/**
 * Require a session and nothing more, for the few routes that are about the
 * caller rather than a feature: what am I allowed to do, which role am I
 * viewing the app as. They answer even when the role could not be read, so
 * the screen can say so.
 */
export async function requireSignedIn(): Promise<Gate> {
  const principal = await getPrincipal();
  if (!principal) return refuse(401, SIGN_IN_FIRST);
  return { ok: true, principal };
}
