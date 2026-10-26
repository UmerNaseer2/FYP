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
 *    /api/me (through lib/auth-guard.ts), before the answer ever reaches this
 *    hook. What is pinned below is what the hook does
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

type MockSession = { user: { name?: string | null; email?: string | null } } | null;

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

/** A signed-in session, as auth.ts leaves it: who the person is, and nothing more. */
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
  org: { slug: "default", name: "Default" },
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

/** What /api/me says for someone holding `role` in the default organization. */
function memberAnswer(role: string, roleLabel: string, permissions: readonly string[]) {
  return {
    role,
    roleLabel,
    permissions,
    bypass: false,
    viewingAs: null,
    org: { slug: "default", name: "Default" },
  };
}

const VIEWER = presetFor("viewer") ?? [];

/** Let answers that have already arrived run all the way through. */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function comeBack(event: "focus" | "visibilitychange") {
  act(() => {
    (event === "focus" ? window : document).dispatchEvent(new Event(event));
  });
}

describe("with authentication enforced", () => {
  test("says plainly that nobody is signed in, and asks nobody", () => {
    const fetchMock = answerMe({});
    const result = read();
    expect([result.user, result.loading, result.isAdmin]).toEqual([null, false, false]);
    expect(ALL_PERMISSIONS.some((key) => result.can(key))).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("reports loading while the session is still being fetched, and asks nobody yet", () => {
    mockStatus = "loading";
    const fetchMock = answerMe({});
    expect(read().loading).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("draws a signed-in page as still loading on the server", () => {
    signIn({ email: "a@example.com" });
    function Show() {
      return <i>{String(useUser().loading)}</i>;
    }
    expect(renderToStaticMarkup(<Show />)).toBe("<i>true</i>");
  });

  test("waits for /api/me, then is the role it names, with what it may do", async () => {
    signIn({ email: "v@example.com", name: "Vee" });
    const fetchMock = answerMe(memberAnswer("viewer", "Viewer", VIEWER));
    expect(read().loading).toBe(true);
    const result = await settled();
    expect(fetchMock).toHaveBeenCalledWith("/api/me", { cache: "no-store" });
    expect(result.user).toEqual({ email: "v@example.com", name: "Vee" });
    expect([result.role, result.roleLabel, result.isAdmin]).toEqual(["viewer", "Viewer", false]);
    expect(VIEWER.every((key) => result.can(key))).toBe(true);
    expect(result.can("roles:update")).toBe(false);
    expect([result.accessError, result.notMember, result.bypass]).toEqual([false, false, false]);
  });

  test("calls an admin an admin, and a custom role by its own name", async () => {
    signIn({ email: "a@example.com" });
    answerMe(memberAnswer("admin", "Admin", ALL_PERMISSIONS));
    read();
    expect((await settled()).isAdmin).toBe(true);

    // The new answer goes in first: the hook already on screen asks again as
    // soon as it is told to forget.
    answerMe(memberAnswer("qa-lead", "QA Lead", [VIEWER[0]]));
    act(() => resetUserCache());
    read();
    const custom = await settled();
    expect([custom.role, custom.roleLabel, custom.isAdmin]).toEqual(["qa-lead", "QA Lead", false]);
  });

  test("takes the address as the name when the session carries no name", async () => {
    signIn({ email: "a@example.com", name: null });
    answerMe(memberAnswer("viewer", "Viewer", VIEWER));
    read();
    expect((await settled()).user).toEqual({ email: "a@example.com", name: "a@example.com" });
  });

  test("falls back to a built-in role's own name, and drops unknown permissions", async () => {
    signIn({ email: "a@example.com" });
    answerMe({ role: "editor", permissions: [VIEWER[0], "made:up", 7] });
    read();
    const result = await settled();
    expect(result.roleLabel).toBe("Editor");
    expect(result.can(VIEWER[0])).toBe(true);
    expect(result.can("made:up" as PermissionKey)).toBe(false);
  });

  test("says they are not a member when /api/me answers 404, and grants nothing", async () => {
    signIn({ email: "gone@example.com" });
    answerMe({ error: "not a member" }, 404);
    read();
    const result = await settled();
    expect([result.notMember, result.accessError, result.isAdmin]).toEqual([true, false, false]);
    expect(ALL_PERMISSIONS.some((key) => result.can(key))).toBe(false);
    expect(result.user?.email).toBe("gone@example.com");
  });

  test.each([
    ["answers 401", () => answerMe({ error: "Sign in" }, 401)],
    ["answers 503", () => answerMe({ error: "Try again." }, 503)],
    ["answers 500", () => answerMe({ error: "Internal error" }, 500)],
    ["answers without a role", () => answerMe({ permissions: ALL_PERMISSIONS })],
    ["cannot be reached", () => {
      const unreachable = jest.fn().mockRejectedValue(new Error("network"));
      globalThis.fetch = unreachable as unknown as typeof fetch;
    }],
  ])("grants nothing, and says the check failed, when /api/me %s", async (_case, setUp) => {
    // A 401 too: the session says they are signed in, so sending them to sign
    // in again would only bring them back here.
    signIn({ email: "a@example.com" });
    setUp();
    read();
    const result = await settled();
    expect([result.accessError, result.notMember, result.isAdmin]).toEqual([true, false, false]);
    expect(ALL_PERMISSIONS.some((key) => result.can(key))).toBe(false);
  });

  test.each(["focus", "visibilitychange"] as const)(
    "asks again on %s, and takes a role an admin changed meanwhile",
    async (event) => {
      signIn({ email: "a@example.com" });
      answerMe(memberAnswer("viewer", "Viewer", VIEWER));
      read();
      expect((await settled()).isAdmin).toBe(false);
      answerMe(memberAnswer("admin", "Admin", ALL_PERMISSIONS));
      comeBack(event);
      await waitFor(() => expect(seen?.isAdmin).toBe(true));
      expect(seen?.loading).toBe(false);
    },
  );

  test("keeps what it knew when asking again fails", async () => {
    // A screen with unsaved work would otherwise be swapped for "could not
    // check" over a blip, when the next look will very likely answer.
    signIn({ email: "a@example.com" });
    answerMe(memberAnswer("viewer", "Viewer", VIEWER));
    read();
    const before = withoutCan(await settled());
    const failing = answerMe({ error: "Try again." }, 503);
    comeBack("focus");
    await flush();
    expect(failing).toHaveBeenCalledTimes(1);
    expect(withoutCan(seen as UserAccess)).toEqual(before);
  });

  test("says they are not a member once an admin has removed them", async () => {
    signIn({ email: "a@example.com" });
    answerMe(memberAnswer("viewer", "Viewer", VIEWER));
    read();
    await settled();
    answerMe({ error: "not a member" }, 404);
    comeBack("focus");
    await waitFor(() => expect(seen?.notMember).toBe(true));
  });

  test("does not ask again while the first answer is still on its way", async () => {
    signIn({ email: "a@example.com" });
    const fetchMock = jest.fn(() => new Promise(() => {}));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    read();
    comeBack("focus");
    comeBack("visibilitychange");
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(seen?.loading).toBe(true);
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
      notMember: false,
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

  test("outranks whoever a real session happens to belong to", () => {
    // The API routes are already being let through as an admin. A UI that
    // refused the same person would be the two halves disagreeing.
    signIn({ email: "viewer@example.com" });
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
    ["says its database did not answer", () => answerMe({ error: "Try again." }, 503)],
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
      org: { slug: "default", name: "Default" },
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
    // it is shown as the role's name. Role keys are 32 characters at most, so
    // a longer value was not set by the switcher, and no more than that shows.
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
  test("forgets the answer with real sign-in too, and asks again", async () => {
    // Only tests need it: signing out loads a new page, which starts over.
    signIn({ email: "a@example.com" });
    const fetchMock = answerMe(memberAnswer("admin", "Admin", ALL_PERMISSIONS));
    read();
    expect((await settled()).isAdmin).toBe(true);
    act(() => resetUserCache());
    expect(withoutCan(await settled())).toEqual(withoutCan(read()));
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
