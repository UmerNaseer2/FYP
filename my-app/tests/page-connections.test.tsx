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
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";

jest.mock("next-auth/react", () => require("./helpers/render-page").sessionStubs);
// The page reads ?edit= and clears it again, so it needs the router.
jest.mock("next/navigation", () => require("./helpers/render-page").navigationStubs);

import ConnectionsPage from "@/app/[org]/(studio)/connections/page";
import {
  fetchCalls,
  flushAsync,
  render,
  resetPageState,
  setCustomRole,
  routerCalls,
  setRoutes,
  setSearchParams,
  setSessionLoading,
  setUser,
} from "./helpers/render-page";
import { HELP_TOPICS } from "@/lib/help";

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
    last_tested_at: null,
    last_test_ok: null,
    last_test_version: null,
    last_test_latency_ms: null,
    last_test_error: null,
    ...over,
  };
}

/** The card carrying `name`, so a query cannot match another card's text. */
function rowFor(name: string): HTMLElement {
  const cell = screen.getByText(name).closest("article");
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

describe("a link that asks for one connection's edit form (?edit=)", () => {
  afterEach(() => setSearchParams(""));

  it("opens that connection's form and takes the parameter off the address", async () => {
    setSearchParams("edit=2");
    setRoutes([
      {
        match: "/api/connections",
        body: [conn({ id: 1, name: "Orders DB" }), conn({ id: 2, name: "Billing DB" })],
      },
    ]);
    render(<ConnectionsPage />);
    await loaded();

    expect(await screen.findByDisplayValue("Billing DB")).toBeInTheDocument();
    expect(routerCalls.replace).toEqual(["/test-org/connections"]);
  });

  it("ignores an id that is not in the list", async () => {
    setSearchParams("edit=999");
    setRoutes([{ match: "/api/connections", body: [conn({ id: 1, name: "Orders DB" })] }]);
    render(<ConnectionsPage />);
    await loaded();

    expect(screen.queryByDisplayValue("Orders DB")).toBeNull();
    expect(routerCalls.replace).toEqual(["/test-org/connections"]);
  });
});

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
    expect(screen.queryByTestId("connections-summary")).not.toBeInTheDocument();
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
    expect(screen.queryByTestId("connections-summary")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^All/ })).not.toBeInTheDocument();
  });

  it("finds a connection by its name or its host, and says so when nothing matches", async () => {
    setRoutes([
      {
        match: "/api/connections",
        body: [
          conn({ id: 1, name: "Orders DB", host: "orders.internal" }),
          conn({ id: 2, name: "Billing DB", host: "billing.internal" }),
        ],
      },
    ]);
    render(<ConnectionsPage />);
    await loaded();

    const search = screen.getByRole("searchbox", { name: "Search connections by name or host" });
    fireEvent.change(search, { target: { value: "billing" } });
    expect(screen.getByText("Billing DB")).toBeInTheDocument();
    expect(screen.queryByText("Orders DB")).not.toBeInTheDocument();

    // The host counts too, in any letter case.
    fireEvent.change(search, { target: { value: "ORDERS.INT" } });
    expect(screen.getByText("Orders DB")).toBeInTheDocument();
    expect(screen.queryByText("Billing DB")).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "nothing like this" } });
    expect(screen.getByText("No connections match this filter.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show all connections" }));
    expect(search).toHaveValue("");
    expect(screen.getByText("Orders DB")).toBeInTheDocument();
    expect(screen.getByText("Billing DB")).toBeInTheDocument();
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
    const summary = screen.getByTestId("connections-summary");
    expect(summary).toHaveTextContent("2 connections. None checked yet.");
    expect(summary).not.toHaveTextContent("healthy");
    expect(summary).not.toHaveTextContent("of 2");
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
    expect(screen.getByTestId("connections-summary")).toHaveTextContent(
      "1 of 2 healthy, 0 failing, 1 not checked yet."
    );
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

describe("where each database is", () => {
  it("labels a database on another computer Remote, not Online", async () => {
    // "Online" read as "reachable right now", which the Test button answers.
    setRoutes([
      {
        match: "/api/connections",
        body: [
          conn({ id: 1, name: "Shop", host: "db.shop.test" }),
          conn({ id: 2, name: "Laptop", host: "localhost" }),
        ],
      },
    ]);
    render(<ConnectionsPage />);
    await loaded();

    expect(rowFor("Shop")).toHaveTextContent("Remote");
    expect(rowFor("Laptop")).toHaveTextContent("Local");
    expect(screen.getByRole("button", { name: /^Remote/ })).toBeInTheDocument();
    expect(screen.queryByText("Online")).not.toBeInTheDocument();
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
    // The counts have to be read before the second press, not after it. The
    // sentence must also say what really happens: the delete removes only the
    // connection, so the snapshots and drift history are kept.
    expect(
      screen.getByText(
        "2 tracked schemas. The 9 snapshots and the drift history are kept, but the tracked schemas can no longer be checked for drift."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/also removes/)).not.toBeInTheDocument();
    expect(screen.getByText("shop_dev, shop_staging")).toBeInTheDocument();
    // A saved set survives, so it is described differently from a snapshot.
    expect(screen.getByText(/1 saved comparison set\. The set is kept/i)).toBeInTheDocument();
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

  it("names its fields by their labels and takes a failed save to the first wrong field", async () => {
    setRoutes([{ match: "/api/connections", body: [] }]);
    render(<ConnectionsPage />);
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: /Add your first connection/ }));
    const drawer = within(document.querySelector(".drawer") as HTMLElement);

    // Named by the label, not by the example in the placeholder.
    const name = drawer.getByLabelText(/^Friendly name/);
    const uri = drawer.getByLabelText("Connection string");
    expect(name).toHaveAttribute("aria-required", "true");
    expect(uri).toHaveAttribute("aria-required", "true");
    expect(name).not.toHaveAttribute("aria-invalid");

    fireEvent.click(drawer.getByRole("button", { name: "Save connection" }));

    // Both problems are reported at once, each tied to its own field.
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveAccessibleDescription("Give this connection a name.");
    expect(uri).toHaveAttribute("aria-invalid", "true");
    expect(uri).toHaveAccessibleDescription("Paste a connection string first.");
    // Focus lands on the first of them, not on the Save button.
    expect(name).toHaveFocus();

    // The separate fields carry their labels too.
    fireEvent.click(drawer.getByRole("button", { name: "Fields" }));
    for (const label of ["Host", "Port", "Database", "User", /^Password/]) {
      expect(drawer.getByLabelText(label)).toBeInTheDocument();
    }
  });

  /** Opens the add drawer and returns queries kept inside it. */
  async function openAdd() {
    setRoutes([{ match: "/api/connections", body: [] }]);
    render(<ConnectionsPage />);
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: /Add your first connection/ }));
    return within(document.querySelector(".drawer") as HTMLElement);
  }

  // Built here rather than written out, as the repository is public.
  const fakePassword = ["fake", "password"].join("-");
  const URI_PLACEHOLDER = "postgres://user:pass@host:5432/database?sslmode=require";

  it("carries a typed connection string into Fields, the password only into its hidden box", async () => {
    const drawer = await openAdd();
    fireEvent.change(drawer.getByPlaceholderText(URI_PLACEHOLDER), {
      target: { value: `postgres://shop:${fakePassword}@db.shop.test:5433/shop_dev` },
    });
    fireEvent.click(drawer.getByRole("button", { name: "Fields" }));

    // Database and User share a placeholder, Database first.
    const [database, user] = drawer.getAllByPlaceholderText("postgres");
    expect(drawer.getByPlaceholderText("db.example.com")).toHaveValue("db.shop.test");
    expect(drawer.getByPlaceholderText("5432")).toHaveValue(5433);
    expect(database).toHaveValue("shop_dev");
    expect(user).toHaveValue("shop");
    const password = drawer.getByPlaceholderText("••••••••");
    expect(password).toHaveValue(fakePassword);
    expect(password).toHaveAttribute("type", "password");
  });

  it("keeps edits made under Fields when switching back and forth", async () => {
    const drawer = await openAdd();
    const uriBox = () => drawer.getByPlaceholderText(URI_PLACEHOLDER);
    const hostBox = () => drawer.getByPlaceholderText("db.example.com");
    fireEvent.change(uriBox(), { target: { value: "postgres://shop@db.shop.test/shop_dev" } });
    fireEvent.click(drawer.getByRole("button", { name: "Fields" }));
    fireEvent.change(hostBox(), { target: { value: "replica.shop.test" } });

    // The string has not changed since it filled the fields, so it must not
    // put its older host back.
    fireEvent.click(drawer.getByRole("button", { name: "Connection string" }));
    fireEvent.click(drawer.getByRole("button", { name: "Fields" }));
    expect(hostBox()).toHaveValue("replica.shop.test");

    // A changed string is newer than the edits, so it fills them in again.
    fireEvent.click(drawer.getByRole("button", { name: "Connection string" }));
    fireEvent.change(uriBox(), { target: { value: "postgres://shop@other.shop.test/shop_dev" } });
    fireEvent.click(drawer.getByRole("button", { name: "Fields" }));
    expect(hostBox()).toHaveValue("other.shop.test");
  });

  it("names a quick start after the latest pill, and keeps what the person typed", async () => {
    const drawer = await openAdd();
    const nameBox = () => drawer.getByPlaceholderText("e.g. Orders on Neon");
    const uriBox = () => drawer.getByPlaceholderText(URI_PLACEHOLDER);

    // Local then Hosted used to leave a hosted database named "Local
    // Postgres".
    fireEvent.click(drawer.getByRole("button", { name: "Local Postgres" }));
    expect(nameBox()).toHaveValue("Local Postgres");
    fireEvent.click(drawer.getByRole("button", { name: /^Hosted/ }));
    expect(nameBox()).toHaveValue("Hosted Postgres");
    expect(uriBox()).toHaveValue("");

    // Hosted used to wipe a pasted string as well. A typed name stays too.
    fireEvent.change(uriBox(), { target: { value: "postgres://app@db.shop.test:5432/shop" } });
    fireEvent.change(nameBox(), { target: { value: "Shop" } });
    fireEvent.click(drawer.getByRole("button", { name: /^Hosted/ }));
    expect(uriBox()).toHaveValue("postgres://app@db.shop.test:5432/shop");
    expect(nameBox()).toHaveValue("Shop");
  });

  it("numbers a quick start name a saved connection already has", async () => {
    setRoutes([
      { match: "/api/connections", body: [conn({ id: 1, name: "Local Postgres", host: "localhost" })] },
    ]);
    render(<ConnectionsPage />);
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: /^Add connection/ }));
    const drawer = within(document.querySelector(".drawer") as HTMLElement);

    fireEvent.click(drawer.getByRole("button", { name: "Local Postgres" }));
    expect(drawer.getByPlaceholderText("e.g. Orders on Neon")).toHaveValue("Local Postgres 2");
  });
});

describe("testing an edit before it is saved", () => {
  // Save keeps the saved password when its box is left blank, and the saved
  // connection string when that box is left blank. Test has to check the same
  // thing, so it sends what Save would send plus the row's id, and the route
  // fills the blanks in from that row. It is never the row's own test-saved,
  // which would ignore what was just changed on screen, the SSL mode included.
  async function editAndTest(saved: ReturnType<typeof conn>) {
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
      { match: "/api/connections", method: "GET", body: [saved] },
    ]);
    render(<ConnectionsPage />);
    await loaded();
    fireEvent.click(within(rowFor(String(saved.name))).getByRole("button", { name: /Edit/ }));
    fireEvent.click(screen.getByRole("radio", { name: "Verify full" }));
    fireEvent.click(screen.getByRole("button", { name: /Test now/ }));
    await screen.findByText(/Connected\. Found/);

    expect(fetchCalls.filter((c) => c.url.includes("/test-saved"))).toHaveLength(0);
    const tests = fetchCalls.filter((c) => /\/api\/connections\/test$/.test(c.url));
    expect(tests).toHaveLength(1);
    return JSON.parse(tests[0].body ?? "{}");
  }

  it("sends the row's id and a blank password, with the SSL mode on screen", async () => {
    const sent = await editAndTest(conn({ id: 3, name: "Orders DB" }));
    expect(sent).toMatchObject({
      id: 3,
      password: "",
      host: "db.internal",
      username: "app",
      ssl_mode: "verify-full",
      clear_connection_string: true,
    });
  });

  it("sends the row's id and a blank connection string for a URI connection", async () => {
    const sent = await editAndTest(
      conn({ id: 6, name: "Hosted DB", has_connection_string: true })
    );
    expect(sent).toMatchObject({
      id: 6,
      connection_string: "",
      ssl_mode: "verify-full",
      clear_connection_string: false,
    });
  });
});

describe("for a role that may not add, change or delete connections", () => {
  /** Why each button is off, in the words the page uses. */
  const refusal = {
    create: (role: string) =>
      `Your role (${role}) can't add a connection. ` +
      `Ask an admin to turn on "Add a connection" for this role.`,
    update: (role: string) =>
      `Your role (${role}) can't edit or test a saved connection. ` +
      `Ask an admin to turn on "Edit or test a saved connection" for this role.`,
    delete: (role: string) =>
      `Your role (${role}) can't delete a connection. ` +
      `Ask an admin to turn on "Delete a connection" for this role.`,
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

    // Said once, as one sentence: three paragraphs that differed by a few
    // words read as a wall. The buttons keep their own reasons, as tooltips.
    expect(
      screen.getAllByText(
        `Your role (Viewer) can't add a connection, edit or test a saved connection, or delete a connection. ` +
          `Ask an admin to turn on "Add a connection", "Edit or test a saved connection", and "Delete a connection" for this role.`
      )
    ).toHaveLength(1);
    for (const reason of [refusal.create, refusal.update, refusal.delete]) {
      expect(screen.queryByText(reason("Viewer"))).toBeNull();
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
    // A Viewer has nothing to ask for one line at a time: they are told an
    // Admin can move them to another role, in a sentence with no link.
    expect(screen.getByText(/An Admin can move you to another role\./)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Ask/ })).toBeNull();
    // The switched-off button points at the line that says why.
    const why = screen.getByText(refusal.create("Viewer")).closest("[id]");
    expect(screen.getByRole("button", { name: /^Add connection/ })).toHaveAttribute(
      "aria-describedby",
      why?.id
    );
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
    // This machine's name is a read, asked for on load.
    expect(
      fetchCalls
        .map((c) => c.url)
        .filter((url) => url !== "/api/connections/machine")
    ).toEqual([
      "/api/connections",
    ]);
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
    fireEvent.change(screen.getByPlaceholderText("e.g. Orders on Neon"), {
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
    expect(
      screen.getByText(
        `Your role (Fixer) can't add a connection or delete a connection. ` +
          `Ask an admin to turn on "Add a connection" and "Delete a connection" for this role.`
      )
    ).toBeInTheDocument();
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

});

describe("somebody changed it first", () => {
  const ORDERS = conn({ id: 1, name: "Orders DB", version: 2 });

  it("deletes over the newer version only when asked again", async () => {
    const current = { ...ORDERS, version: 3, updated_by: "sam@example.test", updated_at: new Date().toISOString() };
    setRoutes([
      { match: "/api/connections", method: "GET", body: [ORDERS] },
      {
        match: "/api/connections",
        method: "DELETE",
        status: 409,
        body: { error: "Changed", conflict: true, current },
      },
    ]);
    render(<ConnectionsPage />);
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Delete Orders DB" }));
    fireEvent.click(within(deleteDialog()).getByRole("button", { name: /Delete connection/ }));

    const modal = (await screen.findByRole("heading", { name: "Changed before you deleted it" })).closest(
      ".modal-scrim"
    ) as HTMLElement;
    await waitFor(() => expect(modal).toHaveClass("open"));
    expect(within(modal).getByText(/sam@example.test changed "Orders DB" after this page read it/)).toBeInTheDocument();

    setRoutes([
      { match: "/api/connections", method: "GET", body: [] },
      { match: "/api/connections", method: "DELETE", body: { ok: true } },
    ]);
    fireEvent.click(within(modal).getByRole("button", { name: "Delete anyway" }));
    await waitFor(() => expect(screen.getByText("No connections yet.")).toBeInTheDocument());
    expect(fetchCalls.filter((c) => c.method === "DELETE").map((c) => c.body)).toEqual([
      JSON.stringify({ id: 1, base_version: 2, confirm: false }),
      JSON.stringify({ id: 1, base_version: 3, confirm: false }),
    ]);
  });

  it("keeps their version and reads the list again", async () => {
    const current = { ...ORDERS, port: 6543, version: 3, updated_by: "sam@example.test" };
    setRoutes([
      { match: "/api/connections", method: "GET", body: [ORDERS] },
      {
        match: "/api/connections",
        method: "PUT",
        status: 409,
        body: { error: 'sam@example.test saved "Orders DB" after you opened it.', conflict: true, current },
      },
    ]);
    render(<ConnectionsPage />);
    await loaded();
    fireEvent.click(within(rowFor("Orders DB")).getByRole("button", { name: /Edit/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    const modal = screen.getByRole("heading", { name: "Changed while you were editing" }).closest(
      ".modal-scrim"
    ) as HTMLElement;
    await waitFor(() => expect(modal).toHaveClass("open"));
    expect(within(modal).getByText("db.internal:6543/shop")).toBeInTheDocument();
    const gets = fetchCalls.filter((c) => c.method === "GET" && c.url === "/api/connections").length;
    fireEvent.click(within(modal).getByRole("button", { name: "Keep theirs" }));

    await waitFor(() =>
      expect(fetchCalls.filter((c) => c.method === "GET" && c.url === "/api/connections").length).toBe(gets + 1)
    );
    expect(fetchCalls.filter((c) => c.method === "PUT")).toHaveLength(1);
    expect(JSON.parse(fetchCalls.find((c) => c.method === "PUT")?.body ?? "{}").base_version).toBe(2);
  });
});

describe("the header, and the explanations that moved into Help", () => {
  it("shows the page's name and its one line from the help file", async () => {
    setRoutes([{ match: "/api/connections", body: [] }]);
    render(<ConnectionsPage />);
    await loaded();

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Connections");
    expect(screen.getByText(HELP_TOPICS["/connections"].blurb)).toBeInTheDocument();
  });

  it("keeps a field's explanation one click away, behind its question mark", async () => {
    setRoutes([{ match: "/api/connections", body: [] }]);
    render(<ConnectionsPage />);
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: /Add your first connection/ }));

    expect(screen.queryByText(/exporting are unaffected/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Help: Who may run migrations here" }));
    expect(screen.getByRole("note")).toHaveTextContent(/exporting are unaffected/);
    // The label still names the field on its own, without the question mark.
    expect(screen.getByLabelText("Who may run migrations here")).toBeInTheDocument();
  });
});
