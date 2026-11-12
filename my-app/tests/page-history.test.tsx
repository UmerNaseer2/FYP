/** @jest-environment jsdom */

/**
 * The "Your activity" page: the organization's recorded drift checks.
 *
 * It reads GET /api/lineage/audit and nothing else. These tests cover what the
 * page shows while loading, when the list is empty, when the server fails, and
 * when the role may not read drift checks, then the filters, the day strip,
 * the detail card and the CSV export.
 */

import "@testing-library/jest-dom";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";

jest.mock("next-auth/react", () => require("./helpers/render-page").sessionStubs);

import HistoryPage from "@/app/[org]/(studio)/history/page";
import {
  activityCsv,
  countLines,
  csvCell,
  dayKey,
  lastDays,
  matchesFilters,
  NO_FILTERS,
} from "@/lib/activity";
import { historyHelp } from "@/lib/help/history";
import type { DriftEventFeedItem } from "@/lib/lineage-db";
import { refusalMessage } from "@/lib/permissions";
import {
  fetchCalls,
  flushAsync,
  holdNext,
  render,
  resetPageState,
  setCustomRole,
  setRoutes,
  setUser,
} from "./helpers/render-page";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** A moment `ms` before now, as the server sends it. */
function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

/** Three checks: one drifted just now, and two from three days ago. */
function sampleEvents(): DriftEventFeedItem[] {
  return [
    {
      id: 1,
      trackedSchemaId: 7,
      schemaName: "shop",
      connectionName: "New box",
      status: "drifted",
      summary: "2 tables differ from the baseline.",
      detail: { tablesAdded: 2, tablesRemoved: 0, tablesChanged: 1, constraintsChanged: 0 },
      detectedAt: ago(1000),
      acknowledgedAt: null,
      source: "manual",
    },
    {
      id: 2,
      trackedSchemaId: 8,
      schemaName: "billing",
      connectionName: "Legacy box",
      status: "in_sync",
      summary: null,
      detail: { tablesAdded: 0, tablesRemoved: 0, tablesChanged: 0, constraintsChanged: 0 },
      detectedAt: ago(3 * DAY),
      acknowledgedAt: null,
      source: "scheduled",
    },
    {
      id: 3,
      trackedSchemaId: 8,
      schemaName: "billing",
      connectionName: "Legacy box",
      status: "unreachable",
      summary: "The database did not answer.",
      detail: null,
      detectedAt: ago(3 * DAY + 1000),
      acknowledgedAt: null,
      source: "scheduled",
    },
  ];
}

function auditCalls() {
  return fetchCalls.filter((call) => call.url.includes("/api/lineage/audit"));
}

async function renderWith(events: DriftEventFeedItem[]) {
  setRoutes([{ match: "/api/lineage/audit", body: events }]);
  render(<HistoryPage />);
  await flushAsync();
}

beforeEach(() => {
  resetPageState();
  setUser("admin");
});

afterEach(cleanup);

describe("loading, empty and failing", () => {
  test("shows a loading state until the list arrives", async () => {
    setRoutes([{ match: "/api/lineage/audit", body: sampleEvents() }]);
    const release = holdNext("/api/lineage/audit");
    render(<HistoryPage />);
    await flushAsync();

    expect(screen.getByRole("status", { name: "Loading the activity" })).toBeInTheDocument();

    release();
    await flushAsync();
    expect(screen.queryByRole("status", { name: "Loading the activity" })).not.toBeInTheDocument();
    expect(screen.getAllByText("shop").length).toBeGreaterThan(0);
  });

  test("says so when nothing has been checked yet", async () => {
    await renderWith([]);

    expect(screen.getByRole("heading", { name: "No checks recorded yet" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to the Dashboard" })).toHaveAttribute(
      "href",
      "/test-org/studio"
    );
    expect(screen.getByRole("button", { name: "Export as CSV" })).toBeDisabled();
  });

  test("shows the server's own words on a failure, and Retry asks again", async () => {
    setRoutes([
      {
        match: "/api/lineage/audit",
        status: 500,
        body: { error: "Could not read the drift history. Is the app database reachable?" },
      },
    ]);
    render(<HistoryPage />);
    await flushAsync();

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not read the drift history. Is the app database reachable?"
    );
    expect(auditCalls()).toHaveLength(1);

    setRoutes([{ match: "/api/lineage/audit", body: sampleEvents() }]);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await flushAsync();

    expect(auditCalls()).toHaveLength(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getAllByText("billing").length).toBeGreaterThan(0);
  });
});

describe("who may read it", () => {
  test("a role without Drift tracking: Read is told so, and nothing is fetched", async () => {
    setCustomRole("auditor", "Auditor", []);
    setRoutes([{ match: "/api/lineage/audit", body: sampleEvents() }]);
    render(<HistoryPage />);
    await flushAsync();

    expect(screen.getByText("You can't see the activity")).toBeInTheDocument();
    expect(screen.getByText(refusalMessage("Auditor", "drift:read"), { exact: false })).toBeInTheDocument();
    expect(auditCalls()).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Export as CSV" })).not.toBeInTheDocument();
  });

  test("a 403 from the server shows the same refusal", async () => {
    setRoutes([{ match: "/api/lineage/audit", status: 403, body: { error: "Forbidden" } }]);
    render(<HistoryPage />);
    await flushAsync();

    expect(screen.getByText("You can't see the activity")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("the list", () => {
  test("asks for the newest 200 checks and groups them by day", async () => {
    await renderWith(sampleEvents());

    expect(auditCalls()[0].url).toContain("limit=200");
    expect(screen.getByRole("heading", { name: /^Today/ })).toHaveTextContent("1 check");
    const rows = screen.getAllByRole("button", { name: /has drifted|is in sync|could not be reached/ });
    expect(rows).toHaveLength(3);
    // Newest first.
    expect(rows[0]).toHaveTextContent("shop has drifted");
    expect(rows[0]).toHaveTextContent("New box, Checked by hand");
  });

  test("the newest check is open beside the list, with what it found", async () => {
    await renderWith(sampleEvents());

    const detail = screen.getByRole("complementary", { name: "Check detail" });
    expect(within(detail).getByRole("heading", { name: "shop has drifted" })).toBeInTheDocument();
    expect(within(detail).getByText("Tables added")).toBeInTheDocument();
    expect(within(detail).getByText("Tables changed")).toBeInTheDocument();
    expect(within(detail).queryByText("Tables removed")).not.toBeInTheDocument();
    expect(within(detail).getByText("2 tables differ from the baseline.")).toBeInTheDocument();
    expect(within(detail).getByRole("link", { name: "Open in Drift" })).toHaveAttribute(
      "href",
      "/test-org/drift?tab=detail&schema=7"
    );
  });

  test("pressing a row opens that check", async () => {
    await renderWith(sampleEvents());

    const row = screen.getByRole("button", { name: /billing could not be reached/ });
    fireEvent.click(row);

    expect(row).toHaveAttribute("aria-current", "true");
    const detail = screen.getByRole("complementary", { name: "Check detail" });
    expect(within(detail).getByText("The database did not answer.")).toBeInTheDocument();
    expect(within(detail).getByRole("link", { name: "Open in Drift" })).toHaveAttribute(
      "href",
      "/test-org/drift?tab=detail&schema=8"
    );
  });
});

describe("filters", () => {
  test("each result button carries its count and narrows the list", async () => {
    await renderWith(sampleEvents());

    const kinds = screen.getByRole("group", { name: "Filter by result" });
    expect(within(kinds).getByRole("button", { name: /^All/ })).toHaveTextContent("3");
    const unreachable = within(kinds).getByRole("button", { name: /^Unreachable/ });
    expect(unreachable).toHaveTextContent("1");

    fireEvent.click(unreachable);

    expect(unreachable).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: /shop has drifted/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /billing could not be reached/ })).toBeInTheDocument();
  });

  test("search with no match offers to clear every filter", async () => {
    await renderWith(sampleEvents());

    fireEvent.change(screen.getByRole("searchbox", { name: "Search the activity" }), {
      target: { value: "no such thing" },
    });
    expect(screen.getByRole("heading", { name: "Nothing matches" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Check detail" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear every filter" }));
    expect(screen.getAllByRole("button", { name: /has drifted|is in sync|could not be reached/ })).toHaveLength(3);
  });

  test("picking a schema shows only its checks", async () => {
    await renderWith(sampleEvents());

    fireEvent.click(screen.getByRole("combobox", { name: "Schema" }));
    fireEvent.click(screen.getByRole("option", { name: "billing on Legacy box" }));

    expect(screen.queryByRole("button", { name: /shop has drifted/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^.*billing/ }).length).toBeGreaterThan(0);
  });

  test("picking a day in the strip shows only that day, and it can be undone", async () => {
    await renderWith(sampleEvents());

    const strip = screen.getByRole("region", { name: "Checks per day, last 30 days" });
    expect(within(strip).getByText("3 checks on 2 days")).toBeInTheDocument();
    const day = within(strip).getByRole("button", { name: /2 checks, 1 unreachable/ });

    fireEvent.click(day);

    expect(day).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: /shop has drifted/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /billing is in sync/ })).toBeInTheDocument();

    fireEvent.click(within(strip).getByRole("button", { name: "Show all 30 days" }));
    expect(screen.getByRole("button", { name: /shop has drifted/ })).toBeInTheDocument();
  });
});

describe("the helpers in lib/activity", () => {
  test("a CSV cell doubles quotes and cannot start a formula", () => {
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("=SUM(A1)")).toBe(`"'=SUM(A1)"`);
    expect(csvCell("-1")).toBe(`"'-1"`);
    expect(csvCell("plain")).toBe('"plain"');
  });

  test("the CSV has a header and one row per check", () => {
    const events = sampleEvents();
    const lines = activityCsv(events).trimEnd().split("\r\n");

    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('"When","Schema","Connection","Result","Started by","Summary","Acknowledged"');
    expect(lines[1]).toBe(
      `"${events[0].detectedAt}","shop","New box","Drifted","Checked by hand","2 tables differ from the baseline.",""`
    );
  });

  test("counts are read carefully from the free-form detail", () => {
    expect(countLines(null)).toEqual([]);
    expect(countLines("nonsense")).toEqual([]);
    expect(countLines({ tablesAdded: "2", tablesRemoved: 3, objectsChanged: 1 })).toEqual([
      { label: "Tables removed", count: 3 },
      { label: "Other objects changed", count: 1 },
    ]);
  });

  test("the day strip ends today and holds the days asked for", () => {
    const now = new Date(2026, 10, 12, 9, 30).getTime();
    const days = lastDays(now, 30);

    expect(days).toHaveLength(30);
    expect(days[29]).toBe("2026-11-12");
    expect(days[0]).toBe("2026-10-14");
    expect(dayKey(now)).toBe("2026-11-12");
  });

  test("filters combine", () => {
    const [drifted, inSync] = sampleEvents();

    expect(matchesFilters(drifted, NO_FILTERS)).toBe(true);
    expect(matchesFilters(drifted, { ...NO_FILTERS, kind: "in_sync" })).toBe(false);
    expect(matchesFilters(inSync, { ...NO_FILTERS, source: "scheduled", schema: "8" })).toBe(true);
    expect(matchesFilters(inSync, { ...NO_FILTERS, source: "manual" })).toBe(false);
    expect(matchesFilters(drifted, { ...NO_FILTERS, search: "NEW BOX" })).toBe(true);
    expect(matchesFilters(drifted, { ...NO_FILTERS, kind: "acknowledged" })).toBe(false);
  });

  test("the help blurb fits the page header", () => {
    expect(historyHelp.blurb.split(/\s+/).length).toBeLessThanOrEqual(15);
  });
});
