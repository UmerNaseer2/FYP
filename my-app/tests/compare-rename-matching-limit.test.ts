// compare: looking for renamed tables must not block the server.
//
// Rename matching scores every leftover table against every leftover table on
// the other side, and every column against every column inside each pair. Two
// unrelated schemas of 100 tables took over a minute, and the server answered
// nobody in that time. The engine now scores each column pair once, without
// building its list of changes, and past a limit it does not look for renamed
// tables at all.
import { compareSchemas, renameMatchingSkipped } from "@/lib/compare";
import { column, schema, table } from "./helpers/snapshots";

/** `tables` tables of `columns` columns each, every name starting with `prefix`. */
function manyTables(prefix: string, tables: number, columns: number) {
  const list = [];
  for (let t = 0; t < tables; t += 1) {
    const cols = [];
    for (let c = 0; c < columns; c += 1) {
      cols.push(column(`${prefix}_col_${t}_${c}`, { typeDisplay: c % 2 === 0 ? "integer" : "text" }));
    }
    list.push(table(`${prefix}_table_${t}`, cols));
  }
  return list;
}

describe("the limit on table rename matching", () => {
  it("compares two big schemas with nothing in common quickly", () => {
    // 120 x 120 tables of 20 columns: 5.76 million column pairs. Scoring them
    // all took minutes here before the limit.
    const started = Date.now();
    const report = compareSchemas(
      schema(manyTables("old", 120, 20)),
      schema(manyTables("new", 120, 20))
    );
    const took = Date.now() - started;

    expect(took).toBeLessThan(5000);
    expect(report.tablesOnlyInA).toHaveLength(120);
    expect(report.tablesOnlyInB).toHaveLength(120);
    expect(report.matchedTables).toEqual([]);
    expect(report.possibleTableMatches).toEqual([]);
    expect(renameMatchingSkipped(report)).toBe(true);
  });

  it("still finds a rename in a big schema whose other tables match by name", () => {
    // Only the leftover tables count towards the limit: here one on each side.
    const shared = manyTables("shared", 120, 10);
    const customer = [column("id", { nullable: false, isPrimaryKey: true }), column("email", { typeDisplay: "text" })];
    const report = compareSchemas(
      schema([...shared, table("customers", customer)]),
      schema([...shared, table("customer", customer)])
    );

    const renamed = report.matchedTables.filter((match) => !match.exact);
    expect(renamed.map((match) => [match.right.name, match.left.name])).toEqual([
      ["customer", "customers"],
    ]);
    expect(report.tablesOnlyInA).toEqual([]);
    expect(report.tablesOnlyInB).toEqual([]);
    expect(renameMatchingSkipped(report)).toBe(false);
  });

  it("still offers rename candidates for a small mismatched pair", () => {
    // Structurally alike, differently named: offered as candidates to confirm.
    const report = compareSchemas(
      schema(manyTables("old", 3, 4)),
      schema(manyTables("new", 3, 4))
    );
    expect(report.possibleTableMatches.length).toBeGreaterThan(0);
    expect(renameMatchingSkipped(report)).toBe(false);
  });
});
