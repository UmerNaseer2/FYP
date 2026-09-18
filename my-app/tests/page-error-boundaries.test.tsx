/** @jest-environment jsdom */

/**
 * The four files that decide what a reader sees when something has already gone
 * wrong: the studio boundary, the outer boundary, the 404, and the last-resort
 * boundary for a failure in the root layout itself.
 *
 * They are grouped into one suite because they are one decision, made four
 * times at four depths, and because what matters about each is the same thing:
 * that it is not a dead end. Before these files existed, a thrown render handed
 * the reader Next's built-in screen — a stack trace in development and the bare
 * words "Application error: a client-side exception has occurred" in production
 * — with nothing to click in an application whose screens are only reachable
 * from a sidebar that is no longer on the page. So every test below is either
 * "there is a way out of here" or "the developer can still find out what
 * happened".
 *
 * What is NOT here:
 *  - That Next actually routes a throw to these files, or that the studio one
 *    keeps the sidebar while the outer one does not. Both are the framework's
 *    reading of where the file sits in app/, which no unit test can exercise;
 *    the placement is argued in each file's header instead.
 *  - The redaction of `error.message` in production. That is the framework's,
 *    and it is the reason `digest` is what these screens print.
 *  - EmptyState, Card, or any of the icons. Three of the four are assembled
 *    out of shared components that have their own suites.
 */

import "@testing-library/jest-dom";
import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

import StudioError from "@/app/(studio)/error";
import AppError from "@/app/error";
import NotFound from "@/app/not-found";
import GlobalError from "@/app/global-error";

// Every boundary logs the error it caught. That is deliberate — a boundary
// swallowing the error is exactly what makes these hard to chase — so the
// console has to be captured rather than left to fill the test output.
let logged: unknown[][];
let consoleError: jest.SpyInstance;

beforeEach(() => {
  logged = [];
  consoleError = jest.spyOn(console, "error").mockImplementation((...args) => {
    logged.push(args);
  });
});

afterEach(() => {
  consoleError.mockRestore();
  cleanup();
});

/** What Next hands a boundary: the error, and a way to re-render the segment. */
const boom = (digest?: string) => {
  const error = new Error("Cannot read properties of null") as Error & { digest?: string };
  if (digest) error.digest = digest;
  return error;
};

/** The boundary's own log line, with React's render warnings filtered out. */
const loggedBy = (prefix: string) =>
  logged.filter((args) => typeof args[0] === "string" && args[0].startsWith(prefix));

describe("a studio screen that stopped working", () => {
  test("says the screen broke, not the application", () => {
    // The sidebar is still on screen next to this, because the boundary sits
    // inside the (studio) group. Wording that said "the app crashed" would
    // contradict what the reader can see and click.
    render(<StudioError error={boom()} reset={jest.fn()} />);
    expect(screen.getByText("This screen stopped working")).toBeInTheDocument();
  });

  test("offers to draw it again", () => {
    const reset = jest.fn();
    render(<StudioError error={boom()} reset={reset} />);
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  test("and a way off the screen if that does not help", () => {
    render(<StudioError error={boom()} reset={jest.fn()} />);
    expect(screen.getByRole("link", { name: /Go to dashboard/ })).toHaveAttribute(
      "href",
      "/studio"
    );
  });

  test("prints the reference a developer can grep the server log for", () => {
    render(<StudioError error={boom("a1b2c3d4")} reset={jest.fn()} />);
    expect(screen.getByText(/a1b2c3d4/)).toBeInTheDocument();
  });

  test("and prints nothing where there is no reference to print", () => {
    // A client-side throw has no digest. "Reference:" followed by nothing
    // reads as a missing value rather than as an error that never had one.
    render(<StudioError error={boom()} reset={jest.fn()} />);
    expect(screen.queryByText(/Reference:/)).not.toBeInTheDocument();
  });

  test("puts the error itself in the console, where it would otherwise vanish", () => {
    const error = boom();
    render(<StudioError error={error} reset={jest.fn()} />);
    const [args] = loggedBy("Studio screen failed");
    expect(args).toBeDefined();
    // The error object, not a message built from it: the stack is the point.
    expect(args[1]).toBe(error);
  });

  test("tells the reader nothing was written, because nothing was", () => {
    // This boundary only catches rendering. Whatever the screen had already
    // sent has been sent. Saying so is the difference between a reader
    // reloading and a reader wondering whether they half-ran a migration.
    render(<StudioError error={boom()} reset={jest.fn()} />);
    expect(screen.getByText(/Nothing was\s+changed in any database/)).toBeInTheDocument();
  });
});

describe("a page outside the studio that stopped working", () => {
  test("offers the same two ways forward", () => {
    const reset = jest.fn();
    render(<AppError error={boom()} reset={reset} />);

    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    expect(reset).toHaveBeenCalledTimes(1);
    // There is no sidebar around this one — sign-in and the root redirect are
    // what reach it — so the link into the app is the only way out.
    expect(screen.getByRole("link", { name: /Go to Schema Studio/ })).toHaveAttribute(
      "href",
      "/studio"
    );
  });

  test("shows the reference when the throw happened on the server", () => {
    render(<AppError error={boom("deadbeef")} reset={jest.fn()} />);
    expect(screen.getByText(/deadbeef/)).toBeInTheDocument();
  });

  test("logs under its own name, so the two boundaries can be told apart", () => {
    render(<AppError error={boom()} reset={jest.fn()} />);
    expect(loggedBy("Page failed to render")).toHaveLength(1);
    expect(loggedBy("Studio screen failed")).toHaveLength(0);
  });
});

describe("an address that matches no screen", () => {
  test("names the two places the reader was most likely heading", () => {
    render(<NotFound />);
    expect(screen.getByRole("link", { name: /Dashboard/ })).toHaveAttribute("href", "/studio");
    expect(screen.getByRole("link", { name: /Compare/ })).toHaveAttribute("href", "/compare");
  });

  test("offers nothing to retry, because nothing failed", () => {
    // A 404 is an answer, not a fault. A "Try again" here would invite the
    // reader to keep pressing it on a URL that will never resolve.
    render(<NotFound />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("There is no page here")).toBeInTheDocument();
  });

  test("says nothing about an error", () => {
    render(<NotFound />);
    expect(loggedBy("")).toHaveLength(0);
  });
});

describe("the application shell itself failing", () => {
  test("brings nothing with it from the rest of the app", () => {
    // The whole point of this file. It replaces the ROOT layout, so the layout
    // that loads globals.css is the thing that has just failed: the design
    // tokens, the fonts and every shared component may be unavailable. One
    // `import { Card } from "@/components/ui"` added here for tidiness would
    // turn the last boundary into a second crash, and there is no boundary
    // under it to catch that one. Asserted against the source because the
    // failure is an import existing, not anything the render does.
    const source = readFileSync(
      path.join(__dirname, "..", "app", "global-error.tsx"),
      "utf8"
    );
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports).toEqual(["react"]);
    // And no side-effect import either — `import "@/app/globals.css"` has no
    // `from` clause, so it would slip past the check above while being the
    // single most likely thing for somebody to add here.
    expect(source).not.toMatch(/^import\s+"/m);
  });

  test("supplies the document Next has taken away", () => {
    // Rendered to markup rather than into jsdom. React merges an <html> or
    // <body> element into the document it is already rendering inside, so a
    // container query here reports them missing when what actually happened is
    // that they were folded into the page the test runner had already built.
    // The markup is the claim: when Next replaces the whole document with this
    // file, this file has to BE a document.
    const markup = renderToStaticMarkup(<GlobalError error={boom()} reset={jest.fn()} />);
    expect(markup).toContain("<html");
    expect(markup).toContain("<body");
    // Its styles have to travel with it, for the same reason as above.
    expect(markup).toContain("<style");
  });

  test("still gives the reader a sentence and a button", () => {
    const reset = jest.fn();
    render(<GlobalError error={boom()} reset={reset} />);
    expect(screen.getByText("Schema Studio could not start")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  test("shows the reference, and logs the error like the others", () => {
    render(<GlobalError error={boom("0ff1ce")} reset={jest.fn()} />);
    expect(screen.getByText(/0ff1ce/)).toBeInTheDocument();
    expect(loggedBy("The application shell failed")).toHaveLength(1);
  });
});
