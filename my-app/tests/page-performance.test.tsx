/** @jest-environment jsdom */

/**
 * The Performance screen: six tabs over one target.
 *
 * Almost everything here turns on two inputs that arrive in the address bar.
 * The tab decides which of six panels is on screen; the connection and schema
 * decide which database every one of them is asking about. Both are handed
 * over by links made on OTHER screens — "see every run of this query" from the
 * analyser, "this table is always scanned" from a suggestion — so getting them
 * wrong does not look like a failure. It looks like advice, about a database
 * nobody asked about.
 */

import "@testing-library/jest-dom";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

jest.mock("next/navigation", () => require("./helpers/render-page").navigationStubs);
jest.mock("next-auth/react", () => require("./helpers/render-page").sessionStubs);

import PerformancePage from "@/app/(studio)/performance/page";
import {
  fetchCalls,
  resetPageState,
  setRoutes,
  setSearchParams,
  type FetchRoute,
} from "./helpers/render-page";

const POSTGRES = {
  id: 1,
  name: "Local Postgres",
  host: "localhost",
  database_name: "shop",
  type: "PostgreSQL",
  environment: "dev",
};
const SECOND_POSTGRES = { ...POSTGRES, id: 2, name: "Warehouse", database_name: "dw" };

/** An analysis that came back clean, so the panel renders rather than fails. */
const CLEAN_ADVICE = {
  connectionName: "Local Postgres",
  database: "shop",
  schema: "public",
  advice: [],
  counts: { high: 0, medium: 0, low: 0, total: 0 },
  tablesAnalyzed: 4,
  statsUnavailable: null,
  patternsUnavailable: null,
};

/**
 * The two reads the picker makes, plus the suggestions panel underneath it.
 *
 * The schema list is keyed on the connection: a test that links to the second
 * server has to be able to say what that server actually has, which is the
 * whole point of the check it exercises.
 */
function baseRoutes(connections: unknown[] = [POSTGRES, SECOND_POSTGRES]): FetchRoute[] {
  return [
    { match: "/api/connections", body: connections },
    {
      match: "/api/lineage/schemas",
      body: (url: string) =>
        url.includes("connectionId=2")
          ? { schemas: ["public", "warehouse"] }
          : { schemas: ["public", "shop_dev"] },
    },
    { match: "/api/performance/advice", body: CLEAN_ADVICE },
  ];
}

/** The URL the suggestions panel asked about, once it has asked. */
async function adviceRequest(): Promise<string> {
  await waitFor(() => expect(fetchCalls.some((c) => c.url.includes("/advice"))).toBe(true));
  return fetchCalls.find((c) => c.url.includes("/advice"))!.url;
}

beforeEach(() => resetPageState());
afterEach(() => cleanup());

describe("which tab the Performance screen opens on", () => {
  it("opens on Suggestions and says which tab is open to a screen reader", async () => {
    setRoutes(baseRoutes());
    render(<PerformancePage />);

    expect(screen.getByRole("heading", { name: "Performance suggestions" })).toBeInTheDocument();
    // The tabs were styled-only until this landed: a screen reader heard six
    // identical links and no clue which one it was already on.
    expect(screen.getByRole("link", { name: "Suggestions" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(screen.getByRole("link", { name: "Trends" })).not.toHaveAttribute("aria-current");
    await adviceRequest();
  });

  it("opens the tab named in the address", async () => {
    setSearchParams("tab=alerts");
    setRoutes([...baseRoutes(), { match: "/api/performance/thresholds", body: { rules: [] } }]);
    render(<PerformancePage />);

    expect(screen.getByRole("heading", { name: "Alert thresholds" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Alerts" })).toHaveAttribute("aria-current", "page");
    // The header is drawn before anything is fetched, so the assertions above
    // pass with the picker's reads still in flight. Waiting for the panel's own
    // read is what makes this a test of the tab that opened rather than of the
    // heading alone — and it keeps the loads inside the test that started them.
    await waitFor(() =>
      expect(fetchCalls.some((c) => c.url.includes("/thresholds"))).toBe(true)
    );
  });

  it("falls back to Suggestions for a tab name it does not know", async () => {
    // Links are written by hand and by other screens, so a name that is not one
    // of the six has to land somewhere sensible rather than on an empty page.
    setSearchParams("tab=whatever");
    setRoutes(baseRoutes());
    render(<PerformancePage />);

    expect(screen.getByRole("heading", { name: "Performance suggestions" })).toBeInTheDocument();
    await adviceRequest();
  });
});

describe("which database the Performance screen asks about", () => {
  it("starts on the database the link arrived with, not the first one saved", async () => {
    // Both servers are saved and the first one is NOT the one the link names.
    // Without the seed the advice below would be about the wrong database and
    // would read as perfectly ordinary advice.
    setSearchParams("connectionId=2&schema=warehouse");
    setRoutes(baseRoutes());
    render(<PerformancePage />);

    const asked = await adviceRequest();
    expect(asked).toContain("connectionId=2");
    expect(asked).toContain("schema=warehouse");
  });

  it("ignores a schema the linked server does not have", async () => {
    // A link from another screen can name a schema that only exists on the
    // database it was made on. Showing it as selected would put a name in the
    // box that nothing here answers to, and every panel would then ask about
    // a schema the server would refuse.
    setSearchParams("connectionId=2&schema=shop_dev");
    setRoutes(baseRoutes());
    render(<PerformancePage />);

    const asked = await adviceRequest();
    expect(asked).toContain("connectionId=2");
    expect(asked).toContain("schema=public");
  });

  it("says so when there is no server it can analyse at all", async () => {
    // Every rule behind this screen is a PostgreSQL rule, so a saved MySQL
    // connection is not a target. Offering it would produce advice from
    // counters that database does not have.
    setRoutes(baseRoutes([{ ...POSTGRES, type: "MySQL" }]));
    render(<PerformancePage />);

    expect(await screen.findByText("No PostgreSQL connections saved")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Connection to analyse" })).toBeDisabled();
  });
});
