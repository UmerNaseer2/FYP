/** @jest-environment jsdom */

/**
 * The Drift & Audit screen, on the three things it has to get right before any
 * of the numbers on it mean anything.
 *
 * Which schema is being shown — the URL picks one, and when it names an id
 * that is not tracked the page falls back to the one that most needs eyes
 * rather than to nothing.
 *
 * Whether it could ask at all — an empty tracked list and a tracked list that
 * could not be read look identical once they reach the screen, and "nothing
 * tracked yet" said about a database outage is a lie the reader acts on.
 *
 * Where the report came from — the badge beside the schema name is the last
 * SAVED result while everything under it was recomputed on this page load, so
 * without the provenance lines the screen showed "○ not checked" directly above
 * a full drift report and contradicted itself.
 */

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

jest.mock("next/navigation", () => require("./helpers/render-page").navigationStubs);

import DriftPage from "@/app/(studio)/drift/page";
import type { CompareReport } from "@/lib/compare-types";
import type { DriftDetailView, TrackedSchemaListItem } from "@/lib/lineage-db";
import { fetchCalls, resetPageState, setRoutes, setSearchParams } from "./helpers/render-page";
import { schema } from "./helpers/snapshots";

/** A tracked row, with only the fields a test cares about spelled out. */
function tracked(over: Partial<TrackedSchemaListItem> & { id: number }): TrackedSchemaListItem {
  return {
    connectionId: 1,
    schemaName: `schema_${over.id}`,
    label: null,
    environment: "dev",
    createdAt: "2026-01-01T00:00:00.000Z",
    connectionName: "Local Postgres",
    connectionHost: "localhost",
    connectionDatabase: "shop",
    headVersion: "v3",
    headSeq: 3,
    migrationCount: 3,
    driftStatus: null,
    driftSummary: null,
    driftCheckedAt: null,
    driftIntervalMinutes: 0,
    lastCheckedAt: null,
    ...over,
  };
}

/**
 * A report with nothing in it.
 *
 * The diff canvas has its own suite; what the drift page does with a report is
 * count it for the hero and hand it on, so an empty one keeps the page's own
 * lines the only thing a query here can match.
 */
function emptyReport(): CompareReport {
  return {
    left: schema([]),
    right: schema([]),
    matchedTables: [],
    tablesOnlyInA: [],
    tablesOnlyInB: [],
    possibleTableMatches: [],
    objectDiffs: [],
    comparedObjectCategories: {
      indexes: true,
      triggers: true,
      views: true,
      sequences: true,
      types: true,
      collations: true,
      extensions: true,
      routines: true,
      rowSecurity: true,
      partitioning: true,
      privileges: true,
      reasons: {},
    },
    summary: {
      tablesOnlyInA: 0,
      tablesOnlyInB: 0,
      changedTables: 0,
      changedConstraints: 0,
      likelyRenameCandidates: 0,
      identicalTables: 0,
      changedObjects: 0,
    },
  };
}

/** A detail view for one tracked schema; `over` says what this test is about. */
function detail(over: Partial<DriftDetailView> & { trackedSchemaId: number }): DriftDetailView {
  return {
    schemaName: `schema_${over.trackedSchemaId}`,
    label: null,
    environment: "dev",
    connection: {
      id: 1,
      name: "Local Postgres",
      host: "localhost",
      port: 5432,
      database: "shop",
      type: "PostgreSQL",
    },
    expected: {
      version: "v3",
      seq: 3,
      snapshotId: 9,
      format: { kind: "current", baselineVersion: 3, currentVersion: 3, missing: [], note: null },
    },
    state: "in_sync",
    summary: "The live schema matches its baseline.",
    counts: null,
    report: null,
    driftIntervalMinutes: 0,
    lastRecorded: null,
    ...over,
  };
}

/** The tracked list, the detail read and the per-schema history, all answered. */
function routesFor(list: TrackedSchemaListItem[], view: DriftDetailView) {
  return [
    { match: /\/api\/lineage$/, body: list },
    { match: "/api/lineage/drift", body: view },
    { match: "/api/lineage/audit", body: [] },
  ];
}

/** The id the detail read actually asked about. */
async function driftRequest(): Promise<string> {
  await waitFor(() =>
    expect(fetchCalls.some((c) => c.url.includes("/api/lineage/drift"))).toBe(true)
  );
  return fetchCalls.find((c) => c.url.includes("/api/lineage/drift"))!.url;
}

beforeEach(() => resetPageState());
afterEach(() => cleanup());

describe("which schema the drift screen shows", () => {
  it("shows the one the URL names", async () => {
    setSearchParams("tab=detail&schema=2");
    setRoutes(
      routesFor(
        [tracked({ id: 1, driftStatus: "drifted" }), tracked({ id: 2, driftStatus: "in_sync" })],
        detail({ trackedSchemaId: 2 })
      )
    );
    render(<DriftPage />);

    // Asked about 2 even though 1 is the worse of the two, which is the whole
    // point: the reader's choice outranks the default ordering.
    expect(await driftRequest()).toContain("trackedSchemaId=2");
  });

  it("falls back to the worst-drifted schema when the URL names one that is gone", async () => {
    // A stale link, or a schema untracked since. Picking nothing would leave a
    // page of empty state in front of a reader who has two live schemas.
    setSearchParams("tab=detail&schema=99");
    setRoutes(
      routesFor(
        [tracked({ id: 1, driftStatus: "in_sync" }), tracked({ id: 2, driftStatus: "drifted" })],
        detail({ trackedSchemaId: 2, state: "drifted" })
      )
    );
    render(<DriftPage />);

    expect(await driftRequest()).toContain("trackedSchemaId=2");
  });

  it("carries the chosen schema across a tab switch", async () => {
    // The tabs are plain links, so the id has to ride in the href or clicking
    // Audit log silently drops what the reader was looking at.
    setSearchParams("tab=detail&schema=2");
    setRoutes(routesFor([tracked({ id: 2 })], detail({ trackedSchemaId: 2 })));
    render(<DriftPage />);

    expect(screen.getByRole("link", { name: "Audit log" })).toHaveAttribute(
      "href",
      "/drift?tab=audit&schema=2"
    );
    expect(screen.getByRole("link", { name: "Schedule" })).toHaveAttribute(
      "href",
      "/drift?tab=schedule&schema=2"
    );
    // Styling alone said which tab was open, which a screen reader could not
    // hear at all: two identical links and no way to tell them apart.
    expect(screen.getByRole("link", { name: "Drift detail" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(screen.getByRole("link", { name: "Audit log" })).not.toHaveAttribute("aria-current");

    // The header and its tabs are drawn before anything is fetched, so every
    // assertion above passes with the panel's reads still in flight. Waiting on
    // the panel keeps them from landing after the test has ended.
    await screen.findByText("Read live on this page load");
  });
});

describe("when the screen cannot find out", () => {
  it("says the tracked list could not be read, rather than that nothing is tracked", async () => {
    setRoutes([
      { match: /\/api\/lineage$/, status: 500, body: { error: "app db down" } },
      { match: "/api/lineage/audit", body: [] },
    ]);
    render(<DriftPage />);

    expect(await screen.findByText("Could not load your tracked schemas")).toBeInTheDocument();
    // The two states are one boolean apart and read as opposites: one says
    // there is nothing to watch, the other that we could not look.
    expect(screen.queryByText("Nothing tracked yet")).not.toBeInTheDocument();
  });

  it("points at the dashboard when nothing really is tracked", async () => {
    setRoutes([{ match: /\/api\/lineage$/, body: [] }]);
    render(<DriftPage />);

    expect(await screen.findByText("Nothing tracked yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Go to dashboard/ })).toHaveAttribute(
      "href",
      "/studio"
    );
    expect(screen.queryByText("Could not load your tracked schemas")).not.toBeInTheDocument();
  });

  it("tells a schema that is gone apart from a read that failed", async () => {
    // A 404 means the id is not tracked any more, which the empty state's own
    // words already explain — naming an error on top of it would invent a
    // fault where there is none.
    setRoutes([
      { match: /\/api\/lineage$/, body: [tracked({ id: 1 })] },
      { match: "/api/lineage/drift", status: 404, body: { error: "Not tracked." } },
      { match: "/api/lineage/audit", body: [] },
    ]);
    render(<DriftPage />);

    expect(await screen.findByText("Tracked schema not found")).toBeInTheDocument();
    expect(screen.queryByText("Could not read this schema's drift")).not.toBeInTheDocument();
  });

  it("names a failed drift read and comes back from it", async () => {
    setRoutes([
      { match: /\/api\/lineage$/, body: [tracked({ id: 1 })] },
      {
        match: "/api/lineage/drift",
        status: 500,
        body: { error: "Could not reach localhost:5432." },
      },
      { match: "/api/lineage/audit", body: [] },
    ]);
    render(<DriftPage />);

    expect(await screen.findByText("Could not read this schema's drift")).toBeInTheDocument();
    expect(screen.getByText("Could not reach localhost:5432.")).toBeInTheDocument();

    // The retry re-reads rather than reloading the page, so a transient outage
    // costs a click and not the reader's place on the screen.
    setRoutes(routesFor([tracked({ id: 1 })], detail({ trackedSchemaId: 1 })));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByText("Live schema matches v3.", { exact: false })
    ).toBeInTheDocument();
  });
});

describe("where the report on screen came from", () => {
  it("says the diff is live and that nothing has been saved yet", async () => {
    setRoutes(
      routesFor(
        [tracked({ id: 1 })],
        detail({ trackedSchemaId: 1, state: "drifted", counts: null, report: emptyReport() })
      )
    );
    render(<DriftPage />);

    // The contradiction these lines exist to resolve: a full drift report under
    // a badge reading "not checked". Both are true — one is this render, the
    // other is the audit trail — and only saying so makes them readable.
    expect(await screen.findByText("Read live on this page load")).toBeInTheDocument();
    expect(
      screen.getByText("Nothing recorded yet — Check drift now saves it")
    ).toBeInTheDocument();
    // "Nothing recorded" has a second meaning worth telling apart: not watched
    // at all, versus watched regularly and never seen to change.
    expect(screen.getByText(/Automatic checking off/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "turn on" })).toHaveAttribute(
      "href",
      "/drift?tab=schedule"
    );
  });

  it("names the saved check and the cadence when there are both", async () => {
    setRoutes(
      routesFor(
        [tracked({ id: 1, driftStatus: "in_sync" })],
        detail({
          trackedSchemaId: 1,
          driftIntervalMinutes: 60,
          lastRecorded: {
            status: "in_sync",
            detectedAt: "2026-06-09T14:21:00.000Z",
            acknowledgedAt: null,
          },
        })
      )
    );
    render(<DriftPage />);

    expect(
      await screen.findByText("Last recorded check · 2026-06-09 14:21 UTC")
    ).toBeInTheDocument();
    expect(screen.getByText(/Checked automatically every 1h/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "change" })).toHaveAttribute(
      "href",
      "/drift?tab=schedule"
    );
  });

  it("says the connection is gone instead of printing a host it no longer has", async () => {
    setRoutes(
      routesFor(
        [tracked({ id: 1, connectionName: null })],
        detail({ trackedSchemaId: 1, connection: null, state: "unreachable" })
      )
    );
    render(<DriftPage />);

    expect(await screen.findByText("Connection removed")).toBeInTheDocument();
    // Compare needs a connection to open against, so the link is withheld
    // rather than offered and then failing.
    expect(screen.queryByRole("link", { name: /Open in Compare/ })).not.toBeInTheDocument();
  });

  it("warns before the resolution buttons when the schema is production", async () => {
    setRoutes(
      routesFor(
        [tracked({ id: 1, environment: "prod" })],
        detail({ trackedSchemaId: 1, environment: "prod" })
      )
    );
    render(<DriftPage />);

    // Said whatever the drift state is: the buttons below can rewrite this
    // schema's baseline, and on production that accepts an outside change as
    // the new truth.
    expect(await screen.findByText("This is a production schema.")).toBeInTheDocument();
  });
});

describe("the audit tab", () => {
  it("says the history could not be read, rather than that none exists", async () => {
    setSearchParams("tab=audit");
    setRoutes([
      { match: /\/api\/lineage$/, body: [tracked({ id: 1 })] },
      { match: "/api/lineage/audit", status: 500, body: { error: "app db down" } },
    ]);
    render(<DriftPage />);

    expect(await screen.findByText("Could not load the drift history")).toBeInTheDocument();
    expect(screen.queryByText(/No drift checks have been recorded yet/)).not.toBeInTheDocument();
  });

  it("holds back the summary tiles until there is a check to summarise", async () => {
    setSearchParams("tab=audit");
    setRoutes([
      { match: /\/api\/lineage$/, body: [tracked({ id: 1 })] },
      { match: "/api/lineage/audit", body: [] },
    ]);
    render(<DriftPage />);

    expect(
      await screen.findByText(/No drift checks have been recorded yet/)
    ).toBeInTheDocument();
    // Four tiles reading zero over "nothing recorded" summarise nothing; they
    // only make an empty log look like a dashboard that has lost its data.
    expect(screen.queryByText("Recorded checks")).not.toBeInTheDocument();
  });
});
