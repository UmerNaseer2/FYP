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
 *
 * The last part is about who may press what. Adding a connection needs
 * Connections: Create, editing or testing a saved one needs Update, and
 * deleting needs Delete. A role without a box still sees the button, switched
 * off, and the page says why once, under its header, rather than on every row.
 */

import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

jest.mock("next-auth/react", () => require("./helpers/render-page").sessionStubs);

import ConnectionsPage from "@/app/(studio)/connections/page";
import {
  fetchCalls,
  flushAsync,
  resetPageState,
  setCustomRole,
  setRoutes,
  setSessionLoading,
  setUser,
} from "./helpers/render-page";
import type { FoundDatabase } from "@/lib/desktop-bridge";
import {
  installDesktopBridge,
  removeDesktopBridge,
  type FakeDesktopBridge,
} from "./helpers/desktop-bridge";

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

describe("for a role that may not add, change or delete connections", () => {
  /** Why each button is off, in the words the page uses. */
  const refusal = {
    create: (role: string) =>
      `Your role (${role}) can't add a connection. ` +
      `Ask an admin to allow "Connections: Create" for this role.`,
    update: (role: string) =>
      `Your role (${role}) can't edit or test a saved connection. ` +
      `Ask an admin to allow "Connections: Update" for this role.`,
    delete: (role: string) =>
      `Your role (${role}) can't delete a connection. ` +
      `Ask an admin to allow "Connections: Delete" for this role.`,
  };

  /** The four buttons a row and the header offer, found the way a reader would. */
  function buttons(name: string) {
    const row = within(rowFor(name));
    return {
      add: screen.getByRole("button", { name: /^Add connection/ }),
      test: row.getByRole("button", { name: /Test/ }),
      edit: row.getByRole("button", { name: /Edit/ }),
      remove: screen.getByRole("button", { name: `Delete ${name}` }),
    };
  }

  it("switches each button off and says why once, under the header", async () => {
    setUser("viewer");
    setRoutes([{ match: "/api/connections", body: [conn({ id: 1, name: "Orders DB" })] }]);
    render(<ConnectionsPage />);
    await loaded();

    const { add, test, edit, remove } = buttons("Orders DB");
    expect(add).toBeDisabled();
    expect(add).toHaveAttribute("title", refusal.create("Viewer"));
    // Testing is under Update with editing: it logs in with the stored
    // password, and it records the outcome on the row.
    for (const button of [test, edit]) {
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("title", refusal.update("Viewer"));
    }
    expect(remove).toBeDisabled();
    expect(remove).toHaveAttribute("title", refusal.delete("Viewer"));

    // Once each. The buttons carry them too, but as tooltips, not as text.
    for (const reason of [refusal.create, refusal.update, refusal.delete]) {
      expect(screen.getAllByText(reason("Viewer"))).toHaveLength(1);
    }
  });

  it("names only the button there is when nothing is saved", async () => {
    // No rows, so nothing to test, edit or delete. "Add" is offered twice, in
    // the header and in the empty state, and both are off.
    setUser("viewer");
    setRoutes([{ match: "/api/connections", body: [] }]);
    render(<ConnectionsPage />);
    await loaded();

    for (const button of [
      screen.getByRole("button", { name: /^Add connection/ }),
      screen.getByRole("button", { name: /Add your first connection/ }),
    ]) {
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("title", refusal.create("Viewer"));
    }
    expect(screen.getByText(refusal.create("Viewer"))).toBeInTheDocument();
    expect(screen.queryByText(refusal.update("Viewer"))).toBeNull();
    expect(screen.queryByText(refusal.delete("Viewer"))).toBeNull();
  });

  it("opens nothing and asks the server nothing when they are pressed anyway", async () => {
    setUser("viewer");
    setRoutes([{ match: "/api/connections", body: [conn({ id: 1, name: "Orders DB" })] }]);
    render(<ConnectionsPage />);
    await loaded();

    for (const button of Object.values(buttons("Orders DB"))) fireEvent.click(button);
    await flushAsync();

    // Both overlays stay mounted (see deleteDialog), so "open" is the class
    // that shows them.
    expect(document.querySelector(".drawer")).not.toHaveClass("open");
    expect(deleteDialog()).not.toHaveClass("open");
    expect(fetchCalls.map((c) => c.url)).toEqual(["/api/connections"]);
  });

  it("lets a role that may only add save one, and leaves its test to the row", async () => {
    // A passing drawer test is re-run on the row once it is saved, so the
    // table can say when it was last reached. That test is the row's own,
    // under Connections: Update, so a role with only Create skips it, and its
    // new row reads "Never", which is true of the row.
    setCustomRole("adder", "Adder", ["connections:create"]);
    const SAVED = conn({ id: 9, name: "Orders DB" });
    setRoutes([
      {
        match: /\/api\/connections\/test$/,
        method: "POST",
        body: {
          ok: true,
          version: "PostgreSQL 17.2",
          schemaCount: 1,
          schemas: ["public"],
          latencyMs: 8,
          ssl: true,
        },
      },
      { match: "/api/connections", method: "GET", body: [] },
    ]);
    render(<ConnectionsPage />);
    await loaded();

    fireEvent.click(screen.getByRole("button", { name: /Add your first connection/ }));
    fireEvent.change(screen.getByPlaceholderText("e.g. Staging — Neon"), {
      target: { value: "Orders DB" },
    });
    fireEvent.change(
      screen.getByPlaceholderText("postgres://user:pass@host:5432/database?sslmode=require"),
      { target: { value: "postgres://app@db.internal:5432/shop?sslmode=require" } }
    );
    fireEvent.click(screen.getByRole("button", { name: /Test now/ }));
    await screen.findByText(/Connected\. Found/);

    // The save, and the list it reloads with the new row in it.
    setRoutes([
      { match: "/api/connections", method: "POST", body: SAVED },
      { match: "/api/connections", method: "GET", body: [SAVED] },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
    await screen.findByRole("button", { name: "Delete Orders DB" });
    await flushAsync();

    expect(fetchCalls.filter((c) => c.url.includes("/test-saved"))).toHaveLength(0);
    expect(rowFor("Orders DB")).toHaveTextContent("Never");
  });

  it("lets a role that may only edit test and edit, and explains the rest", async () => {
    setCustomRole("fixer", "Fixer", ["connections:update"]);
    setRoutes([
      {
        match: "/api/connections/test-saved",
        method: "POST",
        body: {
          ok: true,
          version: "PostgreSQL 17.2",
          latencyMs: 9,
          testedAt: new Date().toISOString(),
        },
      },
      { match: "/api/connections", method: "GET", body: [conn({ id: 1, name: "Orders DB" })] },
    ]);
    render(<ConnectionsPage />);
    await loaded();

    const { add, test, edit, remove } = buttons("Orders DB");
    for (const button of [test, edit]) {
      expect(button).toBeEnabled();
      expect(button).not.toHaveAttribute("title");
    }
    expect(add).toBeDisabled();
    expect(remove).toBeDisabled();
    expect(screen.getByText(refusal.create("Fixer"))).toBeInTheDocument();
    expect(screen.getByText(refusal.delete("Fixer"))).toBeInTheDocument();
    expect(screen.queryByText(/edit or test a saved connection/)).toBeNull();

    fireEvent.click(test);
    await waitFor(() => expect(rowFor("Orders DB")).toHaveTextContent("PostgreSQL 17.2"));
  });

  it("says nothing while the session is still loading", async () => {
    // The server decides then. Switching the buttons off for a role nobody
    // knows yet would flash a refusal at everyone on every page load.
    setSessionLoading();
    setRoutes([{ match: "/api/connections", body: [conn({ id: 1, name: "Orders DB" })] }]);
    render(<ConnectionsPage />);
    await loaded();

    for (const button of Object.values(buttons("Orders DB"))) {
      expect(button).toBeEnabled();
      expect(button).not.toHaveAttribute("title");
    }
    expect(screen.queryByText(/Your role/)).toBeNull();
  });

  it("leaves the row as it was when the server refuses the test", async () => {
    // A role can lose the box while the page is open. The route then stops
    // before it reaches the database and records nothing, so painting the row
    // "failed" would report a fault the database does not have.
    const REFUSED = refusal.update("Editor");
    setUser("editor");
    setRoutes([
      {
        match: "/api/connections/test-saved",
        method: "POST",
        status: 403,
        body: { error: REFUSED },
      },
      {
        match: "/api/connections",
        method: "GET",
        body: [
          conn({
            id: 1,
            name: "Orders DB",
            last_tested_at: new Date(Date.now() - 60 * 60_000).toISOString(),
            last_test_ok: true,
            last_test_version: "PostgreSQL 17.2",
            last_test_latency_ms: 12,
          }),
        ],
      },
    ]);
    render(<ConnectionsPage />);
    await loaded();

    fireEvent.click(buttons("Orders DB").test);

    // The reason is the toast, and the row still says what a reload would.
    expect(await screen.findByText(REFUSED)).toBeInTheDocument();
    expect(rowFor("Orders DB")).toHaveTextContent("PostgreSQL 17.2");
    expect(rowFor("Orders DB")).toHaveTextContent("1h ago");
    expect(rowFor("Orders DB")).not.toHaveTextContent("failed");
  });

  it("does not tell a role that may not edit to edit each unlabelled one", async () => {
    setUser("viewer");
    setRoutes([
      { match: "/api/connections", body: [conn({ id: 1, name: "One", environment: null })] },
    ]);
    render(<ConnectionsPage />);
    await loaded();

    expect(screen.getByText(/1 connection has/)).toBeInTheDocument();
    expect(screen.getByText(/Ask someone who may edit connections/)).toBeInTheDocument();
    expect(screen.queryByText(/edit each one/)).toBeNull();
  });
});

describe("finding databases on this computer, in the desktop app", () => {
  // The desktop app can look for PostgreSQL servers running on the computer it
  // is on, and the add drawer offers what it finds. A web page cannot look
  // around the computer it runs on, so in a browser the drawer has no such
  // section at all.
  const FROM_DOCKER: FoundDatabase = {
    source: "docker",
    label: "shop-db",
    host: "localhost",
    port: 5433,
    user: "shop",
    database: "shop_dev",
    container: "shop-db",
  };
  const ON_A_PORT: FoundDatabase = {
    source: "port",
    label: "PostgreSQL on port 5432",
    host: "localhost",
    port: 5432,
    user: null,
    database: null,
  };

  let bridge: FakeDesktopBridge;
  beforeEach(() => {
    bridge = installDesktopBridge();
    setRoutes([{ match: "/api/connections", body: [] }]);
  });
  afterEach(() => removeDesktopBridge());

  /** The drawer, which stays mounted; queries are kept inside it. */
  function drawer() {
    return within(document.querySelector(".drawer") as HTMLElement);
  }

  async function openAddDrawer() {
    render(<ConnectionsPage />);
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: /Add your first connection/ }));
  }

  /** Keeps the search going until the case says what it found. */
  function holdSearch() {
    let answer: (found: FoundDatabase[]) => void = () => {};
    bridge.findLocalDatabases.mockImplementation(
      () =>
        new Promise<FoundDatabase[]>((resolve) => {
          answer = resolve;
        })
    );
    return (found: FoundDatabase[]) => act(async () => answer(found));
  }

  /**
   * The Fields-mode inputs, found by what they show while empty. Their labels
   * are not tied to them, and Database and User share a placeholder, Database
   * first.
   */
  function fields() {
    const [database, user] = drawer().getAllByPlaceholderText("postgres");
    return {
      name: drawer().getByPlaceholderText("e.g. Staging — Neon"),
      host: drawer().getByPlaceholderText("db.example.com"),
      port: drawer().getByPlaceholderText("5432"),
      database,
      user,
      password: drawer().getByPlaceholderText("••••••••"),
    };
  }

  it("is not offered in a browser, which cannot look around the computer", async () => {
    removeDesktopBridge();
    await openAddDrawer();

    expect(drawer().queryByText("On this computer")).not.toBeInTheDocument();
    expect(drawer().queryByRole("button", { name: "Find databases" })).not.toBeInTheDocument();
  });

  it("looks only when asked, then lists what it found", async () => {
    const answer = holdSearch();
    await openAddDrawer();
    // Opening the drawer is not asking. A search knocks on ports and asks
    // Docker, which nobody adding a hosted database wants done.
    expect(bridge.findLocalDatabases).not.toHaveBeenCalled();

    fireEvent.click(drawer().getByRole("button", { name: "Find databases" }));
    expect(bridge.findLocalDatabases).toHaveBeenCalledTimes(1);
    expect(drawer().getByText("Looking on the usual ports and in Docker…")).toBeInTheDocument();
    expect(drawer().getByRole("button", { name: "Looking…" })).toBeDisabled();

    await answer([FROM_DOCKER, ON_A_PORT]);
    expect(
      await drawer().findByText("Found 2 databases. Pick one to fill in the details below.")
    ).toBeInTheDocument();
    const list = within(drawer().getByRole("list", { name: "Databases found on this computer" }));
    expect(list.getByText("localhost:5433 · user shop · database shop_dev")).toBeInTheDocument();
    // A server only seen answering on a port says what is not known, rather
    // than showing the defaults as if they had been read from it.
    expect(list.getByText("localhost:5432 · user and database not known")).toBeInTheDocument();
    expect(list.getByText("Docker")).toHaveAttribute("title", "Docker container shop-db");
    expect(drawer().getByRole("button", { name: "Look again" })).toBeEnabled();
  });

  it("fills in everything but the password, then puts the cursor there", async () => {
    bridge.findLocalDatabases.mockResolvedValue([FROM_DOCKER, ON_A_PORT]);
    await openAddDrawer();
    fireEvent.click(drawer().getByRole("button", { name: "Find databases" }));
    fireEvent.click(await drawer().findByRole("button", { name: /shop-db/ }));

    const f = fields();
    expect(f.name).toHaveValue("shop-db");
    expect(f.host).toHaveValue("localhost");
    expect(f.port).toHaveValue(5433);
    expect(f.database).toHaveValue("shop_dev");
    expect(f.user).toHaveValue("shop");
    // The app never reads a password, not even from a container's settings,
    // so the person types it, and the cursor is already in the box.
    expect(f.password).toHaveValue("");
    await waitFor(() => expect(f.password).toHaveFocus());
    // The details went into the fields, so the drawer shows the fields.
    expect(drawer().getByRole("button", { name: "Fields" })).toHaveClass("active");
    // A database on this computer is a development one, and seldom has SSL set
    // up, the same as the "Local Postgres" quick start.
    expect(drawer().getByRole("radio", { name: "Dev" })).toHaveAttribute("aria-checked", "true");
    expect(drawer().getByRole("radio", { name: "Off" })).toHaveAttribute("aria-checked", "true");
  });

  it("replaces a name it filled in, but never one the person typed", async () => {
    bridge.findLocalDatabases.mockResolvedValue([FROM_DOCKER, ON_A_PORT]);
    await openAddDrawer();
    fireEvent.click(drawer().getByRole("button", { name: "Find databases" }));
    fireEvent.click(await drawer().findByRole("button", { name: /shop-db/ }));

    // A second pick is a change of mind, so the first pick's name goes too,
    // and what the port server could not say goes back to the defaults rather
    // than keeping shop-db's.
    fireEvent.click(drawer().getByRole("button", { name: /PostgreSQL on port 5432/ }));
    expect(fields().name).toHaveValue("PostgreSQL on port 5432");
    expect(fields().port).toHaveValue(5432);
    expect(fields().database).toHaveValue("postgres");
    expect(fields().user).toHaveValue("postgres");

    fireEvent.change(fields().name, { target: { value: "My laptop" } });
    fireEvent.click(drawer().getByRole("button", { name: /shop-db/ }));
    expect(fields().name).toHaveValue("My laptop");
    expect(fields().port).toHaveValue(5433);
  });

  it("clears a password that was typed for some other server", async () => {
    bridge.findLocalDatabases.mockResolvedValue([FROM_DOCKER]);
    await openAddDrawer();
    fireEvent.click(drawer().getByRole("button", { name: "Fields" }));
    fireEvent.change(fields().password, { target: { value: "typed-for-another-server" } });

    fireEvent.click(drawer().getByRole("button", { name: "Find databases" }));
    expect(
      await drawer().findByText("Found 1 database. Pick it to fill in the details below.")
    ).toBeInTheDocument();
    fireEvent.click(drawer().getByRole("button", { name: /shop-db/ }));
    expect(fields().password).toHaveValue("");
  });

  it("says so when nothing answered, and offers to look again", async () => {
    // The fake's default search finds nothing.
    await openAddDrawer();
    fireEvent.click(drawer().getByRole("button", { name: "Find databases" }));

    expect(await drawer().findByText(/^Nothing found\./)).toBeInTheDocument();
    expect(
      drawer().queryByRole("list", { name: "Databases found on this computer" })
    ).not.toBeInTheDocument();
    fireEvent.click(drawer().getByRole("button", { name: "Look again" }));
    expect(bridge.findLocalDatabases).toHaveBeenCalledTimes(2);
  });

  it("keeps the app's own error out of the drawer when the search fails", async () => {
    bridge.findLocalDatabases.mockRejectedValue(
      new Error("Error invoking remote method 'find-local-databases': Error: EACCES")
    );
    await openAddDrawer();
    fireEvent.click(drawer().getByRole("button", { name: "Find databases" }));

    expect(
      await drawer().findByText(
        "Schema Studio could not look for databases just now. Look again, or fill in the details below."
      )
    ).toBeInTheDocument();
    expect(drawer().queryByText(/EACCES|remote method/)).not.toBeInTheDocument();
    expect(drawer().getByRole("button", { name: "Look again" })).toBeEnabled();
  });

  it("is not offered while a saved connection is being edited", async () => {
    // One press would quietly point the saved connection, and the history
    // kept for it, at a different database.
    setRoutes([{ match: "/api/connections", body: [conn({ id: 1, name: "Orders DB" })] }]);
    render(<ConnectionsPage />);
    await loaded();
    fireEvent.click(within(rowFor("Orders DB")).getByRole("button", { name: /Edit/ }));

    expect(drawer().getByRole("heading", { name: "Edit Orders DB" })).toBeInTheDocument();
    expect(drawer().queryByText("On this computer")).not.toBeInTheDocument();
  });

  it("starts over each time the drawer opens", async () => {
    // What it found the last time may have stopped since, so the old list is
    // not offered again.
    bridge.findLocalDatabases.mockResolvedValue([FROM_DOCKER]);
    await openAddDrawer();
    fireEvent.click(drawer().getByRole("button", { name: "Find databases" }));
    await drawer().findByRole("list", { name: "Databases found on this computer" });

    fireEvent.click(drawer().getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: /Add your first connection/ }));
    expect(drawer().getByRole("button", { name: "Find databases" })).toBeEnabled();
    expect(
      drawer().queryByRole("list", { name: "Databases found on this computer" })
    ).not.toBeInTheDocument();
    expect(bridge.findLocalDatabases).toHaveBeenCalledTimes(1);
  });
});
