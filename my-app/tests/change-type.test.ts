import { compareSchemas } from "@/lib/compare";
import {
  generateMigration,
  migrationChangeLevel,
  renderMigrationScript,
} from "@/lib/generate-sql";
import {
  changeTypeOf,
  inferChangeTypeFromSql,
  readChangeTypeHeader,
} from "@/lib/change-type";
import { column, schema, table } from "./helpers/snapshots";

/**
 * A safe-mode script that both ADDS a table and holds back a DROP. This is the
 * exact shape that used to grade itself breaking: the generator writes "(DROP
 * TABLE / DROP COLUMN) are commented out below" into the header, and the
 * deploy screen searched the whole file for "drop table".
 */
const SOURCE = schema([
  table("orders", [column("id")]),
  table("shipments", [column("id")]),
]);
const TARGET = schema([
  table("orders", [column("id")]),
  table("legacy", [column("id")]),
]);

function additiveWithHeldBackDrop() {
  return generateMigration(compareSchemas(SOURCE, TARGET), {});
}

describe("inferChangeTypeFromSql", () => {
  it("ignores keywords that appear only in a comment", () => {
    const sql = [
      "-- DROP TABLE and DROP COLUMN are commented out below.",
      "ALTER TABLE orders ADD COLUMN note text;",
    ].join("\n");
    expect(inferChangeTypeFromSql(sql)).toBe("additive");
  });

  it("ignores keywords that appear only inside a string literal", () => {
    const sql = "INSERT INTO audit(note) VALUES ('drop table orders');";
    expect(inferChangeTypeFromSql(sql)).toBe("patch");
  });

  it("still grades real destructive SQL breaking", () => {
    expect(inferChangeTypeFromSql("DROP TABLE legacy;")).toBe("breaking");
  });
});

describe("readChangeTypeHeader", () => {
  it("reads the stamp the generator writes", () => {
    expect(readChangeTypeHeader("-- Change-type: additive\nSELECT 1;")).toBe("additive");
  });

  it("does not read a stamp that appears after the first statement", () => {
    const sql = "SELECT 1;\n-- Change-type: patch\n";
    expect(readChangeTypeHeader(sql)).toBeNull();
  });

  it("returns null for a script with no stamp", () => {
    expect(readChangeTypeHeader("ALTER TABLE orders ADD COLUMN note text;")).toBeNull();
  });
});

describe("migrationChangeLevel", () => {
  it("does not count a drop that safe mode holds back", () => {
    expect(migrationChangeLevel(additiveWithHeldBackDrop())).toBe("additive");
  });

  it("counts the same drop once data loss is armed", () => {
    const script = generateMigration(compareSchemas(SOURCE, TARGET), { allowDataLoss: true });
    expect(migrationChangeLevel(script)).toBe("breaking");
  });
});

describe("changeTypeOf — a rendered safe-mode script", () => {
  const sql = renderMigrationScript(additiveWithHeldBackDrop());

  it("still contains the words that used to mislead the search", () => {
    expect(sql.toLowerCase()).toContain("drop table");
  });

  it("grades additive anyway, because nothing destructive will run", () => {
    expect(changeTypeOf(sql)).toBe("additive");
  });
});
