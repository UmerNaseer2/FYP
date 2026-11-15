/** @jest-environment jsdom */

/**
 * The public front page at "/".
 *
 * Anyone can open it, signed in or not, so it makes three promises to someone
 * who has never seen Schema Studio: where its two buttons go, what the product
 * does, and how the passwords of their databases are kept. The tests below
 * read the page by role and name, the way a screen reader would, and hold it
 * to each promise.
 *
 * What is NOT here:
 *  - Which hrefs a server hands the page (the sign-in page, or the studio on a
 *    demo server): tests/page-root.test.ts.
 *  - That "/" opens without a session: tests/proxy.test.ts.
 *  - The layout, the background grid and the colors of each theme. All of it
 *    is CSS, and jsdom applies no stylesheet.
 */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { LandingPage, type LandingPageProps } from "@/components/landing/LandingPage";

const SIGN_IN: LandingPageProps = {
  createAccountHref: "/login?callbackUrl=/onboarding",
  logInHref: "/login",
  encryptsPasswords: true,
};

beforeEach(() => {
  // The root layout starts every page dark, and the saved choice is the
  // theme hook's to apply after mount.
  document.documentElement.setAttribute("data-theme", "dark");
  localStorage.clear();
});

/** Every link on the page as [what it says, where it goes]. */
function links(): [string | null, string | null][] {
  return screen.getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")]);
}

describe("LandingPage", () => {
  it("offers the shared trial as Try it now, only when the server has it", () => {
    const { rerender } = render(<LandingPage {...SIGN_IN} />);
    expect(screen.queryByRole("button", { name: /^Try/ })).toBeNull();
    expect(screen.queryByText(/shared trial/)).toBeNull();
    rerender(<LandingPage {...SIGN_IN} trialAction="/api/trial" />);
    // One button. It asks which role first; before the page's script runs it
    // posts on its own, as the Trial Admin.
    const button = screen.getByRole("button", { name: /^Try/ });
    expect(button).toHaveAccessibleName("Try it now, no account needed");
    expect(button).toHaveTextContent("Try it now");
    expect(button).toHaveTextContent("No account needed");
    expect(button).toHaveAttribute("name", "role");
    expect(button).toHaveAttribute("value", "admin");
    expect(button).toHaveAttribute("aria-haspopup", "dialog");
    expect(button.closest("form")).toHaveAttribute("action", "/api/trial");
    expect(button.closest("form")).toHaveAttribute("method", "post");
    expect(
      screen.getByText(
        "Try it now opens a shared trial with example data. Pick Admin, Editor or Viewer, and switch any time."
      )
    ).toBeInTheDocument();
    // Create account and Log in stay, next to it.
    expect(links()).toEqual([
      ["Create account", "/login?callbackUrl=/onboarding"],
      ["Log in", "/login"],
    ]);
  });

  it("asks which role first, and each choice signs in as that trial account", () => {
    render(<LandingPage {...SIGN_IN} trialAction="/api/trial" />);
    expect(screen.queryByRole("dialog")).toBeNull();
    const button = screen.getByRole("button", { name: "Try it now, no account needed" });
    // The click opens the picker instead of posting.
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => {
      button.dispatchEvent(click);
    });
    expect(click.defaultPrevented).toBe(true);
    const dialog = screen.getByRole("dialog", { name: "Choose a role to try" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(dialog).toHaveTextContent(/switch role any time from the account menu/i);
    const cards = within(dialog).getAllByRole("button", { name: /^Try as/ });
    expect(cards.map((c) => [c.getAttribute("aria-label"), c.getAttribute("name"), c.getAttribute("value")])).toEqual([
      ["Try as Trial Admin", "role", "admin"],
      ["Try as Trial Editor", "role", "editor"],
      ["Try as Trial Viewer", "role", "viewer"],
    ]);
    for (const card of cards) {
      expect(card).toHaveAttribute("type", "submit");
      expect(card.closest("form")).toHaveAttribute("action", "/api/trial");
      expect(card.closest("form")).toHaveAttribute("method", "post");
    }
    // Each card says what that role can do.
    expect(cards[2]).toHaveAccessibleDescription(/except Admin/);
  });

  it("closes the picker with Escape, the close button or a press outside it", () => {
    render(<LandingPage {...SIGN_IN} trialAction="/api/trial" />);
    const button = screen.getByRole("button", { name: "Try it now, no account needed" });
    fireEvent.click(button);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(button);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(button);
    fireEvent.mouseDown(screen.getByRole("dialog").parentElement as HTMLElement);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(button).toHaveAttribute("aria-expanded", "false");
  });

  it("signs in once, however many times a card is pressed", () => {
    render(<LandingPage {...SIGN_IN} trialAction="/api/trial" />);
    fireEvent.click(screen.getByRole("button", { name: "Try it now, no account needed" }));
    const editor = screen.getByRole("button", { name: "Try as Trial Editor" });
    const first = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => {
      editor.dispatchEvent(first);
    });
    expect(first.defaultPrevented).toBe(false);
    expect(editor).toHaveAttribute("aria-busy", "true");
    expect(editor).toHaveTextContent("Opening the trial…");
    const second = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => {
      screen.getByRole("button", { name: "Try as Trial Viewer" }).dispatchEvent(second);
    });
    expect(second.defaultPrevented).toBe(true);
  });

  it("never says the trial resets by itself, and names no environments", () => {
    render(<LandingPage {...SIGN_IN} trialAction="/api/trial" />);
    expect(document.body).not.toHaveTextContent(/every night|nightly|resets? (every|each|at)/i);
    expect(document.body).not.toHaveTextContent(/\b(dev|staging|prod|production)\b/i);
  });

  it("offers exactly two ways in", () => {
    // The name in the header is deliberately not a link: on the front page it
    // would only lead back here.
    render(<LandingPage {...SIGN_IN} />);
    expect(links()).toEqual([
      ["Create account", "/login?callbackUrl=/onboarding"],
      ["Log in", "/login"],
    ]);
  });

  it("tells a new visitor that signing in is what creates the account", () => {
    // Both buttons go to the same sign-in page, so without this line "Create
    // account" would look like a mistake.
    render(<LandingPage {...SIGN_IN} />);
    expect(screen.getByText("New here? Your account is created the first time you sign in.")).toBeInTheDocument();
    expect(screen.queryByText(/demo server/)).toBeNull();
  });

  it("says why both buttons open the studio on a demo server", () => {
    render(<LandingPage createAccountHref="/studio" logInHref="/studio" encryptsPasswords demo />);
    expect(
      screen.getByText("This is a demo server with sign-in switched off, so both buttons open the studio.")
    ).toBeInTheDocument();
    expect(links().map(([, href]) => href)).toEqual(["/studio", "/studio"]);
    expect(screen.queryByText(/created the first time/)).toBeNull();
  });

  it("says what the product is for and lists six features", () => {
    render(<LandingPage {...SIGN_IN} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Catch the schema changes nobody shipped."
    );
    const features = within(screen.getByRole("region", { name: "What it does" }));
    expect(features.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual([
      "Compare your databases",
      "Scheduled drift checks",
      "Deploy and roll back",
      "Roles and permissions",
      "Schema diagrams",
      "Desktop app and phone approvals",
    ]);
  });

  it("says that roles decide who may run, and that anyone else asks for approval", () => {
    render(<LandingPage {...SIGN_IN} />);
    const features = screen.getByRole("region", { name: "What it does" });
    expect(features).toHaveTextContent("Someone whose role may not run it asks for approval of that exact run.");
    expect(screen.getByText("A run your role does not allow waits for an Admin.")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/second person/);
  });

  it("labels the made-up schema in the hero as an example, with one change and the approval rule", () => {
    // Nobody should read it as the state of a real database.
    render(<LandingPage {...SIGN_IN} />);
    const example = within(screen.getByRole("figure", { name: "Example: a schema that has drifted" }));
    expect(example.getByText("Example")).toBeInTheDocument();
    expect(example.getByText("Drifted")).toBeInTheDocument();
    expect(example.getByText("Changed by hand, outside a deploy")).toBeInTheDocument();
    expect(example.getByText("A run your role does not allow waits for an Admin.")).toBeInTheDocument();
    expect(example.queryByText(/approval needed|In sync|Outdated/)).toBeNull();
  });

  it("walks through the five steps the app's menu uses", () => {
    render(<LandingPage {...SIGN_IN} />);
    const how = within(screen.getByRole("region", { name: "How it works" }));
    expect(how.getAllByRole("listitem").map((item) => item.querySelector("b")?.textContent)).toEqual([
      "Connect",
      "Compare",
      "Script",
      "Ship",
      "Watch",
    ]);
  });

  it("says how passwords are stored, and does not claim encryption the server lacks", () => {
    const { rerender } = render(<LandingPage {...SIGN_IN} />);
    const storage = () => screen.getByRole("region", { name: "What gets stored" });
    expect(storage()).toHaveTextContent("each password encrypted using AES-256-GCM");
    expect(storage()).toHaveTextContent("Deleting a connection deletes its password too.");

    rerender(<LandingPage {...SIGN_IN} encryptsPasswords={false} />);
    expect(storage()).toHaveTextContent(
      "This server has no encryption key set, so their passwords are stored as typed."
    );
    expect(storage()).not.toHaveTextContent("AES-256-GCM");
    expect(storage()).toHaveTextContent("Deleting a connection deletes its password too.");
  });

  it("switches between light and dark and remembers the choice", () => {
    render(<LandingPage {...SIGN_IN} />);
    fireEvent.click(screen.getByRole("button", { name: "Light mode" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    // The sign-in page reads the same saved choice, so pressing "Log in" does
    // not flip the visitor back to dark.
    expect(localStorage.getItem("ss-theme")).toBe("light");
    expect(screen.getByRole("button", { name: "Dark mode" })).toBeInTheDocument();
  });

  it("opens in the theme picked earlier on the sign-in page", () => {
    localStorage.setItem("ss-theme", "light");
    render(<LandingPage {...SIGN_IN} />);
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(screen.getByRole("button", { name: "Dark mode" })).toBeInTheDocument();
  });
});
