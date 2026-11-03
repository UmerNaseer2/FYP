// generate-sql: names with line breaks must stay inside their comments.
//
// Every statement in a generated script is preceded by a `--` comment that
// names what it changes, and the header names both schemas. PostgreSQL ends a
// `--` comment at a line break, either \n or \r. Names come from the databases
// being compared, and a quoted name may hold a line break, so a table called
// `x<newline>DROP TABLE customers;--` used to put `DROP TABLE customers;` on a
// line of its own, outside the comment, where it would run with the script.
//
// The check reads the rendered script the way PostgreSQL does: comments,
// strings and quoted names are blanked out (maskNonCode), and the hostile text
// must not be left in what remains.
import { compareSchemas } from "@/lib/compare";
import {
  generateMigration,
  generateRollback,
  renderMigrationScript,
  renderRollbackScript,
} from "@/lib/generate-sql";
import { maskNonCode } from "@/lib/sql-guard";
import { column, schema, table } from "./helpers/snapshots";

const PAYLOAD = "DROP TABLE customers";

/** The parts of a script PostgreSQL would run, with comments and quotes blanked. */
function codeOnly(sql: string): string {
  return maskNonCode(sql);
}

describe.each([
  ["a newline", "\n"],
  ["a carriage return", "\r"],
  ["a CRLF pair", "\r\n"],
])("a name containing %s", (_label, breakChars) => {
  const hostile = `evil${breakChars}${PAYLOAD};--`;

  it("keeps a new table's name inside its comment in the migration", () => {
    const report = compareSchemas(
      schema([table(hostile, [column("id", { nullable: false })])]),
      schema([]),
    );
    const sql = renderMigrationScript(generateMigration(report));

    // The name is still in the script, so the reader can see what is made.
    expect(sql).toContain(PAYLOAD);
    expect(codeOnly(sql)).not.toContain(PAYLOAD);
  });

  it("keeps a held-back drop commented out in safe mode", () => {
    // The target has a table the source lacks, so the migration drops it, and
    // safe mode turns the drop into comment lines. A lone \r inside the quoted
    // name used to end the comment early, so the rest of the line ran.
    const report = compareSchemas(
      schema([]),
      schema([table(hostile, [column("id", { nullable: false })])]),
    );
    const sql = renderMigrationScript(generateMigration(report));

    expect(sql).toContain("NOT EXECUTED");
    expect(codeOnly(sql)).not.toContain(PAYLOAD);
    expect(codeOnly(sql)).not.toMatch(/\bDROP\b/);
  });

  it("keeps a new column's name inside its comment", () => {
    const report = compareSchemas(
      schema([table("orders", [column("id", { nullable: false }), column(hostile)])]),
      schema([table("orders", [column("id", { nullable: false })])]),
    );
    const sql = renderMigrationScript(generateMigration(report));

    expect(sql).toContain(PAYLOAD);
    expect(codeOnly(sql)).not.toContain(PAYLOAD);
  });

  it("keeps both schema names inside the header", () => {
    const report = compareSchemas(
      schema([table("orders", [column("id", { nullable: false })])], { schema: hostile }),
      schema([], { schema: `target${breakChars}${PAYLOAD};--` }),
    );
    const migration = renderMigrationScript(generateMigration(report));
    const rollback = renderRollbackScript(generateRollback(report));

    expect(codeOnly(migration)).not.toContain(PAYLOAD);
    expect(codeOnly(rollback)).not.toContain(PAYLOAD);
  });

  it("keeps the rollback's comments closed too", () => {
    // The rollback is the migration run backwards: the table the migration
    // creates is dropped, and the one it drops comes back. Both are named in
    // the rollback's comments and header lists.
    const report = compareSchemas(
      schema([table(hostile, [column("id", { nullable: false })])]),
      schema([table(`old${breakChars}${PAYLOAD};--`, [column("id", { nullable: false })])]),
    );
    const sql = renderRollbackScript(generateRollback(report, { allowDataLoss: true }));

    expect(sql).toContain(PAYLOAD);
    expect(codeOnly(sql)).not.toContain(PAYLOAD);
  });
});

describe("a default holding a line break", () => {
  it("keeps the MANUAL note about it on one line", () => {
    // A nextval() default the generator cannot read as a sequence becomes a
    // MANUAL note that quotes the default, and the default is text from the
    // source database.
    const odd = `nextval(f()\n${PAYLOAD})`;
    const report = compareSchemas(
      schema([table("orders", [column("id", { nullable: false, columnDefault: odd })])]),
      schema([table("orders", [column("id", { nullable: false })])]),
    );
    const sql = renderMigrationScript(generateMigration(report));

    expect(sql).toContain("MANUAL");
    expect(sql).toContain(PAYLOAD);
    expect(codeOnly(sql)).not.toContain(PAYLOAD);
  });
});
