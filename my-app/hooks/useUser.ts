import { createContext, useContext, useMemo, useSyncExternalStore } from "react";
import { useSession } from "next-auth/react";
import { BYPASS_AUTH, BYPASS_PRINCIPAL, VIEW_AS_COOKIE } from "@/lib/auth-mode";
import {
  ADMIN_ROLE,
  ALL_PERMISSIONS,
  BUILT_IN_ROLE_INFO,
  DEFAULT_ROLE,
  hasPermission,
  isBuiltInRole,
  isPermissionKey,
  type PermissionKey,
} from "@/lib/permissions";

export type CurrentUser = {
  email: string;
  name: string;
};

/**
 * Ask whether the person may do something: `can("connections:create")`.
 * Several keys mean any of them will do, the same as requirePermission on the
 * server, so a screen and the route behind it can ask the same question.
 */
export type Can = (...keys: [PermissionKey, ...PermissionKey[]]) => boolean;

export type UserAccess = {
  user: CurrentUser | null;
  /** The role's key: "viewer", "editor", "admin", or a custom role's. */
  role: string;
  /** The role's name as people read it: "Editor", "QA Lead". */
  roleLabel: string;
  isAdmin: boolean;
  /** True until it is known what the person may do. Show nothing yet. */
  loading: boolean;
  bypass: boolean;
  /** The role "View as" is showing the app as. Null otherwise. */
  viewingAs: string | null;
  can: Can;
  /**
   * True when the app's database could not say what the role may do. The API
   * answers 503 then, so a screen should say "try again", not "your role
   * can't".
   */
  accessError: boolean;
};

// Stable identity so components that memoise on `user` (StudioShell does)
// don't recompute on every render while the bypass is on.
const BYPASS_USER: CurrentUser = {
  email: BYPASS_PRINCIPAL.email,
  name: BYPASS_PRINCIPAL.name,
};

// ---------------------------------------------------------------------------
// "View as", while the bypass is on.
//
// With the bypass on there is no session to say who the person is. The server
// acts as an admin, unless the View as switcher on the studio rail has left a
// cookie naming a role (bypassPrincipal in lib/auth-guard.ts). The browser has
// to show the same app the server is enforcing, so when that cookie is there
// it asks /api/me what the role may do. Every component on the page shares the
// one answer, which is what this small store is for: without it each screen
// would fetch the same thing, and for a moment they could disagree.
// ---------------------------------------------------------------------------

type ViewAsState = {
  loading: boolean;
  role: string;
  roleLabel: string;
  permissions: readonly PermissionKey[];
  viewingAs: string | null;
  accessError: boolean;
};

/** Not known yet: there is a View as cookie and /api/me has not answered. */
const PENDING: ViewAsState = {
  loading: true,
  role: DEFAULT_ROLE,
  roleLabel: BUILT_IN_ROLE_INFO[DEFAULT_ROLE].label,
  permissions: [],
  viewingAs: null,
  accessError: false,
};

/** No View as cookie: the bypass is the full admin it always was. */
const NO_VIEW_AS: ViewAsState = {
  loading: false,
  role: ADMIN_ROLE,
  roleLabel: BUILT_IN_ROLE_INFO[ADMIN_ROLE].label,
  permissions: ALL_PERMISSIONS,
  viewingAs: null,
  accessError: false,
};

let state: ViewAsState = PENDING;
let started = false;
// Bumped by resetUserCache, so an answer to a question asked before a reset
// cannot overwrite the answer to one asked after it.
let generation = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/**
 * The View as cookie's value, read the way the server reads it: Next splits the
 * header on ";" and skips a value it cannot decode. Reading it the same way
 * means the browser and the server agree on whether there is one. Empty counts
 * as none, as it does in bypassPrincipal.
 */
function readViewAsCookie(): string | null {
  if (typeof document === "undefined") return null;
  let found: string | null = null;
  for (const pair of document.cookie.split(";")) {
    const trimmed = pair.trim();
    const at = trimmed.indexOf("=");
    if (at === -1 || trimmed.slice(0, at) !== VIEW_AS_COOKIE) continue;
    try {
      found = decodeURIComponent(trimmed.slice(at + 1));
    } catch {
      // A value that cannot be decoded is skipped, as if it were not there.
    }
  }
  return found || null;
}

/** Ask the server what the role named in the cookie may do. */
async function lookUpViewAs(picked: string, mine: number) {
  // What the server does when it cannot read the role either (see
  // bypassPrincipal): no permissions, and say why, rather than everything.
  // The cookie is whatever the browser holds, so it is cut to a role key's
  // length before it is shown anywhere.
  const role = picked.slice(0, 32);
  let next: ViewAsState = {
    loading: false,
    role,
    roleLabel: role,
    permissions: [],
    viewingAs: role,
    accessError: true,
  };
  try {
    const response = await fetch("/api/me", { cache: "no-store" });
    const body = await response.json().catch(() => null);
    if (response.ok && body && !body.accessUnavailable) {
      const answered = typeof body.role === "string" && body.role ? body.role : role;
      next = {
        loading: false,
        role: answered,
        roleLabel:
          typeof body.roleLabel === "string" && body.roleLabel ? body.roleLabel : answered,
        // Filtered so a permission this build does not know can never match.
        permissions: Array.isArray(body.permissions)
          ? body.permissions.filter(isPermissionKey)
          : [],
        // Null when the role was deleted after it was picked: the server is
        // the full admin again, and so is this.
        viewingAs: typeof body.viewingAs === "string" ? body.viewingAs : null,
        accessError: false,
      };
    }
  } catch {
    // The request itself failed. `next` already says so.
  }
  if (mine !== generation) return;
  state = next;
  emit();
}

/** Work out who the bypass is acting as. Once per page load. */
function startViewAsLookup() {
  started = true;
  const mine = ++generation;
  const picked = readViewAsCookie();
  if (!picked) {
    state = NO_VIEW_AS;
    emit();
    return;
  }
  void lookUpViewAs(picked, mine);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Started by the first component that wants the answer, so a page that never
  // asks never fetches. Only with the bypass on: with real sign-in the session
  // already says what the role may do.
  if (BYPASS_AUTH && !started) startViewAsLookup();
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return state;
}

/**
 * Whether the request that drew this page carried a View as cookie, as the
 * server read it. Provided by components/ViewAsCookie.tsx in the studio layout.
 * Undefined anywhere it is not provided, which is treated as "not known yet".
 */
export const ViewAsCookieSeen = createContext<boolean | undefined>(undefined);

/**
 * Forget what the browser knew about who it is. The sign-out handler calls it,
 * and so do the tests between cases, because the View as answer is otherwise
 * kept for the life of the page.
 */
export function resetUserCache() {
  state = PENDING;
  started = false;
  generation++;
  // Components already on the page will not subscribe again, so they would
  // wait on PENDING forever. Ask again for them.
  if (BYPASS_AUTH && listeners.size > 0) startViewAsLookup();
  emit();
}

/**
 * Who the browser thinks it is, and what that person may do.
 *
 * With real sign-in this is the session: auth.ts reads the role, its name and
 * its permissions from the database on every request and puts them there.
 * With the bypass on it is the same principal lib/auth-guard hands the API
 * routes: the full admin, or the role picked in View as. Without that, a
 * screen could offer a button whose request the server then refuses, the
 * client and the server disagreeing about the one switch meant to control both.
 *
 * Screens ask `can(...)` rather than comparing role names, so a role an admin
 * made yesterday works on every screen without any screen knowing it exists.
 * The screens only hide what the person cannot use. The routes enforce it.
 */
export function useUser(): UserAccess {
  const { data: session, status } = useSession();
  const cookieSeen = useContext(ViewAsCookieSeen);
  const viewAs = useSyncExternalStore(subscribe, getSnapshot, () =>
    // The server's own reading of the cookie, so the first frame already
    // matches: no cookie means the full admin straight away, and a cookie
    // means "Checking your access…" until /api/me answers, never a page drawn
    // as an admin's and then taken away.
    cookieSeen === false ? NO_VIEW_AS : PENDING
  );

  const permissions: readonly string[] = BYPASS_AUTH
    ? viewAs.permissions
    : (session?.user?.permissions ?? []).filter(isPermissionKey);
  // Keyed on the list as one string, so `can` keeps its identity while the
  // permissions stay the same and a component that memoises on it does not
  // redo its work on every render.
  const held = permissions.join(",");
  const can = useMemo<Can>(() => {
    const list = held ? held.split(",") : [];
    return (...keys) => hasPermission({ permissions: list }, ...keys);
  }, [held]);

  if (BYPASS_AUTH) {
    return {
      user: BYPASS_USER,
      role: viewAs.role,
      roleLabel: viewAs.roleLabel,
      isAdmin: viewAs.role === ADMIN_ROLE,
      loading: viewAs.loading,
      bypass: true,
      viewingAs: viewAs.viewingAs,
      can,
      accessError: viewAs.accessError,
    };
  }

  const user: CurrentUser | null = session?.user
    ? {
        email: session.user.email ?? "",
        name: session.user.name ?? session.user.email ?? "",
      }
    : null;
  const role = session?.user?.role || DEFAULT_ROLE;

  return {
    user,
    role,
    roleLabel:
      session?.user?.roleLabel ||
      (isBuiltInRole(role) ? BUILT_IN_ROLE_INFO[role].label : role),
    isAdmin: role === ADMIN_ROLE,
    loading: status === "loading",
    bypass: false,
    viewingAs: null,
    can,
    accessError: session?.user?.accessError === true,
  };
}
