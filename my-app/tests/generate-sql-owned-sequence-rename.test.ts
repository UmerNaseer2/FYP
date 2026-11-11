// generate-sql: a renamed table takes the sequence behind its key with it.
//
// A serial or identity column owns a sequence named after the table:
// "customer_id_seq". When the source was built fresh under the new table name
// its sequence is "customers_id_seq", and the script went on to name that
// sequence (to set its owner, for one) straight after renaming the table.
// ALTER TABLE ... RENAME does not rename the sequence, so PostgreSQL refused
// the script with: relation "customers_id_seq" does not exist.
//
// These tests pin the fix: the sequence is renamed right after the table, and
// only when there is a rename to do and the new name is free.
import { compareSchemas } from "@/lib/compare";
import { generateMigration, renderMigrationScript } from "@/lib/generate-sql";
import { column, schema, table } from "./helpers/snapshots";
import type { ColumnSnapshot, SchemaSnapshot, SequenceSnapshot } from "@/lib/postgres";

/** A sequence as the catalog records it, owned by table.id when a table is named. */
function sequence(name: string, ownedByTable: string | null): SequenceSnapshot {
  return {
    name,
    dataType: "integer",
    startValue: "1",
    increment: "1",
    minValue: "1",
    maxValue: "2147483647",
    cycles: false,
    cacheSize: "1",
    ownedByTable,
    ownedByColumn: ownedByTable === null ? null : "id",
  };
}

/** The `id serial PRIMARY KEY` column of a table called `tableName`. */
function serialId(tableName: string): ColumnSnapshot {
  return column("id", {
    nullable: false,
    isPrimaryKey: true,
    columnDefault: `nextval('${tableName}_id_seq'::regclass)`,
  });
}

/** The `id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY` column. */
function identityId(): ColumnSnapshot {
  return column("id", { nullable: false, isPrimaryKey: true, identity: "ALWAYS" });
}

/** One table with a key column and a few ordinary ones, plus its sequence. */
function oneTable(
  tableName: string,
  id: ColumnSnapshot,
  extraSequences: SequenceSnapshot[] = []
): SchemaSnapshot {
  return schema(
    [
      table(tableName, [
        id,
        column("name", { typeDisplay: "text" }),
        column("email", { typeDisplay: "text" }),
        column("city", { typeDisplay: "text" }),
      ]),
    ],
    { sequences: [sequence(`${tableName}_id_seq`, tableName), ...extraSequences] }
  );
}

/** The generated script as one string, so ordering can be read off it. */
function sql(source: SchemaSnapshot, target: SchemaSnapshot): string {
  return renderMigrationScript(generateMigration(compareSchemas(source, target)));
}

/** Where a fragment sits in the script. Fails loudly when it is not there. */
function at(script: string, fragment: string): number {
  const index = script.indexOf(fragment);
  if (index < 0) throw new Error(`not in the script: ${fragment}`);
  return index;
}

const RENAME_TABLE = 'ALTER TABLE IF EXISTS "customer" RENAME TO "customers";';
const RENAME_SEQUENCE = 'ALTER SEQUENCE IF EXISTS "customer_id_seq" RENAME TO "customers_id_seq";';

describe("the sequence behind a renamed table's key", () => {
  it("is renamed right after the table when the key is serial", () => {
    const script = sql(
      oneTable("customers", serialId("customers")),
      oneTable("customer", serialId("customer"))
    );

    expect(at(script, RENAME_SEQUENCE)).toBeGreaterThan(at(script, RENAME_TABLE));
    // Every later line that names the new sequence comes after the rename.
    const firstUse = script.indexOf('"customers_id_seq"');
    expect(firstUse).toBeGreaterThan(at(script, RENAME_TABLE));
    expect(script.slice(0, at(script, RENAME_SEQUENCE))).not.toContain('SEQUENCE "customers_id_seq"');
  });

  it("is renamed when the key is an identity column", () => {
    const script = sql(oneTable("customers", identityId()), oneTable("customer", identityId()));

    expect(at(script, RENAME_SEQUENCE)).toBeGreaterThan(at(script, RENAME_TABLE));
  });

  it("is renamed when the table already has the new name but the sequence does not", () => {
    // A table renamed by hand keeps its old sequence name.
    const source = oneTable("customers", serialId("customers"));
    const target = schema(oneTable("customers", serialId("customer")).tables, {
      sequences: [sequence("customer_id_seq", "customers")],
    });

    const script = sql(source, target);

    expect(script).toContain(RENAME_SEQUENCE);
    expect(script).not.toContain("RENAME TO \"customers\";");
  });

  it("writes no sequence rename when the names already agree", () => {
    const script = sql(
      schema(
        [table("customers", [serialId("customers"), column("name", { typeDisplay: "text" })])],
        { sequences: [sequence("customers_id_seq", "customers")] }
      ),
      schema([table("customers", [serialId("customers")])], {
        sequences: [sequence("customers_id_seq", "customers")],
      })
    );

    expect(script).not.toContain("ALTER SEQUENCE IF EXISTS");
  });

  it("leaves the sequence alone when the target already uses the new name", () => {
    // Tables, views and sequences share one set of names: renaming onto a name
    // that is taken would fail, which is the thing this fix exists to stop.
    const script = sql(
      oneTable("customers", serialId("customers")),
      oneTable("customer", serialId("customer"), [sequence("customers_id_seq", null)])
    );

    expect(script).toContain(RENAME_TABLE);
    expect(script).not.toContain(RENAME_SEQUENCE);
  });
});
