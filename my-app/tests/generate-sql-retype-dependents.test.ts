// generate-sql: a column type change with a policy, trigger or generated
// column that reads the column.
//
// PostgreSQL refuses ALTER TABLE ... ALTER COLUMN ... TYPE while a row-level
// security policy, a trigger (UPDATE OF the column, or a WHEN clause) or a
// generated column uses that column:
//   cannot alter type of a column used in a policy definition
//   cannot alter type of a column used in a trigger definition
//   cannot alter type of a column used by a generated column
// One that is identical on both sides is in no diff, so nothing moved it out
// of the way and the script stopped there.
//
// These tests pin the fix: the policy or trigger is dropped before the type
// change and created again after it, and a generated column is dropped or
// added on the right side of it.
import { compareSchemas } from "@/lib/compare";
import {
  generateMigration,
  renderMigrationScript,
  statementsThatRun,
  type MigrationScript,
} from "@/lib/generate-sql";
import { column, schema, table } from "./helpers/snapshots";
import type {
  ColumnSnapshot,
  IndexSnapshot,
  PolicySnapshot,
  SchemaSnapshot,
  TableSnapshot,
  TriggerSnapshot,
} from "@/lib/postgres";

/** A policy on "docs" as the catalog records it. */
function policy(name: string, using: string): PolicySnapshot {
  const definition = `AS PERMISSIVE FOR ALL TO public USING (${using})`;
  return {
    name,
    table: "docs",
    permissive: true,
    command: "ALL",
    roles: ["public"],
    using,
    withCheck: null,
    definition,
    normalizedDefinition: definition,
  };
}

/** A trigger as the catalog records it. */
function trigger(name: string, definition: string): TriggerSnapshot {
  return { name, definition, normalizedDefinition: definition, functionName: "touch", enabled: true };
}

/** A btree index on one column of "items". */
function index(name: string, on: string): IndexSnapshot {
  const definition = `CREATE INDEX ${name} ON items USING btree (${on})`;
  return {
    name,
    definition,
    normalizedDefinition: definition,
    columns: [on],
    isUnique: false,
    method: "btree",
    predicate: null,
  };
}

const id = () => column("id", { nullable: false, isPrimaryKey: true });

/** "docs" with a tenant_id of the given type and whatever hangs off it. */
function docs(tenantType: string, over: Partial<TableSnapshot> = {}): TableSnapshot {
  return table("docs", [id(), column("tenant_id", { typeDisplay: tenantType })], {
    indexes: [],
    triggers: [],
    rowSecurity: { enabled: false, forced: false, policies: [] },
    ...over,
  });
}

/** The generated column `line_total = qty * unit_price`. */
function lineTotal(): ColumnSnapshot {
  return column("line_total", {
    typeDisplay: "numeric(14,2)",
    generated: { storage: "STORED", expression: "((qty)::numeric * unit_price)" },
  });
}

/** "items" with a qty of the given type, with or without the generated column. */
function items(qtyType: string, withTotal: boolean, indexes: IndexSnapshot[] = []): TableSnapshot {
  return table(
    "items",
    [
      id(),
      column("qty", { typeDisplay: qtyType }),
      column("unit_price", { typeDisplay: "numeric(10,2)" }),
      ...(withTotal ? [lineTotal()] : []),
    ],
    { indexes, triggers: [], rowSecurity: { enabled: false, forced: false, policies: [] } }
  );
}

function migration(source: SchemaSnapshot, target: SchemaSnapshot, allowDataLoss = false) {
  return generateMigration(compareSchemas(source, target), { allowDataLoss });
}

/** The statements that will really run, as one string. */
function running(script: MigrationScript): string {
  return statementsThatRun(script)
    .map((statement) => statement.sql)
    .join("\n");
}

/** Where a fragment sits in a script. Fails loudly when it is not there. */
function at(script: string, fragment: string): number {
  const position = script.indexOf(fragment);
  if (position < 0) throw new Error(`not in the script: ${fragment}`);
  return position;
}

const RETYPE_TENANT = 'ALTER TABLE "docs" ALTER COLUMN "tenant_id" TYPE bigint';
const RETYPE_QTY = 'ALTER TABLE "items" ALTER COLUMN "qty" TYPE bigint';
const DROP_TOTAL = 'ALTER TABLE "items" DROP COLUMN IF EXISTS "line_total" CASCADE;';
const ADD_TOTAL = 'ALTER TABLE "items" ADD COLUMN IF NOT EXISTS "line_total"';

describe("a column type change that a policy reads", () => {
  const rls = (policies: PolicySnapshot[]) => ({
    rowSecurity: { enabled: true, forced: false, policies },
  });

  it("drops an unchanged policy before the type change and creates it again after", () => {
    const same = policy("p", "(tenant_id = 1)");
    const text = running(
      migration(schema([docs("bigint", rls([same]))]), schema([docs("integer", rls([same]))]))
    );

    expect(at(text, 'DROP POLICY IF EXISTS "p" ON "docs";')).toBeLessThan(at(text, RETYPE_TENANT));
    expect(at(text, 'CREATE POLICY "p" ON "docs"')).toBeGreaterThan(at(text, RETYPE_TENANT));
  });

  it("moves the drop of a changed or removed policy in front of the type change", () => {
    const text = running(
      migration(
        schema([docs("bigint", rls([policy("p_changed", "(tenant_id = 2)")]))]),
        schema([
          docs(
            "integer",
            rls([policy("p_changed", "(tenant_id = 1)"), policy("p_gone", "(tenant_id > 0)")])
          ),
        ])
      )
    );

    expect(at(text, 'DROP POLICY IF EXISTS "p_changed" ON "docs";')).toBeLessThan(
      at(text, RETYPE_TENANT)
    );
    expect(at(text, 'DROP POLICY IF EXISTS "p_gone" ON "docs";')).toBeLessThan(
      at(text, RETYPE_TENANT)
    );
    expect(at(text, 'CREATE POLICY "p_changed" ON "docs"')).toBeGreaterThan(
      at(text, RETYPE_TENANT)
    );
  });

  it("leaves a policy alone when it does not read the column", () => {
    const other = policy("p", "(id > 0)");
    const text = running(
      migration(schema([docs("bigint", rls([other]))]), schema([docs("integer", rls([other]))]))
    );

    expect(text).toContain(RETYPE_TENANT);
    expect(text).not.toContain("POLICY");
  });
});

describe("a column type change that a trigger names", () => {
  it("drops an unchanged trigger before the type change and creates it again after", () => {
    const upd = trigger(
      "t_upd",
      "CREATE TRIGGER t_upd BEFORE UPDATE OF tenant_id ON docs FOR EACH ROW " +
        "WHEN (old.tenant_id IS DISTINCT FROM new.tenant_id) EXECUTE FUNCTION touch()"
    );
    const plain = trigger(
      "t_plain",
      "CREATE TRIGGER t_plain BEFORE INSERT ON docs FOR EACH ROW EXECUTE FUNCTION touch()"
    );
    const text = running(
      migration(
        schema([docs("bigint", { triggers: [plain, upd] })]),
        schema([docs("integer", { triggers: [plain, upd] })])
      )
    );

    expect(at(text, 'DROP TRIGGER IF EXISTS "t_upd" ON "docs";')).toBeLessThan(
      at(text, RETYPE_TENANT)
    );
    expect(at(text, "CREATE TRIGGER t_upd")).toBeGreaterThan(at(text, RETYPE_TENANT));
    // A trigger that does not name the column is not touched.
    expect(text).not.toContain("t_plain");
  });
});

describe("a column type change that a generated column reads", () => {
  it("rebuilds an unchanged generated column around the type change", () => {
    const totalIndex = index("items_total_idx", "line_total");
    const text = running(
      migration(
        schema([items("bigint", true, [totalIndex])]),
        schema([items("integer", true, [totalIndex])])
      )
    );

    expect(at(text, DROP_TOTAL)).toBeLessThan(at(text, RETYPE_QTY));
    expect(at(text, ADD_TOTAL)).toBeGreaterThan(at(text, RETYPE_QTY));
    // The index went with the column, so it is put back after it.
    expect(at(text, "CREATE INDEX items_total_idx")).toBeGreaterThan(at(text, ADD_TOTAL));
  });

  it("adds a new generated column after the type change it depends on", () => {
    const text = running(
      migration(schema([items("bigint", true)]), schema([items("integer", false)]))
    );

    expect(at(text, ADD_TOTAL)).toBeGreaterThan(at(text, RETYPE_QTY));
    expect(text).not.toContain("DROP COLUMN");
  });

  it("drops a generated column the source lacks before the type change when data loss is allowed", () => {
    const text = running(
      migration(schema([items("bigint", false)]), schema([items("integer", true)]), true)
    );

    expect(at(text, DROP_TOTAL)).toBeLessThan(at(text, RETYPE_QTY));
  });

  it("holds the type change back in safe mode while that generated column stays", () => {
    const script = migration(schema([items("bigint", false)]), schema([items("integer", true)]));

    // Safe mode keeps the column, and PostgreSQL would refuse the type change
    // while it is there, so both wait for "allow data loss".
    expect(running(script)).toBe("");
    expect(renderMigrationScript(script)).toContain(`-- ${RETYPE_QTY}`);
    expect(script.warnings.join("\n")).toMatch(
      /The type change of "qty" in "items" is held back: the computed column "line_total" reads it/
    );
  });

  it("writes a plain type change when no generated column reads the column", () => {
    const text = running(
      migration(schema([items("bigint", false)]), schema([items("integer", false)]))
    );

    expect(text).toContain(RETYPE_QTY);
    expect(text).not.toContain("line_total");
  });
});
