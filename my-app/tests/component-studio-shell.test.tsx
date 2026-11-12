/** @jest-environment jsdom */

/**
 * The chrome every studio screen is rendered inside.
 *
 * Nothing here is a screen. What this component does is decide, on every page
 * load, four things the screens themselves never see: which rail rows you are
 * allowed to have, which one is lit, who the rail says you are, and whether
 * this is a window with room for a rail at all. Each of those has one failure
 * that is worse than the rest and each is checked below.
 *
 * The phone path is the one with the most to go wrong. Below 768px the rail
 * leaves the grid entirely and becomes an off-canvas drawer, which means the
 * only route to any other screen is a single unlabelled hamburger — and it
 * means the rail exists twice in the code and never twice on screen. It is
 * driven by matchMedia rather than a one-shot innerWidth read, so rotating a
 * phone has to move the rail without a reload, and the listener has to be let
 * go of on the way out.
 *
 * The session is shaped directly here rather than through the setUser in
 * tests/helpers/render-page.tsx. That helper hands out fixed identities of the
 * form "A admin", and what needs checking is the mapping itself: a session
 * with a name, one with only an address, and one with neither. The session
 * says who is signed in and nothing more, the way auth.ts builds it. The role
 * comes from /api/me, so renderShell hands useUser what /api/me would answer
 * before drawing (seedUserAccess), because the rail only offers a screen the
 * role may open. Routing comes from the helper, because usePathname is all
 * this needs.
 *
 * What is NOT here:
 *  - The rail's own behaviour — sr-only labels, the collapsed brand cell, the
 *    theme wording: tests/component-studio-sidebar.test.tsx.
 *  - The breadcrumb strip and its menu button:
 *    tests/component-studio-topbar.test.tsx.
 *  - Which row a path belongs to, and the row list itself:
 *    tests/studio-nav.test.ts.
 *  - The drawer's own machinery — the portal, the scrim, the focus trap:
 *    tests/component-drawer.test.tsx.
 *  - The two hooks themselves: tests/use-theme.test.tsx and
 *    tests/use-user.test.tsx. What is asserted here is only that the shell is
 *    wired to them: the theme reaching the document, and the session and the
 *    server's answer reaching the rail.
 *  - The auth-bypass pill. It is driven by BYPASS_AUTH, which lib/auth-mode
 *    reads once at module load, so it cannot be switched per test in this file
 *    without switching it for all of them. Both pills are drawn in
 *    tests/component-studio-sidebar.test.tsx, where they arrive as props.
 *  - That the rail is actually 240px wide or the drawer actually slides. Those
 *    are the grid and the stylesheet; what is asserted is the track the shell
 *    asks for, since choosing it is this component's decision.
 */

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { OrgProvider } from "@/components/OrgProvider";
import { StudioShell } from "@/components/studio/StudioShell";
import { type StudioUser } from "@/components/studio/StudioSidebar";
import { resetUserCache, seedUserAccess } from "@/hooks/useUser";
import {
  BUILT_IN_ROLE_INFO,
  effectivePermissions,
  presetFor,
  type BuiltInRole,
} from "@/lib/permissions";
import { pageLoader } from "@/lib/sign-out";
import { installDesktopBridge, removeDesktopBridge } from "./helpers/desktop-bridge";
import { setPathname } from "./helpers/render-page";

jest.mock("next/navigation", () => require("./helpers/render-page").navigationStubs);

/** A session as auth.ts builds it: who is signed in, and nothing about access. */
type MockSession = { user: { name?: string | null; email?: string | null } } | null;

type MeAnswer = { status: number; body: unknown };

/** What /api/me answers a member of the organization who holds this role. */
function answer(role: string, roleLabel: string, permissions: readonly string[]): MeAnswer {
  return {
    status: 200,
    body: {
      role,
      roleLabel,
      permissions: effectivePermissions(role, permissions),
      bypass: false,
      viewingAs: null,
      org: { slug: "test-org", name: "Test Org" },
    },
  };
}

// The same words lib/auth-guard.ts answers with.
const NOT_A_MEMBER: MeAnswer = {
  status: 404,
  body: { error: "This organization does not exist, or you are not a member." },
};
const DATABASE_DOWN: MeAnswer = {
  status: 503,
  body: {
    error:
      "Could not check what your role can do, because the app's database did not answer. " +
      "Try again in a moment.",
  },
};

let mockSession: MockSession = null;
/** What /api/me says to whoever mockSession is. Unused while nobody is signed in. */
let me: MeAnswer = answer("admin", BUILT_IN_ROLE_INFO.admin.label, []);

/** Sign somebody in who holds a built-in role, able to do what it starts out with. */
function signInAs(
  role: BuiltInRole,
  who: { name?: string; email?: string } = { name: "Ada Lovelace", email: "ada@example.com" }
) {
  mockSession = { user: { ...who } };
  me = answer(role, BUILT_IN_ROLE_INFO[role].label, presetFor(role) ?? []);
}
const mockSignOutCalls: unknown[] = [];

jest.mock("next-auth/react", () => ({
  useSession: () => ({
    data: mockSession,
    status: mockSession ? "authenticated" : "unauthenticated",
  }),
  signOut: (options?: unknown) => {
    mockSignOutCalls.push(options);
    return Promise.resolve(undefined);
  },
}));

/*
  A window that can change shape. The stub in tests/helpers/jsdom-gaps.ts never
  matches anything, which is the right default for every other suite and the
  one thing this one cannot live with: half of what is below only happens when
  the query does match, and a rotation only happens when it changes.
*/
const realMatchMedia = window.matchMedia;
let mediaMatches = false;
let mediaQueries: string[] = [];
const mediaListeners = new Set<() => void>();

beforeAll(() => {
  window.matchMedia = ((query: string) => {
    mediaQueries.push(query);
    return {
      media: query,
      get matches() {
        return mediaMatches;
      },
      onchange: null,
      addEventListener: (_type: string, fn: () => void) => {
        mediaListeners.add(fn);
      },
      removeEventListener: (_type: string, fn: () => void) => {
        mediaListeners.delete(fn);
      },
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
});

afterAll(() => {
  window.matchMedia = realMatchMedia;
});

beforeEach(() => {
  mediaMatches = false;
  mediaQueries = [];
  mediaListeners.clear();
  mockSignOutCalls.length = 0;
  signInAs("admin");
  setPathname("/studio");
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

/** Answer the media query the way a window of that shape would. */
function setViewport(mobile: boolean) {
  mediaMatches = mobile;
  act(() => {
    for (const listener of mediaListeners) listener();
  });
}

const PAGE = <p>The page itself</p>;

function renderShell(props: { user?: StudioUser } = {}, org?: string) {
  // What a page learns from /api/me as it opens, handed over before it is
  // drawn, so the rail is right on the first frame. useUser keeps what it
  // learned between tests, hence the reset. Nobody signed in asks nothing.
  resetUserCache();
  if (mockSession) seedUserAccess(me.status, me.body);
  const shell = <StudioShell {...props}>{PAGE}</StudioShell>;
  // app/[org]/layout.tsx provides the organization around every real page.
  return render(org ? <OrgProvider slug={org} name={org}>{shell}</OrgProvider> : shell);
}

const rail = () => screen.getByRole("complementary");
const grid = () => document.querySelector(".studio") as HTMLElement;
const button = (name: string) => screen.getByRole("button", { name });
const hamburger = () => screen.queryByRole("button", { name: "Open navigation" });
// The top bar's "where am I" line. The rail's list of pages is a navigation
// landmark too, so it is found by name.
const breadcrumb = () => screen.getByRole("navigation", { name: "Breadcrumb" });
// The round button at the right of the top bar, and the menu it opens. Who you
// are, your role and Sign out all live there in this design.
const accountButton = () => screen.getByRole("button", { name: /^Account menu/ });
function openAccountMenu() {
  fireEvent.click(accountButton());
  return screen.getByRole("menu", { name: "Account" });
}

describe("a window with room for the rail", () => {
  test("puts the rail, the bar and the page on screen together", () => {
    renderShell({}, "acme");
    expect(rail()).toBeInTheDocument();
    expect(breadcrumb()).toHaveTextContent("acme");
    expect(screen.getByRole("main")).toHaveTextContent("The page itself");
  });

  test("holds what is placed absolutely on a page, so the window never grows", () => {
    // jsdom has no layout, so this pins the class: text hidden for screen readers
    // far down Deploy made the window taller than the screen without it.
    renderShell();
    expect(screen.getByRole("main")).toHaveClass("relative");
  });

  test("starts with a skip link that moves focus past the rail to the page", () => {
    // A keyboard user would otherwise Tab through the whole rail, about
    // fifteen presses, on every screen before reaching the page.
    renderShell();
    const skip = screen.getByRole("link", { name: "Skip to content" });
    // First in the shell, so it is the first thing Tab reaches.
    expect(grid().firstElementChild).toBe(skip);
    expect(skip).toHaveAttribute("href", "#main-content");

    const main = screen.getByRole("main");
    expect(main).toHaveAttribute("id", "main-content");
    // -1: focus can be put there, but Tab never stops on it.
    expect(main).toHaveAttribute("tabindex", "-1");

    fireEvent.click(skip);
    expect(main).toHaveFocus();
  });

  test("keeps the skip link first on a phone too, where the rail is in a drawer", () => {
    mediaMatches = true;
    renderShell();
    expect(grid().firstElementChild).toBe(screen.getByRole("link", { name: "Skip to content" }));
  });

  test("names the screen you are on, from the address bar", () => {
    setPathname("/versionsync");
    renderShell();
    expect(breadcrumb()).toHaveTextContent("Version Sync");
  });

  test("follows the address into a page underneath a screen", () => {
    // /compare/142 is a saved comparison. The breadcrumb naming the dashboard
    // there would tell somebody they had left the screen they are looking at.
    setPathname("/compare/142");
    renderShell();
    expect(breadcrumb()).toHaveTextContent("Compare & Author");
  });

  test("lights the row you are on", () => {
    setPathname("/drift");
    renderShell();
    expect(screen.getByRole("link", { name: "Drift" }).className).toContain("active");
    expect(screen.getByRole("link", { name: "Deploy" }).className).not.toContain("active");
  });

  test("keeps every row inside the organization the page is open in", () => {
    // A row that dropped the organization would still work, through the old
    // address's redirect, but it would land in whichever organization was
    // opened last, which is not always this one.
    setPathname("/acme/drift");
    renderShell({}, "acme");
    expect(screen.getByRole("link", { name: "Drift" })).toHaveAttribute("href", "/acme/drift");
    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute("href", "/acme/studio");
    expect(screen.getByRole("link", { name: "Drift" }).className).toContain("active");
    expect(breadcrumb()).toHaveTextContent("Drift");
  });

  test("hands the rail the organization picker, which reads the list for itself", async () => {
    // The picker's own choices are tests/component-org-switcher.test.tsx. What
    // is checked here is that the shell gives it to the rail at all, on a
    // server with real sign-in, and that it is drawn from what the server
    // lists. Anything but the list stays unanswered, so nothing else this
    // shell might ask for changes what is drawn while the test runs.
    const realFetch = globalThis.fetch;
    const asked: string[] = [];
    globalThis.fetch = ((input: unknown) => {
      asked.push(String(input));
      if (String(input) !== "/api/organizations") return new Promise(() => {});
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            organizations: [
              { slug: "acme", name: "acme" },
              { slug: "beta-ops", name: "Beta Ops" },
            ],
            canCreate: true,
          }),
      });
    }) as typeof fetch;
    try {
      setPathname("/acme/drift");
      renderShell({}, "acme");
      const picker = await screen.findByRole("combobox", { name: "Organization" });
      expect(rail()).toContainElement(picker);
      expect(picker).toHaveTextContent("acme");
      expect(asked).toContain("/api/organizations");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("gives the rail its own column, and a narrow one once collapsed", () => {
    renderShell();
    expect(grid().getAttribute("style")).toContain("240px 1fr");
    fireEvent.click(button("Collapse sidebar"));
    expect(grid().getAttribute("style")).toContain("64px 1fr");
  });

  test("collapses and expands from the rail's own control", () => {
    renderShell();
    fireEvent.click(button("Collapse sidebar"));
    expect(screen.queryByRole("button", { name: "Collapse sidebar" })).toBeNull();
    fireEvent.click(button("Expand sidebar"));
    expect(button("Collapse sidebar")).toBeInTheDocument();
  });

  test("keeps the hamburger off a window that has the rail already", () => {
    renderShell();
    expect(hamburger()).toBeNull();
  });

  test("fills the window", () => {
    renderShell();
    expect(grid().getAttribute("style")).toContain("100vh");
  });

  test("does not hand the rail the drawer's class", () => {
    renderShell();
    expect(rail()).not.toHaveClass("side-in-drawer");
  });
});

describe("who the account menu says you are", () => {
  test("takes the name, the address and the initials from the session", () => {
    renderShell();
    expect(accountButton()).toHaveTextContent("Ada Lovelace");
    const menu = openAccountMenu();
    expect(within(menu).getByText("Ada Lovelace")).toBeInTheDocument();
    expect(within(menu).getByText("ada@example.com")).toBeInTheDocument();
    expect(within(menu).getByText("AD")).toBeInTheDocument();
  });

  test("falls back to the address when the session carries no name", () => {
    signInAs("viewer", { email: "ada@example.com" });
    renderShell();
    const menu = openAccountMenu();
    // Shown twice on purpose: the address stands in for the name as well,
    // which is honest about what is known rather than leaving a blank line.
    expect(within(menu).getAllByText("ada@example.com")).toHaveLength(2);
    expect(within(menu).getByText("AD")).toBeInTheDocument();
  });

  test("says plainly when nobody is signed in", () => {
    mockSession = null;
    renderShell();
    const menu = openAccountMenu();
    expect(within(menu).getByText("Guest")).toBeInTheDocument();
    expect(within(menu).getByText("Not signed in")).toBeInTheDocument();
    expect(within(menu).getByText("?")).toBeInTheDocument();
  });

  test("still calls a session with neither name nor address signed in", () => {
    // A session this thin should not be possible, but rendering an empty name
    // beside an empty address would look like the app had lost track of you.
    signInAs("viewer", {});
    renderShell();
    const menu = openAccountMenu();
    expect(within(menu).getByText("Signed in")).toBeInTheDocument();
    expect(within(menu).getByText("SI")).toBeInTheDocument();
  });

  test("lets a caller name the user itself, over the session", () => {
    renderShell({ user: { name: "Release bot", email: "bot@example.com", initials: "RB" } });
    expect(accountButton()).toHaveTextContent("Release bot");
    expect(screen.queryByText("Ada Lovelace")).toBeNull();
  });
});

describe("what the account menu says you are allowed to do", () => {
  // Only the role half is checked here. The bypass pill is driven by
  // BYPASS_AUTH, which lib/auth-mode reads once at module load. A jest.mock of
  // it would switch the bypass on for every test in this file, including the
  // ones above that are about a real session. That the rail draws the pill when
  // it is told to is tests/component-studio-sidebar.test.tsx's.
  // Found by its tooltip, which says what the role starts out able to do: the
  // word "Admin" is also the name of a rail row.
  const pill = (role: BuiltInRole) => screen.queryByTitle(BUILT_IN_ROLE_INFO[role].description);

  test("shows the role the server answers with, by the name people read", () => {
    renderShell();
    expect(pill("admin")).toHaveTextContent("Admin");
  });

  test("and a different one when the server says so", () => {
    signInAs("viewer");
    renderShell();
    expect(pill("viewer")).toHaveTextContent("Viewer");
    expect(pill("admin")).toBeNull();
  });

  test("names a role an admin made, which has no tooltip of its own words", () => {
    me = answer("qa-lead", "QA Lead", ["dashboard:read"]);
    renderShell();
    expect(screen.getByText("QA Lead")).toBeInTheDocument();
  });

  test("says nothing about a role when nobody is signed in", () => {
    // useUser answers DEFAULT_ROLE — "viewer" — for a missing session, which is
    // the right floor for code asking "may I" and a lie on screen: a viewer
    // badge sitting under "Not signed in" reads as a role somebody holds.
    mockSession = null;
    renderShell();
    expect(screen.getByText("Not signed in")).toBeInTheDocument();
    expect(pill("viewer")).toBeNull();
    expect(screen.queryByText("Viewer")).toBeNull();
  });

  test("keeps the server's role even when a caller names the user itself", () => {
    // The `user` override is a display identity. What the server will actually
    // allow is not something it gets to relabel, so the role comes straight
    // from useUser and ignores it.
    renderShell({ user: { name: "Release bot", email: "bot@example.com", initials: "RB" } });
    expect(accountButton()).toHaveTextContent("Release bot");
    expect(pill("admin")).toHaveTextContent("Admin");
  });

  test("names no role while the app cannot look it up", () => {
    // useUser reports DEFAULT_ROLE then too, and a "Viewer" badge under a real
    // name would be a guess presented as a fact.
    me = DATABASE_DOWN;
    renderShell();
    expect(accountButton()).toHaveTextContent("Ada Lovelace");
    expect(accountButton()).not.toHaveTextContent("Viewer");
    expect(pill("viewer")).toBeNull();
    expect(screen.queryByText("Viewer")).toBeNull();
  });

  test("names no role for someone who is not a member, who holds none", () => {
    me = NOT_A_MEMBER;
    renderShell();
    expect(accountButton()).toHaveTextContent("Ada Lovelace");
    expect(pill("viewer")).toBeNull();
    expect(screen.queryByText("Viewer")).toBeNull();
  });

  test('offers no "View as" picker with real sign-in, where a person is their role', () => {
    // The picker is the bypass's stand-in for signing in as somebody else, and
    // the route behind it answers 404 once sign-in is real
    // (tests/view-as-routes.test.ts). Shown here, it would be a way to wear
    // another role that looks like it works. Its own behaviour:
    // tests/component-view-as-switcher.test.tsx.
    renderShell();
    expect(screen.queryByLabelText("View as")).toBeNull();
  });
});

describe("the admin row", () => {
  test("is there for an admin", () => {
    renderShell();
    expect(screen.getByRole("link", { name: "Admin" })).toBeInTheDocument();
  });

  test("is not offered to anybody else", () => {
    // Presentation only — the screen and its API check the role again. What
    // this saves is somebody walking into a page that will refuse them.
    signInAs("editor");
    renderShell();
    expect(screen.queryByRole("link", { name: "Admin" })).toBeNull();
    expect(screen.getByRole("link", { name: "Connections" })).toBeInTheDocument();
  });
});

describe("which screens the rail offers", () => {
  test("only the ones the role may open", () => {
    // A role an admin made that can read the dashboard and Drift and nothing
    // else. Every other row would open onto "your role can't open this page".
    me = answer("auditor", "Auditor", ["dashboard:read", "drift:read"]);
    renderShell();
    expect(screen.getByRole("link", { name: "Drift" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Deploy" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Connections" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Admin" })).toBeNull();
  });

  test("none of them for a role that may open none", () => {
    // An editor whose every permission an admin has switched off.
    me = answer("editor", BUILT_IN_ROLE_INFO.editor.label, []);
    renderShell();
    expect(screen.queryByRole("link", { name: "Drift" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Connections" })).toBeNull();
  });

  test("every screen but Admin while the app cannot say what the role may do", () => {
    // An empty rail would look broken, and each screen says for itself that the
    // check failed (tests/component-auth-guard.test.tsx).
    me = DATABASE_DOWN;
    renderShell();
    expect(screen.getByRole("link", { name: "Drift" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Connections" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Admin" })).toBeNull();
  });

  test("none at all for someone who is not a member, though Sign out stays", () => {
    // Every screen would only repeat the guard's "not a member". Signing out is
    // the one way on, and it sits in the account menu, not among the rows.
    me = NOT_A_MEMBER;
    renderShell();
    // Inside the rail: the shell's own skip link is not a screen.
    expect(within(rail()).queryAllByRole("link")).toEqual([]);
    expect(within(openAccountMenu()).getByRole("menuitem", { name: "Sign out" })).toBeInTheDocument();
  });
});

describe("signing out", () => {
  test("asks next-auth to end the session, then loads the login screen", async () => {
    // A test page cannot really go anywhere, so the page load is watched.
    const loaded = jest.spyOn(pageLoader, "load").mockImplementation(() => {});
    try {
      renderShell();
      fireEvent.click(within(openAccountMenu()).getByRole("menuitem", { name: "Sign out" }));
      await waitFor(() => expect(loaded).toHaveBeenCalledWith("/login"));
      // lib/sign-out.ts loads the page itself, once the session is gone.
      expect(mockSignOutCalls).toEqual([{ redirect: false }]);
    } finally {
      loaded.mockRestore();
    }
  });

  test("inside the desktop app, leaves it to the app, which forgets the Microsoft account too", async () => {
    // The app holds the account so that it can re-check it in the background.
    // Ending only the session would leave the account behind, so the app ends
    // both and brings up the login screen itself.
    const bridge = installDesktopBridge();
    try {
      renderShell();
      fireEvent.click(within(openAccountMenu()).getByRole("menuitem", { name: "Sign out" }));
      await act(async () => {});
      expect(bridge.signOut).toHaveBeenCalledTimes(1);
      expect(mockSignOutCalls).toEqual([]);
    } finally {
      removeDesktopBridge();
    }
  });
});

describe("the theme", () => {
  test("flips the whole document, not just the rail", () => {
    // The palette hangs off <html data-theme>, so a toggle that only changed
    // the rail's own label would leave every screen in the old colours.
    renderShell();
    fireEvent.click(button("Switch to light theme"));
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(button("Switch to dark theme")).toBeInTheDocument();
  });
});

describe("a window too narrow for the rail", () => {
  test("asks the window about the phone breakpoint rather than guessing its width", () => {
    renderShell();
    expect(mediaQueries[0]).toBe("(max-width: 768px)");
  });

  test("takes the rail out of the page and puts the way back in the bar", () => {
    setViewport(true);
    renderShell();
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(hamburger()).toBeInTheDocument();
  });

  test("gives the page the whole width, and the height a phone actually has", () => {
    // 100vh on a phone is measured behind the browser's own chrome, so the
    // bottom of the page sits under the address bar. 100dvh is the visible part.
    setViewport(true);
    renderShell();
    expect(grid().getAttribute("style")).toContain("1fr");
    expect(grid().getAttribute("style")).not.toContain("240px");
    expect(grid().getAttribute("style")).toContain("100dvh");
  });

  test("opens the rail in a drawer that says what it is", () => {
    setViewport(true);
    renderShell();
    fireEvent.click(button("Open navigation"));
    const drawer = screen.getByRole("dialog");
    expect(drawer).toHaveAttribute("aria-label", "Main navigation");
    expect(drawer).toContainElement(rail());
  });

  test("hands that rail the drawer's class, so it fills the drawer", () => {
    setViewport(true);
    renderShell();
    fireEvent.click(button("Open navigation"));
    expect(rail()).toHaveClass("side-in-drawer");
  });

  test("never collapses the rail in the drawer, which has no room to spare", () => {
    setViewport(true);
    renderShell();
    fireEvent.click(button("Open navigation"));
    expect(screen.queryByRole("button", { name: "Expand sidebar" })).toBeNull();
  });

  test("reads the rail's collapse chevron as put this away", () => {
    setViewport(true);
    renderShell();
    fireEvent.click(button("Open navigation"));
    fireEvent.click(button("Collapse sidebar"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("closes itself once you have gone somewhere", () => {
    // Tapping a row navigates, and a drawer still sitting open over the screen
    // you just asked for would have to be dismissed before you could read it.
    setViewport(true);
    const { rerender } = renderShell();
    fireEvent.click(button("Open navigation"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    setPathname("/deploy");
    rerender(<StudioShell>{PAGE}</StudioShell>);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("follows a window being resized down to a phone", () => {
    renderShell();
    expect(rail()).toBeInTheDocument();
    setViewport(true);
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(hamburger()).toBeInTheDocument();
  });

  test("and back up again", () => {
    setViewport(true);
    renderShell();
    setViewport(false);
    expect(rail()).toBeInTheDocument();
    expect(hamburger()).toBeNull();
  });

  test("stops listening to the window when it goes away", () => {
    const { unmount } = renderShell();
    expect(mediaListeners.size).toBe(1);
    unmount();
    expect(mediaListeners.size).toBe(0);
  });
});

describe("the number beside Requests", () => {
  // The rail's own read of what is waiting. Nothing else in this file answers a
  // fetch, so it is handed one for just these cases, and it notes who asked.
  const realFetch = globalThis.fetch;
  let asked: string[] = [];
  function answerCounts(counts: { waiting: number; answered: number }) {
    asked = [];
    globalThis.fetch = (async (input: unknown) => {
      if (String(input).includes("/api/requests")) asked.push(String(input));
      return { ok: true, status: 200, json: async () => ({ counts }) };
    }) as unknown as typeof fetch;
  }
  const requestsRow = (name: RegExp) => screen.findByRole("link", { name });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("adds what is waiting on this person to the answers they haven't read", async () => {
    answerCounts({ waiting: 2, answered: 1 });
    renderShell();
    expect(await requestsRow(/^Requests\s*3 waiting$/)).toBeInTheDocument();
    expect(asked).toEqual(["/api/requests?only=counts"]);
  });

  test("offers the row with no number when nothing is waiting", async () => {
    answerCounts({ waiting: 0, answered: 0 });
    renderShell();
    await waitFor(() => expect(asked).toHaveLength(1));
    expect(await requestsRow(/^Requests$/)).toBeInTheDocument();
  });

  test("offers the row to every role, since anyone may ask", async () => {
    signInAs("viewer");
    answerCounts({ waiting: 0, answered: 1 });
    renderShell();
    expect(await requestsRow(/^Requests\s*1 waiting$/)).toBeInTheDocument();
  });

  test("asks nothing when nobody is signed in", () => {
    mockSession = null;
    answerCounts({ waiting: 5, answered: 5 });
    renderShell();
    expect(asked).toEqual([]);
  });

  test("asks nothing of someone who isn't in this organization", () => {
    me = NOT_A_MEMBER;
    answerCounts({ waiting: 5, answered: 5 });
    renderShell();
    expect(asked).toEqual([]);
  });

  test("asks nothing while the app database can't say who this is", () => {
    me = DATABASE_DOWN;
    answerCounts({ waiting: 5, answered: 5 });
    renderShell();
    expect(asked).toEqual([]);
  });
});

describe("the shared trial's strip", () => {
  function renderTrial(trial: boolean) {
    resetUserCache();
    if (mockSession) seedUserAccess(me.status, me.body);
    return render(
      <OrgProvider slug="trial" name="Schema Studio Trial" trial={trial}>
        <StudioShell>{PAGE}</StudioShell>
      </OrgProvider>
    );
  }

  test("tells everyone in the trial that it is shared", () => {
    signInAs("viewer");
    renderTrial(true);
    expect(screen.getByText(/Everyone trying Schema Studio sees the same organization/)).toBeInTheDocument();
  });

  test("is not there in any other organization", () => {
    renderTrial(false);
    expect(screen.queryByText(/Shared trial/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset trial" })).not.toBeInTheDocument();
  });

  test("offers Reset trial to the Trial Admin", () => {
    signInAs("admin");
    renderTrial(true);
    expect(screen.getByRole("button", { name: "Reset trial" })).toBeInTheDocument();
  });

  test("and to nobody else", () => {
    signInAs("editor");
    renderTrial(true);
    expect(screen.getByText(/Shared trial/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset trial" })).not.toBeInTheDocument();
  });
});
