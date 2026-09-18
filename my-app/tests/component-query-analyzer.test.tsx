/** @jest-environment jsdom */

/**
 * The query-analysis tab, on the thing that made it dangerous rather than
 * merely wrong: the answer used to outlive the picker it was asked through.
 *
 * Analysing against staging and then switching the picker to production left
 * staging's plan on screen, under a heading naming production, with nothing on
 * the card to say which database it came from. Everything here is about the
 * answer and the target it belongs to staying one thing.
 */

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

jest.mock("next-auth/react", () => require("./helpers/render-page").sessionStubs);

import { QueryAnalyzer } from "@/components/studio/QueryAnalyzer";
import type { PerfTarget } from "@/components/studio/PerfTargetPicker";
import { readPlan } from "@/lib/query-analysis";
import type { AnalyzeView } from "@/lib/query-analysis";
import { scoreQuery } from "@/lib/query-score";
import {
  fetchCalls,
  flushAsync,
  holdNext,
  resetPageState,
  setRoutes,
  setUser,
} from "./helpers/render-page";

const STAGING: PerfTarget = {
  connectionId: "1",
  connectionName: "Staging",
  schema: "public",
};
const PRODUCTION: PerfTarget = {
  connectionId: "2",
  connectionName: "Production",
  schema: "public",
};

/**
 * An answer, built through the real plan reader rather than written out by
 * hand. A PlanStep has two dozen fields and the screen reads most of them, so a
 * hand-made one would be a fixture of what this test imagines a plan is.
 */
function answer(headline: string): AnalyzeView {
  const plan = readPlan([
    {
      Plan: {
        "Node Type": "Seq Scan",
        "Relation Name": "orders",
        Schema: "public",
        "Total Cost": 120,
        "Plan Rows": 40,
      },
    },
  ]);
  if (!plan) throw new Error("The fixture is not a plan.");
  return {
    connectionName: "Staging",
    database: "shop",
    schema: "public",
    mode: "estimate",
    headline,
    plan,
    findings: [],
    counts: { high: 0, medium: 0, low: 0, total: 0 },
    score: scoreQuery(plan, []),
    historyId: null,
    fingerprint: "abc123",
    breaches: [],
  };
}

const SQL = "SELECT * FROM orders;";

/** Type a query in and press the button. */
function analyse() {
  fireEvent.change(screen.getByLabelText("Query"), { target: { value: SQL } });
  fireEvent.click(screen.getByRole("button", { name: /Analyse|Run and measure/ }));
}

beforeEach(() => resetPageState());
afterEach(() => cleanup());

describe("the answer belongs to one target", () => {
  it("drops the plan when the picker moves to another database", async () => {
    setRoutes([{ match: "/api/performance/analyze", body: answer("Estimated at 120 units") }]);
    const { rerender } = render(<QueryAnalyzer target={STAGING} />);

    analyse();
    expect(await screen.findByText("Estimated at 120 units")).toBeInTheDocument();

    // The reader moves the picker. Nothing on the card named the database it
    // came from, so leaving it up is a plan attributed to the wrong server.
    rerender(<QueryAnalyzer target={PRODUCTION} />);
    expect(screen.queryByText("Estimated at 120 units")).not.toBeInTheDocument();

    // No request went with the move: this screen only asks when asked to, and
    // a picker change silently re-running a query against another database
    // would be a worse answer to the same problem.
    expect(fetchCalls).toHaveLength(1);
  });

  it("keeps a refused answer with its target too", async () => {
    setRoutes([
      {
        match: "/api/performance/analyze",
        status: 400,
        body: { error: "Only a single read-only statement can be analysed." },
      },
    ]);
    const { rerender } = render(<QueryAnalyzer target={STAGING} />);

    analyse();
    expect(
      await screen.findByText("Only a single read-only statement can be analysed.")
    ).toBeInTheDocument();

    // An error is an answer about a database as much as a plan is — this one
    // is about staging, and under production's name it means something else.
    rerender(<QueryAnalyzer target={PRODUCTION} />);
    expect(screen.queryByText(/single read-only statement/)).not.toBeInTheDocument();
  });

  it("will not start a second analysis while one is still running", async () => {
    setRoutes([{ match: "/api/performance/analyze", body: answer("Estimated at 120 units") }]);
    const release = holdNext("/api/performance/analyze");
    const { rerender } = render(<QueryAnalyzer target={STAGING} />);
    analyse();

    // Worth pinning down, because it is what makes the key guard above a guard
    // about the PICKER and not about a race. The button is the only way to ask,
    // and it is shut until the answer comes back, so two analyses can never be
    // in flight at once — even across a change of target, since `running`
    // belongs to the screen rather than to the target.
    rerender(<QueryAnalyzer target={PRODUCTION} />);
    const button = screen.getByRole("button", { name: "Analysing…" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(fetchCalls).toHaveLength(1);

    // And when it does come back it is still staging's answer, so the reader
    // now looking at production is not shown it.
    release();
    await flushAsync();
    expect(screen.queryByText("Estimated at 120 units")).not.toBeInTheDocument();
  });
});

describe("running the query", () => {
  it("tells a viewer why measuring is not offered, before they press anything", async () => {
    setUser("viewer");
    setRoutes([{ match: "/api/performance/analyze", body: answer("Estimated at 120 units") }]);
    render(<QueryAnalyzer target={STAGING} />);

    // The server's gate is the gate. This one exists so a viewer is told
    // first, rather than being handed a 403 after pressing a button.
    const measure = screen.getByRole("checkbox");
    expect(measure).toBeDisabled();
    expect(screen.getByText(/needs the editor role, and yours is viewer/)).toBeInTheDocument();

    analyse();
    await waitFor(() => expect(fetchCalls).toHaveLength(1));
    expect(JSON.parse(String(fetchCalls[0].body)).measure).toBe(false);
  });

  it("asks for a measured run when an editor ticks the box", async () => {
    setUser("editor");
    setRoutes([{ match: "/api/performance/analyze", body: answer("Ran in 3.1 ms") }]);
    render(<QueryAnalyzer target={STAGING} />);

    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("button", { name: /Run and measure/ })).toBeInTheDocument();

    analyse();
    expect(await screen.findByText("Ran in 3.1 ms")).toBeInTheDocument();
    expect(JSON.parse(String(fetchCalls[0].body)).measure).toBe(true);
  });

  it("asks nothing until there is a query to ask about", () => {
    render(<QueryAnalyzer target={STAGING} />);
    expect(screen.getByRole("button", { name: "Analyse" })).toBeDisabled();
    expect(fetchCalls).toEqual([]);
  });

  it("says what to do first when no target is picked", () => {
    render(<QueryAnalyzer target={null} />);
    expect(
      screen.getByText(/Choose a PostgreSQL connection and a schema above/)
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Analyse" })).not.toBeInTheDocument();
  });
});
