// generate-sql: safe mode must not drop what a held-back column still needs.
//
// Safe mode comments out every DROP COLUMN and DROP TABLE, so the column or
// table stays. The type, sequence or function that only that column used is
// gone from the source too, and its drop is not destructive, so it stayed
// live. PostgreSQL then refused the script: "cannot drop type order_status
// because other objects depend on it". The safest mode wrote a script that
// could not run.
//
// These tests pin the fix: such a drop is held back beside the column or
// table that needs it, and nothing else is.
import { compareSchemas } from "@/lib/compare";
import {
  generateMigration,
  renderMigrationScript,
  statementsThatRun,
  type MigrationScript,
} from "@/lib/generate-sql";
import { column, schema, table } from "./helpers/snapshots";
import type {
  ConstraintSnapshot,
  RoutineSnapshot,
  SchemaSnapshot,
  SequenceSnapshot,
  TypeSnapshot,
} from "@/lib/postgres";

/** An enum type as the catalog records it. */
function enumType(name: string): TypeSnapshot {
  return {
    name,
    kind: "ENUM",
    labels: ["a", "b"],
    baseType: null,
    notNull: false,
    checks: [],
    attributes: [],
    definition: "ENUM (a, b)",
    normalizedDefinition: "ENUM (a, b)",
  };
}

/** A sequence nothing owns, as CREATE SEQUENCE makes it. */
function freeSequence(name: string): SequenceSnapshot {
  return {
    name,
    dataType: "bigint",
    startValue: "1",
    increment: "1",
    minValue: "1",
    maxValue: "9223372036854775807",
    cycles: false,
    cacheSize: "1",
    ownedByTable: null,
    ownedByColumn: null,
  };
}

/** A one-argument SQL function returning boolean. */
function routine(name: string): RoutineSnapshot {
  const definition = `CREATE OR REPLACE FUNCTION ${name}(integer)\n RETURNS boolean\n LANGUAGE sql\nAS $function$SELECT $1 > 0$function$`;
  return {
    name,
    kind: "FUNCTION",
    identityArguments: "integer",
    signature: `${name}(integer)`,
    returnType: "boolean",
    argumentNames: [],
    language: "sql",
    definition,
    normalizedDefinition: definition,
  };
}

/** A CHECK constraint as the catalog records it. */
function check(name: string, definition: string): ConstraintSnapshot {
  return { name, kind: "CHECK", columns: [], definition, normalizedDefinition: definition };
}

const id = () => column("id", { nullable: false, isPrimaryKey: true });

function migration(source: SchemaSnapshot, target: SchemaSnapshot, allowDataLoss = false) {
  return generateMigration(compareSchemas(source, target), { allowDataLoss });
}

/** The statements that will really run, as one string. */
function running(script: MigrationScript): string {
  return statementsThatRun(script)
    .map((statement) => statement.sql)
    .join("\n");
}

describe("safe mode and a drop that a held-back column still needs", () => {
  it("holds back the type of a column whose drop is held back", () => {
    const source = schema([table("orders", [id()])], { types: [] });
    const target = schema(
      [table("orders", [id(), column("status", { typeDisplay: "order_status" })])],
      { types: [enumType("order_status")] }
    );

    const script = migration(source, target);

    expect(running(script)).not.toContain("DROP TYPE");
    expect(renderMigrationScript(script)).toContain('-- DROP TYPE IF EXISTS "order_status";');
    expect(script.warnings.join("\n")).toMatch(/1 drop of a type, sequence, function or collation/);
  });

  it("holds back the sequence a held-back column's default reads", () => {
    const source = schema([table("tickets", [id()])], { sequences: [] });
    const target = schema(
      [
        table("tickets", [
          id(),
          column("num", {
            typeDisplay: "bigint",
            columnDefault: "nextval('ticket_seq'::regclass)",
          }),
        ]),
      ],
      { sequences: [freeSequence("ticket_seq")] }
    );

    const script = migration(source, target);

    expect(running(script)).not.toContain("DROP SEQUENCE");
    expect(renderMigrationScript(script)).toContain('-- DROP SEQUENCE IF EXISTS "ticket_seq"');
  });

  it("holds back the function a held-back table's CHECK calls", () => {
    const source = schema([table("keep", [id()])], { routines: [] });
    const target = schema(
      [
        table("keep", [id()]),
        table("extra", [id(), column("n")], {
          checkConstraints: [check("extra_n_check", "CHECK (is_ok(n))")],
        }),
      ],
      { routines: [routine("is_ok")] }
    );

    const script = migration(source, target);

    expect(running(script)).not.toContain("DROP FUNCTION");
    expect(renderMigrationScript(script)).toContain('-- DROP FUNCTION IF EXISTS "is_ok"(integer);');
  });

  it("still drops a type that nothing left in place uses", () => {
    const source = schema([table("orders", [id()])], { types: [] });
    const target = schema(
      [table("orders", [id(), column("status", { typeDisplay: "order_status" })])],
      { types: [enumType("order_status"), enumType("unused_kind")] }
    );

    const script = migration(source, target);

    expect(running(script)).toContain('DROP TYPE IF EXISTS "unused_kind";');
    expect(running(script)).not.toContain('"order_status"');
  });

  it("holds nothing back once data loss is allowed", () => {
    const source = schema([table("orders", [id()])], { types: [] });
    const target = schema(
      [table("orders", [id(), column("status", { typeDisplay: "order_status" })])],
      { types: [enumType("order_status")] }
    );

    const script = migration(source, target, true);
    const text = running(script);

    // The column goes first, then the type it used.
    expect(text.indexOf("DROP COLUMN")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('DROP TYPE IF EXISTS "order_status";')).toBeGreaterThan(
      text.indexOf("DROP COLUMN")
    );
    expect(script.warnings.join("\n")).not.toMatch(/drop of a type, sequence, function/);
  });
});
