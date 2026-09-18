/** @jest-environment jsdom */

/**
 * The query plan drawn as a tree of boxes.
 *
 * A plan is the one screen in this app where the reader is being asked to
 * believe something they cannot check: the database said this query is slow
 * HERE. So the box has to be right about which step it is, what that step
 * handed on, how many times it did it, and how much of the query it was — and
 * it has to be right without a graph library, because the boxes are nested
 * <ul>/<li> and the lines between them are CSS borders. Draw the nesting from
 * the wrong parent and the picture is a confident lie about how the query runs.
 *
 * Two things here are about honesty rather than layout. A plan that was only
 * estimated must never be worded as a measurement — the badge says "most
 * expensive (estimate)", not "slowest" — and a step that ran forty times must
 * say so beside its row count, because "1 row" from a step that ran forty times
 * is the single most misread number on the screen.
 *
 * Every plan below is real EXPLAIN output put through readPlan, the same reader
 * the route uses, rather than a hand-written PlanStep. A PlanStep has two dozen
 * fields and the boxes read most of them, so a hand-made one would be a fixture
 * of what this test imagines a plan is — the same reason
 * tests/component-query-analyzer.test.tsx builds its answer that way.
 *
 * What is NOT here:
 *  - Reading the plan: readPlan, the share arithmetic and every rule that
 *    produces a finding are tests/query-analysis.test.ts.
 *  - The words the helpers choose — stepFigures, subqueryCaption, shareText,
 *    shareBand, heaviestStepLabel, shareLegend. The tests below hold the boxes
 *    to what those helpers return for a real plan, so the two can never word a
 *    number differently, but the wording itself is that suite's.
 *  - The screen around the tree — the picker, the headline, the toggle between
 *    this and the step list — is tests/component-query-analyzer.test.tsx, which
 *    stops at the answer and never renders the tree.
 *  - The cards under the tree that the badges point at:
 *    tests/component-finding-card.test.tsx.
 *  - The lines drawn between the boxes. They are borders on ::before/::after in
 *    app/globals.css, and jsdom applies no stylesheet — what is held here is
 *    the nesting those borders are drawn from.
 */

import "@testing-library/jest-dom";
import { cleanup, render, screen, within } from "@testing-library/react";

import { PlanTree, ShareMeter } from "@/components/studio/PlanTree";
import { readPlan, type PlanSummary, type QueryFinding } from "@/lib/query-analysis";

/** readPlan, or a loud failure — a broken fixture must not read as a pass. */
function plan(raw: unknown): PlanSummary {
  const read = readPlan(raw);
  if (read === null) throw new Error("The fixture is not a plan.");
  return read;
}

/**
 * A join that was actually run: EXPLAIN (ANALYZE) over a nested loop.
 *
 * The inner side ran once per row of the outer one, which is the case the row
 * count alone gets wrong. The times are chosen so the three steps come out at
 * 70 / 10 / 20 per cent — one in each of the three bands.
 */
const MEASURED = [
  {
    Plan: {
      "Node Type": "Nested Loop",
      "Total Cost": 300,
      "Plan Rows": 50,
      "Actual Rows": 42,
      "Actual Loops": 1,
      "Actual Total Time": 10,
      Plans: [
        {
          "Node Type": "Seq Scan",
          "Relation Name": "orders",
          Schema: "public",
          Alias: "o",
          "Parent Relationship": "Outer",
          "Total Cost": 100,
          "Plan Rows": 40,
          "Actual Rows": 40,
          "Actual Loops": 1,
          "Actual Total Time": 1,
        },
        {
          "Node Type": "Index Scan",
          "Relation Name": "customers",
          Schema: "public",
          Alias: "c",
          "Index Name": "customers_pkey",
          "Parent Relationship": "Inner",
          "Total Cost": 4,
          "Plan Rows": 1,
          "Actual Rows": 1,
          "Actual Loops": 40,
          "Actual Total Time": 0.05,
        },
      ],
    },
    "Planning Time": 0.2,
    "Execution Time": 11,
  },
];

/**
 * The same join, never run — EXPLAIN with no ANALYZE. Nothing here is a
 * measurement, and the deepest step hangs off a Hash rather than off the join,
 * so the nesting is two levels and not one.
 */
const ESTIMATE = [
  {
    Plan: {
      "Node Type": "Hash Join",
      "Total Cost": 200,
      "Plan Rows": 100,
      Plans: [
        {
          "Node Type": "Seq Scan",
          "Relation Name": "orders",
          Schema: "public",
          "Parent Relationship": "Outer",
          "Total Cost": 120,
          "Plan Rows": 40,
        },
        {
          "Node Type": "Hash",
          "Parent Relationship": "Inner",
          "Total Cost": 30,
          "Plan Rows": 10,
          Plans: [
            {
              "Node Type": "Seq Scan",
              "Relation Name": "customers",
              Schema: "public",
              "Parent Relationship": "Outer",
              "Total Cost": 30,
              "Plan Rows": 10,
            },
          ],
        },
      ],
    },
  },
];

/** A query whose WHERE reads a value worked out by a subquery first. */
const SUBQUERY = [
  {
    Plan: {
      "Node Type": "Seq Scan",
      "Relation Name": "orders",
      Schema: "public",
      "Total Cost": 100,
      "Plan Rows": 40,
      Filter: "(total > $0)",
      Plans: [
        {
          "Node Type": "Aggregate",
          "Parent Relationship": "InitPlan",
          "Subplan Name": "InitPlan 1 (returns $0)",
          "Total Cost": 20,
          "Plan Rows": 1,
          Plans: [
            {
              "Node Type": "Seq Scan",
              "Relation Name": "budgets",
              Schema: "public",
              "Parent Relationship": "Outer",
              "Total Cost": 20,
              "Plan Rows": 5,
            },
          ],
        },
      ],
    },
  },
];

/**
 * A measured plan whose subquery the query never needed: PostgreSQL prints
 * "never executed" for it, and its loop count is 0.
 */
const NEVER_RAN = [
  {
    Plan: {
      "Node Type": "Seq Scan",
      "Relation Name": "orders",
      Schema: "public",
      "Total Cost": 100,
      "Plan Rows": 40,
      Filter: "(status = 'paid'::text)",
      "Actual Rows": 0,
      "Actual Loops": 1,
      "Actual Total Time": 2,
      Plans: [
        {
          "Node Type": "Seq Scan",
          "Relation Name": "refunds",
          Schema: "public",
          "Parent Relationship": "SubPlan",
          "Subplan Name": "SubPlan 1",
          "Total Cost": 20,
          "Plan Rows": 5,
          "Actual Rows": 0,
          "Actual Loops": 0,
          "Actual Total Time": 0,
        },
      ],
    },
    "Planning Time": 0.2,
    "Execution Time": 3,
  },
];

/** A finding of the shape the rules in lib/query-analysis really produce. */
function finding(stepId: number | null, over: Partial<QueryFinding> = {}): QueryFinding {
  return {
    id: `f${stepId ?? "x"}`,
    severity: "low",
    title: "Nothing reads orders through an index",
    object: "public.orders",
    detail: "Every read of this table is a sequential scan of all of it.",
    fix: "CREATE INDEX CONCURRENTLY orders_customer_id_idx ON public.orders (customer_id);",
    fixKind: "change",
    stepId,
    ...over,
  };
}

const tree = (raw: unknown, findings: QueryFinding[] = []) =>
  render(<PlanTree plan={plan(raw)} findings={findings} />);

/** The box carrying "Step n", the way a reader picks one out. */
function step(n: number): HTMLElement {
  return screen.getByText(`Step ${n}`).closest(".plan-node") as HTMLElement;
}

const label = (n: number) => step(n).querySelector(".plan-node-label") as HTMLElement;
const fill = (within_: HTMLElement) =>
  within_.querySelector(".plan-share-fill") as HTMLElement;

/** The tree as nesting alone: each box's label, with the boxes it feeds. */
function shape(list: Element): unknown[] {
  return Array.from(list.children)
    .filter((child) => child.tagName === "LI")
    .map((li) => {
      const name = li.querySelector(".plan-node-label")?.textContent;
      const kids = li.querySelector(":scope > ul");
      return kids === null ? name : [name, shape(kids)];
    });
}

afterEach(cleanup);

describe("the shape of the plan", () => {
  it("hangs every step under the one it feeds", () => {
    // The only picture of how the query runs. A box under the wrong parent
    // says the join reads a table it never touches.
    const { container } = tree(ESTIMATE);
    expect(shape(container.querySelector(".plan-tree") as Element)).toEqual([
      [
        "Hash Join",
        [
          "Seq Scan on orders",
          ["Hash", ["Seq Scan on customers"]],
        ],
      ],
    ]);
  });

  it("numbers the boxes the way the step list below numbers them", () => {
    // The findings say "Step 3". A tree numbering from 0 would send the reader
    // to the box next door.
    tree(ESTIMATE);
    expect(screen.getAllByText(/^Step \d+$/).map((el) => el.textContent)).toEqual([
      "Step 1",
      "Step 2",
      "Step 3",
      "Step 4",
    ]);
  });

  it("scrolls a wide plan in its own frame", () => {
    // A deep plan is wider than the page. Letting it push the page wider moves
    // every other panel on the screen.
    const { container } = tree(ESTIMATE);
    const list = container.querySelector(".plan-tree") as HTMLElement;
    expect(list.closest(".plan-tree-scroll")).not.toBeNull();
    expect(list).toHaveAttribute("aria-label", "The query plan as a tree");
  });
});

describe("what one box says", () => {
  it("names the step, and says what that kind of step does", () => {
    tree(MEASURED);
    expect(label(2)).toHaveTextContent("Seq Scan on orders o");
    expect(label(2)).toHaveAttribute(
      "title",
      "Reads every row in the table and throws away the ones that do not match."
    );
  });

  it("says how many rows the step handed on", () => {
    tree(MEASURED);
    expect(within(step(1)).getByText("42 rows")).toBeInTheDocument();
  });

  it("says a repeated step's count is per run, and how many runs there were", () => {
    // "1 row" from a step that ran forty times is the most misread number on
    // this screen: it is one row EACH time, and the work is the forty.
    tree(MEASURED);
    expect(within(step(3)).getByText("1 row each time")).toBeInTheDocument();
    expect(within(step(3)).getByText("ran 40 times")).toBeInTheDocument();
  });

  it("says nothing about runs for a step that ran once", () => {
    // A "ran 1 times" line on every box is noise that trains the reader to
    // skip the line that matters on the box next to it.
    tree(MEASURED);
    expect(step(1).textContent).not.toMatch(/ran .* times/);
  });

  it("says plainly when a step never ran at all", () => {
    // Nothing matched above it, so the subquery was never needed. "0 rows"
    // would read as a step that ran and found nothing — which is what the
    // reader would then go and try to make faster.
    tree(NEVER_RAN);
    expect(within(step(2)).getByText("never ran")).toBeInTheDocument();
    // The caption still says how it WOULD have run. The two together are the
    // whole answer; either alone is misleading.
    expect(within(step(2)).getByText("SubPlan 1: runs once for each row")).toBeInTheDocument();
  });

  it("marks a plan that was never run as an estimate", () => {
    // Without ANALYZE none of these numbers happened. A row count with no
    // qualifier reads as a measurement.
    tree(ESTIMATE);
    expect(within(step(1)).getByText("~100 rows (estimate)")).toBeInTheDocument();
  });
});

describe("how much of the query a step was", () => {
  it("tints a box red from half the query and amber from a fifth", () => {
    // The point of the tree: find the expensive part before reading a word.
    tree(MEASURED);
    expect(step(1).className).toContain("plan-tint-hot");
    expect(step(3).className).toContain("plan-tint-warm");
    expect(step(2).className).toContain("plan-tint-none");
  });

  it("prints the share beside the bar", () => {
    // The bar is for comparing a column of them at a glance; the number is
    // what a reader can quote in a ticket.
    tree(MEASURED);
    expect(within(step(1)).getByText("70%")).toBeInTheDocument();
    expect(within(step(2)).getByText("10%")).toBeInTheDocument();
    expect(within(step(3)).getByText("20%")).toBeInTheDocument();
  });

  it("fills each bar to its own share, in that share's colour", () => {
    tree(MEASURED);
    expect(fill(step(1))).toHaveStyle({ width: "70%" });
    expect(fill(step(2))).toHaveStyle({ width: "10%" });
    // The bar and the number beside it are banded the same way the box is, so
    // a red box cannot hold an unremarkable-looking bar.
    expect(fill(step(1)).className).toContain("plan-share-fill-hot");
    expect(fill(step(2)).className).toContain("plan-share-fill-none");
    expect(within(step(3)).getByText("20%").className).toContain("plan-share-text-warm");
  });

  it("gives every bar in the tree the plan's own basis", () => {
    // The legend lives on the bar. A tree of estimates whose bars explain
    // themselves as measured time is the same lie as the badge, once per box.
    tree(ESTIMATE);
    const meter = fill(step(1)).closest("[title]");
    expect(meter).toHaveAttribute(
      "title",
      "Share of the planner's estimated cost; an estimate, not a timing"
    );
  });

  it("leaves a sliver for a share too small to print", () => {
    // A bar of zero width beside "<1%" says the step did nothing at all.
    const { container } = render(<ShareMeter share={0.003} basis="cost" />);
    expect(screen.getByText("<1%")).toBeInTheDocument();
    expect(fill(container as unknown as HTMLElement)).toHaveStyle({ width: "2%" });
  });

  it("draws no bar at all for a step with no share", () => {
    const { container } = render(<ShareMeter share={0} basis="cost" />);
    expect(screen.getByText("0%")).toBeInTheDocument();
    expect(fill(container as unknown as HTMLElement)).toHaveStyle({ width: "0%" });
  });

  it("says what the percentages are a share of", () => {
    // A share of the planner's guess and a share of measured time are not the
    // same claim, and the bar looks identical either way.
    const measured = render(<ShareMeter share={0.5} basis="time" />);
    expect(measured.container.querySelector("[title]")).toHaveAttribute(
      "title",
      "Share of the query's total time (measured)"
    );
    cleanup();
    const guess = render(<ShareMeter share={0.5} basis="cost" />);
    expect(guess.container.querySelector("[title]")).toHaveAttribute(
      "title",
      "Share of the planner's estimated cost; an estimate, not a timing"
    );
  });

  it("does not repeat the number to a screen reader", () => {
    // The bar and the text say the same thing. Read out twice it is noise.
    const { container } = render(<ShareMeter share={0.5} basis="time" />);
    expect(container.querySelector(".plan-share-track")).toHaveAttribute("aria-hidden", "true");
  });
});

describe("the heaviest step", () => {
  it("badges the slowest step when the query was actually run", () => {
    tree(MEASURED);
    expect(screen.getAllByText("Slowest step")).toHaveLength(1);
    expect(within(step(1)).getByText("Slowest step")).toBeInTheDocument();
  });

  it("will not call a guess the slowest", () => {
    // Nothing was timed. "Slowest step" on an estimate is the screen claiming
    // a measurement it never took — and the heaviest by cost is not the root.
    tree(ESTIMATE);
    expect(screen.getAllByText("Most expensive step (estimate)")).toHaveLength(1);
    expect(within(step(2)).getByText("Most expensive step (estimate)")).toBeInTheDocument();
    expect(screen.queryByText("Slowest step")).not.toBeInTheDocument();
  });
});

describe("the findings on a box", () => {
  it("counts the findings about that step, on that step's box", () => {
    tree(MEASURED, [finding(1), finding(1), finding(2)]);
    expect(within(step(2)).getByText("2 findings")).toBeInTheDocument();
    expect(within(step(3)).getByText("1 finding")).toBeInTheDocument();
    expect(step(1).textContent).not.toMatch(/finding/);
  });

  it("keeps a finding about the query text off every box", () => {
    // A rule that read the SQL rather than the plan is about no step, and
    // hanging it on the top box would send the reader to a box that is fine.
    tree(MEASURED, [finding(null)]);
    expect(screen.queryByText(/finding/)).not.toBeInTheDocument();
  });

  it("colours the badge for the worst finding on the step, not the first", () => {
    // The colour is the only thing read at a glance. A high finding under a
    // low-coloured badge is the one case where that glance is wrong.
    const worst = (findings: QueryFinding[]) => {
      cleanup();
      tree(MEASURED, findings);
      return within(step(2)).getByText(/finding/).className;
    };
    expect(worst([finding(1, { severity: "low" }), finding(1, { severity: "high" })])).toContain(
      "pill-break"
    );
    expect(worst([finding(1, { severity: "low" }), finding(1, { severity: "medium" })])).toContain(
      "pill-drift"
    );
    expect(worst([finding(1, { severity: "low" })])).toContain("pill-neutral");
  });

  it("says where the findings themselves are", () => {
    // The badge is a count, not the finding. Without this the reader is left
    // hunting a list of cards for the ones about this box.
    tree(MEASURED, [finding(1)]);
    expect(within(step(2)).getByText("1 finding")).toHaveAttribute(
      "title",
      "Listed under 'What to do about it' below, marked with this step's number"
    );
  });
});

describe("a subquery", () => {
  it("says when the subquery runs, which its place in the tree does not", () => {
    // A box hanging off a Seq Scan looks like it runs once per row of it. This
    // one is worked out once, before the scan starts.
    tree(SUBQUERY);
    expect(within(step(2)).getByText("InitPlan 1 (returns $0): runs only once")).toBeInTheDocument();
    expect(step(2).className).toContain("plan-node-sub");
  });

  it("leaves every other box unmarked", () => {
    tree(SUBQUERY);
    expect(step(1).className).not.toContain("plan-node-sub");
    expect(step(3).className).not.toContain("plan-node-sub");
    expect(document.querySelectorAll(".plan-node-caption")).toHaveLength(1);
  });
});
