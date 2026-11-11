import { compareSchemas } from "@/lib/compare";
import { generateMigration, statementsThatRun } from "@/lib/generate-sql";
import { column, schema, table } from "./helpers/snapshots";

// The comparison can be unsure whether a new column (or table) is an old one
// under a new name. It then reports the pair as a possible rename and the
// script adds one and drops the other. The script used to say nothing about the
// guess, so the reader had to write the RENAME by hand. Now a note beside the
// ADD gives the ready statement.

describe("the note for a possible rename", () => {
  const source = schema([
    table("products", [column("id", { nullable: false }), column("sku_code", { typeDisplay: "text" })]),
  ]);
  const target = schema([
    table("products", [column("id", { nullable: false }), column("sku", { typeDisplay: "text" })]),
  ]);

  it("gives the ready RENAME COLUMN beside the ADD COLUMN", () => {
    const report = compareSchemas(source, target);
    // The rig only means something while the comparison is unsure.
    expect(report.matchedTables[0].possibleColumnMatches.map((m) => [m.rightName, m.leftName])).toEqual([
      ["sku", "sku_code"],
    ]);

    const script = generateMigration(report, { allowDataLoss: true });
    const sql = script.statements.map((s) => s.sql);
    const note = sql.findIndex((text) => text.startsWith("-- MANUAL:") && text.includes("may be one column"));
    expect(note).toBeGreaterThan(-1);
    expect(sql[note]).toContain('ALTER TABLE "products" RENAME COLUMN "sku" TO "sku_code";');
    expect(sql[note]).toContain('adds "sku_code" as a new, empty column and drops "sku"');
    // Straight before the ADD COLUMN it is about.
    expect(sql[note + 1]).toContain('ADD COLUMN IF NOT EXISTS "sku_code"');
    // One line, so the statement in it stays a comment, and it runs nothing.
    expect(sql[note]).not.toContain("\n");
    expect(statementsThatRun(script).some((s) => s.sql.includes("RENAME COLUMN"))).toBe(false);
    // Plain words only: no em dash or en dash.
    expect(sql[note]).not.toMatch(/[\u2013\u2014]/);
  });

  it("writes no note when the two columns are plainly different", () => {
    const other = schema([
      table("products", [
        column("id", { nullable: false }),
        column("sku", { typeDisplay: "boolean", nullable: false, columnDefault: "false" }),
      ]),
    ]);
    const report = compareSchemas(source, other);
    expect(report.matchedTables[0].possibleColumnMatches).toEqual([]);
    const script = generateMigration(report, { allowDataLoss: true });
    expect(script.statements.some((s) => s.kind === "MANUAL")).toBe(false);
  });

  it("gives the ready RENAME TO before the CREATE TABLE for a possible table rename", () => {
    const columns = () => [
      column("id", { nullable: false }),
      column("sent_at", { typeDisplay: "timestamp with time zone" }),
      column("note", { typeDisplay: "text" }),
    ];
    const report = compareSchemas(
      schema([table("shipments", columns())]),
      schema([table("legacy_notes", columns())])
    );
    expect(report.possibleTableMatches.map((m) => [m.rightName, m.leftName])).toEqual([
      ["legacy_notes", "shipments"],
    ]);

    const script = generateMigration(report, { allowDataLoss: true });
    const sql = script.statements.map((s) => s.sql);
    const note = sql.findIndex((text) => text.startsWith("-- MANUAL:") && text.includes("may be one table"));
    const create = sql.findIndex((text) => text.includes('CREATE TABLE IF NOT EXISTS "shipments"'));
    expect(note).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(note);
    expect(sql[note]).toContain('ALTER TABLE "legacy_notes" RENAME TO "shipments";');
    expect(sql[note]).not.toMatch(/[\u2013\u2014]/);
  });
});
