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
 */

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import StudioPage from "@/app/(studio)/studio/page";
import { flushAsync, holdNext, resetPageState, setRoutes } from "./helpers/render-page";

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

/**
 * Answers for a dashboard that tracks nothing yet and has the two connections.
 *
 * The tracked-schema list is matched by a pattern anchored at the end rather
 * than by the substring "/api/lineage", which every other route under it starts
 * with too — a plain substring would answer the schema read with an empty
 * tracked list and the drawer would quietly offer nothing.
 */
function baseRoutes() {
  return [
    { match: "/api/connections", body: CONNECTIONS },
    { match: /\/api\/lineage$/, body: [] },
  ];
}

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
