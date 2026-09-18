/** @jest-environment jsdom */

/**
 * Who the browser thinks it is.
 *
 * Every screen that hides a button, disables a form or shows a "you need the
 * editor role" line reads its answer from here, so a wrong answer is wrong in
 * a dozen places at once and in the direction that matters: too generous.
 *
 * The bypass branch is the one worth the trouble of forcing. lib/auth-mode is
 * the single switch that decides whether authentication is enforced, and
 * lib/auth-guard already hands the API routes a full admin principal while it
 * is on. If this hook did not agree, the UI would tell somebody they need the
 * admin role on a screen whose API calls are in fact being let through — the
 * client and the server disagreeing about the one switch that is supposed to
 * control both, which is worse than either answer on its own.
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
 *  - Narrowing a role that came out of the database or a token. That happens
 *    in the session callback in auth.ts before the value ever reaches this
 *    hook (auth.ts:74 runs it through toRole), and is covered by the same
 *    suite. What is pinned below is what this hook does with a value that
 *    somehow was not narrowed.
 *  - The screens that act on the answer: tests/component-auth-guard.test.tsx,
 *    tests/component-studio-shell.test.tsx, and the per-screen suites that
 *    check a disabled control (component-fix-script-builder,
 *    component-comparison-set-bar, component-query-analyzer,
 *    component-alert-thresholds).
 */

import { useEffect } from "react";
import { render } from "@testing-library/react";

import { useUser, resetUserCache } from "@/hooks/useUser";
import { roleAtLeast, BYPASS_PRINCIPAL } from "@/lib/auth-mode";

type MockSession = {
  user: { name?: string | null; email?: string | null; role?: string };
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
 * Render the hook and hand back exactly what it returned — the object itself,
 * not a copy, because one of the tests below is about its identity surviving a
 * re-render. Published from an effect rather than assigned during render:
 * writing to something outside the component while rendering is the impurity
 * the React lint rules exist to catch, and render() flushes effects anyway.
 */
let seen: ReturnType<typeof useUser> | null = null;
function Probe() {
  const value = useUser();
  useEffect(() => {
    seen = value;
  });
  return null;
}
function read() {
  render(<Probe />);
  return seen as ReturnType<typeof useUser>;
}

beforeEach(() => {
  mockSession = null;
  mockStatus = "unauthenticated";
  mockBypass = false;
  seen = null;
});

describe("with authentication enforced", () => {
  test("says plainly that nobody is signed in", () => {
    expect(read()).toEqual({
      user: null,
      role: "viewer",
      isAdmin: false,
      loading: false,
      bypass: false,
    });
  });

  test("gives the least privilege to someone with no role on their session", () => {
    mockSession = { user: { name: "Ada", email: "ada@example.com" } };
    mockStatus = "authenticated";
    const result = read();
    expect(result.role).toBe("viewer");
    expect(result.isAdmin).toBe(false);
  });

  test("takes the name and the address from the session", () => {
    mockSession = { user: { name: "Ada Lovelace", email: "ada@example.com", role: "editor" } };
    mockStatus = "authenticated";
    expect(read().user).toEqual({ name: "Ada Lovelace", email: "ada@example.com" });
  });

  test("falls back to the address when the session carries no name", () => {
    mockSession = { user: { email: "ada@example.com", role: "editor" } };
    mockStatus = "authenticated";
    expect(read().user).toEqual({ name: "ada@example.com", email: "ada@example.com" });
  });

  test("hands back empty strings, not undefined, when the session carries neither", () => {
    // StudioShell picks its display name with `name || email || "Signed in"`,
    // which needs both fields to exist before it can fall through them.
    mockSession = { user: { role: "viewer" } };
    mockStatus = "authenticated";
    expect(read().user).toEqual({ name: "", email: "" });
  });

  test("still reports a user object for a session that thin", () => {
    // Not null: null means signed out, and this person is signed in.
    mockSession = { user: { role: "viewer" } };
    mockStatus = "authenticated";
    expect(read().user).not.toBeNull();
  });

  test("honours a role the session does carry", () => {
    mockSession = { user: { email: "e@example.com", role: "editor" } };
    mockStatus = "authenticated";
    const result = read();
    expect(result.role).toBe("editor");
    expect(result.isAdmin).toBe(false);
  });

  test("calls an admin an admin", () => {
    mockSession = { user: { email: "a@example.com", role: "admin" } };
    mockStatus = "authenticated";
    const result = read();
    expect(result.role).toBe("admin");
    expect(result.isAdmin).toBe(true);
  });

  test("does not grant anything on a role it does not recognise", () => {
    // It passes the string through rather than narrowing it — the narrowing
    // happens earlier, in the session callback. What matters is where an
    // unnarrowed value lands: roleAtLeast cannot place it in the order, so it
    // is below every requirement rather than above them.
    mockSession = { user: { email: "x@example.com", role: "superuser" } };
    mockStatus = "authenticated";
    const result = read();
    expect(result.isAdmin).toBe(false);
    expect(roleAtLeast(result.role, "viewer")).toBe(false);
    expect(roleAtLeast(result.role, "editor")).toBe(false);
    expect(roleAtLeast(result.role, "admin")).toBe(false);
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
    mockSession = { user: { email: "a@example.com", role: "admin" } };
    mockStatus = "authenticated";
    expect(read().loading).toBe(false);
  });
});

describe("with the bypass on", () => {
  beforeEach(() => {
    mockBypass = true;
  });

  test("acts as the labelled testing principal", () => {
    expect(read()).toEqual({
      user: { email: BYPASS_PRINCIPAL.email, name: BYPASS_PRINCIPAL.name },
      role: "admin",
      isAdmin: true,
      loading: false,
      bypass: true,
    });
  });

  test("names that principal as the bypass rather than as a person", () => {
    // It goes on screen in the rail's identity block, so it has to read as
    // "authentication is off here", not as somebody's account.
    const result = read();
    expect(result.user?.name).toBe("Auth bypass (testing)");
    expect(result.user?.email).toBe("bypass@local");
  });

  test("says so, so a screen can show that authentication is off", () => {
    expect(read().bypass).toBe(true);
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
    mockSession = { user: { email: "viewer@example.com", role: "viewer" } };
    mockStatus = "authenticated";
    const result = read();
    expect(result.isAdmin).toBe(true);
    expect(result.role).toBe("admin");
  });

  test("never waits, because there is nothing to fetch", () => {
    mockStatus = "loading";
    expect(read().loading).toBe(false);
  });
});

describe("resetUserCache", () => {
  test("is safe to call and changes nothing", () => {
    // It is called on the way out of the app (StudioShell's sign-out handler).
    // There is no client-side cache to clear any more; the export stays so the
    // sign-out path does not have to change if one ever comes back.
    mockSession = { user: { email: "a@example.com", role: "admin" } };
    mockStatus = "authenticated";
    const before = read();
    expect(() => resetUserCache()).not.toThrow();
    expect(read()).toEqual(before);
  });
});
