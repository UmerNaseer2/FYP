/** @jest-environment jsdom */

/**
 * The command bar (Ctrl K): type where you want to go or what you want to do.
 *
 * What is NOT here:
 *  - Which pages a role may open. The shell hands over the same list the rail
 *    shows: tests/component-studio-shell.test.tsx.
 *  - The shortcut that opens it, which the top bar owns.
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, within } from "@testing-library/react";

const mockPush = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

import { CommandBar, scoreMatch } from "@/components/studio/CommandBar";
import type { NavItem } from "@/components/studio/nav";
import { OPEN_ASK_AI_EVENT } from "@/lib/studio-events";
import { REPLAY_INTRO_EVENT } from "@/lib/intro";

const PAGES: NavItem[] = [
  { screen: "Dashboard", label: "Dashboard", href: "/acme/studio", icon: null },
  { screen: "Compare", label: "Compare & Author", href: "/acme/compare", icon: null },
  { screen: "Version Sync", label: "Version Sync", href: "/acme/versionsync", icon: null },
  { screen: "Deploy", label: "Deploy", href: "/acme/deploy", icon: null },
];

const onClose = jest.fn();
const onToggleTheme = jest.fn();
const onSignOut = jest.fn();
const onHelp = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
});

type Props = Partial<Parameters<typeof CommandBar>[0]>;

function renderBar(over: Props = {}) {
  return render(
    <CommandBar
      open
      onClose={onClose}
      pages={PAGES}
      activeHref="/acme/studio"
      waiting={0}
      theme="dark"
      onToggleTheme={onToggleTheme}
      onSignOut={onSignOut}
      {...over}
    />
  );
}

const box = () => screen.getByRole("combobox", { name: "Search pages and actions" });
const type = (text: string) => fireEvent.change(box(), { target: { value: text } });
const press = (key: string) => fireEvent.keyDown(box(), { key });
const options = () => screen.queryAllByRole("option").map((o) => o.querySelector("b")!.textContent);
const lit = () => screen.getAllByRole("option").find((o) => o.getAttribute("aria-selected") === "true");
const group = (name: string) => screen.queryByRole("group", { name });

describe("scoreMatch", () => {
  test("matches everything when nothing is typed", () => {
    expect(scoreMatch("", "Deploy")).toEqual([0, null]);
  });

  test("ranks the start of the text over the start of a word over the middle of one", () => {
    const start = scoreMatch("ver", "Version Sync")![0];
    const word = scoreMatch("syn", "Version Sync")![0];
    const middle = scoreMatch("rsi", "Version Sync")![0];
    expect(start).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(middle);
  });

  test("underlines the letters it matched", () => {
    expect(scoreMatch("sync", "Version Sync")![1]).toEqual([8, 12]);
  });

  test("finds letters in order, scattered through the text, without underlining", () => {
    const scattered = scoreMatch("vsy", "Version Sync");
    expect(scattered).not.toBeNull();
    expect(scattered![1]).toBeNull();
    expect(scattered![0]).toBeLessThan(scoreMatch("rsi", "Version Sync")![0]);
  });

  test("ignores case", () => {
    expect(scoreMatch("DEP", "deploy")).not.toBeNull();
  });

  test("does not match letters that are out of order, or a lone stray letter", () => {
    expect(scoreMatch("ysv", "Version Sync")).toBeNull();
    expect(scoreMatch("z", "Deploy")).toBeNull();
  });
});

describe("opening it", () => {
  test("draws nothing while it is shut", () => {
    renderBar({ open: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("opens as a dialog that says what it is for", () => {
    renderBar();
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Go to a page or run an action");
  });

  test("lists every page, then the actions, with nothing typed", () => {
    renderBar();
    expect(group("Pages")).toBeInTheDocument();
    expect(group("Actions")).toBeInTheDocument();
    expect(options().slice(0, 4)).toEqual(["Dashboard", "Compare & Author", "Version Sync", "Deploy"]);
    expect(options()).toEqual(expect.arrayContaining(["Replay intro", "Sign out"]));
  });

  test("marks the page you are on", () => {
    renderBar();
    const here = screen.getAllByRole("option")[0];
    expect(here).toHaveTextContent("You are here");
  });

  test("puts requests waiting on you first", () => {
    renderBar({ waiting: 2, requestsHref: "/acme/requests" });
    expect(options()[0]).toBe("2 requests are waiting on you");
    expect(group("Needs you")).toBeInTheDocument();
  });

  test("says one request in the singular", () => {
    renderBar({ waiting: 1, requestsHref: "/acme/requests" });
    expect(options()[0]).toBe("1 request is waiting on you");
  });

  test("leaves the waiting row out when nothing waits", () => {
    renderBar({ waiting: 0, requestsHref: "/acme/requests" });
    expect(group("Needs you")).toBeNull();
  });
});

describe("searching", () => {
  test("narrows the list to what matches", () => {
    renderBar();
    type("dep");
    expect(options()).toEqual(["Deploy"]);
    expect(screen.getByRole("status")).toHaveTextContent("1 result");
  });

  test("underlines the matched letters", () => {
    renderBar();
    type("sync");
    const mark = screen.getAllByRole("option")[0].querySelector("mark");
    expect(mark).toHaveTextContent("Sync");
  });

  test("finds a page by a word it answers to", () => {
    renderBar();
    type("diff");
    expect(options()).toEqual(["Compare & Author"]);
  });

  test("puts pages before actions", () => {
    renderBar();
    // "s" alone is too short to scatter, so only labels holding an "s" match.
    type("si");
    const found = options();
    expect(found.indexOf("Version Sync")).toBeLessThan(found.indexOf("Sign out"));
  });

  test("says so plainly when nothing matches", () => {
    renderBar();
    type("qqqq");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText(/Nothing matches/)).toHaveTextContent("Nothing matches “qqqq”");
    expect(screen.getByRole("status")).toHaveTextContent("0 results");
  });

  test('">" first shows only actions', () => {
    renderBar();
    type(">");
    expect(group("Pages")).toBeNull();
    expect(options()).toContain("Sign out");
    type(">intro");
    expect(options()).toEqual(["Replay intro"]);
    expect(screen.getByRole("button", { name: "Actions" })).toHaveAttribute("aria-pressed", "true");
  });

  test("the Pages and Actions buttons narrow it the same way", () => {
    renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Pages" }));
    expect(group("Actions")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(group("Pages")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Everything" }));
    expect(group("Pages")).toBeInTheDocument();
    expect(group("Actions")).toBeInTheDocument();
  });
});

describe("the keyboard", () => {
  test("lights the first row, and Down and Up move it and wrap", () => {
    renderBar();
    expect(lit()).toHaveTextContent("Dashboard");
    press("ArrowDown");
    expect(lit()).toHaveTextContent("Compare & Author");
    press("ArrowUp");
    press("ArrowUp");
    expect(lit()).toHaveTextContent("Sign out");
  });

  test("tells a screen reader which row is lit", () => {
    renderBar();
    press("ArrowDown");
    expect(box()).toHaveAttribute("aria-activedescendant", lit()!.id);
  });

  test("End and Home jump to the ends while nothing is typed", () => {
    renderBar();
    press("End");
    expect(lit()).toHaveTextContent("Sign out");
    press("Home");
    expect(lit()).toHaveTextContent("Dashboard");
  });

  test("Enter opens the lit page and shuts the bar", () => {
    renderBar();
    type("deploy");
    press("Enter");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith("/acme/deploy");
  });

  test("Escape shuts it", () => {
    renderBar();
    press("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockPush).not.toHaveBeenCalled();
  });
});

describe("the actions", () => {
  test("switches the theme, and names the theme you would get", () => {
    renderBar({ theme: "light" });
    expect(options()).toContain("Switch to the dark theme");
    fireEvent.click(screen.getByRole("option", { name: /Switch to the dark theme/ }));
    expect(onToggleTheme).toHaveBeenCalledTimes(1);
  });

  test("signs out", () => {
    renderBar();
    fireEvent.click(screen.getByRole("option", { name: /Sign out/ }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  test("replays the intro", () => {
    const heard = jest.fn();
    window.addEventListener(REPLAY_INTRO_EVENT, heard);
    try {
      renderBar();
      fireEvent.click(screen.getByRole("option", { name: /Replay intro/ }));
      expect(heard).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(REPLAY_INTRO_EVENT, heard);
    }
  });

  test("offers Help only where the page has some", () => {
    renderBar();
    expect(options()).not.toContain("Help for this page");
  });

  test("opens Help where there is some", () => {
    renderBar({ onHelp });
    fireEvent.click(screen.getByRole("option", { name: /Help for this page/ }));
    expect(onHelp).toHaveBeenCalledTimes(1);
  });

  test("hides Ask AI while it is switched off for you", () => {
    renderBar();
    type("ai");
    expect(options()).not.toContain("Ask AI about your schema");
  });

  test("opens the schema chat when Ask AI is on", () => {
    const heard = jest.fn();
    window.addEventListener(OPEN_ASK_AI_EVENT, heard);
    try {
      renderBar({ askAi: true });
      fireEvent.click(screen.getByRole("option", { name: /Ask AI about your schema/ }));
      expect(heard).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(OPEN_ASK_AI_EVENT, heard);
    }
  });
});

describe("what you picked last", () => {
  test("comes back under Recent next time, newest first", () => {
    const first = renderBar();
    fireEvent.click(screen.getByRole("option", { name: /Deploy/ }));
    first.unmount();

    const second = renderBar();
    fireEvent.click(screen.getByRole("option", { name: /Version Sync/ }));
    second.unmount();

    renderBar();
    const recent = group("Recent")!;
    expect(within(recent).getAllByRole("option").map((o) => o.querySelector("b")!.textContent)).toEqual([
      "Version Sync",
      "Deploy",
    ]);
    // Shown once, under Recent, not again under Pages.
    expect(options().filter((o) => o === "Deploy")).toHaveLength(1);
  });

  test("keeps three at most", () => {
    for (const name of [/Dashboard/, /Compare/, /Version Sync/, /Deploy/]) {
      const bar = renderBar();
      fireEvent.click(screen.getByRole("option", { name }));
      bar.unmount();
    }
    renderBar();
    expect(within(group("Recent")!).getAllByRole("option")).toHaveLength(3);
  });

  test("shrugs off a broken saved list", () => {
    localStorage.setItem("schema-studio:recent-commands", "not json");
    renderBar();
    expect(group("Recent")).toBeNull();
    expect(options()[0]).toBe("Dashboard");
  });
});
