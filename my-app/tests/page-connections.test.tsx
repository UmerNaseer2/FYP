/** @jest-environment jsdom */

/**
 * The connections screen, on the two things it must never get wrong: what it
 * says when it could not read the list, and what it does to a connection that
 * other parts of the app are still using.
 *
 * Both failures look like success. A read that fails and paints an empty table
 * tells somebody their connections are gone; a delete that goes through without
 * naming what went with it takes a drift history nobody was asked about.
 *
 * What is NOT here: the add/edit drawer's field-by-field validation. Every rule
 * it applies comes from lib/connection-validate, which has its own suite, and
 * the drawer calls the same validateConnection() the route does — re-asserting
 * each message through the form would be testing that module twice. The one
 * check made HERE is the one the drawer adds on its own (an empty URI on a new
 * connection), because no other caller has it.
 */

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import ConnectionsPage from "@/app/(studio)/connections/page";
import { fetchCalls, resetPageState, setRoutes } from "./helpers/render-page";

/** A saved row, with everything the table reads spelled out. */
function conn(over: Partial<Record<string, unknown>> & { id: number; name: string }) {
  return {
    host: "db.internal",
    port: 5432,
    database_name: "shop",
    type: "PostgreSQL",
    username: "app",
    ssl: true,
    ssl_mode: "require",
    environment: "dev",
    last_tested_at: null,
    last_test_ok: null,
    last_test_version: null,
    last_test_latency_ms: null,
    last_test_error: null,
    ...over,
  };
}

/** The table row carrying `name`, so a query cannot match another row's cell. */
function rowFor(name: string): HTMLElement {
  const cell = screen.getByText(name).closest("tr");
  if (!cell) throw new Error(`No row rendered for ${name}`);
  return cell as HTMLElement;
}

/**
 * The delete confirmation, which stays mounted so it can fade.
 *
 * Both overlays on this page are always in the DOM — they are hidden with CSS
 * and `inert`, neither of which jsdom applies — so a bare query for "Cancel"
 * finds the drawer's as well.
 */
function deleteDialog(): HTMLElement {
  const modal = document.querySelector(".modal-scrim");
  if (!modal) throw new Error("The delete dialog is not mounted");
  return modal as HTMLElement;
}

/** Wait for the first read to land — every assertion below is about its result. */
async function loaded() {
  await waitFor(() =>
    expect(screen.queryByText("Loading connections…")).not.toBeInTheDocument()
  );
}

beforeEach(() => resetPageState());
afterEach(() => cleanup());

describe("what the screen says about the list itself", () => {
  it("says the connections are still there when the read fails", async () => {
    setRoutes([
      { match: "/api/connections", status: 500, body: { error: "The app database is unreachable." } },
    ]);
    render(<ConnectionsPage />);
    await loaded();

    expect(screen.getByText("The app database is unreachable.")).toBeInTheDocument();
    expect(
      screen.getByText(/Your saved connections are still there/)
    ).toBeInTheDocument();
    // The failure branch sets `connections` to [], and the empty-list copy sits
    // on the same `visible.length === 0` test. Saying "No connections yet." to
    // somebody whose connections are all still saved is the single most
    // misleading thing this screen can do.
    expect(screen.queryByText("No connections yet.")).not.toBeInTheDocument();
    // And no counters: "Total 0" three inches above "they are still there" is
    // the page arguing with itself.
    expect(screen.queryByText("Total")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("recovers on a retry", async () => {
    setRoutes([
      { match: "/api/connections", status: 500, body: { error: "The app database is unreachable." } },
    ]);
    render(<ConnectionsPage />);
    await loaded();

    setRoutes([{ match: "/api/connections", body: [conn({ id: 1, name: "Orders DB" })] }]);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Orders DB")).toBeInTheDocument();
    expect(
      screen.queryByText("The app database is unreachable.")
    ).not.toBeInTheDocument();
  });

  it("offers a first step rather than an empty dashboard when nothing is saved", async () => {
    setRoutes([{ match: "/api/connections", body: [] }]);
    render(<ConnectionsPage />);
    await loaded();

    expect(screen.getByText("No connections yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add your first connection/ })).toBeInTheDocument();
    // Four tiles reading 0 and seven filter pills reading 0 report that
    // everything is at zero, which is a different message from "you have not
    // set this up yet".
    expect(screen.queryByText("Total")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^All/ })).not.toBeInTheDocument();
  });

  it("separates a filter that hides everything from having nothing", async () => {
    setRoutes([{ match: "/api/connections", body: [conn({ id: 1, name: "Orders DB" })] }]);
    render(<ConnectionsPage />);
    await loaded();

    fireEvent.click(screen.getByRole("button", { name: /Production/ }));
    expect(screen.getByText("No connections match this filter.")).toBeInTheDocument();
    expect(screen.queryByText("No connections yet.")).not.toBeInTheDocument();

    // The rows exist and the filter is hiding them, so the way back is offered
    // rather than left to be guessed at.
    fireEvent.click(screen.getByRole("button", { name: "Show all connections" }));
    expect(screen.getByText("Orders DB")).toBeInTheDocument();
  });
});

describe("what the screen says about each connection's health", () => {
  it("says unknown rather than zero when nothing has been tested", async () => {
    setRoutes([
      {
        match: "/api/connections",
        body: [conn({ id: 1, name: "One" }), conn({ id: 2, name: "Two" })],
      },
    ]);
    render(<ConnectionsPage />);
    await loaded();

    // A bare "0" under "Healthy" claims every connection is unhealthy when the
    // truth is that none has been tested.
    const healthy = screen.getByText("Healthy").closest(".card");
    expect(healthy).toHaveTextContent("—");
    expect(healthy).not.toHaveTextContent("of 2");
    expect(rowFor("One")).toHaveTextContent("Never");
  });

  it("counts a result saved on the row, not just one tested in this session", async () => {
    setRoutes([
      {
        match: "/api/connections",
        body: [
          conn({
            id: 1,
            name: "One",
            last_tested_at: new Date(Date.now() - 5 * 60_000).toISOString(),
            last_test_ok: true,
            last_test_version: "PostgreSQL 17.2",
            last_test_latency_ms: 12,
          }),
          conn({ id: 2, name: "Two" }),
        ],
      },
    ]);
    render(<ConnectionsPage />);
    await loaded();

    // "of N" is what stops 1 of 3 being read as 1 of 1.
    expect(screen.getByText("Healthy").closest(".card")).toHaveTextContent("of 2");
    expect(rowFor("One")).toHaveTextContent("PostgreSQL 17.2");
    expect(rowFor("One")).toHaveTextContent("5m ago");
    expect(rowFor("Two")).toHaveTextContent("Never");
  });

  it("records a failed test against the row that failed", async () => {
    setRoutes([
      {
        match: "/api/connections",
        body: [conn({ id: 1, name: "One" }), conn({ id: 2, name: "Two" })],
      },
      {
        match: "/api/connections/test-saved",
        method: "POST",
        body: { ok: false, error: "password authentication failed", testedAt: null },
      },
    ]);
    render(<ConnectionsPage />);
    await loaded();

    fireEvent.click(within(rowFor("Two")).getByRole("button", { name: /Test/ }));

    await waitFor(() => expect(rowFor("Two")).toHaveTextContent("failed"));
    expect(rowFor("One")).toHaveTextContent("Never");
    // It asked about the row that was pressed, and only that one.
    const tests = fetchCalls.filter((c) => c.url.includes("/test-saved"));
    expect(tests).toHaveLength(1);
    expect(tests[0].body).toBe(JSON.stringify({ id: 2 }));
  });

  it("nudges only while something is genuinely unlabelled", async () => {
    setRoutes([
      {
        match: "/api/connections",
        body: [conn({ id: 1, name: "One", environment: null }), conn({ id: 2, name: "Two" })],
      },
    ]);
    render(<ConnectionsPage />);
    await loaded();

    // An unlabelled target is the state where Compare and Deploy cannot warn
    // that a database is production, so the nudge says which way out.
    expect(screen.getByText(/1 connection has/)).toBeInTheDocument();
    expect(screen.getByText(/edit each one and pick Dev, Staging or Production/)).toBeInTheDocument();
  });

  it("lets a test run now overrule the one saved on the row", async () => {
    setRoutes([
      {
        match: "/api/connections",
        method: "GET",
        body: [
          conn({
            id: 1,
            name: "One",
            last_tested_at: new Date(Date.now() - 60 * 60_000).toISOString(),
            last_test_ok: true,
            last_test_version: "PostgreSQL 17.2",
            last_test_latency_ms: 12,
          }),
        ],
      },
      {
        match: "/api/connections/test-saved",
        method: "POST",
        body: { ok: false, error: "the server closed the connection", testedAt: null },
      },
    ]);
    render(<ConnectionsPage />);
    await loaded();
    expect(rowFor("One")).toHaveTextContent("1h ago");

    fireEvent.click(within(rowFor("One")).getByRole("button", { name: /Test/ }));

    // The saved outcome is what survives a reload, but a test run in this
    // browser is the newest thing that happened — a row still showing an
    // hour-old green light next to a failure the reader just watched would be
    // reporting the older of two answers it has.
    await waitFor(() => expect(rowFor("One")).toHaveTextContent("failed"));
    expect(rowFor("One")).not.toHaveTextContent("PostgreSQL 17.2");
  });
});

describe("deleting a connection other things are using", () => {
  const IN_USE = {
    needsConfirmation: true,
    dependents: {
      trackedSchemas: 2,
      schemaNames: ["shop_dev", "shop_staging"],
      snapshots: 9,
      comparisonSets: 1,
      comparisonSetNames: ["Nightly"],
    },
  };

  it("names what goes with it before it goes", async () => {
    setRoutes([
      { match: "/api/connections", method: "GET", body: [conn({ id: 1, name: "Orders DB" })] },
      { match: "/api/connections", method: "DELETE", status: 409, body: IN_USE },
    ]);
    render(<ConnectionsPage />);
    await loaded();

    fireEvent.click(screen.getByRole("button", { name: "Delete Orders DB" }));
    fireEvent.click(screen.getByRole("button", { name: /Delete connection/ }));

    expect(await screen.findByText("Still in use")).toBeInTheDocument();
    // The counts are the whole point: a drift history is not recoverable, so
    // "2 tracked schemas" and "9 snapshots" have to be read before the second
    // press, not after it.
    expect(
      screen.getByText(/2 tracked schemas — deleting it also removes 9 snapshots/)
    ).toBeInTheDocument();
    expect(screen.getByText("shop_dev, shop_staging")).toBeInTheDocument();
    // A saved set survives, so it is described differently from a snapshot.
    expect(screen.getByText(/1 saved comparison set — the set is kept/)).toBeInTheDocument();
    expect(screen.getByText("Nightly")).toBeInTheDocument();

    // The first press asked; nothing has been deleted.
    const deletes = fetchCalls.filter((c) => c.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0].body).toBe(JSON.stringify({ id: 1, confirm: false }));
    // Asserted through the row's own button: the dialog is open, so the name
    // itself is on screen twice.
    expect(screen.getByRole("button", { name: "Delete Orders DB" })).toBeInTheDocument();
  });

  it("carries the confirmation on the second press", async () => {
    setRoutes([
      { match: "/api/connections", method: "GET", body: [conn({ id: 1, name: "Orders DB" })] },
      { match: "/api/connections", method: "DELETE", status: 409, body: IN_USE },
    ]);
    render(<ConnectionsPage />);
    await loaded();

    fireEvent.click(screen.getByRole("button", { name: "Delete Orders DB" }));
    fireEvent.click(screen.getByRole("button", { name: /Delete connection/ }));

    // The button itself changes: the same press means something different now.
    const anyway = await screen.findByRole("button", { name: /Delete anyway/ });
    // The server accepts it this time, and the list it reloads is empty.
    setRoutes([
      { match: "/api/connections", method: "GET", body: [] },
      { match: "/api/connections", method: "DELETE", body: { ok: true } },
    ]);
    fireEvent.click(anyway);

    await waitFor(() => expect(screen.getByText("No connections yet.")).toBeInTheDocument());
    const deletes = fetchCalls.filter((c) => c.method === "DELETE");
    expect(deletes.map((d) => d.body)).toEqual([
      JSON.stringify({ id: 1, confirm: false }),
      JSON.stringify({ id: 1, confirm: true }),
    ]);
  });

  it("forgets the confirmation when the dialog is closed and reopened", async () => {
    setRoutes([
      { match: "/api/connections", method: "GET", body: [conn({ id: 1, name: "Orders DB" })] },
      { match: "/api/connections", method: "DELETE", status: 409, body: IN_USE },
    ]);
    render(<ConnectionsPage />);
    await loaded();

    fireEvent.click(screen.getByRole("button", { name: "Delete Orders DB" }));
    fireEvent.click(screen.getByRole("button", { name: /Delete connection/ }));
    await screen.findByText("Still in use");
    fireEvent.click(within(deleteDialog()).getByRole("button", { name: "Cancel" }));

    // Reopening on an armed dialog would mean one press deletes everything the
    // panel had listed, with the panel no longer on screen to say so.
    fireEvent.click(screen.getByRole("button", { name: "Delete Orders DB" }));
    expect(screen.queryByText("Still in use")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Delete connection/ })).toBeInTheDocument();
  });
});

describe("the add drawer", () => {
  it("asks for the connection string once, not as four missing fields", async () => {
    setRoutes([{ match: "/api/connections", body: [] }]);
    render(<ConnectionsPage />);
    await loaded();

    fireEvent.click(screen.getByRole("button", { name: /Add your first connection/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));

    // validateConnection() would report a blank URI as a missing host, port,
    // database and user — four problems for the one thing there is to do.
    // Read inside the drawer: the same sentence goes to the toast as well, and
    // a toast disappears while the field it is about does not.
    const drawer = document.querySelector(".drawer");
    expect(within(drawer as HTMLElement).getByText("Paste a connection string first."))
      .toBeInTheDocument();
    expect(fetchCalls.filter((c) => c.method === "POST")).toHaveLength(0);
  });
});
