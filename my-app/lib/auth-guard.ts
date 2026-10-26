import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { auth } from "@/auth";
import { BYPASS_AUTH, BYPASS_PRINCIPAL, VIEW_AS_COOKIE } from "./auth-mode";
import {
  ADMIN_ROLE,
  ALL_PERMISSIONS,
  BUILT_IN_ROLE_INFO,
  hasPermission,
  refusalMessage,
  type PermissionKey,
} from "./permissions";
import { findDefaultOrganization, findMembership, type Organization } from "./orgs-db";
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
 * Every request also acts in one organization, and the gate is where it is
 * found. For now that is always the default organization (see lib/orgs-db.ts).
 * With real sign-in the caller has to hold a membership there, and their role
 * is the one that membership names. Both are read on every request, the same
 * as the role's permissions, so an admin who removes someone or changes their
 * role does not have to wait for that person's sign-in to run out: it holds
 * from their next click. Every query a route makes is then filtered by the
 * principal's orgId.
 *
 * The gates answer in the same order:
 *
 *     401  nobody is signed in
 *     404  signed in, but not a member of the organization
 *     503  the app's database did not answer, so nobody can say what the
 *          caller may do, and the gate does not guess in either direction
 *     403  a member whose role does not hold the permission
 *
 * Not being a member is a 404 rather than a 403 so that it reads the same as
 * an organization that does not exist. Someone who does not belong to an
 * organization should not learn from the answer that it is there.
 *
 * The gates honour the same BYPASS_AUTH switch as the UI (lib/auth-mode). With
 * the bypass on, the caller is a full admin of the default organization,
 * unless "View as" on the studio rail has picked a role to try the app as (see
 * bypassPrincipal below).
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
   * The organization this request acts in. Every query a route makes is
   * filtered by orgId; the slug and the name are for screens and links.
   */
  orgId: number;
  orgSlug: string;
  orgName: string;
  /**
   * Whether orgId is the default organization. It decides where the
   * organization's scripts live in the GitHub registry: the default one's at
   * the top, as they always were, any other's under orgs/<id>
   * (registryRoot in lib/registry-paths.ts).
   */
  orgIsDefault: boolean;
};

export type Gate =
  | { ok: true; principal: Principal }
  | { ok: false; response: NextResponse };

/**
 * What looking up the caller found. The three that are not a principal are
 * kept apart, rather than all being "nobody", because each needs a different
 * answer: sign in, you do not belong here, or try again in a moment.
 */
type Resolution =
  | { kind: "ok"; principal: Principal }
  | { kind: "signed-out" }
  | { kind: "not-member" }
  | { kind: "unavailable" };

const SIGN_IN_FIRST = "Sign in to continue.";
const NOT_A_MEMBER = "This organization does not exist, or you are not a member.";
const ACCESS_UNAVAILABLE =
  "Could not check what your role can do, because the app's database did not answer. " +
  "Try again in a moment.";

/** The bypass's normal self: everything, as the Admin of the default organization. */
function bypassAdmin(org: Organization): Principal {
  return {
    ...BYPASS_PRINCIPAL,
    roleLabel: BUILT_IN_ROLE_INFO.admin.label,
    permissions: ALL_PERMISSIONS,
    bypass: true,
    viewingAs: null,
    orgId: org.id,
    orgSlug: org.slug,
    orgName: org.name,
    orgIsDefault: org.isDefault,
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
 *
 * The bypass acts in the default organization. With nobody signed in there is
 * no membership to read, and the default organization is the one everything
 * from before organizations existed was moved into, so this is the app as it
 * always was.
 */
async function bypassPrincipal(): Promise<Resolution> {
  let org: Organization | null;
  try {
    org = await findDefaultOrganization();
  } catch (error) {
    console.error("Could not read the default organization:", error);
    return { kind: "unavailable" };
  }
  // Only when somebody has deleted its row by hand. There is nothing left to
  // act in, and "not a member" is the answer that says so without guessing.
  if (!org) return { kind: "not-member" };

  let picked: string | undefined;
  try {
    picked = (await cookies()).get(VIEW_AS_COOKIE)?.value;
  } catch {
    // cookies() only works while a request is being answered. Outside one
    // there is no switcher to read, so the bypass is the admin it always was.
    return { kind: "ok", principal: bypassAdmin(org) };
  }
  // "Admin (everything)" clears the cookie rather than setting it, so one that
  // names admin was set by hand. It means the bypass's normal self, and it is
  // answered as that, with viewingAs null, so /api/me clears it like any
  // other cookie that did not take.
  if (!picked || picked === ADMIN_ROLE) return { kind: "ok", principal: bypassAdmin(org) };

  try {
    const access = await getRoleAccess(org.id, picked);
    // A role deleted since it was picked: the switcher shows Admin again too.
    if (!access) return { kind: "ok", principal: bypassAdmin(org) };
    return {
      kind: "ok",
      principal: {
        ...bypassAdmin(org),
        role: access.role,
        roleLabel: access.roleLabel,
        permissions: access.permissions,
        viewingAs: access.role,
      },
    };
  } catch (error) {
    console.error("Could not read the role picked in View as:", error);
    // Not the full admin: someone who picked a role to see what it cannot do
    // must not be quietly handed everything because the read failed.
    return { kind: "unavailable" };
  }
}

/**
 * Who is signed in, the membership they hold, and what its role may do.
 *
 * The session says who someone is and nothing more (see auth.ts). Everything
 * about what they may do is read here, on every request.
 */
async function signedInPrincipal(): Promise<Resolution> {
  let email: string | null | undefined;
  let name: string | null | undefined;
  try {
    const session = await auth();
    email = session?.user?.email;
    name = session?.user?.name;
  } catch (error) {
    // An auth backend that is down must read as "not signed in", not as a
    // 500 that leaks the reason.
    console.error("Session lookup failed:", error);
    return { kind: "signed-out" };
  }
  if (!email) return { kind: "signed-out" };

  try {
    const membership = await findMembership(email);
    if (!membership) return { kind: "not-member" };
    const access = await getRoleAccess(membership.orgId, membership.role);
    // The foreign key from a membership to its role will not let a role that
    // somebody holds be deleted, so for a member it is always there. Missing
    // means the rows were edited by hand, and until they are put right nobody
    // can say what this person may do. The log says which rows to look at.
    if (!access) {
      console.error(
        `A membership in organization ${membership.orgId} names the role ` +
          `${JSON.stringify(membership.role)}, which that organization does not have.`
      );
      return { kind: "unavailable" };
    }
    return {
      kind: "ok",
      principal: {
        email,
        name: name ?? email,
        role: access.role,
        roleLabel: access.roleLabel,
        permissions: access.permissions,
        bypass: false,
        viewingAs: null,
        orgId: membership.orgId,
        orgSlug: membership.slug,
        orgName: membership.name,
        orgIsDefault: membership.isDefault,
      },
    };
  } catch (error) {
    console.error("Could not read the caller's membership:", error);
    return { kind: "unavailable" };
  }
}

/** Who is calling, in which organization, and what they may do there. Never throws. */
function resolve(): Promise<Resolution> {
  return BYPASS_AUTH ? bypassPrincipal() : signedInPrincipal();
}

function refuse(status: number, error: string): Gate {
  return { ok: false, response: NextResponse.json({ error }, { status }) };
}

/** The answer for a caller who did not resolve to a principal. */
function refusalFor(found: Exclude<Resolution, { kind: "ok" }>): Gate {
  switch (found.kind) {
    case "signed-out":
      return refuse(401, SIGN_IN_FIRST);
    case "not-member":
      return refuse(404, NOT_A_MEMBER);
    case "unavailable":
      return refuse(503, ACCESS_UNAVAILABLE);
  }
}

/**
 * Require a member whose role holds at least ONE of these permissions.
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
  const found = await resolve();
  if (found.kind !== "ok") return refusalFor(found);
  const { principal } = found;
  if (!hasPermission(principal, ...keys)) {
    return refuse(403, refusalMessage(principal.roleLabel, keys[0]));
  }
  return { ok: true, principal };
}

/**
 * Require a member of the organization and nothing more, for the few routes
 * that are about the caller rather than a feature: what may I do here, which
 * role am I viewing the app as. Every member gets an answer, whatever their
 * role. The refusals are the same as requirePermission's, the 503 included:
 * these routes have nothing true to say about someone whose role could not be
 * read.
 */
export async function requireMember(): Promise<Gate> {
  const found = await resolve();
  if (found.kind !== "ok") return refusalFor(found);
  return { ok: true, principal: found.principal };
}
