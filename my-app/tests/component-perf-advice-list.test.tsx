/** @jest-environment jsdom */

/**
 * The Suggestions tab: what one schema's analysis looks like once it comes
 * back.
 *
 * The screen's whole job is to be trusted with a list of SQL statements
 * somebody is going to run against a real database, and most of what it does
 * is about not overstating what it knows.
 *
 * Three of those decisions are why it is worth a suite of its own:
 *
 *   An answer belongs to the pair it was asked about. Which target the answer
 *   on screen came from is derived from the request, not remembered, so moving
 *   the picker cannot leave one database's advice under another database's
 *   name — the failure nobody would see, because advice about the wrong
 *   database does not look wrong.
 *
 *   Half an analysis says which half. Two of the passes can fail on their own —
 *   the server's counters and this app's own record of analysed queries — and
 *   when one does, the screen prints why and names the checks that did not run.
 *   "Nothing to flag" with the counters down would otherwise be a clean bill of
 *   health for checks that were never made.
 *
 *   The filter is a view, not a selection. It narrows what is on screen; the
 *   script builder underneath still gets every suggestion, because the ticks in
 *   it are what decides the script. A filter left on a severity this run has
 *   none of falls back to All, because an empty list under a full set of counts
 *   reads as results that failed to load.
 *
 * What is NOT here:
 *  - The advice itself: which rules fire, what each one says, and the SQL it
 *    carries. That is lib/perf-advice, covered by tests/perf-advice.test.ts and
 *    tests/perf-sql.test.ts. Every finding here is a fixture.
 *  - What one finding looks like. FindingCard, OriginBadge and SeverityFilter
 *    are tests/component-finding-card.test.tsx; this file checks only that the
 *    right ones are built, with the right origin on them.
 *  - The script builder underneath. tests/component-fix-script-builder.test.tsx
 *    covers what it does with the items; the only thing checked here is which
 *    items it is handed.
 *  - The picker above. tests/component-perf-target-picker.test.tsx.
 *  - The route that answers. GET /api/performance/advice has no suite of its
 *    own: tests/page-performance.test.tsx checks the address this screen asks
 *    for through the page, and nothing anywhere calls its handler.
 *  - Escaping the connection id into the request. The schema is escaped here
 *    because a schema name really can hold a space, but a connection id that
 *    needed escaping has no way to arrive: the picker reads ids off saved rows
 *    as digits, and one carried in on a link is only passed on once the schema
 *    list came back for it, which a junk id never gets. Removing that escape
 *    breaks nothing here, and a fixture written to catch it would be a target
 *    the app cannot produce.
 */

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

jest.mock("next/navigation", () => require("./helpers/render-page").navigationStubs);
jest.mock("next-auth/react", () => require("./helpers/render-page").sessionStubs);

import { PerfAdviceList } from "@/components/studio/PerfAdviceList";
import type { PerfTarget } from "@/components/studio/PerfTargetPicker";
import type { AdviceItem, AdviceView } from "@/lib/perf-advice";
import { fetchCalls, flushAsync, resetPageState, setRoutes, setUser } from "./helpers/render-page";

const SHOP: PerfTarget = { connectionId: "1", connectionName: "Local Postgres", schema: "public" };
const WAREHOUSE: PerfTarget = { connectionId: "2", connectionName: "Warehouse", schema: "public" };

/** One finding of each severity, each from a different pass. */
const MISSING_INDEX: AdviceItem = {
  id: "fk-no-index",
  severity: "high",
  title: "This foreign key has no index",
  object: "public.orders.customer_id",
  detail: "Every delete of a customer scans the whole orders table.",
  fix: "CREATE INDEX CONCURRENTLY orders_customer_id_idx ON public.orders (customer_id);",
  fixKind: "change",
  undo: "DROP INDEX CONCURRENTLY public.orders_customer_id_idx;",
  origin: "structure",
};

const DEAD_ROWS: AdviceItem = {
  id: "dead-rows",
  severity: "medium",
  title: "This table is mostly dead rows",
  object: "public.sessions",
  detail: "Four in five rows here are waiting to be cleaned up.",
  fix: "VACUUM (ANALYZE) public.sessions;",
  fixKind: "maintenance",
  origin: "statistics",
};

const SHARED_FILTER: AdviceItem = {
  id: "shared-filter",
  severity: "low",
  title: "Several analysed queries filter on the same columns",
  object: "public.orders",
  detail: "One index across them would answer all four.",
  fix: "-- Decide whether these four queries are worth one index.",
  fixKind: "decision",
  origin: "queries",
};

function view(over: Partial<AdviceView> = {}): AdviceView {
  const advice = over.advice ?? [MISSING_INDEX, DEAD_ROWS, SHARED_FILTER];
  return {
    connectionName: "Local Postgres",
    database: "shop",
    schema: "public",
    advice,
    counts: {
      high: advice.filter((a) => a.severity === "high").length,
      medium: advice.filter((a) => a.severity === "medium").length,
      low: advice.filter((a) => a.severity === "low").length,
      total: advice.length,
    },
    tablesAnalyzed: 9,
    statsUnavailable: null,
    patternsUnavailable: null,
    ...over,
  };
}

const ADVICE = "/api/performance/advice";

function mount(target: PerfTarget | null = SHOP) {
  return render(<PerfAdviceList target={target} />);
}

/** One per finding: the severity stripe is the only thing a card has exactly one of. */
const cardCount = (container: HTMLElement) =>
  container.querySelectorAll('[style*="border-left"]').length;

const adviceCalls = () => fetchCalls.filter((call) => call.url.includes("/performance/advice"));

beforeEach(() => {
  resetPageState();
  // The script builder underneath asks who is reading before it offers to save
  // a migration. Nothing here depends on the answer, but an undecided session
  // would leave it in its loading state.
  setUser("editor");
});
afterEach(() => cleanup());

describe("before a database has been chosen", () => {
  it("asks for one, and asks the server nothing", async () => {
    setRoutes([{ match: ADVICE, body: view() }]);
    mount(null);
    await flushAsync();

    expect(
      screen.getByText("Choose a PostgreSQL connection and a schema above to analyse it.")
    ).toBeInTheDocument();
    expect(adviceCalls()).toHaveLength(0);
  });
});

describe("the answer belongs to the pair it was asked about", () => {
  it("asks about the pair the picker is on", async () => {
    setRoutes([{ match: ADVICE, body: view() }]);
    render(<PerfAdviceList target={{ ...SHOP, schema: "shop dev" }} />);
    await flushAsync();

    expect(adviceCalls()[0].url).toContain("connectionId=1");
    expect(adviceCalls()[0].url).toContain("schema=shop%20dev");
  });

  it("goes back to loading when the picker moves to another database", async () => {
    setRoutes([{ match: ADVICE, body: view() }]);
    const { rerender } = mount();
    await flushAsync();
    // The detail, not the title: a title is on screen twice, once on the card
    // and once as the label of its checkbox in the script builder.
    expect(screen.getByText(MISSING_INDEX.detail)).toBeInTheDocument();

    // Nothing on a card names the database it came from, so leaving the old
    // answer up under the new name is advice attributed to the wrong server.
    setRoutes([{ match: ADVICE, body: view({ advice: [], connectionName: "Warehouse" }) }]);
    rerender(<PerfAdviceList target={WAREHOUSE} />);
    expect(screen.queryByText(MISSING_INDEX.detail)).not.toBeInTheDocument();

    await flushAsync();
    expect(adviceCalls()).toHaveLength(2);
    expect(adviceCalls()[1].url).toContain("connectionId=2");
  });
});

describe("reading the schema again", () => {
  it("asks the server again, and shows what came back the second time", async () => {
    setRoutes([{ match: ADVICE, body: view() }]);
    const { container } = mount();
    await flushAsync();
    expect(cardCount(container)).toBe(3);

    setRoutes([{ match: ADVICE, body: view({ advice: [MISSING_INDEX] }) }]);
    fireEvent.click(screen.getByRole("button", { name: /Run again/ }));
    await flushAsync();

    expect(adviceCalls()).toHaveLength(2);
    expect(cardCount(container)).toBe(1);
  });
});

describe("when the analysis fails", () => {
  it("prints what the server said, because the server knows why", async () => {
    setRoutes([{ match: ADVICE, status: 500, body: { error: "password authentication failed" } }]);
    mount();
    await flushAsync();

    expect(screen.getByText("Could not analyse this schema")).toBeInTheDocument();
    expect(screen.getByText(/password authentication failed/)).toBeInTheDocument();
  });

  it("has words of its own when the server sent none", async () => {
    setRoutes([{ match: ADVICE, status: 500, body: {} }]);
    mount();
    await flushAsync();

    expect(screen.getByText(/Could not analyse this schema\./)).toBeInTheDocument();
  });

  it("says the request never arrived, rather than blaming the server", async () => {
    setRoutes([{ match: ADVICE, networkError: true }]);
    mount();
    await flushAsync();

    expect(
      screen.getByText(/Could not reach the server to analyse this schema\./)
    ).toBeInTheDocument();
  });

  it("carries on where it left off when asked again", async () => {
    setRoutes([{ match: ADVICE, networkError: true }]);
    mount();
    await flushAsync();

    setRoutes([{ match: ADVICE, body: view() }]);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await flushAsync();

    expect(screen.getByText(MISSING_INDEX.detail)).toBeInTheDocument();
    expect(adviceCalls()).toHaveLength(2);
  });
});

describe("when there is nothing to flag", () => {
  it("says so, and says what was looked at", async () => {
    setRoutes([{ match: ADVICE, body: view({ advice: [], schema: "shop_dev" }) }]);
    mount();
    await flushAsync();

    expect(screen.getByRole("heading", { name: "Nothing to flag" })).toBeInTheDocument();
    expect(screen.getByText(/None of the checks found anything in shop_dev/)).toBeInTheDocument();
  });

  it("does not speak for the checks that could not run", async () => {
    // "Nothing to flag" over a failed counters pass is a clean bill of health
    // for checks nobody made.
    setRoutes([
      {
        match: ADVICE,
        body: view({ advice: [], statsUnavailable: "The counters could not be read." }),
      },
    ]);
    mount();
    await flushAsync();

    expect(
      screen.getByText(/None of the checks on the schema itself found anything/)
    ).toBeInTheDocument();
    expect(screen.getByText(/this says nothing about unused or invalid/)).toBeInTheDocument();
  });

  it("offers nothing to filter and nothing to build a script from", async () => {
    setRoutes([{ match: ADVICE, body: view({ advice: [] }) }]);
    mount();
    await flushAsync();

    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByText("High")).not.toBeInTheDocument();
  });
});

describe("when only part of the analysis ran", () => {
  it("says why the counters could not be read, and what that cost", async () => {
    setRoutes([
      {
        match: ADVICE,
        body: view({ statsUnavailable: "This login may not read pg_stat_user_tables." }),
      },
    ]);
    mount();
    await flushAsync();

    expect(screen.getByText("Live counters could not be read")).toBeInTheDocument();
    expect(
      screen.getByText(/This login may not read pg_stat_user_tables\./)
    ).toBeInTheDocument();
    expect(screen.getByText(/look for unused and invalid indexes/)).toBeInTheDocument();
  });

  it("says why the record of analysed queries could not be read, and what that cost", async () => {
    setRoutes([
      {
        match: ADVICE,
        body: view({ patternsUnavailable: "The app's own database did not answer." }),
      },
    ]);
    mount();
    await flushAsync();

    expect(
      screen.getByText("The record of analysed queries could not be read")
    ).toBeInTheDocument();
    expect(screen.getByText(/The app's own database did not answer\./)).toBeInTheDocument();
    expect(screen.getByText(/Everything else on this page still ran\./)).toBeInTheDocument();
  });

  it("says neither when both passes ran", async () => {
    setRoutes([{ match: ADVICE, body: view() }]);
    mount();
    await flushAsync();

    expect(screen.queryByText("Live counters could not be read")).not.toBeInTheDocument();
    expect(
      screen.queryByText("The record of analysed queries could not be read")
    ).not.toBeInTheDocument();
  });
});

describe("the findings themselves", () => {
  it("lays out one card per finding, worst first as the server sent them", async () => {
    setRoutes([{ match: ADVICE, body: view() }]);
    const { container } = mount();
    await flushAsync();

    expect(cardCount(container)).toBe(3);
    // In the order the server sent them: the list is sorted where the advice is
    // worked out, and re-sorting it here would be a second opinion about which
    // of two findings matters more.
    const details = [MISSING_INDEX, DEAD_ROWS, SHARED_FILTER].map((a) =>
      (container.textContent ?? "").indexOf(a.detail)
    );
    expect(details.every((at) => at >= 0)).toBe(true);
    expect([...details].sort((a, b) => a - b)).toEqual(details);
  });

  it("says which pass each finding came from", async () => {
    setRoutes([{ match: ADVICE, body: view() }]);
    mount();
    await flushAsync();

    expect(screen.getByText("From the schema")).toBeInTheDocument();
    expect(screen.getByText("From live counters")).toBeInTheDocument();
    expect(screen.getByText("From queries analysed here")).toBeInTheDocument();
  });

  it("explains what a counter-based finding is worth", async () => {
    // A reader who cannot tell "true of the schema" from "true of what this
    // server's counters have seen" will eventually drop an index a quarterly
    // report needs.
    setRoutes([{ match: ADVICE, body: view() }]);
    mount();
    await flushAsync();

    expect(screen.getByText("From live counters")).toHaveAttribute(
      "title",
      expect.stringContaining("last reset or crash")
    );
    expect(screen.getByText("From the schema")).toHaveAttribute(
      "title",
      expect.stringContaining("no counters involved")
    );
  });

  it("counts what is on screen against the whole set", async () => {
    setRoutes([{ match: ADVICE, body: view() }]);
    mount();
    await flushAsync();

    expect(screen.getByText(/Showing 3 of 3 suggestions · most serious first\./)).toBeInTheDocument();
  });

  it("says suggestion in the singular when there is one", async () => {
    setRoutes([{ match: ADVICE, body: view({ advice: [MISSING_INDEX] }) }]);
    mount();
    await flushAsync();

    expect(screen.getByText(/Showing 1 of 1 suggestion ·/)).toBeInTheDocument();
  });
});

describe("filtering the list", () => {
  const chip = (label: string) =>
    screen.getAllByRole("button").find((b) => b.textContent?.startsWith(label)) as HTMLElement;

  it("shows only the severity that was asked for, and says how many of the whole that is", async () => {
    setRoutes([{ match: ADVICE, body: view() }]);
    const { container } = mount();
    await flushAsync();

    fireEvent.click(chip("High"));
    expect(cardCount(container)).toBe(1);
    expect(screen.getByText(/Showing 1 of 3 suggestions/)).toBeInTheDocument();
  });

  it("still offers every suggestion to the script builder", async () => {
    // The ticks in the builder are what decides the script, so a filter on
    // screen must not quietly leave things out of it.
    setRoutes([{ match: ADVICE, body: view() }]);
    mount();
    await flushAsync();

    fireEvent.click(chip("High"));
    expect(screen.queryByText(DEAD_ROWS.detail)).not.toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: new RegExp(DEAD_ROWS.title) })
    ).toBeInTheDocument();
  });

  it("drops a filter the next answer has nothing for", async () => {
    setRoutes([{ match: ADVICE, body: view() }]);
    const { container } = mount();
    await flushAsync();

    fireEvent.click(chip("Low"));
    expect(cardCount(container)).toBe(1);

    // The same schema, read again after the one low finding was dealt with. An
    // empty list under "2 suggestions" reads as a screen that failed to load.
    setRoutes([{ match: ADVICE, body: view({ advice: [MISSING_INDEX, DEAD_ROWS] }) }]);
    fireEvent.click(screen.getByRole("button", { name: /Run again/ }));
    await flushAsync();

    expect(cardCount(container)).toBe(2);
    expect(screen.getByText(/Showing 2 of 2 suggestions/)).toBeInTheDocument();
  });
});

describe("the line above the findings", () => {
  it("names the schema, the server and how much was looked at", async () => {
    setRoutes([
      {
        match: ADVICE,
        body: view({ schema: "shop_dev", connectionName: "Local Postgres", tablesAnalyzed: 9 }),
      },
    ]);
    const { container } = mount();
    await flushAsync();

    const summary = container.textContent ?? "";
    expect(summary).toContain("shop_dev on Local Postgres · 9 tables analysed · 3 suggestions");
  });

  it("says table in the singular when only one was looked at", async () => {
    setRoutes([{ match: ADVICE, body: view({ tablesAnalyzed: 1, advice: [] }) }]);
    const { container } = mount();
    await flushAsync();

    expect(container.textContent).toContain("1 table analysed · no suggestions");
  });
});
