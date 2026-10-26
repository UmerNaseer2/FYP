import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
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
   * True when the app could not say what the role may do: /api/me did not
   * answer, or answered that its database did not. A screen should say "try
   * again" then, not "your role can't".
   */
  accessError: boolean;
  /**
   * True when the person is signed in but is not a member of the organization
   * the app acts in, which is what /api/me answers 404 for. With real sign-in
   * that means an admin removed them after they signed in. With the bypass on
   * it means the database has no default organization to act in.
   */
  notMember: boolean;
};

// Stable identity so components that memoise on `user` (StudioShell does)
// don't recompute on every render while the bypass is on.
const BYPASS_USER: CurrentUser = {
  email: BYPASS_PRINCIPAL.email,
  name: BYPASS_PRINCIPAL.name,
};

// ---------------------------------------------------------------------------
// What the person may do, as the server sees it.
//
// The sign-in session only says who the person is. What they may do is their
// membership in the organization and what its role allows, and both can change
// while they are signed in: an admin can change their role, edit the role, or
// remove them. So the browser asks the server, through /api/me, which answers
// with the same principal lib/auth-guard.ts hands every API route. A screen
// then offers exactly what the server will allow, and never a button whose
// request the server refuses.
//
// With the bypass on there is no session, and the server acts as the full
// admin unless the View as switcher on the studio rail has left a cookie
// naming a role (bypassPrincipal in lib/auth-guard.ts). With no cookie there
// is nothing to ask: the answer is the full admin, straight away.
//
// Every component on the page shares the one answer, which is what this small
// store is for. Without it each screen would fetch the same thing, and for a
// moment they could disagree.
// ---------------------------------------------------------------------------

type AccessState = {
  loading: boolean;
  role: string;
  roleLabel: string;
  permissions: readonly PermissionKey[];
  viewingAs: string | null;
  accessError: boolean;
  notMember: boolean;
};

const VIEWER_LABEL = BUILT_IN_ROLE_INFO[DEFAULT_ROLE].label;

/** Not known yet: /api/me has not answered. */
const PENDING: AccessState = {
  loading: true,
  role: DEFAULT_ROLE,
  roleLabel: VIEWER_LABEL,
  permissions: [],
  viewingAs: null,
  accessError: false,
  notMember: false,
};

/** The bypass with no View as cookie: the full admin it always was. */
const NO_VIEW_AS: AccessState = {
  loading: false,
  role: ADMIN_ROLE,
  roleLabel: BUILT_IN_ROLE_INFO[ADMIN_ROLE].label,
  permissions: ALL_PERMISSIONS,
  viewingAs: null,
  accessError: false,
  notMember: false,
};

/** /api/me answered 404: signed in, but not a member. Nothing is allowed. */
const NOT_MEMBER: AccessState = {
  loading: false,
  role: DEFAULT_ROLE,
  roleLabel: VIEWER_LABEL,
  permissions: [],
  viewingAs: null,
  accessError: false,
  notMember: true,
};

/** Nobody is signed in, so there is nothing to ask and nothing allowed. */
const SIGNED_OUT: AccessState = {
  loading: false,
  role: DEFAULT_ROLE,
  roleLabel: VIEWER_LABEL,
  permissions: [],
  viewingAs: null,
  accessError: false,
  notMember: false,
};

let state: AccessState = PENDING;
let started = false;
// Bumped by every fresh start and by resetUserCache, so an answer to a
// question asked before one cannot overwrite the answer to a question asked
// after it.
let generation = 0;
// With the bypass on, the View as cookie the current answer is about. A
// different cookie on a later look (another tab picked a role) means the
// answer is about the wrong role, so the lookup starts again.
let question: string | null = null;
// A quiet refresh is in flight, so another focus does not start a second one.
let refreshing = false;
/** An answer already in hand for the first question. See seedUserAccess. */
let seed: AccessState | null = null;
// Whether the focus and visibility listeners are on. Once per page.
let watching = false;
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

/**
 * Ask the server what the person may do. Null when it gave no usable answer:
 * the request failed, the server answered with an error, or the body was not
 * an answer. 401 is one of those on purpose. The session said someone is
 * signed in, so a 401 means the two briefly disagree, and treating it as
 * "signed out" could send a signed-in person round in circles through /login.
 */
async function askMe(): Promise<AccessState | null> {
  try {
    const response = await fetch("/api/me", { cache: "no-store" });
    const body: unknown = response.ok ? await response.json().catch(() => null) : null;
    return readAnswer(response.status, body);
  } catch {
    return null;
  }
}

/** What an answer from /api/me says, or null when it does not say. */
function readAnswer(status: number, body: unknown): AccessState | null {
  if (status === 404) return NOT_MEMBER;
  if (status < 200 || status >= 300) return null;
  if (typeof body !== "object" || body === null) return null;
  const answer = body as {
    role?: unknown;
    roleLabel?: unknown;
    permissions?: unknown;
    viewingAs?: unknown;
  };
  if (typeof answer.role !== "string" || !answer.role) return null;
  const role = answer.role;
  return {
    loading: false,
    role,
    roleLabel:
      typeof answer.roleLabel === "string" && answer.roleLabel
        ? answer.roleLabel
        : isBuiltInRole(role)
          ? BUILT_IN_ROLE_INFO[role].label
          : role,
    // Filtered so a permission this build does not know can never match.
    permissions: Array.isArray(answer.permissions)
      ? answer.permissions.filter(isPermissionKey)
      : [],
    // Null when the role picked in View as was deleted after it was picked:
    // the server is the full admin again, and so is this.
    viewingAs: typeof answer.viewingAs === "string" ? answer.viewingAs : null,
    accessError: false,
    notMember: false,
  };
}

/**
 * What to show when the first question got no usable answer: no permissions,
 * and say why, the same as the server does when it cannot read the role.
 * With the bypass on and a role picked, the badge still names that role, so
 * the person can see what they were viewing the app as.
 */
function unanswered(picked: string | null): AccessState {
  if (!picked) return { ...SIGNED_OUT, accessError: true };
  // The cookie is whatever the browser holds. Role keys are 32 characters at
  // most (roles_name_check), so a longer value was not set by the switcher,
  // and it is cut to that length before it is shown anywhere.
  const role = picked.slice(0, 32);
  return { ...SIGNED_OUT, role, roleLabel: role, viewingAs: role, accessError: true };
}

async function lookUp(picked: string | null, mine: number) {
  const answer = await askMe();
  if (mine !== generation) return;
  state = answer ?? unanswered(picked);
  emit();
}

/**
 * Find out what the person may do. Once per page load, and again only after
 * resetUserCache, or when the View as cookie changed under the page.
 */
function start() {
  started = true;
  const mine = ++generation;
  watchForReturn();
  if (!BYPASS_AUTH) {
    question = null;
    if (seed) {
      state = seed;
      seed = null;
      emit();
      return;
    }
    void lookUp(null, mine);
    return;
  }
  const picked = readViewAsCookie();
  question = picked;
  if (!picked) {
    state = NO_VIEW_AS;
    emit();
    return;
  }
  void lookUp(picked, mine);
}

function sameAccess(a: AccessState, b: AccessState) {
  return (
    a.role === b.role &&
    a.roleLabel === b.roleLabel &&
    a.permissions.join(",") === b.permissions.join(",") &&
    a.viewingAs === b.viewingAs &&
    a.accessError === b.accessError &&
    a.notMember === b.notMember
  );
}

/**
 * Ask again, quietly, when the person comes back to the page. An admin may
 * have changed their role, or removed them, while the tab sat in the
 * background, and the screens should catch up without a reload.
 *
 * Quietly means nothing changes on screen until the answer is in, and a
 * failed answer changes nothing at all: the guard would otherwise swap a page
 * with unsaved work on it for "Could not check your access" over one dropped
 * request. Not before the first answer, which is already on its way.
 */
function refresh() {
  if (!started || refreshing || state.loading) return;
  if (BYPASS_AUTH) {
    const picked = readViewAsCookie();
    if (picked !== question) {
      // The answer on screen is about a different role. Showing it until the
      // new one arrives would show the wrong role's screens, so start over.
      state = PENDING;
      start();
      emit();
      return;
    }
    // No cookie is the full admin, and there is nothing to ask about that.
    if (!picked) return;
  }
  refreshing = true;
  const mine = generation;
  void askMe().then((answer) => {
    // A reset since has cleared `refreshing` and asked afresh itself.
    if (mine !== generation) return;
    refreshing = false;
    if (answer === null || sameAccess(answer, state)) return;
    state = answer;
    emit();
  });
}

/**
 * "Comes back" is the window getting focus again, or the tab becoming visible
 * again. Both, because each misses a case: switching tabs does not always
 * focus the window, and switching apps does not change the tab's visibility.
 */
function watchForReturn() {
  if (watching || typeof window === "undefined") return;
  watching = true;
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // With the bypass on there is no session to wait for, so the first
  // component that wants the answer starts the lookup, and a page that never
  // asks never fetches. With real sign-in the lookup waits for the session to
  // say someone is signed in (the effect in useUser), because asking for
  // nobody would only get a 401.
  if (BYPASS_AUTH && !started) start();
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
 * Hand over an answer /api/me already gave, to be used instead of asking the
 * first time someone signed in needs one. Only the first time: once the page
 * has asked, a role that changed since is learned by asking again (on focus,
 * or after resetUserCache), so an answer handed over after that is ignored.
 * With the bypass on it is never used either, because the role picked in View
 * as is a different question.
 *
 * For the page tests (tests/helpers/render-page.tsx), so the screen under test
 * knows its role as soon as it is drawn, which is how a page will start once
 * the server hands the answer down with the page itself.
 */
export function seedUserAccess(status: number, body: unknown) {
  if (started) return;
  seed = readAnswer(status, body) ?? unanswered(null);
}

/**
 * Forget what the browser knew about what the person may do. For the tests,
 * which call it between cases: the answer is otherwise kept for the life of
 * the page, and in a test file that is every case in it.
 *
 * Signing out does not need it. Every way of signing out loads a new page (the
 * login screen), and that starts from nothing anyway.
 */
export function resetUserCache() {
  const wasStarted = started;
  state = PENDING;
  started = false;
  question = null;
  refreshing = false;
  seed = null;
  generation++;
  // Components already on the page will not subscribe again, so they would
  // wait on PENDING forever. Ask again for them: always with the bypass on,
  // and with real sign-in only if the lookup had started, which means the
  // session had already said someone is signed in.
  if (listeners.size > 0 && (BYPASS_AUTH || wasStarted)) start();
  emit();
}

/**
 * Who the browser thinks it is, and what that person may do.
 *
 * Who comes from the sign-in session, or from the bypass's stand-in. What they
 * may do comes from /api/me in both cases, which is the same principal
 * lib/auth-guard.ts hands the API routes: their role in the organization, or
 * with the bypass on the full admin or the role picked in View as. Without
 * that, a screen could offer a button whose request the server then refuses,
 * the client and the server disagreeing about the one thing meant to control
 * both.
 *
 * Screens ask `can(...)` rather than comparing role names, so a role an admin
 * made yesterday works on every screen without any screen knowing it exists.
 * The screens only hide what the person cannot use. The routes enforce it.
 */
export function useUser(): UserAccess {
  const { data: session, status } = useSession();
  const cookieSeen = useContext(ViewAsCookieSeen);
  const access = useSyncExternalStore(subscribe, getSnapshot, () =>
    // The server's own reading of the View as cookie, so with the bypass on
    // the first frame already matches: no cookie means the full admin
    // straight away, and a cookie means "Checking your access…" until /api/me
    // answers, never a page drawn as an admin's and then taken away. With
    // real sign-in the first frame cannot know yet.
    BYPASS_AUTH && cookieSeen === false ? NO_VIEW_AS : PENDING
  );

  useEffect(() => {
    if (!BYPASS_AUTH && status === "authenticated" && !started) start();
  }, [status]);

  // With real sign-in the store only speaks for someone the session says is
  // signed in. While the session is still loading nothing is known yet, and
  // once it says nobody is signed in there is nothing to know.
  let shown: AccessState;
  if (BYPASS_AUTH || session?.user) shown = access;
  else if (status === "loading") shown = PENDING;
  else shown = SIGNED_OUT;

  // Keyed on the list as one string, so `can` keeps its identity while the
  // permissions stay the same and a component that memoises on it does not
  // redo its work on every render.
  const held = shown.permissions.join(",");
  const can = useMemo<Can>(() => {
    const list = held ? held.split(",") : [];
    return (...keys) => hasPermission({ permissions: list }, ...keys);
  }, [held]);

  const user: CurrentUser | null = BYPASS_AUTH
    ? BYPASS_USER
    : session?.user
      ? {
          email: session.user.email ?? "",
          name: session.user.name ?? session.user.email ?? "",
        }
      : null;

  return {
    user,
    role: shown.role,
    roleLabel: shown.roleLabel,
    isAdmin: shown.role === ADMIN_ROLE,
    loading: shown.loading,
    bypass: BYPASS_AUTH,
    viewingAs: shown.viewingAs,
    can,
    accessError: shown.accessError,
    notMember: shown.notMember,
  };
}
