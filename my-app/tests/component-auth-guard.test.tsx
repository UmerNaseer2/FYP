/** @jest-environment jsdom */

/**
 * The gate every studio page is wrapped in.
 *
 * It is not a security boundary and does not pretend to be one — proxy.ts turns
 * a page request away and lib/auth-guard turns an API call away, both before
 * any of this runs. What AuthGuard decides is what React puts on screen, and
 * the failures worth catching are the two ways that can go wrong from the
 * reader's side: a page whose contents flash up for a frame before the redirect
 * lands, and a signed-in person bounced to /login because the guard read the
 * moment before next-auth answered as a signed-out one.
 *
 * The role rule is "at least", not "exactly", and the refusal has to name three
 * things — the role needed, the account signed in, and the role it actually has
 * — or the reader cannot tell whether to ask for a different role or a different
 * account.
 *
 * What is NOT here:
 *  - The bypass branch. BYPASS_AUTH is read once at module load from
 *    NEXT_PUBLIC_AUTH_BYPASS, which next/jest does not load under NODE_ENV=test
 *    (it skips .env.local), so inside this suite it is false and the early
 *    `if (BYPASS_AUTH) return children` is unreachable. That it is false here is
 *    what makes everything below testable at all, and the bypass itself is
 *    covered by tests/auth-role-and-bypass.test.ts against lib/auth-mode.
 *  - toRole's coercion of an unrecognised role string to "viewer", which
 *    tests/auth-role-and-bypass.test.ts pins on the module that does it.
 *  - The real enforcement, in tests/proxy.test.ts and tests/host-guard.test.ts.
 */

import "@testing-library/jest-dom";
import { cleanup, render, screen } from "@testing-library/react";

jest.mock("next/navigation", () => require("./helpers/render-page").navigationStubs);
jest.mock("next-auth/react", () => require("./helpers/render-page").sessionStubs);

import AuthGuard from "@/components/AuthGuard";
import type { Role } from "@/lib/auth-mode";
import { resetPageState, routerCalls, setSessionLoading, setUser } from "./helpers/render-page";

const SECRET = "the connection list";

function show(requiredRole?: Role) {
  render(
    <AuthGuard requiredRole={requiredRole}>
      <p>{SECRET}</p>
    </AuthGuard>
  );
}

beforeEach(() => resetPageState());
afterEach(() => cleanup());

describe("before next-auth has answered", () => {
  it("says it is checking rather than showing the page", () => {
    setSessionLoading();
    show();

    expect(screen.getByText("Checking your access…")).toBeInTheDocument();
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
  });

  it("does not send a reader to /login on the strength of a pending answer", () => {
    // "No user yet" and "no user" look identical if you only check `user`. A
    // guard that conflated them would redirect every signed-in person on every
    // page load, and the session that arrived a tick later would arrive on the
    // login screen.
    setSessionLoading();
    show();

    expect(routerCalls.push).toEqual([]);
  });
});

describe("nobody signed in", () => {
  it("sends them to /login", () => {
    setUser(null);
    show();

    expect(routerCalls.push).toEqual(["/login"]);
  });

  it("renders nothing at all while it does", () => {
    // Not even the "checking" card: the redirect is already in flight, and a
    // frame of the real page is a frame of something they are not signed in to
    // see.
    setUser(null);
    const { container } = render(
      <AuthGuard>
        <p>{SECRET}</p>
      </AuthGuard>
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
  });
});

describe("signed in", () => {
  it("opens a page with no role requirement to anyone", () => {
    setUser("viewer");
    show();

    expect(screen.getByText(SECRET)).toBeInTheDocument();
    expect(routerCalls.push).toEqual([]);
  });

  it("opens a page to the exact role it asks for", () => {
    setUser("editor");
    show("editor");

    expect(screen.getByText(SECRET)).toBeInTheDocument();
  });

  it("opens it to a more privileged role too", () => {
    // The rule is "at least". An admin refused from an editor page would have
    // to be given a second, lesser account to do the work they already may do.
    setUser("admin");
    show("editor");

    expect(screen.getByText(SECRET)).toBeInTheDocument();
  });

  it("refuses a lesser role, and says which three things are wrong", () => {
    setUser("viewer");
    show("admin");

    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
    expect(screen.getByText('You need the "admin" role to open this page.')).toBeInTheDocument();
    // The account and its role, because "you need admin" alone leaves a reader
    // who has two accounts unable to tell which one they are using.
    const hint = screen.getByText(/You are signed in as/);
    expect(hint).toHaveTextContent("You are signed in as viewer@example.com");
    expect(hint).toHaveTextContent('with the "viewer" role');
    expect(hint).toHaveTextContent("Ask an admin to change it, then reload.");
  });

  it("does not send a refused reader to sign in again", () => {
    // They are signed in. Sending them to /login would land them back here with
    // the same role, which is a loop with no exit the reader can find.
    setUser("editor");
    show("admin");

    expect(routerCalls.push).toEqual([]);
  });
});
