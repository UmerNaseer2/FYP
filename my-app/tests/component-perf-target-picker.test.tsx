/** @jest-environment jsdom */

/**
 * PerfTargetPicker: the "which database, which schema" bar above every
 * Performance tab.
 *
 * Every panel on that screen — the suggestions, the analyser, the trends, the
 * live activity — asks about the one pair this bar holds, and none of them can
 * tell a wrong answer from a right one. Advice about the wrong database does
 * not look like a failure. It looks like advice. That is why the bar picks for
 * the reader rather than opening as two empty boxes, and why what it picks has
 * to be a pair that actually exists.
 *
 * Three of its decisions are the reason it is worth a suite of its own:
 *
 *   It offers only the servers the rules behind this screen can be run against,
 *   and only the schemas the chosen server really answers to. Offering either
 *   of the others produces advice from counters that database does not have, or
 *   from a schema it would refuse.
 *
 *   A target carried in from another screen is a starting point, not a lock.
 *   The reader has to be able to look somewhere else without being snapped back
 *   to where the link pointed.
 *
 *   Its two reads fail on their own terms, each with its own words and its own
 *   retry. A schema list that could not be read must not look like a server
 *   with no schemas: one of those is worth fixing and the other is worth
 *   knowing, and a reader cannot act on the wrong one.
 *
 * What is NOT here:
 *  - The combobox itself — opening it, the keyboard, re-seeding from its prop.
 *    That is components/ui/Select, and tests/component-select.test.tsx covers
 *    it. These tests only drive it: click the trigger, click an option.
 *  - Which URL the panels underneath then fetch. tests/page-performance.test.tsx
 *    drives this picker through the page and checks the address the advice
 *    request carries. The seeds are checked here as well because the guards
 *    that keep them live in this file.
 *  - The two endpoints behind the reads. /api/connections has
 *    tests/connections-route.test.ts. /api/lineage/schemas has no suite of its
 *    own: tests/unreadable-credentials.test.ts calls its handler for the
 *    unreadable-credentials case and nothing else does.
 *  - The words on the environment pill. toEnvironment is covered in
 *    tests/deploy-safety.test.ts, and the ENVIRONMENT_META labels are written
 *    out in tests/component-schema-environment-picker.test.tsx — the screen
 *    they are edited on — so a wrong label would be caught there rather than
 *    here. These tests check only that the pill follows the connection that is
 *    selected.
 *  - Remembering the pair. The picker reports upward and nothing more; it does
 *    not write the choice back into the address bar, so a reload returns to the
 *    link's target or to the first saved server. That belongs to
 *    app/(studio)/performance/page.tsx.
 */

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { PerfTargetPicker, type PerfTarget } from "@/components/studio/PerfTargetPicker";
import {
  fetchCalls,
  flushAsync,
  holdNext,
  resetPageState,
  setRoutes,
  type FetchRoute,
} from "./helpers/render-page";

const PG = {
  id: 1,
  name: "Local Postgres",
  database_name: "shop",
  type: "PostgreSQL",
  environment: "dev",
};
const WAREHOUSE = {
  id: 2,
  name: "Warehouse",
  database_name: "dw",
  type: "PostgreSQL",
  environment: "prod",
};
const MYSQL = {
  id: 3,
  name: "Orders MySQL",
  database_name: "orders",
  type: "MySQL",
  environment: "prod",
};

/** What each server answers with, so a switch between them is visible. */
const LISTS: Record<string, string[]> = {
  "1": ["audit", "public", "shop_dev"],
  "2": ["public", "warehouse"],
};

function baseRoutes(
  connections: unknown = [PG, WAREHOUSE],
  lists: Record<string, string[]> = LISTS
): FetchRoute[] {
  return [
    { match: "/api/connections", body: connections },
    {
      match: "/api/lineage/schemas",
      body: (url: string) => {
        const id = new URL(url, "http://test").searchParams.get("connectionId") ?? "";
        return { schemas: lists[id] ?? [] };
      },
    },
  ];
}

function mount(props: { initialConnectionId?: string | null; initialSchema?: string | null } = {}) {
  const onChange = jest.fn<void, [PerfTarget | null]>();
  const view = render(<PerfTargetPicker onChange={onChange} {...props} />);
  return { onChange, ...view };
}

const combo = (name: string) => screen.getByRole("combobox", { name });

/** Open one of the two boxes and choose from it, the way a reader would. */
function pick(box: string, option: string) {
  fireEvent.click(combo(box));
  fireEvent.click(screen.getByRole("option", { name: option }));
}

/**
 * Both reads done. They are a chain, not a pair — the schema list cannot be
 * asked for until the connection list has said which server to ask about — so
 * one flush is not enough.
 */
async function settle() {
  await flushAsync();
  await flushAsync();
}

const schemaUrls = () => fetchCalls.filter((call) => call.url.includes("/lineage/schemas"));

beforeEach(() => resetPageState());
afterEach(() => cleanup());

describe("what it offers to analyse", () => {
  it("offers only the servers these rules can be run against", async () => {
    // Every rule behind this screen reads pg_stat_user_tables, which no other
    // engine has. A MySQL connection in this list is not a target; it is an
    // invitation to produce advice from counters that do not exist.
    setRoutes(baseRoutes([MYSQL, PG, WAREHOUSE]));
    mount();
    await settle();

    fireEvent.click(combo("Connection to analyse"));
    expect(screen.getAllByRole("option").map((option) => option.textContent?.trim())).toEqual([
      "Local Postgres (shop)",
      "Warehouse (dw)",
    ]);
  });

  it("starts on the first usable server, not the first one saved", async () => {
    setRoutes(baseRoutes([MYSQL, WAREHOUSE, PG]));
    mount();
    await settle();

    expect(combo("Connection to analyse")).toHaveTextContent("Warehouse (dw)");
    expect(schemaUrls()[0].url).toContain("connectionId=2");
  });

  it("stops the schema row claiming to load when there is nothing to load one for", async () => {
    // The row starts out saying "Loading schemas…" because normally one is on
    // its way. With no server to ask, nothing would ever arrive to change it,
    // and the reader would be left watching a list that is never coming.
    setRoutes(baseRoutes([MYSQL]));
    mount();
    await settle();

    expect(await screen.findByText("No PostgreSQL connections saved")).toBeInTheDocument();
    expect(combo("Schema to analyse")).toHaveTextContent("Select a schema");
    // An empty box that opens is worse than one that does not: it says there
    // is a choice to make here, and there is not.
    expect(combo("Connection to analyse")).toBeDisabled();
    expect(schemaUrls()).toHaveLength(0);
  });
});

describe("the schema it lands on", () => {
  it("prefers public, whatever order the server listed them in", async () => {
    setRoutes(baseRoutes());
    mount();
    await settle();

    // "audit" is first in the list this server returned.
    expect(combo("Schema to analyse")).toHaveTextContent("public");
  });

  it("falls back to the first schema on a server with no public", async () => {
    setRoutes(baseRoutes([PG], { "1": ["audit", "shop_dev"] }));
    mount();
    await settle();

    expect(combo("Schema to analyse")).toHaveTextContent("audit");
  });

  it("says so when the login cannot see a single schema on the server", async () => {
    // The connection worked, so this is not a failure to report as one — but
    // it is also not a screen anything below can be run on, and saying nothing
    // would leave an empty box with no reason beside it.
    setRoutes(baseRoutes([PG], { "1": [] }));
    const { onChange } = mount();
    await settle();

    expect(await screen.findByText("This server has no readable schemas")).toBeInTheDocument();
    expect(
      screen.getByText("The connection worked, but this user cannot see any schema on it.")
    ).toBeInTheDocument();
    expect(combo("Schema to analyse")).toBeDisabled();
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});

describe("a target carried in from a link", () => {
  it("opens on the server the link named, not the first one saved", async () => {
    // Both are saved and the first one is not the one the link names. Without
    // the seed every panel below would be about the wrong database, and would
    // read as perfectly ordinary advice.
    setRoutes(baseRoutes());
    mount({ initialConnectionId: "2" });
    await settle();

    expect(combo("Connection to analyse")).toHaveTextContent("Warehouse (dw)");
  });

  it("opens on the schema the link named, when that server has it", async () => {
    setRoutes(baseRoutes());
    mount({ initialConnectionId: "1", initialSchema: "shop_dev" });
    await settle();

    expect(combo("Schema to analyse")).toHaveTextContent("shop_dev");
  });

  it("ignores a schema the named server does not have", async () => {
    // A link is written on whichever screen the reader came from, and the name
    // it carries can belong to a different database entirely. Showing it as
    // selected would put a name in the box that nothing here answers to.
    setRoutes(baseRoutes());
    mount({ initialConnectionId: "2", initialSchema: "shop_dev" });
    await settle();

    expect(combo("Schema to analyse")).toHaveTextContent("public");
  });

  it("is a starting point and not a lock", async () => {
    setRoutes(baseRoutes());
    mount({ initialConnectionId: "1", initialSchema: "shop_dev" });
    await settle();

    pick("Connection to analyse", "Warehouse (dw)");
    await settle();

    expect(combo("Connection to analyse")).toHaveTextContent("Warehouse (dw)");
    expect(schemaUrls().at(-1)!.url).toContain("connectionId=2");
  });

  it("seeds every schema list the named schema fits, not only the first", async () => {
    // The seed is read once per list rather than once per mount. A reader who
    // moves to another server that happens to have the same schema name is
    // still looking at the schema they followed the link for, which is the
    // reading that matches what they asked for.
    setRoutes(baseRoutes());
    mount({ initialConnectionId: "1", initialSchema: "warehouse" });
    await settle();
    expect(combo("Schema to analyse")).toHaveTextContent("public");

    pick("Connection to analyse", "Warehouse (dw)");
    await settle();

    expect(combo("Schema to analyse")).toHaveTextContent("warehouse");
  });
});

describe("changing the connection", () => {
  it("asks the new server for its own schemas", async () => {
    setRoutes(baseRoutes());
    mount();
    await settle();

    pick("Connection to analyse", "Warehouse (dw)");
    await settle();

    expect(schemaUrls().map((call) => call.url)).toHaveLength(2);
    expect(schemaUrls().at(-1)!.url).toContain("connectionId=2");
    fireEvent.click(combo("Schema to analyse"));
    expect(screen.getAllByRole("option").map((option) => option.textContent?.trim())).toEqual([
      "public",
      "warehouse",
    ]);
  });

  it("will not let a schema be chosen while the new server's list is on its way", async () => {
    // The box still holds the old server's schemas at this point. Leaving it
    // open would let a reader pick a name that means nothing on the server
    // they just moved to, and every panel below would ask about it.
    setRoutes(baseRoutes());
    const { onChange } = mount();
    await settle();

    const release = holdNext("/api/lineage/schemas");
    pick("Connection to analyse", "Warehouse (dw)");
    await flushAsync();

    expect(combo("Schema to analyse")).toBeDisabled();
    expect(combo("Schema to analyse")).toHaveTextContent("Loading schemas…");
    expect(onChange).toHaveBeenLastCalledWith(null);

    release();
    await settle();
    expect(combo("Schema to analyse")).toHaveTextContent("public");
  });

  it("clears the complaint the server it left behind had made", async () => {
    setRoutes([
      { match: "/api/connections", body: [PG, WAREHOUSE] },
      { match: "/api/lineage/schemas", status: 500, body: { error: "permission denied" } },
    ]);
    mount();
    await settle();
    expect(await screen.findByText("Could not list schemas")).toBeInTheDocument();

    setRoutes(baseRoutes());
    pick("Connection to analyse", "Warehouse (dw)");
    await settle();

    expect(screen.queryByText("Could not list schemas")).not.toBeInTheDocument();
    expect(combo("Schema to analyse")).toHaveTextContent("public");
  });
});

describe("what it reports upward", () => {
  it("reports nothing at all until both halves are real", async () => {
    // A tab that fired at half a target would ask about a connection with no
    // schema, and get an answer about whichever schema the server felt like.
    setRoutes(baseRoutes());
    const release = holdNext("/api/lineage/schemas");
    const { onChange } = mount();
    await settle();

    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls.every(([target]) => target === null)).toBe(true);

    release();
    await settle();
    expect(onChange).toHaveBeenLastCalledWith({
      connectionId: "1",
      connectionName: "Local Postgres",
      schema: "public",
    });
  });

  it("reports the server's name as well as its id", async () => {
    // The panels print the name. Reporting the id alone would leave them
    // saying "advice for connection 2", which names nothing a reader saved.
    setRoutes(baseRoutes());
    const { onChange } = mount();
    await settle();

    pick("Connection to analyse", "Warehouse (dw)");
    await settle();

    expect(onChange).toHaveBeenLastCalledWith({
      connectionId: "2",
      connectionName: "Warehouse",
      schema: "public",
    });
  });
});

describe("when the saved connections cannot be read", () => {
  it("says so instead of showing two boxes with nothing in them", async () => {
    setRoutes([{ match: "/api/connections", status: 500, body: { error: "no" } }]);
    mount();
    await settle();

    expect(await screen.findByText("Could not load your saved connections")).toBeInTheDocument();
    // The whole bar goes: two empty dropdowns with no reason beside them read
    // as "you have saved nothing", which is a different thing to fix.
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(schemaUrls()).toHaveLength(0);
  });

  it("treats an answer that is not a list as a failure", async () => {
    // A 200 carrying something else is not an empty account. Rendering it as
    // one would tell a reader to go and save a connection they already have.
    setRoutes([{ match: "/api/connections", body: { error: "Not signed in" } }]);
    mount();
    await settle();

    expect(await screen.findByText("Could not load your saved connections")).toBeInTheDocument();
    expect(screen.queryByText("No PostgreSQL connections saved")).not.toBeInTheDocument();
  });

  it("treats the request never arriving as a failure", async () => {
    setRoutes([{ match: "/api/connections", networkError: true }]);
    mount();
    await settle();

    expect(await screen.findByText("Could not load your saved connections")).toBeInTheDocument();
  });

  it("reads the list again when asked, and carries on where it left off", async () => {
    setRoutes([{ match: "/api/connections", networkError: true }]);
    mount();
    await settle();
    expect(await screen.findByText("Could not load your saved connections")).toBeInTheDocument();

    setRoutes(baseRoutes());
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle();

    expect(screen.queryByText("Could not load your saved connections")).not.toBeInTheDocument();
    expect(combo("Connection to analyse")).toHaveTextContent("Local Postgres (shop)");
    expect(combo("Schema to analyse")).toHaveTextContent("public");
  });
});

describe("when the schemas cannot be listed", () => {
  it("prints what the server said, because the server knows why", async () => {
    setRoutes([
      { match: "/api/connections", body: [PG] },
      {
        match: "/api/lineage/schemas",
        status: 403,
        body: { error: "permission denied for database shop" },
      },
    ]);
    mount();
    await settle();

    expect(await screen.findByText("Could not list schemas")).toBeInTheDocument();
    expect(screen.getByText(/permission denied for database shop/)).toBeInTheDocument();
    // The connection itself is fine, so the server list stays usable.
    expect(combo("Connection to analyse")).toBeEnabled();
    expect(combo("Schema to analyse")).toBeDisabled();
  });

  it("has words of its own when the server sent none", async () => {
    setRoutes([
      { match: "/api/connections", body: [PG] },
      { match: "/api/lineage/schemas", status: 500, body: {} },
    ]);
    mount();
    await settle();

    expect(
      await screen.findByText(/Could not list the schemas on this server\./)
    ).toBeInTheDocument();
  });

  it("says the request never arrived, rather than blaming the server", async () => {
    setRoutes([
      { match: "/api/connections", body: [PG] },
      { match: "/api/lineage/schemas", networkError: true },
    ]);
    mount();
    await settle();

    expect(await screen.findByText(/Network error while listing schemas\./)).toBeInTheDocument();
  });

  it("does not read the connections again to list the schemas again", async () => {
    // Two reads, two retries. Re-reading the connection list would throw away
    // a selection that was never the thing that failed.
    setRoutes([
      { match: "/api/connections", body: [PG] },
      { match: "/api/lineage/schemas", networkError: true },
    ]);
    mount();
    await settle();
    expect(await screen.findByText("Could not list schemas")).toBeInTheDocument();

    setRoutes(baseRoutes([PG]));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle();

    expect(screen.queryByText("Could not list schemas")).not.toBeInTheDocument();
    expect(combo("Schema to analyse")).toHaveTextContent("public");
    expect(fetchCalls.filter((call) => call.url.includes("/api/connections"))).toHaveLength(1);
  });
});

describe("the environment of the server being analysed", () => {
  it("labels the chosen server with the environment it was saved under", async () => {
    setRoutes(baseRoutes());
    mount();
    await settle();

    expect(screen.getByText("Dev")).toBeInTheDocument();
  });

  it("follows the server the reader moves to", async () => {
    // The pill is the only warning on this screen that the thing being read is
    // production. Leaving it on the last server's label would be worse than
    // not showing one at all.
    setRoutes(baseRoutes());
    mount();
    await settle();

    pick("Connection to analyse", "Warehouse (dw)");
    await settle();

    expect(screen.getByText("Production")).toBeInTheDocument();
    expect(screen.queryByText("Dev")).not.toBeInTheDocument();
  });

  it("says a server was never labelled rather than guessing one", async () => {
    setRoutes(baseRoutes([{ ...PG, environment: null }]));
    mount();
    await settle();

    await waitFor(() => expect(screen.getByText("Unlabelled")).toBeInTheDocument());
  });
});
