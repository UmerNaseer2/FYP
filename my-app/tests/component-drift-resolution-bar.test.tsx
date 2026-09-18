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
 */

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

jest.mock("next/navigation", () => require("./helpers/render-page").navigationStubs);

import { DriftResolutionBar } from "@/components/studio/DriftResolutionBar";
import { fetchCalls, holdNext, resetPageState, routerCalls, setRoutes } from "./helpers/render-page";

const OK_ROUTES = [
  { match: "/api/lineage/rebaseline", body: { success: true } },
  { match: "/api/lineage/acknowledge", body: { success: true } },
  { match: "/api/lineage/drift", body: { status: "in_sync" } },
];

beforeEach(() => resetPageState());
afterEach(() => cleanup());

const drifted = (onDone?: () => void) => (
  <DriftResolutionBar
    trackedSchemaId={7}
    state="drifted"
    compareHref="/compare?schema=7"
    onDone={onDone}
  />
);

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
    render(<DriftResolutionBar trackedSchemaId={7} state="in_sync" compareHref="/compare?schema=7" />);

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

  it("tells a self-fetching screen to reload, and refreshes the router without one", async () => {
    setRoutes(OK_ROUTES);
    const onDone = jest.fn();
    render(drifted(onDone));

    fireEvent.click(screen.getByRole("button", { name: /Acknowledge/ }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    // A screen holding its data in state would see nothing from a router
    // refresh, so the caller saying which it is has to actually decide it.
    expect(routerCalls.refresh).toBe(0);

    cleanup();
    resetPageState();
    setRoutes(OK_ROUTES);
    render(<DriftResolutionBar trackedSchemaId={7} state="drifted" compareHref={null} />);
    fireEvent.click(screen.getByRole("button", { name: /Acknowledge/ }));
    await waitFor(() => expect(routerCalls.refresh).toBe(1));
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
