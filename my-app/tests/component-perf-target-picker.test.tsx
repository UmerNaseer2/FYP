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
 *  - The picker itself: opening it, the keyboard, the search box. That is
 *    components/studio/TargetPicker, and tests/component-target-picker.test.tsx
 *    covers it. These tests only drive it: press Change, press a row.
 *  - Which URL the panels underneath then fetch. tests/page-performance.test.tsx
 *    drives this picker through the page and checks the address the advice
 *    request carries. The seeds are checked here as well because the guards
 *    that keep them live in this file.
 *  - The two endpoints behind the reads. /api/connections has
 *    tests/connections-route.test.ts. /api/lineage/schemas has no suite of its
 *    own: tests/unreadable-credentials.test.ts calls its handler for the
 *    unreadable-credentials case and nothing else does.
 *  - Remembering the pair. The picker reports upward and nothing more; it does
 *    not write the choice back into the address bar, so a reload returns to the
 *    link's target or to the first saved server. That belongs to
 *    app/[org]/(studio)/performance/page.tsx.
 */

import "@testing-library/jest-dom";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";

import { PerfTargetPicker, type PerfTarget } from "@/components/studio/PerfTargetPicker";
import {
  fetchCalls,
  flushAsync,
  holdNext,
  render,
  resetPageState,
  setRoutes,
  type FetchRoute,
} from "./helpers/render-page";

const PG = {
  id: 1,
  name: "Local Postgres",
  database_name: "shop",
  type: "PostgreSQL",
};
const WAREHOUSE = {
  id: 2,
  name: "Warehouse",
  database_name: "dw",
  type: "PostgreSQL",
};
const MYSQL = {
  id: 3,
  name: "Orders MySQL",
  database_name: "orders",
  type: "MySQL",
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

const CHANGE = "Change looking at connection and schema";

/** The field that shows what is chosen. Its label is "Looking at". */
const field = () => screen.getByRole("group", { name: /Looking at/ });
const chosenConnection = () => field().querySelector("b")?.textContent ?? "";
const chosenSchema = () => field().querySelector(".tp__schema")?.textContent ?? "";

/** The open panel, opened first when it is shut. */
function panel() {
  if (!screen.queryByRole("dialog")) fireEvent.click(screen.getByRole("button", { name: CHANGE }));
  return screen.getByRole("dialog");
}

/** The names on the rows of one of the panel's two lists. */
function rowNames(list: "Connections" | "Schemas"): string[] {
  const group = within(panel()).getByRole("group", { name: list });
  return within(group)
    .queryAllByRole("button")
    .map((row) => row.querySelector(".tp__name")?.textContent ?? "");
}

/** Open the panel and choose another connection, the way a reader would. */
function pickConnection(name: string) {
  const group = within(panel()).getByRole("group", { name: "Connections" });
  const row = within(group)
    .getAllByRole("button")
    .find((button) => button.querySelector(".tp__name")?.textContent === name);
  fireEvent.click(row!);
}

/**
 * Both reads done. They are a chain, not a pair: the schema list cannot be
 * asked for until the connection list has said which server to ask about, so
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

    expect(rowNames("Connections")).toEqual(["Local Postgres", "Warehouse"]);
  });

  it("starts on the first usable server, not the first one saved", async () => {
    setRoutes(baseRoutes([MYSQL, WAREHOUSE, PG]));
    mount();
    await settle();

    expect(chosenConnection()).toBe("Warehouse");
    expect(schemaUrls()[0].url).toContain("connectionId=2");
  });

  it("leaves the picker out when there is no server to pick", async () => {
    // A picker that opens on an empty list says there is a choice to make
    // here, and there is not. The note says what is missing and where to go.
    setRoutes(baseRoutes([MYSQL]));
    mount();
    await settle();

    expect(await screen.findByText("No PostgreSQL connections saved")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Connections" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /connection and schema/ })).not.toBeInTheDocument();
    expect(schemaUrls()).toHaveLength(0);
  });
});

describe("the schema it lands on", () => {
  it("prefers public, whatever order the server listed them in", async () => {
    setRoutes(baseRoutes());
    mount();
    await settle();

    // "audit" is first in the list this server returned.
    expect(chosenSchema()).toBe("public");
  });

  it("falls back to the first schema on a server with no public", async () => {
    setRoutes(baseRoutes([PG], { "1": ["audit", "shop_dev"] }));
    mount();
    await settle();

    expect(chosenSchema()).toBe("audit");
  });

  it("says so when the login cannot see a single schema on the server", async () => {
    // The connection worked, so this is not a failure to report as one. It is
    // also not a screen anything below can be run on, and saying nothing
    // would leave an empty field with no reason beside it.
    setRoutes(baseRoutes([PG], { "1": [] }));
    const { onChange } = mount();
    await settle();

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(field()).toHaveTextContent("No schema chosen");
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

    expect(chosenConnection()).toBe("Warehouse");
  });

  it("opens on the schema the link named, when that server has it", async () => {
    setRoutes(baseRoutes());
    mount({ initialConnectionId: "1", initialSchema: "shop_dev" });
    await settle();

    expect(chosenSchema()).toBe("shop_dev");
  });

  it("ignores a schema the named server does not have", async () => {
    // A link is written on whichever screen the reader came from, and the name
    // it carries can belong to a different database entirely. Showing it as
    // selected would put a name in the field that nothing here answers to.
    setRoutes(baseRoutes());
    mount({ initialConnectionId: "2", initialSchema: "shop_dev" });
    await settle();

    expect(chosenSchema()).toBe("public");
  });

  it("is a starting point and not a lock", async () => {
    setRoutes(baseRoutes());
    mount({ initialConnectionId: "1", initialSchema: "shop_dev" });
    await settle();

    pickConnection("Warehouse");
    await settle();

    expect(chosenConnection()).toBe("Warehouse");
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
    expect(chosenSchema()).toBe("public");

    pickConnection("Warehouse");
    await settle();

    expect(chosenSchema()).toBe("warehouse");
  });
});

describe("changing the connection", () => {
  it("asks the new server for its own schemas", async () => {
    setRoutes(baseRoutes());
    mount();
    await settle();

    pickConnection("Warehouse");
    await settle();

    expect(schemaUrls().map((call) => call.url)).toHaveLength(2);
    expect(schemaUrls().at(-1)!.url).toContain("connectionId=2");
    expect(rowNames("Schemas")).toEqual(["public", "warehouse"]);
  });

  it("will not let a schema be chosen while the new server's list is on its way", async () => {
    // Offering the old server's schemas at this point would let a reader pick
    // a name that means nothing on the server they just moved to, and every
    // panel below would ask about it.
    setRoutes(baseRoutes());
    const { onChange } = mount();
    await settle();

    const release = holdNext("/api/lineage/schemas");
    pickConnection("Warehouse");
    await flushAsync();

    expect(rowNames("Schemas")).toEqual([]);
    expect(field()).toHaveTextContent("Loading schemas from Warehouse…");
    expect(onChange).toHaveBeenLastCalledWith(null);

    release();
    await settle();
    expect(chosenSchema()).toBe("public");
  });

  it("clears the complaint the server it left behind had made", async () => {
    setRoutes([
      { match: "/api/connections", body: [PG, WAREHOUSE] },
      { match: "/api/lineage/schemas", status: 500, body: { error: "the list could not be read" } },
    ]);
    mount();
    await settle();
    expect(await screen.findByText(/the list could not be read/)).toBeInTheDocument();

    setRoutes(baseRoutes());
    pickConnection("Warehouse");
    await settle();

    expect(screen.queryByText(/the list could not be read/)).not.toBeInTheDocument();
    expect(chosenSchema()).toBe("public");
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

    pickConnection("Warehouse");
    await settle();

    expect(onChange).toHaveBeenLastCalledWith({
      connectionId: "2",
      connectionName: "Warehouse",
      schema: "public",
    });
  });
});

describe("when the saved connections cannot be read", () => {
  it("says so instead of showing a picker with nothing in it", async () => {
    setRoutes([{ match: "/api/connections", status: 500, body: { error: "no" } }]);
    mount();
    await settle();

    expect(await screen.findByText(/Could not load your saved connections/)).toBeInTheDocument();
    // The picker goes: an empty one with no reason beside it reads as "you
    // have saved nothing", which is a different thing to fix.
    expect(screen.queryByRole("button", { name: /connection and schema/ })).not.toBeInTheDocument();
    expect(schemaUrls()).toHaveLength(0);
  });

  it("treats an answer that is not a list as a failure", async () => {
    // A 200 carrying something else is not an empty account. Rendering it as
    // one would tell a reader to go and save a connection they already have.
    setRoutes([{ match: "/api/connections", body: { error: "Not signed in" } }]);
    mount();
    await settle();

    expect(await screen.findByText(/Could not load your saved connections/)).toBeInTheDocument();
    expect(screen.queryByText("No PostgreSQL connections saved")).not.toBeInTheDocument();
  });

  it("treats the request never arriving as a failure", async () => {
    setRoutes([{ match: "/api/connections", networkError: true }]);
    mount();
    await settle();

    expect(await screen.findByText(/Could not load your saved connections/)).toBeInTheDocument();
  });

  it("reads the list again when asked, and carries on where it left off", async () => {
    setRoutes([{ match: "/api/connections", networkError: true }]);
    mount();
    await settle();
    expect(await screen.findByText(/Could not load your saved connections/)).toBeInTheDocument();

    setRoutes(baseRoutes());
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle();

    expect(screen.queryByText(/Could not load your saved connections/)).not.toBeInTheDocument();
    expect(chosenConnection()).toBe("Local Postgres");
    expect(chosenSchema()).toBe("public");
  });
});

describe("when the schemas cannot be listed", () => {
  it("prints what the server said, because the server knows why", async () => {
    setRoutes([
      { match: "/api/connections", body: [PG] },
      {
        match: "/api/lineage/schemas",
        status: 403,
        body: { error: "the list could not be read on shop" },
      },
    ]);
    mount();
    await settle();

    expect(await screen.findByText(/the list could not be read on shop/)).toBeInTheDocument();
    // The connection itself is fine, so the picker stays usable.
    expect(screen.getByRole("button", { name: CHANGE })).toBeEnabled();
    expect(field()).toHaveTextContent("No schema chosen");
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
    expect(await screen.findByText(/Network error while listing schemas\./)).toBeInTheDocument();

    setRoutes(baseRoutes([PG]));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle();

    expect(screen.queryByText(/Network error while listing schemas\./)).not.toBeInTheDocument();
    expect(chosenSchema()).toBe("public");
    expect(fetchCalls.filter((call) => call.url.includes("/api/connections"))).toHaveLength(1);
  });
});
