/** @jest-environment jsdom */

/**
 * The comparison screen, on the questions it answers before any diff exists.
 *
 * This page is a plain GET form: every pick is a submit, and nothing is read
 * from a database until somebody presses Compare. That design is why the tests
 * below are about words rather than numbers — the failures worth catching here
 * are a screen that shows a stale comparison as though it were the current one,
 * a tick the reader believes has taken effect when it has not, and an empty
 * form offered as an answer.
 *
 * What is NOT here: a finished comparison's diff panels. They are built from a
 * CompareReport by components with their own suites (DiffReport, SummaryMatrix,
 * the Migration Workbench), and rebuilding a realistic multi-target outcome
 * here would test those components a second time through a page that only
 * passes them along.
 */

import "@testing-library/jest-dom";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";

jest.mock("next/navigation", () => require("./helpers/render-page").navigationStubs);
jest.mock("next-auth/react", () => require("./helpers/render-page").sessionStubs);

import ComparePage from "@/app/[org]/(studio)/compare/page";
import type { CompareScreen } from "@/lib/compare/run";
import { flushAsync, holdNext, render, resetPageState, setRoutes } from "./helpers/render-page";

const CONNECTIONS = [
  { id: 1, name: "Local Postgres", database_name: "shop" },
  { id: 2, name: "Warehouse", database_name: "warehouse" },
];

/** A screen with both sides picked and nothing run — the state a bare /compare lands in. */
function ready(over: Partial<Extract<CompareScreen, { kind: "ready" }>> = {}): CompareScreen {
  return {
    kind: "ready",
    connections: CONNECTIONS,
    canAddTarget: true,
    maxTargets: 4,
    sets: [],
    activeSetId: null,
    setNotFound: false,
    setsRefusal: null,
    setModified: false,
    selection: {
      sourceConnectionId: 1,
      sourceConnectionLabel: "Local Postgres",
      sourceSchema: "public",
      allowDataLoss: false,
      compareData: false,
      dataTables: [],
      targets: [{ connectionId: 1, connectionLabel: "Local Postgres", schema: "shop_dev" }],
    },
    source: {
      connectionId: 1,
      displayName: "Local Postgres",
      schema: "public",
      schemaOptions: ["public", "shop_dev"],
      detectedVersion: null,
      missingMessage: null,
    },
    sourceError: null,
    targets: [
      {
        index: 0,
        connectionId: 1,
        displayName: "Local Postgres",
        schema: "shop_dev",
        schemaOptions: ["public", "shop_dev"],
        missingMessage: null,
      },
    ],
    outcomes: [],
    allowDataLoss: false,
    compareData: false,
    dataTables: [],
    asked: false,
    swapHref: null,
    ...over,
  };
}

/** Answer the one POST this page makes with the screen handed in. */
function serve(view: CompareScreen) {
  setRoutes([{ match: "/api/compare", method: "POST", body: view }]);
}

/** Wait for the form itself, which only exists once a screen has arrived. */
const compareButton = () => screen.findByRole("button", { name: /^Compare( again)?$/ });

/** Opens the target picker's panel, where its connections and schemas are listed. */
const openTargetPicker = () =>
  fireEvent.click(screen.getByRole("button", { name: "Change target connection and schema" }));
/**
 * One of the open panel's two steps: "Connections" or "Schemas". The panel
 * shows one at a time and opens on the schemas, so asking for the connections
 * steps back out to them first.
 */
function pickerList(name: "Connections" | "Schemas") {
  const panel = screen.getByRole("dialog", { name: /^Choose target/ });
  if (name === "Connections" && !within(panel).queryByRole("group", { name })) {
    fireEvent.click(within(panel).getByRole("button", { name: "Back to connections" }));
  }
  return within(panel).getByRole("group", { name });
}
/** Picks a schema, which also closes the panel. */
function pickTargetSchema(schema: string) {
  openTargetPicker();
  fireEvent.click(within(pickerList("Schemas")).getByRole("button", { name: schema }));
}

beforeEach(() => resetPageState());
afterEach(() => cleanup());

describe("a screen with nothing to compare on", () => {
  it("asks for one connection, not two", async () => {
    serve({ kind: "no-connections" });
    render(<ComparePage />);

    expect(await screen.findByText("Add a connection to compare")).toBeInTheDocument();
    // The branch fires on ZERO connections, and one is genuinely enough: the
    // two sides of a comparison are two schemas, and both can live on the same
    // server. Asking for a second sent people off to invent one.
    expect(screen.getByText(/One is enough to start/)).toBeInTheDocument();
    expect(screen.queryByText(/at least two connections/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Go to Connections/ })).toHaveAttribute(
      "href",
      "/test-org/connections"
    );
  });

  it("shows the failure on its own when the first run never arrives", async () => {
    setRoutes([
      {
        match: "/api/compare",
        method: "POST",
        status: 500,
        body: { error: "Could not reach the source database." },
      },
    ]);
    render(<ComparePage />);

    expect(await screen.findByText("Could not reach the source database.")).toBeInTheDocument();
    // Nothing else is drawn: a picker bar over a comparison that does not
    // exist would invite a Compare that cannot be told from the one that
    // failed.
    expect(screen.queryByRole("button", { name: /^Compare( again)?$/ })).not.toBeInTheDocument();
  });

  it("lets a failed first run be tried again", async () => {
    setRoutes([
      {
        match: "/api/compare",
        method: "POST",
        status: 500,
        body: { error: "Could not reach the source database." },
      },
    ]);
    render(<ComparePage />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not reach the source database."
    );

    // The retry is a real way back, not a button that redraws the failure.
    serve(ready());
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await compareButton()).toBeInTheDocument();
  });

  it("says nothing has been read yet when nobody pressed Compare", async () => {
    serve(ready({ asked: false }));
    render(<ComparePage />);

    expect(await screen.findByText("Nothing compared yet")).toBeInTheDocument();
    // A migration generated for a pair nobody chose reads as a recommendation.
    expect(screen.getByText(/Press Compare to read the schemas picked above/)).toBeInTheDocument();
  });

  it("blames the missing source rather than the targets", async () => {
    serve(
      ready({
        asked: true,
        source: {
          connectionId: null,
          displayName: "Deleted connection",
          schema: "public",
          schemaOptions: [],
          detectedVersion: null,
          missingMessage: "That connection has been deleted.",
        },
      })
    );
    render(<ComparePage />);

    expect(await screen.findByText("Nothing compared yet")).toBeInTheDocument();
    expect(
      screen.getByText(/The source has no connection, so there is nothing to compare/)
    ).toBeInTheDocument();
  });

  it("says where a saved set went, and what the pickers are showing instead", async () => {
    serve(ready({ setNotFound: true, asked: false }));
    render(<ComparePage />);

    expect(await screen.findByText(/That saved set no longer exists/)).toBeInTheDocument();
    expect(screen.getByText(/The pickers show the defaults instead/)).toBeInTheDocument();
  });

  it("reports an unreadable source once, above the targets", async () => {
    serve(
      ready({
        asked: true,
        sourceError: "password authentication failed for user \"shop\"",
      })
    );
    render(<ComparePage />);

    expect(await screen.findByText("Unable to read the source schema")).toBeInTheDocument();
    expect(
      screen.getByText('password authentication failed for user "shop"')
    ).toBeInTheDocument();
  });
});

describe("changes that have not been applied yet", () => {
  it("says a ticked option does nothing until Compare is pressed", async () => {
    serve(ready({ asked: true }));
    render(<ComparePage />);
    await compareButton();

    // The report says "Untick Allow data loss to hold it back", so a reader who
    // did exactly that watched the page go on insisting the drop was armed.
    // The line keeps its room while hidden, so the Compare button never moves.
    expect(screen.getByText(/Not applied yet/)).not.toBeVisible();
    fireEvent.click(screen.getByRole("checkbox", { name: /Allow data loss/ }));
    expect(screen.getByText(/Not applied yet/)).toBeVisible();
  });

  it("says the same about a changed picker", async () => {
    serve(ready({ asked: true }));
    render(<ComparePage />);
    await compareButton();

    pickTargetSchema("public");

    expect(screen.getByText(/Not applied yet/)).toBeVisible();
  });

  it("goes quiet again when a picker is put back the way it was", async () => {
    // Dirty is measured against what the comparison on screen used, not
    // against "has anything been touched" — picking another and then the
    // original again is back to clean, and saying otherwise trains the reader
    // to ignore the line.
    serve(ready({ asked: true }));
    render(<ComparePage />);
    await compareButton();

    pickTargetSchema("public");
    pickTargetSchema("shop_dev");

    expect(screen.getByText(/Not applied yet/)).not.toBeVisible();
  });
});

describe("the order of the page", () => {
  it("offers Compare again after a result, and Compare once something changed", async () => {
    serve(ready({ asked: true }));
    render(<ComparePage />);

    expect(await screen.findByRole("button", { name: "Compare again" })).toBeInTheDocument();
    pickTargetSchema("public");
    expect(screen.getByRole("button", { name: "Compare" })).toBeInTheDocument();
  });

  it("keeps Save this comparison for after a result", async () => {
    serve(ready({ asked: false }));
    render(<ComparePage />);
    await compareButton();

    // Saved comparisons can be opened from the top at any time.
    expect(screen.getByRole("button", { name: /^Saved comparisons/ })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Save this comparison" })).not.toBeInTheDocument();
  });

  it("shows Save this comparison under the results once there is one", async () => {
    serve(ready({ asked: true }));
    render(<ComparePage />);
    await compareButton();

    const save = screen.getByRole("group", { name: "Save this comparison" });
    const results = document.querySelector(".cp-results");
    expect(results).not.toBeNull();
    // After the results in the page, never before them.
    expect(results!.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("says once, under both pickers, that the two sides are the same schema", async () => {
    serve(ready({ asked: false }));
    render(<ComparePage />);
    await compareButton();

    pickTargetSchema("public");

    expect(
      screen.getByText("Source and target are the same schema. Pick a different target.")
    ).toBeInTheDocument();
  });
});

describe("the picker's schema list", () => {
  it("ignores the list for a connection the reader has moved off", async () => {
    setRoutes([
      { match: "/api/compare", method: "POST", body: ready({ asked: true }) },
      {
        match: "/api/lineage/schemas",
        body: (url: string) =>
          url.includes("connectionId=2")
            ? { schemas: ["warehouse"] }
            : { schemas: ["slow_a", "slow_b"] },
      },
    ]);
    render(<ComparePage />);
    await compareButton();

    // Pick the second connection and hold its answer; then pick the first back,
    // which answers at once. Two requests, and the held one is the older.
    // The panel stays open after a connection is picked and moves on to its
    // schemas, so both picks happen in the one panel, stepping back between.
    const releaseWarehouse = holdNext("connectionId=2");
    openTargetPicker();
    fireEvent.click(within(pickerList("Connections")).getByRole("button", { name: /^Warehouse/ }));
    fireEvent.click(
      within(pickerList("Connections")).getByRole("button", { name: /^Local Postgres/ })
    );

    const schemaNames = () =>
      within(pickerList("Schemas"))
        .getAllByRole("button")
        .map((row) => row.textContent);
    await waitFor(() => expect(schemaNames()).toEqual(["slow_a", "slow_b"]));

    releaseWarehouse();
    await flushAsync();

    // The released answer is true about a connection nobody has selected, and
    // this list is the only place the reader would ever see it.
    expect(schemaNames()).toEqual(["slow_a", "slow_b"]);
  });

  it("keeps the schema already in the box when the list cannot be read", async () => {
    setRoutes([
      { match: "/api/compare", method: "POST", body: ready({ asked: true }) },
      {
        match: "/api/lineage/schemas",
        status: 500,
        body: { error: "Could not reach warehouse.internal." },
      },
    ]);
    render(<ComparePage />);
    await compareButton();

    openTargetPicker();
    fireEvent.click(within(pickerList("Connections")).getByRole("button", { name: /^Warehouse/ }));

    expect(
      await screen.findByText("Could not reach warehouse.internal.")
    ).toBeInTheDocument();
    // Compare still sends it, and the run's own result says whether that
    // database could be read at all — which is a better answer than a box
    // emptied on the reader's behalf. Waited for rather than read straight
    // away: the box is blanked for the duration of the load and only refills
    // from the schema state on the commit after the failure lands.
    await waitFor(() =>
      expect(document.querySelector('input[name="targetSchema"]')).toHaveValue("shop_dev")
    );
    expect(screen.getByRole("group", { name: /^Target/ })).toHaveTextContent("shop_dev");
  });
});
