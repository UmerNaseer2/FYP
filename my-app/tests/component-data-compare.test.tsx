/** @jest-environment jsdom */

/**
 * The row-level half of a comparison — and the only screen in the app that
 * names what a sync DESTROYS.
 *
 * Everything else a comparison reports can be re-run, re-read or undone. Rows
 * in a table that exists only in the target cannot: the sync drops the table,
 * and no rollback script puts rows back. So the guarantee this panel owes its
 * reader is not that its numbers are pretty, it is that it never claims a
 * result nobody obtained. Three claims in here are false all-clears waiting to
 * happen, and each has a test below:
 *
 *  - "rows match" over a run where every table was new, so nothing was
 *    compared against anything at all.
 *  - "rows match" over tables the run never read, because it hit its cap or
 *    its timeout.
 *  - "identical" over a checksum that could only cover the columns both sides
 *    share, while the difference sits in a column only one of them has.
 *
 * And the banner has its own version of the same problem: a table dropped by a
 * sync that the run never reached has an unknown row count, which is not the
 * same as none. Counting only what was read is what let a schema of sixty-odd
 * tables push every drop past the cap and show no banner at all.
 *
 * What is NOT here:
 *  - summarizeDataCompare and describeSample, which have their own suites
 *    (tests/compare-data-summary, tests/compare-sample). This file checks that
 *    the panel puts their answers in front of the reader, and in the right
 *    words — a correct total in a sentence that misreads it is still wrong.
 *  - Which rows a scan reads, or how the checksum is built. That is
 *    lib/compare-data, and it needs a database.
 *  - Collapsing and expanding the groups, which is <details> doing what
 *    <details> does. The `open` attribute is asserted where a default matters;
 *    jsdom renders the contents either way, so there is no visibility to test
 *    and pretending otherwise would prove nothing.
 *  - The picker's KNOWN WART, documented on TablePicker: with several targets
 *    each panel draws its own copy and the last one touched is the one that
 *    submits. That is one form field shared by two forms, which is a page-level
 *    fact — a single panel is correct in isolation, and that is all this suite
 *    renders.
 */

import "@testing-library/jest-dom";
import { cleanup, render, screen, within } from "@testing-library/react";

import { DataCompare } from "@/components/studio/DataCompare";
import type { DataCompareReport, TableDataCompare } from "@/lib/compare-data-summary";
import type { RowSample } from "@/lib/compare-sample";

const aTable = (over: Partial<TableDataCompare> & { table: string }): TableDataCompare => ({
  status: "identical",
  leftRows: 10,
  rightRows: 10,
  leftChecksum: "abc",
  rightChecksum: "abc",
  columns: ["id", "name"],
  ignoredColumns: [],
  note: null,
  sample: null,
  droppedBySync: false,
  ...over,
});

const aReport = (tables: TableDataCompare[], over: Partial<DataCompareReport> = {}): DataCompareReport => ({
  tables,
  error: null,
  timeoutMs: 15000,
  ...over,
});

/** A table the sync drops, with rows in it. */
const dropped = (table: string, rows: number) =>
  aTable({ table, status: "targetOnly", leftRows: null, rightRows: rows, droppedBySync: true });

/** A table the sync drops that the run never reached. */
const unread = (table: string, note: string) =>
  aTable({
    table,
    status: "skipped",
    leftRows: null,
    rightRows: null,
    leftChecksum: null,
    rightChecksum: null,
    note,
    droppedBySync: true,
  });

const aSample = (over: Partial<RowSample> = {}): RowSample => ({
  status: "sampled",
  keyColumns: ["id"],
  rows: [],
  more: false,
  scanned: 2000,
  partial: false,
  note: null,
  ...over,
});

/** The headline pill, which is the one line most readers take away. */
const verdict = () => screen.getByText("Row data").closest("summary")!;

afterEach(() => cleanup());

describe("when there is nothing to report", () => {
  it("shows the failure instead of an empty report", () => {
    // Every per-table result is meaningless once the run failed, and an empty
    // report reads as "nothing differs".
    render(<DataCompare result={aReport([aTable({ table: "invoices" })], { error: "The target refused the connection." })} />);

    expect(screen.getByText("The target refused the connection.")).toBeInTheDocument();
    expect(screen.queryByText("Row data")).not.toBeInTheDocument();
  });

  it("says so when no table was compared", () => {
    render(<DataCompare result={aReport([])} />);

    expect(screen.getByText("There are no tables to compare.")).toBeInTheDocument();
  });
});

describe("the rows a sync destroys", () => {
  it("counts them, and says nothing can put them back", () => {
    render(
      <DataCompare
        result={aReport([aTable({ table: "invoices" }), dropped("audit_log", 1204)])}
        allowDataLoss
      />
    );

    expect(screen.getByText("1,204 rows would be destroyed")).toBeInTheDocument();
    expect(screen.getByText(/1 table exists only in the target/)).toHaveTextContent(
      "Nothing in this app can put them back afterwards."
    );
  });

  it("does not say destroyed over a script that drops nothing", () => {
    // "Allow data loss" off means the DROP TABLEs in the script beside this
    // panel are commented out. A banner promising destruction over a script
    // that destroys nothing contradicts the diff card two inches above it.
    render(
      <DataCompare
        result={aReport([dropped("audit_log", 1204)])}
        allowDataLoss={false}
      />
    );

    expect(screen.getByText("1,204 rows sit in tables a sync drops")).toBeInTheDocument();
    expect(screen.getByText(/1 table exists only in the target/)).toHaveTextContent(
      "“Allow data loss” is off, so the script below has those drops commented out"
    );
  });

  it("claims nothing about a script when there is no script", () => {
    render(<DataCompare result={aReport([dropped("audit_log", 12)])} />);

    expect(screen.getByText(/1 table exists only in the target/)).toHaveTextContent(
      "No script is rendered here, so nothing on this page runs that drop — but nothing could put the rows back either."
    );
  });

  it("warns about a dropped table the run never read", () => {
    // The whole point. Keying the banner on the row count alone is what let a
    // large schema push every drop past the cap and show no banner at all —
    // a table dropped unread is dropped exactly the same.
    render(
      <DataCompare
        result={aReport([unread("audit_log", "Not read: the table cap was reached.")])}
        allowDataLoss
      />
    );

    expect(screen.getByText("1 table is dropped by a sync — row count unknown")).toBeInTheDocument();
  });

  it("keeps an unknown count out of the total, and says how many are missing", () => {
    // "1,204 rows" is what WAS read. Adding a guess for the unread ones would
    // be a number nothing produced; saying nothing would let 1,204 read as the
    // whole cost.
    render(
      <DataCompare
        result={aReport([dropped("audit_log", 1204), unread("events", "Not read."), unread("jobs", "Not read.")])}
        allowDataLoss
      />
    );

    expect(screen.getByText("1,204 rows would be destroyed")).toBeInTheDocument();
    expect(screen.getByText(/3 tables exist only in the target/)).toHaveTextContent(
      "2 of them were not read, so their rows are not in the figure above."
    );
  });

  it("stays quiet when a sync drops nothing", () => {
    render(<DataCompare result={aReport([aTable({ table: "invoices" })])} allowDataLoss />);

    expect(screen.queryByText(/would be destroyed/)).not.toBeInTheDocument();
    expect(screen.queryByText(/sit in tables a sync drops/)).not.toBeInTheDocument();
  });
});

describe("the one-line verdict", () => {
  it("leads with the tables that differ", () => {
    render(
      <DataCompare
        result={aReport([
          aTable({ table: "invoices", status: "different", rightRows: 11, leftChecksum: "a", rightChecksum: "b" }),
          dropped("audit_log", 3),
        ])}
      />
    );

    expect(within(verdict()).getByText(/tables differ/)).toHaveTextContent("2 tables differ");
  });

  it("will not call a run clean when part of it was never read", () => {
    // A skipped table timed out or had no column both sides could be hashed
    // on. "rows match" over it claims a result nobody obtained.
    render(
      <DataCompare
        result={aReport([aTable({ table: "invoices" }), aTable({ table: "events", status: "skipped", note: "Timed out." })])}
      />
    );

    expect(within(verdict()).getByText(/not read/)).toHaveTextContent("1 of 2 tables not read");
    expect(within(verdict()).queryByText(/rows match/)).not.toBeInTheDocument();
  });

  it("will not call a first run clean when every table is new", () => {
    // A populated source against an empty target is this tool's most common
    // first run. Not one row was compared against anything.
    render(
      <DataCompare
        result={aReport([
          aTable({ table: "invoices", status: "sourceOnly", rightRows: null }),
          aTable({ table: "customers", status: "sourceOnly", rightRows: null }),
        ])}
      />
    );

    expect(within(verdict()).getByText("nothing to compare — every table is new")).toBeInTheDocument();
  });

  it("says how far a match went when some tables were never compared", () => {
    render(
      <DataCompare
        result={aReport([
          aTable({ table: "invoices" }),
          aTable({ table: "customers", status: "sourceOnly", rightRows: null }),
        ])}
      />
    );

    expect(verdict()).toHaveTextContent("rows match in 1 shared table");
  });

  it("says a match covers only the columns both sides have", () => {
    // The checksum can only hash shared columns, so a table whose every
    // difference lives in an unpaired column arrives here as a clean match.
    render(
      <DataCompare
        result={aReport([aTable({ table: "invoices", ignoredColumns: ["archived_at"] })])}
      />
    );

    expect(verdict()).toHaveTextContent("rows match, on the columns both sides have");
  });

  it("says plain 'rows match' when there is nothing to qualify", () => {
    render(<DataCompare result={aReport([aTable({ table: "invoices" })])} />);

    // The pill itself, not the line it sits on: a qualifier that slipped into
    // the wrong element would still be read as part of the verdict.
    expect(within(verdict()).getByText("rows match")).toHaveTextContent(/^rows match$/);
  });
});

describe("what each table's line says", () => {
  it("prints one count when both sides agree", () => {
    render(<DataCompare result={aReport([aTable({ table: "invoices", leftRows: 1204, rightRows: 1204 })])} />);

    expect(screen.getByText("1,204 rows")).toBeInTheDocument();
  });

  it("prints both counts when they do not", () => {
    render(
      <DataCompare
        result={aReport([
          aTable({ table: "invoices", status: "different", leftRows: 1204, rightRows: 1198, rightChecksum: "b" }),
        ])}
      />
    );

    expect(screen.getByText("1,204 → 1,198 rows")).toBeInTheDocument();
  });

  it("spells out the same count with different contents", () => {
    // The interesting case, and the one that reads as a contradiction unless
    // the line says so: the same number of rows holding different values.
    render(
      <DataCompare
        result={aReport([
          aTable({ table: "invoices", status: "different", leftRows: 1204, rightRows: 1204, rightChecksum: "b" }),
        ])}
      />
    );

    expect(screen.getByText("1,204 rows, but the contents differ")).toBeInTheDocument();
  });

  it("names the side a count came from when only one side has the table", () => {
    render(
      <DataCompare
        result={aReport([
          aTable({ table: "invoices", status: "sourceOnly", leftRows: 7, rightRows: null }),
          dropped("audit_log", 1),
        ])}
      />
    );

    expect(screen.getByText("7 rows in the source")).toBeInTheDocument();
    expect(screen.getByText("1 row in the target")).toBeInTheDocument();
  });

  it("shows an unknown count as a dash, not as zero", () => {
    render(
      <DataCompare
        result={aReport([aTable({ table: "events", status: "targetOnly", leftRows: null, rightRows: null })])}
      />
    );

    expect(screen.getByText("— rows in the target")).toBeInTheDocument();
  });

  it("bounds an identical verdict by the columns that were read", () => {
    render(
      <DataCompare
        result={aReport([
          aTable({
            table: "invoices",
            columns: ["id", "total"],
            ignoredColumns: ["archived_at"],
            note: "archived_at exists only in the target and was not hashed.",
          }),
        ])}
      />
    );

    expect(screen.getByText("10 rows, identical on 2 shared columns")).toBeInTheDocument();
    expect(screen.getByText("archived_at exists only in the target and was not hashed.")).toBeInTheDocument();
  });

  it("qualifies the collapsed group on its own header", () => {
    // The group is shut by default, so a reader who never opens it sees only
    // this line — an unqualified claim here is the whole false all-clear.
    render(
      <DataCompare
        result={aReport([
          aTable({ table: "invoices", ignoredColumns: ["archived_at"] }),
          aTable({ table: "customers" }),
        ])}
      />
    );

    const group = screen.getByText(/hold identical rows/).closest("details")!;
    expect(group).not.toHaveAttribute("open");
    expect(group).toHaveTextContent("2 tables hold identical rows (1 of them on the shared columns only)");
  });

  it("groups each table under what is to be done about it", () => {
    render(
      <DataCompare
        result={aReport([
          aTable({ table: "invoices", status: "different", rightChecksum: "b" }),
          dropped("audit_log", 4),
          aTable({ table: "customers", status: "sourceOnly", rightRows: null }),
          aTable({ table: "events", status: "skipped", note: "Timed out." }),
        ])}
      />
    );

    const group = (title: string) => screen.getByText(title).closest(".obj-group") as HTMLElement;
    expect(within(group("Contents differ")).getByText("invoices")).toBeInTheDocument();
    expect(within(group("Only in the target")).getByText("audit_log")).toBeInTheDocument();
    expect(group("Only in the target")).toHaveTextContent("dropped by a full sync");
    expect(within(group("Only in the source")).getByText("customers")).toBeInTheDocument();
    expect(group("Only in the source")).toHaveTextContent("the migration copies structure, never rows");
    expect(within(group("Not compared")).getByText("Timed out.")).toBeInTheDocument();
  });
});

describe("the rows that differ", () => {
  const differing = (sample: RowSample) =>
    aReport([aTable({ table: "invoices", status: "different", rightChecksum: "b", sample })]);

  it("names what the rows were paired by", () => {
    render(
      <DataCompare
        result={differing(
          aSample({
            keyColumns: ["tenant_id", "id"],
            rows: [{ key: ["7", "12"], kind: "changed", differences: [{ column: "total", left: "10.00", right: "12.00" }] }],
          })
        )}
      />
    );

    expect(screen.getByText(/paired by/)).toHaveTextContent("1 row shown, paired by tenant_id, id");
    expect(screen.getByText("7, 12")).toBeInTheDocument();
    expect(screen.getByText("total")).toBeInTheDocument();
  });

  it("says which side a row is missing from", () => {
    render(
      <DataCompare
        result={differing(
          aSample({
            rows: [
              { key: ["1"], kind: "sourceOnly", differences: [] },
              { key: ["2"], kind: "targetOnly", differences: [] },
            ],
          })
        )}
      />
    );

    expect(screen.getByText("only in the source")).toBeInTheDocument();
    expect(screen.getByText("only in the target")).toBeInTheDocument();
  });

  it("distinguishes a NULL from an empty value", () => {
    // Two different things: one is "no value", the other is a value that
    // happens to be empty. An empty cell would show them identically.
    render(
      <DataCompare
        result={differing(
          aSample({
            rows: [{ key: ["1"], kind: "changed", differences: [{ column: "note", left: null, right: "" }] }],
          })
        )}
      />
    );

    expect(screen.getByTitle("SQL NULL")).toHaveTextContent("NULL");
  });

  it("cuts a long value but keeps the whole of it on hover", () => {
    const long = "x".repeat(80);
    render(
      <DataCompare
        result={differing(
          aSample({
            rows: [{ key: ["1"], kind: "changed", differences: [{ column: "blob", left: long, right: "y" }] }],
          })
        )}
      />
    );

    expect(screen.getByTitle(long)).toHaveTextContent(`${"x".repeat(60)}…`);
    // The short one is not cut, so it carries no title to recover.
    expect(screen.getByText("y")).not.toHaveAttribute("title");
  });

  it("says when a difference was found but its values could not be read", () => {
    render(
      <DataCompare
        result={differing(aSample({ rows: [{ key: ["1"], kind: "changed", differences: [] }] }))}
      />
    );

    expect(screen.getByText("differs — the values could not be read back")).toBeInTheDocument();
  });

  it("never lets a silent absence read as 'no rows differ'", () => {
    // The table is in this group BECAUSE its rows differ. An empty sample with
    // no explanation says the opposite of the line above it.
    render(
      <DataCompare
        result={differing(aSample({ status: "no-key", keyColumns: [], rows: [] }))}
      />
    );

    expect(screen.getByText(/cannot be paired up/)).toBeInTheDocument();
  });

  it("says when the difference lies past the part that was read", () => {
    render(
      <DataCompare result={differing(aSample({ rows: [], partial: true }))} />
    );

    expect(screen.getByText(/past the first 2,000 rows/)).toBeInTheDocument();
  });

  it("draws nothing at all when there is nothing to say", () => {
    const { container } = render(<DataCompare result={differing(aSample())} />);

    expect(container.querySelector(".sample-rows")).toBeNull();
  });
});

describe("choosing which tables the next run reads", () => {
  const twoTables = aReport([aTable({ table: "invoices" }), aTable({ table: "customers" })]);

  it("is left out where there is no form to submit through", () => {
    // Controls that cannot do anything are worse than no controls.
    render(<DataCompare result={twoTables} />);

    expect(screen.queryByText(/Reading every table/)).not.toBeInTheDocument();
  });

  it("submits through the options bar's own form, as a plain GET field", () => {
    render(<DataCompare result={twoTables} formId="compare-form" dataTables={[]} />);

    const box = screen.getByRole("checkbox", { name: "invoices" });
    expect(box).toHaveAttribute("form", "compare-form");
    expect(box).toHaveAttribute("name", "dataTable");
    expect(box).toHaveAttribute("value", "invoices");
    expect(screen.getByRole("button", { name: "Compare again" })).toHaveAttribute("form", "compare-form");
  });

  it("reopens the selection that produced the report", () => {
    // The selection lives in the URL, so a reload or a shared link has to come
    // back to the same ticks — not to a blank picker over a narrowed report.
    render(<DataCompare result={twoTables} formId="compare-form" dataTables={["customers"]} />);

    expect(screen.getByRole("checkbox", { name: "invoices" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "customers" })).toBeChecked();
    expect(screen.getByText("Reading 1 of 2 tables")).toBeInTheDocument();
    // Opened, because a narrowed run is a state worth seeing without a click.
    expect(screen.getByText("Reading 1 of 2 tables").closest("details")).toHaveAttribute("open");
  });

  it("says how to get back to reading everything", () => {
    // After narrowing to one table, clearing the ticks is the only route back
    // to the rest, and nothing else on the page says so.
    render(<DataCompare result={twoTables} formId="compare-form" dataTables={[]} />);

    expect(screen.getByText("Reading every table")).toBeInTheDocument();
    expect(screen.getByText(/Tick nothing/)).toHaveTextContent(
      "Tick nothing to read every table again. A selection only changes which tables are READ — the rest are still listed below, as not read."
    );
  });
});

describe("what the footer admits to", () => {
  it("states the timeout the run actually used", () => {
    render(<DataCompare result={aReport([aTable({ table: "invoices" })], { timeoutMs: 30000 })} />);

    expect(screen.getByText(/Rows are compared by checksum/)).toHaveTextContent("capped at 30s each");
  });

  it("warns that two servers can render the same value differently", () => {
    render(<DataCompare result={aReport([aTable({ table: "invoices" })])} />);

    expect(screen.getByText(/Values are hashed as text/)).toHaveTextContent(
      "will read as different even when the data matches. Row counts are exact either way."
    );
  });
});
