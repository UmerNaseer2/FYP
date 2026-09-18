/** @jest-environment jsdom */

/**
 * The panel at the top of Compare that names what a migration is about to
 * break.
 *
 * Spec feature 04 asks for critical differences to be highlighted, and the
 * thing this panel exists to fix is a reading problem: the engine has always
 * graded every difference and the diff canvas has always marked the breaking
 * ones, but a narrowing type change on one column of a forty-table schema is
 * one red word several screens down. So the panel lifts them out and lists
 * them under a count.
 *
 * Two of its jobs are easy to get wrong and both are worth pinning here.
 *
 * The first is that "breaking" and "no script can do this" are two different
 * problems, and a comparison can have either without the other. The list is
 * the breaking ones; the manual ones are counted and pointed at. A row that is
 * both appears once, in the list, wearing the tag. The panel has to render
 * sensibly in all three cases, including the one where nothing is breaking at
 * all and the whole panel is a sentence about work a person has to do.
 *
 * The second is that the counts here are counted from the DIFFERENCES, and the
 * ones in the header above are counted from the STATEMENTS the migration will
 * run. With "allow data loss" switched off those two disagree on purpose — a
 * dropped column is still a breaking difference even though the script leaves
 * the DROP commented out — so the panel writes a sentence explaining which is
 * which, and it is a different sentence depending on the switch. Showing the
 * wrong one of the two tells the reader the opposite of the truth about
 * whether their data is at risk, so both are asserted, and each is asserted to
 * exclude the other.
 *
 * There is nothing to click in this component: no state, no handlers, no
 * fetches. Everything below is what it renders from the document it is given.
 *
 * What is NOT here:
 *  - Which differences count as breaking and which no statement can carry.
 *    That grading is the comparison engine's, and the panel deliberately
 *    repeats it rather than forming a second opinion:
 *    tests/compare.test.ts, describe("change severity"). The rows below are
 *    written by hand so this file keeps its meaning when the grading changes.
 *  - Whether the migration really does comment its destructive statements off
 *    when data loss is not allowed. The panel only says so:
 *    tests/generate-sql.test.ts.
 *  - The counts in the header above this panel and in the export beside it,
 *    and the fact that those two agree: tests/compare-export.test.ts.
 *  - The diff canvas further down, which marks the same rows where they sit:
 *    tests/component-diff-report.test.tsx.
 *  - Where the panel sits on the compare screen and what is around it:
 *    tests/page-compare.test.tsx.
 *  - That the panel is drawn in red, that the chevron turns when it opens, and
 *    that the spacer pushes that chevron to the right. All three are CSS and
 *    jsdom applies no stylesheet, so what is asserted is the class the
 *    component asks for, not what a browser would draw from it. For the same
 *    reason a shut <details> still has its contents in the document here, so
 *    "shut" is read off the element's own open flag rather than off what is
 *    visible.
 */

import "@testing-library/jest-dom";
import { render } from "@testing-library/react";

import { CriticalChanges } from "@/components/studio/CriticalChanges";
import type { ChangeRow, DiffDocument } from "@/lib/compare-export";

function totals(over: Partial<DiffDocument["totals"]> = {}): DiffDocument["totals"] {
  return {
    changes: 0,
    added: 0,
    dropped: 0,
    changed: 0,
    renamed: 0,
    renameSuggestions: 0,
    breaking: 0,
    manual: 0,
    ...over,
  };
}

/**
 * A finished comparison carrying the given rows.
 *
 * The totals are counted off those rows rather than left at zero. The panel
 * never reads them — it counts the list itself, which is the whole point of
 * the sentence it writes about the header — but a document claiming nothing is
 * breaking while its own list holds three breaking rows is not a document this
 * app can produce, and a fixture that could never happen tests nothing.
 */
function doc(changes: ChangeRow[]): DiffDocument {
  return {
    format: "schema-studio-diff",
    version: 1,
    source: { database: "shop-dev", schema: "public" },
    target: { database: "shop_prod", schema: "public" },
    totals: totals({
      changes: changes.length,
      breaking: changes.filter((row) => row.severity === "breaking").length,
      manual: changes.filter((row) => row.manual).length,
    }),
    notCompared: [],
    categories: [],
    changes,
    data: null,
  };
}

/** One difference. Safe and scriptable unless a test says otherwise. */
function change(over: Partial<ChangeRow> = {}): ChangeRow {
  return {
    category: "Column",
    table: "orders",
    object: "total",
    change: "changed",
    severity: "safe",
    detail: "",
    manual: false,
    ...over,
  };
}

/** A dropped column: breaking, and something the generator can write. */
function breaking(over: Partial<ChangeRow> = {}): ChangeRow {
  return change({
    change: "dropped",
    severity: "breaking",
    detail: "Column total exists only in shop_prod.",
    ...over,
  });
}

/**
 * A range type the snapshot cannot describe well enough to write CREATE TYPE.
 * The engine grades a new type "info" and flags it as manual work, so this is
 * the shape of a difference that needs a person without being breaking — the
 * case that decides whether the panel appears at all.
 */
function manualOnly(object = "temperature_range"): ChangeRow {
  return change({
    category: "Type",
    table: "",
    object,
    change: "added",
    severity: "info",
    detail: `Range type ${object} exists only in shop-dev.`,
    manual: true,
  });
}

/**
 * A changed collation: breaking AND manual. PostgreSQL has no ALTER that
 * changes how one sorts, so it has to be dropped and recreated, which fails
 * while any column still uses it. A row like this belongs in both counts.
 */
function breakingAndManual(): ChangeRow {
  return change({
    category: "Collation",
    table: "",
    object: "en_us_ci",
    change: "changed",
    severity: "breaking",
    detail: "Collation en_us_ci changed definition.",
    manual: true,
  });
}

/** `count` distinct breaking rows, for the cases that overflow the list. */
function manyBreaking(count: number): ChangeRow[] {
  return Array.from({ length: count }, (_, index) =>
    breaking({ object: `col_${index}`, detail: "" })
  );
}

function renderPanel(changes: ChangeRow[], allowDataLoss = false) {
  return render(<CriticalChanges doc={doc(changes)} allowDataLoss={allowDataLoss} />);
}

/**
 * The text of an element as the page reads it. JSX wraps its own source lines,
 * so a sentence written across two of them arrives with the newline and the
 * indentation still in it.
 */
const words = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

const panel = () => document.querySelector("details.critical") as HTMLDetailsElement;
const title = () => document.querySelector(".critical__title");
const pill = () => document.querySelector(".pill");
const more = () => document.querySelector(".critical__more");
const rows = () => Array.from(document.querySelectorAll(".critical__row"));
const notes = () => Array.from(document.querySelectorAll(".critical__note")).map(words);

describe("when there is nothing to warn about", () => {
  test("draws nothing at all when every difference is safe", () => {
    // Not an empty panel and not a green "all clear" banner: one more thing to
    // scroll past on every comparison, when the counts above already say
    // breaking · 0.
    const { container } = renderPanel([change(), change({ severity: "info" })]);
    expect(container.firstChild).toBeNull();
  });

  test("draws nothing for a comparison with no differences in it", () => {
    const { container } = renderPanel([]);
    expect(container.firstChild).toBeNull();
  });
});

describe("what makes the panel appear", () => {
  test("a breaking difference", () => {
    renderPanel([breaking()]);
    expect(panel()).toBeInTheDocument();
  });

  test("work no script can do, even with nothing breaking", () => {
    // The two problems are independent. A comparison whose only trouble is a
    // range type nobody can write CREATE TYPE for has nothing red in it and
    // still needs somebody told.
    renderPanel([change(), manualOnly()]);
    expect(panel()).toBeInTheDocument();
  });

  test("opens itself when something is breaking", () => {
    renderPanel([breaking()]);
    expect(panel().open).toBe(true);
  });

  test("stays shut when the only trouble is work for a person", () => {
    // There is no list to show in that case — the list is the breaking rows —
    // so opening it would present an empty box under a sentence. The sentence
    // is in the summary, which is the part that is shut.
    renderPanel([manualOnly()]);
    expect(panel().open).toBe(false);
  });
});

describe("the headline", () => {
  test("counts the breaking differences", () => {
    renderPanel([breaking({ object: "total" }), breaking({ object: "notes" }), change()]);
    expect(words(title())).toBe("2 breaking differences");
  });

  test("says difference, singular, when there is one", () => {
    renderPanel([breaking()]);
    expect(words(title())).toBe("1 breaking difference");
  });

  test("talks about manual work instead when nothing is breaking", () => {
    renderPanel([manualOnly()]);
    expect(words(title())).toBe("1 difference no script can make");
  });

  test("and counts those the same way", () => {
    renderPanel([manualOnly("a_range"), manualOnly("b_range"), manualOnly("c_range")]);
    expect(words(title())).toBe("3 differences no script can make");
  });
});

describe("the pill beside the headline", () => {
  test("says how many need a person when some of both are here", () => {
    // Deliberately different counts: a pill reading the breaking number would
    // pass every other test in this file.
    renderPanel([breaking({ object: "total" }), breaking({ object: "notes" }), manualOnly()]);
    expect(words(pill())).toBe("1 need a person");
  });

  test("counts the rows that are breaking and manual at once", () => {
    renderPanel([breaking(), breakingAndManual()]);
    expect(words(title())).toBe("2 breaking differences");
    expect(words(pill())).toBe("1 need a person");
  });

  test("stays away when everything breaking can still be scripted", () => {
    renderPanel([breaking()]);
    expect(pill()).toBeNull();
  });

  test("stays away when the headline is already about manual work", () => {
    renderPanel([manualOnly()]);
    expect(pill()).toBeNull();
  });
});

describe("the list", () => {
  test("lists every breaking difference", () => {
    renderPanel(manyBreaking(3));
    expect(rows()).toHaveLength(3);
  });

  test("lists nothing that is not breaking, however it is graded", () => {
    // Safe, info, and manual-but-not-breaking all stay out. The manual one is
    // the trap: it is counted in the sentence below and does not belong in a
    // list headed "breaking".
    renderPanel([change(), change({ severity: "info" }), manualOnly(), breaking()]);
    expect(rows().map((row) => words(row.querySelector(".mono")))).toEqual(["orders.total"]);
  });

  test("lists a difference that is breaking and manual once, and marks it", () => {
    renderPanel([breakingAndManual()]);
    expect(rows()).toHaveLength(1);
    expect(words(rows()[0].querySelector(".critical__manual"))).toBe("needs a person");
  });

  test("leaves the mark off a difference a script can carry out", () => {
    renderPanel([breaking()]);
    expect(rows()[0].querySelector(".critical__manual")).toBeNull();
  });

  test("files each row under the engine's own heading for it", () => {
    renderPanel([breaking(), breakingAndManual()]);
    expect(rows().map((row) => words(row.querySelector(".tag")))).toEqual([
      "Column",
      "Collation",
    ]);
  });

  test("says which table the object belongs to", () => {
    renderPanel([breaking({ table: "orders", object: "total" })]);
    expect(words(rows()[0].querySelector(".mono"))).toBe("orders.total");
  });

  test("does not repeat the name of a table against itself", () => {
    // A dropped table names itself in both fields. "orders.orders" would read
    // as a column nobody has.
    renderPanel([breaking({ category: "Table", table: "orders", object: "orders" })]);
    expect(words(rows()[0].querySelector(".mono"))).toBe("orders");
  });

  test("leaves an object that hangs off no table unqualified", () => {
    renderPanel([breakingAndManual()]);
    expect(words(rows()[0].querySelector(".mono"))).toBe("en_us_ci");
  });

  test("says what the migration would do to it", () => {
    renderPanel([breaking({ change: "dropped" })]);
    expect(words(rows()[0].querySelector(".chg-break"))).toBe("dropped");
  });

  test("carries the engine's own sentence about the change", () => {
    renderPanel([breaking({ detail: "Column total exists only in shop_prod." })]);
    expect(words(rows()[0].querySelector(".muted"))).toBe(
      "— Column total exists only in shop_prod."
    );
  });

  test("leaves the dash out when the engine wrote no sentence", () => {
    renderPanel([breaking({ detail: "" })]);
    expect(rows()[0].querySelector(".muted")).toBeNull();
  });
});

describe("a comparison with more breaking differences than fit", () => {
  test("lists them all while they fit", () => {
    renderPanel(manyBreaking(25));
    expect(rows()).toHaveLength(25);
    expect(more()).toBeNull();
  });

  test("cuts the list once they do not, and counts what it cut", () => {
    renderPanel(manyBreaking(26));
    expect(rows()).toHaveLength(25);
    expect(words(more())).toMatch(/^…and 1 more\./);
  });

  test("counts only the ones it left out of the list", () => {
    // The safe rows are here to catch a count taken from the whole document
    // rather than from the breaking rows: 30 breaking, 25 shown, 5 left.
    renderPanel([...manyBreaking(30), change(), change({ severity: "info" })]);
    expect(rows()).toHaveLength(25);
    expect(words(more())).toMatch(/^…and 5 more\./);
  });

  test("points at the export and the diff for the rest", () => {
    // The cut is only defensible because the whole list is still reachable.
    renderPanel(manyBreaking(26));
    expect(words(more())).toContain("The whole list is in the export above");
    expect(words(more())).toContain("marked in the diff below");
  });
});

describe("what it says about the script", () => {
  test("warns that the destructive statements are armed", () => {
    renderPanel([breaking()], true);
    expect(notes()).toHaveLength(1);
    expect(notes()[0]).toContain("Counted from the differences, not from the script.");
    expect(notes()[0]).toContain("allow data loss, so the destructive statements among these are armed");
    expect(notes()[0]).not.toContain("commented off");
  });

  test("explains why the header above will disagree when they are not", () => {
    renderPanel([breaking()], false);
    expect(notes()).toHaveLength(1);
    expect(notes()[0]).toContain("Counted from the differences, not from the script.");
    expect(notes()[0]).toContain("written out but commented off");
    expect(notes()[0]).not.toContain("are armed");
  });

  test("says nothing about the script when nothing here is breaking", () => {
    // Nothing is commented off or armed in that case; the script simply has no
    // statement to write.
    renderPanel([manualOnly()], false);
    expect(notes()).toHaveLength(1);
    expect(notes()[0]).not.toContain("Counted from the differences");
  });
});

describe("what it says about the work a person has to do", () => {
  test("counts the differences no generated statement can carry", () => {
    renderPanel([manualOnly("a_range"), manualOnly("b_range")]);
    expect(notes()).toHaveLength(1);
    expect(notes()[0]).toContain("2 of the differences below cannot be carried out");
  });

  test("says where to find them", () => {
    renderPanel([manualOnly()]);
    expect(notes()[0]).toContain("marked as manual work");
  });

  test("sits under the script note when there is some of both", () => {
    // Order matters: the script sentence explains the counts in the headline,
    // the manual sentence sends the reader somewhere else.
    renderPanel([breaking(), manualOnly()], false);
    expect(notes()).toHaveLength(2);
    expect(notes()[0]).toContain("Counted from the differences");
    expect(notes()[1]).toContain("1 of the differences below cannot be carried out");
  });

  test("stays away when every difference can be scripted", () => {
    renderPanel([breaking()], false);
    expect(notes()).toHaveLength(1);
    expect(notes()[0]).not.toContain("cannot be carried out");
  });
});
