/** @jest-environment jsdom */

/**
 * The diff canvas, on the one question it kept answering two ways at once: what
 * the generated migration actually does with a drop.
 *
 * Every line here is a sentence the reader acts on. "dropped" over a
 * materialized view whose drop is commented out is not a wording problem — it
 * is the report contradicting the banner two inches above it about whether the
 * rows survive, and only one of them can be right.
 */

import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { DiffReport } from "@/components/studio/DiffReport";
import type { CompareReport, ObjectDiff } from "@/lib/compare-types";
import { schema } from "./helpers/snapshots";

/**
 * A report whose only content is the object diffs handed in.
 *
 * Everything else is empty on purpose: with no tables in play the only lines
 * on screen are the ones under test, so a query cannot match something else
 * that happens to use the same word.
 */
function report(objectDiffs: ObjectDiff[]): CompareReport {
  return {
    left: schema([]),
    right: schema([]),
    matchedTables: [],
    tablesOnlyInA: [],
    tablesOnlyInB: [],
    possibleTableMatches: [],
    objectDiffs,
    comparedObjectCategories: {
      indexes: true,
      triggers: true,
      views: true,
      sequences: true,
      types: true,
      collations: true,
      extensions: true,
      routines: true,
      rowSecurity: true,
      partitioning: true,
      privileges: true,
      reasons: {},
    },
    summary: {
      tablesOnlyInA: 0,
      tablesOnlyInB: 0,
      changedTables: 0,
      changedConstraints: 0,
      likelyRenameCandidates: 0,
      identicalTables: 0,
      changedObjects: objectDiffs.length,
    },
  };
}

/**
 * A view that exists only in the target, so syncing drops it.
 *
 * `dropDestroysData` is the whole point of the pair below: it is the compare
 * engine's own answer to "does this drop throw stored rows away", and a
 * materialized view keeps its own copy of the result set where a plain view
 * keeps nothing.
 */
function droppedView(name: string, destroysData: boolean): ObjectDiff {
  return {
    kind: destroysData ? "MATERIALIZED VIEW" : "VIEW",
    name,
    status: "onlyB",
    summary: `View ${name} exists only in the target.`,
    rightDefinition: "SELECT 1",
    severity: "breaking",
    dropDestroysData: destroysData,
  };
}

/** A view whose SELECT moved, so the generator drops it and builds it again. */
function rebuiltView(name: string, destroysData: boolean): ObjectDiff {
  return {
    kind: destroysData ? "MATERIALIZED VIEW" : "VIEW",
    name,
    status: "changedDefinition",
    summary: `View ${name} has a different definition.`,
    leftDefinition: "SELECT 2",
    rightDefinition: "SELECT 1",
    severity: "breaking",
    replaceNeedsDrop: true,
    dropDestroysData: destroysData,
  };
}

/** The one line describing `name`, wherever on the page it ended up. */
function lineFor(name: string) {
  const line = screen.getByText(name).closest(".diff-row");
  if (!line) throw new Error(`No diff row rendered for ${name}`);
  return line as HTMLElement;
}

afterEach(() => cleanup());

describe("what the report promises about a drop", () => {
  it("says a destructive drop is held back while the safety switch is on", () => {
    render(
      <DiffReport
        report={report([droppedView("sales_rollup", true), droppedView("open_orders", false)])}
        allowDataLoss={false}
      />
    );

    // The matview's DROP is commented out, so the rows are still there.
    expect(lineFor("sales_rollup")).toHaveTextContent("drop held back");
    // The plain view's is not: it stores nothing, so nothing is held back and
    // saying it was would be the same lie pointing the other way.
    expect(lineFor("open_orders")).toHaveTextContent("only in target — dropped");
    expect(lineFor("open_orders")).not.toHaveTextContent("held back");

    // And the banner above counts exactly the drop that destroys data.
    expect(
      screen.getByText("1 destructive statement held back")
    ).toBeInTheDocument();
  });

  it("says both are dropped once the switch is armed", () => {
    render(
      <DiffReport
        report={report([droppedView("sales_rollup", true), droppedView("open_orders", false)])}
        allowDataLoss
      />
    );

    expect(lineFor("sales_rollup")).toHaveTextContent("only in target — dropped");
    expect(lineFor("open_orders")).toHaveTextContent("only in target — dropped");
    // Asserted on the lines rather than on the whole page: the legend above
    // them explains the words "held back" whether or not anything is.
    expect(lineFor("sales_rollup")).not.toHaveTextContent("held back");
    expect(lineFor("open_orders")).not.toHaveTextContent("held back");
    expect(screen.getByText("1 destructive statement armed")).toBeInTheDocument();
  });

  it("promises nothing when no script has been generated", () => {
    // No allowDataLoss prop at all — /drift and a freshly loaded /compare.
    // There is no script yet, so neither "dropped" nor "held back" is a claim
    // this page is in a position to make.
    render(<DiffReport report={report([droppedView("sales_rollup", true)])} />);

    const line = lineFor("sales_rollup");
    expect(line).toHaveTextContent("only in target");
    expect(line).not.toHaveTextContent("dropped");
    expect(line).not.toHaveTextContent("held back");
  });

  it("says a matview rebuild is held back too, and a plain view's is not", () => {
    // A rebuild starts with the same destructive DROP, so safe mode comments
    // out the CREATE behind it as well — the object is neither dropped nor
    // rebuilt. This line said "dropped and rebuilt" for both.
    render(
      <DiffReport
        report={report([rebuiltView("sales_rollup", true), rebuiltView("open_orders", false)])}
        allowDataLoss={false}
      />
    );

    expect(lineFor("sales_rollup")).toHaveTextContent("definition changed — rebuild held back");
    expect(lineFor("open_orders")).toHaveTextContent("definition changed — dropped and rebuilt");
  });

  it("describes a drift report as history rather than as a plan", () => {
    // Same diffs, read on /drift: nothing here will be dropped by this page, so
    // a line naming statements would be describing a migration that does not
    // exist. What the reader needs is which side the object is on now.
    render(
      <DiffReport report={report([droppedView("sales_rollup", true)])} sides="expected-live" />
    );

    expect(lineFor("sales_rollup")).toHaveTextContent(
      "only in the live database — added since the baseline"
    );
    expect(
      screen.getByText("Going back to the baseline would drop 1 thing")
    ).toBeInTheDocument();
  });
});

describe("the rest of the object lines", () => {
  it("groups each kind under its own heading", () => {
    render(
      <DiffReport
        report={report([
          droppedView("sales_rollup", true),
          {
            kind: "FUNCTION",
            name: "recalc(integer)",
            status: "onlyA",
            summary: "Function recalc(integer) exists only in the source.",
            leftDefinition: "BEGIN END",
            severity: "safe",
          },
        ])}
        allowDataLoss={false}
      />
    );

    const group = screen.getByText("Views").closest(".obj-group") as HTMLElement;
    expect(within(group).getByText("sales_rollup")).toBeInTheDocument();
    expect(within(group).queryByText("recalc(integer)")).not.toBeInTheDocument();
    expect(lineFor("recalc(integer)")).toHaveTextContent("only in source — created");
  });

  it("says a sequence, enum or domain is altered in place, and how a routine goes", () => {
    // These all said "replaced". ALTER SEQUENCE, ALTER TYPE ... ADD VALUE and
    // ALTER DOMAIN change the object where it stands, and a routine whose
    // return type moved is dropped before it is created again.
    const changed = (
      kind: ObjectDiff["kind"],
      name: string,
      extra: Partial<ObjectDiff> = {}
    ): ObjectDiff => ({
      kind,
      name,
      status: "changedDefinition",
      summary: `${name} differs.`,
      leftDefinition: "new",
      rightDefinition: "old",
      severity: "safe",
      ...extra,
    });
    render(
      <DiffReport
        report={report([
          changed("SEQUENCE", "order_seq"),
          changed("ENUM", "order_status"),
          changed("DOMAIN", "email_address"),
          changed("FUNCTION", "recalc(integer)"),
          changed("FUNCTION", "total(integer)", { replaceNeedsDrop: true }),
        ])}
        allowDataLoss={false}
      />
    );

    for (const name of ["order_seq", "order_status", "email_address"]) {
      expect(lineFor(name)).toHaveTextContent("definition changed — altered in place");
    }
    expect(lineFor("recalc(integer)")).toHaveTextContent("definition changed — replaced");
    expect(lineFor("total(integer)")).toHaveTextContent(
      "definition changed — dropped and recreated"
    );
  });

  it("says schemas are in sync when there is nothing to report", () => {
    render(<DiffReport report={report([])} allowDataLoss={false} />);
    expect(screen.getByText("Schemas are in sync")).toBeInTheDocument();
  });
});

describe("showing one kind of change", () => {
  // The count tiles on Compare narrow the report through the `only` prop.
  const added: ObjectDiff = {
    kind: "VIEW",
    name: "new_orders",
    status: "onlyA",
    summary: "View new_orders exists only in the source.",
    leftDefinition: "SELECT 1",
    severity: "safe",
  };
  const both = () => report([added, droppedView("open_orders", false)]);

  it("shows every change when nothing is picked", () => {
    render(<DiffReport report={both()} allowDataLoss={false} />);
    expect(screen.getByText("new_orders")).toBeInTheDocument();
    expect(screen.getByText("open_orders")).toBeInTheDocument();
  });

  it("keeps only the additions when Added is picked", () => {
    render(<DiffReport report={both()} allowDataLoss={false} only="add" />);
    expect(screen.getByText("new_orders")).toBeInTheDocument();
    expect(screen.queryByText("open_orders")).not.toBeInTheDocument();
  });

  it("keeps only the removals when Removed is picked", () => {
    render(<DiffReport report={both()} allowDataLoss={false} only="rem" />);
    expect(screen.queryByText("new_orders")).not.toBeInTheDocument();
    expect(screen.getByText("open_orders")).toBeInTheDocument();
  });
});

describe("what the signs mean", () => {
  // The legend was a paragraph above the report. It is now the "?" beside the
  // report's title, and it still reads differently on each page.
  it("is one click away on Compare, where a + is work the script will do", () => {
    render(<DiffReport report={report([droppedView("open_orders", false)])} allowDataLoss={false} />);

    expect(screen.getByText("Changes to the target")).toBeInTheDocument();
    expect(screen.queryByRole("note")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Help: What the signs mean" }));

    expect(screen.getByRole("note")).toHaveTextContent(
      "+ is created, − is dropped and ~ is altered in place."
    );
  });

  it("is one click away on Drift, where a + is something missing from the live database", () => {
    render(
      <DiffReport report={report([droppedView("open_orders", false)])} sides="expected-live" />
    );

    expect(screen.getByText("Differences from the baseline")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Help: What the signs mean" }));

    expect(screen.getByRole("note")).toHaveTextContent(
      "+ is in the baseline but missing from the live database, − is live only, and ~ is in both but different."
    );
  });
});
