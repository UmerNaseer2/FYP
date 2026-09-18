/** @jest-environment jsdom */

/**
 * The four ways a diff leaves the compare screen.
 *
 * Everything this bar hands over is built elsewhere — the document on the
 * server, the Markdown, JSON and CSV in lib/compare-export-format — so what is
 * left to get wrong is the handing over itself, and all four ways have a way of
 * failing quietly:
 *
 *   A copy that the browser refused looks exactly like a copy that worked. The
 *   clipboard is blocked outside a secure context and there is no asking in
 *   advance, so the only honest answer is to say so afterwards and point at the
 *   downloads, which are not blocked.
 *
 *   Print is the one export this app does not write. The browser does, from the
 *   page, which means the page has to be worth printing: every card here is a
 *   <details>, and a collapsed one prints as its one-line summary, so the paper
 *   would carry whichever parts the reader happened to have expanded. And the
 *   app is dark by default, which prints as pale grey on white with background
 *   graphics off — the default.
 *
 *   Both of those are undone afterwards, and the undoing is shared. The compare
 *   screen renders one of these bars per target, so a two-target run has two
 *   handlers saving the theme: the second used to save the "light" the first had
 *   just written and put THAT back, leaving the whole app stuck in light once
 *   the dialog closed.
 *
 * What is NOT here:
 *  - What the exported files actually say. The four formatters live in
 *    lib/compare-export-format.ts, and only two of them are covered:
 *    countedChanges and documentToMarkdown's headline, by
 *    tests/compare-export.test.ts, which also holds this bar's count against
 *    the header above it on real engine output. documentToJson and
 *    documentToCsv have no suite of their own, and exportFileStem is exercised
 *    below only as far as the file name. The tests here pin which document goes
 *    into which format, what it is called and when it is let go of — not what
 *    comes out.
 *  - Building the document: buildDiffDocument in lib/compare-export.ts, through
 *    that same suite.
 *  - The screen that mounts this. tests/page-compare.test.tsx stops before a
 *    finished comparison exists, so the bar had never been rendered.
 *  - The other caller of downloadText — the performance fix script — is
 *    tests/component-fix-script-builder.test.tsx.
 *  - Whether the print stylesheet is any good. That is app/globals.css, and
 *    nothing here can see a printed page; what these tests hold is the state
 *    the page is put into for it.
 */

import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ExportBar } from "@/components/studio/ExportBar";
import type { DiffDocument } from "@/lib/compare-export";
import type { TableDataCompare } from "@/lib/compare-data-summary";
import {
  documentToCsv,
  documentToJson,
  documentToMarkdown,
} from "@/lib/compare-export-format";

/** The clock the JSON stamp is read from. */
const NOW = new Date("2026-04-02T09:30:00.000Z");

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
 * A finished comparison. The source database has a dash in it on purpose: the
 * file name is built from both sides, and a dash is not a character every
 * download folder and shell handles the same way.
 */
function doc(over: Partial<DiffDocument> = {}): DiffDocument {
  return {
    format: "schema-studio-diff",
    version: 1,
    source: { database: "shop-dev", schema: "public" },
    target: { database: "shop_prod", schema: "public" },
    totals: totals(),
    notCompared: [],
    categories: [],
    changes: [],
    data: null,
    ...over,
  };
}

/** One table in a row-data comparison; only how many there are is read here. */
function dataTable(name: string): TableDataCompare {
  return {
    table: name,
    status: "identical",
    leftRows: 10,
    rightRows: 10,
    leftChecksum: "abc",
    rightChecksum: "abc",
    columns: ["id"],
    ignoredColumns: [],
    note: null,
    sample: null,
    droppedBySync: false,
  };
}

/** Every file the bar handed the browser, in order. */
let downloads: { name: string; type: string; text: string }[] = [];
/** What the page was asked to copy, when the clipboard let it. */
let copies: string[] = [];
let revoked: string[] = [];
let printed = 0;

const button = (name: RegExp) => screen.getByRole("button", { name });
const count = (c: HTMLElement) => c.querySelector(".export-bar__count")?.textContent ?? "";
const problem = (c: HTMLElement) => c.querySelector(".export-bar__error")?.textContent ?? null;

/** A clipboard that accepts writes, or one the browser has blocked. */
function setClipboard(mode: "allowed" | "blocked") {
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value:
      mode === "allowed"
        ? {
            writeText: (text: string) => {
              copies.push(text);
              return Promise.resolve();
            },
          }
        : // What a browser outside a secure context actually leaves behind:
          // no clipboard object at all, so reading .writeText throws.
          undefined,
  });
}

/** Let the click's promise settle without letting the fake clock move. */
const settle = () => act(async () => {});

const theme = () => window.document.documentElement.getAttribute("data-theme");

beforeEach(() => {
  downloads = [];
  copies = [];
  revoked = [];
  printed = 0;
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  setClipboard("allowed");

  // jsdom has no object URLs and no print dialog, and its Blob will not give
  // its own text back — so the Blob is recorded on the way in instead.
  (window as unknown as { Blob: unknown }).Blob = class {
    constructor(parts: string[], options: { type: string }) {
      downloads.push({ name: "", type: options.type, text: parts.join("") });
    }
  };
  URL.createObjectURL = () => "blob:export";
  URL.revokeObjectURL = (url: string) => {
    revoked.push(url);
  };
  window.print = () => {
    printed += 1;
  };
  // Naming the file is the whole point of the anchor, and letting jsdom follow
  // a blob: link is not.
  jest
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      downloads[downloads.length - 1].name = this.download;
    });
});

afterEach(() => {
  cleanup();
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
  window.document.documentElement.removeAttribute("data-theme");
});

describe("copying the diff", () => {
  it("hands the clipboard the whole document as Markdown", async () => {
    const d = doc({ totals: totals({ changes: 3, added: 3 }) });
    render(<ExportBar doc={d} />);
    fireEvent.click(button(/Copy as Markdown/));
    await settle();
    expect(copies).toEqual([documentToMarkdown(d)]);
  });

  it("says it worked, and stops saying it", async () => {
    // A button stuck on "Copied" is a button that claims the next copy
    // happened too.
    const { container } = render(<ExportBar doc={doc()} />);
    fireEvent.click(button(/Copy as Markdown/));
    await settle();
    expect(button(/Copied/)).toBeInTheDocument();
    expect(problem(container)).toBeNull();

    act(() => jest.advanceTimersByTime(1500));
    expect(button(/Copy as Markdown/)).toBeInTheDocument();
  });

  it("says the browser refused, rather than looking like nothing happened", async () => {
    // Outside a secure context there is no clipboard to write to and no way to
    // find that out in advance — so the button has to answer afterwards, and
    // point at the two ways out that are not blocked.
    setClipboard("blocked");
    const { container } = render(<ExportBar doc={doc()} />);
    fireEvent.click(button(/Copy as Markdown/));
    await settle();
    expect(problem(container)).toBe(
      "Copy blocked by the browser — use the JSON or CSV download."
    );
    expect(screen.queryByRole("button", { name: /Copied/ })).not.toBeInTheDocument();
  });

  it("takes the refusal back when a later copy works", async () => {
    // Permission can arrive between two clicks. Leaving the line up would tell
    // the reader to go and download something they have already copied.
    setClipboard("blocked");
    const { container } = render(<ExportBar doc={doc()} />);
    fireEvent.click(button(/Copy as Markdown/));
    await settle();
    expect(problem(container)).not.toBeNull();

    setClipboard("allowed");
    fireEvent.click(button(/Copy as Markdown/));
    await settle();
    expect(problem(container)).toBeNull();
    expect(button(/Copied/)).toBeInTheDocument();
  });
});

describe("downloading the diff", () => {
  it("writes JSON stamped with the moment it was asked for", () => {
    // The stamp is not in the document — it is when this copy left the app,
    // which is the only thing a file sitting in a pull request can be dated by.
    const d = doc({ totals: totals({ changes: 2, added: 2 }) });
    render(<ExportBar doc={d} />);
    fireEvent.click(button(/^JSON$/));
    expect(downloads).toEqual([
      {
        name: "diff_shop_dev_public_to_shop_prod_public.json",
        type: "application/json;charset=utf-8",
        text: documentToJson(d, NOW.toISOString()),
      },
    ]);
  });

  it("writes CSV under the same name", () => {
    const d = doc({ totals: totals({ changes: 2, added: 2 }) });
    render(<ExportBar doc={d} />);
    fireEvent.click(button(/^CSV$/));
    expect(downloads).toEqual([
      {
        name: "diff_shop_dev_public_to_shop_prod_public.csv",
        type: "text/csv;charset=utf-8",
        text: documentToCsv(d),
      },
    ]);
  });

  it("lets go of the file once the browser has taken it", () => {
    // The object URL holds the whole file in memory until it is released, and
    // this page can hand out one per click for as long as it stays open. The
    // release waits a tick on purpose: Safari has not finished with the URL
    // when click() returns, and revoking there cancels the download.
    render(<ExportBar doc={doc()} />);
    fireEvent.click(button(/^CSV$/));
    expect(revoked).toEqual([]);
    act(() => jest.advanceTimersByTime(0));
    expect(revoked).toEqual(["blob:export"]);
  });

  it("names the file after both sides of the comparison", () => {
    // Two exports from two different runs land in the same download folder.
    render(<ExportBar doc={doc({ target: { database: "shop_stage", schema: "public" } })} />);
    fireEvent.click(button(/^CSV$/));
    expect(downloads[0].name).toBe("diff_shop_dev_public_to_shop_stage_public.csv");
  });
});

describe("printing", () => {
  /** The bar, with a card that is collapsed and a card that is not. */
  function withCards() {
    return render(
      <>
        <details data-testid="collapsed">
          <summary>public.orders</summary>
          <p>a changed column</p>
        </details>
        <details data-testid="expanded" open>
          <summary>public.customers</summary>
          <p>a dropped index</p>
        </details>
        <ExportBar doc={doc()} />
      </>
    );
  }

  it("asks the browser for its own dialog, and says that is where the PDF is", () => {
    // "Print / PDF" promises something this app cannot write. The browser can,
    // from the same dialog, so the title says where to find it.
    render(<ExportBar doc={doc()} />);
    const print = button(/Print \/ PDF/);
    expect(print).toHaveAttribute(
      "title",
      "Opens the browser print dialog — choose “Save as PDF” there for a PDF"
    );
    fireEvent.click(print);
    expect(printed).toBe(1);
  });

  it("opens every collapsed card so the paper carries the whole diff", () => {
    const { getByTestId } = withCards();
    fireEvent(window, new Event("beforeprint"));
    expect(getByTestId("collapsed")).toHaveAttribute("open");
    expect(getByTestId("expanded")).toHaveAttribute("open");
    fireEvent(window, new Event("afterprint"));
  });

  it("closes the ones it opened and leaves the rest alone", () => {
    // Printing is not a reason to rearrange the screen the reader goes back to.
    const { getByTestId } = withCards();
    fireEvent(window, new Event("beforeprint"));
    fireEvent(window, new Event("afterprint"));
    expect(getByTestId("collapsed")).not.toHaveAttribute("open");
    expect(getByTestId("expanded")).toHaveAttribute("open");
  });

  it("borrows the light palette, then gives the reader their theme back", () => {
    // Dark ink prints as pale grey on white once the browser drops background
    // graphics, which it does by default.
    window.document.documentElement.setAttribute("data-theme", "dark");
    render(<ExportBar doc={doc()} />);
    fireEvent(window, new Event("beforeprint"));
    expect(theme()).toBe("light");
    fireEvent(window, new Event("afterprint"));
    expect(theme()).toBe("dark");
  });

  it("leaves no theme behind when there was none to start with", () => {
    // No attribute means "whatever the system asked for", and writing "dark"
    // back would freeze the app on the reader's daytime setting.
    render(<ExportBar doc={doc()} />);
    fireEvent(window, new Event("beforeprint"));
    expect(theme()).toBe("light");
    fireEvent(window, new Event("afterprint"));
    expect(theme()).toBeNull();
  });

  it("does not leave a two-target comparison stuck in light", () => {
    // Two bars, two handlers, one page. The second one to run sees the light
    // theme the first has already written — so only the first one to save gets
    // to put it back.
    window.document.documentElement.setAttribute("data-theme", "dark");
    render(
      <>
        <ExportBar doc={doc()} />
        <ExportBar doc={doc({ target: { database: "shop_stage", schema: "public" } })} />
      </>
    );
    fireEvent(window, new Event("beforeprint"));
    expect(theme()).toBe("light");
    fireEvent(window, new Event("afterprint"));
    expect(theme()).toBe("dark");
  });

  it("stops listening once the bar is gone", () => {
    // A handler left on the window would open every card on a screen that no
    // longer has an export bar.
    window.document.documentElement.setAttribute("data-theme", "dark");
    const { unmount } = withCards();
    unmount();
    fireEvent(window, new Event("beforeprint"));
    expect(theme()).toBe("dark");
  });
});

describe("the count beside the buttons", () => {
  it("counts the changes the export lists", () => {
    const { container } = render(
      <ExportBar doc={doc({ totals: totals({ changes: 7, added: 4, changed: 3 }) })} />
    );
    expect(count(container)).toBe("7 changes");
  });

  it("says one change in the singular", () => {
    const { container } = render(
      <ExportBar doc={doc({ totals: totals({ changes: 1, added: 1 }) })} />
    );
    expect(count(container)).toBe("1 change");
  });

  it("counts a possible rename beside the changes rather than among them", () => {
    // A suggestion is a pairing the matcher spotted and did NOT accept: the
    // migration does nothing about it, so a count that included it would
    // disagree with the header two inches above.
    const { container } = render(
      <ExportBar
        doc={doc({ totals: totals({ changes: 8, added: 4, changed: 3, renameSuggestions: 1 }) })}
      />
    );
    expect(count(container)).toBe("7 changes · 1 possible rename");
  });

  it("puts two of them in the plural", () => {
    const { container } = render(
      <ExportBar
        doc={doc({ totals: totals({ changes: 9, added: 4, changed: 3, renameSuggestions: 2 }) })}
      />
    );
    expect(count(container)).toBe("7 changes · 2 possible renames");
  });

  it("says how many tables of row data are going with it", () => {
    // The row data is the part of an export that can be large and the part a
    // reader may not have meant to send anywhere.
    const { container } = render(
      <ExportBar
        doc={doc({
          totals: totals({ changes: 2, added: 2 }),
          data: {
            timeoutMs: 5000,
            error: null,
            totals: {
              identical: 2,
              different: 0,
              sourceOnly: 0,
              targetOnly: 0,
              skipped: 0,
              rowsAtRiskOfDrop: 0,
              unreadDrops: 0,
            },
            tables: [dataTable("orders"), dataTable("customers")],
          },
        })}
      />
    );
    expect(count(container)).toBe("2 changes · 2 tables of row data");
  });

  it("names what the comparison never looked at", () => {
    // An export that is silent about this reads as a clean bill of health for
    // categories nobody compared.
    const { container } = render(
      <ExportBar
        doc={doc({
          totals: totals({ changes: 2, added: 2 }),
          notCompared: [
            { category: "Index", reason: "noMatchedTables" },
            { category: "Row security", reason: "snapshotPredatesCategory" },
          ],
        })}
      />
    );
    expect(count(container)).toBe("2 changes · index, row security not compared");
  });

  it("says nothing it has nothing to say about", () => {
    const { container } = render(
      <ExportBar doc={doc({ totals: totals({ changes: 2, added: 2 }) })} />
    );
    expect(count(container)).toBe("2 changes");
  });
});
