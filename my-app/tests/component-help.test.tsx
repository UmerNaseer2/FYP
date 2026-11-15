/** @jest-environment jsdom */

/**
 * The shared help pieces: the Help panel, its button and its Show me links,
 * the small "?" note, the shared page header and the page's section tabs.
 *
 * The text itself is checked in tests/help-topics.test.ts.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { HelpButton, HelpProvider } from "@/components/help/HelpPanel";
import { PageHeader } from "@/components/studio/PageHeader";
import { PageTabs } from "@/components/studio/PillTabs";
import { HelpHint } from "@/components/ui/HelpHint";
import { BLURB_MAX_WORDS, HELP_TOPICS, stepText } from "@/lib/help";

let mockPathname = "/acme/deploy";
jest.mock("next/navigation", () => ({ usePathname: () => mockPathname }));

beforeEach(() => {
  mockPathname = "/acme/deploy";
});

describe("Help panel", () => {
  test("the button opens the help for the page you are on", () => {
    render(
      <HelpProvider>
        <HelpButton />
      </HelpProvider>
    );
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Help" }));

    const panel = screen.getByRole("dialog", { name: "Help: Deploy" });
    expect(panel.textContent).toContain("What this page is for");
    expect(panel.textContent).toContain(stepText(HELP_TOPICS["/deploy"].steps[0]));
    expect(panel.textContent).toContain(HELP_TOPICS["/deploy"].problems[0].problem);
  });

  test("it follows the page: on Drift it shows Drift's help", () => {
    mockPathname = "/acme/drift";
    render(
      <HelpProvider>
        <HelpButton />
      </HelpProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    expect(screen.getByRole("dialog", { name: "Help: Drift" })).toBeTruthy();
  });

  test("Close and Escape both shut it", () => {
    render(
      <HelpProvider>
        <HelpButton />
      </HelpProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("with no panel around it, the button draws nothing", () => {
    const { container } = render(<HelpButton />);
    expect(container.innerHTML).toBe("");
  });
});

/** jsdom lays nothing out, so give an element a size: that is what "on the page" means. */
function putOnScreen(element: HTMLElement) {
  const box = { left: 100, top: 100, right: 300, bottom: 140, width: 200, height: 40, x: 100, y: 100, toJSON: () => ({}) };
  element.getBoundingClientRect = () => box as DOMRect;
  element.getClientRects = () => [box] as unknown as DOMRectList;
}

describe("Show me links in Help", () => {
  function openHelp(withTarget: boolean) {
    const view = render(
      <HelpProvider>
        <HelpButton />
        {withTarget ? <button data-tour="deploy-run">Deploy</button> : null}
      </HelpProvider>
    );
    if (withTarget) putOnScreen(screen.getByRole("button", { name: "Deploy" }));
    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    return view;
  }

  test("a step whose control is not on the page has no link", () => {
    openHelp(false);
    expect(screen.queryByRole("button", { name: /^Show me/ })).toBeNull();
  });

  test("a step whose control is on the page gets a link, and only that step", () => {
    openHelp(true);
    expect(screen.getAllByRole("button", { name: /^Show me/ })).toHaveLength(1);
  });

  test("the link closes Help and points at the control, with the step's words", () => {
    openHelp(true);
    fireEvent.click(screen.getByRole("button", { name: /^Show me/ }));

    expect(screen.queryByRole("dialog", { name: "Help: Deploy" })).toBeNull();
    const spot = screen.getByRole("dialog", { name: "Show me" });
    const step = HELP_TOPICS["/deploy"].steps.find((one) => typeof one !== "string" && one.target.includes("deploy-run"));
    expect(spot.textContent).toContain(stepText(step!));
  });

  test("Escape, Got it and a click anywhere each end it", () => {
    openHelp(true);
    fireEvent.click(screen.getByRole("button", { name: /^Show me/ }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    fireEvent.click(screen.getByRole("button", { name: /^Show me/ }));
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    fireEvent.click(screen.getByRole("button", { name: /^Show me/ }));
    fireEvent.click(document.querySelector(".tour")!);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("HelpHint", () => {
  test("the note is hidden until the ? is clicked, and a second click hides it", () => {
    render(<HelpHint label="Dry run">Runs the script and then undoes it.</HelpHint>);
    const button = screen.getByRole("button", { name: "Help: Dry run" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("note")).toBeNull();

    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const note = screen.getByRole("note");
    expect(note.textContent).toBe("Runs the script and then undoes it.");
    expect(button.getAttribute("aria-controls")).toBe(note.id);

    fireEvent.click(button);
    expect(screen.queryByRole("note")).toBeNull();
  });

  test("Escape closes the note and puts focus back on the ?", () => {
    render(<HelpHint label="Dry run">A note.</HelpHint>);
    const button = screen.getByRole("button", { name: "Help: Dry run" });
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: "Escape" });
    expect(screen.queryByRole("note")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  test("a click anywhere else closes the note", () => {
    render(
      <div>
        <HelpHint label="Dry run">A note.</HelpHint>
        <p>Somewhere else</p>
      </div>
    );
    fireEvent.click(screen.getByRole("button", { name: "Help: Dry run" }));
    fireEvent.pointerDown(screen.getByText("Somewhere else"));
    expect(screen.queryByRole("note")).toBeNull();
  });

  test("a click inside the note keeps it open", () => {
    render(<HelpHint label="Dry run">A note.</HelpHint>);
    fireEvent.click(screen.getByRole("button", { name: "Help: Dry run" }));
    fireEvent.pointerDown(screen.getByRole("note"));
    expect(screen.getByRole("note")).toBeTruthy();
  });
});

describe("PageHeader", () => {
  test("shows the page's name and its one line from the help file", () => {
    render(<PageHeader page="/deploy" />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Deploy");
    expect(screen.getByText(HELP_TOPICS["/deploy"].blurb)).toBeTruthy();
    expect(HELP_TOPICS["/deploy"].blurb.split(/\s+/).length).toBeLessThanOrEqual(BLURB_MAX_WORDS);
  });

  test("a page about one thing can show that thing's name, and extra buttons", () => {
    render(<PageHeader page="/schemas" title="students_main" blurb="12 tables." actions={<button>Refresh</button>} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("students_main");
    expect(screen.getByText("12 tables.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
  });

  test("it has no Help button of its own: the one Help button is in the top bar", () => {
    render(
      <HelpProvider>
        <PageHeader page="/deploy" />
      </HelpProvider>
    );
    expect(screen.queryByRole("button", { name: "Help" })).toBeNull();
  });
});

describe("PageTabs", () => {
  const TABS = [
    { key: "users", label: "Users" },
    { key: "roles", label: "Roles", count: 2 },
    { key: "github", label: "GitHub" },
  ];

  function Sections() {
    const [tab, setTab] = useState("users");
    return <PageTabs label="Admin sections" tabs={TABS} value={tab} onChange={setTab} idPrefix="t-" panelPrefix="p-" />;
  }

  test("as buttons it is a tablist, and only the picked tab is in the Tab order", () => {
    render(<Sections />);
    expect(screen.getByRole("tablist", { name: "Admin sections" })).toBeTruthy();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
    expect(tabs[1].id).toBe("t-roles");
    expect(tabs[1].getAttribute("aria-controls")).toBe("p-roles");
    expect(tabs[1].textContent).toBe("Roles2");
  });

  test("a click picks a tab, and the arrow keys, Home and End move along the row", () => {
    render(<Sections />);
    const picked = () => screen.getByRole("tab", { selected: true });

    fireEvent.click(screen.getByRole("tab", { name: "GitHub" }));
    expect(picked().textContent).toBe("GitHub");

    picked().focus();
    fireEvent.keyDown(picked(), { key: "ArrowRight" });
    expect(picked().textContent).toBe("Users");
    expect(document.activeElement).toBe(picked());

    fireEvent.keyDown(picked(), { key: "ArrowLeft" });
    expect(picked().textContent).toBe("GitHub");
    fireEvent.keyDown(picked(), { key: "Home" });
    expect(picked().textContent).toBe("Users");
    fireEvent.keyDown(picked(), { key: "End" });
    expect(picked().textContent).toBe("GitHub");
  });

  test("as links it is a nav, and the open one is marked", () => {
    const links = [
      { key: "detail", label: "Drift detail", href: "/acme/drift?tab=detail" },
      { key: "audit", label: "Audit log", href: "/acme/drift?tab=audit" },
    ];
    render(<PageTabs label="Drift views" tabs={links} value="audit" />);
    expect(screen.getByRole("navigation", { name: "Drift views" })).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
    const open = screen.getByRole("link", { name: "Audit log" });
    expect(open.getAttribute("aria-current")).toBe("page");
    expect(open.getAttribute("href")).toBe("/acme/drift?tab=audit");
    expect(screen.getByRole("link", { name: "Drift detail" }).getAttribute("aria-current")).toBeNull();

    open.focus();
    fireEvent.keyDown(open, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "Drift detail" }));
  });
});
