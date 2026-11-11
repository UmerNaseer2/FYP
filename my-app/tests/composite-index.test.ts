import { compositeIndexAdvice, tableSearchIndexes, type SearchPattern } from "../lib/composite-index";

/**
 * The rule that suggests one index across several columns. These tests cover
 * the list of indexes it is given: the snapshot keeps the index behind a
 * PRIMARY KEY or UNIQUE constraint apart from a table's stand-alone indexes,
 * and the rule has to be told about both.
 */

/** Two analysed queries that look order_items up by order_id and product_id. */
const BY_BOTH_KEYS: SearchPattern = {
  table: "order_items",
  equality: ["order_id", "product_id"],
  range: null,
  queries: 2,
  runs: 2,
};

/** order_items as the snapshot records it: a two-column primary key, no other index. */
const ORDER_ITEMS = {
  primaryKey: { name: "order_items_pkey", columns: ["order_id", "product_id"] },
  uniqueConstraints: [],
  indexes: [],
};

function advise(indexes: ReturnType<typeof tableSearchIndexes>) {
  return compositeIndexAdvice("public", [BY_BOTH_KEYS], { order_items: indexes }, [], 30);
}

describe("tableSearchIndexes", () => {
  it("lists the primary key and unique constraints with the stand-alone indexes", () => {
    const list = tableSearchIndexes({
      primaryKey: { name: "t_pkey", columns: ["id"] },
      uniqueConstraints: [{ name: "t_code_key", columns: ["code"] }],
      indexes: [{ name: "t_a_idx", columns: ["a"], predicate: "(a > 0)" }],
    });
    expect(list).toEqual([
      { name: "t_pkey", columns: ["id"], predicate: null },
      { name: "t_code_key", columns: ["code"], predicate: null },
      { name: "t_a_idx", columns: ["a"], predicate: "(a > 0)" },
    ]);
  });

  it("leaves out a stand-alone index the caller says is not usable", () => {
    const list = tableSearchIndexes(
      { primaryKey: null, uniqueConstraints: [], indexes: [{ name: "bad", columns: ["a"], predicate: null }] },
      (index) => index.name !== "bad"
    );
    expect(list).toEqual([]);
  });

  it("copes with a snapshot taken before indexes were captured", () => {
    expect(tableSearchIndexes({ primaryKey: null, uniqueConstraints: [] })).toEqual([]);
  });
});

describe("compositeIndexAdvice", () => {
  it("does not suggest an index that copies the primary key", () => {
    expect(advise(tableSearchIndexes(ORDER_ITEMS))).toEqual([]);
  });

  it("does not suggest an index that copies a unique constraint", () => {
    const table = {
      primaryKey: null,
      uniqueConstraints: [{ name: "order_items_order_product_key", columns: ["product_id", "order_id"] }],
      indexes: [],
    };
    expect(advise(tableSearchIndexes(table))).toEqual([]);
  });

  it("still suggests the index when nothing serves the search", () => {
    const advice = advise([]);
    expect(advice).toHaveLength(1);
    expect(advice[0].fix).toContain('ON "public"."order_items" ("order_id", "product_id")');
  });

  it("does not say no index leads with the columns when a wider one does", () => {
    // (order_id, created_at) leads with order_id but does not serve the search.
    const advice = advise([{ name: "order_items_order_created_idx", columns: ["order_id", "created_at"], predicate: null }]);
    expect(advice).toHaveLength(1);
    expect(advice[0].detail).not.toMatch(/No index leads/);
    expect(advice[0].detail).toContain("No single-column index covers these columns.");
  });
});
