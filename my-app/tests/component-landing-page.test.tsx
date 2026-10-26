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
import { fireEvent, render, screen, within } from "@testing-library/react";
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
      "Keep dev, staging and prod from drifting apart."
    );
    const features = within(screen.getByRole("region", { name: "What it does" }));
    expect(features.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual([
      "Compare across environments",
      "Scheduled drift checks",
      "Deploy and roll back",
      "Roles and permissions",
      "Schema diagrams",
      "Desktop app and phone approvals",
    ]);
  });

  it("calls the second approver a default, since an organization can switch it off", () => {
    render(<LandingPage {...SIGN_IN} />);
    const features = screen.getByRole("region", { name: "What it does" });
    expect(features).toHaveTextContent("By default, production deploys wait for a second person");
    expect(screen.getByText("Production deploys wait for a second person by default.")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/with a second person signing off/);
  });

  it("labels the made-up schema in the hero as an example", () => {
    // It shows drift and a waiting deploy, and nobody should read it as the
    // state of a real database.
    render(<LandingPage {...SIGN_IN} />);
    const example = within(screen.getByRole("figure", { name: "Example: one schema in three environments" }));
    expect(example.getByText("Example")).toBeInTheDocument();
    for (const status of ["In sync", "Drifted", "Outdated"]) {
      expect(example.getByText(status)).toBeInTheDocument();
    }
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
