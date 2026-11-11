import { compareSchemas } from "@/lib/compare";
import { generateMigration, statementsThatRun } from "@/lib/generate-sql";
import { column, schema, table } from "./helpers/snapshots";
import type { ConstraintSnapshot, ForeignKeySnapshot, IndexSnapshot } from "@/lib/postgres";

// Three things PostgreSQL is strict about when a key changes. The live suite
// (generate-sql-db.test.ts) runs each of them on a real server; these check
// the same scripts without one.

const primaryKey = (name: string, columns: string[]): ConstraintSnapshot => ({
  name,
  kind: "PRIMARY KEY",
  columns,
  definition: `PRIMARY KEY (${columns.join(", ")})`,
  normalizedDefinition: `primary key (${columns.join(", ")})`,
});

const unique = (name: string, columns: string[]): ConstraintSnapshot => ({
  name,
  kind: "UNIQUE",
  columns,
  definition: `UNIQUE (${columns.join(", ")})`,
  normalizedDefinition: `unique (${columns.join(", ")})`,
});

function sqlOf(source: ReturnType<typeof schema>, target: ReturnType<typeof schema>): string[] {
  const script = generateMigration(compareSchemas(source, target), { allowDataLoss: true });
  return statementsThatRun(script).map((s) => s.sql);
}

function position(sql: string[], text: string): number {
  return sql.findIndex((statement) => statement.includes(text));
}

describe("an index whose name a new key takes", () => {
  // The target has a plain unique index called users_email_key. The source has
  // a UNIQUE constraint of that name, and PostgreSQL backs it with an index of
  // the same name: "relation users_email_key already exists" unless the plain
  // index goes first.
  const plainIndex: IndexSnapshot = {
    name: "users_email_key",
    definition: "CREATE UNIQUE INDEX users_email_key ON users USING btree (email)",
    normalizedDefinition: "create unique index users_email_key on users using btree (email)",
    columns: ["email"],
    isUnique: true,
    method: "btree",
    predicate: null,
  };
  const columns = () => [column("id", { nullable: false }), column("email", { typeDisplay: "text" })];

  it("is dropped before the constraint is added", () => {
    const sql = sqlOf(
      schema([table("users", columns(), { uniqueConstraints: [unique("users_email_key", ["email"])], indexes: [] })]),
      schema([table("users", columns(), { indexes: [plainIndex] })])
    );
    const drop = position(sql, 'DROP INDEX IF EXISTS "users_email_key"');
    const add = position(sql, 'ADD CONSTRAINT "users_email_key"');
    expect(drop).toBeGreaterThan(-1);
    expect(add).toBeGreaterThan(drop);
  });

  it("is dropped before a new table that has the key is created", () => {
    const sql = sqlOf(
      schema([
        table("users", columns(), { indexes: [] }),
        table("people", columns(), { uniqueConstraints: [unique("users_email_key", ["email"])], indexes: [] }),
      ]),
      schema([table("users", columns(), { indexes: [plainIndex] })])
    );
    const drop = position(sql, 'DROP INDEX IF EXISTS "users_email_key"');
    const create = position(sql, 'CREATE TABLE IF NOT EXISTS "people"');
    expect(drop).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(drop);
  });

  it("stays with the other index work when no key takes its name", () => {
    const sql = sqlOf(
      schema([table("users", [...columns(), column("phone", { typeDisplay: "text" })], { indexes: [] })]),
      schema([table("users", columns(), { indexes: [plainIndex] })])
    );
    const drop = position(sql, 'DROP INDEX IF EXISTS "users_email_key"');
    const addColumn = position(sql, 'ADD COLUMN IF NOT EXISTS "phone"');
    expect(addColumn).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(addColumn);
  });
});

describe("a column that leaves the primary key and may be empty again", () => {
  // PostgreSQL refuses DROP NOT NULL while the column is still in the key:
  // "column b is in a primary key". The key has to go first.
  it("drops the old key before DROP NOT NULL", () => {
    const sql = sqlOf(
      schema([
        table("t", [column("a", { nullable: false }), column("b")], { primaryKey: primaryKey("t_pkey", ["a"]) }),
      ]),
      schema([
        table("t", [column("a", { nullable: false }), column("b", { nullable: false })], {
          primaryKey: primaryKey("t_pkey", ["a", "b"]),
        }),
      ])
    );
    const dropKey = position(sql, 'DROP CONSTRAINT IF EXISTS "t_pkey"');
    const dropNotNull = position(sql, 'ALTER COLUMN "b" DROP NOT NULL');
    const addKey = position(sql, 'ADD CONSTRAINT "t_pkey"');
    expect(dropKey).toBeGreaterThan(-1);
    expect(dropNotNull).toBeGreaterThan(dropKey);
    expect(addKey).toBeGreaterThan(dropNotNull);
  });
});

describe("a foreign key in the script", () => {
  // PostgreSQL's own text for the key is the only place that holds the column
  // list after SET NULL. Built from the snapshot's separate fields the script
  // wrote plain ON DELETE SET NULL: a different key, which empties tenant_id too.
  const definition =
    "FOREIGN KEY (tenant_id, author_id) REFERENCES users(tenant_id, id) ON DELETE SET NULL (author_id)";
  const key: ForeignKeySnapshot = {
    name: "posts_author_fk",
    kind: "FOREIGN KEY",
    columns: ["tenant_id", "author_id"],
    definition,
    normalizedDefinition: definition.toLowerCase(),
    referencedSchema: "public",
    referencedTable: "users",
    referencedColumns: ["tenant_id", "id"],
    onUpdate: "NO ACTION",
    onDelete: "SET NULL",
  };
  const users = () =>
    table("users", [column("tenant_id", { nullable: false }), column("id", { nullable: false })], {
      primaryKey: primaryKey("users_pkey", ["tenant_id", "id"]),
    });
  const postColumns = () => [column("id", { nullable: false }), column("tenant_id"), column("author_id")];

  it("is written as PostgreSQL describes it, on a changed table", () => {
    const sql = sqlOf(
      schema([users(), table("posts", postColumns(), { foreignKeys: [key] })]),
      schema([users(), table("posts", postColumns())])
    );
    expect(sql.join("\n")).toContain(`ADD CONSTRAINT "posts_author_fk" ${definition}`);
  });

  it("is written as PostgreSQL describes it, on a new table", () => {
    const sql = sqlOf(schema([users(), table("posts", postColumns(), { foreignKeys: [key] })]), schema([users()]));
    expect(sql.join("\n")).toContain(`ADD CONSTRAINT "posts_author_fk" ${definition}`);
  });

  it("is still built from the fields when the snapshot has no text for it", () => {
    const sql = sqlOf(
      schema([users(), table("posts", postColumns(), { foreignKeys: [{ ...key, definition: "" }] })]),
      schema([users()])
    );
    expect(sql.join("\n")).toContain(
      'ADD CONSTRAINT "posts_author_fk" FOREIGN KEY ("tenant_id", "author_id") REFERENCES "users" ("tenant_id", "id") ON DELETE SET NULL'
    );
  });
});
