import { compareSchemas } from "@/lib/compare";
import { inferChangeTypeFromSql, readChangeTypeHeader } from "@/lib/change-type";
import {
  generateMigration,
  generateRollback,
  migrationChangeLevel,
  renderMigrationScript,
  renderRollbackScript,
  statementsThatRun,
  type MigrationOptions,
} from "@/lib/generate-sql";
import { suggestBumpLevel } from "@/lib/script-status";
import { containsTransactionControl, findMightFailStatements } from "@/lib/sql-guard";
import { column, schema, table } from "./helpers/snapshots";
import type {
  ConstraintSnapshot,
  ForeignKeySnapshot,
  IndexSnapshot,
  PolicySnapshot,
  SchemaSnapshot,
  SequenceSnapshot,
  TypeSnapshot,
} from "@/lib/postgres";

/** Compare two snapshots and generate the forward migration between them. */
function migration(source: SchemaSnapshot, target: SchemaSnapshot, options: MigrationOptions = {}) {
  return generateMigration(compareSchemas(source, target), options);
}

describe("renderMigrationScript — header tally", () => {
  // The Compare page counts only the statements that run. The header used to
  // count the held-back drops too, so it said "3 breaking" beside a page that
  // said "1 breaking" for the same script.
  const source = schema([table("customers", [column("id", { nullable: false }), column("full_name")])]);
  const target = schema([table("customers", [column("id", { nullable: false }), column("legacy_code")])]);

  it("counts only the statements that run when drops are held back", () => {
    const script = migration(source, target);
    const run = statementsThatRun(script);
    expect(run.length).toBeLessThan(script.statements.length);
    const breaking = run.filter((s) => s.severity === "breaking").length;
    const safe = run.filter((s) => s.severity === "safe").length;
    const info = run.filter((s) => s.severity === "info").length;
    expect(renderMigrationScript(script)).toContain(
      `-- Statements: ${script.statements.length}  (${run.length} run: ${breaking} breaking · ${safe} safe · ${info} info)`
    );
    // The DROP COLUMN is breaking, but it is commented out, so it is not counted.
    expect(breaking).toBe(0);
  });

  it("keeps the plain tally when every statement runs", () => {
    const script = migration(source, target, { allowDataLoss: true });
    expect(statementsThatRun(script)).toHaveLength(script.statements.length);
    const sql = renderMigrationScript(script);
    expect(sql).toMatch(/-- Statements: \d+  \(\d+ breaking · \d+ safe · \d+ info\)/);
    expect(sql).not.toMatch(/-- Statements: .* run: /);
  });
});

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
describe("generateMigration — where a new enum label goes", () => {
  // PostgreSQL sorts an enum by the order its labels were added, and ADD VALUE
  // with no neighbour appends. A label the source has in the middle therefore
  // arrived at the end, and the next comparison could only report it as "same
  // values, different order" — which needs the type recreated by hand.
  function enums(sourceLabels: string[], targetLabels: string[]) {
    const build = (labels: string[]): TypeSnapshot => {
      const definition = `ENUM (${labels.map((label) => `'${label}'`).join(", ")})`;
      return {
        name: "severity",
        kind: "ENUM",
        labels,
        baseType: null,
        notNull: false,
        checks: [],
        attributes: [],
        definition,
        normalizedDefinition: definition,
      };
    };
    return {
      source: schema([table("alerts", [column("id")])], { types: [build(sourceLabels)] }),
      target: schema([table("alerts", [column("id")])], { types: [build(targetLabels)] }),
    };
  }

  /** Just the ALTER TYPE lines, in the order the script runs them. */
  function addValues(sourceLabels: string[], targetLabels: string[]): string[] {
    const { source, target } = enums(sourceLabels, targetLabels);
    return statementsThatRun(migration(source, target))
      .map((s) => s.sql)
      .filter((sql) => sql.includes("ADD VALUE"));
  }

  it("puts a label the source has in the middle in front of the one that follows it", () => {
    expect(addValues(["low", "medium", "high"], ["low", "high"])).toEqual([
      `ALTER TYPE "severity" ADD VALUE IF NOT EXISTS 'medium' BEFORE 'high';`,
    ]);
  });

  it("appends a label the source has at the end", () => {
    // No BEFORE at all: there is nothing after it to anchor to, and appending
    // is already the right answer.
    expect(addValues(["low", "high", "critical"], ["low", "high"])).toEqual([
      `ALTER TYPE "severity" ADD VALUE IF NOT EXISTS 'critical';`,
    ]);
  });

  it("anchors two new labels to the same following label, in source order", () => {
    // Each lands directly in front of "high", so the second ends up after the
    // first — which is the order the source has them in.
    expect(addValues(["low", "medium", "urgent", "high"], ["low", "high"])).toEqual([
      `ALTER TYPE "severity" ADD VALUE IF NOT EXISTS 'medium' BEFORE 'high';`,
      `ALTER TYPE "severity" ADD VALUE IF NOT EXISTS 'urgent' BEFORE 'high';`,
    ]);
  });

  it("skips over a label the target does not have yet when choosing the anchor", () => {
    // "urgent" is being added in this same run, so it is no use as a neighbour
    // for "medium" — the first label the target ALREADY has is what works.
    expect(addValues(["medium", "urgent", "high"], ["high"])).toEqual([
      `ALTER TYPE "severity" ADD VALUE IF NOT EXISTS 'medium' BEFORE 'high';`,
      `ALTER TYPE "severity" ADD VALUE IF NOT EXISTS 'urgent' BEFORE 'high';`,
    ]);
  });

  it("says in words where the label is going", () => {
    const { source, target } = enums(["low", "medium", "high"], ["low", "high"]);
    const added = migration(source, target).statements.find((s) => s.sql.includes("ADD VALUE"));
    expect(added?.description).toBe(`Add value 'medium' to enum "severity" before 'high'`);
  });
});

describe("generateMigration — a key another table points at", () => {
  // PostgreSQL will not drop a PRIMARY KEY or UNIQUE constraint while a foreign
  // key depends on it, and that key lives on a different table — outside
  // everything one table's own diff can see.
  const pk = (name: string, columns: string[]): ConstraintSnapshot => ({
    name,
    kind: "PRIMARY KEY",
    columns,
    definition: `PRIMARY KEY (${columns.map((c) => `"${c}"`).join(", ")})`,
    normalizedDefinition: `primary key (${columns.join(", ")})`,
  });
  const fk = (name: string, refTable: string, refColumns: string[]): ForeignKeySnapshot => ({
    name,
    kind: "FOREIGN KEY",
    columns: ["order_id"],
    definition: `FOREIGN KEY (order_id) REFERENCES ${refTable}(${refColumns.join(", ")})`,
    normalizedDefinition: `foreign key (order_id) references ${refTable}(${refColumns.join(", ")})`,
    referencedSchema: "public",
    referencedTable: refTable,
    referencedColumns: refColumns,
    onUpdate: "NO ACTION",
    onDelete: "NO ACTION",
  });

  /** orders keyed as `keyColumns` say, and order_items pointing at orders(id). */
  function shop(keyColumns: string[] | null, over: { items?: Partial<import("@/lib/postgres").TableSnapshot> } = {}) {
    return schema([
      table(
        "orders",
        [column("id", { nullable: false }), column("code", { nullable: false })],
        { primaryKey: keyColumns ? pk("orders_pkey", keyColumns) : null }
      ),
      table("order_items", [column("order_id", { nullable: false })], {
        foreignKeys: [fk("order_items_order_id_fkey", "orders", ["id"])],
        ...over.items,
      }),
    ]);
  }

  it("takes the dependent key off before dropping the one it points at", () => {
    // The source keys orders on (code); the target keys it on (id). The pkey
    // has to be rebuilt, and order_items is holding it.
    const sql = statementsThatRun(migration(shop(["code"]), shop(["id"]))).map((s) => s.sql);
    const dropFk = sql.findIndex((t) => /"order_items" DROP CONSTRAINT IF EXISTS "order_items_order_id_fkey"/.test(t));
    const dropPk = sql.findIndex((t) => /"orders" DROP CONSTRAINT IF EXISTS "orders_pkey"/.test(t));
    expect(dropFk).toBeGreaterThan(-1);
    expect(dropPk).toBeGreaterThan(-1);
    expect(dropFk).toBeLessThan(dropPk);
  });

  it("says which key is making it drop the other one", () => {
    const script = migration(shop(["code"]), shop(["id"]));
    const dropped = script.statements.find(
      (s) => s.kind === "DROP_CONSTRAINT" && s.sql.includes("order_items_order_id_fkey")
    );
    expect(dropped?.description).toContain('PRIMARY KEY "orders_pkey" on "orders"');
  });

  it("leaves the reference dropped when the source has no key to point at", () => {
    // The source drops orders' primary key altogether. Putting the FK back
    // would fail: there is no unique constraint matching its columns any more.
    const sql = statementsThatRun(migration(shop(null), shop(["id"]))).map((s) => s.sql);
    expect(sql.some((t) => /DROP CONSTRAINT IF EXISTS "order_items_order_id_fkey"/.test(t))).toBe(true);
    expect(sql.some((t) => /ADD CONSTRAINT "order_items_order_id_fkey"/.test(t))).toBe(false);
  });

  it("puts the reference back after the key it points at is rebuilt", () => {
    // Both sides key orders on (id); only the definition differs, so the key is
    // dropped and re-added over the same columns and the reference is still
    // valid at the end. Putting it back is the only way the table ends up the
    // way the source says it should be.
    const deferrable = shop(["id"]);
    deferrable.tables[0].primaryKey = {
      ...pk("orders_pkey", ["id"]),
      definition: 'PRIMARY KEY ("id") DEFERRABLE',
      normalizedDefinition: "primary key (id) deferrable",
    };
    const sql = statementsThatRun(migration(deferrable, shop(["id"]))).map((s) => s.sql);
    const dropFk = sql.findIndex((t) => /"order_items" DROP CONSTRAINT IF EXISTS "order_items_order_id_fkey"/.test(t));
    const addPk = sql.findIndex((t) => /"orders" ADD CONSTRAINT "orders_pkey"/.test(t));
    const addFk = sql.findIndex((t) => /"order_items" ADD CONSTRAINT "order_items_order_id_fkey"/.test(t));
    expect(dropFk).toBeGreaterThan(-1);
    expect(addPk).toBeGreaterThan(dropFk);
    expect(addFk).toBeGreaterThan(addPk);
  });

  it("leaves the reference dropped when the source keys the table differently", () => {
    // The source keys orders on (id, code). Nothing matches the (id) the FK
    // references any more, so an ADD would fail on "no unique constraint".
    const sql = statementsThatRun(migration(shop(["id", "code"]), shop(["id"]))).map((s) => s.sql);
    expect(sql.some((t) => /"orders" ADD CONSTRAINT "orders_pkey"/.test(t))).toBe(true);
    expect(sql.some((t) => /ADD CONSTRAINT "order_items_order_id_fkey"/.test(t))).toBe(false);
  });

  it("leaves a key alone when nothing points at it", () => {
    const plain = (keyColumns: string[]) =>
      schema([
        table(
          "orders",
          [column("id", { nullable: false }), column("code", { nullable: false })],
          { primaryKey: pk("orders_pkey", keyColumns) }
        ),
      ]);
    const sql = statementsThatRun(migration(plain(["code"]), plain(["id"]))).map((s) => s.sql);
    expect(sql.some((t) => /order_items/.test(t))).toBe(false);
  });

  it("does not touch a reference the owning table is already rewriting", () => {
    // order_items' own diff drops and re-adds this key on its own schedule.
    // A second drop here would race the ADD that section queues.
    const source = shop(["code"]);
    const target = schema([
      table(
        "orders",
        [column("id", { nullable: false }), column("code", { nullable: false })],
        { primaryKey: pk("orders_pkey", ["id"]) }
      ),
      table("order_items", [column("order_id", { nullable: false })], {
        foreignKeys: [
          { ...fk("order_items_order_id_fkey", "orders", ["id"]), onDelete: "CASCADE",
            normalizedDefinition: "foreign key (order_id) references orders(id) on delete cascade" },
        ],
      }),
    ]);
    const drops = statementsThatRun(migration(source, target))
      .filter((s) => s.sql.includes(`DROP CONSTRAINT IF EXISTS "order_items_order_id_fkey"`));
    expect(drops).toHaveLength(1);
    expect(drops[0].description).not.toContain("about to go");
  });
});

describe("generateMigration — rebuilding a generated column", () => {
  // PostgreSQL has no ALTER for a GENERATED ALWAYS AS (…) clause, so the only
  // portable answer is DROP COLUMN … CASCADE and add it back. CASCADE is silent
  // about what else it takes, and the drop is only harmless in one direction.
  const gen = (expression: string) => ({
    generated: { storage: "STORED" as const, expression },
  });

  /** A table whose "total" is computed in the source and computed differently, or not at all, in the target. */
  function totals(
    left: Partial<import("@/lib/postgres").ColumnSnapshot>,
    right: Partial<import("@/lib/postgres").ColumnSnapshot>,
    over: Partial<import("@/lib/postgres").TableSnapshot> = {}
  ) {
    const cols = (side: Partial<import("@/lib/postgres").ColumnSnapshot>) => [
      column("id", { nullable: false }),
      column("qty", { nullable: false }),
      column("total", { typeDisplay: "numeric", ...side }),
    ];
    return {
      source: schema([table("invoices", cols(left), over)]),
      target: schema([table("invoices", cols(right))]),
    };
  }

  it("arms the drop when the column being replaced holds stored values", () => {
    // The target stores what somebody typed; the source computes it. Nothing
    // recomputes those values, so this is data loss like any other.
    const { source, target } = totals(gen("qty * 2"), { generated: null });
    const script = migration(source, target);
    const drop = script.statements.find((s) => s.kind === "DROP_COLUMN");
    expect(drop?.destructive).toBe(true);
    expect(drop?.description).toContain("stored data");
    // Safe mode holds a destructive statement back, which is the whole point.
    expect(statementsThatRun(script)).not.toContain(drop);
  });

  it("leaves the drop unarmed when the column it replaces is computed", () => {
    // Both sides compute it, so every value comes back from the new expression
    // the moment the column does. Arming this would block a harmless rebuild.
    const { source, target } = totals(gen("qty * 3"), gen("qty * 2"));
    const script = migration(source, target);
    const drop = script.statements.find((s) => s.kind === "DROP_COLUMN");
    expect(drop?.destructive).toBe(false);
    expect(statementsThatRun(script)).toContain(drop);
  });

  it("adds a NOT NULL rebuild as nullable and puts NOT NULL back after", () => {
    // ADD COLUMN … NOT NULL with no default is refused outright on a table that
    // already has rows, and one refused statement aborts the whole script.
    const { source, target } = totals(
      { nullable: false, generated: null },
      { nullable: false, ...gen("qty * 2") }
    );
    const sql = statementsThatRun(migration(source, target, { allowDataLoss: true })).map(
      (s) => s.sql
    );
    const added = sql.findIndex((text) => /ADD COLUMN IF NOT EXISTS "total"/.test(text));
    expect(added).toBeGreaterThan(-1);
    expect(sql[added]).not.toContain("NOT NULL");
    expect(sql[added + 1]).toContain('ALTER COLUMN "total" SET NOT NULL');
  });

  it("puts back the index CASCADE took with the column", () => {
    // The index is identical in both schemas, so it is in no diff and the index
    // phase never mentioned it — this is the only thing that can restore it.
    const index: IndexSnapshot = {
      name: "invoices_total_idx",
      definition: 'CREATE INDEX invoices_total_idx ON public.invoices USING btree (total)',
      normalizedDefinition: "create index invoices_total_idx on invoices using btree (total)",
      columns: ["total"],
      isUnique: false,
      method: "btree",
      predicate: null,
    };
    const onBoth = (expression: string) =>
      schema([
        table(
          "invoices",
          [
            column("id", { nullable: false }),
            column("qty", { nullable: false }),
            column("total", { typeDisplay: "numeric", ...gen(expression) }),
          ],
          { indexes: [index] }
        ),
      ]);
    const sql = renderMigrationScript(migration(onBoth("qty * 3"), onBoth("qty * 2")));
    expect(sql).toContain("CREATE INDEX invoices_total_idx");
    // And it comes back AFTER the column does, not before.
    expect(sql.indexOf("CREATE INDEX invoices_total_idx")).toBeGreaterThan(
      sql.indexOf('ADD COLUMN IF NOT EXISTS "total"')
    );
  });

  it("puts back a CHECK constraint CASCADE took with the column", () => {
    const check: ConstraintSnapshot = {
      name: "invoices_total_positive",
      kind: "CHECK",
      columns: ["total"],
      definition: "CHECK ((total > (0)::numeric))",
      normalizedDefinition: "check ((total > (0)::numeric))",
    };
    const cols = (expression: string) => [
      column("id", { nullable: false }),
      column("qty", { nullable: false }),
      column("total", { typeDisplay: "numeric", ...gen(expression) }),
    ];
    const source = schema([
      table("invoices", cols("qty * 3"), { checkConstraints: [check] }),
    ]);
    const target = schema([
      table("invoices", cols("qty * 2"), { checkConstraints: [check] }),
    ]);
    const sql = renderMigrationScript(migration(source, target));
    expect(sql).toContain('ADD CONSTRAINT "invoices_total_positive"');
    expect(sql).toContain("CASCADE took it");
  });

  it("says nothing extra when the rebuilt column has no index or constraint on it", () => {
    const { source, target } = totals(gen("qty * 3"), gen("qty * 2"));
    const sql = renderMigrationScript(migration(source, target));
    expect(sql).not.toContain("CASCADE took it");
    expect(sql).not.toContain("CREATE INDEX");
  });
});

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

/**
 * A dropped NOT NULL column with no default is the one restore PostgreSQL
 * cannot perform on a table that already holds rows: there is no value to put
 * in them. Writing it as a single `ADD COLUMN … NOT NULL` made the whole
 * rollback abort, so the column did not come back either.
 */
describe("generateRollback — restoring a NOT NULL column with no default", () => {
  const before = schema([
    table("orders", [
      column("id", { nullable: false }),
      column("note", { typeDisplay: "text", nullable: false }),
    ]),
  ]);
  const after = schema([table("orders", [column("id", { nullable: false })])]);

  /** The migration that drops "note", and the rollback that puts it back. */
  function rollback() {
    return generateRollback(compareSchemas(after, before), { allowDataLoss: true });
  }

  it("adds the column back without NOT NULL, so the statement can run", () => {
    const sql = renderRollbackScript(rollback());
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "note" text;/);
  });

  it("re-applies NOT NULL only when the table turns out to be empty", () => {
    const sql = renderRollbackScript(rollback());
    // Looks at the column first, so a second run does not claim NOT NULL is
    // missing once the first run has put it on.
    expect(sql).toMatch(/attnotnull/);
    expect(sql).toMatch(/ELSIF EXISTS \(SELECT 1 FROM "orders" LIMIT 1\) THEN/);
    expect(sql).toMatch(/RAISE NOTICE/);
    expect(sql).toMatch(/ALTER COLUMN "note" SET NOT NULL;/);
  });

  it("names the column in the script header instead of leaving it to a description", () => {
    const script = rollback();
    expect(script.nullableOnRestore).toEqual(["orders.note"]);
    expect(renderRollbackScript(script)).toContain("orders.note");
  });

  it("leaves a column that has a default alone", () => {
    const withDefault = schema([
      table("orders", [
        column("id", { nullable: false }),
        column("note", { typeDisplay: "text", nullable: false, columnDefault: "''" }),
      ]),
    ]);
    const script = generateRollback(compareSchemas(after, withDefault), { allowDataLoss: true });
    expect(script.nullableOnRestore).toEqual([]);
    expect(renderRollbackScript(script)).toMatch(/"note" text NOT NULL DEFAULT ''/);
  });

  // The warning text, joined back together from its wrapped comment lines.
  function warningText(sql: string): string {
    const lines = sql.split("\n");
    const start = lines.findIndex((line) => line.startsWith("-- WARNING: "));
    if (start < 0) return "";
    const parts = [lines[start].slice("-- WARNING: ".length)];
    for (let index = start + 1; index < lines.length && lines[index].startsWith("--          "); index += 1) {
      parts.push(lines[index].trim().replace(/^--\s+/, ""));
    }
    return parts.join(" ");
  }

  it("writes the generator's warnings into the rollback, above the statements", () => {
    // The warnings used to live only in the Workbench panel: the pushed
    // v<ver>.down.sql and Deploy's preview never said the rollback was lossy.
    const warning =
      "The rename of orders to invoices was not confirmed, so this rollback recreates the table empty and its rows are not restored.";
    const sql = renderRollbackScript({ ...rollback(), warnings: [warning] });
    expect(sql).toContain("-- WARNING: The rename");
    expect(warningText(sql)).toBe(warning);
    expect(sql.indexOf("-- WARNING:")).toBeLessThan(sql.indexOf("ALTER TABLE"));
    for (const line of sql.split("\n").filter((each) => each.startsWith("-- WARNING") || each.startsWith("--          "))) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
  });

  it("writes no warning lines when there are none", () => {
    expect(renderRollbackScript({ ...rollback(), warnings: [] })).not.toContain("WARNING:");
  });

  it("keeps a warning with a line break inside its comment", () => {
    // A line break in the text must not end the comment and leave SQL behind.
    const sql = renderRollbackScript({ ...rollback(), warnings: ["first line\nDROP TABLE orders;\rDROP TABLE t2;"] });
    expect(sql).not.toContain("\r");
    for (const line of sql.split("\n")) {
      if (line.includes("DROP TABLE orders") || line.includes("DROP TABLE t2")) {
        expect(line.startsWith("--")).toBe(true);
      }
    }
  });
});

/**
 * A deploy that was cut off half way, or simply run a second time, used to stop
 * on the first "already exists" — and because the whole run is one transaction,
 * nothing after that statement happened either. Every CREATE and ADD is now
 * written so a second run skips what is already there: IF NOT EXISTS where
 * PostgreSQL has it, and a catalog lookup in a DO block where it does not.
 */
describe("generateMigration — safe to run twice", () => {
  /** The table the foreign keys below point at. Both sides have it. */
  const customers = table("customers", [column("id", { nullable: false })]);

  /** A foreign key from customer_id to customers.id. */
  function customerFk(name: string): ForeignKeySnapshot {
    return {
      name,
      kind: "FOREIGN KEY",
      columns: ["customer_id"],
      definition: "FOREIGN KEY (customer_id) REFERENCES customers(id)",
      normalizedDefinition: "FOREIGN KEY (customer_id) REFERENCES customers(id)",
      referencedSchema: "public",
      referencedTable: "customers",
      referencedColumns: ["id"],
      onUpdate: "NO ACTION",
      onDelete: "NO ACTION",
    };
  }

  const orderColumns = [column("id", { nullable: false }), column("customer_id")];

  /** One nullable column the target is missing. */
  function addedColumn() {
    return migration(
      schema([table("orders", [column("id"), column("note", { typeDisplay: "text" })])]),
      schema([table("orders", [column("id")])])
    );
  }

  /** orders exists on both sides; only the source has its foreign key. */
  function matchedFk() {
    return migration(
      schema([
        customers,
        table("orders", orderColumns, { foreignKeys: [customerFk("orders_customer_fk")] }),
      ]),
      schema([customers, table("orders", orderColumns)])
    );
  }

  /** invoices exists only in the source, with a foreign key of its own. */
  function newTableFk() {
    return migration(
      schema([
        customers,
        table("invoices", orderColumns, { foreignKeys: [customerFk("invoices_customer_fk")] }),
      ]),
      schema([customers])
    );
  }

  /** One index on orders.note the target does not have. */
  function addedIndex(isUnique: boolean) {
    const definition =
      `CREATE ${isUnique ? "UNIQUE " : ""}INDEX orders_note_idx ON orders USING btree (note)`;
    const index: IndexSnapshot = {
      name: "orders_note_idx",
      definition,
      normalizedDefinition: definition,
      columns: ["note"],
      isUnique,
      method: "btree",
      predicate: null,
    };
    const columns = [column("note", { typeDisplay: "text" })];
    return migration(
      schema([table("orders", columns, { indexes: [index] })]),
      schema([table("orders", columns, { indexes: [] })])
    );
  }

  const totalCheck: ConstraintSnapshot = {
    name: "orders_total_check",
    kind: "CHECK",
    columns: ["total"],
    definition: "CHECK ((total >= (0)::numeric))",
    normalizedDefinition: "CHECK ((total >= (0)::numeric))",
  };
  const totalColumns = [column("total", { typeDisplay: "numeric" })];

  it("adds a column with IF NOT EXISTS", () => {
    expect(renderMigrationScript(addedColumn())).toContain(
      'ADD COLUMN IF NOT EXISTS "note" text;'
    );
  });

  it("creates an index only when it is not already on that table, unique or not", () => {
    // Not IF NOT EXISTS: that skips on the name alone, which across tables (index
    // names are unique per schema, not per table) can drop an index that just
    // moved. The DO block checks this exact table instead — see indexCreateSql.
    const plain = renderMigrationScript(addedIndex(false));
    expect(plain).toContain("DO $guard$");
    expect(plain).toContain(
      "SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid"
    );
    expect(plain).toContain(`i.indrelid = to_regclass('"orders"')`);
    expect(plain).toContain("c.relname = 'orders_note_idx'");
    expect(plain).toContain("CREATE INDEX orders_note_idx");
    expect(plain).not.toContain("CREATE INDEX IF NOT EXISTS");
    // Guarded inside the DO block, so indented — never bare at column 0, where a
    // second run would stop on it.
    expect(plain).not.toMatch(/^CREATE INDEX/m);

    const unique = renderMigrationScript(addedIndex(true));
    expect(unique).toContain("CREATE UNIQUE INDEX orders_note_idx");
    expect(unique).not.toContain("CREATE UNIQUE INDEX IF NOT EXISTS");
    expect(unique).not.toMatch(/^CREATE UNIQUE INDEX/m);
  });

  it("still creates a new table with IF NOT EXISTS", () => {
    expect(renderMigrationScript(newTableFk())).toContain(
      'CREATE TABLE IF NOT EXISTS "invoices"'
    );
  });

  it("adds a foreign key to an existing table only when it is not there yet", () => {
    const sql = renderMigrationScript(matchedFk());
    expect(sql).toContain("DO $guard$");
    expect(sql).toContain("conname = 'orders_customer_fk'");
    expect(sql).toContain(`to_regclass('"orders"')`);
    expect(sql).toContain('ADD CONSTRAINT "orders_customer_fk" FOREIGN KEY');
    // Never bare at the start of a line, where a second run would stop on it.
    expect(sql).not.toMatch(/^ALTER TABLE "orders" ADD CONSTRAINT/m);
  });

  it("guards a new table's foreign key the same way", () => {
    const sql = renderMigrationScript(newTableFk());
    expect(sql).toContain("DO $guard$");
    expect(sql).toContain("conname = 'invoices_customer_fk'");
    expect(sql).toContain(`to_regclass('"invoices"')`);
    expect(sql).toContain('ADD CONSTRAINT "invoices_customer_fk" FOREIGN KEY');
    expect(sql).not.toMatch(/^ALTER TABLE "invoices" ADD CONSTRAINT/m);
  });

  it("guards a CHECK constraint", () => {
    const sql = renderMigrationScript(
      migration(
        schema([table("orders", totalColumns, { checkConstraints: [totalCheck] })]),
        schema([table("orders", totalColumns)])
      )
    );
    expect(sql).toContain("conname = 'orders_total_check'");
    expect(sql).toContain(
      'ADD CONSTRAINT "orders_total_check" CHECK ((total >= (0)::numeric));'
    );
    expect(sql).not.toMatch(/^ALTER TABLE "orders" ADD CONSTRAINT/m);
  });

  it("drops a changed constraint before the guarded add, so the new one is written", () => {
    const changed = {
      ...totalCheck,
      definition: "CHECK ((total > (0)::numeric))",
      normalizedDefinition: "CHECK ((total > (0)::numeric))",
    };
    const sql = renderMigrationScript(
      migration(
        schema([table("orders", totalColumns, { checkConstraints: [totalCheck] })]),
        schema([table("orders", totalColumns, { checkConstraints: [changed] })])
      )
    );
    // Otherwise the lookup would find the old one and skip the new definition.
    expect(sql.indexOf("DROP CONSTRAINT IF EXISTS")).toBeGreaterThan(-1);
    expect(sql.indexOf("DROP CONSTRAINT IF EXISTS")).toBeLessThan(sql.indexOf("DO $guard$"));
  });

  it("creates a type only when the name is not taken", () => {
    const mood: TypeSnapshot = {
      name: "mood",
      kind: "ENUM",
      labels: ["a", "b"],
      baseType: null,
      notNull: false,
      checks: [],
      attributes: [],
      definition: "ENUM ('a', 'b')",
      normalizedDefinition: "ENUM ('a', 'b')",
    };
    const sql = renderMigrationScript(
      migration(schema([], { types: [mood] }), schema([], { types: [] }))
    );
    // By name, in the schema the CREATE writes to. See the "line" test below
    // for why the name is not resolved instead.
    expect(sql).toContain(
      "IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'mood' AND typnamespace = " +
        "(SELECT oid FROM pg_namespace WHERE nspname = current_schema())) THEN\n" +
        '    CREATE TYPE "mood" AS ENUM'
    );
  });

  it("creates a policy only when the table does not have one by that name", () => {
    const policy: PolicySnapshot = {
      name: "orders_read",
      table: "orders",
      permissive: true,
      command: "SELECT",
      roles: ["public"],
      using: "true",
      withCheck: null,
      definition: "AS PERMISSIVE FOR SELECT TO public USING (true)",
      normalizedDefinition: "AS PERMISSIVE FOR SELECT TO public USING (true)",
    };
    const columns = [column("id")];
    const withPolicies = (policies: PolicySnapshot[]) =>
      table("orders", columns, { rowSecurity: { enabled: true, forced: false, policies } });
    const sql = renderMigrationScript(
      migration(schema([withPolicies([policy])]), schema([withPolicies([])]))
    );
    expect(sql).toContain(
      `SELECT 1 FROM pg_policy WHERE polrelid = to_regclass('"orders"') AND polname = 'orders_read'`
    );
    expect(sql).toMatch(/THEN\n    CREATE POLICY "orders_read" ON "orders" AS PERMISSIVE/);
  });

  it("says in the header that the script is safe to run again", () => {
    expect(renderMigrationScript(addedColumn())).toContain("Safe to run again");
  });

  it("words that header so it cannot move the suggested version bump", () => {
    const sql = renderMigrationScript(addedColumn());
    const paragraph = commentParagraph(sql, "Safe to run again");
    // All of it, down to the last line.
    expect(paragraph).toContain("compare again after running.");
    // suggestBumpLevel skips comments now, but the paragraph read on its own as
    // SQL must still say nothing it counts, in either direction — a pasted copy
    // of the prose without the dashes is still harmless.
    expect(suggestBumpLevel(paragraph)).toBe("patch");
    expect(suggestBumpLevel(sql)).toBe("minor");
  });

  it("words the rollback's header the same careful way", () => {
    const rollback = generateRollback(
      compareSchemas(
        schema([table("orders", [column("id"), column("note", { typeDisplay: "text" })])]),
        schema([table("orders", [column("id")])])
      ),
      { allowDataLoss: true }
    );
    const paragraph = commentParagraph(renderRollbackScript(rollback), "Run this after the migration");
    expect(paragraph).toContain("converted back again.");
    expect(suggestBumpLevel(paragraph)).toBe("patch");
  });

  it("puts no transaction control in the guard blocks", () => {
    // BEGIN and END inside a DO body are PL/pgSQL, not a transaction.
    expect(containsTransactionControl(renderMigrationScript(matchedFk()))).toBe(false);
  });

  it("leaves the Change-type line reading the level of the statements themselves", () => {
    // The guard changes how a statement is written, not what it does. A
    // constraint added to a table that already exists is graded breaking
    // (constraintChangeSeverity), so that script keeps its own level; a new
    // table's foreign key is part of creating it, so that one reads additive.
    const matched = matchedFk();
    expect(migrationChangeLevel(matched)).toBe("breaking");
    expect(readChangeTypeHeader(renderMigrationScript(matched))).toBe("breaking");
    expect(readChangeTypeHeader(renderMigrationScript(newTableFk()))).toBe("additive");
  });

  it("still warns that a guarded foreign key can fail on existing rows", () => {
    expect(findMightFailStatements(renderMigrationScript(matchedFk()))).toContain(
      "FOREIGN KEY constraint"
    );
  });
});

/**
 * An index name that moved from one table to another. Index names are unique
 * per schema, not per table, so this shows up as a DROP on the old table and a
 * CREATE on the new one — and if the create runs first it collides with the
 * name still in place. The script used to skip that collision with IF NOT
 * EXISTS, which read "already there" and left the index on neither table once
 * the DROP followed. Two things stop that now: the create is guarded against
 * its own table (not the bare name), and every index drop is drained ahead of
 * the creates.
 */
describe("generateMigration — an index name that moved between tables", () => {
  function movedIndex(tableName: string): IndexSnapshot {
    const definition = `CREATE INDEX shared_idx ON ${tableName} USING btree (val)`;
    return {
      name: "shared_idx",
      definition,
      normalizedDefinition: definition,
      columns: ["val"],
      isUnique: false,
      method: "btree",
      predicate: null,
    };
  }

  // matchedTables is sorted by name, so "aaa" (which gains the index, a CREATE)
  // is processed before "zzz" (which loses it, a DROP): without the reorder the
  // create would be emitted first, which is the case this guards against.
  const cols = [column("val", { typeDisplay: "text" })];
  const sql = renderMigrationScript(
    migration(
      schema([
        table("aaa", cols, { indexes: [movedIndex("aaa")] }),
        table("zzz", cols, { indexes: [] }),
      ]),
      schema([
        table("aaa", cols, { indexes: [] }),
        table("zzz", cols, { indexes: [movedIndex("zzz")] }),
      ])
    )
  );

  it("drops the old copy before it creates the new one", () => {
    const drop = sql.indexOf("DROP INDEX IF EXISTS");
    const create = sql.indexOf("CREATE INDEX shared_idx");
    expect(drop).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(-1);
    expect(drop).toBeLessThan(create);
  });

  it("guards the create against this table, so the copy still on zzz is not read as already there", () => {
    expect(sql).toContain(`i.indrelid = to_regclass('"aaa"')`);
    expect(sql).toContain("c.relname = 'shared_idx'");
    expect(sql).not.toContain("CREATE INDEX IF NOT EXISTS");
  });
});

/**
 * The comment paragraph in a rendered script that starts on the line holding
 * `opening`: that line and each one after it that is still prose. It stops at
 * a bare "--", a "-- ====" rule or anything else that is not a sentence.
 */
function commentParagraph(sql: string, opening: string): string {
  const lines = sql.split("\n");
  const paragraph: string[] = [];
  let at = lines.findIndex((line) => line.includes(opening));
  while (at >= 0 && at < lines.length && /^-- [a-z]/i.test(lines[at])) {
    paragraph.push(lines[at]);
    at += 1;
  }
  return paragraph.join("\n");
}

/**
 * The statements PostgreSQL has no IF NOT EXISTS for, beyond the constraints
 * and policies above: types, renames, and the steps that turn a column into an
 * identity column or move its counter. On a second run each one has to find
 * its work already done and skip it, rather than stop on it or do it twice.
 */
describe("generateMigration — safe to run twice, the harder cases", () => {
  const CURRENT_SCHEMA = "(SELECT oid FROM pg_namespace WHERE nspname = current_schema())";

  function enumType(name: string, labels: string[]): TypeSnapshot {
    const definition = `ENUM (${labels.map((label) => `'${label}'`).join(", ")})`;
    return {
      name,
      kind: "ENUM",
      labels,
      baseType: null,
      notNull: false,
      checks: [],
      attributes: [],
      definition,
      normalizedDefinition: definition,
    };
  }

  function posint(checks: { name: string; expression: string }[]): TypeSnapshot {
    const definition = ["integer", ...checks.map((check) => check.expression)].join(" ");
    return {
      name: "posint",
      kind: "DOMAIN",
      labels: [],
      baseType: "integer",
      notNull: false,
      checks,
      attributes: [],
      definition,
      normalizedDefinition: definition,
    };
  }

  /** The forward script that creates these types on a target that has none. */
  function creating(types: TypeSnapshot[]): string {
    return renderMigrationScript(migration(schema([], { types }), schema([], { types: [] })));
  }

  it("creates a sequence, an extension and a collation with IF NOT EXISTS", () => {
    const sql = renderMigrationScript(
      migration(
        schema([], {
          sequences: [
            {
              name: "Seq One",
              dataType: "bigint",
              startValue: "1",
              increment: "1",
              minValue: "1",
              maxValue: "9223372036854775807",
              cycles: false,
              cacheSize: "1",
              ownedByTable: null,
              ownedByColumn: null,
            },
          ],
          extensions: [
            { name: "citext", version: "1.6", definition: "1.6", normalizedDefinition: "1.6" },
          ],
          collations: [
            {
              name: "ci",
              provider: "icu",
              deterministic: false,
              locale: "und-u-ks-level2",
              lcCollate: null,
              lcCtype: null,
              rules: null,
              definition: "icu und-u-ks-level2 nondeterministic",
              normalizedDefinition: "icu und-u-ks-level2 nondeterministic",
            },
          ],
        }),
        schema([], { sequences: [], extensions: [], collations: [] })
      )
    );
    expect(sql).toContain('CREATE SEQUENCE IF NOT EXISTS "Seq One"');
    expect(sql).toContain(`CREATE EXTENSION IF NOT EXISTS "citext" VERSION '1.6';`);
    expect(sql).toContain(
      `CREATE COLLATION IF NOT EXISTS "ci" (PROVIDER = icu, LOCALE = 'und-u-ks-level2', DETERMINISTIC = false);`
    );
  });

  it("looks a type up in the schema the CREATE writes to, so a built-in cannot hide it", () => {
    // pg_catalog is searched before every other schema, so resolving the name
    // "line" finds the built-in geometric type. A lookup that did that would
    // skip creating the source's own "line" on the very first run.
    const sql = creating([enumType("line", ["a"])]);
    expect(sql).toContain(
      `IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'line' AND typnamespace = ${CURRENT_SCHEMA}) THEN\n` +
        '    CREATE TYPE "line" AS ENUM'
    );
    expect(sql).not.toContain("to_regtype");
  });

  it("guards a domain, a composite type and a range type the same way", () => {
    const pair: TypeSnapshot = {
      name: "pair",
      kind: "COMPOSITE",
      labels: [],
      baseType: null,
      notNull: false,
      checks: [],
      attributes: ['"a" integer', '"b" text'],
      definition: "(a integer, b text)",
      normalizedDefinition: "(a integer, b text)",
    };
    const floatrange: TypeSnapshot = {
      name: "floatrange",
      kind: "RANGE",
      labels: [],
      baseType: "double precision",
      notNull: false,
      checks: [],
      attributes: [],
      rangeDetails: {
        subtypeOpclass: null,
        collation: null,
        canonical: null,
        subtypeDiff: "float8mi",
        multirangeName: null,
        needsManualCreate: false,
      },
      definition: "RANGE (double precision)",
      normalizedDefinition: "RANGE (double precision)",
    };
    const sql = creating([
      posint([{ name: "posint_check", expression: "CHECK ((VALUE > 0))" }]),
      pair,
      floatrange,
    ]);
    const creates: [string, string][] = [
      ["posint", 'CREATE DOMAIN "posint" AS integer'],
      ["pair", 'CREATE TYPE "pair" AS ('],
      ["floatrange", 'CREATE TYPE "floatrange" AS RANGE ('],
    ];
    for (const [name, create] of creates) {
      expect(sql).toContain(
        `(SELECT 1 FROM pg_type WHERE typname = '${name}' AND typnamespace = ${CURRENT_SCHEMA}) THEN\n    ${create}`
      );
    }
    expect(sql).not.toMatch(/^CREATE (TYPE|DOMAIN)/m);
  });

  it("adds a check to an existing domain only when the domain lacks it", () => {
    const positive = { name: "posint_check", expression: "CHECK ((VALUE > 0))" };
    const small = { name: "posint_small", expression: "CHECK ((VALUE < 1000))" };
    const sql = renderMigrationScript(
      migration(
        schema([], { types: [posint([positive, small])] }),
        schema([], { types: [posint([positive])] })
      )
    );
    // ALTER DOMAIN finds the domain through the search_path, and so does this.
    expect(sql).toContain(
      "IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE contypid = to_regtype('\"posint\"') " +
        "AND conname = 'posint_small') THEN\n" +
        '    ALTER DOMAIN "posint" ADD CONSTRAINT "posint_small" CHECK ((VALUE < 1000));'
    );
  });

  it("picks another dollar tag when the text inside already holds $guard$", () => {
    // An enum label can be any text at all. In a block tagged $guard$, this
    // label would end the block halfway through.
    const sql = creating([enumType("weird", ["a$guard$b"])]);
    expect(sql).toContain("DO $guard1$\n");
    expect(sql).toContain("'a$guard$b'");
    expect(sql).toContain("END\n$guard1$;");
    expect(sql).not.toContain("DO $guard$\n");
  });

  /** orders.customer_nm on the target is orders.customer_name in the source. */
  function renamedColumn() {
    return compareSchemas(
      schema([table("orders", [column("id"), column("customer_name", { typeDisplay: "text" })])]),
      schema([table("orders", [column("id"), column("customer_nm", { typeDisplay: "text" })])])
    );
  }

  it("renames a column only while the table has no column by the new name", () => {
    const report = renamedColumn();
    // The pair has to be read as a rename for this test to mean anything.
    expect(report.matchedTables[0].columnMatches.filter((match) => !match.exact)).toHaveLength(1);
    const sql = renderMigrationScript(generateMigration(report, {}));
    expect(sql).toContain(
      "IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('\"orders\"') " +
        "AND attname = 'customer_name' AND attnum > 0 AND NOT attisdropped) THEN\n" +
        '    ALTER TABLE "orders" RENAME COLUMN "customer_nm" TO "customer_name";'
    );
    expect(sql).not.toMatch(/^ALTER TABLE "orders" RENAME COLUMN/m);
  });

  it("still grades that rename breaking when reading the SQL, not the header", () => {
    // The rename is the script's only statement, and it sits inside a DO block.
    const sql = renderMigrationScript(generateMigration(renamedColumn(), {}));
    expect(readChangeTypeHeader(sql)).toBe("breaking");
    expect(inferChangeTypeFromSql(sql)).toBe("breaking");
  });

  it("renames a table with IF EXISTS, so a second run skips it", () => {
    const columns = [
      column("id", { nullable: false }),
      column("email", { typeDisplay: "text" }),
      column("created_at", { typeDisplay: "timestamptz" }),
      column("full_name", { typeDisplay: "text" }),
    ];
    const report = compareSchemas(
      schema([table("customer", columns)]),
      schema([table("customers", columns)])
    );
    expect(report.matchedTables.map((match) => match.exact)).toEqual([false]);
    const sql = renderMigrationScript(generateMigration(report, {}));
    expect(sql).toContain('ALTER TABLE IF EXISTS "customers" RENAME TO "customer";');
  });

  it("turns a serial column into an identity column once, and skips both steps after", () => {
    const sql = renderMigrationScript(
      migration(
        schema([table("orders", [column("id", { nullable: false, identity: "ALWAYS" })])]),
        schema([
          table("orders", [
            column("id", {
              nullable: false,
              identity: null,
              columnDefault: "nextval('orders_id_seq'::regclass)",
            }),
          ]),
        ])
      )
    );
    const isIdentity =
      "IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('\"orders\"') " +
      "AND attname = 'id' AND attnum > 0 AND NOT attisdropped AND attidentity <> '') THEN\n";
    // DROP DEFAULT is refused outright on an identity column, so a second run
    // has to skip it as well as the ADD.
    expect(sql).toContain(`${isIdentity}    ALTER TABLE "orders" ALTER COLUMN "id" DROP DEFAULT;`);
    expect(sql).toContain(
      `${isIdentity}    ALTER TABLE "orders" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY;`
    );
    expect(sql).not.toMatch(/^ALTER TABLE "orders" ALTER COLUMN "id" (DROP DEFAULT|ADD GENERATED)/m);
  });

  it("keeps a mixed-case sequence name quoted inside its nextval default", () => {
    // A Prisma-style table "User" owns the sequence "User_id_seq". Written bare
    // inside the literal, PostgreSQL reads it as user_id_seq and the deploy
    // stops on "relation does not exist" with the sequence sitting right there.
    const sql = renderMigrationScript(
      migration(
        schema([
          table("User", [
            column("id", {
              nullable: false,
              identity: null,
              columnDefault: `nextval('"User_id_seq"'::regclass)`,
            }),
          ]),
        ]),
        schema([table("User", [column("id", { nullable: false, identity: null })])])
      )
    );
    expect(sql).toContain(
      `ALTER TABLE "User" ALTER COLUMN "id" SET DEFAULT nextval('"User_id_seq"'::regclass);`
    );
    expect(sql).not.toContain(`nextval('User_id_seq'::regclass)`);
  });

  /** counters.id, generated the way `how` says, with a sequence that stops at maxValue. */
  function counters(how: "identity" | "serial", maxValue: string) {
    const sequenceOptions = {
      dataType: "integer",
      startValue: "1",
      increment: "1",
      minValue: "1",
      maxValue,
      cycles: false,
      cacheSize: "1",
    };
    return table("counters", [
      column(
        "id",
        how === "identity"
          ? { nullable: false, identity: "BY DEFAULT", sequenceOptions }
          : {
              nullable: false,
              identity: null,
              columnDefault: "nextval('counters_id_seq'::regclass)",
              sequenceOptions,
            }
      ),
    ]);
  }

  it("moves an identity column's counter back only until the source's bounds are set", () => {
    const sql = renderMigrationScript(
      migration(schema([counters("identity", "5000")]), schema([counters("identity", "1000000")]))
    );
    // Moving it back again on a second run would hand out ids that were handed
    // out after the first.
    expect(sql).toContain(
      "IF NOT EXISTS (SELECT 1 FROM pg_sequence WHERE seqrelid = " +
        "to_regclass(pg_get_serial_sequence('\"counters\"', 'id')) AND seqmin = 1 AND seqmax = 5000) THEN\n" +
        '    ALTER TABLE "counters" ALTER COLUMN "id" RESTART WITH 1;'
    );
    expect(sql).not.toMatch(/^ALTER TABLE "counters" ALTER COLUMN "id" RESTART/m);
    // The note names the sequence first and ends on its warning.
    expect(sql).toMatch(
      /^-- \[\w+\] Move the counter to 1 on the sequence behind "id" in "counters" — WARNING: the narrower bounds .* hands out ids the table already has$/m
    );
    // Setting a bound lands on the same value however often it runs.
    expect(sql).toMatch(/^ALTER TABLE "counters" ALTER COLUMN "id" SET MAXVALUE 5000;$/m);
  });

  it("does the same for the sequence behind a serial column", () => {
    const sql = renderMigrationScript(
      migration(schema([counters("serial", "5000")]), schema([counters("serial", "1000000")]))
    );
    expect(sql).toContain(
      "IF NOT EXISTS (SELECT 1 FROM pg_sequence WHERE seqrelid = " +
        "to_regclass('\"counters_id_seq\"') AND seqmin = 1 AND seqmax = 5000) THEN\n" +
        '    ALTER SEQUENCE "counters_id_seq" RESTART WITH 1;'
    );
    expect(sql).toMatch(/^ALTER SEQUENCE "counters_id_seq" MAXVALUE 5000;$/m);
  });
});

/**
 * ALTER COLUMN ... TYPE converts the column's default as well as its rows, but
 * USING is applied to the rows only. A default with no automatic cast to the
 * new type used to stop the statement ("default for column cannot be cast
 * automatically"), so a text status column with DEFAULT 'active' could never
 * become an enum. The default now comes off first and goes back on after.
 */
describe("generateMigration — a type change and the column's default", () => {
  /** The SQL of every statement that runs, in order. */
  function runSql(source: SchemaSnapshot, target: SchemaSnapshot): string[] {
    return statementsThatRun(migration(source, target)).map((statement) => statement.sql);
  }

  function orders(...columns: Parameters<typeof column>[]) {
    return schema([table("orders", columns.map(([name, over]) => column(name, over)))]);
  }

  it("drops the target's default, changes the type, then sets the source's default", () => {
    const sql = runSql(
      orders(["status", { typeDisplay: "order_status", columnDefault: "'active'::order_status" }]),
      orders(["status", { typeDisplay: "text", columnDefault: "'active'::text" }])
    );
    expect(sql).toEqual([
      'ALTER TABLE "orders" ALTER COLUMN "status" DROP DEFAULT;',
      'ALTER TABLE "orders" ALTER COLUMN "status" TYPE order_status USING "status"::order_status;',
      `ALTER TABLE "orders" ALTER COLUMN "status" SET DEFAULT 'active'::order_status;`,
    ]);
  });

  it("puts the default back even when both sides' defaults read the same", () => {
    // Nothing differs about the default, but the type change took it off.
    const script = migration(
      orders(["qty", { typeDisplay: "bigint", columnDefault: "0" }]),
      orders(["qty", { typeDisplay: "integer", columnDefault: "0" }])
    );
    expect(statementsThatRun(script).map((statement) => statement.sql)).toEqual([
      'ALTER TABLE "orders" ALTER COLUMN "qty" DROP DEFAULT;',
      'ALTER TABLE "orders" ALTER COLUMN "qty" TYPE bigint USING "qty"::bigint;',
      'ALTER TABLE "orders" ALTER COLUMN "qty" SET DEFAULT 0;',
    ]);
    expect(script.statements[2].description).toBe(
      'Put the default back on "qty" in "orders" (0) after its type change'
    );
  });

  it("drops the default once and sets nothing when the source has no default", () => {
    const sql = runSql(
      orders(["code", { typeDisplay: "integer" }]),
      orders(["code", { typeDisplay: "text", columnDefault: "'n/a'::text" }])
    );
    expect(sql.filter((text) => /DROP DEFAULT/.test(text))).toHaveLength(1);
    expect(sql.findIndex((text) => /DROP DEFAULT/.test(text))).toBeLessThan(
      sql.findIndex((text) => /TYPE integer/.test(text))
    );
    expect(sql.some((text) => /SET DEFAULT/.test(text))).toBe(false);
  });

  it("leaves the default alone when the type does not really change or both sides are serial", () => {
    // A widening converts its default without help.
    const widened = runSql(
      orders(["note", { typeDisplay: "character varying(200)", columnDefault: "''::character varying" }]),
      orders(["note", { typeDisplay: "character varying(100)", columnDefault: "''::character varying" }])
    );
    expect(widened.some((text) => /DEFAULT/.test(text))).toBe(false);

    // Each side's serial keeps its own sequence, and nextval() returns a bigint
    // that casts to every integer type.
    const serial = runSql(
      orders(["id", { typeDisplay: "bigint", nullable: false, columnDefault: "nextval('orders_id_seq'::regclass)" }]),
      orders(["id", { typeDisplay: "integer", nullable: false, columnDefault: "nextval('orders_id_seq'::regclass)" }])
    );
    expect(serial).toEqual(['ALTER TABLE "orders" ALTER COLUMN "id" TYPE bigint USING "id"::bigint;']);
  });

  it("drops a plain default before the column becomes an identity column", () => {
    // ADD GENERATED is refused while the column has any default, not only a
    // serial's. It used to drop only a nextval default.
    const sql = runSql(
      orders(["id", { nullable: false, identity: "ALWAYS" }]),
      orders(["id", { nullable: false, identity: null, columnDefault: "0" }])
    );
    expect(sql).toHaveLength(3);
    expect(sql[0]).toContain('    ALTER TABLE "orders" ALTER COLUMN "id" DROP DEFAULT;');
    expect(sql[0]).toContain("attidentity <> ''");
    expect(sql[1]).toContain('ALTER TABLE "orders" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY;');
    // The new sequence's counter, moved past the rows (see the block below).
    expect(sql[2]).toMatch(/^SELECT setval\(identity_sequence\.seq, /);
    expect(sql.some((text) => /SET DEFAULT/.test(text))).toBe(false);
  });

  it("drops a serial's default once, guarded, when it becomes a wider identity column", () => {
    const sql = runSql(
      orders(["id", { typeDisplay: "bigint", nullable: false, identity: "BY DEFAULT" }]),
      orders([
        "id",
        {
          typeDisplay: "integer",
          nullable: false,
          identity: null,
          columnDefault: "nextval('orders_id_seq'::regclass)",
        },
      ])
    );
    const drops = sql.filter((text) => /DROP DEFAULT/.test(text));
    expect(drops).toHaveLength(1);
    // Skipped on a second run, where the column is already an identity column.
    expect(drops[0]).toMatch(/^DO \$guard\$\nBEGIN\n  IF NOT EXISTS \(.*attidentity <> ''\) THEN/);
    const order = ["DROP DEFAULT", "TYPE bigint", "ADD GENERATED BY DEFAULT"].map((needle) =>
      sql.findIndex((text) => text.includes(needle))
    );
    expect(order[0]).toBeGreaterThanOrEqual(0);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe("generateMigration — a column that starts generating its own values", () => {
  // A column that becomes serial or identity on a table that already holds ids
  // 1 to 100 gets a sequence that starts at 1, so the first insert after the
  // migration used to fail on the primary key. Each case below moves the new
  // counter past the rows in the same script.
  function runSql(source: SchemaSnapshot, target: SchemaSnapshot): string[] {
    return statementsThatRun(migration(source, target)).map((statement) => statement.sql);
  }

  function orders(over: Parameters<typeof column>[1]) {
    return schema([table("orders", [column("id", { nullable: false, ...over })])]);
  }

  const serialDefault = "nextval('orders_id_seq'::regclass)";

  it("moves a new identity column's sequence past the highest id", () => {
    const sql = runSql(orders({ identity: "BY DEFAULT" }), orders({ identity: null }));
    expect(sql).toHaveLength(2);
    expect(sql[0]).toContain('ALTER TABLE "orders" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY;');
    expect(sql[1]).toBe(
      `SELECT setval(identity_sequence.seq, GREATEST(nextval(identity_sequence.seq), (SELECT max("id") + 1 FROM "orders")), false)\n` +
        `  FROM (SELECT d.objid::regclass AS seq FROM pg_depend d ` +
        `JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid ` +
        `WHERE d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass ` +
        `AND d.deptype = 'i' AND d.refobjid = to_regclass('"orders"') ` +
        `AND a.attname = 'id') AS identity_sequence;`
    );
  });

  it("carries on from a serial's old sequence when the column becomes an identity column", () => {
    const sql = runSql(
      orders({ identity: "ALWAYS" }),
      orders({ identity: null, columnDefault: serialDefault })
    );
    const addGenerated = sql.findIndex((text) => text.includes("ADD GENERATED ALWAYS AS IDENTITY"));
    expect(addGenerated).toBeGreaterThanOrEqual(0);
    const counter = sql[addGenerated + 1];
    // The old sequence can be ahead of max(id) when the newest rows were deleted.
    expect(counter).toContain(
      `GREATEST(nextval(identity_sequence.seq), nextval(to_regclass('"orders_id_seq"')), ` +
        `(SELECT max("id") + 1 FROM "orders"))`
    );
    // The old sequence stays owned by the column, as it did before this step
    // existed, so the next comparison still hides it instead of reporting an
    // extra sequence in the target. That is also why the lookup is not
    // pg_get_serial_sequence, which would usually find the old sequence.
    expect(sql.some((text) => /OWNED BY NONE/.test(text))).toBe(false);
    expect(counter).not.toContain("pg_get_serial_sequence");
  });

  it("moves a new serial's sequence past the highest id once it is tied to the column", () => {
    // From a plain column, and from an identity column, whose sequence goes with DROP IDENTITY.
    for (const target of [orders({ identity: null }), orders({ identity: "BY DEFAULT" })]) {
      const sql = runSql(orders({ identity: null, columnDefault: serialDefault }), target);
      const owned = sql.indexOf('ALTER SEQUENCE "orders_id_seq" OWNED BY "orders"."id";');
      expect(owned).toBeGreaterThanOrEqual(0);
      expect(sql[owned + 1]).toBe(
        `SELECT setval('"orders_id_seq"', GREATEST(nextval('"orders_id_seq"'), ` +
          `(SELECT max("id") + 1 FROM "orders")), false);`
      );
    }
  });

  it("moves a sequence that counts down below the lowest id instead", () => {
    const sql = runSql(
      orders({
        identity: "ALWAYS",
        sequenceOptions: {
          dataType: "integer",
          startValue: "-1",
          increment: "-1",
          minValue: "-2147483648",
          maxValue: "-1",
          cycles: false,
          cacheSize: "1",
        },
      }),
      orders({ identity: null })
    );
    const counter = sql.find((text) => text.startsWith("SELECT setval("));
    expect(counter).toContain(
      `LEAST(nextval(identity_sequence.seq), (SELECT min("id") - 1 FROM "orders"))`
    );
  });

  it("leaves the counter alone when the column already generated its values, or is not an integer", () => {
    const pairs: [SchemaSnapshot, SchemaSnapshot][] = [
      // Identity on both sides, only ALWAYS / BY DEFAULT differs.
      [orders({ identity: "ALWAYS" }), orders({ identity: "BY DEFAULT" })],
      // Serial on both sides, only the width differs.
      [
        orders({ identity: null, columnDefault: serialDefault }),
        orders({ identity: null, columnDefault: serialDefault, typeDisplay: "smallint" }),
      ],
      // A nextval default on a numeric column: max() + 1 is not attempted.
      [
        orders({ identity: null, columnDefault: serialDefault, typeDisplay: "numeric" }),
        orders({ identity: null, typeDisplay: "numeric" }),
      ],
    ];
    for (const [source, target] of pairs) {
      expect(runSql(source, target).some((text) => text.includes("setval"))).toBe(false);
    }
  });
});

describe("generateMigration — when a column may be written as serial", () => {
  // `serial` is not a type: it tells PostgreSQL to CREATE a sequence called
  // <table>_<column>_seq and hand it to that one column. Writing it for a column
  // whose sequence is somebody else's, or is named something else, builds a
  // DIFFERENT sequence and never says so.
  function runSql(source: SchemaSnapshot, target: SchemaSnapshot): string[] {
    return statementsThatRun(migration(source, target)).map((statement) => statement.sql);
  }

  /** A sequence left on every default, as CREATE SEQUENCE with no clauses makes it. */
  function untuned(over: Partial<SequenceSnapshot> & { name: string }): SequenceSnapshot {
    return {
      dataType: "integer",
      startValue: "1",
      increment: "1",
      minValue: "1",
      maxValue: "2147483647",
      cycles: false,
      cacheSize: "1",
      ownedByTable: null,
      ownedByColumn: null,
      ...over,
    };
  }

  const DEFAULT_OPTIONS = {
    dataType: "integer",
    startValue: "1",
    increment: "1",
    minValue: "1",
    maxValue: "2147483647",
    cycles: false,
    cacheSize: "1",
  };

  /**
   * The column definition line the CREATE TABLE gives this column, without the
   * comma that separates it from the next one.
   */
  function columnLine(sql: string[], columnName: string): string {
    const create = sql.find((text) => text.startsWith("CREATE TABLE")) ?? "";
    const line =
      create
        .split("\n")
        .map((text) => text.trim())
        .find((text) => text.startsWith(`"${columnName}"`)) ?? "";
    return line.replace(/,$/, "");
  }

  const EMPTY = schema([], { sequences: [] });

  it("writes serial for a column that owns the sequence serial would have made", () => {
    const source = schema(
      [
        table("orders", [
          column("id", {
            nullable: false,
            columnDefault: "nextval('orders_id_seq'::regclass)",
            sequenceOptions: DEFAULT_OPTIONS,
          }),
        ]),
      ],
      { sequences: [untuned({ name: "orders_id_seq", ownedByTable: "orders", ownedByColumn: "id" })] }
    );
    const sql = runSql(source, EMPTY);

    expect(columnLine(sql, "id")).toBe('"id" serial NOT NULL');
    // The shorthand builds the sequence itself; a CREATE SEQUENCE beside it
    // would be the name taken twice.
    expect(sql.some((text) => text.includes("CREATE SEQUENCE"))).toBe(false);
  });

  it("writes out both columns in full when two of them share one sequence", () => {
    // A shared pool of numbers is a deliberate design. Two `serial`s would give
    // each column a private sequence, and both would start handing out 1.
    const source = schema(
      [
        table("tickets", [
          column("id", {
            nullable: false,
            columnDefault: "nextval('tickets_id_seq'::regclass)",
            sequenceOptions: DEFAULT_OPTIONS,
          }),
          column("backup_id", { columnDefault: "nextval('tickets_id_seq'::regclass)" }),
        ]),
      ],
      {
        sequences: [
          untuned({ name: "tickets_id_seq", ownedByTable: "tickets", ownedByColumn: "id" }),
        ],
      }
    );
    const sql = runSql(source, EMPTY);

    expect(columnLine(sql, "id")).toBe(
      `"id" integer NOT NULL DEFAULT nextval('tickets_id_seq'::regclass)`
    );
    expect(columnLine(sql, "backup_id")).toBe(
      `"backup_id" integer DEFAULT nextval('tickets_id_seq'::regclass)`
    );
    // Built once, by the column that owns it, before the table that reads it.
    const created = sql.filter((text) => text.includes(`CREATE SEQUENCE IF NOT EXISTS "tickets_id_seq"`));
    expect(created).toHaveLength(1);
    expect(sql.indexOf(created[0])).toBeLessThan(
      sql.findIndex((text) => text.startsWith("CREATE TABLE"))
    );
    expect(sql).toContain('ALTER SEQUENCE "tickets_id_seq" OWNED BY "tickets"."id";');
  });

  it("leaves a standalone sequence to the object phase instead of writing serial", () => {
    // The name is exactly what serial would pick, which is the trap: the object
    // phase creates it first, serial finds the name taken and silently takes
    // "orders_id_seq1" — a sequence the source has never heard of.
    const source = schema(
      [
        table("orders", [
          column("id", { nullable: false, columnDefault: "nextval('orders_id_seq'::regclass)" }),
        ]),
      ],
      { sequences: [untuned({ name: "orders_id_seq" })] }
    );
    const sql = runSql(source, EMPTY);

    expect(columnLine(sql, "id")).toBe(
      `"id" integer NOT NULL DEFAULT nextval('orders_id_seq'::regclass)`
    );
    // Created once, by the object phase, and not tied to the column — it belongs
    // to nobody in the source and has to stay that way.
    expect(sql.filter((text) => text.includes("CREATE SEQUENCE"))).toHaveLength(1);
    expect(sql.some((text) => text.includes("OWNED BY"))).toBe(false);
  });

  it("keeps a sequence whose name serial cannot reproduce", () => {
    // The column was renamed after the table was created, so its sequence still
    // carries the old name. serial would build "orders_order_id_seq" and leave
    // every later comparison reporting a default no migration can settle.
    const source = schema(
      [
        table("orders", [
          column("order_id", {
            nullable: false,
            columnDefault: "nextval('orders_id_seq'::regclass)",
            sequenceOptions: DEFAULT_OPTIONS,
          }),
        ]),
      ],
      {
        sequences: [
          untuned({ name: "orders_id_seq", ownedByTable: "orders", ownedByColumn: "order_id" }),
        ],
      }
    );
    const sql = runSql(source, EMPTY);

    expect(columnLine(sql, "order_id")).toBe(
      `"order_id" integer NOT NULL DEFAULT nextval('orders_id_seq'::regclass)`
    );
    expect(sql).toContain('ALTER SEQUENCE "orders_id_seq" OWNED BY "orders"."order_id";');
    expect(sql.some((text) => text.includes("orders_order_id_seq"))).toBe(false);
  });

  it("still writes serial when the snapshot never recorded any sequences", () => {
    // An older snapshot has no ownership to read. Refusing the shorthand there
    // would write a nextval default for a sequence nothing in the script creates.
    const source = schema([
      table("orders", [
        column("id", { nullable: false, columnDefault: "nextval('orders_id_seq'::regclass)" }),
      ]),
    ]);
    const sql = runSql(source, schema([]));

    expect(columnLine(sql, "id")).toBe('"id" serial NOT NULL');
  });

  it("asks the same question when the column is added to a table that already exists", () => {
    const orders = (columns: Parameters<typeof column>[]) =>
      schema(
        [table("orders", columns.map(([name, over]) => column(name, over)))],
        {
          sequences: [
            untuned({ name: "orders_ref_seq", ownedByTable: "orders", ownedByColumn: "ref" }),
          ],
        }
      );
    const target = schema([table("orders", [column("id", { nullable: false })])], {
      sequences: [],
    });

    const shorthand = runSql(
      orders([
        ["id", { nullable: false }],
        ["ref", { columnDefault: "nextval('orders_ref_seq'::regclass)", sequenceOptions: DEFAULT_OPTIONS }],
      ]),
      target
    );
    expect(shorthand).toContain('ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "ref" serial;');

    // The same column, but something else already reads its sequence.
    const shared = runSql(
      orders([
        ["id", { nullable: false }],
        ["ref", { columnDefault: "nextval('orders_ref_seq'::regclass)", sequenceOptions: DEFAULT_OPTIONS }],
        ["spare", { columnDefault: "nextval('orders_ref_seq'::regclass)" }],
      ]),
      target
    );
    expect(shared).toContain(
      `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "ref" integer DEFAULT nextval('orders_ref_seq'::regclass);`
    );
    expect(shared).toContain('ALTER SEQUENCE "orders_ref_seq" OWNED BY "orders"."ref";');
  });
});
