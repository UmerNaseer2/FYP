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
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

jest.mock("next-auth/react", () => require("./helpers/render-page").sessionStubs);

import StudioPage from "@/app/(studio)/studio/page";
import type { TrackedSchemaListItem } from "@/lib/lineage-db";
import {
  fetchCalls,
  flushAsync,
  holdNext,
  resetPageState,
  setCustomRole,
  setRoutes,
  setSessionLoading,
  setUser,
} from "./helpers/render-page";

const CONNECTIONS = [
  {
    id: 1,
    name: "Legacy box",
    host: "legacy.internal",
    database_name: "old",
    type: "PostgreSQL",
    environment: "dev",
  },
  {
    id: 2,
    name: "New box",
    host: "new.internal",
    database_name: "shop",
    type: "PostgreSQL",
    environment: "dev",
  },
];

/** One schema tracked on the first connection, not checked yet. */
const TRACKED: TrackedSchemaListItem = {
  id: 7,
  connectionId: 1,
  schemaName: "shop",
  label: null,
  environment: "dev",
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
function baseRoutes(tracked: TrackedSchemaListItem[] = []) {
  return [
    { match: "/api/connections", body: CONNECTIONS },
    { match: /\/api\/lineage$/, body: tracked },
  ];
}

/** Why each button is off, in the words the page uses. */
const refusal = {
  create: (role: string) =>
    `Your role (${role}) can't track a schema. ` +
    `Ask an admin to allow "Drift tracking: Create" for this role.`,
  run: (role: string) =>
    `Your role (${role}) can't run a drift check. ` +
    `Ask an admin to allow "Drift tracking: Run" for this role.`,
  delete: (role: string) =>
    `Your role (${role}) can't stop tracking a schema. ` +
    `Ask an admin to allow "Drift tracking: Delete" for this role.`,
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

describe("for a role that may not track, check or stop tracking", () => {
  it("switches each button off and says why once, under the header", async () => {
    setUser("viewer");
    setRoutes(baseRoutes([TRACKED]));
    render(<StudioPage />);

    const untrack = await screen.findByRole("button", { name: "Stop tracking shop" });
    const track = screen.getByRole("button", { name: /Track a schema/ });
    const check = screen.getByRole("button", { name: /Check drift/ });

    expect(track).toBeDisabled();
    expect(track).toHaveAttribute("title", refusal.create("Viewer"));
    expect(check).toBeDisabled();
    expect(check).toHaveAttribute("title", refusal.run("Viewer"));
    expect(untrack).toBeDisabled();
    expect(untrack).toHaveAttribute("title", refusal.delete("Viewer"));

    // Once each. The buttons carry them too, but as tooltips, not as text.
    for (const reason of [refusal.create, refusal.run, refusal.delete]) {
      expect(screen.getAllByText(reason("Viewer"))).toHaveLength(1);
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
    expect(screen.getByText(refusal.create("Watcher"))).toBeInTheDocument();
    expect(screen.getByText(refusal.delete("Watcher"))).toBeInTheDocument();
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

  it("does not tell a role that may not relabel to label them", async () => {
    // The environment picker on each card needs Drift tracking: Update.
    setUser("viewer");
    setRoutes(baseRoutes([{ ...TRACKED, environment: "unset" }]));
    render(<StudioPage />);

    expect(await screen.findByText(/1 tracked schema has/)).toBeInTheDocument();
    expect(screen.getByText(/Ask someone who may change schema environments/)).toBeInTheDocument();
    expect(screen.queryByText(/Label them so Compare/)).toBeNull();
  });

  it("says nothing while the session is still loading", async () => {
    // The server decides then. Switching the buttons off for a role nobody
    // knows yet would flash a refusal at everyone on every page load.
    setSessionLoading();
    setRoutes(baseRoutes([TRACKED]));
    render(<StudioPage />);

    const untrack = await screen.findByRole("button", { name: "Stop tracking shop" });
    expect(untrack).toBeEnabled();
    expect(screen.getByRole("button", { name: /Track a schema/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Check drift/ })).toBeEnabled();
    expect(screen.queryByText(/Your role/)).toBeNull();
  });
});
