// generate-sql: what the rollback header is allowed to promise.
//
// A "lossless" rollback header says, in as many words, that running the script
// "restores the target exactly as it was". That sentence is the reason somebody
// runs a down script without reading it, so it has to be earned.
//
// It was earned on three checks — nothing recreated empty, nothing dropped that
// could hold new rows, no truncating cast — and two ways of coming back short
// slipped through both. A `-- MANUAL:` note is a sentence, not a statement, so
// the work it describes simply does not happen. A recreated sequence comes back
// at its START WITH value rather than the number it had reached, which is the
// one thing about a sequence anybody cares about.
import { compareSchemas } from "@/lib/compare";
import { generateRollback, renderRollbackScript } from "@/lib/generate-sql";
import { column, schema, table } from "./helpers/snapshots";
import type { SchemaSnapshot, SequenceSnapshot, TypeSnapshot } from "@/lib/postgres";

/**
 * Roll back the migration that would turn `target` into `source`.
 *
 * Same argument order as generateMigration: the first schema is the desired
 * state the forward script moves towards, the second is what the database has.
 */
function rollback(source: SchemaSnapshot, target: SchemaSnapshot) {
  return generateRollback(compareSchemas(source, target));
}

/** An enum, with only the fields the generator reads spelled out. */
function enumType(name: string, labels: string[]): TypeSnapshot {
  return {
    name,
    kind: "ENUM",
    labels,
    baseType: null,
    notNull: false,
    checks: [],
    attributes: [],
    // Derived from the labels, because the comparator diffs types on their
    // normalized definition: two enums sharing one would compare identical
    // however differently they were spelled out above.
    definition: `CREATE TYPE ${name} AS ENUM (${labels.map((l) => `'${l}'`).join(", ")});`,
    normalizedDefinition: `enum:${labels.join(",")}`,
  };
}

/** A standalone sequence — one no column owns, so it is created in its own right. */
function sequence(name: string, startValue = "1"): SequenceSnapshot {
  return {
    name,
    ownedByTable: null,
    ownedByColumn: null,
    dataType: "bigint",
    startValue,
    increment: "1",
    minValue: "1",
    maxValue: "9223372036854775807",
    cycles: false,
    cacheSize: "1",
  };
}

/** One table, unchanged on both sides, so the tables contribute nothing. */
const unchanged = [table("orders", [column("id", { nullable: false })])];

describe("a rollback with a step no DDL can express", () => {
  // The migration adds an enum value. Undoing that means REMOVING one, which
  // PostgreSQL has no statement for, so the rollback can only describe it.
  const source = schema(unchanged, { types: [enumType("mood", ["happy", "sad", "livid"])] });
  const target = schema(unchanged, { types: [enumType("mood", ["happy", "sad"])] });

  it("is not called lossless", () => {
    const script = rollback(source, target);

    // The statements really are inert, which is exactly why the header must
    // not say the target comes back the way it was.
    expect(script.statements.some((s) => s.kind === "MANUAL")).toBe(true);
    expect(script.lossless).toBe(false);
  });

  it("says the work is left undone, and that it has to be done by hand", () => {
    const script = rollback(source, target);
    const warning = script.warnings.find((w) => w.includes("MANUAL"));

    expect(warning).toBeDefined();
    expect(warning).toContain("leaves that work undone");
    expect(warning).toContain("by hand");
  });

  it("keeps the promise out of the rendered header", () => {
    const text = renderRollbackScript(rollback(source, target));

    expect(text).not.toContain("restores the target exactly as it was");
    expect(text).toContain("THIS RESTORES STRUCTURE, NOT DATA.");
  });
});

describe("a rollback that recreates a sequence", () => {
  // The migration dropped a standalone sequence, so the rollback creates it
  // again — from its configured start, because where it had got to was never
  // captured and could not have been restored from a capture anyway.
  const source = schema(unchanged, { sequences: [] });
  const target = schema(unchanged, { sequences: [sequence("invoice_no", "1")] });

  it("is not called lossless", () => {
    const script = rollback(source, target);

    expect(script.statements.some((s) => s.kind === "CREATE_SEQUENCE")).toBe(true);
    expect(script.lossless).toBe(false);
  });

  it("warns that the next value is not where it was", () => {
    const script = rollback(source, target);
    const warning = script.warnings.find((w) => w.includes("sequence"));

    expect(warning).toBeDefined();
    // The consequence, not just the fact: a sequence rewound below the rows
    // already in the table hands out ids that are taken.
    expect(warning).toContain("START WITH");
    expect(warning).toContain("setval()");
    expect(warning).toContain("collides");
  });
});

describe("a rollback that really does restore everything", () => {
  it("still gets to say so", () => {
    // Dropping a view the migration created puts the target back exactly: a
    // view holds no rows of its own. Nothing here should have changed, and a
    // fix that made every rollback "not lossless" would be no fix at all.
    const source = schema(unchanged, {
      views: [
        {
          name: "recent_orders",
          materialized: false,
          dependsOn: [],
          definition: " SELECT id FROM orders;",
          normalizedDefinition: "select id from orders",
          columns: ["id"],
        },
      ],
    });
    const target = schema(unchanged, { views: [] });
    const script = rollback(source, target);

    expect(script.lossless).toBe(true);
    expect(renderRollbackScript(script)).toContain("restores the target exactly as it was");
  });
});
