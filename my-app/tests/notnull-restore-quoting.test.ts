// generate-sql: the NOT NULL restore block against names that fight back.
//
// Adding a NOT NULL column to a table that already holds rows is impossible —
// there is no value for the rows that are there — so the generator writes a DO
// block that puts the constraint back on an empty table and otherwise prints
// what to run after a backfill. That block embeds the table and column names
// twice: once in the notice text, once in the ALTER inside it.
//
// Two characters made it generate SQL that does not parse. `%` is RAISE
// NOTICE's placeholder, so a name containing one asked for a parameter that was
// never passed. `$$` was the block's own tag, so a name containing one closed
// the block on itself and left the remainder outside it. Neither is a name
// anybody would choose, and both are names PostgreSQL accepts, which is enough
// — a migration that aborts half way through is the most expensive kind.
import { compareSchemas } from "@/lib/compare";
import { generateMigration } from "@/lib/generate-sql";
import { column, schema, table } from "./helpers/snapshots";
import type { SqlStatement } from "@/lib/generate-sql";

/**
 * The DO block for a NOT NULL column being added to `tableName`.
 *
 * A new NOT NULL column with no default is exactly the "risky" case that makes
 * the generator write the block, so adding one to a table the target already
 * has is the shortest way to get one.
 */
function restoreBlock(tableName: string, columnName: string): SqlStatement {
  const script = generateMigration(
    compareSchemas(
      schema([
        table(tableName, [
          column("id", { nullable: false }),
          column(columnName, { typeDisplay: "text", nullable: false }),
        ]),
      ]),
      schema([table(tableName, [column("id", { nullable: false })])])
    )
  );
  const block = script.statements.find((s) => s.sql.startsWith("DO "));
  if (!block) throw new Error("no DO block was generated");
  return block;
}

/** The tag a `DO <tag>` block opens with. */
function openingTag(sql: string): string {
  const match = sql.match(/^DO (\$[^$]*\$)/);
  if (!match) throw new Error(`no dollar tag in: ${sql.slice(0, 40)}`);
  return match[1];
}

describe("a name containing a percent sign", () => {
  it("does not become part of the RAISE format string", () => {
    const block = restoreBlock("orders", "done_%");

    // The format string is a bare '%' and the message is the parameter. Put the
    // message in the format string instead and PostgreSQL counts the percent
    // signs, finds no arguments for them, and aborts the block.
    expect(block.sql).toContain("RAISE NOTICE '%',");
    const raiseLine = block.sql.split("\n").find((line) => line.includes("RAISE NOTICE"));
    expect(raiseLine).toBeDefined();
    // Exactly one % before the comma: the placeholder. Everything after the
    // comma is a quoted literal and is printed as-is.
    expect(raiseLine!.slice(0, raiseLine!.indexOf(",")).match(/%/g)).toHaveLength(1);
  });

  it("still names the column in the message it prints", () => {
    // The fix must not solve the problem by dropping the name — the notice
    // exists to tell the reader which column needs backfilling.
    const block = restoreBlock("orders", "done_%");

    expect(block.sql).toContain("done_%");
  });

  it("handles a percent in the table name too", () => {
    const block = restoreBlock("100%_done", "note");

    expect(block.sql).toContain("RAISE NOTICE '%',");
    expect(block.sql).toContain("100%_done");
  });
});

describe("a name containing a dollar-quote tag", () => {
  it("does not end the block early", () => {
    const block = restoreBlock("orders", "a$$b");
    const tag = openingTag(block.sql);

    // The name is inside the block, so the tag has to be something else.
    expect(tag).not.toBe("$$");
    // And the body between the tags must contain the whole block, not just the
    // part before the name.
    const body = block.sql.slice(block.sql.indexOf(tag) + tag.length);
    expect(body.slice(0, body.lastIndexOf(tag))).toContain("END IF;");
  });

  it("closes with the same tag it opened with", () => {
    const sql = restoreBlock("orders", "a$$b").sql;
    const tag = openingTag(sql);

    expect(sql.trimEnd().endsWith(`${tag};`)).toBe(true);
    // Opening and closing, and no third copy from the name itself.
    expect(sql.split(tag)).toHaveLength(3);
  });

  it("climbs past a name that contains the guard tag as well", () => {
    // $guard$ is the first choice, so a name holding one has to push it on.
    const sql = restoreBlock("orders", "x$guard$y").sql;
    const tag = openingTag(sql);

    expect(tag).not.toBe("$$");
    expect(tag).not.toBe("$guard$");
    expect(sql.split(tag)).toHaveLength(3);
  });
});

describe("an ordinary name", () => {
  it("is left looking exactly as it did", () => {
    // The overwhelmingly common case. A fix that made every block cryptic to
    // read would cost more than the bug it prevents.
    const sql = restoreBlock("orders", "shipped_at").sql;

    expect(openingTag(sql)).toBe("$guard$");
    expect(sql).toContain("RAISE NOTICE '%',");
    expect(sql).toContain('ALTER TABLE "orders" ALTER COLUMN "shipped_at" SET NOT NULL;');
  });
});
