/** @jest-environment jsdom */

/**
 * FindingCard — one piece of performance advice, and the chips that filter a
 * list of them.
 *
 * Both halves of the Performance section print through this one file: the
 * schema suggestions and the query analyser. Whatever it gets wrong, it gets
 * wrong in both places at once.
 *
 * What the card is for is a decision — whether to run the SQL it is holding —
 * and everything on it exists so that decision is not made on the wrong
 * information. The heading says what running it would do, so a schema change
 * is not pasted into a console as if it were a session setting. The undo says
 * how to take it back out, and under a fix that removes something it has to
 * say "put it back" rather than "undo", because the statement underneath is a
 * CREATE and "To undo" above a CREATE reads as if the CREATE were the thing to
 * be careful of. The step number is the only thread between a finding and the
 * plan above it. The severity is the order the reader works in.
 *
 * The filter chips have their own reason to be here: a filter that selects an
 * empty list looks exactly like results that failed to load, and the chip
 * counts are what tell those two apart.
 *
 * What is NOT here:
 *  - Which findings exist, how serious each one is, and the SQL each carries.
 *    That is lib/perf-advice and lib/perf-sql, covered by
 *    tests/perf-advice.test.ts, tests/perf-sql.test.ts and
 *    tests/query-analysis.test.ts — the first two through
 *    tests/helpers/fix-invariants.ts, which holds every rule to a fix that is
 *    not empty. This file covers only what happens once one of those arrives.
 *  - The two screens that build these cards. components/studio/PerfAdviceList
 *    has no suite at all. The analyser has tests/component-query-analyzer.test.tsx,
 *    but it is about an answer staying tied to the target it was asked through
 *    and its fixture carries no findings, and tests/page-performance.test.tsx
 *    stubs an empty advice list — so before this file nothing anywhere drew one
 *    of these cards.
 *  - components/studio/PlanTree, which borrows SEVERITY_META from this file to
 *    colour its rows. It has no suite, so the colours are pinned here only as
 *    the card uses them.
 *  - What the browser does with a copied statement. jsdom has no clipboard, so
 *    these tests install one and check what was handed to it; that the
 *    clipboard then holds it is the browser's promise, not this app's.
 *  - Pill and Card themselves (components/ui). The tone class is asserted here
 *    because SEVERITY_META chooses it; what the class then looks like is CSS.
 *  - Two halves of undoHeading's /^DROP\b/i that nothing can reach: that the
 *    match starts at the statement and stops at a word boundary. Every DROP the
 *    rules write begins its statement, so no fix exists that would tell those
 *    guards apart, and a fixture invented to do it would be testing SQL this app
 *    never produces. If either were deleted, nothing here would notice.
 */

import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";

import {
  FIX_KIND_HEADING,
  FindingCard,
  OriginBadge,
  SeverityFilter,
  activeFilter,
  undoHeading,
  type FindingCounts,
  type FindingSeverity,
  type FilterKey,
} from "@/components/studio/FindingCard";
import type { FixKind } from "@/lib/perf-sql";

type CardProps = ComponentProps<typeof FindingCard>;

/** A finding of the shape lib/perf-advice really produces. */
const BASE: CardProps = {
  severity: "high",
  title: "Nothing reads orders through an index",
  object: "public.orders",
  detail: "Every read of this table is a sequential scan of all of it.",
  fix: "CREATE INDEX CONCURRENTLY orders_customer_id_idx ON public.orders (customer_id);",
  fixKind: "change",
};

function card(over: Partial<CardProps> = {}) {
  return render(<FindingCard {...BASE} {...over} />);
}

/** Each severity as the card shows it: the word, the pill's tone, the stripe. */
const SEVERITIES: [FindingSeverity, string, string, string][] = [
  ["high", "High", "pill-break", "var(--break)"],
  ["medium", "Medium", "pill-drift", "var(--drift)"],
  ["low", "Low", "pill-neutral", "var(--text-3)"],
];

const KINDS: [FixKind, string][] = [
  ["change", "Schema change: save it as a migration"],
  ["maintenance", "Maintenance: run it by hand"],
  ["query", "Change the query: nothing runs on the server"],
  ["decision", "Needs your decision"],
];

afterEach(() => cleanup());

describe("how serious the finding is", () => {
  it("says it in a word and in a colour, so a column of them can be scanned", () => {
    for (const [severity, word, tone] of SEVERITIES) {
      card({ severity });
      expect(screen.getByText(word)).toHaveClass(tone);
      cleanup();
    }
  });

  it("repeats the severity in the stripe down the side of the card", () => {
    // The stripe is the same decision in a form a column of cards can be
    // scanned by without reading any of the pills.
    for (const [severity, , , color] of SEVERITIES) {
      const { container } = card({ severity });
      const stripe = container.querySelector("[style]") as HTMLElement;
      expect(stripe.style.borderLeft).toBe(`3px solid ${color}`);
      cleanup();
    }
  });
});

describe("what the card names", () => {
  it("prints the object, what is wrong with it, and why", () => {
    card();
    expect(screen.getByText("public.orders")).toBeInTheDocument();
    expect(screen.getByText(BASE.title)).toBeInTheDocument();
    expect(screen.getByText(BASE.detail)).toBeInTheDocument();
  });

  it("shows the badge it was handed, and nothing in its place when there is none", () => {
    card({ badge: <span>From your slowest query</span> });
    expect(screen.getByText("From your slowest query")).toBeInTheDocument();
    cleanup();

    card();
    expect(screen.queryByText("From your slowest query")).not.toBeInTheDocument();
  });

  it("counts the plan step the way the plan does, from one", () => {
    // step is the id, 0-based. A card saying "Step 0" next to a plan whose
    // first row is "Step 1" is a finding the reader cannot place.
    card({ step: 0 });
    expect(screen.getByText("Step 1")).toHaveAttribute(
      "title",
      "The step in the plan above that this is about"
    );
  });

  it("says nothing about a step when the finding is not about one", () => {
    card({ step: null });
    expect(screen.queryByText(/^Step /)).not.toBeInTheDocument();
    cleanup();

    card();
    expect(screen.queryByText(/^Step /)).not.toBeInTheDocument();
  });
});

describe("where it sends the reader next", () => {
  it("links where it was told to", () => {
    card({ action: { label: "Analyse a query on this table", href: "/performance?tab=analyse" } });
    expect(screen.getByRole("link", { name: "Analyse a query on this table" })).toHaveAttribute(
      "href",
      "/performance?tab=analyse"
    );
  });

  it("shows no link when there is nowhere to go", () => {
    card();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});

describe("the fix, and what running it would do", () => {
  it("heads each kind of fix with what that kind of fix is", () => {
    for (const [fixKind, heading] of KINDS) {
      card({ fixKind });
      expect(screen.getByText(heading)).toBeInTheDocument();
      cleanup();
    }
  });

  it("has a heading for every kind of fix there is", () => {
    // Not the same check: the loop above would still pass with a fifth kind
    // added to lib/perf-sql and left out of this map, which renders as
    // "undefined" above the SQL.
    expect(Object.keys(FIX_KIND_HEADING).sort()).toEqual(KINDS.map(([kind]) => kind).sort());
  });

  it("can be told to say something else instead", () => {
    // The Analyse tab's fix for a table in another schema is not saved as a
    // migration, so the usual words for a schema change would be a lie.
    card({ fixHeading: "Change on another schema: run it there yourself" });
    expect(screen.getByText("Change on another schema: run it there yourself")).toBeInTheDocument();
    expect(screen.queryByText("Schema change: save it as a migration")).not.toBeInTheDocument();
  });

  it("prints the fix as it was given", () => {
    const { container } = card();
    expect(container.querySelector("pre")).toHaveTextContent(
      "CREATE INDEX CONCURRENTLY orders_customer_id_idx ON public.orders (customer_id);"
    );
  });

  it("draws no code box at all when there is no fix to show", () => {
    // An empty box reads as a fix that failed to load.
    for (const fix of ["", "   \n  "]) {
      const { container } = card({ fix });
      expect(container.querySelector("pre")).toBeNull();
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
      cleanup();
    }
  });
});

describe("the statement that puts it back", () => {
  it("shows the undo in a box of its own", () => {
    const { container } = card({ undo: "DROP INDEX CONCURRENTLY orders_customer_id_idx;" });
    expect(screen.getByText("To undo")).toBeInTheDocument();
    expect(container.querySelectorAll("pre")).toHaveLength(2);
  });

  it("shows no undo box when there is nothing to undo with", () => {
    for (const undo of [undefined, "", "  \n "]) {
      const { container } = card({ undo });
      expect(container.querySelectorAll("pre")).toHaveLength(1);
      expect(screen.queryByText(/^To (undo|put it back)$/)).not.toBeInTheDocument();
      cleanup();
    }
  });

  it("calls it putting it back when the fix removed something", () => {
    // The undo under a DROP INDEX is the CREATE INDEX that rebuilds it, and
    // "To undo" over a CREATE reads as if the CREATE were the risk.
    card({
      fixKind: "maintenance",
      fix: "DROP INDEX CONCURRENTLY orders_unused_idx;",
      undo: "CREATE INDEX CONCURRENTLY orders_unused_idx ON public.orders (status);",
    });
    expect(screen.getByText("To put it back")).toBeInTheDocument();
  });
});

describe("undoHeading on its own", () => {
  it("does not care how the DROP was typed", () => {
    expect(undoHeading("drop index orders_unused_idx;")).toBe("To put it back");
  });

  it("reads past the comment explaining the fix", () => {
    expect(undoHeading("-- Nothing reads through this one.\nDROP INDEX orders_unused_idx;")).toBe(
      "To put it back"
    );
  });

  it("reads past blank lines and indentation", () => {
    expect(undoHeading("\n\n   DROP INDEX orders_unused_idx;")).toBe("To put it back");
  });

  it("does not let a comment decide for the statement under it", () => {
    // A rule that explains itself by naming the DROP it is replacing must not
    // be read as a DROP.
    expect(
      undoHeading("-- Replaces the DROP INDEX this used to suggest.\nCREATE INDEX o_idx ON o (id);")
    ).toBe("To undo");
  });

  it("calls it an undo when the fix removes nothing", () => {
    expect(undoHeading("CREATE INDEX o_idx ON o (id);")).toBe("To undo");
  });

  it("calls it an undo when there is no statement at all", () => {
    // Unreachable through the card, which draws nothing for an empty fix, but
    // the function is exported and must not read undefined.
    expect(undoHeading("")).toBe("To undo");
    expect(undoHeading("-- only a comment\n")).toBe("To undo");
  });
});

describe("copying what it printed", () => {
  let written: string[];

  beforeEach(() => {
    // jsdom has no navigator.clipboard, and tests/helpers/jsdom-gaps.ts
    // deliberately does not invent one. Without this the component's own catch
    // swallows every copy and the button never changes.
    written = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void written.push(text) },
    });
    // The button says "Copied" for 1.5s and then goes back. A real timer would
    // still be pending when the test ends.
    jest.useFakeTimers();
  });

  afterEach(() => jest.useRealTimers());

  /** Click a Copy button and let the clipboard's promise settle. */
  async function copy(button: HTMLElement) {
    await act(async () => {
      fireEvent.click(button);
    });
  }

  /** The Copy button belonging to the box under this heading. */
  function copyUnder(heading: string) {
    const row = screen.getByText(heading).closest("div") as HTMLElement;
    return within(row).getByRole("button");
  }

  it("copies the fix, and says that it did", async () => {
    card();
    const button = copyUnder("Schema change: save it as a migration");
    expect(button).toHaveTextContent("Copy");

    await copy(button);
    expect(written).toEqual([BASE.fix]);
    expect(button).toHaveTextContent("Copied");
  });

  it("gives each box its own button, copying its own statement", async () => {
    card({ undo: "DROP INDEX CONCURRENTLY orders_customer_id_idx;" });

    await copy(copyUnder("To undo"));
    expect(written).toEqual(["DROP INDEX CONCURRENTLY orders_customer_id_idx;"]);
    // The fix's button is untouched, so nothing suggests it was the one copied.
    expect(copyUnder("Schema change: save it as a migration")).toHaveTextContent("Copy");
  });

  it("goes back to offering a copy once the reader has seen it worked", async () => {
    card();
    const button = copyUnder("Schema change: save it as a migration");
    await copy(button);
    expect(button).toHaveTextContent("Copied");

    act(() => void jest.advanceTimersByTime(1500));
    expect(button).toHaveTextContent("Copy");
  });

  it("leaves the button alone when the browser will not give up the clipboard", async () => {
    // What an insecure context looks like from in here.
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });

    card();
    const button = copyUnder("Schema change: save it as a migration");
    await copy(button);

    // Not "Copied": nothing was. The SQL is still on screen to select by hand.
    expect(button).toHaveTextContent("Copy");
  });
});

describe("the severity filter", () => {
  const COUNTS: FindingCounts = { high: 2, medium: 1, low: 0, total: 3 };

  function filter(over: Partial<ComponentProps<typeof SeverityFilter>> = {}) {
    const onChange = jest.fn<void, [FilterKey]>();
    const view = render(<SeverityFilter counts={COUNTS} value="all" onChange={onChange} {...over} />);
    return { onChange, ...view };
  }

  const chip = (label: string) =>
    screen.getAllByRole("button").find((b) => b.textContent?.startsWith(label)) as HTMLElement;

  it("says how many findings each chip would leave", () => {
    filter();
    // The count sits right against the label in the markup; the space between
    // them on screen is a margin.
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "All3",
      "High2",
      "Medium1",
      "Low0",
    ]);
  });

  it("says which chip is on, and not only in its colour", () => {
    filter({ value: "high" });
    expect(chip("High")).toHaveAttribute("aria-pressed", "true");
    expect(chip("All")).toHaveAttribute("aria-pressed", "false");
    expect(chip("Medium")).toHaveAttribute("aria-pressed", "false");
  });

  it("will not let a severity with nothing in it be chosen", () => {
    filter();
    expect(chip("Low")).toBeDisabled();
    expect(chip("High")).toBeEnabled();
  });

  it("shuts every chip when there is nothing to filter", () => {
    filter({ counts: { high: 0, medium: 0, low: 0, total: 0 } });
    for (const label of ["All", "High", "Medium", "Low"]) {
      expect(chip(label)).toBeDisabled();
    }
  });

  it("reports the chip that was pressed", () => {
    const { onChange } = filter();
    fireEvent.click(chip("Medium"));
    expect(onChange).toHaveBeenCalledWith("medium");
  });
});

describe("activeFilter", () => {
  it("drops a filter that would show an empty list under a full set of counts", () => {
    // Left on High from the previous run. An empty list underneath three
    // counts reads as results that failed to load.
    expect(activeFilter("high", { high: 0, medium: 2, low: 1, total: 3 })).toBe("all");
  });

  it("keeps a filter that still has something behind it", () => {
    expect(activeFilter("high", { high: 2, medium: 1, low: 0, total: 3 })).toBe("high");
  });

  it("leaves All alone even when there is nothing at all", () => {
    // Nothing found is a real answer, and the screen says so in its own words.
    expect(activeFilter("all", { high: 0, medium: 0, low: 0, total: 0 })).toBe("all");
  });
});

describe("where a finding came from", () => {
  it("shows the label, and explains it to anyone who stops on it", () => {
    render(<OriginBadge label="Slow query" help="Found while analysing one of your saved queries" />);
    expect(screen.getByText("Slow query")).toHaveAttribute(
      "title",
      "Found while analysing one of your saved queries"
    );
  });
});
