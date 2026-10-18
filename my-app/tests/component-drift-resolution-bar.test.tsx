/** @jest-environment jsdom */

/**
 * The three resolution actions for one drifted schema, plus the re-check that
 * sits inside the same bar.
 *
 * Tested at the component rather than through the screen that uses it. The bar
 * is rendered once today, inside the drift page's hero, and in three different
 * shapes of that hero — but the thing worth pinning down, that these four
 * buttons block one another, belongs to the bar itself and would have to be
 * re-pinned from scratch at every screen that adopted it next.
 *
 * And who may use them. Re-baselining and acknowledging change how the schema
 * is tracked, so both need Drift tracking: Update; the re-check needs Run. A
 * role without a box sees the buttons it would need switched off, and each
 * reason said once, under the bar, rather than beside every button it turns
 * off. The re-check is asked to keep quiet beside itself for that reason.
 *
 * What is NOT here:
 *  - The re-check button's own behaviour — what it sends, what it does with the
 *    answer, and that it reports starting and stopping at all:
 *    tests/component-recheck-drift-button.test.tsx. What is checked below is
 *    only the handshake, from the bar's side, in both directions.
 *  - The routes behind the bar's own buttons. POST /api/lineage/rebaseline and
 *    POST /api/lineage/acknowledge have no suites of their own; the answers
 *    below are written out by hand.
 *  - The screen that renders it, and the onDone it passes down:
 *    tests/page-drift.test.tsx.
 *  - That Deploy: Run lets the re-check through as well: the button's own
 *    suite has that, and the bar only passes the question on.
 */

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

jest.mock("next/navigation", () => require("./helpers/render-page").navigationStubs);
jest.mock("next-auth/react", () => require("./helpers/render-page").sessionStubs);

import { DriftResolutionBar } from "@/components/studio/DriftResolutionBar";
import {
  fetchCalls,
  flushAsync,
  holdNext,
  resetPageState,
  routerCalls,
  setCustomRole,
  setRoutes,
  setSessionLoading,
  setUser,
} from "./helpers/render-page";

const OK_ROUTES = [
  { match: "/api/lineage/rebaseline", body: { success: true } },
  { match: "/api/lineage/acknowledge", body: { success: true } },
  { match: "/api/lineage/drift", body: { status: "in_sync" } },
];

beforeEach(() => resetPageState());
afterEach(() => cleanup());

// onDone is required on the bar, so the helper always supplies one. Tests that
// assert on it pass their own.
const drifted = (onDone: () => void = jest.fn()) => (
  <DriftResolutionBar
    trackedSchemaId={7}
    state="drifted"
    compareHref="/compare?schema=7"
    onDone={onDone}
  />
);

// The server's own words, for whichever role is signed in.
const updateRefusal = (role: string) =>
  `Your role (${role}) can't change schedules, environments and baselines, or acknowledge ` +
  `drift. Ask an admin to allow "Drift tracking: Update" for this role.`;
const runRefusal = (role: string) =>
  `Your role (${role}) can't run a drift check. ` +
  `Ask an admin to allow "Drift tracking: Run" for this role.`;

describe("drift resolution bar", () => {
  it("offers all four actions on a drifted schema", () => {
    setRoutes(OK_ROUTES);
    render(drifted());

    expect(screen.getByRole("link", { name: /Author a migration/ })).toHaveAttribute(
      "href",
      "/compare?schema=7"
    );
    expect(screen.getByRole("button", { name: "Re-baseline to live" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Acknowledge/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Check drift now/ })).toBeEnabled();
  });

  it("offers only a re-check once the schema is back in sync", () => {
    setRoutes(OK_ROUTES);
    render(
      <DriftResolutionBar
        trackedSchemaId={7}
        state="in_sync"
        compareHref="/compare?schema=7"
        onDone={jest.fn()}
      />
    );

    // Nothing to resolve, so nothing that resolves — and the remaining button
    // is named for what it now means.
    expect(screen.queryByRole("button", { name: "Re-baseline to live" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Acknowledge/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Author a migration/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Re-check/ })).toBeInTheDocument();
  });

  it("shuts its own writes while the nested re-check is running", async () => {
    setRoutes(OK_ROUTES);
    render(drifted());

    const release = holdNext("/api/lineage/drift");
    fireEvent.click(screen.getByRole("button", { name: /Check drift now/ }));

    // The defect: the re-check runs its own POST, so the bar's `busy` cannot
    // see it. Re-baselining REPLACES the baseline the check is comparing
    // against, so overlapping them left the recorded answer down to which
    // request came back first.
    expect(await screen.findByRole("button", { name: "Checking…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Re-baseline to live" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Acknowledge/ })).toBeDisabled();

    release();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Re-baseline to live" })).toBeEnabled()
    );
  });

  it("shuts the nested re-check while one of its own writes is running", async () => {
    setRoutes(OK_ROUTES);
    render(drifted());

    const release = holdNext("/api/lineage/rebaseline");
    fireEvent.click(screen.getByRole("button", { name: "Re-baseline to live" }));
    fireEvent.click(await screen.findByRole("button", { name: "Re-baseline" }));

    expect(await screen.findByRole("button", { name: "Re-baselining…" })).toBeDisabled();
    // The block has to run the other way too, or the pair is only half closed.
    expect(screen.getByRole("button", { name: /Check drift now/ })).toBeDisabled();

    release();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Check drift now/ })).toBeEnabled()
    );
  });

  it("tells the screen to reload after a write", async () => {
    setRoutes(OK_ROUTES);
    const onDone = jest.fn();
    render(drifted(onDone));

    fireEvent.click(screen.getByRole("button", { name: /Acknowledge/ }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    // There is no router.refresh() fallback behind this any more, and the bar
    // no longer accepts a missing onDone. Every screen that renders it holds
    // its data in state, where a router refresh repaints nothing — so the path
    // that used to be taken when onDone was absent did nothing visible while
    // reporting success. The caller has to say how to reload, and this is the
    // assertion that the bar does not quietly do something else instead.
    expect(routerCalls.refresh).toBe(0);
  });

  it("shows the server's reason when an action is refused, and lets go of the lock", async () => {
    setRoutes([
      { match: "/api/lineage/acknowledge", status: 409, body: { error: "No open drift event." } },
      ...OK_ROUTES,
    ]);
    render(drifted(jest.fn()));

    fireEvent.click(screen.getByRole("button", { name: /Acknowledge/ }));

    expect(await screen.findByText("No open drift event.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Acknowledge/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Check drift now/ })).toBeEnabled();
    expect(fetchCalls.at(-1)).toMatchObject({
      method: "POST",
      body: JSON.stringify({ trackedSchemaId: 7 }),
    });
  });
});

describe("for a role that may not resolve or re-check", () => {
  it("leaves every button on screen but off, and says each reason once", () => {
    setUser("viewer");
    render(drifted());

    const rebaseline = screen.getByRole("button", { name: "Re-baseline to live" });
    const acknowledge = screen.getByRole("button", { name: /Acknowledge/ });
    const recheck = screen.getByRole("button", { name: /Check drift now/ });
    expect(rebaseline).toBeDisabled();
    expect(acknowledge).toBeDisabled();
    expect(recheck).toBeDisabled();
    expect(rebaseline).toHaveAttribute("title", updateRefusal("Viewer"));
    expect(acknowledge).toHaveAttribute("title", updateRefusal("Viewer"));
    expect(recheck).toHaveAttribute("title", runRefusal("Viewer"));
    // Once each, under the bar. Said beside the re-check as well, the run
    // reason would be on screen twice.
    expect(screen.getAllByText(updateRefusal("Viewer"))).toHaveLength(1);
    expect(screen.getAllByText(runRefusal("Viewer"))).toHaveLength(1);
  });

  it("sends nothing when a switched-off button is pressed anyway", async () => {
    // No routes: a request that got out would fail on its own.
    setUser("viewer");
    setRoutes([]);
    render(drifted());

    fireEvent.click(screen.getByRole("button", { name: /Acknowledge/ }));
    fireEvent.click(screen.getByRole("button", { name: "Re-baseline to live" }));
    await flushAsync();

    expect(fetchCalls).toHaveLength(0);
    // Not even the confirm: a role that may not re-baseline is not asked to.
    expect(screen.queryByRole("button", { name: "Re-baseline" })).toBeNull();
  });

  it("gives only the re-check's reason on a schema back in sync", () => {
    setUser("viewer");
    render(
      <DriftResolutionBar
        trackedSchemaId={7}
        state="in_sync"
        compareHref="/compare?schema=7"
        onDone={jest.fn()}
      />
    );

    expect(screen.getByRole("button", { name: /Re-check/ })).toBeDisabled();
    expect(screen.getByText(runRefusal("Viewer"))).toBeInTheDocument();
    // Nothing to resolve here, so nothing to explain about resolving.
    expect(screen.queryByText(updateRefusal("Viewer"))).toBeNull();
  });

  it("lets a role with Run alone re-check, and names only what it may not do", () => {
    setCustomRole("watcher", "Watcher", ["drift:run"]);
    setRoutes(OK_ROUTES);
    render(drifted());

    expect(screen.getByRole("button", { name: /Check drift now/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Re-baseline to live" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Acknowledge/ })).toBeDisabled();
    expect(screen.getByText(updateRefusal("Watcher"))).toBeInTheDocument();
    expect(screen.queryByText(runRefusal("Watcher"))).toBeNull();
  });

  it("lets a role with Update acknowledge, and keeps the re-check off", async () => {
    setCustomRole("reviewer", "Reviewer", ["drift:update"]);
    setRoutes(OK_ROUTES);
    const onDone = jest.fn();
    render(drifted(onDone));

    fireEvent.click(screen.getByRole("button", { name: /Acknowledge/ }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toMatchObject({ url: "/api/lineage/acknowledge", method: "POST" });
    // Update is not Run.
    expect(screen.getByRole("button", { name: /Check drift now/ })).toBeDisabled();
    expect(screen.getByText(runRefusal("Reviewer"))).toBeInTheDocument();
    expect(screen.queryByText(updateRefusal("Reviewer"))).toBeNull();
  });

  it("says nothing while the session is still loading", () => {
    // The server decides then, so nothing is switched off for a role nobody
    // knows yet.
    setSessionLoading();
    setRoutes(OK_ROUTES);
    render(drifted());

    expect(screen.getByRole("button", { name: "Re-baseline to live" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Acknowledge/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Check drift now/ })).toBeEnabled();
    expect(screen.queryByText(/Your role/)).toBeNull();
  });
});
