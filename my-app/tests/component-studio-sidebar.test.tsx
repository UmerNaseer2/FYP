/** @jest-environment jsdom */

/**
 * The rail down the left of every studio screen (the Atelier design).
 *
 * It is presentational: it holds no state, fetches nothing, and every decision
 * it makes arrives as a prop. But it is on screen on every page, and two of its
 * decisions have gone wrong before, so most of this file is about them.
 *
 * The first is what "collapsed" means. Hiding the words with `hidden` is
 * display:none, which takes them out of the accessibility tree as well as out
 * of the layout, and a collapsed rail then handed a screen reader a column of
 * unnamed icons. `sr-only` costs the same room and keeps the text, so the tests
 * below read the rail by accessible name and expect every row to still answer
 * in the narrow state.
 *
 * The second is that a collapsed rail has to keep a way out of itself. The
 * mark at the top becomes the expand button, because a right-aligned chevron
 * would be clipped off a 64px column and leave nothing to click.
 *
 * What is NOT here:
 *  - Who you are, the theme switch and signing out. In this design they live
 *    in the top bar's account menu: tests/component-account-menu.test.tsx and
 *    tests/component-studio-shell.test.tsx.
 *  - Who decides `collapsed`, `activeHref`, `bypass`, `viewAs` or
 *    `orgSwitcher`. All of them are the shell's.
 *  - The real list of screens and which rows a role may see:
 *    tests/studio-nav.test.ts and the shell's suite.
 *  - What any of it looks like. jsdom applies no stylesheet, so what is
 *    asserted is the class the component asks for.
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";

import { StudioSidebar } from "@/components/studio/StudioSidebar";
import type { NavItem } from "@/components/studio/nav";
import { APP_VERSION } from "@/lib/app-version";

// A cut-down rail. The icons are stand-ins: what matters is that whatever the
// caller hands over for a row is what gets drawn in it. One row is given a
// label that is not its screen name, and it is the label the rail shows.
const ITEMS: NavItem[] = [
  {
    screen: "Dashboard",
    label: "Dashboard",
    href: "/studio",
    icon: <span data-testid="icon-dashboard" />,
    feature: "dashboard",
  },
  {
    screen: "Drift",
    label: "Drift watch",
    href: "/drift",
    icon: <span data-testid="icon-drift" />,
    feature: "drift",
  },
  {
    screen: "Admin",
    label: "Admin",
    href: "/admin",
    icon: <span data-testid="icon-admin" />,
    feature: ["users", "roles"],
  },
];

const onToggleCollapse = jest.fn();

beforeEach(() => {
  onToggleCollapse.mockClear();
});

type Overrides = Partial<Parameters<typeof StudioSidebar>[0]>;

function renderRail(over: Overrides = {}) {
  return render(
    <StudioSidebar
      items={ITEMS}
      activeHref="/drift"
      collapsed={false}
      onToggleCollapse={onToggleCollapse}
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
    expect(screen.getByText(`v${APP_VERSION}`)).toBeInTheDocument();
  });

  test("draws the mark the logo reveal flies to", () => {
    renderRail();
    expect(rail().querySelectorAll("[data-intro-target]")).toHaveLength(1);
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
    // The highlight is only colour, so it is said out loud as well.
    expect(link("Drift watch")).toHaveAttribute("aria-current", "page");
    expect(link("Dashboard")).not.toHaveAttribute("aria-current");
  });

  test("marks nothing when the page you are on has no row", () => {
    renderRail({ activeHref: "/schemas/12" });
    for (const row of screen.getAllByRole("link")) {
      expect(row.className).not.toContain("active");
      expect(row).not.toHaveAttribute("aria-current");
    }
  });

  test("names the list of pages for a screen reader", () => {
    renderRail();
    expect(screen.getByRole("navigation", { name: "Pages" })).toBeInTheDocument();
  });
});

describe("the rail when it is collapsed", () => {
  test("turns the mark into the way back out", () => {
    renderRail({ collapsed: true });
    expect(button("Expand sidebar")).toHaveAttribute("title", "Expand");
    expect(screen.queryByRole("button", { name: "Collapse sidebar" })).toBeNull();
    // The reveal still has somewhere to land.
    expect(button("Expand sidebar").querySelector("[data-intro-target]")).not.toBeNull();
  });

  test("drops the product name and version, which have no room", () => {
    renderRail({ collapsed: true });
    expect(screen.queryByText("Schema Studio")).toBeNull();
    expect(screen.queryByText(`v${APP_VERSION}`)).toBeNull();
  });

  test("still says what every row is", () => {
    renderRail({ collapsed: true });
    expect(link("Dashboard")).toBeInTheDocument();
    expect(link("Drift watch")).toBeInTheDocument();
    expect(link("Admin")).toBeInTheDocument();
  });

  test("keeps each row's words in the page instead of removing them", () => {
    renderRail({ collapsed: true });
    expect(screen.getByText("Drift watch", { selector: "span" })).toHaveClass("sr-only");
  });

  test("asks for the folded look", () => {
    renderRail({ collapsed: true });
    expect(rail().firstElementChild).toHaveClass("side", "side-folded");
  });
});

describe("the sign-in bypass warning", () => {
  test("says nothing when the bypass is off", () => {
    renderRail();
    expect(screen.queryByText("auth off")).not.toBeInTheDocument();
  });

  test("says out loud when authentication is switched off", () => {
    renderRail({ bypass: true });
    const pill = screen.getByText("auth off").parentElement!;
    expect(pill).toHaveAttribute("title", expect.stringContaining("NEXT_PUBLIC_AUTH_BYPASS"));
  });

  test("keeps it readable in the narrow rail", () => {
    renderRail({ bypass: true, collapsed: true });
    expect(screen.getByText("auth off")).toHaveClass("sr-only");
  });
});

describe('the "View as" slot', () => {
  test("draws whatever it was handed", () => {
    renderRail({ viewAs: <p>the switcher</p> });
    expect(screen.getByText("the switcher")).toBeInTheDocument();
  });

  test("leaves it off the narrow rail, which has no room for a picker", () => {
    renderRail({ viewAs: <p>the switcher</p>, collapsed: true });
    expect(screen.queryByText("the switcher")).toBeNull();
  });
});

describe("the organization slot", () => {
  test("draws whatever it was handed, at the foot of the rail", () => {
    renderRail({ orgSwitcher: <p>the organizations</p> });
    const picker = screen.getByText("the organizations");
    expect(picker.closest(".side-foot")).not.toBeNull();
  });

  test("leaves it off the narrow rail, which has no room for a picker", () => {
    renderRail({ orgSwitcher: <p>the organizations</p>, collapsed: true });
    expect(screen.queryByText("the organizations")).toBeNull();
  });

  // The picker draws nothing when there is nothing to pick. Its box stays in
  // the page, and the class is what lets a browser drop it, gap and all.
  test("puts a picker that draws nothing in a box that hides itself", () => {
    function NothingToPick() {
      return null;
    }
    renderRail({ orgSwitcher: <NothingToPick /> });
    const box = rail().querySelector(".side-foot")!.firstElementChild!;
    expect(box).toHaveClass("empty:hidden");
    expect(box).toBeEmptyDOMElement();
  });

  test("draws no box at all when handed no picker", () => {
    renderRail();
    expect(rail().querySelector(".side-foot")).toBeEmptyDOMElement();
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
    // The phone drawer passes side-in-drawer so the rail fills it edge to edge.
    renderRail({ className: "side-in-drawer" });
    expect(rail()).toHaveClass("side-wrap", "side-in-drawer");
  });

  test("stands on its own when nobody passes any", () => {
    renderRail();
    expect(rail().className.trim()).toBe("side-wrap");
  });
});

describe("the number beside a row", () => {
  const withNumber = (badge: number | undefined): NavItem[] =>
    ITEMS.map((item) => (item.href === "/drift" ? { ...item, badge } : item));
  const badge = () => document.querySelector(".nav-item .badge") as HTMLElement | null;

  test("shows the number, and tells a screen reader what it counts", () => {
    renderRail({ items: withNumber(3) });
    expect(screen.getByRole("link", { name: /^Drift watch\s*3 waiting$/ })).toBeInTheDocument();
    expect(screen.getByText("3")).not.toHaveClass("sr-only");
  });

  test.each([
    ["none", 0],
    ["no answer yet", undefined],
  ])("shows nothing for %s", (_name, count) => {
    renderRail({ items: withNumber(count) });
    expect(badge()).toBeNull();
    expect(rail()).not.toHaveTextContent("waiting");
  });

  test("folds down to a dot, with the number still there for a screen reader", () => {
    renderRail({ items: withNumber(12), collapsed: true });
    expect(badge()).toHaveClass("badge-dot");
    expect(screen.getByText("12")).toHaveClass("sr-only");
    expect(badge()).toHaveTextContent("12 waiting");
  });

  test("stays on the row it belongs to", () => {
    renderRail({ items: withNumber(3) });
    expect(document.querySelectorAll(".nav-item .badge")).toHaveLength(1);
    expect(link("Dashboard")).not.toHaveTextContent("3");
  });
});
