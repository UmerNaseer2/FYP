/** @jest-environment jsdom */

/**
 * The automatic-checking screen: what the background loop is doing, how often
 * each schema is checked, and what the screen says when it can no longer find
 * out.
 *
 * Two of these are regressions for defects that were invisible by nature — a
 * screen that has stopped being refreshed looks exactly like one that is fine,
 * and a dropdown that snaps back to the value you just changed away from looks
 * like you mis-clicked.
 */

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

jest.mock("next/navigation", () => require("./helpers/render-page").navigationStubs);

import { ScheduleTable, type ScheduleRow } from "@/components/studio/ScheduleTable";
import { DRIFT_INTERVAL_CHOICES } from "@/lib/drift-schedule";
import { flushAsync, holdNext, resetPageState, setRoutes } from "./helpers/render-page";

const HOUR_AGO = new Date(Date.now() - 60 * 60_000).toISOString();
const IN_AN_HOUR = new Date(Date.now() + 60 * 60_000).toISOString();

function row(intervalMinutes: number): ScheduleRow {
  return {
    trackedSchemaId: 1,
    label: null,
    schemaName: "shop_dev",
    connectionName: "Local Postgres",
    intervalMinutes,
    cadence: "hourly",
    lastCheckedAt: HOUR_AGO,
    nextDueAt: IN_AN_HOUR,
    due: false,
  };
}

function view(rows: ScheduleRow[], running = true, checksRun = 30) {
  return {
    scheduler: {
      running,
      stoppedReason: running ? null : "DRIFT_SCHEDULER is off in this deployment.",
      ticks: 12,
      checksRun,
      lastTickAt: HOUR_AGO,
      lastTickSummary: "2 schemas checked, 1 drifted",
      tickSeconds: 30,
    },
    choices: DRIFT_INTERVAL_CHOICES,
    rows,
  };
}

const cadenceOf = () => screen.getByRole("combobox", { name: "How often to check shop_dev" });

beforeEach(() => resetPageState());
afterEach(() => cleanup());

describe("schedule table", () => {
  it("shows what the loop is doing and when each schema is next due", async () => {
    setRoutes([{ match: "/api/lineage/schedule", method: "GET", body: view([row(60)]) }]);
    render(<ScheduleTable />);

    expect(await screen.findByText("Running")).toBeInTheDocument();
    expect(screen.getByText(/1 of 1 schema is on a cadence/)).toBeInTheDocument();
    expect(screen.getByText(/2 schemas checked, 1 drifted/)).toBeInTheDocument();
    expect(cadenceOf()).toHaveTextContent("Every hour");
    expect(screen.getByText("in 1h")).toBeInTheDocument();
  });

  it("says plainly that nothing is watching when the loop is stopped", async () => {
    setRoutes([{ match: "/api/lineage/schedule", method: "GET", body: view([row(0)], false) }]);
    render(<ScheduleTable />);

    expect(await screen.findByText("Not running")).toBeInTheDocument();
    expect(screen.getByText(/DRIFT_SCHEDULER is off in this deployment/)).toBeInTheDocument();
    // A schema set to manual is not waiting for anything, so it gets no
    // countdown to imply it is.
    expect(screen.getByText("manual only")).toBeInTheDocument();
  });

  it("offers a retry when the very first read fails", async () => {
    setRoutes([
      {
        match: "/api/lineage/schedule",
        method: "GET",
        status: 500,
        body: { error: "The app database is unreachable." },
      },
    ]);
    render(<ScheduleTable />);

    expect(await screen.findByText("Could not read the checking schedule")).toBeInTheDocument();
    expect(screen.getByText("The app database is unreachable.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("keeps the last good answer when a LATER read fails, and says it is stale", async () => {
    setRoutes([{ match: "/api/lineage/schedule", method: "GET", body: view([row(60)]) }]);
    render(<ScheduleTable />);
    await screen.findByText("Running");

    // The database goes away AFTER the screen has something on it.
    setRoutes([
      {
        match: "/api/lineage/schedule",
        method: "GET",
        status: 500,
        body: { error: "Lost the database." },
      },
    ]);
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));

    // The defect: `error` was read in exactly one place — the empty state,
    // which only shows when there is nothing to display at all. So a screen
    // that had stopped being refreshed went on ticking its countdowns and
    // showing a "Running" pill, indistinguishable from a healthy one.
    expect(
      await screen.findByText(/What you see below is the last answer that came back/)
    ).toBeInTheDocument();
    // The old numbers stay: they are still the best answer anybody has.
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(cadenceOf()).toHaveTextContent("Every hour");
    // And the banner is the only way back: it carries its own retry.
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("does not let a slow poll repaint a cadence the user has just changed", async () => {
    // What the server would say, as it changes under the screen. The check
    // count rides along as a stamp: it is the one thing on this screen that
    // only ever comes from an answer, so it says WHICH answer is being shown.
    let answer = view([row(60)], true, 30);
    setRoutes([
      { match: "/api/lineage/schedule", method: "GET", body: () => answer },
      { match: "/api/lineage/schedule", method: "PATCH", body: { ok: true } },
    ]);
    render(<ScheduleTable />);
    await waitFor(() => expect(cadenceOf()).toHaveTextContent("Every hour"));

    // A minute poll starts. Its answer is decided NOW — hourly, 30 checks —
    // and then held.
    const releasePoll = holdNext("/api/lineage/schedule", "GET");
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));

    // Meanwhile the user picks a new cadence. The save reloads afterwards, and
    // that reload is not held, so it lands FIRST.
    answer = view([row(5)], true, 31);
    fireEvent.click(cadenceOf());
    fireEvent.click(screen.getByRole("option", { name: "Every 5 minutes" }));

    // Waited for on the stamp rather than on the dropdown, and this is the
    // whole test. The dropdown holds its own value while it is open, so it
    // reads "Every 5 minutes" from the click alone, before the save has even
    // been sent — waiting on that would let the two answers land in the same
    // batch, which is not a race at all and nothing could be overtaken.
    expect(await screen.findByText("31 checks this run")).toBeInTheDocument();

    // Now the poll comes back, carrying the state the user has moved on from.
    releasePoll();
    await flushAsync();

    // Without the request-sequence guard this is where the screen went
    // backwards on its own, with no save and no click behind it: the counters
    // to the older pass, and the dropdown to the cadence just changed away
    // from, which reads as the click having failed.
    expect(screen.getByText("31 checks this run")).toBeInTheDocument();
    expect(cadenceOf()).toHaveTextContent("Every 5 minutes");
  });

  it("reports a refused save without dropping the table", async () => {
    setRoutes([
      { match: "/api/lineage/schedule", method: "GET", body: view([row(60)]) },
      {
        match: "/api/lineage/schedule",
        method: "PATCH",
        status: 400,
        body: { error: "That is not one of the allowed intervals." },
      },
    ]);
    render(<ScheduleTable />);
    await waitFor(() => expect(cadenceOf()).toHaveTextContent("Every hour"));

    fireEvent.click(cadenceOf());
    fireEvent.click(screen.getByRole("option", { name: "Every 5 minutes" }));

    expect(
      await screen.findByText("That is not one of the allowed intervals.")
    ).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
  });

  it("points at the Dashboard when nothing is tracked yet", async () => {
    setRoutes([{ match: "/api/lineage/schedule", method: "GET", body: view([]) }]);
    render(<ScheduleTable />);

    expect(await screen.findByText("No schemas are being tracked")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to the Dashboard" })).toHaveAttribute(
      "href",
      "/studio"
    );
  });
});
