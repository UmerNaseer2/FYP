// generate-sql: replacing a function that something in the target still uses.
//
// A function whose return type or argument name changed cannot be replaced in
// place, so the script writes DROP FUNCTION and then CREATE. PostgreSQL
// refuses the drop while a view, a column default, a CHECK or an index still
// uses the function:
//   cannot drop function g(integer) because other objects depend on it
// Something identical on both sides is in no diff, so nothing moved it out of
// the way and the whole script stopped on that line.
//
// These tests pin the fix. Plain views are dropped first and rebuilt after the
// new function exists. For anything else the function is left alone and the
// script says so in a MANUAL note, instead of a statement certain to fail.
import { compareSchemas } from "@/lib/compare";
import { generateMigration, statementsThatRun, type MigrationScript } from "@/lib/generate-sql";
import { column, schema, table } from "./helpers/snapshots";
import type {
  ConstraintSnapshot,
  IndexSnapshot,
  RoutineSnapshot,
  SchemaSnapshot,
  TableSnapshot,
  ViewSnapshot,
} from "@/lib/postgres";

/** The function g(integer), with the given return type and argument name. */
function g(returnType: string, argument = "a"): RoutineSnapshot {
  const definition = `CREATE OR REPLACE FUNCTION g(${argument} integer)\n RETURNS ${returnType}\n LANGUAGE sql\nAS $function$select ${argument} + 1$function$`;
  return {
    name: "g",
    kind: "FUNCTION",
    identityArguments: `${argument} integer`,
    signature: "g(integer)",
    returnType,
    argumentNames: [argument],
    language: "sql",
    definition,
    normalizedDefinition: definition,
  };
}

/** A view as the catalog records it. */
function view(
  name: string,
  definition: string,
  dependsOn: string[],
  materialized = false
): ViewSnapshot {
  return {
    name,
    materialized,
    definition,
    normalizedDefinition: definition,
    columns: ["id"],
    dependsOn,
    options: [],
    indexes: [],
    triggers: [],
  };
}

const id = () => column("id", { nullable: false, isPrimaryKey: true });

/** The table "t" with an id and an integer x. */
function t(over: Partial<TableSnapshot> = {}, xDefault: string | null = null): TableSnapshot {
  return table("t", [id(), column("x", { columnDefault: xDefault })], { indexes: [], ...over });
}

const callsG = () => view("v", " SELECT id\n   FROM t\n  WHERE g(x) > 0;", ["t"]);

function migration(source: SchemaSnapshot, target: SchemaSnapshot, allowDataLoss = false) {
  return generateMigration(compareSchemas(source, target), { allowDataLoss });
}

/** The statements that will really run, as one string. */
function running(script: MigrationScript): string {
  return statementsThatRun(script)
    .map((statement) => statement.sql)
    .join("\n");
}

/** The text of every MANUAL note in the script. */
function notes(script: MigrationScript): string {
  return script.statements
    .filter((statement) => statement.kind === "MANUAL")
    .map((statement) => statement.sql)
    .join("\n");
}

/** Where a fragment sits in a script. Fails loudly when it is not there. */
function at(script: string, fragment: string): number {
  const position = script.indexOf(fragment);
  if (position < 0) throw new Error(`not in the script: ${fragment}`);
  return position;
}

const DROP_G = 'DROP FUNCTION IF EXISTS "g"(a integer);';
const CREATE_G = "CREATE OR REPLACE FUNCTION g(";

describe("a replaced function that only plain views call", () => {
  it("drops the view first and rebuilds it, and the view on top of it, afterwards", () => {
    const views = [callsG(), view("v2", " SELECT id\n   FROM v;", ["v"])];
    const text = running(
      migration(
        schema([t()], { routines: [g("bigint")], views }),
        schema([t()], { routines: [g("integer")], views })
      )
    );

    expect(at(text, 'DROP VIEW IF EXISTS "v" CASCADE;')).toBeLessThan(at(text, DROP_G));
    expect(at(text, CREATE_G)).toBeGreaterThan(at(text, DROP_G));
    expect(at(text, 'CREATE OR REPLACE VIEW "v" AS')).toBeGreaterThan(at(text, CREATE_G));
    // The CASCADE took v2 as well, so it is put back after v.
    expect(at(text, 'CREATE OR REPLACE VIEW "v2" AS')).toBeGreaterThan(
      at(text, 'CREATE OR REPLACE VIEW "v" AS')
    );
  });

  it("leaves the pair exactly as it was when nothing uses the function", () => {
    const script = migration(
      schema([t()], { routines: [g("bigint")], views: [] }),
      schema([t()], { routines: [g("integer")], views: [] })
    );
    const text = running(script);

    expect(at(text, CREATE_G)).toBeGreaterThan(at(text, DROP_G));
    expect(text).not.toContain("DROP VIEW");
    expect(notes(script)).toBe("");
  });
});

describe("a replaced function that something else still uses", () => {
  /** No DROP FUNCTION, no CREATE, one note that names every user. */
  function expectLeftAlone(script: MigrationScript, users: string[]) {
    const text = running(script);
    expect(text).not.toContain("DROP FUNCTION");
    expect(text).not.toContain(CREATE_G);
    for (const user of users) expect(notes(script)).toContain(user);
    expect(script.warnings.join("\n")).toMatch(/Function "g\(integer\)" is not replaced/);
  }

  it("writes a MANUAL note when a column default calls it", () => {
    const script = migration(
      schema([t({}, "g(1)")], { routines: [g("bigint")] }),
      schema([t({}, "g(1)")], { routines: [g("integer")] })
    );

    expectLeftAlone(script, ['the default of "t"."x"']);
  });

  it("names a CHECK and an index when an argument was renamed", () => {
    const check: ConstraintSnapshot = {
      name: "t_x_chk",
      kind: "CHECK",
      columns: ["x"],
      definition: "CHECK ((g(x) > 0))",
      normalizedDefinition: "CHECK ((g(x) > 0))",
    };
    const index: IndexSnapshot = {
      name: "t_g_idx",
      definition: "CREATE INDEX t_g_idx ON t USING btree (g(x))",
      normalizedDefinition: "CREATE INDEX t_g_idx ON t USING btree (g(x))",
      columns: [],
      isUnique: false,
      method: "btree",
      predicate: null,
    };
    const uses = { checkConstraints: [check], indexes: [index] };
    const script = migration(
      schema([t(uses)], { routines: [g("integer", "b")] }),
      schema([t(uses)], { routines: [g("integer", "a")] })
    );

    expectLeftAlone(script, ['the constraint "t_x_chk" on "t"', 'the index "t_g_idx"']);
  });

  it("never drops a materialized view to get at the function", () => {
    const views = [view("m", " SELECT id\n   FROM t\n  WHERE g(x) > 0;", ["t"], true)];
    const script = migration(
      schema([t()], { routines: [g("bigint")], views }),
      schema([t()], { routines: [g("integer")], views })
    );

    expectLeftAlone(script, ['the materialized view "m"']);
    expect(script.statements.map((statement) => statement.sql).join("\n")).not.toContain(
      "DROP MATERIALIZED VIEW"
    );
  });

  it("does not drop a plain view when a materialized view is built on it", () => {
    // DROP VIEW ... CASCADE would take the materialized view's rows with it.
    const views = [callsG(), view("m", " SELECT id\n   FROM v;", ["v"], true)];
    const script = migration(
      schema([t()], { routines: [g("bigint")], views }),
      schema([t()], { routines: [g("integer")], views })
    );

    expectLeftAlone(script, ['the view "v" (a materialized view is built on it)']);
    expect(running(script)).not.toContain("DROP VIEW");
  });

  it("counts a table the script drops later: the drop comes after the functions", () => {
    // The rollback shape: the table that uses the function is on its way out,
    // but DROP TABLE is written after the function statements.
    const u = table("u", [id(), column("y", { typeDisplay: "bigint", columnDefault: "g(1)" })]);
    const script = migration(
      schema([t()], { routines: [g("integer")] }),
      schema([t(), u], { routines: [g("bigint")] }),
      true
    );

    expectLeftAlone(script, ['the default of "u"."y"']);
    expect(running(script)).toContain('DROP TABLE IF EXISTS "u" CASCADE;');
  });
});
