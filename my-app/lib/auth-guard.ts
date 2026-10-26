import { NextResponse } from "next/server";
import { cookies, headers } from "next/headers";
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
import { ORG_HEADER } from "./org-slug";
import {
  findDefaultMembership,
  findDefaultOrganization,
  findMembership,
  findOrganization,
  type Member,
  type Organization,
} from "./orgs-db";
import { getRoleAccess } from "./roles-db";
import { sessionProfileId } from "./session-profile";

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
 * found. The request names it: a screen's API calls carry the slug of the
 * organization the page is open in, in ORG_HEADER (lib/api-fetch.ts). With
 * real sign-in the caller has to hold a membership there, and their role is
 * the one that membership names. Both are read on every request, the same as
 * the role's permissions, so an admin who removes someone or changes their
 * role does not have to wait for that person's sign-in to run out: it holds
 * from their next click. Every query a route makes is then filtered by the
 * principal's orgId.
 *
 * A request that names no organization is answered on the desktop only, in
 * its default organization. The desktop has just the one, and its own calls
 * from outside any page (the phone link, the drift watcher) have no page to
 * take a slug from. Anywhere else it is a 404, the same as naming an
 * organization the caller is not in: a request that forgets to say where it
 * acts must not quietly act somewhere.
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
 * the bypass on, the caller is a full admin of the organization the request
 * names, unless "View as" on the studio rail has picked a role to try the app
 * as (see bypassPrincipal below).
 *
 * The pages use the same lookup. app/[org]/layout.tsx asks resolveOrganization
 * about the slug in the address before it shows anything, so a page and its
 * API calls always agree about who may see what.
 */

export type Principal = {
  /**
   * The person's profile ID, which everything about them is keyed by. Null
   * for the bypass, which is nobody in particular.
   */
  profileId: number | null;
  /**
   * The address the app knows them by: their profile's, whichever way they
   * signed in this time (see lib/accounts-db.ts).
   */
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
  /**
   * The organization's two-person rule (Organization.twoPersonRule in
   * lib/orgs-db.ts). Read with the rest of the principal on every request, so
   * the approval routes act on the rule as it is now, not as it was at sign-in.
   */
  orgTwoPersonRule: boolean;
};

export type Gate =
  | { ok: true; principal: Principal }
  | { ok: false; response: NextResponse };

/**
 * What looking up the caller found. The three that are not a principal are
 * kept apart, rather than all being "nobody", because each needs a different
 * answer: sign in, you do not belong here, or try again in a moment.
 *
 * "not-member" carries the profile ID of the person who is signed in, or null
 * for the bypass, which has no membership anywhere. The gates never use it.
 * The organization's layout does, to tell someone who belongs to no
 * organization at all (who is sent to make one) from someone who typed the
 * address of one they are not in (who gets "not found").
 */
export type Resolution =
  | { kind: "ok"; principal: Principal }
  | { kind: "signed-out" }
  | { kind: "not-member"; profileId: number | null }
  | { kind: "unavailable" };

/** The desktop app starts this server with SCHEMA_STUDIO_DESKTOP=1 (see auth.config.ts). */
function onDesktop(): boolean {
  return process.env.SCHEMA_STUDIO_DESKTOP === "1";
}

/**
 * The organization the request names in ORG_HEADER, or null when it names
 * none. Whether the slug is well formed is left to the lookups, which answer
 * a slug no organization could have the same way as one nobody has.
 */
async function requestedSlug(): Promise<string | null> {
  try {
    return (await headers()).get(ORG_HEADER)?.trim() || null;
  } catch {
    // headers() only works while a request is being answered. Outside one
    // there is no request to name an organization.
    return null;
  }
}

const SIGN_IN_FIRST = "Sign in to continue.";
const NOT_A_MEMBER = "This organization does not exist, or you are not a member.";
const ACCESS_UNAVAILABLE =
  "Could not check what your role can do, because the app's database did not answer. " +
  "Try again in a moment.";

/** The bypass's normal self: everything, as the Admin of `org`. */
function bypassAdmin(org: Organization): Principal {
  return {
    ...BYPASS_PRINCIPAL,
    profileId: null,
    roleLabel: BUILT_IN_ROLE_INFO.admin.label,
    permissions: ALL_PERMISSIONS,
    bypass: true,
    viewingAs: null,
    orgId: org.id,
    orgSlug: org.slug,
    orgName: org.name,
    orgIsDefault: org.isDefault,
    orgTwoPersonRule: org.twoPersonRule,
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
 * The bypass acts in whichever organization the request names. With nobody
 * signed in there is no membership to read, so it is an admin of every
 * organization there is, which is what "no sign-in" has always meant here. A
 * slug no organization has is "not a member", the same answer real sign-in
 * gives for it.
 */
async function bypassPrincipal(slug: string | null): Promise<Resolution> {
  let org: Organization | null;
  try {
    if (slug !== null) org = await findOrganization(slug);
    else if (onDesktop()) org = await findDefaultOrganization();
    else return { kind: "not-member", profileId: null };
  } catch (error) {
    console.error("Could not read the organization:", error);
    return { kind: "unavailable" };
  }
  // No organization by that name, or (asking for the default) somebody has
  // deleted its row by hand. Either way there is nothing to act in.
  if (!org) return { kind: "not-member", profileId: null };

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
 * The profile ID the sign-in session carries, or null when nobody is signed
 * in. Never throws.
 */
async function signedInProfileId(): Promise<number | null> {
  try {
    return sessionProfileId(await auth());
  } catch (error) {
    // An auth backend that is down must read as "not signed in", not as a
    // 500 that leaks the reason.
    console.error("Session lookup failed:", error);
    return null;
  }
}

/**
 * Who is signed in, the membership they hold in the organization `slug`
 * names, and what its role may do there.
 *
 * The session says who someone is, by their profile ID, and nothing more (see
 * auth.ts). Everything about them is read here, on every request: their
 * membership, their role's permissions, and the address and name the app
 * knows them by.
 */
async function signedInPrincipal(slug: string | null): Promise<Resolution> {
  const profileId = await signedInProfileId();
  if (profileId === null) return { kind: "signed-out" };

  if (slug === null && !onDesktop()) return { kind: "not-member", profileId };

  try {
    const membership: Member | null =
      slug === null
        ? await findDefaultMembership(profileId)
        : await findMembership(profileId, slug);
    if (!membership) return { kind: "not-member", profileId };
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
        profileId,
        email: membership.email,
        name: membership.personName ?? membership.email,
        role: access.role,
        roleLabel: access.roleLabel,
        permissions: access.permissions,
        bypass: false,
        viewingAs: null,
        orgId: membership.orgId,
        orgSlug: membership.slug,
        orgName: membership.name,
        orgIsDefault: membership.isDefault,
        orgTwoPersonRule: membership.twoPersonRule,
      },
    };
  } catch (error) {
    console.error("Could not read the caller's membership:", error);
    return { kind: "unavailable" };
  }
}

/** Who is calling, in the organization `slug` names, and what they may do there. Never throws. */
function resolveIn(slug: string | null): Promise<Resolution> {
  return BYPASS_AUTH ? bypassPrincipal(slug) : signedInPrincipal(slug);
}

/** Who is calling, in the organization the request names, and what they may do there. Never throws. */
async function resolve(): Promise<Resolution> {
  return resolveIn(await requestedSlug());
}

/**
 * The same lookup the gates make, for a page: who is looking, in the
 * organization `slug` names, and what they may do there. Never throws.
 *
 * The page's address names the organization, so the slug comes from there
 * rather than from ORG_HEADER, which only the screens' API calls carry.
 */
export function resolveOrganization(slug: string): Promise<Resolution> {
  return resolveIn(slug);
}

function refuse(status: number, error: string): { ok: false; response: NextResponse } {
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

/**
 * Someone the app knows, before any organization comes into it. See
 * requireSignedIn.
 */
/**
 * Who passed requireSignedIn: a signed-in person and their profile ID, or the
 * bypass, which is nobody in particular and so has no profile. Checking
 * `bypass` is enough to know which.
 */
export type Caller = { bypass: false; profileId: number } | { bypass: true; profileId: null };

export type SignedInGate =
  | { ok: true; caller: Caller }
  | { ok: false; response: NextResponse };

/**
 * Require someone signed in, and ask nothing about any organization.
 *
 * Only for the routes about a person's organizations as a whole: which ones
 * they belong to, and making a new one. Both have to answer people who belong
 * to none yet, because that is who signs up, so a membership cannot come
 * first. Everything else is done inside an organization and opens with
 * requirePermission or requireMember. tests/permissions-coverage.test.ts holds
 * the list of routes allowed to use this one.
 *
 * The caller says nothing about what they may do, because outside an
 * organization there is nothing to grant. A route that goes on to act in one
 * must check the membership for itself.
 *
 * With the bypass on there is nobody to identify, so the caller is the
 * bypass, with no profile. It answers on the desktop too, where the one
 * person is signed in by the desktop app.
 */
export async function requireSignedIn(): Promise<SignedInGate> {
  if (BYPASS_AUTH) return { ok: true, caller: { profileId: null, bypass: true } };
  const profileId = await signedInProfileId();
  if (profileId === null) return refuse(401, SIGN_IN_FIRST);
  return { ok: true, caller: { profileId, bypass: false } };
}
