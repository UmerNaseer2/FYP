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

/** A column as the comparison report describes it. */
function col(name: string) {
  // nullable is read when the sampler looks for a key it can pair rows by; the
  // name is all the checksum itself needs.
  return { name, nullable: false };
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
  /** The source's primary key, or null for a table the sampler cannot pair. */
  primaryKey?: string[] | null;
}): CompareReport {
  const columns = [...options.shared, ...(options.onlyA ?? [])].map(col);
  const primaryKey =
    options.primaryKey === undefined
      ? { columns: [options.shared[0] ?? "id"] }
      : options.primaryKey === null
        ? null
        : { columns: options.primaryKey };
  return {
    left: { tables: [] },
    right: { tables: [] },
    tablesOnlyInA: [],
    tablesOnlyInB: [],
    matchedTables: [
      {
        // The key fields belong to the SOURCE side: that is the snapshot the
        // sampler picks a key from, and the target's names are derived from
        // the column matches below.
        left: { name: "orders", primaryKey, uniqueConstraints: [], columns },
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
  options: Parameters<typeof compareRowData>[3] = {},
): Promise<DataCompareReport> {
  pools.left = createFakeClient(leftSteps);
  pools.right = createFakeClient(rightSteps);
  return compareRowData(
    report,
    { config: { database: "source" }, schema: "public" },
    { config: { database: "target" }, schema: "public" },
    options,
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
      sample: null,
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

/**
 * Which rows differ (spec 04 — sample mismatched rows).
 *
 * The verdict above is one bit: the checksums disagree. These tests are about
 * the part that names the rows behind it, and about the two things it must
 * never do — claim more than it read, or go quiet when it read nothing.
 *
 * The digest read is the one projecting `AS digest`; the follow-up that fetches
 * a changed row's values projects `AS c0`. Matching on those keeps the fakes
 * independent of the rest of the generated SQL.
 */
describe("which rows differ", () => {
  const digest = (rows: Record<string, string>[]): FakeStep => ({
    match: /AS digest/,
    rows,
  });
  const values = (rows: Record<string, string>[]): FakeStep => ({
    match: /AS c0/,
    rows,
  });

  it("names a row only one side has, and which side", async () => {
    const result = await run(
      reportWithOneMatch({ shared: ["id", "total"] }),
      [...checksum(2, "abc"), digest([{ k0: "1", digest: "a" }, { k0: "2", digest: "b" }])],
      [...checksum(2, "zzz"), digest([{ k0: "1", digest: "a" }, { k0: "3", digest: "c" }])],
    );

    const sample = result.tables[0].sample;
    expect(sample?.status).toBe("sampled");
    expect(sample?.keyColumns).toEqual(["id"]);
    // Row 1 is on both sides with the same digest, so it is not listed at all.
    expect(sample?.rows).toEqual([
      { key: ["2"], kind: "sourceOnly", differences: [] },
      { key: ["3"], kind: "targetOnly", differences: [] },
    ]);
  });

  it("names the columns that differ on a row both sides have", async () => {
    // Only a row present on both sides has two versions to put side by side,
    // so this is the only case that costs a second read.
    const result = await run(
      reportWithOneMatch({ shared: ["id", "total"] }),
      [
        ...checksum(1, "abc"),
        digest([{ k0: "1", digest: "a" }]),
        values([{ k0: "1", c0: "1", c1: "10" }]),
      ],
      [
        ...checksum(1, "zzz"),
        digest([{ k0: "1", digest: "z" }]),
        values([{ k0: "1", c0: "1", c1: "99" }]),
      ],
    );

    expect(result.tables[0].sample?.rows).toEqual([
      {
        key: ["1"],
        kind: "changed",
        // `id` is in the projection too and agrees, so it is not listed. Only
        // what actually differs belongs in a list headed "what differs".
        differences: [{ column: "total", left: "10", right: "99" }],
      },
    ]);
  });

  it("reports a renamed column under the source's name", async () => {
    // Both sides project their paired columns as c0..cN in the same order, so
    // the target's `client_id` comes back as the source's `customer_id`.
    // Reading the target's row by the source's name would find nothing and
    // report every renamed column as a difference.
    const report = reportWithOneMatch({ shared: ["id"] }) as unknown as {
      matchedTables: {
        left: { columns: { name: string; nullable: boolean }[] };
        columnMatches: { left: { name: string }; right: { name: string } }[];
      }[];
    };
    report.matchedTables[0].left.columns.push({ name: "customer_id", nullable: false });
    report.matchedTables[0].columnMatches.push({
      left: { name: "customer_id" },
      right: { name: "client_id" },
    });

    // Both sides project their paired columns sorted by the SOURCE's name — the
    // checksum hashes a positional ROW(), so any other order would hash the
    // same data differently on the two sides. customer_id therefore comes back
    // as c0 and id as c1, on both.
    const result = await run(
      report as unknown as CompareReport,
      [
        ...checksum(1, "abc"),
        digest([{ k0: "1", digest: "a" }]),
        values([{ k0: "1", c0: "7", c1: "1" }]),
      ],
      [
        ...checksum(1, "zzz"),
        digest([{ k0: "1", digest: "z" }]),
        values([{ k0: "1", c0: "8", c1: "1" }]),
      ],
    );

    expect(result.tables[0].sample?.rows[0].differences).toEqual([
      { column: "customer_id", left: "7", right: "8" },
    ]);
  });

  it("says a table's rows cannot be paired instead of going quiet", async () => {
    // No primary key and no non-null unique constraint means there is nothing
    // to match a row against on the other side. The table still differs, so
    // showing nothing at all would read as "no rows differ".
    const result = await run(
      reportWithOneMatch({ shared: ["id", "total"], primaryKey: null }),
      checksum(1, "abc"),
      checksum(1, "zzz"),
    );

    expect(result.tables[0].status).toBe("different");
    expect(result.tables[0].sample?.status).toBe("no-key");
  });

  it("says so when the rows could not be read", async () => {
    // The verdict's own reads succeeded — the table IS different — and only
    // the follow-up timed out. Losing that distinction would turn a table with
    // a known difference into one that was never compared.
    const result = await run(
      reportWithOneMatch({ shared: ["id", "total"] }),
      [
        ...checksum(1, "abc"),
        { match: /AS digest/, error: { code: "57014", message: "canceling statement" } },
      ],
      [...checksum(1, "zzz"), digest([{ k0: "1", digest: "z" }])],
    );

    expect(result.tables[0].status).toBe("different");
    expect(result.tables[0].sample?.status).toBe("unavailable");
    expect(result.tables[0].sample?.note).toContain("source:");
  });

  it("does not look at a table whose rows already match", async () => {
    // Two more full reads to produce an empty list is the one case where the
    // cost buys nothing at all.
    const result = await run(
      reportWithOneMatch({ shared: ["id", "total"] }),
      checksum(1, "abc"),
      checksum(1, "abc"),
    );

    expect(result.tables[0].status).toBe("identical");
    expect(result.tables[0].sample).toBeNull();
  });

  it("can be turned off without turning off the verdict", async () => {
    const result = await run(
      reportWithOneMatch({ shared: ["id", "total"] }),
      checksum(1, "abc"),
      checksum(1, "zzz"),
      { sample: false },
    );

    expect(result.tables[0].status).toBe("different");
    expect(result.tables[0].sample).toBeNull();
  });
});

/**
 * "Compare all OR SELECTED table data" (spec 04).
 *
 * The selection narrows what is READ. What the report COVERS does not change,
 * because a report that listed only the tables it read would shrink the screen's
 * picker to those tables and leave no way back to the rest.
 */
describe("a compare limited to some tables", () => {
  /** Two matched tables, both with an `id` primary key. */
  function twoTables(): CompareReport {
    return {
      left: { tables: [] },
      right: { tables: [] },
      tablesOnlyInA: [],
      tablesOnlyInB: [],
      matchedTables: ["orders", "customers"].map((name) => ({
        left: {
          name,
          primaryKey: { columns: ["id"] },
          uniqueConstraints: [],
          columns: [col("id")],
        },
        right: { name },
        columnMatches: [{ left: col("id"), right: col("id") }],
        columnsOnlyInA: [],
        columnsOnlyInB: [],
      })),
    } as unknown as CompareReport;
  }

  it("reads the selected table and reports the other as not read", async () => {
    const result = await run(
      twoTables(),
      [...checksum(1, "abc"), digestless()],
      [...checksum(1, "zzz"), digestless()],
      { only: ["customers"] },
    );

    expect(result.tables.map((table) => [table.table, table.status])).toEqual([
      ["orders", "skipped"],
      ["customers", "different"],
    ]);
    expect(result.tables[0].note).toContain("not one of the selected tables");
  });

  it("falls back to every table when the selection matches nothing", async () => {
    // The screen sent names this comparison does not have — a schema that
    // changed under a saved set, most likely. Reporting "no tables to compare"
    // for a schema that plainly has some reads as a broken page rather than as
    // a stale selection.
    const result = await run(
      twoTables(),
      [...checksum(1, "abc"), digestless()],
      [...checksum(1, "abc"), digestless()],
      { only: ["invoices"] },
    );

    expect(result.tables.map((table) => table.status)).toEqual([
      "identical",
      "identical",
    ]);
  });

  it("does not count the tables it skipped against the per-run cap", async () => {
    // The reason to select a table is usually that it sits past the cap. A cap
    // that counted the skipped ones would put it right back out of reach.
    const result = await run(
      twoTables(),
      [...checksum(1, "abc"), digestless()],
      [...checksum(1, "zzz"), digestless()],
      { only: ["customers"], maxTables: 1 },
    );

    expect(result.tables[1].status).toBe("different");
  });
});

/** A digest read that comes back empty — enough to satisfy a sampled table. */
function digestless(): FakeStep {
  return { match: /AS digest/, rows: [] };
}
