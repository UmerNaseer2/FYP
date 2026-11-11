/** @jest-environment jsdom */

/**
 * The three shared help pieces: the Help panel and its button, the small "?"
 * note, and the shared page header.
 *
 * The text itself is checked in tests/help-topics.test.ts.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { HelpButton, HelpProvider } from "@/components/help/HelpPanel";
import { PageHeader } from "@/components/studio/PageHeader";
import { HelpHint } from "@/components/ui/HelpHint";
import { BLURB_MAX_WORDS, HELP_TOPICS } from "@/lib/help";

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
    expect(panel.textContent).toContain(HELP_TOPICS["/deploy"].steps[0]);
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

  test("a tab can give its own title and line, and extra buttons", () => {
    render(<PageHeader page="/performance" title="Slow queries" blurb="The slowest statements." actions={<button>Refresh</button>} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Slow queries");
    expect(screen.getByText("The slowest statements.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
  });

  test("inside the studio it carries a Help button that opens the panel", () => {
    render(
      <HelpProvider>
        <PageHeader page="/deploy" />
      </HelpProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    expect(screen.getByRole("dialog", { name: "Help: Deploy" })).toBeTruthy();
  });

  test("on its own (a page test) it has no Help button", () => {
    render(<PageHeader page="/deploy" />);
    expect(screen.queryByRole("button", { name: "Help" })).toBeNull();
  });
});
