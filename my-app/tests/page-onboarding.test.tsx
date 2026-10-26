/** @jest-environment jsdom */

/**
 * "Your organizations" (components/onboarding/OnboardingPage.tsx): the page
 * someone lands on when they belong to no organization yet, or want to make
 * a new one.
 *
 * What it is held to here:
 *   - The list: each organization a link into its studio, an empty list that
 *     says what to do next, and a list that could not be read saying why,
 *     with "Try again" where that can help and "Sign in" where it cannot.
 *   - The form, only when the server says it would make an organization. The
 *     address follows the name until the person types their own, and is kept
 *     lowercase. A name's problems show as it is typed; an address's wait
 *     until the box is left or Create is pressed, because "ac" is on its way
 *     to "acme". Nothing is sent while either has a problem.
 *   - Creating: the name cleaned and the address trimmed, one request however
 *     often Create is pressed, and the studio of the new organization opened.
 *     A refusal lands under the box it names, or above the button when it
 *     names none.
 *   - The demo (sign-in switched off): no Sign out, and no form.
 *
 * The server half, which forwards the desktop app to /studio, is in
 * tests/page-onboarding-server.test.ts. The route's own refusals are in
 * tests/organizations-route.test.ts, and the name and address rules in
 * tests/new-organization.test.ts.
 */

import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

jest.mock("next/navigation", () => require("./helpers/render-page").navigationStubs);
// The real one reaches for next-auth, and signing out is not this page's to test.
jest.mock("../lib/sign-out", () => ({ signOutEverywhere: jest.fn(() => Promise.resolve()) }));

import { OnboardingPage } from "@/components/onboarding/OnboardingPage";
import { signOutEverywhere } from "@/lib/sign-out";
import {
  fetchCalls,
  holdNext,
  resetPageState,
  routerCalls,
  setRoutes,
  type FetchRoute,
} from "./helpers/render-page";

const LIST = "/api/organizations";
const SIGN_IN_AGAIN = "/login?callbackUrl=/onboarding";
const UNREACHABLE = "Could not reach the server. Check your connection, then try again.";
const SHAPE =
  "An address is 3 to 40 lowercase letters, digits and dashes, " +
  "and starts and ends with a letter or digit.";

const ACME = { slug: "acme", name: "Acme" };
const BETA = { slug: "beta-ops", name: "Beta Ops" };

/** GET /api/organizations answering with this list. */
function listing(organizations: { slug: string; name: string }[], canCreate = true): FetchRoute {
  return { match: LIST, method: "GET", body: { organizations, canCreate } };
}

/** POST /api/organizations answering like this. */
function creating(status: number, body: unknown): FetchRoute {
  return { match: LIST, method: "POST", status, body };
}

/** Draw the page and wait for its list to be read, however that went. */
async function open(routes: FetchRoute[], { demo = false } = {}) {
  setRoutes(routes);
  render(<OnboardingPage demo={demo} />);
  await waitFor(() => expect(screen.queryByText("Loading your organizations…")).toBeNull());
}

const nameBox = () => screen.getByLabelText("Name") as HTMLInputElement;
const slugBox = () => screen.getByLabelText("Address") as HTMLInputElement;
const createButton = () => screen.getByRole("button", { name: /Create organization|Creating…|Opening…/ });

function typeName(value: string) {
  fireEvent.change(nameBox(), { target: { value } });
}

function typeSlug(value: string) {
  fireEvent.change(slugBox(), { target: { value } });
}

/** Every POST the page sent, as the JSON it sent. */
function posted(): unknown[] {
  return fetchCalls.filter((call) => call.method === "POST").map((call) => JSON.parse(call.body!));
}

beforeEach(() => {
  resetPageState();
  window.history.replaceState({}, "", "/onboarding");
  (signOutEverywhere as jest.Mock).mockClear();
});

afterEach(() => cleanup());

describe("the list of organizations", () => {
  test("links each one into its studio, by name and address, after one read", async () => {
    await open([listing([ACME, BETA])]);

    const links = within(screen.getByRole("list")).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/acme/studio",
      "/beta-ops/studio",
    ]);
    expect(links[0]).toHaveTextContent("Acme");
    expect(links[0]).toHaveTextContent("/acme");
    expect(links[1]).toHaveTextContent("Beta Ops");
    expect(fetchCalls).toEqual([{ url: LIST, method: "GET", body: null }]);
  });

  test("when empty, says so and points at the invitation link and the form", async () => {
    await open([listing([])]);

    expect(screen.getByText("You are not in any organization yet.")).toBeInTheDocument();
    expect(
      screen.getByText(/If someone has asked you to join theirs, open the invitation link/)
    ).toHaveTextContent("Or create your own below.");
    expect(screen.queryByRole("list")).toBeNull();
    expect(createButton()).toBeInTheDocument();
  });

  test("when empty on a server that makes none, offers no form and does not point at one", async () => {
    await open([listing([], false)]);

    expect(
      screen.getByText(/If someone has asked you to join theirs, open the invitation link/)
    ).not.toHaveTextContent("Or create your own below.");
    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(screen.queryByRole("button", { name: /Create organization/ })).toBeNull();
    expect(screen.getByText("This server does not create new organizations.")).toBeInTheDocument();
  });
});

describe("a list that could not be read", () => {
  test("says why, offers Try again and no form, and reads the list again when asked", async () => {
    const unavailable =
      "Could not read your organizations. The app's database may be unreachable. Try again in a moment.";
    await open([{ match: LIST, method: "GET", status: 503, body: { error: unavailable } }]);

    expect(screen.getByRole("alert")).toHaveTextContent(unavailable);
    expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
    expect(screen.queryByLabelText("Name")).toBeNull();

    setRoutes([listing([ACME])]);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByRole("status")).toHaveTextContent("Loading your organizations…");
    expect(screen.queryByRole("alert")).toBeNull();

    expect(await screen.findByRole("link", { name: /Acme/ })).toHaveAttribute("href", "/acme/studio");
    expect(fetchCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${LIST}`,
      `GET ${LIST}`,
    ]);
  });

  test("a server that could not be reached is said so, in words that say what to do", async () => {
    await open([{ match: LIST, method: "GET", networkError: true }]);

    expect(screen.getByRole("alert")).toHaveTextContent(UNREACHABLE);
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  test("a refusal with no message of its own gives its status", async () => {
    await open([{ match: LIST, method: "GET", status: 500, body: "<html>Bad gateway</html>" }]);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not read your organizations (HTTP 500)."
    );
  });

  test("an answer in a shape the page does not know is not drawn as a list", async () => {
    await open([
      { match: LIST, method: "GET", body: { organizations: [{ slug: "acme" }], canCreate: true } },
    ]);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "The server's answer could not be read. Try again in a moment."
    );
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByLabelText("Name")).toBeNull();
  });

  test("a session that has ended offers Sign in, back to this page, instead of Try again", async () => {
    await open([
      { match: LIST, method: "GET", status: 401, body: { error: "Sign in to continue." } },
    ]);

    expect(screen.getByRole("alert")).toHaveTextContent("Sign in to continue.");
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", SIGN_IN_AGAIN);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });
});

describe("the address", () => {
  test("follows the name, and the help under it shows where the pages will be", async () => {
    await open([listing([])]);
    expect(screen.getByText("/your-address/studio")).toBeInTheDocument();

    typeName("Acme Data Team");
    expect(slugBox()).toHaveValue("acme-data-team");
    expect(screen.getByText("/acme-data-team/studio")).toBeInTheDocument();
  });

  test("stops following once the person types their own", async () => {
    await open([listing([])]);
    typeName("Acme Data Team");
    typeSlug("acme");
    typeName("Acme Labs");

    expect(slugBox()).toHaveValue("acme");
  });

  test("follows the name again once emptied, from the name's next change", async () => {
    await open([listing([])]);
    typeName("Acme");
    typeSlug("my-own");
    typeSlug("");
    expect(slugBox()).toHaveValue("");

    typeName("Acme Labs");
    expect(slugBox()).toHaveValue("acme-labs");
  });

  test("takes capitals as the lowercase letters an address is made of", async () => {
    await open([listing([])]);
    typeSlug("Acme-OPS");

    expect(slugBox()).toHaveValue("acme-ops");
    expect(screen.getByText("/acme-ops/studio")).toBeInTheDocument();
  });
});

describe("problems with the form", () => {
  test("a name's show as it is typed, tied to its box", async () => {
    await open([listing([])]);
    typeName("x".repeat(61));

    const problem = screen.getByText("Keep the name to 60 characters or fewer.");
    expect(problem).toHaveAttribute("id", "org-name-problem");
    expect(nameBox()).toHaveAttribute("aria-invalid", "true");
    expect(nameBox()).toHaveAttribute("aria-describedby", "org-name-problem");

    typeName("Acme");
    expect(screen.queryByText("Keep the name to 60 characters or fewer.")).toBeNull();
    expect(nameBox()).not.toHaveAttribute("aria-invalid");
    expect(nameBox()).not.toHaveAttribute("aria-describedby");
  });

  test("an address's wait until the box is left, then sit beside its help", async () => {
    await open([listing([])]);
    typeSlug("ac");
    expect(screen.queryByText(SHAPE)).toBeNull();
    expect(slugBox()).toHaveAttribute("aria-describedby", "org-slug-help");

    fireEvent.blur(slugBox());
    expect(screen.getByText(SHAPE)).toHaveAttribute("id", "org-slug-problem");
    expect(slugBox()).toHaveAttribute("aria-invalid", "true");
    expect(slugBox()).toHaveAttribute("aria-describedby", "org-slug-help org-slug-problem");
  });

  test("an address that only followed the name shows its problem once Create is pressed", async () => {
    await open([listing([])]);
    typeName("QA");
    expect(slugBox()).toHaveValue("qa");
    expect(screen.queryByText(SHAPE)).toBeNull();

    fireEvent.click(createButton());
    expect(screen.getByText(SHAPE)).toBeInTheDocument();
    expect(slugBox()).toHaveFocus();
    expect(posted()).toEqual([]);
  });

  test("Create with nothing filled in shows both problems, puts the cursor in the name, and sends nothing", async () => {
    await open([listing([])]);
    fireEvent.click(createButton());

    expect(screen.getByText("Give the organization a name.")).toBeInTheDocument();
    expect(screen.getByText("Give the organization an address.")).toBeInTheDocument();
    expect(nameBox()).toHaveFocus();
    expect(posted()).toEqual([]);
  });
});

describe("creating an organization", () => {
  test("sends the name cleaned and the address trimmed, once, then opens the new studio", async () => {
    await open([listing([]), creating(201, { organization: { slug: "acme-ops", name: "Acme Ops" } })]);
    const release = holdNext(LIST, "POST");
    typeName("  Acme   Ops ");
    typeSlug(" Acme-Ops ");
    fireEvent.click(createButton());

    expect(await screen.findByText("Creating…")).toBeInTheDocument();
    expect(createButton()).toBeDisabled();
    expect(createButton()).toHaveAttribute("aria-busy", "true");
    expect(nameBox()).toHaveAttribute("readonly");
    expect(slugBox()).toHaveAttribute("readonly");
    expect(posted()).toEqual([{ name: "Acme Ops", slug: "acme-ops" }]);

    // The button is disabled, so this is a press that got past it.
    fireEvent.submit(createButton().closest("form")!);
    expect(posted()).toHaveLength(1);
    expect(routerCalls.push).toEqual([]);

    await act(async () => release());
    expect(await screen.findByText("Opening…")).toBeInTheDocument();
    expect(createButton()).toBeDisabled();
    expect(routerCalls.push).toEqual(["/acme-ops/studio"]);
  });

  test("a taken address is said under the address, which gets the cursor, until it is changed", async () => {
    await open([
      listing([]),
      creating(409, { error: "That address is taken. Pick another.", field: "slug" }),
    ]);
    typeName("Acme");
    fireEvent.click(createButton());

    expect(await screen.findByText("That address is taken. Pick another.")).toHaveAttribute(
      "id",
      "org-slug-problem"
    );
    expect(slugBox()).toHaveFocus();
    expect(slugBox()).not.toHaveAttribute("readonly");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(createButton()).toHaveTextContent("Create organization");
    expect(createButton()).toBeEnabled();
    expect(routerCalls.push).toEqual([]);

    typeSlug("acme-2");
    expect(screen.queryByText("That address is taken. Pick another.")).toBeNull();
    expect(slugBox()).not.toHaveAttribute("aria-invalid");
  });

  test("a refusal of the name is said under the name, which gets the cursor, until it is changed", async () => {
    const refused = "The name has a character that cannot be shown. Type it again.";
    await open([listing([]), creating(400, { error: refused, field: "name" })]);
    typeName("Acme");
    fireEvent.click(createButton());

    expect(await screen.findByText(refused)).toHaveAttribute("id", "org-name-problem");
    expect(nameBox()).toHaveFocus();

    typeName("Acme Labs");
    expect(screen.queryByText(refused)).toBeNull();
  });

  test("a refusal about neither box is said above the button, and the boxes keep what was typed", async () => {
    const unavailable =
      "Could not make the organization. The app's database may be unreachable. Try again in a moment.";
    await open([listing([]), creating(503, { error: unavailable })]);
    typeName("Acme");
    fireEvent.click(createButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(unavailable);
    expect(screen.queryByRole("link", { name: "Sign in again" })).toBeNull();
    expect(nameBox()).toHaveValue("Acme");
    expect(slugBox()).toHaveValue("acme");
    expect(createButton()).toBeEnabled();
  });

  test("pressing Create again clears the last refusal, and can succeed", async () => {
    await open([listing([]), creating(503, { error: "Could not make the organization." })]);
    typeName("Acme");
    fireEvent.click(createButton());
    await screen.findByRole("alert");

    setRoutes([creating(201, { organization: ACME })]);
    fireEvent.click(createButton());
    expect(screen.queryByRole("alert")).toBeNull();
    await screen.findByText("Opening…");
    expect(routerCalls.push).toEqual(["/acme/studio"]);
    expect(posted()).toHaveLength(2);
  });

  test("a server that could not be reached is said so above the button", async () => {
    await open([listing([]), { match: LIST, method: "POST", networkError: true }]);
    typeName("Acme");
    fireEvent.click(createButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(UNREACHABLE);
  });

  test("a refusal with no message of its own gives its status", async () => {
    await open([listing([]), creating(502, "<html>Bad gateway</html>")]);
    typeName("Acme");
    fireEvent.click(createButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not create the organization (HTTP 502)."
    );
  });

  test("an ended session offers Sign in again, back to this page", async () => {
    await open([listing([]), creating(401, { error: "Sign in again to continue." })]);
    typeName("Acme");
    fireEvent.click(createButton());

    expect(await screen.findByRole("alert")).toHaveTextContent("Sign in again to continue.");
    expect(screen.getByRole("link", { name: "Sign in again" })).toHaveAttribute(
      "href",
      SIGN_IN_AGAIN
    );
  });
});

describe("the header", () => {
  test("Sign out signs the person out", async () => {
    await open([listing([ACME])]);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(signOutEverywhere).toHaveBeenCalledTimes(1);
  });
});

describe("the demo, with sign-in switched off", () => {
  test("lists the demo's organizations, with no Sign out and no form, and says why", async () => {
    await open([listing([ACME, BETA], false)], { demo: true });

    expect(
      screen.getByText("Sign-in is switched off here, so these are the demo's organizations.")
    ).toBeInTheDocument();
    expect(within(screen.getByRole("list")).getAllByRole("link")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(
      screen.getByText(
        "Creating an organization needs a real sign-in, so there is no one here to be its first Admin."
      )
    ).toBeInTheDocument();
  });
});
