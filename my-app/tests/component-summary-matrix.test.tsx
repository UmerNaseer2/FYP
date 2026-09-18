/** @jest-environment jsdom */

/**
 * The Summary board above the diff: every object category on one line, whether
 * or not anything happened to it.
 *
 * The canvas below walks table by table, which is the right shape for reading a
 * change and the wrong shape for "did anything happen to my views?" — you have
 * to scroll the whole thing and hope you did not miss a card. This board is the
 * other half, and almost everything worth pinning about it is in the cells that
 * are NOT counts:
 *
 *   A category the comparison skipped is not a category with nothing in it.
 *   Drawing a row of zeros over something nobody looked at states as fact what
 *   the run never established, so those rows give up their numbers and say why
 *   instead — and there are two whys. A snapshot too old to hold the category
 *   can only be captured again; having no table that exists on both sides is
 *   the tool's most ordinary run, where the migration beside this board is busy
 *   creating every index it just declined to count. Telling a reader the first
 *   when it was the second sends them off to re-capture a snapshot that was
 *   never the problem.
 *
 *   The same column means opposite things on the two screens this serves. On
 *   /compare the left side is the schema you want, so "only in source" is work
 *   the migration is about to do. On /drift the left side is the tracked
 *   baseline and the right is the live database, so the same column is a record
 *   of something already gone — headings reading "created" and "dropped" there
 *   named the opposite of what happened.
 *
 *   And the column about drops has to agree with the script under it. One
 *   switch writes both, so a board promising a drop above a script that
 *   commented it out is impossible rather than unlikely.
 *
 * What is NOT here:
 *  - The arithmetic. summaryRows in lib/compare-summary.ts turns a report into
 *    these rows and has no suite of its own. Every number below does go through
 *    it, but the fixtures are built to reach a cell on screen rather than to
 *    cover the counting rules, so a row that is right for the wrong reason
 *    would still pass here.
 *  - The diff canvas underneath, and what the same drop switch does to its
 *    cards: tests/component-diff-report.test.tsx.
 *  - The script the switch actually arms:
 *    tests/component-migration-workbench.test.tsx.
 *  - The two screens that mount this. tests/page-compare.test.tsx stops before
 *    a finished report exists and says so; tests/page-drift.test.tsx hands the
 *    drift page a report with nothing in it at all. So before this file the
 *    board had never been drawn with a number on it, and its /drift headings
 *    had never been drawn at all.
 */

import "@testing-library/jest-dom";
import { cleanup, render, screen } from "@testing-library/react";

import { SummaryMatrix } from "@/components/studio/SummaryMatrix";
import type {
  CompareReport,
  NotComparedReason,
  ObjectCategoryKey,
  ObjectDiff,
  ObjectKind,
} from "@/lib/compare-types";
import type { CollationSnapshot, TypeSnapshot } from "@/lib/postgres";
import { schema, table } from "./helpers/snapshots";

/** A comparison that found nothing anywhere; each test adds what it is about. */
function report(over: Partial<CompareReport> = {}): CompareReport {
  return {
    left: schema([]),
    right: schema([]),
    matchedTables: [],
    tablesOnlyInA: [],
    tablesOnlyInB: [],
    possibleTableMatches: [],
    objectDiffs: [],
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
      changedObjects: 0,
    },
    ...over,
  };
}

/** The same comparison, with some categories skipped for a stated reason. */
function skipped(
  reasons: Partial<Record<ObjectCategoryKey, NotComparedReason>>
): CompareReport {
  const categories = { ...report().comparedObjectCategories, reasons };
  for (const key of Object.keys(reasons) as ObjectCategoryKey[]) categories[key] = false;
  return report({ comparedObjectCategories: categories });
}

/**
 * A comparison over real tables.
 *
 * The one table matters: with nothing on either side the Tables row is "none on
 * either side" and never reaches its numbers, so a summary block on its own
 * would describe a row the board does not draw.
 */
function counted(summary: Partial<CompareReport["summary"]>): CompareReport {
  return report({
    left: schema([table("orders", [])]),
    summary: { ...report().summary, ...summary },
  });
}

/** A change PostgreSQL has no statement for, so the script can only write a note. */
function unscriptable(kind: ObjectKind, name: string): ObjectDiff {
  return {
    kind,
    name,
    status: "changedDefinition",
    summary: `${name} changed in a way no statement can perform.`,
    severity: "breaking",
    needsManualWork: true,
  };
}

/** A range type — one of the shapes ALTER cannot reach. */
function rangeType(name: string): TypeSnapshot {
  return {
    name,
    kind: "RANGE",
    labels: [],
    baseType: null,
    notNull: false,
    checks: [],
    attributes: [],
    definition: `CREATE TYPE ${name} AS RANGE (subtype = numeric)`,
    normalizedDefinition: `create type ${name} as range (subtype = numeric)`,
  };
}

/** A collation — the other one: its rules cannot be altered in place. */
function collation(name: string): CollationSnapshot {
  return {
    name,
    provider: "icu",
    deterministic: true,
    locale: "en-US",
    lcCollate: null,
    lcCtype: null,
    rules: null,
    definition: `CREATE COLLATION ${name} (provider = icu, locale = 'en-US')`,
    normalizedDefinition: `create collation ${name} (provider = icu, locale = 'en-us')`,
  };
}

function board(over: Partial<Parameters<typeof SummaryMatrix>[0]> = {}) {
  return render(<SummaryMatrix report={report()} {...over} />);
}

const rowFor = (c: HTMLElement, label: string) =>
  Array.from(c.querySelectorAll("tbody tr")).find(
    (tr) => tr.querySelector(".matrix-name")?.textContent === label
  ) as HTMLElement;

/** One row's four numbers, left to right. Empty when the row printed a note. */
const cells = (c: HTMLElement, label: string) =>
  Array.from(rowFor(c, label).querySelectorAll(".matrix-n")).map((td) => td.textContent);

/** The class on each of those cells, which is what carries the colour. */
const tones = (c: HTMLElement, label: string) =>
  Array.from(rowFor(c, label).querySelectorAll(".matrix-n")).map((td) => td.className);

/** What a row says in place of numbers, or null when it printed numbers. */
const note = (c: HTMLElement, label: string) =>
  rowFor(c, label).querySelector(".matrix-na")?.textContent ?? null;

/** Every row label, in the order the board draws them. */
const labels = (c: HTMLElement) =>
  Array.from(c.querySelectorAll(".matrix-name")).map((el) => el.textContent);

/** Each column heading with the small print under it. */
const columns = (c: HTMLElement) =>
  Array.from(c.querySelectorAll("thead th")).map((th) => ({
    label: th.firstChild?.textContent ?? "",
    sub: th.querySelector(".sub")?.textContent ?? null,
  }));

/** The paragraph under the board. */
const help = (c: HTMLElement) => c.querySelector(".help")?.textContent ?? "";

/** The parts of it the board puts in bold, which are the parts about this run. */
const flags = (c: HTMLElement) =>
  Array.from(c.querySelectorAll(".help b")).map((b) => b.textContent);

afterEach(() => cleanup());

describe("the board", () => {
  it("lists every category the comparison looks at, in one order", () => {
    // The whole reason this exists: a category that did not change still gets
    // its line, so "nothing happened to my views" is something the reader can
    // see rather than something they conclude from not finding a card.
    const { container } = board();
    expect(labels(container)).toEqual([
      "Tables",
      "Columns",
      "Constraints",
      "Indexes",
      "Triggers",
      "Row security",
      "Partitioning",
      "Views",
      "Sequences",
      "Enums & types",
      "Collations",
      "Extensions",
      "Functions",
      "Privileges",
    ]);
  });

  it("is open on arrival, under a heading rather than a label", () => {
    // A heading, so this board is one stop in the outline a screen reader can
    // jump between — and open, because a board that answers "did anything
    // happen to X" cannot answer it from behind a closed disclosure.
    const { container } = board();
    expect(container.querySelector("details")).toHaveAttribute("open");
    expect(screen.getByRole("heading", { level: 3, name: "Summary" })).toBeInTheDocument();
  });
});

describe("what a row says", () => {
  it("counts the four things that can happen to an object", () => {
    const { container } = board({
      report: counted({
        identicalTables: 4,
        tablesOnlyInA: 3,
        tablesOnlyInB: 2,
        changedTables: 1,
      }),
    });
    expect(cells(container, "Tables")).toEqual(["4", "3", "2", "1"]);
  });

  it("keeps a zero quiet and gives every other number its own colour", () => {
    // Four differently-toned numbers and a row of zeros look the same from a
    // distance, which is the distance this board is read from.
    const { container } = board({
      report: counted({ identicalTables: 4, tablesOnlyInA: 3, tablesOnlyInB: 0, changedTables: 1 }),
    });
    expect(tones(container, "Tables")).toEqual([
      "matrix-n tone-sync",
      "matrix-n tone-add",
      "matrix-n is-zero",
      "matrix-n tone-chg",
    ]);
  });

  it("says a category is absent rather than printing four zeros at it", () => {
    // "0 0 0 0" reads as a category that was compared and came out even. On a
    // schema with no views at all there was nothing to come out even.
    const { container } = board();
    expect(note(container, "Views")).toBe("none on either side");
    expect(cells(container, "Views")).toEqual([]);
  });
});

describe("a category nobody compared", () => {
  it("says so instead of reporting it as nothing, and gives up its numbers", () => {
    const { container } = board({ report: skipped({ indexes: "snapshotPredatesCategory" }) });
    expect(note(container, "Indexes")).toBe("not compared");
    expect(cells(container, "Indexes")).toEqual([]);
    // Across all four columns, so the sentence is read as the row's answer
    // rather than as one column's and three blanks.
    expect(rowFor(container, "Indexes").querySelector(".matrix-na")).toHaveAttribute(
      "colspan",
      "4"
    );
  });

  it("separates having nothing to compare from being unable to", () => {
    // Both rows have no numbers, and they are different problems: one reader
    // has to capture a snapshot again, the other has nothing to fix at all.
    const { container } = board({
      report: skipped({ indexes: "noMatchedTables", triggers: "snapshotPredatesCategory" }),
    });
    expect(note(container, "Indexes")).toBe("no matched tables");
    expect(note(container, "Triggers")).toBe("not compared");
  });

  it("leaves the rest of the board counting", () => {
    // Skipping is per category. A run that could not compare indexes still
    // knows exactly what happened to the tables.
    const { container } = board({
      report: {
        ...skipped({ indexes: "noMatchedTables" }),
        left: schema([table("orders", [])]),
        summary: { ...report().summary, identicalTables: 2 },
      },
    });
    expect(cells(container, "Tables")).toEqual(["2", "0", "0", "0"]);
  });
});

describe("the columns, on the screen they are serving", () => {
  it("reads a comparison as work a migration has not done yet", () => {
    const { container } = board();
    expect(columns(container)).toEqual([
      { label: "Object", sub: null },
      { label: "In sync", sub: null },
      { label: "Only in source", sub: "created" },
      // No switch has been touched yet, so the heading describes the drop
      // without claiming it is armed.
      { label: "Only in target", sub: "a sync would drop" },
      { label: "Changed", sub: null },
    ]);
  });

  it("says the drop is held back while the switch is off", () => {
    const { container } = board({ allowDataLoss: false });
    expect(columns(container)[3]).toEqual({
      label: "Only in target",
      sub: "drop held back",
    });
  });

  it("says dropped once the switch is armed", () => {
    const { container } = board({ allowDataLoss: true });
    expect(columns(container)[3]).toEqual({ label: "Only in target", sub: "dropped" });
  });

  it("reads drift as a record of what already happened", () => {
    // Same two columns, opposite meaning: nothing here is about to be done,
    // and "created"/"dropped" would name the reverse of the event.
    const { container } = board({ sides: "expected-live" });
    expect(columns(container)).toEqual([
      { label: "Object", sub: null },
      { label: "In sync", sub: null },
      { label: "Only in the baseline", sub: "gone from live" },
      { label: "Only in the live database", sub: "added since" },
      { label: "Changed", sub: null },
    ]);
  });
});

describe("the note under the board", () => {
  it("explains why what hangs off a one-sided table is not counted twice", () => {
    const { container } = board();
    expect(help(container)).toContain(
      "Columns, constraints, indexes, triggers, row security and partitioning " +
        "are counted on tables that exist on both sides."
    );
    expect(help(container)).toContain("are created or dropped with the table itself");
  });

  it("puts that in the past tense on drift", () => {
    const { container } = board({ sides: "expected-live" });
    expect(help(container)).toContain("arrived or went with the table");
    expect(help(container)).not.toContain("are created or dropped with the table itself");
  });

  it("stays quiet when there is nothing about this run to add", () => {
    const { container } = board();
    expect(flags(container)).toEqual([]);
  });

  it("names the categories that had no table pair to be counted on", () => {
    const { container } = board({
      report: skipped({ indexes: "noMatchedTables", triggers: "noMatchedTables" }),
    });
    expect(flags(container)).toEqual([
      "Indexes, Triggers have no matched tables to be counted on",
    ]);
    // The reassuring half: nothing is wrong with either snapshot, and the
    // migration is about to write the very objects this board did not count.
    expect(help(container)).toContain(
      "they are counted per table pair, and no table exists on both sides"
    );
    expect(help(container)).toContain(
      "is created or dropped with the table, and the migration below writes it"
    );
  });

  it("says where those went instead, on drift, where no migration is coming", () => {
    const { container } = board({
      sides: "expected-live",
      report: skipped({ indexes: "noMatchedTables" }),
    });
    expect(flags(container)).toEqual([
      "Indexes have no matched tables to be counted on",
    ]);
    expect(help(container)).toContain(
      "arrived or went with the table, and that table's card lists it"
    );
    expect(help(container)).not.toContain("the migration below writes it");
  });

  it("counts a change no statement can make, and says what the script does instead", () => {
    const { container } = board({
      report: report({
        left: schema([], { types: [rangeType("temperature")] }),
        right: schema([], { types: [rangeType("temperature")] }),
        objectDiffs: [unscriptable("RANGE TYPE", "temperature")],
      }),
    });
    expect(flags(container)).toEqual(["1 of these is counted but cannot be scripted"]);
    expect(help(container)).toContain(
      "PostgreSQL has no statement that makes the change (Enums & types), so the " +
        "script writes a note saying what has to be done and runs nothing for it."
    );
  });

  it("names every category holding one of them", () => {
    const { container } = board({
      report: report({
        left: schema([], { types: [rangeType("temperature")], collations: [collation("natural")] }),
        right: schema([], { types: [rangeType("temperature")], collations: [collation("natural")] }),
        objectDiffs: [
          unscriptable("RANGE TYPE", "temperature"),
          unscriptable("COLLATION", "natural"),
        ],
      }),
    });
    expect(flags(container)).toEqual(["2 of these are counted but cannot be scripted"]);
    expect(help(container)).toContain("(Enums & types, Collations)");
  });

  it("tells a drift reader that undoing one cannot be scripted either", () => {
    const { container } = board({
      sides: "expected-live",
      report: report({
        left: schema([], { types: [rangeType("temperature")] }),
        right: schema([], { types: [rangeType("temperature")] }),
        objectDiffs: [unscriptable("RANGE TYPE", "temperature")],
      }),
    });
    expect(help(container)).toContain(
      "so undoing it cannot be scripted either — it has to be done by hand."
    );
  });

  it("tells the reader which snapshot to capture again, and why it matters", () => {
    const { container } = board({
      report: skipped({ rowSecurity: "snapshotPredatesCategory" }),
    });
    expect(flags(container)).toEqual(["Row security could not be compared"]);
    expect(help(container)).toContain(
      "one of these snapshots was captured before this app recorded them, and " +
        "treating “no record” as “none” would report every one of " +
        "them as newly added. Re-capture it to include them."
    );
  });

  it("keeps the two reasons in separate sentences", () => {
    // The same run can hit both, and merging them would put a re-capture in
    // front of a reader whose snapshots are perfectly current.
    const { container } = board({
      report: skipped({ indexes: "noMatchedTables", rowSecurity: "snapshotPredatesCategory" }),
    });
    expect(flags(container)).toEqual([
      "Indexes have no matched tables to be counted on",
      "Row security could not be compared",
    ]);
  });
});
