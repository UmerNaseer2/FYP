import {
  columnMatchPercent,
  compareSchemas,
  extractBaseType,
  isNarrowingType,
  typeSizeParams,
  typeChangeSeverity,
  nullabilityChangeSeverity,
  droppedColumnSeverity,
  addedColumnSeverity,
} from "@/lib/compare";
import type { ConstraintSnapshot } from "@/lib/postgres";
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

/**
 * Which column pairs may be renamed without a human looking.
 *
 * Two columns of the same type in the same position inside one table score 45
 * of 60 on structure alone, and the accept threshold is 50 — so a name counted
 * for almost nothing and any leftover pair became an automatic RENAME COLUMN.
 * That is the one migration mistake nothing downstream can catch: no row is
 * lost, no statement fails, and the data is simply under the wrong heading.
 */
describe("compareSchemas — column renames", () => {
  /** One table, matched by name, with a differing column at the end. */
  function withLastColumn(leftName: string, rightName: string) {
    const shared = [
      column("id", { nullable: false, typeDisplay: "integer" }),
      column("created_at", { typeDisplay: "timestamptz" }),
    ];
    const report = compareSchemas(
      schema([table("customers", [...shared, column(leftName, { typeDisplay: "text" })])]),
      schema([table("customers", [...shared, column(rightName, { typeDisplay: "text" })])])
    );
    const match = report.matchedTables[0];
    return {
      renamed: match.columnMatches
        .filter((columnMatch) => !columnMatch.exact)
        .map((columnMatch) => `${columnMatch.right.name} → ${columnMatch.left.name}`),
      candidates: match.possibleColumnMatches.map((c) => `${c.rightName} → ${c.leftName}`),
      added: match.columnsOnlyInA.map((c) => c.name),
      dropped: match.columnsOnlyInB.map((c) => c.name),
    };
  }

  it("does not rename billing_address into shipping_address on its own", () => {
    const result = withLastColumn("shipping_address", "billing_address");
    expect(result.renamed).toEqual([]);
    // Offered for review instead, and left as an add and a drop — both of which
    // are marked destructive, so safe mode stops the script before either runs.
    expect(result.candidates).toEqual(["billing_address → shipping_address"]);
    expect(result.added).toEqual(["shipping_address"]);
    expect(result.dropped).toEqual(["billing_address"]);
  });

  it("does not rename between two columns that merely rhyme", () => {
    // Real pairs that sit in one table and would otherwise swap their contents.
    for (const [left, right] of [
      ["updated_at", "verified_at"],
      ["last_name", "first_name"],
      ["is_archived", "is_active"],
    ]) {
      expect(withLastColumn(left, right).renamed).toEqual([]);
    }
  });

  it("still renames a column whose name is a correction of the old one", () => {
    expect(withLastColumn("user_id", "usr_id").renamed).toEqual(["usr_id → user_id"]);
    expect(withLastColumn("address", "adress").renamed).toEqual(["adress → address"]);
  });

  it("still renames a column the new name spells out", () => {
    // The old name inside the new one is the commonest real rename there is.
    expect(withLastColumn("email_address", "email").renamed).toEqual(["email → email_address"]);
    expect(withLastColumn("description", "descr").renamed).toEqual(["descr → description"]);
  });

  it("reports the match as a share of what a column can score", () => {
    // 56.25 of 60 is a 94% match. It used to be shown as "56.3% match", which
    // reads as a coin toss and tells the reader to distrust a good match.
    expect(columnMatchPercent(56.25)).toBe(94);
    expect(columnMatchPercent(60)).toBe(100);
    expect(columnMatchPercent(45)).toBe(75);
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

/**
 * A changed value has two sides and the report has to be able to print them in
 * either order: /compare rewrites the target so it reads target → source, while
 * /drift is watching a live database move away from a baseline so it reads
 * baseline → live. The engine records the pair without choosing; these tests
 * pin the pair down so a renderer can rely on which side is which.
 */
/**
 * A unique constraint matched by its column list alone.
 *
 * Two constraints over the same columns under different names are taken to be
 * the same constraint — a reasonable rule, since the name is often generated.
 * But the column list is all the signature holds, so everything the rest of the
 * definition says (DEFERRABLE, NULLS NOT DISTINCT, INCLUDE) was thrown away
 * with it, and a real difference produced an empty migration.
 */
describe("compareSchemas — unique constraints matched by column list", () => {
  function uniqueOn(name: string, definition: string): ConstraintSnapshot {
    return { name, kind: "UNIQUE", columns: ["email"], definition, normalizedDefinition: definition };
  }

  function diffsFor(left: ConstraintSnapshot, right: ConstraintSnapshot) {
    const report = compareSchemas(
      schema([table("customers", [column("email")], { uniqueConstraints: [left] })]),
      schema([table("customers", [column("email")], { uniqueConstraints: [right] })])
    );
    return report.matchedTables[0].constraintDiffs;
  }

  it("reports a definition difference under another name", () => {
    const diffs = diffsFor(
      uniqueOn("customers_email_unique", "UNIQUE NULLS NOT DISTINCT (email)"),
      uniqueOn("customers_email_key", "UNIQUE (email)")
    );
    expect(diffs).toEqual([
      {
        kind: "UNIQUE",
        status: "changedDefinition",
        summary: "Unique constraint customers_email_unique changed definition.",
        leftName: "customers_email_unique",
        rightName: "customers_email_key",
      },
    ]);
  });

  it("reports INCLUDE columns the signature cannot see", () => {
    const diffs = diffsFor(
      uniqueOn("customers_email_unique", "UNIQUE (email) INCLUDE (full_name)"),
      uniqueOn("customers_email_key", "UNIQUE (email)")
    );
    expect(diffs.map((d) => d.status)).toEqual(["changedDefinition"]);
  });

  it("still says nothing when only the name differs", () => {
    // The whole point of matching on the column list: a generated name is not
    // a difference anybody wants a migration for.
    expect(
      diffsFor(
        uniqueOn("customers_email_unique", "UNIQUE (email)"),
        uniqueOn("customers_email_key", "UNIQUE (email)")
      )
    ).toEqual([]);
  });
});

describe("compareSchemas — the pair behind a changed column", () => {
  it("records the source value as left and the target value as right", () => {
    const report = compareSchemas(
      schema([table("customers", [column("full_name", { typeDisplay: "character varying(200)" })])]),
      schema([table("customers", [column("full_name", { typeDisplay: "character varying(120)" })])])
    );
    const [change] = report.matchedTables[0].columnMatches[0].changes;

    expect(change.kind).toBe("size");
    expect(change.label).toBe("Size/precision");
    expect(change.leftValue).toBe("character varying(200)");
    expect(change.rightValue).toBe("character varying(120)");
  });

  it("records the pair for a nullability change too", () => {
    const report = compareSchemas(
      schema([table("orders", [column("note", { nullable: false })])]),
      schema([table("orders", [column("note", { nullable: true })])])
    );
    const change = report.matchedTables[0].columnMatches[0].changes.find(
      (c) => c.kind === "nullability"
    );

    expect(change?.leftValue).toBe("not null");
    expect(change?.rightValue).toBe("nullable");
  });
});
