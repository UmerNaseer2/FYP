/** @jest-environment jsdom */

/**
 * The Trends tab: spec feature 10, monitoring, as a screen.
 *
 * Every other Performance tab reads the live database the moment you ask it.
 * This one cannot — a trend has to have been collected in advance, by the
 * drift check — and that single constraint is where all the failures here come
 * from. Three of them are worth a suite:
 *
 *   Nobody was looking is not the same as nothing happened. A schema no drift
 *   check is watching has no readings, and the honest answer is an explanation
 *   and the link that starts the watching. An empty chart in its place would
 *   be a claim about the schema that the app has no basis for.
 *
 *   A reading that could not be taken is a gap, never a zero. The size metrics
 *   need a privilege the counts do not, so on a connection without it every
 *   size reading comes back null. Drawn as zeros they would make a chart that
 *   says the schema emptied out and filled up again.
 *
 *   The answer on screen has to belong to the question on screen. Window,
 *   target and Refresh all change the request, and the one before it may still
 *   be in flight; the screen goes back to its skeleton rather than showing
 *   90 days of readings under a button that says 24 hours.
 *
 * What is NOT here:
 *  - The geometry. Every coordinate, rule, tick and caption comes out of
 *    lib/metrics-series, which is pure and has tests/metrics-series.test.ts.
 *    This suite checks which of those answers reach the screen, not how they
 *    are worked out.
 *  - describeCadence, in tests/drift-schedule.test.ts.
 *  - The route that serves the readings and the check that records them:
 *    tests/performance-routes.test.ts and tests/schema-metrics.test.ts.
 *  - How the chart LOOKS. The SVG is aria-hidden on purpose — it carries no
 *    information the sentence beside it does not — so what is asserted below
 *    is the words, which is what a reader who cannot see the line gets.
 */

import "@testing-library/jest-dom";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";

jest.mock("next/navigation", () => require("./helpers/render-page").navigationStubs);
jest.mock("next-auth/react", () => require("./helpers/render-page").sessionStubs);

import { SchemaTrends } from "@/components/studio/SchemaTrends";
import type { PerfTarget } from "@/components/studio/PerfTargetPicker";
import type { MetricSample } from "@/lib/metrics-series";
import { fetchCalls, flushAsync, holdNext, resetPageState, setRoutes } from "./helpers/render-page";

/* ----------------------------------------------------------------- fixtures */

const TARGET: PerfTarget = {
  connectionId: "7",
  connectionName: "Prod shop",
  schema: "public",
};

/** One reading, with the counts filled in and the sizes readable. */
const reading = (over: Partial<MetricSample> & { at: string }): MetricSample => ({
  tables: 12,
  columns: 90,
  indexes: 20,
  foreignKeys: 8,
  views: 3,
  routines: 1,
  totalBytes: 4_194_304,
  indexBytes: 1_048_576,
  estimatedRows: 50_000,
  drifted: false,
  ...over,
});

const TWO_READINGS: MetricSample[] = [
  reading({ at: "2026-09-10T09:00:00.000Z" }),
  reading({ at: "2026-09-12T09:00:00.000Z", tables: 14, columns: 101 }),
];

/** What /api/performance/metrics answers with. */
const metricsView = (over: Record<string, unknown> = {}) => ({
  connectionName: TARGET.connectionName,
  schema: TARGET.schema,
  tracking: {
    trackedSchemaId: 3,
    label: null,
    intervalMinutes: 60,
    lastCheckedAt: "2026-09-12T09:00:00.000Z",
  },
  days: 7,
  retentionDays: 90,
  samples: TWO_READINGS,
  ...over,
});

const answers = (body: unknown, status = 200) => [
  { match: "/api/performance/metrics", status, body },
];

/* ------------------------------------------------------------------ helpers */

function show(target: PerfTarget | null = TARGET) {
  return render(<SchemaTrends target={target} />);
}

/** The heading of the first chart, which is only on screen once readings are. */
const charted = () => screen.findByText("Tables");

const windowButton = (label: string) => screen.getByRole("button", { name: label });

/** Every metrics request the screen has made so far. */
const requests = () => fetchCalls.filter((call) => call.url.includes("/api/performance/metrics"));

beforeEach(() => {
  resetPageState();
  setRoutes(answers(metricsView()));
});
afterEach(() => cleanup());

/* -------------------------------------------------------------------- tests */

describe("before there is a schema to show", () => {
  it("asks for one rather than drawing an empty chart", () => {
    show(null);

    expect(
      screen.getByText(/Choose a PostgreSQL connection and a schema above/)
    ).toBeInTheDocument();
    expect(requests()).toHaveLength(0);
  });

  it("asks for the readings of the schema it was given, and only once", async () => {
    show();

    await charted();
    expect(requests()).toHaveLength(1);
    expect(requests()[0].url).toContain("connectionId=7");
    expect(requests()[0].url).toContain("schema=public");
    expect(requests()[0].url).toContain("days=7");
  });
});

describe("when nothing is watching the schema", () => {
  it("says so, and points at the screen that starts the watching", async () => {
    // The whole point. With no tracking there are no readings, and a chart of
    // no readings would say the schema has not changed — which the app has no
    // way of knowing. What it does know is that nobody was looking.
    setRoutes(answers(metricsView({ tracking: null, samples: [] })));
    show();

    expect(await screen.findByText("Nothing is watching this schema yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Go to Drift/ })).toHaveAttribute("href", "/drift");
    expect(screen.queryByText("Tables")).not.toBeInTheDocument();
  });
});

describe("when the schema is watched but the window is empty", () => {
  it("separates “no check has run” from “nothing was recorded”", async () => {
    // Two different situations with the same empty chart: one is waiting for
    // the first check, the other has been checked and the readings are older
    // than the window. Only one of them is fixed by choosing a longer window.
    setRoutes(
      answers(
        metricsView({ samples: [], tracking: { ...metricsView().tracking, lastCheckedAt: null } })
      )
    );
    show();

    expect(await screen.findByText("No readings in this window")).toBeInTheDocument();
    expect(screen.getByText(/no drift check has finished yet/)).toBeInTheDocument();
    expect(screen.queryByText(/Try a longer window/)).not.toBeInTheDocument();
  });

  it("tells someone whose checks are older than the window to widen it", async () => {
    setRoutes(answers(metricsView({ samples: [], days: 1 })));
    show();

    expect(await screen.findByText("No readings in this window")).toBeInTheDocument();
    expect(screen.getByText(/nothing was recorded in the last 1 day\. Try a longer window\./))
      .toBeInTheDocument();
  });
});

describe("when the history cannot be read", () => {
  it("shows what the server said rather than an empty chart", async () => {
    setRoutes(answers({ error: "That connection is not a PostgreSQL one." }, 400));
    show();

    expect(await screen.findByText("Could not read this schema's history")).toBeInTheDocument();
    expect(screen.getByText(/That connection is not a PostgreSQL one\./)).toBeInTheDocument();
  });

  it("has its own words for a server it could not reach at all", async () => {
    setRoutes([{ match: "/api/performance/metrics", networkError: true }]);
    show();

    expect(
      await screen.findByText(/Could not reach the server to read this schema's history/)
    ).toBeInTheDocument();
  });

  it("falls back to its own sentence when the failure came with no reason", async () => {
    setRoutes(answers({}, 500));
    show();

    expect(await screen.findByText(/Could not read this schema's history\./)).toBeInTheDocument();
  });

  it("asks again when Try again is pressed", async () => {
    setRoutes(answers({ error: "Server busy." }, 503));
    show();
    await screen.findByText("Could not read this schema's history");

    setRoutes(answers(metricsView()));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await charted()).toBeInTheDocument();
    expect(requests()).toHaveLength(2);
  });
});

describe("the readings themselves", () => {
  it("draws a card for every metric, structure and size alike", async () => {
    show();

    await charted();
    for (const label of ["Tables", "Columns", "Indexes", "Foreign keys", "Views", "Functions"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText("Structure")).toBeInTheDocument();
    expect(screen.getByText("Size and rows")).toBeInTheDocument();
  });

  it("says which way each metric went, in words", async () => {
    show();

    await charted();
    // 12 tables to 14, 90 columns to 101: the sentence says the number it
    // ended on and by how much it moved, because the line alone cannot.
    expect(screen.getByText(/14 tables, up 2/)).toBeInTheDocument();
    expect(screen.getByText(/101 columns, up 11/)).toBeInTheDocument();
  });

  it("says a single reading has nothing to compare against", async () => {
    // A flat line through one number reads as "steady". It is not steady, it
    // is the first one.
    setRoutes(answers(metricsView({ samples: [TWO_READINGS[0]] })));
    show();

    await charted();
    expect(
      screen.getAllByText(/at the only check in this window — there is nothing yet to compare/)
        .length
    ).toBeGreaterThan(0);
  });

  it("counts how many checks in the window found the schema drifted", async () => {
    setRoutes(
      answers(
        metricsView({
          samples: [TWO_READINGS[0], { ...TWO_READINGS[1], drifted: true }],
        })
      )
    );
    show();

    await charted();
    expect(
      screen.getByText("1 of 2 checks in this window found the schema drifted from its baseline.")
    ).toBeInTheDocument();
  });

  it("says how many readings there are and when they get removed", async () => {
    show();

    await charted();
    expect(
      screen.getByText(/2 readings in this window · one is taken every time a drift check runs/)
    ).toBeInTheDocument();
    expect(screen.getByText(/readings older than 90 days are removed/)).toBeInTheDocument();
  });
});

describe("readings that could not be taken", () => {
  it("leaves them out of the line and says how many, rather than drawing zeros", async () => {
    // A connection whose login cannot read the size catalogue gets null for
    // every size metric. Plotted as zero they would draw a schema that emptied
    // itself out — a fault that is not there, on a chart somebody acts on.
    setRoutes(
      answers(
        metricsView({
          samples: [
            reading({ at: "2026-09-10T09:00:00.000Z", totalBytes: null, indexBytes: null }),
            reading({ at: "2026-09-12T09:00:00.000Z" }),
          ],
        })
      )
    );
    show();

    await charted();
    expect(
      screen.getAllByText(
        /1 reading in this window could not be measured, and is left out of the line rather than drawn as zero/
      )
    ).toHaveLength(2);
    expect(screen.getByText("12 tables, unchanged over the last 2 days.")).toBeInTheDocument();
  });

  it("says a metric could not be measured at all when none of its readings were", async () => {
    setRoutes(
      answers(
        metricsView({
          samples: TWO_READINGS.map((sample) => ({
            ...sample,
            totalBytes: null,
            indexBytes: null,
            estimatedRows: null,
          })),
        })
      )
    );
    show();

    await charted();
    expect(screen.getByText("Total size could not be measured in this window.")).toBeInTheDocument();
    expect(screen.getAllByText("Nothing measurable in this window.")).toHaveLength(3);
    // The counts beside them are fine, so the tab is still worth opening.
    expect(screen.getByText(/14 tables, up 2/)).toBeInTheDocument();
  });
});

describe("changing the question", () => {
  it("asks again for the window that was picked, and marks it as the one in use", async () => {
    show();
    await charted();

    fireEvent.click(windowButton("30 days"));

    await waitFor(() => expect(requests()).toHaveLength(2));
    expect(requests()[1].url).toContain("days=30");

    // The buttons go with the skeleton while the new window is being read, so
    // there is nothing to ask about aria-pressed until the readings are back.
    await charted();
    expect(windowButton("30 days")).toHaveAttribute("aria-pressed", "true");
    expect(windowButton("7 days")).toHaveAttribute("aria-pressed", "false");
  });

  it("goes back to the skeleton while the new window is being read", async () => {
    // Leaving 7 days of readings under a button that now says 90 would be a
    // chart captioned with a window it is not of.
    show();
    await charted();
    const release = holdNext("/api/performance/metrics");

    fireEvent.click(windowButton("90 days"));

    await waitFor(() => expect(screen.queryByText("Tables")).not.toBeInTheDocument());
    release();
    expect(await charted()).toBeInTheDocument();
  });

  it("goes back to the skeleton when the target changes under it", async () => {
    const { rerender } = render(<SchemaTrends target={TARGET} />);
    await charted();
    const release = holdNext("/api/performance/metrics");

    rerender(<SchemaTrends target={{ ...TARGET, connectionId: "9", schema: "sales" }} />);

    expect(screen.queryByText("Tables")).not.toBeInTheDocument();
    release();
    await charted();
    expect(requests()[1].url).toContain("schema=sales");
  });

  it("reads again when Refresh is pressed, for the same window", async () => {
    show();
    await charted();

    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));

    await waitFor(() => expect(requests()).toHaveLength(2));
    expect(requests()[1].url).toContain("days=7");
  });

  it("does not let a slow answer land on a question nobody asked any more", async () => {
    // The race the key exists for: the answer to the first question arrives
    // after the third has already been drawn, and must not overwrite it.
    //
    // The window buttons cannot drive this. They go with the skeleton, so
    // while the first answer is still in the air there is nothing on screen to
    // click. The target prop changes the same key from outside the component,
    // and does not depend on anything being rendered.
    const { rerender } = render(<SchemaTrends target={TARGET} />);
    await charted();

    const releaseFirst = holdNext("/api/performance/metrics");
    rerender(<SchemaTrends target={{ ...TARGET, schema: "sales" }} />);
    // From here the answer is a single reading, so it cannot be mistaken for
    // the two-reading answer still held above.
    setRoutes(answers(metricsView({ samples: [TWO_READINGS[0]] })));
    rerender(<SchemaTrends target={{ ...TARGET, schema: "billing" }} />);
    await waitFor(() => expect(requests()).toHaveLength(3));
    await screen.findByText(/^12 tables at the only check in this window/);

    releaseFirst();
    await flushAsync();

    // Still the billing answer: one reading, not the two the held one carries.
    expect(
      screen.getByText(/^12 tables at the only check in this window/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/14 tables, up 2/)).not.toBeInTheDocument();
  });
});

describe("the line above the charts", () => {
  it("names the schema, the connection and how often it is checked", async () => {
    show();

    await charted();
    expect(screen.getByText("public")).toBeInTheDocument();
    expect(screen.getByText(/on Prod shop · checked/)).toHaveTextContent("checked every 1h");
  });

  it("says plainly when no check has finished yet", async () => {
    setRoutes(
      answers(metricsView({ tracking: { ...metricsView().tracking, lastCheckedAt: null } }))
    );
    show();

    await charted();
    expect(screen.getByText(/no check has finished yet/)).toBeInTheDocument();
  });
});
