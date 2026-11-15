/** @jest-environment jsdom */

/**
 * The dashboard's "Track a schema" drawer, on the race that made it offer the
 * wrong database's schemas.
 *
 * Picking a second connection while the first one's schema list was still
 * loading left the box filled from the connection nobody had selected — and
 * tracking one of those then failed with "schema not found", naming a schema
 * the screen had just offered. Nothing on the drawer said which connection the
 * list belonged to, so there was no way to tell from looking.
 *
 * The last part is about who may press the page's buttons. Tracking a schema
 * needs Drift tracking: Create, checking one needs Run (or Deploy: Run, which
 * the route takes as well), and stopping needs Delete. A role without a box
 * still sees the button, switched off, and the page says why once, under its
 * header, rather than under every card.
 */

import "@testing-library/jest-dom";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";

jest.mock("next-auth/react", () => require("./helpers/render-page").sessionStubs);

import StudioPage from "@/app/[org]/(studio)/studio/page";
import type { TrackedSchemaListItem } from "@/lib/lineage-db";
import {
  fetchCalls,
  flushAsync,
  holdNext,
  render,
  resetPageState,
  setCustomRole,
  setRoutes,
  setUser,
} from "./helpers/render-page";

const CONNECTIONS = [
  {
    id: 1,
    name: "Legacy box",
    host: "legacy.internal",
    database_name: "old",
    type: "PostgreSQL",
  },
  {
    id: 2,
    name: "New box",
    host: "new.internal",
    database_name: "shop",
    type: "PostgreSQL",
  },
];

/** One schema tracked on the first connection, not checked yet. */
const TRACKED: TrackedSchemaListItem = {
  id: 7,
  connectionId: 1,
  schemaName: "shop",
  label: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  connectionName: "Legacy box",
  connectionHost: "legacy.internal",
  connectionDatabase: "old",
  headVersion: "v1.0.0",
  headSeq: 1,
  migrationCount: 0,
  driftStatus: null,
  driftSummary: null,
  driftCheckedAt: null,
  driftAcknowledgedAt: null,
  driftIntervalMinutes: 0,
  lastCheckedAt: null,
};

/**
 * Answers for a dashboard with the two connections, tracking `tracked`:
 * nothing, unless a test says otherwise.
 *
 * The tracked-schema list is matched by a pattern anchored at the end rather
 * than by the substring "/api/lineage", which every other route under it starts
 * with too — a plain substring would answer the schema read with an empty
 * tracked list and the drawer would quietly offer nothing.
 */
/**
 * The small reads beside the list: who found the picked schema's state, and
 * the two facts the Getting started list asks about (a saved comparison set,
 * a GitHub token). Nothing has happened yet unless a test says otherwise.
 */
const SIDE_ROUTES = [
  { match: "/api/lineage/audit", body: [] },
  { match: "/api/comparison-sets", body: { sets: [] } },
  { match: "/api/admin/github", body: { source: "none", tokenUnreadable: false } },
];

function baseRoutes(tracked: TrackedSchemaListItem[] = []) {
  return [
    { match: "/api/connections", body: CONNECTIONS },
    { match: /\/api\/lineage$/, body: tracked },
    ...SIDE_ROUTES,
  ];
}

/** Open the card's More menu, where everything but the main action lives. */
async function openMore(schema: string) {
  fireEvent.click(await screen.findByRole("button", { name: `More actions for ${schema}` }));
}

/** Why each button is off, in the words the page uses. */
const refusal = {
  create: (role: string) =>
    `Your role (${role}) can't track a schema. ` +
    `Ask an admin to turn on "Track a schema" for this role.`,
  run: (role: string) =>
    `Your role (${role}) can't run a drift check. ` +
    `Ask an admin to turn on "Run a drift check" for this role.`,
  delete: (role: string) =>
    `Your role (${role}) can't stop tracking a schema. ` +
    `Ask an admin to turn on "Stop tracking a schema" for this role.`,
};

/** Open the drawer and wait for the connection list to arrive in it. */
async function openDrawer() {
  fireEvent.click(await screen.findByRole("button", { name: /Track a schema/ }));
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Connection" })).toBeEnabled()
  );
}

/** Pick one of the drawer's two dropdowns by its label. */
function pick(box: "Connection" | "Schema", option: string | RegExp) {
  fireEvent.click(screen.getByRole("combobox", { name: box }));
  fireEvent.click(screen.getByRole("option", { name: option }));
}

/** Every schema the Schema dropdown is currently offering. */
function schemasOffered(): string[] {
  fireEvent.click(screen.getByRole("combobox", { name: "Schema" }));
  const list = screen.getByRole("listbox");
  return within(list)
    .getAllByRole("option")
    .map((o) => o.textContent ?? "");
}

beforeEach(() => resetPageState());
afterEach(() => cleanup());

describe("picking a connection to track a schema on", () => {
  it("ignores a schema list that arrives after the reader moved on", async () => {
    setRoutes([
      ...baseRoutes(),
      {
        match: "/api/lineage/schemas",
        body: (url: string) =>
          url.includes("connectionId=1")
            ? { schemas: ["legacy_a", "legacy_b"] }
            : { schemas: ["shop_dev"] },
      },
    ]);
    render(<StudioPage />);
    await openDrawer();

    // The first connection is picked and its schema list is held in flight.
    const releaseLegacy = holdNext("/api/lineage/schemas");
    pick("Connection", /Legacy box/);
    expect(screen.getByRole("combobox", { name: "Schema" })).toBeDisabled();

    // The reader gives up on it and picks the other one, which answers.
    pick("Connection", /New box/);
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Schema" })).toBeEnabled()
    );

    // Now the first connection's list turns up. It is a true answer about a
    // connection nobody has selected, and the box is the only place the reader
    // would ever see it.
    releaseLegacy();
    await flushAsync();
    expect(schemasOffered()).toEqual(["shop_dev"]);
  });

  it("does not let a stale failure paint the connection now picked as broken", async () => {
    // The first connection's read fails, slowly. A guard on the success exit
    // alone would let this through, and a stale error misreports a working
    // connection as broken just as wrongly as a stale list fills the box.
    setRoutes([
      ...baseRoutes(),
      {
        match: "/api/lineage/schemas?connectionId=1",
        status: 500,
        body: { error: "Could not reach legacy.internal." },
      },
      { match: "/api/lineage/schemas", body: { schemas: ["shop_dev"] } },
    ]);
    render(<StudioPage />);
    await openDrawer();

    const releaseLegacy = holdNext("/api/lineage/schemas?connectionId=1");
    pick("Connection", /Legacy box/);
    pick("Connection", /New box/);
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Schema" })).toBeEnabled()
    );

    releaseLegacy();
    await flushAsync();
    expect(screen.queryByText("Could not reach legacy.internal.")).not.toBeInTheDocument();
    expect(schemasOffered()).toEqual(["shop_dev"]);
  });

  it("reports a failure that is about the connection actually picked", async () => {
    setRoutes([
      ...baseRoutes(),
      {
        match: "/api/lineage/schemas",
        status: 500,
        body: { error: "Could not reach legacy.internal." },
      },
    ]);
    render(<StudioPage />);
    await openDrawer();

    pick("Connection", /Legacy box/);
    expect(await screen.findByText("Could not reach legacy.internal.")).toBeInTheDocument();
    // Nothing to choose from, so the schema box stays shut rather than
    // offering the previous connection's list.
    expect(screen.getByRole("combobox", { name: "Schema" })).toBeDisabled();
  });
});

describe("a drifted schema's card", () => {
  it("leads to the drift detail rather than to another check", async () => {
    setRoutes(
      baseRoutes([{ ...TRACKED, driftStatus: "drifted", driftSummary: "1 column added" }])
    );
    render(<StudioPage />);

    const review = await screen.findByRole("link", { name: "Review drift on shop" });
    expect(review).toHaveAttribute("href", "/test-org/drift?tab=detail&schema=7");
    expect(review).toHaveClass("btn-primary");
    // One main action. Another check is still there, in the More menu.
    expect(screen.queryByRole("button", { name: /Check drift/ })).toBeNull();
    await openMore("shop");
    expect(screen.getByRole("menuitem", { name: "Check drift" })).toBeEnabled();
  });

  it("is not offered on a card that has not drifted", async () => {
    setRoutes(baseRoutes([TRACKED]));
    render(<StudioPage />);

    await screen.findByRole("button", { name: "More actions for shop" });
    expect(screen.queryByRole("link", { name: /Review drift/ })).toBeNull();
  });
});

describe("for a role that may not track, check or stop tracking", () => {
  it("switches each button off and says why once, under the header", async () => {
    setUser("viewer");
    setRoutes(baseRoutes([TRACKED]));
    render(<StudioPage />);

    await openMore("shop");
    const untrack = screen.getByRole("menuitem", { name: "Stop tracking shop" });
    const track = screen.getByRole("button", { name: /Track a schema/ });
    const check = screen.getByRole("button", { name: /Check drift/ });

    expect(track).toBeDisabled();
    expect(track).toHaveAttribute("title", refusal.create("Viewer"));
    expect(check).toBeDisabled();
    expect(check).toHaveAttribute("title", refusal.run("Viewer"));
    expect(untrack).toBeDisabled();
    expect(untrack).toHaveAttribute("title", refusal.delete("Viewer"));

    // Said once, as one sentence rather than a paragraph per button. The
    // buttons keep their own reasons, as tooltips.
    expect(
      screen.getAllByText(
        `Your role (Viewer) can't track a schema, run a drift check, or stop tracking a schema. ` +
          `Ask an admin to turn on "Track a schema", "Run a drift check", and "Stop tracking a schema" for this role.`
      )
    ).toHaveLength(1);
    for (const reason of [refusal.create, refusal.run, refusal.delete]) {
      expect(screen.queryByText(reason("Viewer"))).toBeNull();
    }
  });

  it("names only the button there is when nothing is tracked", async () => {
    // No cards, so nothing to check or stop tracking. "Track a schema" is
    // offered twice, in the header and in the empty state, and both are off.
    setUser("viewer");
    setRoutes(baseRoutes());
    render(<StudioPage />);

    await screen.findByText("Nothing tracked yet");
    const buttons = screen.getAllByRole("button", { name: /Track a schema/ });
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("title", refusal.create("Viewer"));
    }
    expect(screen.getByText(refusal.create("Viewer"))).toBeInTheDocument();
    expect(screen.queryByText(refusal.run("Viewer"))).toBeNull();
    expect(screen.queryByText(refusal.delete("Viewer"))).toBeNull();
  });

  it("opens no drawer when Track is pressed anyway", async () => {
    setUser("viewer");
    setRoutes(baseRoutes());
    render(<StudioPage />);
    await screen.findByText("Nothing tracked yet");

    for (const button of screen.getAllByRole("button", { name: /Track a schema/ })) {
      fireEvent.click(button);
    }
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("lets a role given Drift tracking: Run check, and still explains the rest", async () => {
    setCustomRole("watcher", "Watcher", ["drift:run"]);
    setRoutes([
      ...baseRoutes([TRACKED]),
      { match: "/api/lineage/drift", method: "POST", body: { status: "in_sync" } },
    ]);
    render(<StudioPage />);

    const check = await screen.findByRole("button", { name: /Check drift/ });
    expect(check).toBeEnabled();
    expect(check).not.toHaveAttribute("title");
    expect(
      screen.getByText(
        `Your role (Watcher) can't track a schema or stop tracking a schema. ` +
          `Ask an admin to turn on "Track a schema" and "Stop tracking a schema" for this role.`
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/run a drift check/)).toBeNull();

    fireEvent.click(check);
    await flushAsync();

    const checks = fetchCalls.filter((call) => call.url === "/api/lineage/drift");
    expect(checks).toHaveLength(1);
    expect(JSON.parse(String(checks[0].body))).toEqual({ trackedSchemaId: 7 });
  });

  it("and one given only Deploy: Run, which the route lets through too", async () => {
    setCustomRole("deployer", "Deployer", ["deploy:run"]);
    setRoutes(baseRoutes([TRACKED]));
    render(<StudioPage />);

    expect(await screen.findByRole("button", { name: /Check drift/ })).toBeEnabled();
    expect(screen.queryByText(/run a drift check/)).toBeNull();
  });
});

describe("the skyline", () => {
  const SECOND: TrackedSchemaListItem = {
    ...TRACKED,
    id: 8,
    schemaName: "billing",
    migrationCount: 4,
    driftStatus: "drifted",
    driftSummary: "1 table removed",
  };

  it("draws one building per tracked schema and says what each one is", async () => {
    setRoutes(baseRoutes([TRACKED, SECOND]));
    render(<StudioPage />);

    // Drifted stands first, so it is the one picked to begin with.
    const billing = await screen.findByRole("button", {
      name: "billing, Drifted, 4 recorded versions",
    });
    const shop = screen.getByRole("button", {
      name: "shop, Not checked yet, 0 recorded versions",
    });
    expect(billing).toHaveAttribute("aria-pressed", "true");
    expect(shop).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("link", { name: "Review drift on billing" })).toBeInTheDocument();
    expect(screen.getByText(/A taller one has more recorded versions/)).toBeInTheDocument();
  });

  it("shows the building you press, by mouse or by keyboard", async () => {
    setRoutes(baseRoutes([TRACKED, SECOND]));
    render(<StudioPage />);

    const shop = await screen.findByRole("button", { name: /^shop, / });
    fireEvent.click(shop);
    expect(shop).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "More actions for shop" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Review drift/ })).toBeNull();

    // A building is a real button, so Enter and Space press it without any
    // key handling of the page's own.
    const billing = screen.getByRole("button", { name: /^billing, / });
    expect(billing.tagName).toBe("BUTTON");
    fireEvent.click(billing);
    expect(screen.getByRole("button", { name: "More actions for billing" })).toBeInTheDocument();
  });

  it("lists what has drifted under Needs you, and picks it from there", async () => {
    setRoutes(baseRoutes([TRACKED, SECOND]));
    render(<StudioPage />);

    fireEvent.click(await screen.findByRole("button", { name: /^shop, / }));
    const row = screen.getByRole("button", { name: /billing.*1 table removed/ });
    fireEvent.click(row);
    expect(screen.getByRole("button", { name: "More actions for billing" })).toBeInTheDocument();
  });

  it("reads the table counts only when Tables is picked as the height", async () => {
    setRoutes([
      ...baseRoutes([TRACKED]),
      { match: "/api/lineage/7", body: { migrations: [{ snapshot: { tableCount: 12 } }] } },
    ]);
    render(<StudioPage />);

    await screen.findByRole("button", { name: /^shop, / });
    expect(fetchCalls.some((call) => call.url === "/api/lineage/7")).toBe(false);

    fireEvent.click(screen.getByRole("radio", { name: "Tables" }));
    expect(
      await screen.findByRole("button", { name: "shop, Not checked yet, 12 tables" })
    ).toBeInTheDocument();
    expect(screen.getByText(/had more tables in its latest recorded version/)).toBeInTheDocument();
  });

  it("says so when a table count cannot be read, rather than drawing a zero", async () => {
    setRoutes([
      ...baseRoutes([TRACKED]),
      { match: "/api/lineage/7", status: 500, body: { error: "no" } },
    ]);
    render(<StudioPage />);

    await screen.findByRole("button", { name: /^shop, / });
    fireEvent.click(screen.getByRole("radio", { name: "Tables" }));
    expect(
      await screen.findByRole("button", { name: "shop, Not checked yet, table count not known" })
    ).toBeInTheDocument();
    expect((await screen.findAllByText("Couldn't read")).length).toBeGreaterThan(0);
  });
});

describe("before anything is tracked", () => {
  it("sends somebody with no saved connection to add one first", async () => {
    setRoutes([
      { match: "/api/connections", body: [] },
      { match: /\/api\/lineage$/, body: [] },
      ...SIDE_ROUTES,
    ]);
    render(<StudioPage />);

    expect(await screen.findByText("Add a connection first")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Add a connection/ })).toHaveAttribute(
      "href",
      "/test-org/connections"
    );
    expect(screen.getByText("Step 1 of 3")).toBeInTheDocument();
  });

  it("says the list could not be read rather than that nothing is tracked", async () => {
    setRoutes([
      { match: "/api/connections", body: CONNECTIONS },
      { match: /\/api\/lineage$/, status: 500, body: { error: "down" } },
      ...SIDE_ROUTES,
    ]);
    render(<StudioPage />);

    expect(await screen.findByText("Couldn't load tracked schemas")).toBeInTheDocument();
    expect(screen.queryByText("Nothing tracked yet")).toBeNull();
    expect(screen.getByRole("button", { name: /Retry/ })).toBeInTheDocument();
  });
});

describe("the picked schema's card", () => {
  it("says the state in one line, with how often it is checked", async () => {
    setRoutes(baseRoutes([{ ...TRACKED, driftIntervalMinutes: 15 }]));
    render(<StudioPage />);

    expect(
      await screen.findByText("Not checked yet. Checks every 15 minutes.")
    ).toBeInTheDocument();
  });

  it("says who found the drift when the newest event tells it", async () => {
    const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    setRoutes([
      { match: "/api/lineage/audit", body: [{ source: "scheduled", status: "drifted" }] },
      ...baseRoutes([
        {
          ...TRACKED,
          driftStatus: "drifted",
          driftCheckedAt: dayAgo,
          lastCheckedAt: dayAgo,
          driftIntervalMinutes: 15,
        },
      ]),
    ]);
    render(<StudioPage />);

    expect(
      await screen.findByText(
        "Found by the scheduled check 1 day ago. Checks every 15 minutes."
      )
    ).toBeInTheDocument();
  });

  it("keeps the rest in a More menu that Escape closes", async () => {
    setRoutes(baseRoutes([TRACKED]));
    render(<StudioPage />);

    await openMore("shop");
    const more = screen.getByRole("button", { name: "More actions for shop" });
    expect(more).toHaveAttribute("aria-expanded", "true");
    const menu = screen.getByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((line) => line.textContent)
    ).toEqual(["Open", "Compare", "Stop tracking"]);
    // The first line has the focus, so the arrow keys work straight away.
    expect(within(menu).getByRole("menuitem", { name: "Open" })).toHaveFocus();

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(within(menu).getByRole("menuitem", { name: "Compare" })).toHaveFocus();

    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(more).toHaveFocus();
  });
});

describe("the Getting started list", () => {
  const HIDDEN_KEY = "schema-studio:setup-hidden:test-org";

  beforeEach(() => window.localStorage.clear());

  it("counts the steps that are done and offers the next ones", async () => {
    setRoutes(baseRoutes([TRACKED]));
    render(<StudioPage />);

    expect(await screen.findByText("Getting started")).toBeInTheDocument();
    // A connection is saved and a schema is tracked; no compare, no GitHub.
    expect(screen.getByText("2 of 4 done")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Start" })).toHaveAttribute(
      "href",
      "/test-org/compare"
    );
    expect(screen.getByRole("link", { name: "Set up GitHub" })).toHaveAttribute(
      "href",
      "/test-org/admin?tab=github"
    );
  });

  it("goes away once Hide is pressed, and stays away", async () => {
    setRoutes(baseRoutes([TRACKED]));
    const first = render(<StudioPage />);

    await screen.findByText("Getting started");
    fireEvent.click(screen.getByRole("button", { name: /Hide/ }));
    expect(screen.queryByText("Getting started")).toBeNull();
    expect(window.localStorage.getItem(HIDDEN_KEY)).toBe("1");

    // Opening the Dashboard again does not bring it back.
    first.unmount();
    render(<StudioPage />);
    await screen.findByRole("button", { name: "More actions for shop" });
    await flushAsync();
    expect(screen.queryByText("Getting started")).toBeNull();
  });

  it("goes away by itself when every step is done", async () => {
    setRoutes([
      { match: "/api/comparison-sets", body: { sets: [{ id: 1 }] } },
      { match: "/api/admin/github", body: { source: "organization", tokenUnreadable: false } },
      ...baseRoutes([TRACKED]),
    ]);
    render(<StudioPage />);

    await screen.findByRole("button", { name: "More actions for shop" });
    await flushAsync();
    expect(screen.queryByText("Getting started")).toBeNull();
  });

  it("tells somebody who is not an Admin that an Admin sets up GitHub", async () => {
    setUser("viewer");
    setRoutes(baseRoutes([TRACKED]));
    render(<StudioPage />);

    expect(await screen.findByText("An Admin sets this up.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Set up GitHub" })).toBeNull();
  });
});
