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
import { TABLE_INDEX_SHOWN } from "@/components/studio/TableIndex";
import { compareSchemas } from "@/lib/compare/diff";
import type { CompareReport, ObjectDiff } from "@/lib/compare/types";
import { column, schema, table } from "./helpers/snapshots";

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
    expect(lineFor("open_orders")).toHaveTextContent("only in target, dropped");
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

    expect(lineFor("sales_rollup")).toHaveTextContent("only in target, dropped");
    expect(lineFor("open_orders")).toHaveTextContent("only in target, dropped");
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

    expect(lineFor("sales_rollup")).toHaveTextContent("definition changed, rebuild held back");
    expect(lineFor("open_orders")).toHaveTextContent("definition changed, dropped and rebuilt");
  });

  it("describes a drift report as history rather than as a plan", () => {
    // Same diffs, read on /drift: nothing here will be dropped by this page, so
    // a line naming statements would be describing a migration that does not
    // exist. What the reader needs is which side the object is on now.
    render(
      <DiffReport report={report([droppedView("sales_rollup", true)])} sides="expected-live" />
    );

    expect(lineFor("sales_rollup")).toHaveTextContent(
      "only in the live database, added since the baseline"
    );
    expect(
      screen.getByText("The live database gained 1 materialized view since the baseline")
    ).toBeInTheDocument();
    // By name, so nobody has to hunt through the report for it.
    expect(screen.getByText("materialized view sales_rollup")).toBeInTheDocument();
  });

  it("names the first five drops and counts the rest", () => {
    const views = ["a", "b", "c", "d", "e", "f", "g"].map((name) => droppedView(`mv_${name}`, true));
    render(<DiffReport report={report(views)} allowDataLoss={false} />);

    expect(
      screen.getByText(
        "materialized view mv_a, materialized view mv_b, materialized view mv_c, " +
          "materialized view mv_d, materialized view mv_e and 2 more"
      )
    ).toBeInTheDocument();
  });
});

describe("a possible rename", () => {
  const candidate = {
    kind: "table" as const,
    leftName: "customers",
    rightName: "clients",
    score: 80,
    accepted: false,
    breakdown: {} as never,
  };

  it("says what the script does with the pair and where the RENAME is", () => {
    render(
      <DiffReport report={{ ...report([]), possibleTableMatches: [candidate] }} allowDataLoss={false} />
    );
    expect(
      screen.getByText(
        "The script adds customers as a new, empty table and holds back the drop of clients, " +
          "so the rows stay in clients. If this is a rename, find the \"Possible rename\" note " +
          "in the script and run its RENAME statement in place of that pair."
      )
    ).toBeInTheDocument();
  });

  it("says nothing about a script on a drift report, which has none", () => {
    render(
      <DiffReport report={{ ...report([]), possibleTableMatches: [candidate] }} sides="expected-live" />
    );
    expect(screen.getByText("Possible table rename")).toBeInTheDocument();
    expect(screen.queryByText(/The script adds/)).not.toBeInTheDocument();
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
    expect(lineFor("recalc(integer)")).toHaveTextContent("only in source, created");
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
      expect(lineFor(name)).toHaveTextContent("definition changed, altered in place");
    }
    expect(lineFor("recalc(integer)")).toHaveTextContent("definition changed, replaced");
    expect(lineFor("total(integer)")).toHaveTextContent(
      "definition changed, dropped and recreated"
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

describe("the list of tables above the cards", () => {
  // A tester comparing two schemas had to fold every open card by hand to see
  // what else had changed. The list names every table that differs, folds or
  // opens all the cards at once, and takes the reader to one card.
  afterEach(cleanup);

  const id = column("id", { typeDisplay: "integer", nullable: false });
  const tables = (...names: string[]) => names.map((name) => table(name, [id]));

  /** Source has `source`, target has `target`, and `orders` differs in both. */
  function engine(source: string[], target: string[]): CompareReport {
    const left = schema([...tables(...source), table("orders", [id, column("note", { typeDisplay: "text" })])]);
    const right = schema([...tables(...target), table("orders", [id])]);
    return compareSchemas(left, right);
  }

  const list = () => screen.getByRole("navigation", { name: /Tables with changes|Tables that differ/ });

  it("names each added, changed and removed table on Compare", () => {
    render(<DiffReport report={engine(["customers", "invoices"], ["legacy_log"])} allowDataLoss={false} />);
    const nav = list();
    expect(nav).toHaveTextContent("Tables with changes");
    expect(within(within(nav).getByRole("list", { name: "Added" })).getAllByRole("button").map((b) => b.textContent)).toEqual(["+customers", "+invoices"]);
    expect(within(nav).getByRole("list", { name: "Changed" })).toHaveTextContent("orders");
    expect(within(nav).getByRole("list", { name: "Removed" })).toHaveTextContent("legacy_log");
  });

  it("uses the Drift words on Drift", () => {
    render(<DiffReport report={engine(["customers"], ["legacy_log"])} sides="expected-live" />);
    const nav = list();
    expect(nav).toHaveTextContent("Tables that differ");
    expect(within(nav).getByRole("list", { name: "Missing" })).toHaveTextContent("customers");
    expect(within(nav).getByRole("list", { name: "Live only" })).toHaveTextContent("legacy_log");
  });

  it("is left out when only one table differs, because there is nothing to find", () => {
    render(<DiffReport report={engine([], [])} allowDataLoss={false} />);
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });

  it("follows the count tile the reader picked", () => {
    render(<DiffReport report={engine(["customers", "invoices"], ["legacy_log"])} allowDataLoss={false} only="add" />);
    const nav = list();
    expect(within(nav).getByRole("list", { name: "Added" })).toBeInTheDocument();
    expect(within(nav).queryByRole("list", { name: "Removed" })).not.toBeInTheDocument();
  });

  it("folds and opens every card at once, and shows which way they are", () => {
    const { container } = render(
      <DiffReport report={engine(["customers", "invoices"], ["legacy_log"])} allowDataLoss={false} />
    );
    const cards = [...container.querySelectorAll<HTMLDetailsElement>("details.table-group")];
    expect(cards.length).toBeGreaterThan(1);
    expect(cards.every((card) => card.open)).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(cards.every((card) => !card.open)).toBe(true);
    expect(screen.getByRole("group", { name: "Fold the table cards" })).toHaveAttribute("data-fold", "closed");

    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(cards.every((card) => card.open)).toBe(true);
    expect(screen.getByRole("group", { name: "Fold the table cards" })).toHaveAttribute("data-fold", "open");
  });

  it("says the cards are mixed after one is folded by hand", () => {
    const { container } = render(
      <DiffReport report={engine(["customers", "invoices"], [])} allowDataLoss={false} />
    );
    const card = container.querySelector<HTMLDetailsElement>('[data-table-card="add:customers"]')!;
    card.open = false;
    fireEvent(card, new Event("toggle"));
    const fold = screen.getByRole("group", { name: "Fold the table cards" });
    expect(fold).toHaveAttribute("data-fold", "mixed");
    expect(within(fold).getAllByRole("button").some((b) => b.classList.contains("is-on"))).toBe(false);
  });

  it("opens, flashes and focuses the card a chip names", () => {
    const { container } = render(
      <DiffReport report={engine(["customers", "invoices"], ["legacy_log"])} allowDataLoss={false} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    fireEvent.click(within(list()).getByRole("button", { name: "legacy_log" }));
    const card = container.querySelector<HTMLDetailsElement>('[data-table-card="rem:legacy_log"]')!;
    expect(card.open).toBe(true);
    expect(card).toHaveClass("card-flash");
    expect(card.querySelector(":scope > summary")).toHaveFocus();
    expect(container.querySelector<HTMLDetailsElement>('[data-table-card="add:customers"]')!.open).toBe(false);
  });

  it("shows twelve tables to a group, and the rest behind +N more", () => {
    const many = Array.from({ length: 15 }, (_, i) => `t${String(i + 1).padStart(2, "0")}`);
    render(<DiffReport report={engine(many, [])} allowDataLoss={false} />);
    const added = within(list()).getByRole("list", { name: "Added" });
    expect(within(added).getAllByRole("listitem")).toHaveLength(TABLE_INDEX_SHOWN + 1);
    const more = within(added).getByRole("button", { name: "+3 more" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(more);
    expect(within(added).getAllByRole("listitem")).toHaveLength(16);
    expect(within(added).getByRole("button", { name: "Show fewer" })).toHaveAttribute("aria-expanded", "true");
  });
});
