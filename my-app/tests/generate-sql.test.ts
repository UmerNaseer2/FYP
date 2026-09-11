import { compareSchemas } from "@/lib/compare";
import { inferChangeTypeFromSql, readChangeTypeHeader } from "@/lib/change-type";
import {
  generateMigration,
  generateRollback,
  migrationChangeLevel,
  renderMigrationScript,
  renderRollbackScript,
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
  TypeSnapshot,
} from "@/lib/postgres";

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

  it("creates an index with IF NOT EXISTS, unique or not", () => {
    expect(renderMigrationScript(addedIndex(false))).toContain(
      "CREATE INDEX IF NOT EXISTS orders_note_idx"
    );
    expect(renderMigrationScript(addedIndex(true))).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS orders_note_idx"
    );
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
    // suggestBumpLevel reads comments too, so on its own the block has to say
    // nothing it counts, in either direction.
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
