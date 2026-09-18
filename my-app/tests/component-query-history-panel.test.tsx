/** @jest-environment jsdom */

/**
 * The History tab: spec feature 8, "store query history for comparison", and
 * feature 10's "compare historical performance with current performance", as a
 * screen.
 *
 * One list with two modes, and the second mode is the point. A single
 * measurement is a fact about one afternoon; the question people actually
 * bring to this screen is "is this worse than it was". Three failures are
 * worth a suite:
 *
 *   An empty list says something about who has looked, not about the schema.
 *   Nothing here is collected in the background — a row appears only when
 *   somebody analyses a query — so an empty chart in place of the explanation
 *   would read as "nothing here has ever been slow", which the app has no way
 *   of knowing.
 *
 *   An estimate has no timing. EXPLAIN without ANALYZE returns no exec time
 *   and no row count, and printing those as 0 would be a claim that the query
 *   took no time and returned nothing. They are dashes; and a window in which
 *   nothing was timed says so rather than drawing a flat line along the floor.
 *
 *   A baseline belongs to one query. The chosen run is remembered together
 *   with the fingerprint it was chosen under, so opening a different query
 *   cannot ask the server to compare it against a run that is not in that
 *   query's history at all.
 *
 * What is NOT here:
 *  - The comparison itself: the verdict, the deltas and the threshold for
 *    calling a query slower are lib/query-history, with its own suite. What is
 *    checked below is that what the server decided reaches the screen intact,
 *    not whether it decided right.
 *  - fingerprintQuery, the score and bandFor: their own suites.
 *  - The route that serves the rows, and the pruning that retires them:
 *    tests/performance-routes.test.ts and tests/query-history.test.ts.
 *  - The bar heights in the day chart. They are a percentage of the peak with
 *    a floor so a fast day is still visible, they carry no text of their own,
 *    and a reader who cannot see them gets the words beside them — which is
 *    what is asserted here.
 */

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

jest.mock("next/navigation", () => require("./helpers/render-page").navigationStubs);
jest.mock("next-auth/react", () => require("./helpers/render-page").sessionStubs);

import { QueryHistoryPanel } from "@/components/studio/QueryHistoryPanel";
import type { PerfTarget } from "@/components/studio/PerfTargetPicker";
import type { QueryComparison, QueryHistoryRow } from "@/lib/query-history";
import {
  fetchCalls,
  flushAsync,
  holdNext,
  resetPageState,
  routerCalls,
  setRoutes,
} from "./helpers/render-page";

/* ----------------------------------------------------------------- fixtures */

const TARGET: PerfTarget = {
  connectionId: "7",
  connectionName: "Prod shop",
  schema: "public",
};

const FINGERPRINT = "abc123";

/** One stored analysis. Measured, with a timing, unless a test says otherwise. */
const run = (
  over: Partial<QueryHistoryRow> & { id: number; captured_at: string }
): QueryHistoryRow => ({
  connection_id: 7,
  connection_name: "Prod shop",
  schema_name: "public",
  query_text: "select * from orders where customer_id = 41",
  fingerprint: FINGERPRINT,
  exec_time_ms: 120,
  planning_ms: 2,
  rows_returned: 500,
  total_cost: 900,
  estimated_rows: 480,
  score: 72,
  band: "fair",
  measured: true,
  high_count: 0,
  medium_count: 1,
  low_count: 2,
  captured_by: "umer@example.com",
  ...over,
});

/** Three runs of the one query, newest first — the order the route sends. */
const RUNS: QueryHistoryRow[] = [
  run({ id: 3, captured_at: "2026-09-12T09:00:00.000Z", exec_time_ms: 120, score: 72 }),
  run({ id: 2, captured_at: "2026-09-11T09:00:00.000Z", exec_time_ms: 95, score: 78 }),
  run({ id: 1, captured_at: "2026-09-10T09:00:00.000Z", exec_time_ms: 80, score: 81 }),
];

/** A run of a different query, for the schema-wide list. */
const OTHER = run({
  id: 9,
  captured_at: "2026-09-13T09:00:00.000Z",
  fingerprint: "zzz999",
  query_text: "select count(*) from items",
  score: 91,
});

const COMPARISON: QueryComparison = {
  execTimeDeltaMs: 25,
  execTimeRatio: 1.26,
  scoreDelta: -6,
  costRatio: 1.1,
  rowsDelta: 40,
  verdict: "This run was 26% slower than the one before it.",
};

const TREND = [
  { day: "2026-09-10", runs: 3, measuredRuns: 2, medianExecMs: 90, maxExecMs: 140, medianScore: 70 },
  { day: "2026-09-12", runs: 1, measuredRuns: 1, medianExecMs: 120, maxExecMs: 120, medianScore: 72 },
];

/** What /api/performance/history answers with. */
const historyView = (over: Record<string, unknown> = {}) => ({
  connectionName: TARGET.connectionName,
  schema: TARGET.schema,
  fingerprint: null,
  rows: RUNS,
  days: 30,
  trend: TREND,
  comparison: null,
  baselineId: null,
  baselineNote: null,
  retentionDays: 45,
  maxRows: 2000,
  pageSize: 50,
  ...over,
});

const answers = (body: unknown, status = 200) => [
  { match: "/api/performance/history", status, body },
];

/* ------------------------------------------------------------------ helpers */

function show(
  target: PerfTarget | null = TARGET,
  fingerprint: string | null = null
) {
  return render(<QueryHistoryPanel target={target} fingerprint={fingerprint} />);
}

/** The chart heading, which is only on screen once there are rows to draw. */
const listed = () => screen.findByText("Median time per day");

/** Every history request the screen has made so far. */
const requests = () => fetchCalls.filter((call) => call.url.includes("/api/performance/history"));

/** What the screen prints for a stored timestamp, in this run's locale. */
const shown = (at: string) => new Date(at).toLocaleString();

const baselinePicker = () => screen.getByLabelText("Compare against");

beforeEach(() => {
  resetPageState();
  setRoutes(answers(historyView()));
});
afterEach(() => cleanup());

/* -------------------------------------------------------------------- tests */

describe("before there is a schema to show", () => {
  it("asks for one rather than listing nothing", () => {
    show(null);

    expect(
      screen.getByText(/Choose a PostgreSQL connection and a schema above/)
    ).toBeInTheDocument();
    expect(requests()).toHaveLength(0);
  });

  it("asks for the history of the schema it was given, and nothing else", async () => {
    show();

    await listed();
    expect(requests()).toHaveLength(1);
    expect(requests()[0].url).toContain("connectionId=7");
    expect(requests()[0].url).toContain("schema=public");
    expect(requests()[0].url).toContain("days=30");
    expect(requests()[0].url).not.toContain("fingerprint=");
    expect(requests()[0].url).not.toContain("baseline=");
  });

  it("names the one query in the request when it was given one", async () => {
    show(TARGET, FINGERPRINT);

    await listed();
    expect(requests()[0].url).toContain(`fingerprint=${FINGERPRINT}`);
  });
});

describe("when nothing has been analysed here", () => {
  it("explains who fills the list, and offers the screen that does it", async () => {
    // The whole point. Nothing arrives here on its own, so an empty list is a
    // statement about who has looked — never about whether the schema is slow.
    setRoutes(answers(historyView({ rows: [] })));
    show();

    expect(
      await screen.findByText("Nothing has been analysed against this schema yet")
    ).toBeInTheDocument();
    expect(screen.getByText(/Nothing is collected in the background/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Analyse a query/ })).toHaveAttribute(
      "href",
      "/performance?tab=analyse"
    );
  });

  it("has different words for one query with no runs, and names the window", async () => {
    // "Never analysed" and "analysed, but longer ago than we keep" are two
    // different answers, and only one of them is fixed by analysing it again.
    setRoutes(answers(historyView({ rows: [], retentionDays: 45 })));
    show(TARGET, FINGERPRINT);

    expect(await screen.findByText("No runs of that query")).toBeInTheDocument();
    expect(screen.getByText(/aged out of the 45-day window/)).toBeInTheDocument();
  });
});

describe("what one stored run says", () => {
  it("prints the score, the timing and who ran it", async () => {
    setRoutes(answers(historyView({ rows: [RUNS[0]] })));
    show();

    await listed();
    expect(screen.getByText("72 / 100")).toBeInTheDocument();
    expect(screen.getByText("Measured")).toBeInTheDocument();
    expect(screen.getByText("120 ms · 500 rows")).toBeInTheDocument();
    expect(
      screen.getByText(`${shown("2026-09-12T09:00:00.000Z")} · umer@example.com`)
    ).toBeInTheDocument();
    expect(screen.getByText("0 high · 1 medium · 2 low")).toBeInTheDocument();
  });

  it("shows an estimate's missing numbers as dashes, never as zeros", async () => {
    // A 0 would say the query took no time and returned nothing. It was simply
    // never run: EXPLAIN without ANALYZE has neither number to report.
    setRoutes(
      answers(
        historyView({
          rows: [run({ id: 4, captured_at: "2026-09-12T09:00:00.000Z", measured: false, exec_time_ms: null, rows_returned: null })],
          // No trend either, so the "0 ms" and "0 rows" checks below can only
          // be answered by the row itself.
          trend: [],
        })
      )
    );
    show();

    await listed();
    expect(screen.getByText("Estimated")).toBeInTheDocument();
    expect(screen.getByText("— · —")).toBeInTheDocument();
    // Anchored, so the retention line's "2,000 rows" cannot answer for the row.
    expect(screen.queryByText(/^0 ms · /)).not.toBeInTheDocument();
    expect(screen.queryByText(/ · 0 rows$/)).not.toBeInTheDocument();
  });

  it("leaves the findings line off a run that had no findings", async () => {
    setRoutes(
      answers(
        historyView({
          rows: [run({ id: 5, captured_at: "2026-09-12T09:00:00.000Z", high_count: 0, medium_count: 0, low_count: 0 })],
        })
      )
    );
    show();

    await listed();
    expect(screen.queryByText(/high · /)).not.toBeInTheDocument();
  });

  it("says how long rows are kept, so a short list is not read as a quiet schema", async () => {
    show();

    await listed();
    expect(
      screen.getByText("Kept for 45 days, up to 2,000 rows per schema.")
    ).toBeInTheDocument();
  });
});

describe("the two modes", () => {
  it("lists the whole schema with a way into each query", async () => {
    setRoutes(answers(historyView({ rows: [OTHER, RUNS[0]] })));
    show();

    await listed();
    expect(screen.getByText("Recently analysed")).toBeInTheDocument();
    expect(screen.queryByText("One query")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Every run" })).toHaveLength(2);
  });

  it("opens one query through the URL, so the screen can be linked to", async () => {
    setRoutes(answers(historyView({ rows: [OTHER, RUNS[0]] })));
    show();

    await listed();
    fireEvent.click(screen.getAllByRole("button", { name: "Every run" })[0]);

    expect(routerCalls.push).toEqual([
      "/performance?tab=history&connectionId=7&schema=public&fingerprint=zzz999",
    ]);
  });

  it("drops the per-row button in one-query mode, where it would reload the same page", async () => {
    setRoutes(answers(historyView({ fingerprint: FINGERPRINT })));
    show(TARGET, FINGERPRINT);

    await listed();
    expect(screen.getByText("One query")).toBeInTheDocument();
    expect(screen.getByText("3 runs of this query, newest first.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Every run" })).not.toBeInTheDocument();
  });

  it("counts one run in words rather than as “1 runs”", async () => {
    setRoutes(answers(historyView({ rows: [RUNS[0]], fingerprint: FINGERPRINT })));
    show(TARGET, FINGERPRINT);

    await listed();
    expect(screen.getByText("This query has been analysed once.")).toBeInTheDocument();
  });

  it("goes back to the whole schema through the URL too", async () => {
    setRoutes(answers(historyView({ fingerprint: FINGERPRINT })));
    show(TARGET, FINGERPRINT);

    await listed();
    fireEvent.click(screen.getByRole("button", { name: "Show the whole schema" }));

    expect(routerCalls.push).toEqual([
      "/performance?tab=history&connectionId=7&schema=public",
    ]);
  });
});

describe("the newest run set against an earlier one", () => {
  const compared = (over: Record<string, unknown> = {}) =>
    answers(
      historyView({
        fingerprint: FINGERPRINT,
        comparison: COMPARISON,
        baselineId: 2,
        ...over,
      })
    );

  it("prints the verdict, both deltas and the rows", async () => {
    setRoutes(compared());
    show(TARGET, FINGERPRINT);

    await listed();
    expect(screen.getByText(COMPARISON.verdict)).toBeInTheDocument();
    expect(screen.getByText("+25 ms · score -6 · +40 rows")).toBeInTheDocument();
  });

  it("names both runs, because the baseline is no longer always the previous one", async () => {
    setRoutes(compared());
    show(TARGET, FINGERPRINT);

    await listed();
    expect(
      screen.getByText(
        `${shown("2026-09-12T09:00:00.000Z")} against ${shown("2026-09-11T09:00:00.000Z")}`
      )
    ).toBeInTheDocument();
  });

  it("says “an earlier run” rather than naming one it cannot find", async () => {
    // Only reachable if the row list and the id the server compared against
    // ever disagree. Naming the wrong run would be worse than being vague.
    setRoutes(compared({ baselineId: 404 }));
    show(TARGET, FINGERPRINT);

    await listed();
    expect(
      screen.getByText(`${shown("2026-09-12T09:00:00.000Z")} against an earlier run`)
    ).toBeInTheDocument();
  });

  it("says there is no timing to compare rather than printing a delta of zero", async () => {
    setRoutes(compared({ comparison: { ...COMPARISON, execTimeDeltaMs: null, rowsDelta: null } }));
    show(TARGET, FINGERPRINT);

    await listed();
    expect(
      screen.getByText(/No timing to compare — one of the two runs was an estimate/)
    ).toBeInTheDocument();
  });

  it("marks the two runs the verdict is about, in a list where they are not adjacent", async () => {
    setRoutes(compared());
    show(TARGET, FINGERPRINT);

    await listed();
    expect(screen.getByText("Newest")).toBeInTheDocument();
    expect(screen.getByText("Baseline")).toBeInTheDocument();
  });

  it("marks nothing at all when there is nothing to compare", async () => {
    setRoutes(answers(historyView({ rows: [RUNS[0]], fingerprint: FINGERPRINT })));
    show(TARGET, FINGERPRINT);

    await listed();
    expect(screen.queryByText("Newest")).not.toBeInTheDocument();
    expect(
      screen.getByText(/There is nothing to compare it to yet\. Analyse it again/)
    ).toBeInTheDocument();
  });

  it("passes on the server's note about the baseline it actually used", async () => {
    setRoutes(compared({ baselineNote: "That run has aged out; the previous one was used." }));
    show(TARGET, FINGERPRINT);

    await listed();
    expect(
      screen.getByText("That run has aged out; the previous one was used.")
    ).toBeInTheDocument();
  });
});

describe("choosing what to compare against", () => {
  const compared = (over: Record<string, unknown> = {}) =>
    answers(historyView({ fingerprint: FINGERPRINT, comparison: COMPARISON, baselineId: 2, ...over }));

  it("offers every earlier run, and not the run being measured", async () => {
    // Comparing the newest run with itself would print "about the same", which
    // reads as a finding and is not one.
    setRoutes(compared());
    show(TARGET, FINGERPRINT);

    await listed();
    const options = Array.from(baselinePicker().querySelectorAll("option")).map((o) => o.textContent);
    expect(options).toEqual([
      "The previous run",
      `${shown("2026-09-11T09:00:00.000Z")} — 95 ms`,
      `${shown("2026-09-10T09:00:00.000Z")} — 80 ms`,
    ]);
  });

  it("is not offered at all when there is only one run to choose from", async () => {
    setRoutes(compared({ rows: [RUNS[0]] }));
    show(TARGET, FINGERPRINT);

    await listed();
    expect(screen.queryByLabelText("Compare against")).not.toBeInTheDocument();
  });

  it("stays on “the previous run” while the chosen run is the previous run", async () => {
    // Pinning an id would freeze the comparison on one run as new ones arrive;
    // the default is meant to follow the list.
    setRoutes(compared());
    show(TARGET, FINGERPRINT);

    await listed();
    expect(baselinePicker()).toHaveValue("");
  });

  it("asks the server to compare against the run that was picked", async () => {
    setRoutes(compared());
    show(TARGET, FINGERPRINT);

    await listed();
    fireEvent.change(baselinePicker(), { target: { value: "1" } });

    await waitFor(() => expect(requests()).toHaveLength(2));
    expect(requests()[1].url).toContain("baseline=1");
  });

  it("forgets the picked run when a different query is opened", async () => {
    // A run id belongs to one query. Carrying it across would ask the server to
    // compare this query against a run that is not in its history at all.
    setRoutes(compared());
    const { rerender } = render(
      <QueryHistoryPanel target={TARGET} fingerprint={FINGERPRINT} />
    );

    await listed();
    fireEvent.change(baselinePicker(), { target: { value: "1" } });
    await waitFor(() => expect(requests()).toHaveLength(2));
    expect(requests()[1].url).toContain("baseline=1");

    rerender(<QueryHistoryPanel target={TARGET} fingerprint="zzz999" />);

    await waitFor(() => expect(requests()).toHaveLength(3));
    expect(requests()[2].url).toContain("fingerprint=zzz999");
    expect(requests()[2].url).not.toContain("baseline=");
  });
});

describe("the day chart", () => {
  it("ends the axis at the days it has, and names the peak", async () => {
    show();

    await listed();
    expect(screen.getByText("2026-09-10")).toBeInTheDocument();
    expect(screen.getByText("2026-09-12")).toBeInTheDocument();
    expect(screen.getByText("peak median 120 ms")).toBeInTheDocument();
  });

  it("says a window had nothing timed rather than drawing a flat line at zero", async () => {
    // Every run in the window was an estimate. A line along the floor would
    // read as "instant", which is the opposite of what happened.
    setRoutes(
      answers(historyView({ trend: TREND.map((p) => ({ ...p, medianExecMs: null, maxExecMs: null })) }))
    );
    show();

    await listed();
    expect(screen.getByText(/Nothing in this window was timed/)).toBeInTheDocument();
    expect(screen.queryByText(/peak median/)).not.toBeInTheDocument();
  });
});

describe("changing the question", () => {
  it("asks again for the window that was picked", async () => {
    show();

    await listed();
    fireEvent.click(screen.getByRole("button", { name: "90 days" }));

    await waitFor(() => expect(requests()).toHaveLength(2));
    expect(requests()[1].url).toContain("days=90");
  });

  it("keeps the picked baseline when only the window changes", async () => {
    setRoutes(answers(historyView({ fingerprint: FINGERPRINT, comparison: COMPARISON, baselineId: 2 })));
    show(TARGET, FINGERPRINT);

    await listed();
    fireEvent.change(baselinePicker(), { target: { value: "1" } });
    await waitFor(() => expect(requests()).toHaveLength(2));

    await listed();
    fireEvent.click(screen.getByRole("button", { name: "7 days" }));

    await waitFor(() => expect(requests()).toHaveLength(3));
    expect(requests()[2].url).toContain("days=7");
    expect(requests()[2].url).toContain("baseline=1");
  });

  it("clears the list while the new answer is being read", async () => {
    // Leaving 90 days of rows under a button that now says 7 would be a list
    // captioned with a window it is not of.
    show();

    await listed();
    const release = holdNext("/api/performance/history");
    fireEvent.click(screen.getByRole("button", { name: "7 days" }));

    await waitFor(() => expect(screen.queryByText("Median time per day")).not.toBeInTheDocument());
    release();
    expect(await listed()).toBeInTheDocument();
  });

  it("does not let a slow answer land on a question nobody asked any more", async () => {
    const { rerender } = render(<QueryHistoryPanel target={TARGET} fingerprint={null} />);
    await listed();

    const releaseFirst = holdNext("/api/performance/history");
    rerender(<QueryHistoryPanel target={{ ...TARGET, schema: "sales" }} fingerprint={null} />);
    // From here the answer carries one row, so it cannot be mistaken for the
    // three-row answer still held above.
    setRoutes(answers(historyView({ rows: [OTHER] })));
    rerender(<QueryHistoryPanel target={{ ...TARGET, schema: "billing" }} fingerprint={null} />);
    await waitFor(() => expect(requests()).toHaveLength(3));
    await screen.findByText("select count(*) from items");

    releaseFirst();
    await flushAsync();

    expect(screen.getByText("select count(*) from items")).toBeInTheDocument();
    expect(screen.queryByText(/select \* from orders/)).not.toBeInTheDocument();
  });
});

describe("when the history cannot be read", () => {
  it("shows what the server said rather than an empty list", async () => {
    setRoutes(answers({ error: "That connection is not a PostgreSQL one." }, 400));
    show();

    expect(await screen.findByText("Could not read the query history")).toBeInTheDocument();
    expect(screen.getByText(/That connection is not a PostgreSQL one\./)).toBeInTheDocument();
  });

  it("has its own words for a server it could not reach at all", async () => {
    setRoutes([{ match: "/api/performance/history", networkError: true }]);
    show();

    expect(
      await screen.findByText(/Could not reach the server to read the history/)
    ).toBeInTheDocument();
  });
});
