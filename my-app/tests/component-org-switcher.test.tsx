/** @jest-environment jsdom */

/**
 * The organization picker on the studio rail (components/studio/OrgSwitcher.tsx).
 *
 * It names the organization open now, offers the others this person belongs
 * to, and, where the server makes them, a way to make a new one. Picking one
 * opens that organization's studio home.
 *
 * What it is held to here:
 *   - The choices: the organization open now first, named as the page names
 *     it; then the others in the order the server listed them; then
 *     "New organization…" only when the server says it would make one.
 *   - Nothing drawn when there is nothing to pick (the desktop app's one
 *     organization, a demo with one), before the list arrives, when it could
 *     not be read, when the answer is not a list, and outside an organization.
 *   - Picking: another organization opens its studio, "New organization…"
 *     opens "Your organizations", and the one already open goes nowhere.
 *   - The read: one request, never from the cache, sent as this organization.
 *
 * What is NOT here:
 *   - Where the rail puts the picker, and that the narrow rail leaves it off:
 *     tests/component-studio-sidebar.test.tsx.
 *   - That the shell hands it to the rail: tests/component-studio-shell.test.tsx.
 *   - What the list holds, and who may create: tests/organizations-route.test.ts.
 *   - That the list opens upward, out of the way of the bottom of the window.
 *     That is the stylesheet, and jsdom applies none; the preview is where it
 *     was checked.
 *   - The select itself (keys, focus, closing): tests/component-select.test.tsx.
 */

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render as renderWithoutOrg, screen, waitFor } from "@testing-library/react";

jest.mock("next/navigation", () => require("./helpers/render-page").navigationStubs);

import { OrgSwitcher } from "@/components/studio/OrgSwitcher";
import { ORG_HEADER } from "@/lib/org-slug";
import {
  TEST_ORG,
  fetchCalls,
  flushAsync,
  holdNext,
  render,
  resetPageState,
  routerCalls,
  setRoutes,
  type FetchRoute,
} from "./helpers/render-page";

const LIST = "/api/organizations";

const HERE = { slug: TEST_ORG.slug, name: TEST_ORG.name };
const ACME = { slug: "acme", name: "Acme" };
const BETA = { slug: "beta-ops", name: "Beta Ops" };

/** GET /api/organizations answering with this list. */
function listing(organizations: { slug: string; name: string }[], canCreate = true): FetchRoute {
  return { match: LIST, method: "GET", body: { organizations, canCreate } };
}

const picker = () => screen.getByRole("combobox", { name: "Organization" });
const options = () => screen.getAllByRole("option").map((option) => option.textContent);

/** Draw the picker inside TEST_ORG and wait for it to appear. */
async function open(routes: FetchRoute[]) {
  setRoutes(routes);
  render(<OrgSwitcher />);
  return waitFor(() => picker());
}

/** Draw the picker and let its read finish, for the cases that draw nothing. */
async function openQuietly(routes: FetchRoute[]) {
  setRoutes(routes);
  const view = render(<OrgSwitcher />);
  await flushAsync();
  return view;
}

/** Open the list and pick the option with this name. */
function pick(name: string) {
  fireEvent.click(picker());
  fireEvent.click(screen.getByRole("option", { name }));
}

beforeEach(() => {
  resetPageState();
  window.history.replaceState({}, "", `/${TEST_ORG.slug}/studio`);
});

afterEach(() => cleanup());

describe("the choices", () => {
  test("the organization open now, then the others as listed, then a new one", async () => {
    await open([listing([ACME, HERE, BETA])]);

    expect(picker()).toHaveTextContent(TEST_ORG.name);
    fireEvent.click(picker());
    expect(options()).toEqual([TEST_ORG.name, "Acme", "Beta Ops", "New organization…"]);
    expect(screen.getByRole("option", { name: TEST_ORG.name })).toHaveAttribute("aria-selected", "true");
  });

  test("no way to make one where the server makes none", async () => {
    await open([listing([HERE, ACME], false)]);

    fireEvent.click(picker());
    expect(options()).toEqual([TEST_ORG.name, "Acme"]);
  });

  test("only a new one, when this is the only organization so far", async () => {
    await open([listing([HERE])]);

    fireEvent.click(picker());
    expect(options()).toEqual([TEST_ORG.name, "New organization…"]);
  });

  test("names the organization open now as the page does, not as the list did", async () => {
    // The list was read a moment before a rename reached this page, or after.
    // Either way the page's own name is the one the rest of the screen shows.
    await open([listing([{ slug: TEST_ORG.slug, name: "An older name" }, ACME])]);

    expect(picker()).toHaveTextContent(TEST_ORG.name);
    fireEvent.click(picker());
    expect(options()).toEqual([TEST_ORG.name, "Acme", "New organization…"]);
  });

  test("still offers the organization open now when the list leaves it out", async () => {
    // Someone removed a moment ago: the list no longer has it, and the page
    // they are on is about to say so. Until then the picker still has to say
    // where they are.
    await open([listing([ACME])]);

    fireEvent.click(picker());
    expect(options()).toEqual([TEST_ORG.name, "Acme", "New organization…"]);
  });
});

describe("nothing to pick", () => {
  test("one organization and no way to make another: the desktop app, or a small demo", async () => {
    const { container } = await openQuietly([listing([HERE], false)]);
    expect(container).toBeEmptyDOMElement();
    expect(fetchCalls).toHaveLength(1);
  });

  test("before the list arrives", async () => {
    const release = holdNext(LIST);
    const { container } = await openQuietly([listing([HERE, ACME])]);
    expect(container).toBeEmptyDOMElement();

    release();
    await waitFor(() => picker());
  });

  test("when the list could not be read", async () => {
    const { container } = await openQuietly([
      { match: LIST, method: "GET", status: 503, body: { error: "Could not read your organizations." } },
    ]);
    expect(container).toBeEmptyDOMElement();
  });

  test("when the server refused, whatever the body of the refusal looks like", async () => {
    // The status is what says whether this is the list. A proxy or an older
    // server can put anything in the body of a refusal.
    const { container } = await openQuietly([
      { match: LIST, method: "GET", status: 401, body: { organizations: [HERE, ACME], canCreate: true } },
    ]);
    expect(container).toBeEmptyDOMElement();
  });

  test("when the server could not be reached", async () => {
    const { container } = await openQuietly([{ match: LIST, method: "GET", networkError: true }]);
    expect(container).toBeEmptyDOMElement();
  });

  test.each([
    ["not an object", "<html>Bad gateway</html>"],
    ["no list", { canCreate: true }],
    ["an entry without a name", { organizations: [{ slug: "acme" }], canCreate: true }],
    ["no word on creating", { organizations: [HERE, ACME] }],
  ])("when the answer is %s", async (_case, body) => {
    const { container } = await openQuietly([{ match: LIST, method: "GET", body }]);
    expect(container).toBeEmptyDOMElement();
  });

  test("outside an organization, where there is nothing to switch from, and it asks nothing", async () => {
    window.history.replaceState({}, "", "/onboarding");
    setRoutes([listing([ACME, BETA])]);
    const { container } = renderWithoutOrg(<OrgSwitcher />);
    await flushAsync();
    expect(container).toBeEmptyDOMElement();
    expect(fetchCalls).toEqual([]);
  });
});

describe("picking", () => {
  test("another organization opens its studio home", async () => {
    await open([listing([HERE, ACME, BETA])]);

    pick("Beta Ops");
    expect(routerCalls.push).toEqual(["/beta-ops/studio"]);
  });

  test('"New organization…" opens "Your organizations", where the form is', async () => {
    await open([listing([HERE, ACME])]);

    pick("New organization…");
    expect(routerCalls.push).toEqual(["/onboarding"]);
  });

  test("the organization already open goes nowhere", async () => {
    await open([listing([HERE, ACME])]);

    pick(TEST_ORG.name);
    expect(routerCalls.push).toEqual([]);
    expect(routerCalls.replace).toEqual([]);
  });
});

describe("the read", () => {
  test("asks once, never from the cache, as the organization the page is in", async () => {
    const asked: RequestInit[] = [];
    await open([
      {
        match: LIST,
        method: "GET",
        body: (_url: string, init?: RequestInit) => {
          asked.push(init ?? {});
          return { organizations: [HERE, ACME], canCreate: true };
        },
      },
    ]);

    expect(fetchCalls).toEqual([{ url: LIST, method: "GET", body: null }]);
    expect(asked).toHaveLength(1);
    expect(asked[0].cache).toBe("no-store");
    expect(new Headers(asked[0].headers).get(ORG_HEADER)).toBe(TEST_ORG.slug);
  });
});
