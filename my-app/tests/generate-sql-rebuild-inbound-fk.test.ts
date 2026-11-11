// generate-sql: a column rebuild must not lose the keys other tables point at it.
//
// PostgreSQL cannot change a GENERATED ALWAYS AS (...) clause in place, so the
// generator rebuilds the column: DROP COLUMN ... CASCADE, then ADD COLUMN.
// When another table has a foreign key to that column (through a UNIQUE key on
// it), the CASCADE drops that foreign key as well. The key is identical in both
// schemas, so it is in no diff and nothing put it back. The script finished,
// and the other table quietly accepted rows that point at nothing.
//
// Checked on a real PostgreSQL 18 while fixing it: before, orders lost
// orders_product_code_fkey and took an orphan row; after, the key is back, an
// orphan is refused, and a rebuild whose new values would orphan existing rows
// makes the whole script fail instead of finishing.
import { compareSchemas } from "@/lib/compare";
import {
  generateMigration,
  generateRollback,
  renderMigrationScript,
  statementsThatRun,
  type MigrationOptions,
} from "@/lib/generate-sql";
import type { ColumnSnapshot, ConstraintSnapshot, ForeignKeySnapshot, SchemaSnapshot } from "@/lib/postgres";
import { column, schema, table } from "./helpers/snapshots";

function migration(source: SchemaSnapshot, target: SchemaSnapshot, options: MigrationOptions = {}) {
  return generateMigration(compareSchemas(source, target), options);
}

const unique = (name: string, columns: string[]): ConstraintSnapshot => ({
  name,
  kind: "UNIQUE",
  columns,
  definition: `UNIQUE (${columns.map((c) => `"${c}"`).join(", ")})`,
  normalizedDefinition: `unique (${columns.join(", ")})`,
});

const fk = (name: string, refColumn: string): ForeignKeySnapshot => ({
  name,
  kind: "FOREIGN KEY",
  columns: ["product_code"],
  definition: `FOREIGN KEY (product_code) REFERENCES products(${refColumn})`,
  normalizedDefinition: `foreign key (product_code) references products(${refColumn})`,
  referencedSchema: "public",
  referencedTable: "products",
  referencedColumns: [refColumn],
  onUpdate: "NO ACTION",
  onDelete: "NO ACTION",
});

const stored = (expression: string): Partial<ColumnSnapshot> => ({
  generated: { storage: "STORED", expression },
});

/**
 * products, with a UNIQUE "code" (or whatever `codeName` says) built as `code`
 * says, and orders pointing at it. `keyed: false` leaves the UNIQUE off.
 */
function shop(
  code: Partial<ColumnSnapshot>,
  options: { codeName?: string; keyed?: boolean; alsoLines?: boolean } = {}
): SchemaSnapshot {
  const codeName = options.codeName ?? "code";
  const keyed = options.keyed ?? true;
  const pointing = (tableName: string) =>
    table(tableName, [column("id", { nullable: false }), column("product_code", { typeDisplay: "text" })], {
      foreignKeys: [fk("fk_product", codeName)],
    });
  return schema([
    table(
      "products",
      [
        column("id", { nullable: false }),
        column("name", { typeDisplay: "text" }),
        column(codeName, { typeDisplay: "text", ...code }),
      ],
      { uniqueConstraints: keyed ? [unique("products_code_key", [codeName])] : [] }
    ),
    pointing("orders"),
    ...(options.alsoLines ? [pointing("order_lines")] : []),
  ]);
}

/** Where in the running statements a pattern first appears, or -1. */
function position(sql: string[], pattern: RegExp): number {
  return sql.findIndex((text) => pattern.test(text));
}

describe("rebuilding a column another table points at", () => {
  it("takes the other table's key off by name and puts it back at the end", () => {
    // Ordinary in the target, computed in the source: a rebuild that loses the
    // typed values, so it only runs with data loss allowed.
    const script = migration(shop(stored("upper(name)")), shop({ generated: null }), { allowDataLoss: true });
    const sql = statementsThatRun(script).map((s) => s.sql);

    const dropFk = position(sql, /"orders" DROP CONSTRAINT IF EXISTS "fk_product"/);
    const dropColumn = position(sql, /"products" DROP COLUMN IF EXISTS "code" CASCADE/);
    const addColumn = position(sql, /"products" ADD COLUMN IF NOT EXISTS "code"/);
    const addKey = position(sql, /"products" ADD CONSTRAINT "products_code_key"/);
    // The key goes back in PostgreSQL's own words (the snapshot's definition).
    const addFk = position(sql, /"orders" ADD CONSTRAINT "fk_product" FOREIGN KEY \(product_code\) REFERENCES products\(code\)/);

    expect(dropFk).toBeGreaterThan(-1);
    expect(dropFk).toBeLessThan(dropColumn);
    expect(addColumn).toBeGreaterThan(dropColumn);
    expect(addKey).toBeGreaterThan(addColumn);
    expect(addFk).toBeGreaterThan(addKey);

    const described = script.statements.find((s) => s.sql.includes('"orders" DROP CONSTRAINT'));
    expect(described?.description).toContain('points at "code" on "products"');
  });

  it("holds the key drop back whenever safe mode holds the column drop back", () => {
    // Safe mode comments out the data-losing DROP COLUMN. Taking the key off
    // anyway would leave orders unchecked beside a column that never moved.
    const script = migration(shop(stored("upper(name)")), shop({ generated: null }));
    const running = statementsThatRun(script).map((s) => s.sql);
    expect(position(running, /DROP COLUMN IF EXISTS "code"/)).toBe(-1);
    expect(position(running, /"orders" DROP CONSTRAINT IF EXISTS "fk_product"/)).toBe(-1);
    expect(renderMigrationScript(script)).toContain('-- ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "fk_product";');
  });

  it("drops and restores the key when only the expression changes", () => {
    // Both sides compute it, so the rebuild loses nothing and runs in safe mode.
    const script = migration(shop(stored("upper(name)")), shop(stored("lower(name)")));
    const sql = statementsThatRun(script).map((s) => s.sql);
    expect(position(sql, /"orders" DROP CONSTRAINT IF EXISTS "fk_product"/)).toBeGreaterThan(-1);
    expect(position(sql, /"orders" ADD CONSTRAINT "fk_product"/)).toBeGreaterThan(
      position(sql, /"products" ADD COLUMN IF NOT EXISTS "code"/)
    );
  });

  it("puts the key back on every table that had one, even when the names match", () => {
    // Constraint names are only unique per table: orders and order_lines both
    // call theirs fk_product, and both are taken by the CASCADE.
    const script = migration(
      shop(stored("upper(name)"), { alsoLines: true }),
      shop({ generated: null }, { alsoLines: true }),
      { allowDataLoss: true }
    );
    const sql = statementsThatRun(script).map((s) => s.sql);
    expect(position(sql, /"orders" ADD CONSTRAINT "fk_product"/)).toBeGreaterThan(-1);
    expect(position(sql, /"order_lines" ADD CONSTRAINT "fk_product"/)).toBeGreaterThan(-1);
  });

  it("names the column by its new name when the rebuild also renames it", () => {
    // code becomes codes and turns computed. The key goes back on pointing at
    // "codes"; pointing at "code" would fail, as that column is gone.
    const script = migration(
      shop(stored("upper(name)"), { codeName: "codes" }),
      shop({ generated: null }),
      { allowDataLoss: true }
    );
    const sql = statementsThatRun(script).map((s) => s.sql);
    expect(position(sql, /RENAME COLUMN "code" TO "codes"/)).toBeGreaterThan(-1);
    expect(position(sql, /"orders" ADD CONSTRAINT "fk_product" FOREIGN KEY \(product_code\) REFERENCES products\(codes\)/)).toBeGreaterThan(-1);
  });

  it("drops the key once and leaves it off when the source has no key to point at", () => {
    // The source drops the UNIQUE as well. The key drop is wanted twice (by
    // the rebuild and by the UNIQUE going) but written once, and it cannot go
    // back on: there is nothing unique left for it to point at.
    const script = migration(shop(stored("upper(name)"), { keyed: false }), shop({ generated: null }), {
      allowDataLoss: true,
    });
    const sql = statementsThatRun(script).map((s) => s.sql);
    expect(sql.filter((text) => /"orders" DROP CONSTRAINT IF EXISTS "fk_product"/.test(text))).toHaveLength(1);
    expect(position(sql, /"orders" ADD CONSTRAINT "fk_product"/)).toBe(-1);
  });

  it("restores the key in the rollback too", () => {
    // The migration turns a computed column ordinary (DROP EXPRESSION, no
    // rebuild). Undoing it makes the column computed again, which is a rebuild.
    const report = compareSchemas(shop({ generated: null }), shop(stored("upper(name)")));
    // Every statement, in order: a rollback decides for itself which of its
    // data-losing steps it runs, so this only checks what it writes and where.
    const sql = generateRollback(report, { allowDataLoss: true }).statements.map((s) => s.sql);
    expect(position(sql, /"orders" DROP CONSTRAINT IF EXISTS "fk_product"/)).toBeGreaterThan(-1);
    expect(position(sql, /"orders" DROP CONSTRAINT IF EXISTS "fk_product"/)).toBeLessThan(
      position(sql, /"products" DROP COLUMN IF EXISTS "code" CASCADE/)
    );
    expect(position(sql, /"products" DROP COLUMN IF EXISTS "code" CASCADE/)).toBeGreaterThan(-1);
    expect(position(sql, /"orders" ADD CONSTRAINT "fk_product"/)).toBeGreaterThan(
      position(sql, /"products" DROP COLUMN IF EXISTS "code" CASCADE/)
    );
  });
});
