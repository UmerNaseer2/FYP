/** @jest-environment jsdom */

/**
 * Who the browser thinks it is, and what it may do.
 *
 * Every screen that hides a button, disables a form or says "your role can't"
 * reads its answer from here, so a wrong answer is wrong in a dozen places at
 * once and in the direction that matters: too generous.
 *
 * The bypass branch is the one worth the trouble of forcing. lib/auth-mode is
 * the single switch that decides whether authentication is enforced, and
 * lib/auth-guard hands the API routes a full admin principal while it is on,
 * or the role picked in "View as". If this hook did not agree, the UI would
 * offer a button whose request the server then refuses, or refuse one it would
 * let through: the client and the server disagreeing about the one switch that
 * is supposed to control both, which is worse than either answer on its own.
 *
 * BYPASS_AUTH is read once when lib/auth-mode loads, so it cannot be changed
 * from inside a test. The module is replaced here with the real one plus a
 * switch that can be moved, which is the only way to reach both branches in
 * one file. That does mean the switch's own parsing is not exercised here.
 *
 * What is NOT here:
 *  - Which spellings of the environment variable turn the bypass on, and that
 *    an unset one leaves authentication enforced:
 *    tests/auth-role-and-bypass.test.ts, against the real module.
 *  - Reading the role and its permissions out of the database. That happens in
 *    the session callback in auth.ts, and in /api/me for "View as", before the
 *    answer ever reaches this hook. What is pinned below is what the hook does
 *    with the answer, including one that somehow was not cleaned up first.
 *  - The screens that act on the answer: tests/component-auth-guard.test.tsx,
 *    tests/component-studio-shell.test.tsx, and the per-screen suites that
 *    check a disabled control.
 */

import { useEffect } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, render, waitFor } from "@testing-library/react";

import { useUser, resetUserCache, ViewAsCookieSeen, type UserAccess } from "@/hooks/useUser";
import { BYPASS_PRINCIPAL, VIEW_AS_COOKIE } from "@/lib/auth-mode";
import { ALL_PERMISSIONS, presetFor, type PermissionKey } from "@/lib/permissions";

type MockSession = {
  user: {
    name?: string | null;
    email?: string | null;
    role?: string;
    roleLabel?: string;
    permissions?: string[];
    accessError?: boolean;
  };
} | null;

let mockSession: MockSession = null;
let mockStatus = "unauthenticated";
let mockBypass = false;

jest.mock("next-auth/react", () => ({
  useSession: () => ({ data: mockSession, status: mockStatus }),
}));

jest.mock("../lib/auth-mode", () => ({
  ...jest.requireActual("../lib/auth-mode"),
  // A getter, not a value: the hook reads BYPASS_AUTH when it runs, so this is
  // what lets one file see both sides of a switch that is otherwise decided
  // once, at module load, from the environment.
  get BYPASS_AUTH() {
    return mockBypass;
  },
}));

/**
 * Render the hook and hand back exactly what it returned: the object itself,
 * not a copy, because one of the tests below is about its identity surviving a
 * re-render. Published from an effect rather than assigned during render:
 * writing to something outside the component while rendering is the impurity
 * the React lint rules exist to catch, and render() flushes effects anyway.
 */
let seen: UserAccess | null = null;
function Probe() {
  const value = useUser();
  useEffect(() => {
    seen = value;
  });
  return null;
}
function read() {
  render(<Probe />);
  return seen as UserAccess;
}

/** The answer without `can`, which is a function and so never equal to another. */
function withoutCan(access: UserAccess) {
  const rest: Partial<UserAccess> = { ...access };
  delete rest.can;
  return rest;
}

/** A signed-in session, as the session callback in auth.ts leaves it. */
function signIn(user: NonNullable<MockSession>["user"]) {
  mockSession = { user };
  mockStatus = "authenticated";
}

const VIEW_AS_GONE = `${VIEW_AS_COOKIE}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;

/** What /api/me says while "View as" is set to Viewer. */
const VIEWER_ANSWER = {
  role: "viewer",
  roleLabel: "Viewer",
  permissions: presetFor("viewer"),
  bypass: true,
  viewingAs: "viewer",
  accessUnavailable: false,
};

/** Answer every request with `body`, the way fetch would. */
function answerMe(body: unknown, status = 200) {
  const fetchMock = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/** Wait for the View as lookup to be answered, and hand back what the hook says then. */
async function settled() {
  await waitFor(() => expect(seen?.loading).toBe(false));
  return seen as UserAccess;
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  mockSession = null;
  mockStatus = "unauthenticated";
  mockBypass = false;
  seen = null;
  document.cookie = VIEW_AS_GONE;
  resetUserCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("with authentication enforced", () => {
  test("says plainly that nobody is signed in", () => {
    const result = read();
    expect(withoutCan(result)).toEqual({
      user: null,
      role: "viewer",
      roleLabel: "Viewer",
      isAdmin: false,
      loading: false,
      bypass: false,
      viewingAs: null,
      accessError: false,
    });
    expect(result.can("dashboard:read")).toBe(false);
  });

  test("gives the least role to someone with no role on their session", () => {
    signIn({ name: "Ada", email: "ada@example.com" });
    const result = read();
    expect(result.role).toBe("viewer");
    expect(result.roleLabel).toBe("Viewer");
    expect(result.isAdmin).toBe(false);
    // And nothing the session did not list. Being called a viewer is not the
    // same as holding a viewer's boxes.
    expect(ALL_PERMISSIONS.some((key) => result.can(key))).toBe(false);
  });

  test("takes the name and the address from the session", () => {
    signIn({ name: "Ada Lovelace", email: "ada@example.com", role: "editor" });
    expect(read().user).toEqual({ name: "Ada Lovelace", email: "ada@example.com" });
  });

  test("falls back to the address when the session carries no name", () => {
    signIn({ email: "ada@example.com", role: "editor" });
    expect(read().user).toEqual({ name: "ada@example.com", email: "ada@example.com" });
  });

  test("hands back empty strings, not undefined, when the session carries neither", () => {
    // StudioShell picks its display name with `name || email || "Signed in"`,
    // which needs both fields to exist before it can fall through them.
    signIn({ role: "viewer" });
    expect(read().user).toEqual({ name: "", email: "" });
  });

  test("still reports a user object for a session that thin", () => {
    // Not null: null means signed out, and this person is signed in.
    signIn({ role: "viewer" });
    expect(read().user).not.toBeNull();
  });

  test("honours a role the session does carry, and what it may do", () => {
    signIn({
      email: "e@example.com",
      role: "editor",
      roleLabel: "Editor",
      permissions: [...(presetFor("editor") ?? [])],
    });
    const result = read();
    expect(result.role).toBe("editor");
    expect(result.isAdmin).toBe(false);
    expect(result.can("deploy:run")).toBe(true);
    expect(result.can("approvals:approve")).toBe(false);
  });

  test("calls an admin an admin", () => {
    signIn({ email: "a@example.com", role: "admin", roleLabel: "Admin", permissions: [...ALL_PERMISSIONS] });
    const result = read();
    expect(result.role).toBe("admin");
    expect(result.isAdmin).toBe(true);
  });

  test("does not grant anything on a role it does not recognise", () => {
    // It passes the key through rather than narrowing it, and the role holds
    // what the session lists, which here is nothing. A name alone opens nothing,
    // whatever it is.
    signIn({ email: "x@example.com", role: "superuser" });
    const result = read();
    expect(result.isAdmin).toBe(false);
    expect(result.roleLabel).toBe("superuser");
    expect(ALL_PERMISSIONS.some((key) => result.can(key))).toBe(false);
  });

  test("calls a role by the name the session gives it", () => {
    // A role an admin made has no built-in name, so the session's is the only one.
    signIn({ email: "q@example.com", role: "qa-lead", roleLabel: "QA Lead", permissions: [] });
    expect(read().roleLabel).toBe("QA Lead");
  });

  test("falls back to a built-in role's own name when the session gives none", () => {
    signIn({ email: "e@example.com", role: "editor", permissions: [] });
    expect(read().roleLabel).toBe("Editor");
  });

  test("answers yes only for a box the session lists", () => {
    signIn({ email: "q@example.com", role: "qa-lead", permissions: ["connections:read"] });
    const result = read();
    expect(result.can("connections:read")).toBe(true);
    expect(result.can("connections:create")).toBe(false);
  });

  test("never matches a permission this build does not know", () => {
    // A key from a newer build, or one somebody typed into the database by
    // hand. It is dropped on the way in, so no check can ever be answered by it.
    signIn({ email: "q@example.com", role: "qa-lead", permissions: ["made-up:thing"] });
    expect(read().can("made-up:thing" as PermissionKey)).toBe(false);
  });

  test("takes several boxes as any one of them, like the server does", () => {
    signIn({ email: "q@example.com", role: "qa-lead", permissions: ["dashboard:read"] });
    const result = read();
    expect(result.can("connections:create", "dashboard:read")).toBe(true);
    expect(result.can("connections:create", "deploy:run")).toBe(false);
  });

  test("keeps `can` the same function while the permissions stay the same", () => {
    // Screens put it in effect and memo dependencies. A new one on every
    // render would redo that work every time anything on the page changed.
    signIn({ email: "q@example.com", role: "qa-lead", permissions: ["dashboard:read"] });
    const { rerender } = render(<Probe />);
    const first = (seen as UserAccess).can;
    rerender(<Probe />);
    expect((seen as UserAccess).can).toBe(first);

    // And a new one when they do change, answering the new way.
    signIn({ email: "q@example.com", role: "qa-lead", permissions: ["deploy:run"] });
    rerender(<Probe />);
    expect((seen as UserAccess).can).not.toBe(first);
    expect((seen as UserAccess).can("deploy:run")).toBe(true);
  });

  test("says so when the database could not answer what the role may do", () => {
    // The routes answer 503 then, so a screen should say "try again" rather
    // than "your role can't".
    signIn({ email: "v@example.com", role: "viewer", permissions: [], accessError: true });
    expect(read().accessError).toBe(true);
  });

  test("reports loading while the session is still being fetched", () => {
    // Screens wait on this before deciding to show "you do not have access":
    // an unfetched session looks exactly like a viewer otherwise.
    mockStatus = "loading";
    const result = read();
    expect(result.loading).toBe(true);
    expect(result.user).toBeNull();
  });

  test("stops reporting loading once the answer is in", () => {
    signIn({ email: "a@example.com", role: "admin" });
    expect(read().loading).toBe(false);
  });
});

describe('with the bypass on and nothing picked in "View as"', () => {
  beforeEach(() => {
    mockBypass = true;
  });

  test("acts as the labelled testing principal, a full admin", () => {
    const result = read();
    expect(withoutCan(result)).toEqual({
      user: { email: BYPASS_PRINCIPAL.email, name: BYPASS_PRINCIPAL.name },
      role: "admin",
      roleLabel: "Admin",
      isAdmin: true,
      loading: false,
      bypass: true,
      viewingAs: null,
      accessError: false,
    });
    expect(ALL_PERMISSIONS.every((key) => result.can(key))).toBe(true);
  });

  test("names that principal as the bypass rather than as a person", () => {
    // It goes on screen in the rail's identity block, so it has to read as
    // "authentication is off here", not as somebody's account.
    const result = read();
    expect(result.user?.name).toBe("Auth bypass (testing)");
    expect(result.user?.email).toBe("bypass@local");
  });

  test("hands back the same identity object every time", () => {
    // StudioShell memoises on this object. A fresh one per render would make
    // that memo miss on every single render for as long as the bypass is on.
    const first = read().user;
    const second = read().user;
    expect(first).toBe(second);
  });

  test("outranks whatever a real session happens to say", () => {
    // The API routes are already being let through as an admin. A UI that
    // refused the same person would be the two halves disagreeing.
    signIn({ email: "viewer@example.com", role: "viewer", permissions: [] });
    const result = read();
    expect(result.isAdmin).toBe(true);
    expect(result.role).toBe("admin");
  });

  test("never waits, and asks nobody, because there is nothing to fetch", () => {
    const fetchMock = answerMe(VIEWER_ANSWER);
    mockStatus = "loading";
    expect(read().loading).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('with the bypass on and a role picked in "View as"', () => {
  beforeEach(() => {
    mockBypass = true;
    document.cookie = `${VIEW_AS_COOKIE}=viewer; path=/`;
  });

  test("waits for /api/me, then is the role it names", async () => {
    const fetchMock = answerMe(VIEWER_ANSWER);
    expect(read().loading).toBe(true);

    const result = await settled();
    expect(result.role).toBe("viewer");
    expect(result.roleLabel).toBe("Viewer");
    expect(result.viewingAs).toBe("viewer");
    expect(result.isAdmin).toBe(false);
    expect(result.accessError).toBe(false);
    expect(result.can("connections:read")).toBe(true);
    expect(result.can("deploy:run")).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Never a stored answer: the role may have been changed since it was given.
    expect(fetchMock.mock.calls[0]).toEqual(["/api/me", { cache: "no-store" }]);
  });

  test("asks once for the whole page, however many screens want the answer", async () => {
    const fetchMock = answerMe(VIEWER_ANSWER);
    render(
      <>
        <Probe />
        <Probe />
      </>
    );
    await settled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["answers with an error", () => answerMe({ error: "Internal error" }, 500)],
    ["says it could not read the role", () => answerMe({ ...VIEWER_ANSWER, accessUnavailable: true })],
    ["cannot be reached", () => {
      globalThis.fetch = jest.fn().mockRejectedValue(new Error("network")) as unknown as typeof fetch;
    }],
  ])("holds nothing, and says the check failed, when /api/me %s", async (_case, setUp) => {
    // What the server does when it cannot read the role either: no
    // permissions, rather than the full admin the bypass would otherwise be.
    setUp();
    read();
    const result = await settled();
    expect(result.accessError).toBe(true);
    expect(result.viewingAs).toBe("viewer");
    expect(result.isAdmin).toBe(false);
    expect(ALL_PERMISSIONS.some((key) => result.can(key))).toBe(false);
  });

  test("is the full admin again when the picked role has since been deleted", async () => {
    // The server stops acting as a role that is gone, and so does this.
    document.cookie = `${VIEW_AS_COOKIE}=qa-lead; path=/`;
    answerMe({
      role: "admin",
      roleLabel: "Admin",
      permissions: ALL_PERMISSIONS,
      bypass: true,
      viewingAs: null,
      accessUnavailable: false,
    });
    read();
    const result = await settled();
    expect(result.viewingAs).toBeNull();
    expect(result.isAdmin).toBe(true);
    expect(result.can("roles:update")).toBe(true);
  });

  test("never matches a permission this build does not know", async () => {
    answerMe({ ...VIEWER_ANSWER, permissions: ["dashboard:read", "made-up:thing"] });
    read();
    const result = await settled();
    expect(result.can("dashboard:read")).toBe(true);
    expect(result.can("made-up:thing" as PermissionKey)).toBe(false);
  });

  test("drops a slow answer to a question asked before a reset", async () => {
    // The switcher went back to Admin while the lookup for Viewer was still
    // out. The late answer is a true answer to a question nobody is asking any
    // more, and letting it land would put the old role back.
    let release: (value: unknown) => void = () => {};
    globalThis.fetch = jest.fn().mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    ) as unknown as typeof fetch;
    expect(read().loading).toBe(true);

    document.cookie = VIEW_AS_GONE;
    act(() => resetUserCache());
    expect(seen?.role).toBe("admin");
    expect(seen?.viewingAs).toBeNull();

    await act(async () => {
      release({ ok: true, status: 200, json: () => Promise.resolve(VIEWER_ANSWER) });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(seen?.role).toBe("admin");
    expect(seen?.viewingAs).toBeNull();
  });
});

describe("reading the View as cookie the way the server reads it", () => {
  // The server reads the cookie off the request (bypassPrincipal in
  // lib/auth-guard.ts) and the browser reads it off document.cookie. If the two
  // disagreed about whether there is one, the page would be drawn for one role
  // while the routes answered for another.
  const LOOK_ALIKE = `${VIEW_AS_COOKIE}-old`;

  beforeEach(() => {
    mockBypass = true;
  });

  afterEach(() => {
    document.cookie = `${LOOK_ALIKE}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  });

  /** /api/me cannot be reached, so the hook shows the role the cookie names. */
  function meUnreachable() {
    globalThis.fetch = jest.fn().mockRejectedValue(new Error("network")) as unknown as typeof fetch;
  }

  test.each([
    ["an empty value", `${VIEW_AS_COOKIE}=; path=/`],
    ["a value that cannot be decoded", `${VIEW_AS_COOKIE}=%E0%A4%A; path=/`],
    ["a cookie whose name only starts the same", `${LOOK_ALIKE}=viewer; path=/`],
  ])("takes %s as no View as at all, and asks nobody", (_case, cookie) => {
    document.cookie = cookie;
    const fetchMock = answerMe(VIEWER_ANSWER);
    const result = read();
    expect([result.loading, result.role, result.viewingAs]).toEqual([false, "admin", null]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("decodes the value before asking about it", async () => {
    // The route that sets it writes role keys, which need no encoding, but a
    // value that arrives encoded has to name the same role on both sides.
    document.cookie = `${VIEW_AS_COOKIE}=qa%2Dlead; path=/`;
    meUnreachable();
    read();
    const result = await settled();
    expect([result.role, result.viewingAs]).toEqual(["qa-lead", "qa-lead"]);
  });

  test("cuts a long value to a role key's length before showing it", async () => {
    // The cookie is whatever the browser holds, and with /api/me unreachable
    // it is shown as the role's name. The server cuts it to the same length.
    document.cookie = `${VIEW_AS_COOKIE}=${"x".repeat(100)}; path=/`;
    meUnreachable();
    read();
    const result = await settled();
    const cut = "x".repeat(32);
    expect([result.role, result.roleLabel, result.viewingAs]).toEqual([cut, cut, cut]);
  });
});

describe("on the server, before the page reaches the browser", () => {
  // The first frame is drawn on the server, which read the View as cookie off
  // the request and says so through ViewAsCookieSeen. Drawing the admin's page
  // and then taking it away in the browser would show, for a moment, screens
  // the server is refusing.
  function Label() {
    const { role, loading } = useUser();
    return <span>{loading ? "loading" : role}</span>;
  }

  beforeEach(() => {
    mockBypass = true;
  });

  test("draws the full admin straight away when the request had no View as cookie", () => {
    const html = renderToStaticMarkup(
      <ViewAsCookieSeen.Provider value={false}>
        <Label />
      </ViewAsCookieSeen.Provider>
    );
    expect(html).toBe("<span>admin</span>");
  });

  test("waits when it had one, and when nothing said either way", () => {
    const withCookie = renderToStaticMarkup(
      <ViewAsCookieSeen.Provider value={true}>
        <Label />
      </ViewAsCookieSeen.Provider>
    );
    expect(withCookie).toBe("<span>loading</span>");
    expect(renderToStaticMarkup(<Label />)).toBe("<span>loading</span>");
  });
});

describe("resetUserCache", () => {
  test("is safe with real sign-in, and changes nothing there", () => {
    // It is called on the way out of the app (StudioShell's sign-out handler).
    // With real sign-in the session is the whole answer, so there is nothing
    // of its own to forget.
    signIn({ email: "a@example.com", role: "admin", roleLabel: "Admin", permissions: [...ALL_PERMISSIONS] });
    const before = read();
    expect(() => resetUserCache()).not.toThrow();
    expect(withoutCan(read())).toEqual(withoutCan(before));
  });

  test("forgets the View as answer, and asks again for what is on the page", async () => {
    // The View as answer is kept for the life of the page, so this is how a
    // screen already showing gets the new role without being drawn again.
    mockBypass = true;
    document.cookie = `${VIEW_AS_COOKIE}=viewer; path=/`;
    answerMe(VIEWER_ANSWER);
    read();
    expect((await settled()).viewingAs).toBe("viewer");

    document.cookie = VIEW_AS_GONE;
    act(() => resetUserCache());
    expect(seen?.role).toBe("admin");
    expect(seen?.viewingAs).toBeNull();
  });
});
