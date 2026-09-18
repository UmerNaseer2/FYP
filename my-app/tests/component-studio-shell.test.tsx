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
 * with a name, one with only an address, and one with neither. Routing still
 * comes from the helper, because usePathname is all this needs of it.
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
 *    wired to them — the theme reaching the document, and the session reaching
 *    the rail.
 *  - That the rail is actually 240px wide or the drawer actually slides. Those
 *    are the grid and the stylesheet; what is asserted is the track the shell
 *    asks for, since choosing it is this component's decision.
 */

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { StudioShell } from "@/components/studio/StudioShell";
import { type StudioUser } from "@/components/studio/StudioSidebar";
import { setPathname } from "./helpers/render-page";

jest.mock("next/navigation", () => require("./helpers/render-page").navigationStubs);

type MockSession = {
  user: { name?: string | null; email?: string | null; role?: string };
} | null;

let mockSession: MockSession = null;
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
  mockSession = { user: { name: "Ada Lovelace", email: "ada@example.com", role: "admin" } };
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

function renderShell(props: { user?: StudioUser } = {}) {
  return render(<StudioShell {...props}>{PAGE}</StudioShell>);
}

const rail = () => screen.getByRole("complementary");
const grid = () => document.querySelector(".studio") as HTMLElement;
const button = (name: string) => screen.getByRole("button", { name });
const hamburger = () => screen.queryByRole("button", { name: "Open navigation" });

describe("a window with room for the rail", () => {
  test("puts the rail, the bar and the page on screen together", () => {
    renderShell();
    expect(rail()).toBeInTheDocument();
    expect(screen.getByRole("navigation")).toHaveTextContent("Workspace");
    expect(screen.getByRole("main")).toHaveTextContent("The page itself");
  });

  test("names the screen you are on, from the address bar", () => {
    setPathname("/versionsync");
    renderShell();
    expect(screen.getByRole("navigation")).toHaveTextContent("Version Sync");
  });

  test("follows the address into a page underneath a screen", () => {
    // /compare/142 is a saved comparison. The breadcrumb naming the dashboard
    // there would tell somebody they had left the screen they are looking at.
    setPathname("/compare/142");
    renderShell();
    expect(screen.getByRole("navigation")).toHaveTextContent("Compare & Author");
  });

  test("lights the row you are on", () => {
    setPathname("/drift");
    renderShell();
    expect(screen.getByRole("link", { name: "Drift" }).className).toContain("active");
    expect(screen.getByRole("link", { name: "Deploy" }).className).not.toContain("active");
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

  test("does not hand the rail the drawer's full-height class", () => {
    renderShell();
    expect(rail()).not.toHaveClass("h-full");
  });
});

describe("who the rail says you are", () => {
  test("takes the name, the address and the initials from the session", () => {
    renderShell();
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
    expect(screen.getByText("AD")).toBeInTheDocument();
  });

  test("falls back to the address when the session carries no name", () => {
    mockSession = { user: { email: "ada@example.com", role: "viewer" } };
    renderShell();
    // Shown twice on purpose: the address stands in for the name as well,
    // which is honest about what is known rather than leaving a blank line.
    expect(screen.getAllByText("ada@example.com")).toHaveLength(2);
    expect(screen.getByText("AD")).toBeInTheDocument();
  });

  test("says plainly when nobody is signed in", () => {
    mockSession = null;
    renderShell();
    expect(screen.getByText("Guest")).toBeInTheDocument();
    expect(screen.getByText("Not signed in")).toBeInTheDocument();
    expect(screen.getByText("?")).toBeInTheDocument();
  });

  test("still calls a session with neither name nor address signed in", () => {
    // A session this thin should not be possible, but rendering an empty name
    // beside an empty address would look like the app had lost track of you.
    mockSession = { user: { role: "viewer" } };
    renderShell();
    expect(screen.getByText("Signed in")).toBeInTheDocument();
    expect(screen.getByText("SI")).toBeInTheDocument();
  });

  test("lets a caller name the user itself, over the session", () => {
    renderShell({ user: { name: "Release bot", email: "bot@example.com", initials: "RB" } });
    expect(screen.getByText("Release bot")).toBeInTheDocument();
    expect(screen.queryByText("Ada Lovelace")).toBeNull();
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
    mockSession = { user: { name: "Ada Lovelace", email: "ada@example.com", role: "editor" } };
    renderShell();
    expect(screen.queryByRole("link", { name: "Admin" })).toBeNull();
    expect(screen.getByRole("link", { name: "Connections" })).toBeInTheDocument();
  });
});

describe("signing out", () => {
  test("asks next-auth to end the session and says where to land", () => {
    renderShell();
    fireEvent.click(button("Sign out"));
    expect(mockSignOutCalls).toEqual([{ callbackUrl: "/login" }]);
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

  test("hands that rail the full height it needs inside the drawer", () => {
    setViewport(true);
    renderShell();
    fireEvent.click(button("Open navigation"));
    expect(rail()).toHaveClass("h-full");
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
