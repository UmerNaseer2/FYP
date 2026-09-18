/** @jest-environment jsdom */

/**
 * The audit log: every drift check that has been recorded, and the filters over
 * it.
 *
 * The log's whole claim is that it is the complete record, so the parts that
 * hide rows are the parts worth testing:
 *
 *   A filter that finds nothing says so in the language of a filter. "No drift
 *   checks have been recorded yet" under a search box with text in it would
 *   read as data loss — the reader would go looking for the checks they know
 *   ran. The two empty states are separated on whether the log itself is empty,
 *   not on whether the list on screen is.
 *
 *   The controls stay away until there is something to control. Five chips
 *   reading 0 and a search box over an empty log are controls for work that has
 *   not happened yet.
 *
 *   Acknowledged is not a status. A drifted check that somebody has since
 *   acknowledged is still drifted, so it belongs in both views — the chip reads
 *   the acknowledgement column, and every other chip reads the status column.
 *
 *   The search covers what ran the check. "Checked on schedule" is not text in
 *   any column of the row's data, it is a label this app writes, and a reader
 *   asking "what has the scheduler been doing" searches for the words they can
 *   see.
 *
 * What is NOT here:
 *  - Where the rows come from. The Drift screen fetches them and hands them
 *    over; tests/page-drift.test.tsx covers the audit tab failing to load and
 *    the log being empty. It passes no rows, so before this file the table
 *    itself had never been drawn with any.
 *  - The order. This table shows rows in the order it is handed them, and the
 *    footer's "newest first" is a claim about the query that produced them:
 *    listDriftEvents in lib/lineage-db orders by detected_at then id, in SQL,
 *    and has no suite of its own. What is pinned here is that the table does
 *    not disturb that order.
 *  - What the source labels say. lib/drift-source owns them and is covered by
 *    tests/drift-source.test.ts; this file only checks that the label is shown
 *    and is searchable.
 *  - How "5m ago" is worded. lib/time-ago has no suite of its own; the clock is
 *    fixed here so the column can be read, but the wording is its rule, not
 *    this table's.
 *  - Acknowledging a check. That is a button on the drift detail screen, not
 *    here — this column only reports what it already says.
 */

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

jest.mock("next/navigation", () => require("./helpers/render-page").navigationStubs);

import { AuditLogTable, type AuditRow } from "@/components/studio/AuditLogTable";
import { resetPageState, routerCalls } from "./helpers/render-page";

/** A fixed clock, so the "When" column reads the same on every run. */
const NOW = new Date("2026-06-09T14:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

function row(over: Partial<AuditRow> = {}): AuditRow {
  return {
    id: 1,
    trackedSchemaId: 11,
    schemaName: "public",
    connectionName: "Prod",
    status: "drifted",
    summary: "2 tables changed",
    detectedAt: ago(5 * MIN),
    acknowledgedAt: null,
    source: "scheduled",
    ...over,
  };
}

/**
 * Five checks: every status, one of them twice, and two acknowledgements.
 *
 * An acknowledgement is itself a recorded check — POST /api/lineage/acknowledge
 * re-reads the schema and writes a row stamped "acknowledged" — which is why
 * those two rows say a person ran them rather than naming the original trigger.
 */
const DRIFTED = row();
const IN_SYNC = row({
  id: 2,
  trackedSchemaId: 12,
  schemaName: "billing",
  connectionName: "Staging",
  status: "in_sync",
  summary: null,
  detectedAt: ago(3 * HOUR),
  source: "manual",
});
const SESSIONS = row({
  id: 3,
  trackedSchemaId: 13,
  schemaName: "sessions",
  connectionName: "Analytics",
  status: "in_sync",
  summary: "no changes since the baseline",
  detectedAt: ago(HOUR),
  source: "manual",
});
const UNREACHABLE = row({
  id: 4,
  trackedSchemaId: 14,
  schemaName: "reporting",
  connectionName: null,
  status: "unreachable",
  summary: "could not connect",
  detectedAt: ago(2 * DAY),
  acknowledgedAt: ago(DAY),
  source: "acknowledged",
});
const ACKED_DRIFT = row({
  id: 5,
  trackedSchemaId: 15,
  schemaName: "archive",
  status: "drifted",
  summary: "one column dropped",
  detectedAt: ago(30_000),
  acknowledgedAt: ago(10 * MIN),
  source: "acknowledged",
});
/** Newest first, as the query hands them over. */
const ROWS = [ACKED_DRIFT, DRIFTED, SESSIONS, IN_SYNC, UNREACHABLE];

const mount = (rows: AuditRow[] = ROWS) => render(<AuditLogTable rows={rows} />);

/** The schema each visible row is about, in the order they are drawn. */
const shown = () =>
  screen
    .queryAllByRole("row")
    .slice(1)
    .map((r) => r.querySelector(".audit-row__link")?.firstChild?.textContent ?? "");

/** A filter chip, found by the label in front of its count. */
const chip = (label: string) =>
  screen.getAllByRole("button").find((b) => b.textContent?.startsWith(label)) as HTMLElement;
const chipCount = (label: string) => chip(label).querySelector(".mono")?.textContent;

const search = () => screen.getByLabelText("Search the audit log");
const type = (text: string) => fireEvent.change(search(), { target: { value: text } });

/** One row's cells, by the label the responsive layout prints beside them. */
const cell = (schema: string, label: string) => {
  const tr = screen
    .getAllByRole("row")
    .find((r) => r.querySelector(".audit-row__link")?.firstChild?.textContent === schema);
  return within(tr as HTMLElement).getByText((_, el) => el?.getAttribute("data-label") === label);
};

beforeEach(() => {
  resetPageState();
  // "5m ago" has to mean something fixed, and this table prints four of them.
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

describe("before any check has been recorded", () => {
  it("says so, and keeps the controls away until there is something to control", () => {
    mount([]);

    expect(
      screen.getByText(
        "No drift checks have been recorded yet. Run a check from the Drift detail tab or the dashboard."
      )
    ).toBeInTheDocument();
    // Nothing offers to filter or search a log with nothing in it. The chips
    // are hidden, which is also what takes them out of the accessibility tree,
    // so a screen reader is not offered five filters over nothing either.
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(search()).not.toBeVisible();
    expect(screen.getByText(/Showing 0 of 0/)).not.toBeVisible();
  });
});

describe("what one row says", () => {
  it("shows when, what ran it, the status, the summary, the schema and the server", () => {
    mount([DRIFTED]);

    expect(cell("public", "When")).toHaveTextContent("5m ago");
    expect(cell("public", "By")).toHaveTextContent("Checked on schedule");
    expect(cell("public", "Status")).toHaveTextContent("Drifted");
    expect(cell("public", "Summary")).toHaveTextContent("2 tables changed");
    expect(cell("public", "Connection")).toHaveTextContent("Prod");
  });

  it("says a check found nothing to summarise, rather than leaving the cell blank", () => {
    mount([IN_SYNC]);
    expect(cell("billing", "Summary")).toHaveTextContent("—");
  });

  it("says the connection is gone rather than naming nothing", () => {
    // The row outlives the connection it was recorded against, and a blank
    // cell would read as a row that failed to load the rest of itself.
    mount([UNREACHABLE]);
    expect(cell("reporting", "Connection")).toHaveTextContent("removed");
  });

  it("marks a check somebody has acknowledged, and says when", () => {
    mount([UNREACHABLE]);

    const status = cell("reporting", "Status");
    expect(status).toHaveTextContent("Unreachable");
    expect(status).toHaveTextContent("ack'd");
    expect(status.querySelector("[title]")).toHaveAttribute("title", "Acknowledged 1d ago");
  });

  it("leaves an unacknowledged check unmarked", () => {
    mount([DRIFTED]);
    expect(cell("public", "Status")).not.toHaveTextContent("ack'd");
  });

  it("gives each status its own word", () => {
    mount(ROWS);
    expect(cell("public", "Status")).toHaveTextContent("Drifted");
    expect(cell("billing", "Status")).toHaveTextContent("In sync");
    expect(cell("reporting", "Status")).toHaveTextContent("Unreachable");
  });
});

describe("opening a check", () => {
  it("links the schema to that schema's drift detail", () => {
    mount([DRIFTED]);
    expect(screen.getByRole("link", { name: /^public/ })).toHaveAttribute(
      "href",
      "/drift?tab=detail&schema=11"
    );
  });

  it("tells a screen reader which check the link is for", () => {
    // Four rows about the same schema are four links reading "public", and
    // the one thing that separates them is what is only in the other columns.
    mount([DRIFTED]);
    expect(
      screen.getByRole("link", {
        name: "public — open the drift detail for this check, drifted 5m ago",
      })
    ).toBeInTheDocument();
  });

  it("opens the same page when the row itself is clicked", () => {
    mount([DRIFTED]);
    fireEvent.click(cell("public", "Summary"));
    expect(routerCalls.push).toEqual(["/drift?tab=detail&schema=11"]);
  });

  it("does not also ask the router when the link is the thing clicked", () => {
    // The link navigates on its own; letting the click reach the row would
    // ask for the same page a second time.
    mount([DRIFTED]);
    fireEvent.click(screen.getByRole("link", { name: /^public/ }));
    expect(routerCalls.push).toEqual([]);
  });
});

describe("the filter chips", () => {
  it("count what each one would show", () => {
    mount();
    expect(chipCount("All")).toBe("5");
    expect(chipCount("Drifted")).toBe("2");
    expect(chipCount("In sync")).toBe("2");
    expect(chipCount("Unreachable")).toBe("1");
    // Two of five, so a chip counting the other side of this column would
    // not happen to print the same number.
    expect(chipCount("Acknowledged")).toBe("2");
  });

  it("narrows to one status", () => {
    mount();
    fireEvent.click(chip("In sync"));
    expect(shown()).toEqual(["sessions", "billing"]);
  });

  it("keep counting the whole log while the table shows part of it", () => {
    // The chips are the breakdown of the log, not of what survived the last
    // thing typed. Counting the rows on screen would make every chip but the
    // active one read 0 the moment a search narrowed the table, and there
    // would be nothing left on the screen saying how much had been hidden.
    mount();
    type("archive");
    expect(shown()).toEqual(["archive"]);
    expect(chipCount("All")).toBe("5");
    expect(chipCount("Drifted")).toBe("2");
    expect(chipCount("In sync")).toBe("2");
    expect(chipCount("Unreachable")).toBe("1");
    expect(chipCount("Acknowledged")).toBe("2");
  });

  it("keeps an acknowledged check in the status it is still in", () => {
    // Acknowledging is not a fix. A drifted schema somebody has looked at is
    // still drifted, and dropping it out of Drifted would hide live drift.
    mount();
    fireEvent.click(chip("Drifted"));
    expect(shown()).toEqual(["archive", "public"]);
  });

  it("crosses the statuses when asked what has been acknowledged", () => {
    mount();
    fireEvent.click(chip("Acknowledged"));
    expect(shown()).toEqual(["archive", "reporting"]);
  });

  it("goes back to everything", () => {
    mount();
    fireEvent.click(chip("Unreachable"));
    fireEvent.click(chip("All"));
    expect(shown()).toEqual(["archive", "public", "sessions", "billing", "reporting"]);
  });

  it("says a filter is the reason the list is empty, not that nothing was recorded", () => {
    mount([DRIFTED]);
    fireEvent.click(chip("Unreachable"));

    expect(screen.getByText("No audit rows match this filter.")).toBeInTheDocument();
    expect(screen.queryByText(/No drift checks have been recorded yet/)).not.toBeInTheDocument();
    // And the chips stay, because they are how the reader gets back.
    expect(chip("All")).toBeVisible();
  });
});

describe("the search box", () => {
  it("matches the schema", () => {
    mount();
    type("billing");
    expect(shown()).toEqual(["billing"]);
  });

  it("matches the connection, whatever case it is typed in", () => {
    mount();
    type("STAGING");
    expect(shown()).toEqual(["billing"]);
  });

  it("matches the summary", () => {
    mount();
    type("column dropped");
    expect(shown()).toEqual(["archive"]);
  });

  it("matches what ran the check", () => {
    // "Checked on schedule" is this app's own wording, not a column of the
    // row — and it is the wording a reader can see, so it is what they type.
    mount();
    type("on schedule");
    expect(shown()).toEqual(["public"]);
  });

  it("ignores space either side of what was typed", () => {
    mount();
    type("  Prod  ");
    expect(shown()).toEqual(["archive", "public"]);
  });

  it("narrows within the filter rather than replacing it", () => {
    mount();
    fireEvent.click(chip("Drifted"));
    type("archive");
    expect(shown()).toEqual(["archive"]);
  });

  it("finds nothing that the filter has already excluded", () => {
    mount();
    fireEvent.click(chip("In sync"));
    type("archive");
    expect(screen.getByText("No audit rows match this filter.")).toBeInTheDocument();
  });

  it("shows everything again once it is cleared", () => {
    mount();
    type("billing");
    type("");
    expect(shown()).toEqual(["archive", "public", "sessions", "billing", "reporting"]);
  });
});

describe("the line under the table", () => {
  it("says how much of the log is on screen", () => {
    mount();
    fireEvent.click(chip("Drifted"));
    expect(
      screen.getByText("Showing 2 of 5 recorded checks · newest first.")
    ).toBeInTheDocument();
  });

  it("counts a single check as one", () => {
    mount([DRIFTED]);
    expect(
      screen.getByText("Showing 1 of 1 recorded check · newest first.")
    ).toBeInTheDocument();
  });

  it("keeps the plural when the filter leaves one row of many", () => {
    // "recorded check" is counted by the log, which is the number right in
    // front of it: one row out of five is still "1 of 5 recorded checks".
    // Agreeing with the row count instead would read "1 of 5 recorded check".
    mount();
    fireEvent.click(chip("Unreachable"));
    expect(
      screen.getByText("Showing 1 of 5 recorded checks · newest first.")
    ).toBeInTheDocument();
  });
});

describe("the order", () => {
  it("shows the rows in the order it was handed them", () => {
    // The query sorts, not this table — so a table that sorted again would
    // be a second opinion about "newest first" with no clock behind it.
    mount([IN_SYNC, UNREACHABLE, ACKED_DRIFT, DRIFTED]);
    expect(shown()).toEqual(["billing", "reporting", "archive", "public"]);
  });

  it("keeps that order through a filter", () => {
    mount([DRIFTED, ACKED_DRIFT]);
    fireEvent.click(chip("Drifted"));
    expect(shown()).toEqual(["public", "archive"]);
  });
});
