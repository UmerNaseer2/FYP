// generate-sql: a name the script needs while the target still has it.
//
// Tables, views, sequences and indexes share one set of names in a schema, and
// every primary key and unique key has an index of its own name. A client
// tester renamed a table in staging. The table kept its key name, "b_pkey",
// and the script made the new table before it dropped the old one, so
// PostgreSQL refused the deploy: relation "b_pkey" already exists.
//
// These tests pin how the script frees such names and in what order. The same
// cases run for real, with safe mode, a second run and the rollback, in
// tests/generate-sql-db-name-clashes.test.ts.
import { compareSchemas } from "@/lib/compare/diff";
import { generateMigration, renderMigrationScript } from "@/lib/sql/generate";
import { withSuffix } from "@/lib/sql/generate/name-clashes";
import { column, schema, table } from "./helpers/snapshots";
import type { ColumnSnapshot, ConstraintSnapshot, SchemaSnapshot, SequenceSnapshot, TableSnapshot } from "@/lib/postgres";

function key(kind: "PRIMARY KEY" | "UNIQUE", name: string, columns: string[]): ConstraintSnapshot {
  const definition = `${kind} (${columns.join(", ")})`;
  return { name, kind, columns, definition, normalizedDefinition: definition };
}

/** A sequence as the catalog records it, tied to `owner` ("table.column") or to nothing. */
function sequence(name: string, owner: string | null = null): SequenceSnapshot {
  const [ownedByTable, ownedByColumn] = owner === null ? [null, null] : owner.split(".");
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
    ownedByColumn,
  };
}

/** An integer column that takes its values from `sequenceName`. */
function counter(name: string, sequenceName: string, over: Partial<ColumnSnapshot> = {}): ColumnSnapshot {
  return column(name, { nullable: false, columnDefault: `nextval('${sequenceName}'::regclass)`, ...over });
}

function id(over: Partial<ColumnSnapshot> = {}): ColumnSnapshot {
  return column("id", { nullable: false, isPrimaryKey: true, ...over });
}

function text(name: string): ColumnSnapshot {
  return column(name, { typeDisplay: "text" });
}

function keyed(name: string, keyName: string, columns: ColumnSnapshot[], over: Partial<TableSnapshot> = {}) {
  return table(name, columns, { primaryKey: key("PRIMARY KEY", keyName, ["id"]), ...over });
}

function generate(source: SchemaSnapshot, target: SchemaSnapshot, allowDataLoss = true) {
  const migration = generateMigration(compareSchemas(source, target), { allowDataLoss });
  return { script: renderMigrationScript(migration), warnings: migration.warnings };
}

/** Where a fragment sits in the script. Fails loudly when it is not there. */
function at(script: string, fragment: string | RegExp): number {
  const index = typeof fragment === "string" ? script.indexOf(fragment) : script.search(fragment);
  if (index < 0) throw new Error(`not in the script: ${fragment}`);
  return index;
}

const CREATE_A = /CREATE TABLE[^\n]*"a"/;
const DROP_B = /DROP TABLE[^\n]*"b"/;

describe("a key name the script needs while the target still has it", () => {
  // Staging renamed "b" to "a" and gave it new columns: the key kept its name.
  const source = () => schema([keyed("a", "b_pkey", [id(), text("x"), text("z")])]);
  const target = () => schema([keyed("b", "b_pkey", [id(), text("y")])]);

  it("moves the old key aside before the new table is made, and drops the old table after", () => {
    const { script } = generate(source(), target());

    const moveAside = at(script, 'ALTER INDEX "b_pkey" RENAME TO "b_pkey_old";');
    expect(moveAside).toBeLessThan(at(script, CREATE_A));
    expect(at(script, DROP_B)).toBeGreaterThan(at(script, CREATE_A));
  });

  it("guards the move by the table, so a second run leaves the new key alone", () => {
    const { script } = generate(source(), target());

    expect(script).toMatch(
      /IF EXISTS \([^\n]*'"b"'[^\n]*\) THEN\n\s*ALTER INDEX "b_pkey" RENAME TO "b_pkey_old";/
    );
  });

  it("still moves it in safe mode, which keeps the old table, and says so", () => {
    const { script, warnings } = generate(source(), target(), false);

    expect(at(script, 'ALTER INDEX "b_pkey" RENAME TO "b_pkey_old";')).toBeLessThan(at(script, CREATE_A));
    expect(warnings.join("\n")).toContain('safe mode keeps it, so its "b_pkey" is renamed to "b_pkey_old"');
  });

  it("parks a unique key that moves to another kept table, and drops it under its parked name", () => {
    const { script } = generate(
      schema([
        table("t1", [id(), text("code")]),
        table("t2", [id(), text("code")], { uniqueConstraints: [key("UNIQUE", "t1_code_key", ["code"])] }),
      ]),
      schema([
        table("t1", [id(), text("code")], { uniqueConstraints: [key("UNIQUE", "t1_code_key", ["code"])] }),
        table("t2", [id(), text("code")]),
      ])
    );

    const moveAside = at(script, 'ALTER INDEX "t1_code_key" RENAME TO "t1_code_key_old";');
    expect(moveAside).toBeLessThan(at(script, /ADD CONSTRAINT "t1_code_key" UNIQUE/));
    expect(script).toMatch(/DROP CONSTRAINT IF EXISTS "t1_code_key_old"/);
    expect(script).not.toMatch(/DROP CONSTRAINT IF EXISTS "t1_code_key"[^_]/);
  });

  it("gives a kept key the source's name first when a new table wants its old one", () => {
    const { script } = generate(
      schema([keyed("t", "t_pk", [id()]), keyed("u", "t_pkey", [id()])]),
      schema([keyed("t", "t_pkey", [id()])])
    );

    expect(at(script, 'ALTER INDEX "t_pkey" RENAME TO "t_pk";')).toBeLessThan(at(script, /CREATE TABLE[^\n]*"u"/));
  });

  it("cuts a parked name to PostgreSQL's 63 bytes between characters", () => {
    expect(withSuffix("k_" + "x".repeat(60), "_old")).toBe("k_" + "x".repeat(57) + "_old");
    expect(withSuffix("é".repeat(40), "_old")).toBe("é".repeat(29) + "_old");
    expect(withSuffix("short", "_old")).toBe("short_old");
  });
});

describe("a sequence name the script needs while the target still has it", () => {
  it("parks the identity sequence of a dropped table whose name the new table wants", () => {
    const identity = { identity: "ALWAYS" as const };
    const { script } = generate(
      schema([keyed("a", "a_pkey", [id(identity), text("x")])], { sequences: [sequence("b_id_seq", "a.id")] }),
      schema([keyed("b", "b_pkey", [id(identity), text("y")])], { sequences: [sequence("b_id_seq", "b.id")] })
    );

    expect(script).toMatch(
      /deptype IN \('a', 'i'\)[^\n]*\) THEN\n\s*ALTER SEQUENCE "b_id_seq" RENAME TO "b_id_seq_old";/
    );
    expect(at(script, 'ALTER SEQUENCE "b_id_seq" RENAME TO "b_id_seq_old";')).toBeLessThan(at(script, CREATE_A));
  });

  it("guards the rename of a kept table's own sequence by who owns it", () => {
    const { script } = generate(
      schema([keyed("customers", "customers_pkey", [counter("id", "customers_id_seq", { isPrimaryKey: true }), text("name")])], {
        sequences: [sequence("customers_id_seq", "customers.id")],
      }),
      schema([keyed("customer", "customer_pkey", [counter("id", "customer_id_seq", { isPrimaryKey: true }), text("name")])], {
        sequences: [sequence("customer_id_seq", "customer.id")],
      })
    );

    expect(script).toMatch(
      /IF EXISTS \(SELECT 1 FROM pg_depend [^\n]*'"customer_id_seq"'[^\n]*'"customers"'[^\n]*deptype IN \('a', 'i'\)\) THEN\n\s*ALTER SEQUENCE "customer_id_seq" RENAME TO "customers_id_seq";/
    );
  });

  it("makes a sequence of its own only once the kept table's sequence has left that name", () => {
    // The way back from a renamed table: "customers_id_seq" is the table's own
    // sequence in the target and a sequence of its own in the source. CREATE
    // SEQUENCE IF NOT EXISTS would see the name taken and do nothing.
    const { script } = generate(
      schema([keyed("customer", "customer_pkey", [counter("id", "customer_id_seq", { isPrimaryKey: true }), text("name")])], {
        sequences: [sequence("customer_id_seq", "customer.id"), sequence("customers_id_seq")],
      }),
      schema([keyed("customers", "customer_pkey", [counter("id", "customers_id_seq", { isPrimaryKey: true }), text("name")])], {
        sequences: [sequence("customers_id_seq", "customers.id")],
      })
    );

    expect(at(script, 'CREATE SEQUENCE IF NOT EXISTS "customers_id_seq"')).toBeGreaterThan(
      at(script, 'ALTER SEQUENCE "customers_id_seq" RENAME TO "customer_id_seq";')
    );
  });

  it("keeps a sequence that a column reads on both sides, and says why", () => {
    const orders = () => table("orders", [id(), counter("ref", "customers_id_seq")]);
    const { script, warnings } = generate(
      schema([keyed("customers", "customers_pkey", [counter("id", "customers_id_seq", { isPrimaryKey: true }), text("name")]), orders()], {
        sequences: [sequence("customers_id_seq", "customers.id")],
      }),
      schema([keyed("customer", "customer_pkey", [counter("id", "customer_id_seq", { isPrimaryKey: true }), text("name")]), orders()], {
        sequences: [sequence("customer_id_seq", "customer.id"), sequence("customers_id_seq")],
      })
    );

    expect(script).not.toMatch(/DROP SEQUENCE IF EXISTS "customers_id_seq"/);
    expect(warnings.join("\n")).toContain('Sequence "customers_id_seq" is kept.');
  });

  it("moves an unused sequence of its own aside so a kept column's sequence can take its name", () => {
    // The target's "t"."id" reads "s2"; the source's reads "s". The loose "s"
    // in the target is read by nothing.
    const { script } = generate(
      schema([table("t", [counter("id", "s"), text("name")])], { sequences: [sequence("s", "t.id")] }),
      schema([table("t", [counter("id", "s2"), text("name")])], { sequences: [sequence("s2", "t.id"), sequence("s")] })
    );

    const park = at(script, 'ALTER SEQUENCE "s" RENAME TO "s_old";');
    const rename = at(script, 'ALTER SEQUENCE "s2" RENAME TO "s";');
    expect(park).toBeLessThan(rename);
    expect(at(script, 'DROP SEQUENCE IF EXISTS "s_old";')).toBeGreaterThan(rename);
  });

  it("leaves both alone when a column in the target reads the sequence of its own", () => {
    const reader = () => table("u", [id(), counter("x", "s")]);
    const { script } = generate(
      schema([table("t", [counter("id", "s"), text("name")]), reader()], { sequences: [sequence("s", "t.id")] }),
      schema([table("t", [counter("id", "s2"), text("name")]), reader()], {
        sequences: [sequence("s2", "t.id"), sequence("s")],
      })
    );

    expect(script).not.toContain('RENAME TO "s_old"');
    expect(script).not.toContain('ALTER SEQUENCE "s2" RENAME TO "s";');
    expect(script).not.toMatch(/DROP SEQUENCE IF EXISTS "s"/);
  });
});
