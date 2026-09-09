import {
  compareSchemas,
  extractBaseType,
  isNarrowingType,
  typeSizeParams,
  typeChangeSeverity,
  nullabilityChangeSeverity,
  droppedColumnSeverity,
  addedColumnSeverity,
} from "@/lib/compare";
import { column, schema, table } from "./helpers/snapshots";

/**
 * Direction is the thing to get right here, and it is easy to get backwards.
 *
 * compareSchemas(source, target) answers "what would it take to make the target
 * look like the source". So report.left is the SOURCE — what the schema should
 * be — and report.right is the TARGET. "Only in A" is therefore something the
 * forward migration CREATES, and "only in B" is something it DROPS. Every test
 * below is written the way the Compare screen reads.
 */
describe("compareSchemas — direction", () => {
  it("reports a source-only table as something the migration creates", () => {
    const report = compareSchemas(
      schema([table("orders", [column("id")]), table("customers", [column("id")])]),
      schema([table("orders", [column("id")])])
    );
    expect(report.tablesOnlyInA.map((t) => t.name)).toEqual(["customers"]);
    expect(report.tablesOnlyInB).toEqual([]);
    expect(report.summary.tablesOnlyInA).toBe(1);
  });

  it("reports a target-only table as something the migration drops", () => {
    const report = compareSchemas(
      schema([table("orders", [column("id")])]),
      schema([table("orders", [column("id")]), table("legacy", [column("id")])])
    );
    expect(report.tablesOnlyInB.map((t) => t.name)).toEqual(["legacy"]);
    expect(report.tablesOnlyInA).toEqual([]);
  });

  it("finds no differences between a schema and itself", () => {
    const one = schema([
      table("orders", [column("id", { nullable: false }), column("total", { typeDisplay: "numeric" })]),
    ]);
    const report = compareSchemas(one, structuredClone(one));

    expect(report.tablesOnlyInA).toEqual([]);
    expect(report.tablesOnlyInB).toEqual([]);
    expect(report.summary.changedTables).toBe(0);
    expect(report.summary.identicalTables).toBe(1);
    expect(report.matchedTables[0].hasChanges).toBe(false);
  });
});

describe("compareSchemas — columns", () => {
  it("splits added and removed columns by direction", () => {
    const report = compareSchemas(
      schema([table("orders", [column("id"), column("total", { typeDisplay: "numeric" })])]),
      schema([table("orders", [column("id"), column("legacy_note", { typeDisplay: "text" })])])
    );
    const match = report.matchedTables[0];

    expect(match.columnsOnlyInA.map((c) => c.name)).toContain("total");
    expect(match.columnsOnlyInB.map((c) => c.name)).toContain("legacy_note");
    expect(match.hasChanges).toBe(true);
  });

  it("records a type change on the matched column", () => {
    const report = compareSchemas(
      schema([table("orders", [column("total", { typeDisplay: "numeric" })])]),
      schema([table("orders", [column("total", { typeDisplay: "integer" })])])
    );
    const match = report.matchedTables[0].columnMatches.find((c) => c.left.name === "total");

    expect(match).toBeDefined();
    // `exact` means "matched by name", not "identical" — a non-exact match is a
    // rename. Same name, different type, so it stays exact and the difference
    // shows up in `changes`.
    expect(match!.exact).toBe(true);
    expect(match!.changes.length).toBeGreaterThan(0);
    expect(report.matchedTables[0].hasChanges).toBe(true);
  });

  it("records a nullability change", () => {
    const report = compareSchemas(
      schema([table("orders", [column("total", { nullable: false })])]),
      schema([table("orders", [column("total", { nullable: true })])])
    );
    const match = report.matchedTables[0].columnMatches[0];
    expect(match.changes.some((c) => /null/i.test(JSON.stringify(c)))).toBe(true);
  });

  it("matches columns by name regardless of position", () => {
    const report = compareSchemas(
      schema([table("orders", [column("id"), column("total")])]),
      schema([table("orders", [column("total"), column("id")])])
    );
    const match = report.matchedTables[0];
    expect(match.columnsOnlyInA).toEqual([]);
    expect(match.columnsOnlyInB).toEqual([]);
  });
});

describe("compareSchemas — table matching", () => {
  it("matches a renamed table by similarity rather than calling it add + drop", () => {
    const columns = [
      column("id", { nullable: false, typeDisplay: "integer" }),
      column("email", { typeDisplay: "text" }),
      column("created_at", { typeDisplay: "timestamptz" }),
      column("full_name", { typeDisplay: "text" }),
    ];
    const report = compareSchemas(
      schema([table("app_users", columns)]),
      schema([table("users", columns)])
    );

    // Either it paired them outright or it offered the pair as a candidate —
    // both are "we noticed", which is the point. What it must NOT do is report
    // an unrelated create and an unrelated drop.
    const paired =
      report.matchedTables.length > 0 || report.possibleTableMatches.length > 0;
    expect(paired).toBe(true);
    expect(report.summary.likelyRenameCandidates + report.matchedTables.length).toBeGreaterThan(0);
  });

  it("does not pair two tables that have nothing in common", () => {
    const report = compareSchemas(
      schema([table("orders", [column("id"), column("total")])]),
      schema([table("audit_log", [column("occurred_at"), column("payload")])])
    );
    expect(report.matchedTables).toEqual([]);
    expect(report.tablesOnlyInA.map((t) => t.name)).toEqual(["orders"]);
    expect(report.tablesOnlyInB.map((t) => t.name)).toEqual(["audit_log"]);
  });

  it("is case-insensitive about table names", () => {
    const report = compareSchemas(
      schema([table("Orders", [column("id")])]),
      schema([table("orders", [column("id")])])
    );
    expect(report.matchedTables).toHaveLength(1);
    expect(report.tablesOnlyInA).toEqual([]);
  });
});

describe("type analysis", () => {
  it("reads the base type out of a display type", () => {
    expect(extractBaseType("character varying(255)")).toBe("character varying");
    expect(extractBaseType("numeric(10,2)")).toBe("numeric");
    expect(extractBaseType("integer")).toBe("integer");
  });

  it("reads the size parameters", () => {
    expect(typeSizeParams("varchar(255)")).toEqual([255]);
    expect(typeSizeParams("numeric(10,2)")).toEqual([10, 2]);
    expect(typeSizeParams("integer")).toBeNull();
  });

  it("knows which direction loses data within one type family", () => {
    // Reads current → new. Shrinking a varchar can truncate; growing cannot.
    expect(isNarrowingType("varchar(255)", "varchar(50)")).toBe(true);
    expect(isNarrowingType("varchar(50)", "varchar(255)")).toBe(false);
    // Dropping fractional scale, or the whole-number room, both lose values.
    expect(isNarrowingType("numeric(10,2)", "numeric(10,4)")).toBe(true);
    expect(isNarrowingType("numeric(10,2)", "numeric(12,2)")).toBe(false);
    // Bounded → unbounded is safe; unbounded → bounded constrains what is
    // already stored.
    expect(isNarrowingType("varchar(50)", "text")).toBe(false);
    expect(isNarrowingType("text", "text")).toBe(false);
  });

  it("says nothing about a change of base type", () => {
    // Different families need a cast, which this cannot reason about — so it
    // answers false and typeChangeSeverity grades those breaking outright.
    expect(isNarrowingType("bigint", "integer")).toBe(false);
    expect(isNarrowingType("integer", "text")).toBe(false);
  });
});

/**
 * Severity is what the Deploy screen counts as `breakingCount`, and that number
 * now gates the button — so a change classified one level too quiet would let a
 * destructive run through the gate that exists to catch it.
 */
describe("change severity", () => {
  it("grades a type change by what the migration does to the TARGET", () => {
    // Arguments read (source, target), and the migration rewrites the target to
    // match the source — so this pair shrinks varchar(255) down to varchar(50).
    expect(typeChangeSeverity("varchar(50)", "varchar(255)")).toBe("breaking");
    // ...and this pair grows it, which cannot fail.
    expect(typeChangeSeverity("varchar(255)", "varchar(50)")).toBe("safe");
    // Any change of base type needs a cast that can fail on real values.
    expect(typeChangeSeverity("integer", "bigint")).toBe("breaking");
    expect(typeChangeSeverity("text", "integer")).toBe("breaking");
  });

  it("calls tightening a column to NOT NULL breaking", () => {
    // Source is NOT NULL, target is nullable → the migration adds NOT NULL,
    // which fails outright if any existing row holds a null.
    expect(nullabilityChangeSeverity(false)).toBe("breaking");
    // The other direction only relaxes the rule.
    expect(nullabilityChangeSeverity(true)).not.toBe("breaking");
  });

  it("calls dropping a column breaking", () => {
    expect(droppedColumnSeverity()).toBe("breaking");
  });

  it("calls adding a NOT NULL column with no default breaking", () => {
    expect(addedColumnSeverity(column("total", { nullable: false, columnDefault: null }))).toBe(
      "breaking"
    );
    // With a default there is something to backfill every existing row with.
    expect(
      addedColumnSeverity(column("total", { nullable: false, columnDefault: "0" }))
    ).not.toBe("breaking");
    expect(addedColumnSeverity(column("note", { nullable: true }))).not.toBe("breaking");
  });
});
