/** @jest-environment jsdom */

/**
 * The rail down the left of every studio screen.
 *
 * It is presentational — it holds no state, fetches nothing, and every decision
 * it makes arrives as a prop — but it is on screen on every single page, and
 * two of its decisions have already gone wrong once. Both are recorded in the
 * source, and both are what most of this file is about.
 *
 * The first is what "collapsed" means. Hiding the words with `hidden` is
 * display:none, which takes them out of the accessibility tree as well as out
 * of the layout, and a collapsed rail then handed a screen reader a column of
 * unnamed icons. `sr-only` costs the same room and keeps the text, so the tests
 * below read the rail the way assistive tech does — by accessible name — and
 * expect every row to still answer in the narrow state.
 *
 * The second is that a collapsed rail has to keep a way out of itself. The
 * collapse toggle moves into the brand cell, because a right-aligned chevron
 * would be clipped off a 64px column and leave nothing to click, and Sign out
 * stays where it is, because hiding it along with the labels once removed the
 * only way to leave the app.
 *
 * What is NOT here:
 *  - Who decides `collapsed`, `theme`, `activeHref`, or what sign out actually
 *    does. All four are the shell's:
 *    tests/component-studio-shell.test.tsx.
 *  - The real list of screens and which route counts as active:
 *    tests/studio-nav.test.ts. The rows below are written out by hand so these
 *    tests keep their meaning the next time a screen is added to that file.
 *  - The drawer this rail is hosted in on a phone:
 *    tests/component-drawer.test.tsx covers bare mode from the drawer's side.
 *  - That the rail is 64px wide when collapsed, that sr-only text is invisible,
 *    or that the avatar has a gradient in it. All three are CSS and jsdom
 *    applies no stylesheet, so what is asserted is the class the component asks
 *    for, not what a browser would draw from it.
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";

import { StudioSidebar } from "@/components/studio/StudioSidebar";
import type { NavItem } from "@/components/studio/nav";

// A cut-down rail. The icons are stand-ins: what matters is that whatever the
// caller hands over for a row is what gets drawn in it. One row is given a
// label that is not its screen name — the two are allowed to differ, and it is
// the label the rail is supposed to show.
const ITEMS: NavItem[] = [
  {
    screen: "Dashboard",
    label: "Dashboard",
    href: "/studio",
    icon: <span data-testid="icon-dashboard" />,
  },
  {
    screen: "Drift",
    label: "Drift watch",
    href: "/drift",
    icon: <span data-testid="icon-drift" />,
  },
  {
    screen: "Admin",
    label: "Admin",
    href: "/admin",
    icon: <span data-testid="icon-admin" />,
    adminOnly: true,
  },
];

// Initials as the shell actually builds them: the first two letters of the
// name, upper-cased.
const USER = { name: "Ada Lovelace", email: "ada@example.com", initials: "AD" };

const onToggleCollapse = jest.fn();
const onToggleTheme = jest.fn();
const onSignOut = jest.fn();

beforeEach(() => {
  onToggleCollapse.mockClear();
  onToggleTheme.mockClear();
  onSignOut.mockClear();
});

type Overrides = Partial<Parameters<typeof StudioSidebar>[0]>;

function renderRail(over: Overrides = {}) {
  return render(
    <StudioSidebar
      items={ITEMS}
      activeHref="/drift"
      collapsed={false}
      onToggleCollapse={onToggleCollapse}
      theme="dark"
      onToggleTheme={onToggleTheme}
      user={USER}
      onSignOut={onSignOut}
      {...over}
    />
  );
}

const rail = () => screen.getByRole("complementary");
const link = (name: string) => screen.getByRole("link", { name });
const button = (name: string) => screen.getByRole("button", { name });

describe("the rail when it is open", () => {
  test("says what the app is and which build of it this is", () => {
    renderRail();
    expect(screen.getByText("Schema Studio")).toBeInTheDocument();
    expect(screen.getByText("v2.0.0")).toBeInTheDocument();
  });

  test("offers a way to collapse and no way to expand", () => {
    renderRail();
    expect(button("Collapse sidebar")).toHaveAttribute("title", "Collapse");
    expect(screen.queryByRole("button", { name: "Expand sidebar" })).toBeNull();
  });

  test("lists every screen it was handed, in the order it was handed them", () => {
    renderRail();
    expect(screen.getAllByRole("link").map((el) => el.textContent?.trim())).toEqual([
      "Dashboard",
      "Drift watch",
      "Admin",
    ]);
  });

  test("points each row at its own route", () => {
    renderRail();
    expect(link("Dashboard")).toHaveAttribute("href", "/studio");
    expect(link("Drift watch")).toHaveAttribute("href", "/drift");
    expect(link("Admin")).toHaveAttribute("href", "/admin");
  });

  test("gives each row the tooltip it will need once the words are gone", () => {
    renderRail();
    expect(link("Drift watch")).toHaveAttribute("title", "Drift watch");
    expect(link("Admin")).toHaveAttribute("title", "Admin");
  });

  test("draws the icon it was given for each row", () => {
    // The collapsed rail is nothing but these, so a row that dropped its icon
    // would be a blank line in the 64px state.
    renderRail();
    expect(screen.getByTestId("icon-dashboard")).toBeInTheDocument();
    expect(screen.getByTestId("icon-drift")).toBeInTheDocument();
    expect(screen.getByTestId("icon-admin")).toBeInTheDocument();
  });

  test("marks the screen you are on, and only that one", () => {
    renderRail();
    expect(link("Drift watch").className).toContain("active");
    expect(link("Dashboard").className).not.toContain("active");
    expect(link("Admin").className).not.toContain("active");
  });

  test("marks nothing when the page you are on has no row", () => {
    // /schemas/12 is a real screen with no rail entry. Lighting a row anyway
    // would tell somebody they are somewhere they are not.
    renderRail({ activeHref: "/schemas/12" });
    for (const row of screen.getAllByRole("link")) {
      expect(row.className).not.toContain("active");
    }
  });

  test("heads the list rather than leaving the rows loose", () => {
    renderRail();
    expect(screen.getByText("Workspace")).not.toHaveClass("sr-only");
  });
});

describe("the rail when it is collapsed", () => {
  test("turns the brand cell into the way back out", () => {
    renderRail({ collapsed: true });
    expect(button("Expand sidebar")).toHaveAttribute("title", "Expand");
    expect(screen.queryByRole("button", { name: "Collapse sidebar" })).toBeNull();
  });

  test("drops the product name and version, which have no room", () => {
    renderRail({ collapsed: true });
    expect(screen.queryByText("Schema Studio")).toBeNull();
    expect(screen.queryByText("v2.0.0")).toBeNull();
  });

  test("still says what every row is", () => {
    // The whole point of sr-only over hidden: read by accessible name, the
    // narrow rail answers exactly as the wide one does.
    renderRail({ collapsed: true });
    expect(link("Dashboard")).toBeInTheDocument();
    expect(link("Drift watch")).toBeInTheDocument();
    expect(link("Admin")).toBeInTheDocument();
  });

  test("keeps each row's words in the page instead of removing them", () => {
    renderRail({ collapsed: true });
    expect(screen.getByText("Drift watch", { selector: "span" })).toHaveClass("sr-only");
  });

  test("takes the heading out of sight the same way", () => {
    renderRail({ collapsed: true });
    expect(screen.getByText("Workspace")).toHaveClass("sr-only");
  });

  test("keeps sign out reachable", () => {
    // The regression this component records: hidden along with the labels, and
    // a collapsed rail had no way to leave the app at all.
    renderRail({ collapsed: true });
    fireEvent.click(button("Sign out"));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  test("keeps the initials as the one visible sign of who is signed in", () => {
    renderRail({ collapsed: true });
    expect(screen.getByText("AD")).not.toHaveClass("sr-only");
    expect(screen.getByText("Ada Lovelace").parentElement).toHaveClass("sr-only");
  });
});

describe("the theme switch", () => {
  test("offers the theme you would get, not the one you have", () => {
    renderRail({ theme: "dark" });
    expect(button("Switch to light theme")).toHaveAttribute("title", "Switch to light theme");
  });

  test("and the other way round", () => {
    renderRail({ theme: "light" });
    expect(button("Switch to dark theme")).toHaveAttribute("title", "Switch to dark theme");
  });

  test("says which theme is on now, in words and in a picture", () => {
    // Of the two icons only the sun is drawn with a circle in it, which is the
    // one difference between them jsdom can see without a stylesheet.
    renderRail({ theme: "dark" });
    expect(screen.getByText("Dark")).toBeInTheDocument();
    expect(screen.queryByText("Light")).toBeNull();
    expect(button("Switch to light theme").querySelector("circle")).not.toBeNull();
  });

  test("and says the other one when that is the one on", () => {
    renderRail({ theme: "light" });
    expect(screen.getByText("Light")).toBeInTheDocument();
    expect(screen.queryByText("Dark")).toBeNull();
    expect(button("Switch to dark theme").querySelector("circle")).toBeNull();
  });

  test("hands the switch back rather than making it here", () => {
    renderRail();
    fireEvent.click(button("Switch to light theme"));
    expect(onToggleTheme).toHaveBeenCalledTimes(1);
    expect(onToggleCollapse).not.toHaveBeenCalled();
  });

  test("still names itself and its setting in the narrow rail", () => {
    renderRail({ collapsed: true, theme: "light" });
    expect(button("Switch to dark theme")).toBeInTheDocument();
    expect(screen.getByText("Theme")).toHaveClass("sr-only");
    expect(screen.getByText("Light")).toHaveClass("sr-only");
  });
});

describe("who is signed in", () => {
  test("shows the name and the address that goes with it", () => {
    renderRail();
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
  });

  test("shows the initials the avatar stands in with", () => {
    // There is no photo anywhere in this app, so the initials are the avatar
    // rather than a fallback for one.
    renderRail();
    expect(screen.getByText("AD")).toBeInTheDocument();
  });

  test("hands sign out back to the shell and does nothing else", () => {
    renderRail();
    fireEvent.click(button("Sign out"));
    expect(onSignOut).toHaveBeenCalledTimes(1);
    expect(onToggleCollapse).not.toHaveBeenCalled();
    expect(onToggleTheme).not.toHaveBeenCalled();
  });
});

describe("the collapse control", () => {
  test("asks to be collapsed", () => {
    renderRail();
    fireEvent.click(button("Collapse sidebar"));
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
  });

  test("asks to be expanded", () => {
    renderRail({ collapsed: true });
    fireEvent.click(button("Expand sidebar"));
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
  });
});

describe("hosting it", () => {
  test("takes the extra classes whoever hosts it needs", () => {
    // The mobile drawer passes h-full so the rail fills the slide-over.
    renderRail({ className: "h-full" });
    expect(rail()).toHaveClass("h-full");
    expect(rail()).toHaveClass("flex");
  });

  test("stands on its own when nobody passes any", () => {
    renderRail();
    expect(rail().className.trim()).toBe("flex flex-col");
  });
});
