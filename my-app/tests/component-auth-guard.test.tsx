/** @jest-environment jsdom */

/**
 * The gate every studio page is wrapped in.
 *
 * It is not a security boundary and does not pretend to be one — proxy.ts turns
 * a page request away and lib/auth-guard turns an API call away, both before
 * any of this runs. What AuthGuard decides is what React puts on screen, and
 * the failures worth catching are the ways that can go wrong from the reader's
 * side: a page whose contents flash up for a frame before the redirect lands, a
 * signed-in person bounced to /login because the guard read the moment before
 * next-auth answered as a signed-out one, and a refusal that does not say what
 * to ask for.
 *
 * The rule is the feature's Read box. A page that belongs to several features
 * names them all, and Read on any one of them is enough, the same as
 * requirePermission on the server. A refusal names three things: the role, the
 * account signed in, and the box an admin would have to tick. Without the
 * account, a reader with two of them cannot tell which one they are using.
 *
 * Someone the server says is not a member of the organization gets none of
 * it, the pages that name no feature included, because every request behind
 * every page is answered 404 for them. In the browser they can go to the
 * organizations they are still in, or make one (/onboarding). In the desktop
 * app, which only ever has the one organization, signing out is the one way
 * on.
 *
 * What is NOT here:
 *  - Which permissions a role holds, and what a box brings with it:
 *    tests/permissions.test.ts, against lib/permissions.
 *  - The real enforcement, in tests/proxy.test.ts, tests/host-guard.test.ts and
 *    the route suites.
 */

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

jest.mock("next/navigation", () => require("./helpers/render-page").navigationStubs);
jest.mock("next-auth/react", () => require("./helpers/render-page").sessionStubs);

// Which way signing out goes (next-auth, or the desktop app) is lib/sign-out's
// business, and tests/component-studio-shell.test.tsx follows both. Here it
// only matters that the button asks for it.
const mockSignOutEverywhere = jest.fn();
jest.mock("../lib/sign-out", () => ({ signOutEverywhere: () => mockSignOutEverywhere() }));

let mockBypass = false;
jest.mock("../lib/auth-mode", () => ({
  ...jest.requireActual("../lib/auth-mode"),
  // A getter, so one file can see both sides of a switch that is otherwise
  // decided once, at module load. See tests/use-user.test.tsx.
  get BYPASS_AUTH() {
    return mockBypass;
  },
}));

import AuthGuard from "@/components/AuthGuard";
import { resetUserCache } from "@/hooks/useUser";
import { presetFor, type FeatureKey } from "@/lib/permissions";
import { installDesktopBridge, removeDesktopBridge } from "./helpers/desktop-bridge";
import {
  resetPageState,
  routerCalls,
  setAccessError,
  setCustomRole,
  setNotMember,
  setRoutes,
  setSessionLoading,
  setUser,
} from "./helpers/render-page";

const SECRET = "the connection list";

function show(feature?: FeatureKey | FeatureKey[]) {
  render(
    <AuthGuard feature={feature}>
      <p>{SECRET}</p>
    </AuthGuard>
  );
}

beforeEach(() => {
  resetPageState();
  mockSignOutEverywhere.mockClear();
});
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
  it("opens a page that names no feature to anyone, even a role with nothing", () => {
    setCustomRole("nobody", "Nobody", []);
    show();

    expect(screen.getByText(SECRET)).toBeInTheDocument();
    expect(routerCalls.push).toEqual([]);
  });

  it("opens a page to a role that may read its feature", () => {
    setUser("viewer");
    show("connections");

    expect(screen.getByText(SECRET)).toBeInTheDocument();
  });

  it("opens a page of several features on Read of any one of them", () => {
    // A schema's history page belongs to drift tracking and to the dashboard,
    // and a role that may read either is meant to get in.
    setCustomRole("watcher", "Watcher", ["dashboard:read"]);
    show(["drift", "dashboard"]);

    expect(screen.getByText(SECRET)).toBeInTheDocument();
  });

  it("refuses a role without the box, and says which three things are wrong", () => {
    // A role an admin made, which nothing in the code knows by name. It is
    // refused for what it holds, and called by the name people gave it.
    setCustomRole("auditor", "Auditor", ["dashboard:read"]);
    show("connections");

    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
    expect(screen.getByText("Your role (Auditor) can't open this page.")).toBeInTheDocument();
    const hint = screen.getByText(/You are signed in as/);
    expect(hint).toHaveTextContent("You are signed in as auditor@example.com.");
    expect(hint).toHaveTextContent(
      'Ask an admin to allow "Connections: Read" for your role, then reload.'
    );
  });

  it("does not offer a box nobody can tick on an admin-only page", () => {
    // Users and Roles & permissions are admin-only. Telling a viewer to ask for
    // "Users: Read" would send them after a box that is not on the grid.
    setUser("viewer");
    show(["users", "roles"]);

    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
    expect(screen.getByText("Your role (Viewer) can't open this page.")).toBeInTheDocument();
    expect(screen.getByText(/You are signed in as/)).toHaveTextContent(
      "Only admins can open it."
    );
    expect(screen.queryByText(/Ask an admin to allow/)).toBeNull();
  });

  it("opens an admin-only page to an admin", () => {
    setUser("admin");
    show(["users", "roles"]);

    expect(screen.getByText(SECRET)).toBeInTheDocument();
  });

  it("does not send a refused reader to sign in again", () => {
    // They are signed in. Sending them to /login would land them back here with
    // the same role, which is a loop with no exit the reader can find.
    setUser("editor");
    show(["users", "roles"]);

    expect(routerCalls.push).toEqual([]);
  });
});

describe("someone who is not a member of the organization", () => {
  it("says so on every page, the open ones too, and shows none of it", () => {
    // An admin removed them after they signed in. Even a page that names no
    // feature would only fill up with the server's 404s.
    setNotMember();
    show();

    expect(screen.getByText("You are not a member of this organization.")).toBeInTheDocument();
    expect(
      screen.getByText(
        "An admin may have removed you, or you were never added. Check with an admin, " +
          "open another of your organizations, or sign out."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
  });

  it("offers a way out, and does not loop them through /login", () => {
    // /login would sign them straight back in to the same organization.
    setNotMember();
    show("connections");

    expect(routerCalls.push).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(mockSignOutEverywhere).toHaveBeenCalledTimes(1);
  });

  it("in the browser, offers the organizations they are still in, or a new one", () => {
    setNotMember();
    show();

    expect(screen.getByRole("link", { name: "Your organizations" })).toHaveAttribute(
      "href",
      "/onboarding"
    );
  });

  it("in the desktop app, offers only signing out", () => {
    // The desktop app only ever has the one organization, and no page for
    // making another.
    installDesktopBridge();
    try {
      setNotMember();
      show();

      expect(
        screen.getByText(
          "An admin may have removed you, or you were never added. Check with an admin, or sign out."
        )
      ).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Your organizations" })).toBeNull();
      expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    } finally {
      removeDesktopBridge();
    }
  });
});

describe("when the database could not say what the role may do", () => {
  it("says the check failed, not that the role can't", () => {
    // Every request behind the page would be answered "try again" (503).
    // "Your role can't" would send the reader to an admin about a problem no
    // admin can fix.
    setAccessError("viewer");
    show("connections");

    expect(screen.getByText("Could not check your access right now.")).toBeInTheDocument();
    expect(screen.queryByText(/can't open this page/)).toBeNull();
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
  });

  it("still opens a page that names no feature", () => {
    setAccessError("viewer");
    show();

    expect(screen.getByText(SECRET)).toBeInTheDocument();
  });
});

describe('with the bypass on and "View as" picking a role', () => {
  // What /api/me says while the switcher on the rail is set to Viewer.
  const VIEWER_ANSWER = {
    role: "viewer",
    roleLabel: "Viewer",
    permissions: presetFor("viewer"),
    bypass: true,
    viewingAs: "viewer",
    org: { slug: "default", name: "Default" },
  };

  beforeEach(() => {
    mockBypass = true;
    document.cookie = "studio-view-as=viewer; path=/";
    resetUserCache();
  });

  afterEach(() => {
    // Unmounted first, so the reset below has nobody to look the role up for.
    cleanup();
    document.cookie = "studio-view-as=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT";
    mockBypass = false;
    resetUserCache();
  });

  it("checks first, then refuses what the role can't open and says how to go back", async () => {
    // The server is acting as a viewer, so drawing the admin page for a frame
    // and then taking it away would show something the API is refusing.
    setRoutes([{ match: "/api/me", body: VIEWER_ANSWER }]);
    show(["users", "roles"]);

    expect(screen.getByText("Checking your access…")).toBeInTheDocument();
    expect(await screen.findByText("Your role (Viewer) can't open this page.")).toBeInTheDocument();
    expect(
      screen.getByText(
        'You are viewing the app as Viewer. Change "View as" to Admin to see every screen again.'
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
  });

  it("opens what the role can", async () => {
    setRoutes([{ match: "/api/me", body: VIEWER_ANSWER }]);
    show("connections");

    expect(await screen.findByText(SECRET)).toBeInTheDocument();
  });

  it("says the check failed when /api/me can't answer, and to reload", async () => {
    setRoutes([{ match: "/api/me", status: 500, body: { error: "boom" } }]);
    show("connections");

    expect(await screen.findByText("Could not check your access right now.")).toBeInTheDocument();
    expect(screen.getByText(/Reload the page in a moment\./)).toBeInTheDocument();
    // Not "change View as": the server needs its database to act as any role,
    // Admin included, so switching would not get anybody in.
    expect(screen.queryByText(/View as/)).not.toBeInTheDocument();
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
  });

  it("says when no organization has the address, with nobody to sign out", async () => {
    setRoutes([
      {
        match: "/api/me",
        status: 404,
        body: { error: "This organization does not exist, or you are not a member." },
      },
    ]);
    show();

    expect(
      await screen.findByText("You are not a member of this organization.")
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Authentication is off, and the app's database has no organization at this address."
      )
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
  });
});
