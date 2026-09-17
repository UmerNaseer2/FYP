// compare-data: what a row comparison is allowed to call "identical".
//
// The checksum can only hash the columns both tables have. That is not a bug —
// there is nothing on the other side to hash a lone column against — but it
// bounds the verdict, and the bound has to travel with it. A table whose every
// difference lives in a column only one side has produces the same hash on both
// sides and comes back "identical", which is true of the columns that were read
// and says nothing at all about the ones that were not.
//
// These tests pin the wording and the counts that carry that bound, because a
// reader who takes "rows match" at face value over a partial compare is exactly
// the person this report exists to protect.
import { compareRowData, summarizeDataCompare } from "@/lib/compare-data";
import type { DataCompareReport, TableDataCompare } from "@/lib/compare-data-summary";
import type { CompareReport } from "@/lib/compare";
import { createFakeClient, type FakeClient, type FakeStep } from "./helpers/fake-pg";

// One fake connection per side, handed out by a fake pool. compareRowData opens
// exactly one connection per side and holds it for the whole run.
const pools: { left: FakeClient; right: FakeClient } = {
  left: createFakeClient([]),
  right: createFakeClient([]),
};

jest.mock("../lib/postgres", () => ({
  getPoolForConfig: (config: { database?: string }) => ({
    connect: async () =>
      config.database === "source" ? mockPools.left : mockPools.right,
  }),
}));

// The factory above runs before the module body, so it cannot close over
// `pools` directly — a `mock`-prefixed alias is the escape hatch jest allows.
const mockPools = pools;

/** A column as the comparison report describes it. Only the name is read here. */
function col(name: string) {
  return { name };
}

/**
 * A report with one matched table: `shared` columns on both sides, `onlyA` on
 * the source alone and `onlyB` on the target alone.
 *
 * Cast at the boundary because a real CompareReport carries a great deal more
 * than the four fields planTables reads, and spelling all of it out would hide
 * which parts the test is actually about.
 */
function reportWithOneMatch(options: {
  shared: string[];
  onlyA?: string[];
  onlyB?: string[];
}): CompareReport {
  return {
    left: { tables: [] },
    right: { tables: [] },
    tablesOnlyInA: [],
    tablesOnlyInB: [],
    matchedTables: [
      {
        left: { name: "orders" },
        right: { name: "orders" },
        columnMatches: options.shared.map((name) => ({
          left: col(name),
          right: col(name),
        })),
        columnsOnlyInA: (options.onlyA ?? []).map(col),
        columnsOnlyInB: (options.onlyB ?? []).map(col),
      },
    ],
  } as unknown as CompareReport;
}

/** Run a comparison against two fake connections answering the given steps. */
async function run(
  report: CompareReport,
  leftSteps: FakeStep[],
  rightSteps: FakeStep[],
): Promise<DataCompareReport> {
  pools.left = createFakeClient(leftSteps);
  pools.right = createFakeClient(rightSteps);
  return compareRowData(
    report,
    { config: { database: "source" }, schema: "public" },
    { config: { database: "target" }, schema: "public" },
  );
}

/** The one checksum answer a side gives back. */
function checksum(rows: number, hash: string): FakeStep[] {
  return [
    {
      match: /md5\(coalesce\(string_agg/,
      rows: [{ row_count: String(rows), checksum: hash }],
    },
  ];
}

describe("a compare that could only read some of the columns", () => {
  it("says what the verdict covers instead of a bare identical", async () => {
    // The hashes agree because the columns that were hashed agree. The target's
    // extra `archived_at` was never in the hash, so nothing here rules out
    // every row differing in it.
    const result = await run(
      reportWithOneMatch({ shared: ["id", "total"], onlyB: ["archived_at"] }),
      checksum(3, "abc"),
      checksum(3, "abc"),
    );

    const table = result.tables[0];
    expect(table.status).toBe("identical");
    expect(table.ignoredColumns).toEqual(["archived_at"]);
    expect(table.note).toBe(
      "Identical on the 2 columns both sides share. " +
        "Not compared (present on one side only): archived_at."
    );
  });

  it("names every unpaired column, from either side, in one list", async () => {
    const result = await run(
      reportWithOneMatch({
        shared: ["id"],
        onlyA: ["draft_note"],
        onlyB: ["archived_at", "legacy_ref"],
      }),
      checksum(1, "abc"),
      checksum(1, "abc"),
    );

    const table = result.tables[0];
    // Sorted, so the sentence reads the same on every run rather than in
    // whatever order the two column lists happened to arrive in.
    expect(table.ignoredColumns).toEqual(["archived_at", "draft_note", "legacy_ref"]);
    expect(table.note).toContain(
      "Not compared (present on one side only): archived_at, draft_note, legacy_ref."
    );
    // Singular, because exactly one column was actually compared.
    expect(table.note).toContain("Identical on the 1 column both sides share.");
  });

  it("keeps the plain wording when every column paired up", async () => {
    // The whole table was hashed, so "identical" needs no qualification and
    // adding one would train the reader to ignore it.
    const result = await run(
      reportWithOneMatch({ shared: ["id", "total"] }),
      checksum(3, "abc"),
      checksum(3, "abc"),
    );

    expect(result.tables[0].status).toBe("identical");
    expect(result.tables[0].ignoredColumns).toEqual([]);
    expect(result.tables[0].note).toBeNull();
  });

  it("still reports a real difference as a caveat, not as the verdict", async () => {
    // Here the shared columns genuinely disagree. The unpaired column is a
    // footnote to a difference that was found, not the reason one was missed,
    // so the sentence must not claim anything was identical.
    const result = await run(
      reportWithOneMatch({ shared: ["id", "total"], onlyB: ["archived_at"] }),
      checksum(3, "abc"),
      checksum(3, "zzz"),
    );

    const table = result.tables[0];
    expect(table.status).toBe("different");
    expect(table.note).toBe(
      "Not included in the checksum (present on one side only): archived_at."
    );
    expect(table.note).not.toContain("Identical");
  });

  it("carries the unpaired columns onto a table it could not read", async () => {
    // A failed read is still a partial compare that never happened. Reporting
    // an empty list here would say the columns all paired up, which is a claim
    // this run is in no position to make.
    const result = await run(
      reportWithOneMatch({ shared: ["id"], onlyB: ["archived_at"] }),
      [{ match: /md5\(coalesce/, error: { code: "57014", message: "canceling statement" } }],
      checksum(1, "abc"),
    );

    expect(result.tables[0].status).toBe("skipped");
    expect(result.tables[0].ignoredColumns).toEqual(["archived_at"]);
  });
});

describe("summarizeDataCompare", () => {
  /** A finished table result, with only the fields the summary reads set. */
  function table(over: Partial<TableDataCompare>): TableDataCompare {
    return {
      table: "t",
      status: "identical",
      leftRows: 1,
      rightRows: 1,
      leftChecksum: "a",
      rightChecksum: "a",
      columns: ["id"],
      ignoredColumns: [],
      note: null,
      droppedBySync: false,
      ...over,
    };
  }

  it("counts the partial matches apart from the clean ones", () => {
    // Both are identical — the count exists so the headline can say that one of
    // them was only compared on part of its columns without demoting it to
    // "different", which would be the opposite lie.
    const totals = summarizeDataCompare({
      tables: [
        table({ table: "clean" }),
        table({ table: "partial", ignoredColumns: ["archived_at"] }),
      ],
      error: null,
      timeoutMs: 5000,
    });

    expect(totals.identical).toBe(2);
    expect(totals.identicalOnSharedColumns).toBe(1);
    expect(totals.different).toBe(0);
  });

  it("does not count unpaired columns on tables that were not identical", () => {
    // A different table's unpaired columns say nothing about a match, and a
    // skipped one was never compared at all. Counting either would put a
    // qualifier on a headline that has no match to qualify.
    const totals = summarizeDataCompare({
      tables: [
        table({ table: "differs", status: "different", ignoredColumns: ["x"] }),
        table({ table: "unread", status: "skipped", ignoredColumns: ["y"] }),
      ],
      error: null,
      timeoutMs: 5000,
    });

    expect(totals.identicalOnSharedColumns).toBe(0);
    expect(totals.different).toBe(1);
    expect(totals.skipped).toBe(1);
  });

  it("stays at zero when every table was compared in full", () => {
    const totals = summarizeDataCompare({
      tables: [table({ table: "a" }), table({ table: "b" })],
      error: null,
      timeoutMs: 5000,
    });

    expect(totals.identical).toBe(2);
    expect(totals.identicalOnSharedColumns).toBe(0);
  });
});
