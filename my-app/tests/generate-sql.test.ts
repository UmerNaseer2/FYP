import { compareSchemas } from "@/lib/compare";
import {
  generateMigration,
  generateRollback,
  renderMigrationScript,
  renderRollbackScript,
  type MigrationOptions,
} from "@/lib/generate-sql";
import { containsTransactionControl } from "@/lib/sql-guard";
import { column, schema, table } from "./helpers/snapshots";
import type { SchemaSnapshot } from "@/lib/postgres";

/** Compare two snapshots and generate the forward migration between them. */
function migration(source: SchemaSnapshot, target: SchemaSnapshot, options: MigrationOptions = {}) {
  return generateMigration(compareSchemas(source, target), options);
}

describe("generateMigration — direction", () => {
  it("creates a table the target is missing", () => {
    const script = migration(
      schema([table("orders", [column("id", { nullable: false })])]),
      schema([])
    );
    const sql = renderMigrationScript(script);

    expect(sql).toMatch(/CREATE TABLE/i);
    expect(sql).toMatch(/orders/);
    expect(sql).not.toMatch(/DROP TABLE/i);
  });

  it("drops a table the source no longer has", () => {
    const script = migration(
      schema([]),
      schema([table("legacy", [column("id")])]),
      { allowDataLoss: true }
    );
    expect(renderMigrationScript(script)).toMatch(/DROP TABLE/i);
  });

  it("writes nothing at all for two identical schemas", () => {
    const one = schema([table("orders", [column("id", { nullable: false })])]);
    const script = migration(one, structuredClone(one));
    expect(script.statements).toEqual([]);
  });
});

/**
 * Safe mode is the default, and it is the reason a generated script cannot
 * quietly delete a production table. Every statement that destroys rows is
 * still WRITTEN — so the user can read what would happen — but rendered
 * commented out until they arm it.
 */
describe("generateMigration — safe mode", () => {
  const source = schema([table("orders", [column("id")])]);
  const target = schema([
    table("orders", [column("id"), column("legacy_note", { typeDisplay: "text" })]),
    table("legacy", [column("id")]),
  ]);

  it("comments out destructive statements by default", () => {
    const script = migration(source, target);
    const sql = renderMigrationScript(script);

    expect(script.allowDataLoss).toBe(false);
    expect(script.destructiveCount).toBeGreaterThan(0);
    // Every DROP that survives into the rendered script is behind a comment.
    for (const line of sql.split("\n")) {
      if (/^\s*(DROP TABLE|ALTER TABLE .* DROP COLUMN)/i.test(line)) {
        throw new Error(`safe mode left an armed destructive line: ${line}`);
      }
    }
  });

  it("arms them when the user opts in", () => {
    const sql = renderMigrationScript(migration(source, target, { allowDataLoss: true }));
    const armed = sql
      .split("\n")
      .filter((line) => /^\s*(DROP TABLE|ALTER TABLE)/i.test(line) && /DROP/i.test(line));
    expect(armed.length).toBeGreaterThan(0);
  });

  it("holds back at least the destructive statements, and reports both counts", () => {
    // heldBackCount can exceed destructiveCount — a rebuilt materialized view
    // destroys nothing but is inert unless its paired DROP actually ran — so
    // the "N destructive statements" wording never over-reports.
    const script = migration(source, target);
    expect(script.heldBackCount).toBeGreaterThanOrEqual(script.destructiveCount);
  });
});

describe("generateMigration — column changes", () => {
  it("adds a column the target lacks", () => {
    const sql = renderMigrationScript(
      migration(
        schema([table("orders", [column("id"), column("total", { typeDisplay: "numeric" })])]),
        schema([table("orders", [column("id")])])
      )
    );
    expect(sql).toMatch(/ADD COLUMN/i);
    expect(sql).toMatch(/total/);
  });

  it("writes SET NOT NULL when the source tightened the column", () => {
    const sql = renderMigrationScript(
      migration(
        schema([table("orders", [column("total", { nullable: false })])]),
        schema([table("orders", [column("total", { nullable: true })])])
      )
    );
    expect(sql).toMatch(/SET NOT NULL/i);
  });

  it("writes DROP NOT NULL in the other direction", () => {
    const sql = renderMigrationScript(
      migration(
        schema([table("orders", [column("total", { nullable: true })])]),
        schema([table("orders", [column("total", { nullable: false })])])
      )
    );
    expect(sql).toMatch(/DROP NOT NULL/i);
  });
});

/**
 * Everything the generator writes runs inside the apply route's single
 * transaction, with search_path already pointed at the target schema. Two rules
 * follow from that, and breaking either one is the kind of bug that only shows
 * up against a real database.
 */
describe("generated SQL fits the apply route", () => {
  const wide = () =>
    migration(
      schema([
        table("orders", [
          column("id", { nullable: false }),
          column("total", { typeDisplay: "numeric", nullable: false }),
        ]),
        table("customers", [column("id", { nullable: false })]),
      ]),
      schema([
        table("orders", [column("id"), column("legacy", { typeDisplay: "text" })]),
        table("audit", [column("id")]),
      ]),
      { allowDataLoss: true }
    );

  it("never emits its own transaction control", () => {
    // A COMMIT here would end the route's transaction early and leave DDL
    // applied with no ledger row. The guard is checked against generated
    // output, not only against what a user types.
    expect(containsTransactionControl(renderMigrationScript(wide()))).toBe(false);
  });

  it("leaves object names unqualified", () => {
    // search_path is set to the target schema, deliberately without public, so
    // a hard-coded schema prefix would write to the wrong place.
    const sql = renderMigrationScript(wide());
    expect(sql).not.toMatch(/\bpublic\./);
  });

  it("renders as text a person can read", () => {
    const sql = renderMigrationScript(wide());
    expect(sql.length).toBeGreaterThan(0);
    expect(sql).toMatch(/--/); // carries its explanatory comments
  });
});

/**
 * A rollback is generated from the comparison run BACKWARDS, and has to work
 * whether or not the forward script's destructive statements were armed — in
 * safe mode nothing was dropped, so the restoring statements must be no-ops
 * rather than errors.
 */
describe("generateRollback", () => {
  it("undoes a created table by dropping it", () => {
    const report = compareSchemas(
      schema([table("orders", [column("id", { nullable: false })])]),
      schema([])
    );
    const sql = generateRollback(report, { allowDataLoss: true });
    expect(JSON.stringify(sql)).toMatch(/DROP TABLE/i);
  });

  it("restores idempotently, so a safe-mode forward run leaves it a no-op", () => {
    const report = compareSchemas(
      schema([table("orders", [column("id")])]),
      schema([table("orders", [column("id"), column("legacy", { typeDisplay: "text" })])])
    );
    const rollback = generateRollback(report, { allowDataLoss: true });
    const text = JSON.stringify(rollback);
    // The forward script would DROP COLUMN legacy; the rollback puts it back,
    // and must not fail when the drop was never armed.
    expect(text).toMatch(/ADD COLUMN IF NOT EXISTS/i);
  });
});

/**
 * A migration made only of ALTER COLUMN TYPE drops nothing and creates
 * nothing, so the counts that decide `lossless` were both zero and the header
 * promised the target came back "exactly as it was". It does not: the down
 * script restores the type, never the values the forward cast threw away.
 *
 * The two cases below were checked against a live PostgreSQL before being
 * written down. Inserting 2024-03-05 14:30:00 and 1.2345, casting down and
 * back again, returns 2024-03-05 00:00:00 and 1.2300.
 */
describe("generateRollback — truncating type changes", () => {
  /** Same table both sides, one column typed differently. */
  function typeChange(sourceType: string, targetType: string) {
    return generateRollback(
      compareSchemas(
        schema([table("reading", [column("value", { typeDisplay: sourceType })])]),
        schema([table("reading", [column("value", { typeDisplay: targetType })])])
      )
    );
  }

  it("is not lossless when the forward cast drops the time of day", () => {
    const rollback = typeChange("date", "timestamp without time zone");
    expect(rollback.lossless).toBe(false);
    expect(rollback.truncatingTypeChanges).toEqual([
      "reading.value: timestamp without time zone → date",
    ]);
  });

  it("is not lossless when the forward cast rounds away scale", () => {
    const rollback = typeChange("numeric(10,2)", "numeric(10,4)");
    expect(rollback.lossless).toBe(false);
    expect(rollback.truncatingTypeChanges).toEqual([
      "reading.value: numeric(10,4) → numeric(10,2)",
    ]);
  });

  it("stays lossless when the forward cast only widens", () => {
    const widened = typeChange("character varying(200)", "character varying(50)");
    expect(widened.truncatingTypeChanges).toEqual([]);
    expect(widened.lossless).toBe(true);

    const promoted = typeChange("bigint", "integer");
    expect(promoted.truncatingTypeChanges).toEqual([]);
    expect(promoted.lossless).toBe(true);
  });

  it("names the columns in the header instead of claiming an exact restore", () => {
    const sql = renderRollbackScript(typeChange("date", "timestamp without time zone"));
    expect(sql).not.toMatch(/restores the target exactly as it was/);
    expect(sql).toMatch(/TYPE RESTORED, VALUES NOT/);
    expect(sql).toMatch(/reading\.value: timestamp without time zone → date/);
  });
});
