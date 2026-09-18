/** @jest-environment jsdom */

/**
 * One tracked schema's own page: its lineage, its drift, and the four ways it
 * can have nothing to show.
 *
 * The four are not interchangeable, and that is most of what is tested here.
 * "Not tracked" and "could not read it" look the same on screen and lead
 * opposite ways — one is a schema that was removed, the other a database that
 * is down and will answer again in a minute. And the numbers in the header are
 * from the newest SNAPSHOT, not from the live database: on a drifted schema —
 * exactly when a reader most wants the current shape — they are the shape as
 * it was captured.
 *
 * What is NOT here:
 *  - The environment picker this page hosts, which is the one place that label
 *    can be corrected: tests/component-schema-environment-picker.test.tsx. What
 *    this page contributes is the onDone it passes, so a change reloads the
 *    header above rather than leaving it disagreeing with the buttons.
 *  - The re-check button beside the drift line, which fetches and reloads the
 *    page's own data: components/studio/RecheckDriftButton has no suite of its
 *    own.
 *  - The route behind every read on this page. GET /api/lineage/[id] has no
 *    suite of its own; the answers below are written out by hand.
 */

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

jest.mock("next/navigation", () => require("./helpers/render-page").navigationStubs);
jest.mock("next-auth/react", () => require("./helpers/render-page").sessionStubs);

import SchemaDetailPage from "@/app/(studio)/schemas/[id]/page";
import { fetchCalls, resetPageState, setRoutes, type FetchRoute } from "./helpers/render-page";

const CONNECTION = {
  id: 3,
  name: "Local Postgres",
  host: "localhost",
  port: 5432,
  database: "shop",
  type: "PostgreSQL",
};

/** The snapshot the header's counts are read from. */
const SNAPSHOT = {
  snapshotId: 11,
  label: "baseline",
  tableCount: 4,
  columnCount: 20,
  constraintCount: 6,
  indexCount: 3,
  triggerCount: 0,
  viewCount: 1,
  sequenceCount: 2,
  typeCount: 0,
  routineCount: 0,
  tableNames: ["orders", "customers", "items", "audit"],
  capturedAt: "2026-05-01T09:00:00.000Z",
};

const NODE = {
  id: 21,
  seq: 1,
  name: "baseline",
  changeLevel: "additive",
  version: "1.0.0",
  sqlRef: null,
  createdAt: "2026-05-01T09:00:00.000Z",
  isBaseline: true,
  snapshot: SNAPSHOT,
};

function detail(over: Record<string, unknown> = {}) {
  return {
    trackedSchemaId: 7,
    schemaName: "shop_dev",
    label: null,
    environment: "dev",
    createdAt: "2026-05-01T09:00:00.000Z",
    connection: CONNECTION,
    headSeq: 1,
    headVersion: "1.0.0",
    migrations: [NODE],
    drift: null,
    driftIntervalMinutes: 0,
    ...over,
  };
}

/**
 * The route params, in the shape `use()` can read without suspending.
 *
 * Next hands a client component its params as a promise, and `use()` unwraps
 * it. A bare Promise.resolve() would make the first render suspend and never
 * come back here — React only retries a suspended render when something tells
 * it the promise settled, and in a test there is no router to do that. React's
 * own protocol is the way out: a thenable already carrying status "fulfilled"
 * is read straight through, which is what a page navigated to normally sees.
 */
function alreadyResolved<T>(value: T): Promise<T> {
  return {
    status: "fulfilled",
    value,
    then: (onFulfilled: (v: T) => unknown) => onFulfilled(value),
  } as unknown as Promise<T>;
}

/** Render the page for one route id. */
function show(id: string) {
  render(<SchemaDetailPage params={alreadyResolved({ id })} />);
}

const ROUTE_7: FetchRoute = { match: "/api/lineage/7", body: detail() };

beforeEach(() => resetPageState());
afterEach(() => cleanup());

describe("a schema page with nothing to show", () => {
  it("does not ask the server about an id that is not one", async () => {
    // /schemas/anything is a URL anybody can type. Sending it on would make the
    // route parse "abc" as a schema id, and the screen would report whatever
    // came back of that as a failure of the app.
    setRoutes([ROUTE_7]);
    show("abc");

    expect(await screen.findByText("Schema not found")).toBeInTheDocument();
    expect(fetchCalls).toHaveLength(0);
    expect(screen.getByRole("link", { name: /Back to dashboard/ })).toHaveAttribute(
      "href",
      "/studio"
    );
  });

  it("keeps 'not tracked' apart from 'could not read it'", async () => {
    // A 404 is an answer: this schema is not tracked, and the empty state says
    // so in full. Offering "Try again" here would invite a reader to keep
    // pressing a button for a row that does not exist.
    setRoutes([{ match: "/api/lineage/7", status: 404, body: { error: "not found" } }]);
    show("7");

    expect(await screen.findByText("Schema not found")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("says why a real failure failed, and lets it be retried", async () => {
    setRoutes([
      { match: "/api/lineage/7", status: 500, body: { error: "The app database is down." } },
    ]);
    show("7");

    expect(await screen.findByText("Could not load this schema")).toBeInTheDocument();
    expect(screen.getByText("The app database is down.")).toBeInTheDocument();

    // And the retry is a real way back, not a button that redraws the failure.
    setRoutes([ROUTE_7]);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "shop_dev" })).toBeInTheDocument();
  });
});

describe("a tracked schema's header", () => {
  it("marks its counts as the snapshot's, not the live schema's", async () => {
    // The drifted case is the whole reason this label exists: the live schema
    // is known to differ, and these numbers are from before it did.
    setRoutes([
      {
        match: "/api/lineage/7",
        body: detail({
          drift: {
            status: "drifted",
            summary: "2 columns added outside the app.",
            detail: null,
            detectedAt: "2026-05-02T10:00:00.000Z",
          },
        }),
      },
    ]);
    show("7");

    expect(await screen.findByText(/4 tables · 20 columns at HEAD/)).toBeInTheDocument();
    // getAllByText: the status pill is drawn twice on purpose, in the header
    // and again on the lineage card, which sit at opposite ends of a wide row.
    expect(screen.getAllByText("Drifted").length).toBeGreaterThan(0);
    expect(screen.getByText(/The live schema has drifted from/)).toBeInTheDocument();
    expect(screen.getByText("2 columns added outside the app.")).toBeInTheDocument();
  });

  it("does not offer Compare once the connection has been deleted", async () => {
    // Compare runs against two live databases. With the connection gone there
    // is no live database on this side at all, so the link would open a screen
    // that could only fail.
    setRoutes([{ match: "/api/lineage/7", body: detail({ connection: null }) }]);
    show("7");

    expect(await screen.findByText("Connection removed")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Open in Compare/ })).not.toBeInTheDocument();
  });

  it("asks for a first check rather than claiming to be in sync", async () => {
    // drift === null means nobody has looked. Drawing the calm "in sync" note
    // here would be the app vouching for a comparison it never made.
    setRoutes([ROUTE_7]);
    show("7");

    expect(await screen.findByText("No drift check has run yet.")).toBeInTheDocument();
    expect(screen.queryByText(/Live schema matches/)).not.toBeInTheDocument();
  });

  it("names the lineage counter as its own, not a script version", async () => {
    // The number on this card is Schema Studio's count of structure changes.
    // Read as a script version it would send somebody looking for v1.0.0 in
    // GitHub, where the tag means something else entirely.
    setRoutes([ROUTE_7]);
    show("7");

    expect(
      await screen.findByText("counts structure changes — not a script version")
    ).toBeInTheDocument();
  });
});
