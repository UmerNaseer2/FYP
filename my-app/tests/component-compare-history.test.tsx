/** @jest-environment jsdom */

/**
 * The panel that answers "is this the same fourteen differences I looked at
 * last week, or fourteen different ones?".
 *
 * The report below it is a photograph of how two schemas differ today, and a
 * photograph cannot answer that. So the server works out what moved since the
 * last run of the same pair and hands this component a sentence and two lists;
 * all this file does is draw them.
 *
 * Three of its decisions are judgements rather than plumbing, and they are
 * what most of the tests below are about.
 *
 * It opens on what APPEARED, not on whether anything moved. Differences going
 * away is good news and can stay folded up; new ones are the reason somebody
 * came back to this screen. A panel that opened on either would be open on
 * nearly every comparison and stop meaning anything.
 *
 * It offers a chevron only when there is something under the summary worth
 * opening onto. When neither list has anything in it the body is one line of
 * text, and a chevron there is a promise the panel cannot keep.
 *
 * And each list's pill counts the whole list while the list itself stops at
 * fifteen rows. Those two numbers disagreeing is the point — the pill is how
 * many moved, the rows are as many as are worth reading — so the count is
 * taken from the lines rather than from what was drawn.
 *
 * Nothing here is interactive: no state, no handlers, no fetches.
 *
 * What is NOT here:
 *  - Working out what moved, and writing the sentence about it. That is
 *    lib/comparison-history — snapshotChanges, compareRuns, describeItem and
 *    describeDelta — and it is covered by tests/comparison-history.test.ts.
 *    The sentence handed in below is written by hand, in the shape that file
 *    produces, so these tests keep their meaning if the wording changes.
 *  - The decision not to render this panel at all on a first comparison, which
 *    is the compare page's (`outcome.history && <CompareHistory …>`) sitting on
 *    a null that lib/compare-run fills in. That wiring has no suite of its own.
 *  - Reading and writing the stored run the comparison is made against:
 *    tests/comparison-history.test.ts covers readRunSnapshot; the database
 *    round trip is not exercised anywhere in the unit tests.
 *  - The report below the panel: tests/component-diff-report.test.tsx, and
 *    tests/component-critical-changes.test.tsx for the panel above it.
 *  - That the panel is tinted, that the chevron turns, or that the spacer
 *    pushes it right. All CSS, and jsdom applies no stylesheet. For the same
 *    reason a shut <details> still has its contents in the document here, so
 *    "shut" is read off the element's own open flag.
 */

import "@testing-library/jest-dom";
import { render } from "@testing-library/react";

import { CompareHistory } from "@/components/studio/CompareHistory";
import type { ComparisonHistoryView, HistoryLine } from "@/lib/compare-run";
import type { ChangeSeverity } from "@/lib/compare-types";

/** When the run being measured against happened, exactly as it is stored. */
const SINCE = "2026-09-12T14:30:00.000Z";

/** The same instant as the sentence says it, which is not the same string. */
const WHEN = "on 12 Sep 2026, 14:30";

/**
 * U+2212 MINUS SIGN, which is what the component writes — not the hyphen on
 * the keyboard. Named here because a retyped copy of this file would fail on a
 * character that looks identical in the diff.
 */
const MINUS = "−";

const noun = (count: number) => (count === 1 ? "difference" : "differences");

/**
 * The sentence the server would have written for these two lists.
 *
 * The component draws whatever string it is handed and describeDelta is
 * another suite's business, but a headline reading "nothing has drifted" over
 * a list of four new differences is not a panel this app can produce, and a
 * fixture that could never happen tests nothing.
 */
function sentenceFor(appeared: HistoryLine[], resolved: HistoryLine[]): string {
  if (appeared.length === 0 && resolved.length === 0) {
    return `The same differences as the comparison ${WHEN}. Nothing has drifted since.`;
  }
  const parts: string[] = [];
  if (appeared.length > 0) parts.push(`${appeared.length} new ${noun(appeared.length)}`);
  if (resolved.length > 0) parts.push(`${resolved.length} ${noun(resolved.length)} resolved`);
  return `Since the comparison ${WHEN}: ${parts.join(", ")}.`;
}

function view(over: Partial<ComparisonHistoryView> = {}): ComparisonHistoryView {
  const appeared = over.appeared ?? [];
  const resolved = over.resolved ?? [];
  return {
    since: SINCE,
    by: "ada@example.com",
    sentence: sentenceFor(appeared, resolved),
    appeared,
    resolved,
    ...over,
  };
}

/** One moved difference, already described by the server. */
function line(label: string, severity: ChangeSeverity = "safe"): HistoryLine {
  return { label, severity };
}

/** `count` distinct lines, for the cases that overflow a list. */
function many(count: number, prefix: string): HistoryLine[] {
  return Array.from({ length: count }, (_, index) => line(`${prefix}.col_${index} added`));
}

function renderPanel(history: ComparisonHistoryView) {
  return render(<CompareHistory history={history} />);
}

/** Text as the page reads it, with the JSX source's own line wraps collapsed. */
const words = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

const panel = () => document.querySelector("details.history") as HTMLDetailsElement;
const sentence = () => document.querySelector(".history__sentence");
const chevron = () => document.querySelector(".chev");
const groups = () => Array.from(document.querySelectorAll(".history__group"));
const who = () => document.querySelector(".history__who");

/**
 * The paragraphs that sit directly in the body rather than inside a list —
 * the line that replaces the two lists, and the credit line under them.
 */
const bodyParagraphs = () =>
  Array.from(document.querySelectorAll(".obj-group > p.help")).map(words);

const titleOf = (group: Element) => words(group.querySelector(".history__title"));
const countOf = (group: Element) => words(group.querySelector(".pill"));
const rowsIn = (group: Element) => Array.from(group.querySelectorAll(".history__row"));
const labelsIn = (group: Element) => rowsIn(group).map((row) => words(row.querySelector(".body")));
const helpIn = (group: Element) => Array.from(group.querySelectorAll(".help")).map(words);

describe("the summary line", () => {
  test("shows the sentence the server wrote", () => {
    renderPanel(view({ appeared: [line("orders.total added")] }));
    expect(words(sentence())).toBe(`Since the comparison ${WHEN}: 1 new difference.`);
  });

  test("hangs the stored stamp off it as a tooltip", () => {
    // The sentence says "on 12 Sep 2026, 14:30" because that is what a reader
    // wants; the exact instant is what they check when they doubt it.
    renderPanel(view());
    expect(sentence()).toHaveAttribute("title", SINCE);
  });
});

describe("whether it starts open", () => {
  test("opens when new differences have appeared", () => {
    renderPanel(view({ appeared: [line("orders.total added")] }));
    expect(panel().open).toBe(true);
  });

  test("stays shut when the only movement is differences going away", () => {
    // Good news folds up. Opening on this as well would leave the panel open
    // on nearly every comparison, which is the same as it never being open.
    renderPanel(view({ resolved: [line("orders.notes added")] }));
    expect(panel().open).toBe(false);
  });

  test("stays shut when nothing moved at all", () => {
    renderPanel(view());
    expect(panel().open).toBe(false);
  });

  test("opens on what appeared even when things were resolved too", () => {
    renderPanel(
      view({ appeared: [line("orders.total added")], resolved: [line("orders.notes added")] })
    );
    expect(panel().open).toBe(true);
  });
});

describe("when nothing moved", () => {
  test("says so in one line instead of two empty lists", () => {
    renderPanel(view());
    expect(groups()).toHaveLength(0);
    expect(bodyParagraphs()[0]).toBe(
      "The two schemas differ in exactly the ways they did then."
    );
  });

  test("offers no chevron, because there is nothing to open onto", () => {
    renderPanel(view());
    expect(chevron()).toBeNull();
  });
});

describe("when something moved", () => {
  test("offers the chevron", () => {
    renderPanel(view({ resolved: [line("orders.notes added")] }));
    expect(chevron()).not.toBeNull();
  });

  test("drops the one-line summary for the lists", () => {
    renderPanel(view({ appeared: [line("orders.total added")] }));
    expect(bodyParagraphs()).toEqual([expect.stringContaining("That run was made by")]);
  });

  test("puts what is new first and what went away second", () => {
    renderPanel(
      view({ appeared: [line("orders.total added")], resolved: [line("orders.notes added")] })
    );
    expect(groups().map(titleOf)).toEqual(["New since then", "No longer different"]);
  });

  test("signs the two lists differently", () => {
    renderPanel(
      view({ appeared: [line("orders.total added")], resolved: [line("orders.notes added")] })
    );
    expect(words(rowsIn(groups()[0])[0].querySelector(".sign"))).toBe("+");
    expect(words(rowsIn(groups()[1])[0].querySelector(".sign"))).toBe(MINUS);
  });

  test("counts each list beside its own heading", () => {
    renderPanel(
      view({
        appeared: many(3, "orders"),
        resolved: [line("orders.notes added")],
      })
    );
    expect(groups().map(countOf)).toEqual(["3", "1"]);
  });
});

describe("the lists themselves", () => {
  test("names every difference that moved, in the order it was given them", () => {
    renderPanel(
      view({ appeared: [line("orders.total added"), line("orders.notes added")] })
    );
    expect(labelsIn(groups()[0])).toEqual(["orders.total added", "orders.notes added"]);
  });

  test("marks the breaking ones and says so in words", () => {
    renderPanel(view({ appeared: [line("orders.total dropped", "breaking")] }));
    const row = rowsIn(groups()[0])[0];
    expect(words(row.querySelector(".history__break"))).toBe("breaking");
    expect(row.querySelector(".chg-break")).not.toBeNull();
  });

  test("leaves the mark off the rest", () => {
    renderPanel(view({ appeared: [line("orders.total added")] }));
    const row = rowsIn(groups()[0])[0];
    expect(row.querySelector(".history__break")).toBeNull();
    expect(row.querySelector(".chg-break")).toBeNull();
    expect(row.querySelector(".mono")).not.toBeNull();
  });

  test("grades each row on its own", () => {
    renderPanel(
      view({ appeared: [line("orders.total dropped", "breaking"), line("orders.notes added")] })
    );
    expect(rowsIn(groups()[0]).map((row) => row.querySelector(".history__break") !== null)).toEqual(
      [true, false]
    );
  });

  test("says nothing new when the movement was all the other way", () => {
    // Both lists are always drawn once either has anything in it, so the empty
    // one has to say which kind of nothing it is.
    renderPanel(view({ resolved: [line("orders.notes added")] }));
    expect(rowsIn(groups()[0])).toHaveLength(0);
    expect(helpIn(groups()[0])).toEqual(["Nothing new."]);
    expect(rowsIn(groups()[1])).toHaveLength(1);
  });

  test("and says nothing was resolved the other way round", () => {
    renderPanel(view({ appeared: [line("orders.total added")] }));
    expect(rowsIn(groups()[1])).toHaveLength(0);
    expect(helpIn(groups()[1])).toEqual(["Nothing was resolved."]);
  });
});

describe("a run with more movement than fits", () => {
  test("lists them all while they fit", () => {
    renderPanel(view({ appeared: many(15, "orders") }));
    expect(rowsIn(groups()[0])).toHaveLength(15);
    expect(helpIn(groups()[0])).toEqual([]);
  });

  test("cuts the list once they do not, and counts what it cut", () => {
    renderPanel(view({ appeared: many(16, "orders") }));
    expect(rowsIn(groups()[0])).toHaveLength(15);
    expect(helpIn(groups()[0])).toEqual(["…and 1 more."]);
  });

  test("still counts every one of them beside the heading", () => {
    // The pill is how many moved; the rows are how many are worth reading.
    // Taking the pill from the drawn rows would quietly under-report drift.
    renderPanel(view({ appeared: many(40, "orders") }));
    expect(countOf(groups()[0])).toBe("40");
    expect(helpIn(groups()[0])).toEqual(["…and 25 more."]);
  });

  test("cuts each list on its own", () => {
    renderPanel(view({ appeared: many(16, "orders"), resolved: many(3, "invoices") }));
    expect(rowsIn(groups()[0])).toHaveLength(15);
    expect(helpIn(groups()[0])).toEqual(["…and 1 more."]);
    expect(rowsIn(groups()[1])).toHaveLength(3);
    expect(helpIn(groups()[1])).toEqual([]);
  });
});

describe("the credit line", () => {
  test("says who ran the comparison this is measured against", () => {
    renderPanel(view({ by: "ada@example.com" }));
    expect(words(who())).toContain("That run was made by ada@example.com.");
  });

  test("carries whatever the run was recorded under", () => {
    // Not always an address — a run made with authentication bypassed is
    // stored under a phrase, and the panel must not dress it up as a person.
    renderPanel(view({ by: "(authentication bypassed)" }));
    expect(words(who())).toContain("That run was made by (authentication bypassed).");
  });

  test("says what is not tracked, so a quiet panel is not read as an all-clear", () => {
    renderPanel(view());
    expect(words(who())).toContain("Only structural differences are tracked");
    expect(words(who())).toContain("row counts move whenever the database is used");
  });
});
