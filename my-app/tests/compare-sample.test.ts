import {
  describeSample,
  differingColumns,
  findMismatchedRows,
  pickSampleKey,
  SAMPLE_ROW_LIMIT,
  SAMPLE_SCAN_ROWS,
  type RowSample,
} from "@/lib/compare-sample";

/**
 * The rules behind "which rows differ" (spec 04 — sample mismatched rows).
 *
 * Everything here is pure, so it is tested directly rather than through a fake
 * database. What the SQL does with these answers — the bounded scan, the byte
 * ordering both sides agree on — lives in compare-data and is exercised by
 * compare-data.test.ts.
 */

type PickTable = Parameters<typeof pickSampleKey>[0];

function table(over: Partial<PickTable> = {}): PickTable {
  return {
    primaryKey: { columns: ["id"] },
    uniqueConstraints: [],
    columns: [
      { name: "id", nullable: false },
      { name: "email", nullable: false },
      { name: "nickname", nullable: true },
      { name: "total", nullable: false },
    ],
    ...over,
  };
}

const ALL = new Set(["id", "email", "nickname", "total"]);

describe("pickSampleKey", () => {
  it("takes the primary key first", () => {
    expect(pickSampleKey(table(), ALL)).toEqual(["id"]);
  });

  it("takes a composite primary key whole", () => {
    expect(
      pickSampleKey(
        table({
          primaryKey: { columns: ["tenant", "id"] },
          columns: [
            { name: "tenant", nullable: false },
            { name: "id", nullable: false },
          ],
        }),
        new Set(["tenant", "id"]),
      ),
    ).toEqual(["tenant", "id"]);
  });

  it("keeps a primary key whose snapshot forgot to mark it NOT NULL", () => {
    // A primary key's columns are NOT NULL by definition. Checking them against
    // the per-column flag would let a snapshot taken by an older build throw
    // away the one key that is always correct, and fall through to "this table
    // cannot be sampled" on a table with a perfectly good id.
    const pk = table({ columns: [{ name: "id", nullable: true }] });
    expect(pickSampleKey(pk, new Set(["id"]))).toEqual(["id"]);
  });

  it("falls back to a unique constraint when there is no primary key", () => {
    expect(
      pickSampleKey(
        table({ primaryKey: null, uniqueConstraints: [{ columns: ["email"] }] }),
        ALL,
      ),
    ).toEqual(["email"]);
  });

  it("refuses a unique constraint over a nullable column", () => {
    // PostgreSQL lets a UNIQUE column hold NULL, and lets MORE THAN ONE row
    // hold it, because NULL is not equal to itself. Pairing rows on such a
    // column would report a row that is sitting right there as missing from
    // the other side.
    expect(
      pickSampleKey(
        table({
          primaryKey: null,
          uniqueConstraints: [{ columns: ["nickname" ] }, { columns: ["email"] }],
        }),
        ALL,
      ),
    ).toEqual(["email"]);
  });

  it("refuses a key whose column only one side has", () => {
    // `shared` is the columns the comparison actually matched up. A key column
    // missing from the target cannot find anything there, so the table has a
    // key but this comparison does not.
    expect(pickSampleKey(table(), new Set(["email", "total"]))).toEqual(null);
  });

  it("returns null when nothing qualifies", () => {
    expect(
      pickSampleKey(table({ primaryKey: null, uniqueConstraints: [] }), ALL),
    ).toEqual(null);
    // An empty column list is not a key either — it would pair every row with
    // every other one.
    expect(
      pickSampleKey(
        table({ primaryKey: { columns: [] }, uniqueConstraints: [{ columns: [] }] }),
        ALL,
      ),
    ).toEqual(null);
  });

  it("does not hand back the table's own array", () => {
    // The caller stores the result on a plan and maps it to the target's
    // names; mutating it must not reach back into the snapshot.
    const snapshot = table();
    const key = pickSampleKey(snapshot, ALL);
    key?.push("email");
    expect(snapshot.primaryKey?.columns).toEqual(["id"]);
  });
});

describe("findMismatchedRows", () => {
  const row = (key: string, digest: string) => ({ key: [key], digest });

  it("finds nothing when both sides agree", () => {
    const side = [row("1", "a"), row("2", "b")];
    expect(findMismatchedRows(side, side, 10)).toEqual({ rows: [], more: false });
  });

  it("names a row only one side has, on each side", () => {
    const found = findMismatchedRows(
      [row("1", "a"), row("2", "b")],
      [row("2", "b"), row("3", "c")],
      10,
    );
    expect(found.rows).toEqual([
      { key: ["1"], kind: "sourceOnly" },
      { key: ["3"], kind: "targetOnly" },
    ]);
  });

  it("names a row both sides have whose contents disagree", () => {
    const found = findMismatchedRows([row("1", "a")], [row("1", "z")], 10);
    expect(found.rows).toEqual([{ key: ["1"], kind: "changed" }]);
  });

  it("does not rely on the two sides arriving in the same order", () => {
    // Text sort order is a per-database collation setting, and two servers
    // routinely disagree about it. A merge-walk would report every row here as
    // one-sided; pairing by lookup does not.
    const left = [row("1", "a"), row("2", "b"), row("3", "c")];
    const right = [row("3", "c"), row("1", "a"), row("2", "b")];
    expect(findMismatchedRows(left, right, 10).rows).toEqual([]);
  });

  it("shows missing rows before changed ones", () => {
    // A row on one side only is the bigger fact — it is an INSERT or a DELETE,
    // not an UPDATE — so it is what a caller showing only the first few gets.
    const found = findMismatchedRows(
      [row("1", "a"), row("2", "b")],
      [row("1", "z"), row("3", "c")],
      10,
    );
    expect(found.rows.map((r) => r.kind)).toEqual([
      "sourceOnly",
      "targetOnly",
      "changed",
    ]);
  });

  it("caps the list and says there were more", () => {
    const left = [row("1", "a"), row("2", "a"), row("3", "a")];
    const found = findMismatchedRows(left, [], 2);
    expect(found.rows).toHaveLength(2);
    expect(found.more).toBe(true);
    // Exactly at the limit is not "more" — an off-by-one here would put "more
    // than 10 rows differ" above a complete list of ten.
    expect(findMismatchedRows(left, [], 3).more).toBe(false);
  });

  it("does not confuse two composite keys that join to the same string", () => {
    // ["a|b", "c"] and ["a", "b|c"] joined by a pipe are the same string, and a
    // composite key made of free text is exactly where that happens. Keys are
    // compared as JSON for this reason.
    const found = findMismatchedRows(
      [{ key: ["a|b", "c"], digest: "x" }],
      [{ key: ["a", "b|c"], digest: "x" }],
      10,
    );
    expect(found.rows).toEqual([
      { key: ["a|b", "c"], kind: "sourceOnly" },
      { key: ["a", "b|c"], kind: "targetOnly" },
    ]);
  });
});

describe("differingColumns", () => {
  const pairs = [
    { left: "email", right: "email" },
    { left: "total", right: "total" },
  ];

  it("returns nothing when every paired column matches", () => {
    expect(
      differingColumns(
        { email: "a@b.c", total: "10" },
        { email: "a@b.c", total: "10" },
        pairs,
      ),
    ).toEqual([]);
  });

  it("reports a column under the source's name when it was renamed", () => {
    // The comparison matched `customer_id` to `client_id`. Reading the target's
    // row by the source's name would find nothing and report every renamed
    // column as a difference.
    expect(
      differingColumns({ customer_id: "7" }, { client_id: "7" }, [
        { left: "customer_id", right: "client_id" },
      ]),
    ).toEqual([]);
    expect(
      differingColumns({ customer_id: "7" }, { client_id: "8" }, [
        { left: "customer_id", right: "client_id" },
      ]),
    ).toEqual([{ column: "customer_id", left: "7", right: "8" }]);
  });

  it("treats a missing column as NULL rather than as undefined", () => {
    // A row that came back without the column reads the same as one that came
    // back with NULL in it. Letting `undefined` through would put the word
    // "undefined" on screen beside a real value.
    expect(differingColumns({}, { email: null }, pairs.slice(0, 1))).toEqual([]);
    expect(differingColumns({}, { email: "a@b.c" }, pairs.slice(0, 1))).toEqual([
      { column: "email", left: null, right: "a@b.c" },
    ]);
  });

  it("separates NULL from the empty string", () => {
    // Both render as an empty cell, and they are not the same value. The
    // renderer says which is which; this makes sure the difference survives to
    // reach it.
    expect(differingColumns({ email: null }, { email: "" }, pairs.slice(0, 1))).toEqual([
      { column: "email", left: null, right: "" },
    ]);
  });

  it("ignores a column the comparison did not pair", () => {
    // A column only one side has is reported by the structural diff. Listing it
    // as a row-level difference would say the DATA changed, which it did not.
    expect(
      differingColumns({ email: "a", extra: "1" }, { email: "a" }, pairs.slice(0, 1)),
    ).toEqual([]);
  });
});

describe("describeSample", () => {
  function sample(over: Partial<RowSample> = {}): RowSample {
    return {
      status: "sampled",
      keyColumns: ["id"],
      rows: [],
      more: false,
      scanned: SAMPLE_SCAN_ROWS,
      partial: false,
      note: null,
      ...over,
    };
  }

  it("says nothing when the rows shown are the whole story", () => {
    expect(
      describeSample(sample({ rows: [{ key: ["1"], kind: "changed", differences: [] }] })),
    ).toBeNull();
  });

  it("explains a table whose rows cannot be paired at all", () => {
    const said = describeSample(sample({ status: "no-key", keyColumns: [] }));
    expect(said).toContain("no primary key");
    expect(said).toContain("unique constraint");
  });

  it("passes a failed read's own reason through", () => {
    // Why the rows are missing differs — a timeout reads differently from a
    // dropped connection — so the reason the reader gets is the real one.
    expect(
      describeSample(sample({ status: "unavailable", note: "The rows could not be read." })),
    ).toBe("The rows could not be read.");
  });

  it("explains an empty list on a table that plainly differs", () => {
    // The checksum covers every row; the sample covers the first few thousand.
    // A difference past the cut-off leaves a table in the "contents differ"
    // group with nothing under it, and saying so is the whole point — silence
    // would read as "no rows differ", which is the one thing it never means.
    const said = describeSample(sample({ partial: true }));
    expect(said).toContain("past the first");
    expect(said).toContain(SAMPLE_SCAN_ROWS.toLocaleString());
  });

  it("bounds a capped list", () => {
    const rows = Array.from({ length: SAMPLE_ROW_LIMIT }, (_, i) => ({
      key: [String(i)],
      kind: "changed" as const,
      differences: [],
    }));
    expect(describeSample(sample({ rows, more: true }))).toContain(
      `More than ${SAMPLE_ROW_LIMIT} rows differ`,
    );
  });

  it("says how far the scan read, and by what", () => {
    const rows = [{ key: ["1"], kind: "changed" as const, differences: [] }];
    const said = describeSample(
      sample({ rows, partial: true, keyColumns: ["tenant", "id"] }),
    );
    expect(said).toContain("tenant, id");
    expect(said).toContain("not checked");
  });

  it("says both things at once when both are true", () => {
    const rows = [{ key: ["1"], kind: "changed" as const, differences: [] }];
    const said = describeSample(sample({ rows, more: true, partial: true }));
    expect(said).toContain("More than");
    expect(said).toContain("not checked");
  });
});
