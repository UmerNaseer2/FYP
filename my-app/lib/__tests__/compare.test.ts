/**
 * Tests for lib/compare.ts
 *
 * These tests verify the three improvements made to the algorithm:
 *   1. typeScore()          — partial credit for same-family types
 *   2. extractBaseType()    — strips params to get the base type name
 *   3. typeChangeDescription() — "Size/precision changed" vs "Type changed"
 *   4. columnOrderSimilarity — relative position, not absolute (tested via compareSchemas)
 *
 * We also run integration tests through compareSchemas() to make sure
 * everything works end-to-end with realistic data.
 */

import {
  compareSchemas,
  extractBaseType,
  typeScore,
  typeChangeDescription,
} from "../compare";
import type { SchemaSnapshot, TableSnapshot, ColumnSnapshot } from "../postgres";

// ─── small helpers to build test data without too much boilerplate ────────────

function makeColumn(
  name: string,
  typeDisplay: string,
  ordinalPosition: number,
  overrides: Partial<ColumnSnapshot> = {}
): ColumnSnapshot {
  return {
    name,
    typeDisplay,
    ordinalPosition,
    nullable: false,
    isPrimaryKey: false,
    uniqueConstraintNames: [],
    foreignKeyConstraintNames: [],
    ...overrides,
  };
}

function makeTable(name: string, columns: ColumnSnapshot[]): TableSnapshot {
  return {
    name,
    columns,
    primaryKey: null,
    uniqueConstraints: [],
    foreignKeys: [],
    checkConstraints: [],
    excludeConstraints: [],
  };
}

function makeSchema(...tables: TableSnapshot[]): SchemaSnapshot {
  return {
    database: "test_db",
    schema: "public",
    tables,
  };
}

// ─── extractBaseType ──────────────────────────────────────────────────────────

describe("extractBaseType", () => {
  it("strips the size param from parameterized types", () => {
    expect(extractBaseType("character varying(100)")).toBe("character varying");
    expect(extractBaseType("character varying(255)")).toBe("character varying");
  });

  it("strips multiple params (e.g. numeric precision and scale)", () => {
    expect(extractBaseType("numeric(10,2)")).toBe("numeric");
    expect(extractBaseType("numeric(5,0)")).toBe("numeric");
  });

  it("returns the type as-is when there are no params", () => {
    expect(extractBaseType("integer")).toBe("integer");
    expect(extractBaseType("text")).toBe("text");
    expect(extractBaseType("boolean")).toBe("boolean");
    expect(extractBaseType("double precision")).toBe("double precision");
    expect(extractBaseType("jsonb")).toBe("jsonb");
  });

  it("normalises case before returning", () => {
    expect(extractBaseType("CHARACTER VARYING(100)")).toBe("character varying");
    expect(extractBaseType("NUMERIC(10,2)")).toBe("numeric");
    expect(extractBaseType("INTEGER")).toBe("integer");
  });
});

// ─── typeScore ────────────────────────────────────────────────────────────────

describe("typeScore", () => {
  describe("full score (20) — identical types", () => {
    it("scores simple types that are exactly the same", () => {
      expect(typeScore("integer", "integer")).toBe(20);
      expect(typeScore("text", "text")).toBe(20);
      expect(typeScore("boolean", "boolean")).toBe(20);
      expect(typeScore("jsonb", "jsonb")).toBe(20);
      expect(typeScore("double precision", "double precision")).toBe(20);
    });

    it("scores parameterized types that are exactly the same", () => {
      expect(typeScore("character varying(100)", "character varying(100)")).toBe(20);
      expect(typeScore("numeric(10,2)", "numeric(10,2)")).toBe(20);
      expect(typeScore("timestamp without time zone", "timestamp without time zone")).toBe(20);
    });

    it("is case-insensitive — same type written differently still scores 20", () => {
      expect(typeScore("INTEGER", "integer")).toBe(20);
      expect(typeScore("CHARACTER VARYING(100)", "character varying(100)")).toBe(20);
      expect(typeScore("BOOLEAN", "boolean")).toBe(20);
    });
  });

  describe("partial score (12) — same base type, different size or precision", () => {
    it("gives partial credit for varchar with different sizes", () => {
      expect(typeScore("character varying(100)", "character varying(200)")).toBe(12);
      expect(typeScore("character varying(50)",  "character varying(255)")).toBe(12);
    });

    it("gives partial credit for numeric with different precision or scale", () => {
      expect(typeScore("numeric(10,2)", "numeric(8,4)")).toBe(12);
      expect(typeScore("numeric(5,0)",  "numeric(10,2)")).toBe(12);
    });

    it("is case-insensitive for partial matches too", () => {
      expect(typeScore("CHARACTER VARYING(100)", "character varying(200)")).toBe(12);
    });
  });

  describe("zero score — completely different types", () => {
    it("gives 0 for unrelated types", () => {
      expect(typeScore("integer", "text")).toBe(0);
      expect(typeScore("boolean", "integer")).toBe(0);
      expect(typeScore("jsonb", "text")).toBe(0);
    });

    it("gives 0 when varchar changes to integer (not just a size change)", () => {
      expect(typeScore("character varying(100)", "integer")).toBe(0);
    });

    it("gives 0 for timestamp vs date (different base types, not just params)", () => {
      expect(typeScore("timestamp without time zone", "date")).toBe(0);
    });

    it("gives 0 for numeric vs double precision (same concept, different type family)", () => {
      // These are mathematically related but they are different PostgreSQL types.
      expect(typeScore("numeric(10,2)", "double precision")).toBe(0);
    });
  });
});

// ─── typeChangeDescription ────────────────────────────────────────────────────

describe("typeChangeDescription", () => {
  it("says 'Size/precision changed' when the base type is the same", () => {
    const msg = typeChangeDescription(
      "character varying(100)",
      "character varying(200)"
    );
    expect(msg).toContain("Size/precision changed");
    expect(msg).toContain("character varying(100)");
    expect(msg).toContain("character varying(200)");
    expect(msg).not.toContain("Type changed");
  });

  it("says 'Type changed' when the base types are different", () => {
    const msg = typeChangeDescription("integer", "text");
    expect(msg).toContain("Type changed");
    expect(msg).toContain("integer");
    expect(msg).toContain("text");
    expect(msg).not.toContain("Size/precision changed");
  });

  it("says 'Type changed' for numeric vs double precision", () => {
    const msg = typeChangeDescription("numeric(10,2)", "double precision");
    expect(msg).toContain("Type changed");
  });

  it("says 'Size/precision changed' for numeric with different params", () => {
    const msg = typeChangeDescription("numeric(10,2)", "numeric(8,4)");
    expect(msg).toContain("Size/precision changed");
  });
});

// ─── compareSchemas — integration tests ──────────────────────────────────────

describe("compareSchemas", () => {

  // ── identical schemas ───────────────────────────────────────────────────────

  describe("identical schemas", () => {
    it("reports no changes when both schemas are exactly the same", () => {
      const columns = [
        makeColumn("id",       "integer",                1, { isPrimaryKey: true }),
        makeColumn("username", "character varying(50)",  2),
        makeColumn("email",    "character varying(100)", 3),
      ];
      const schema = makeSchema(makeTable("users", columns));
      const report = compareSchemas(schema, schema);

      expect(report.matchedTables).toHaveLength(1);
      expect(report.matchedTables[0].hasChanges).toBe(false);
      expect(report.matchedTables[0].columnMatches.every((m) => m.changes.length === 0)).toBe(true);
      expect(report.tablesOnlyInA).toHaveLength(0);
      expect(report.tablesOnlyInB).toHaveLength(0);
    });

    it("sets identicalTables count correctly in the summary", () => {
      const col = makeColumn("id", "integer", 1);
      const schema = makeSchema(makeTable("users", [col]), makeTable("orders", [col]));
      const report = compareSchemas(schema, schema);

      expect(report.summary.identicalTables).toBe(2);
      expect(report.summary.changedTables).toBe(0);
    });

    it("uses the real structural score for exact-name table matches", () => {
      const tableA = makeTable("users", [
        makeColumn("id", "integer", 1),
        makeColumn("email", "character varying(100)", 2),
      ]);
      const tableB = makeTable("users", [
        makeColumn("id", "integer", 1),
        makeColumn("email", "character varying(150)", 2),
      ]);

      const report = compareSchemas(makeSchema(tableA), makeSchema(tableB));
      const match = report.matchedTables[0];

      expect(match.exact).toBe(true);
      expect(match.score).toBeLessThan(100);
      expect(match.breakdown.columns).toBeLessThan(60);
    });
  });

  // ── type change reporting ───────────────────────────────────────────────────

  describe("type change reporting", () => {
    it("reports 'Size/precision changed' — not 'Type changed' — for varchar size diff", () => {
      const tableA = makeTable("users", [
        makeColumn("id",    "integer",                1),
        makeColumn("email", "character varying(100)", 2),
      ]);
      const tableB = makeTable("users", [
        makeColumn("id",    "integer",                1),
        makeColumn("email", "character varying(200)", 2), // only the size changed
      ]);

      const report  = compareSchemas(makeSchema(tableA), makeSchema(tableB));
      const match   = report.matchedTables[0];
      const emailMatch = match.columnMatches.find((m) => m.left.name === "email");

      expect(emailMatch).toBeDefined();
      expect(emailMatch!.changes).toHaveLength(1);
      expect(emailMatch!.changes[0]).toContain("Size/precision changed");
      expect(emailMatch!.changes[0]).not.toContain("Type changed");
    });

    it("reports 'Type changed' when the base type actually changes", () => {
      const tableA = makeTable("products", [
        makeColumn("id",    "integer",       1),
        makeColumn("price", "numeric(10,2)", 2),
      ]);
      const tableB = makeTable("products", [
        makeColumn("id",    "integer",          1),
        makeColumn("price", "double precision", 2), // genuinely different type
      ]);

      const report  = compareSchemas(makeSchema(tableA), makeSchema(tableB));
      const match   = report.matchedTables[0];
      const priceMatch = match.columnMatches.find((m) => m.left.name === "price");

      expect(priceMatch!.changes[0]).toContain("Type changed");
      expect(priceMatch!.changes[0]).not.toContain("Size/precision changed");
    });

    it("reports 'Type changed' for timestamp vs date (not just a size tweak)", () => {
      const tableA = makeTable("users", [
        makeColumn("id",         "integer",                    1),
        makeColumn("created_at", "timestamp without time zone", 2),
      ]);
      const tableB = makeTable("users", [
        makeColumn("id",         "integer", 1),
        makeColumn("created_at", "date",    2),
      ]);

      const report = compareSchemas(makeSchema(tableA), makeSchema(tableB));
      const match  = report.matchedTables[0];
      const col    = match.columnMatches.find((m) => m.left.name === "created_at");

      expect(col!.changes[0]).toContain("Type changed");
    });

    it("does not report a type change when both types are identical", () => {
      const tableA = makeTable("users", [
        makeColumn("id", "integer", 1),
      ]);
      const tableB = makeTable("users", [
        makeColumn("id", "integer", 1),
      ]);

      const report = compareSchemas(makeSchema(tableA), makeSchema(tableB));
      const match  = report.matchedTables[0];
      const col    = match.columnMatches.find((m) => m.left.name === "id");

      expect(col!.changes).toHaveLength(0);
    });
  });

  // ── tables only in one schema ───────────────────────────────────────────────

  describe("tables only in one schema", () => {
    it("correctly identifies a table that only exists in A", () => {
      const sharedCol = makeColumn("id", "integer", 1);
      const schemaA   = makeSchema(
        makeTable("users",      [sharedCol]),
        makeTable("categories", [sharedCol])  // only in A
      );
      const schemaB   = makeSchema(
        makeTable("users", [sharedCol])
      );

      const report = compareSchemas(schemaA, schemaB);

      expect(report.tablesOnlyInA).toHaveLength(1);
      expect(report.tablesOnlyInA[0].name).toBe("categories");
      expect(report.tablesOnlyInB).toHaveLength(0);
    });

    it("correctly identifies a table that only exists in B", () => {
      const sharedCol = makeColumn("id", "integer", 1);
      const schemaA   = makeSchema(makeTable("users", [sharedCol]));
      const schemaB   = makeSchema(
        makeTable("users",     [sharedCol]),
        makeTable("inventory", [sharedCol])  // only in B
      );

      const report = compareSchemas(schemaA, schemaB);

      expect(report.tablesOnlyInA).toHaveLength(0);
      expect(report.tablesOnlyInB).toHaveLength(1);
      expect(report.tablesOnlyInB[0].name).toBe("inventory");
    });
  });

  // ── column detection ────────────────────────────────────────────────────────

  describe("column detection", () => {
    it("detects a column that exists only in A", () => {
      const tableA = makeTable("users", [
        makeColumn("id",        "integer", 1),
        makeColumn("is_active", "boolean", 2),  // only in A
      ]);
      const tableB = makeTable("users", [
        makeColumn("id", "integer", 1),
      ]);

      const report = compareSchemas(makeSchema(tableA), makeSchema(tableB));
      const match  = report.matchedTables[0];

      expect(match.columnsOnlyInA).toHaveLength(1);
      expect(match.columnsOnlyInA[0].name).toBe("is_active");
      expect(match.columnsOnlyInB).toHaveLength(0);
    });

    it("detects a column that exists only in B", () => {
      const tableA = makeTable("users", [
        makeColumn("id", "integer", 1),
      ]);
      const tableB = makeTable("users", [
        makeColumn("id",    "integer",               1),
        makeColumn("phone", "character varying(20)", 2),  // only in B
      ]);

      const report = compareSchemas(makeSchema(tableA), makeSchema(tableB));
      const match  = report.matchedTables[0];

      expect(match.columnsOnlyInA).toHaveLength(0);
      expect(match.columnsOnlyInB).toHaveLength(1);
      expect(match.columnsOnlyInB[0].name).toBe("phone");
    });
  });

  // ── relative column order (improvement 2) ───────────────────────────────────

  describe("relative column order scoring", () => {
    it("does not penalise a last-position column when a new column is inserted before it", () => {
      // Table A: id(1)  name(2)    email(3)          — 3 columns total
      // Table B: id(1)  new_col(2) name(3) email(4)  — 4 columns, new one inserted at pos 2
      //
      // 'email' is the last column in BOTH tables.
      //   A: ordinal 3 / 3 total = ratio 1.0
      //   B: ordinal 4 / 4 total = ratio 1.0
      //   diff = 0  →  order score = 10  (maximum)
      const tableA = makeTable("users", [
        makeColumn("id",      "integer",                1),
        makeColumn("name",    "character varying(100)", 2),
        makeColumn("email",   "character varying(100)", 3),
      ]);
      const tableB = makeTable("users", [
        makeColumn("id",      "integer",                1),
        makeColumn("new_col", "text",                   2),
        makeColumn("name",    "character varying(100)", 3),
        makeColumn("email",   "character varying(100)", 4),
      ]);

      const report     = compareSchemas(makeSchema(tableA), makeSchema(tableB));
      const match      = report.matchedTables[0];
      const emailMatch = match.columnMatches.find((m) => m.left.name === "email");

      expect(emailMatch).toBeDefined();
      // 'email' should match to 'email' in B (not lost to the new column).
      expect(emailMatch!.right.name).toBe("email");
      // Order score should be the max (10) because relative position is the same.
      expect(emailMatch!.breakdown.order).toBe(10);
    });

    it("gives 0 order score to a column that has shifted halfway across the table", () => {
      // Table A: a(1)  b(2)  c(3)  d(4)
      // Table B: b(1)  c(2)  a(3)  d(4)   — 'a' moved from pos 1 to pos 3
      //
      // For 'a':
      //   leftRatio  = 1/4 = 0.25
      //   rightRatio = 3/4 = 0.75
      //   diff = 0.5  →  1 - (0.5 * 2) = 0  →  order score = 0
      const tableA = makeTable("things", [
        makeColumn("a", "integer", 1),
        makeColumn("b", "integer", 2),
        makeColumn("c", "integer", 3),
        makeColumn("d", "integer", 4),
      ]);
      const tableB = makeTable("things", [
        makeColumn("b", "integer", 1),
        makeColumn("c", "integer", 2),
        makeColumn("a", "integer", 3),
        makeColumn("d", "integer", 4),
      ]);

      const report = compareSchemas(makeSchema(tableA), makeSchema(tableB));
      const match  = report.matchedTables[0];
      const aMatch = match.columnMatches.find((m) => m.left.name === "a");

      expect(aMatch).toBeDefined();
      expect(aMatch!.breakdown.order).toBe(0);
    });

    it("gives a medium order score to a column that shifted by a quarter of the table", () => {
      // Table A: a(1)  b(2)  c(3)  d(4)
      // Table B: a(2)  b(3)  c(4)  d(1)   — everything shifted by one
      // For 'd':
      //   leftRatio  = 4/4 = 1.0
      //   rightRatio = 1/4 = 0.25
      //   diff = 0.75  →  1 - (0.75 * 2) = -0.5  →  clamped to 0
      // For 'a':
      //   leftRatio  = 1/4 = 0.25
      //   rightRatio = 2/4 = 0.5
      //   diff = 0.25  →  1 - (0.25 * 2) = 0.5  →  0.5 * 10 = 5
      const tableA = makeTable("things", [
        makeColumn("a", "integer", 1),
        makeColumn("b", "integer", 2),
        makeColumn("c", "integer", 3),
        makeColumn("d", "integer", 4),
      ]);
      const tableB = makeTable("things", [
        makeColumn("d", "integer", 1),
        makeColumn("a", "integer", 2),
        makeColumn("b", "integer", 3),
        makeColumn("c", "integer", 4),
      ]);

      const report = compareSchemas(makeSchema(tableA), makeSchema(tableB));
      const match  = report.matchedTables[0];
      const aMatch = match.columnMatches.find((m) => m.left.name === "a");

      expect(aMatch).toBeDefined();
      // diff = |0.25 - 0.5| = 0.25, score = max(0, 1 - 0.25*2) = 0.5, * 10 = 5
      expect(aMatch!.breakdown.order).toBe(5);
    });
  });

  // ── summary counts ──────────────────────────────────────────────────────────

  describe("summary counts", () => {
    it("produces accurate summary counts across a mixed schema diff", () => {
      // Setup:
      //   users      → same name in both, but has a column size change (changedTable)
      //   categories → only in A  (deliberately different columns from inventory so
      //                            the algorithm cannot false-match them)
      //   inventory  → only in B

      const usersA = makeTable("users", [
        makeColumn("id",    "integer",                1),
        makeColumn("email", "character varying(100)", 2),
      ]);
      const usersB = makeTable("users", [
        makeColumn("id",    "integer",                1),
        makeColumn("email", "character varying(150)", 2), // only size changed
      ]);

      // categories: text/boolean columns only — types chosen so they can't
      // score any type points against inventory's all-numeric/timestamp columns.
      const categoriesA = makeTable("categories", [
        makeColumn("label",   "text",    1, { nullable: true }),
        makeColumn("visible", "boolean", 2),
      ]);

      // inventory: integer/numeric/timestamp columns only — no varchar or boolean,
      // so type score vs any categories column is always 0.
      // When all type scores are 0, the max column pair score is 25/60,
      // which keeps the overall table similarity well below the 55-point threshold.
      const inventoryB = makeTable("inventory", [
        makeColumn("quantity",    "integer",                    1),
        makeColumn("warehouse_id","numeric(5,2)",              2),
        makeColumn("checked_at",  "timestamp without time zone", 3),
      ]);

      const schemaA = makeSchema(usersA, categoriesA);
      const schemaB = makeSchema(usersB, inventoryB);

      const report = compareSchemas(schemaA, schemaB);

      expect(report.summary.tablesOnlyInA).toBe(1);   // categories
      expect(report.summary.tablesOnlyInB).toBe(1);   // inventory
      expect(report.summary.changedTables).toBe(1);    // users (email size change)
      expect(report.summary.identicalTables).toBe(0);
    });

    it("counts identical tables correctly when nothing has changed", () => {
      const col     = makeColumn("id", "integer", 1);
      const schemaA = makeSchema(makeTable("users", [col]), makeTable("orders", [col]));
      const schemaB = makeSchema(makeTable("users", [col]), makeTable("orders", [col]));

      const report  = compareSchemas(schemaA, schemaB);

      expect(report.summary.identicalTables).toBe(2);
      expect(report.summary.changedTables).toBe(0);
    });
  });

  // ── rename candidates ───────────────────────────────────────────────────────

  describe("rename candidates", () => {
    it("suggests a table rename candidate when two tables have different names but similar columns", () => {
      // audit_logs (A) vs event_log (B) — six very similar columns, just renamed
      const auditCols = [
        makeColumn("id",           "integer",                    1),
        makeColumn("table_name",   "character varying(100)",     2),
        makeColumn("action",       "character varying(10)",      3),
        makeColumn("performed_by", "integer",                    4, { nullable: true }),
        makeColumn("performed_at", "timestamp without time zone", 5),
        makeColumn("payload",      "jsonb",                      6, { nullable: true }),
      ];
      const eventCols = [
        makeColumn("id",           "integer",                    1),
        makeColumn("table_name",   "character varying(100)",     2),
        makeColumn("event_type",   "character varying(10)",      3),  // was action
        makeColumn("triggered_by", "integer",                    4, { nullable: true }),
        makeColumn("triggered_at", "timestamp without time zone", 5),
        makeColumn("data",         "jsonb",                      6, { nullable: true }),
      ];

      const schemaA = makeSchema(makeTable("audit_logs", auditCols));
      const schemaB = makeSchema(makeTable("event_log",  eventCols));

      const report = compareSchemas(schemaA, schemaB);

      // The two tables should be identified as a rename candidate (either as
      // an accepted similarity match or a possible match — both count).
      const isRenameCandidate =
        report.matchedTables.some((m) => !m.exact) ||
        report.possibleTableMatches.length > 0;

      expect(isRenameCandidate).toBe(true);
      // Since the tables only appear in rename results, they shouldn't show as "only in A/B".
      const allRenameNames = [
        ...report.matchedTables.filter((m) => !m.exact).map((m) => m.left.name),
        ...report.possibleTableMatches.map((m) => m.leftName),
      ];
      expect(allRenameNames).toContain("audit_logs");
    });

    it("accepts a strong renamed column match when the score clears the threshold", () => {
      const schemaA = makeSchema(
        makeTable("accounts", [
          makeColumn("customer_id", "integer", 1, { isPrimaryKey: true }),
          makeColumn("full_name", "character varying(100)", 2),
        ])
      );
      const schemaB = makeSchema(
        makeTable("accounts", [
          makeColumn("client_id", "integer", 1, { isPrimaryKey: true }),
          makeColumn("full_name", "character varying(100)", 2),
        ])
      );

      const report = compareSchemas(schemaA, schemaB);
      const match = report.matchedTables[0];
      const renamedColumn = match.columnMatches.find(
        (columnMatch) => columnMatch.left.name === "customer_id"
      );

      expect(renamedColumn).toBeDefined();
      expect(renamedColumn!.right.name).toBe("client_id");
      expect(renamedColumn!.exact).toBe(false);
      expect(match.columnsOnlyInA.map((column) => column.name)).not.toContain("customer_id");
      expect(match.columnsOnlyInB.map((column) => column.name)).not.toContain("client_id");
    });

    it("keeps possible table matches visible in the only-in-A/B buckets", () => {
      const schemaA = makeSchema(
        makeTable("alpha_core", [
          makeColumn("id", "integer", 1),
          makeColumn("first_name", "character varying(100)", 2),
          makeColumn("is_active", "boolean", 3),
          makeColumn("updated_at", "timestamp without time zone", 4),
        ])
      );
      const schemaB = makeSchema(
        makeTable("omega_core", [
          makeColumn("id", "integer", 1),
          makeColumn("title", "integer", 2),
          makeColumn("created_on", "date", 3),
          makeColumn("amount", "numeric(10,2)", 4),
        ])
      );

      const report = compareSchemas(schemaA, schemaB);

      expect(report.possibleTableMatches).toHaveLength(1);
      expect(report.tablesOnlyInA.map((table) => table.name)).toContain("alpha_core");
      expect(report.tablesOnlyInB.map((table) => table.name)).toContain("omega_core");
    });

    it("keeps possible column matches visible in the only-in-A/B lists", () => {
      const schemaA = makeSchema(
        makeTable("users", [
          makeColumn("id", "integer", 1),
          makeColumn("legacy_code", "character varying(100)", 2),
        ])
      );
      const schemaB = makeSchema(
        makeTable("users", [
          makeColumn("id", "integer", 1),
          makeColumn("notes", "character varying(100)", 2),
        ])
      );

      const report = compareSchemas(schemaA, schemaB);
      const match = report.matchedTables[0];

      expect(match.possibleColumnMatches).toHaveLength(1);
      expect(match.columnsOnlyInA.map((column) => column.name)).toContain("legacy_code");
      expect(match.columnsOnlyInB.map((column) => column.name)).toContain("notes");
    });

    it("does not treat case-sensitive table and column names as exact matches", () => {
      const schemaA = makeSchema(
        makeTable("User", [
          makeColumn("UserID", "integer", 1),
        ])
      );
      const schemaB = makeSchema(
        makeTable("user", [
          makeColumn("userid", "integer", 1),
        ])
      );

      const report = compareSchemas(schemaA, schemaB);

      expect(report.matchedTables).toHaveLength(1);
      expect(report.matchedTables[0].exact).toBe(false);
      expect(report.matchedTables[0].columnMatches).toHaveLength(1);
      expect(report.matchedTables[0].columnMatches[0].exact).toBe(false);
    });
  });
});
