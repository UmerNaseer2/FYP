// generate-sql: when a CREATE FUNCTION has to come before CREATE TABLE.
//
// Functions are emitted after the tables on purpose, so a function whose body
// reads a new table finds it there. The opposite dependency breaks that order:
// `id text DEFAULT gen_ulid()` is resolved by PostgreSQL at CREATE TABLE time,
// so a new table naming a new function in a default, a generated column or a
// CHECK fails with "function does not exist" on a script the report called
// clean. Triggers are immune — they are created later still.
//
// These tests pin the ordering both ways round: the function a table needs is
// moved up, and the function nothing needs stays where the old order protects
// it.
import { compareSchemas } from "@/lib/compare";
import { generateMigration, renderMigrationScript } from "@/lib/generate-sql";
import { column, schema, table } from "./helpers/snapshots";
import type {
  ConstraintSnapshot,
  RoutineSnapshot,
  SchemaSnapshot,
  TableSnapshot,
} from "@/lib/postgres";

/** A function as the catalog records it. `definition` is what gets emitted. */
function routine(name: string, over: Partial<RoutineSnapshot> = {}): RoutineSnapshot {
  const args = over.identityArguments ?? "";
  const definition =
    over.definition ??
    `CREATE OR REPLACE FUNCTION ${name}(${args})\n RETURNS text\n LANGUAGE sql\nAS $function$ SELECT 'x' $function$`;
  return {
    name,
    kind: "FUNCTION",
    identityArguments: args,
    signature: `${name}(${args})`,
    returnType: "text",
    language: "sql",
    definition,
    normalizedDefinition: definition.toLowerCase(),
    ...over,
  };
}

/** A CHECK constraint as the catalog records it. */
function check(name: string, definition: string): ConstraintSnapshot {
  return {
    name,
    kind: "CHECK",
    columns: [],
    definition,
    normalizedDefinition: definition.toLowerCase(),
  };
}

/**
 * A source schema with `routines` recorded and a target with none of them.
 *
 * Both sides must record the collection or the comparator says nothing about
 * routines at all — `undefined` means "this snapshot never looked", which is
 * not the same as "there are none".
 */
function sourceAndTarget(
  tables: TableSnapshot[],
  routines: RoutineSnapshot[],
  targetTables: TableSnapshot[] = []
): [SchemaSnapshot, SchemaSnapshot] {
  return [
    schema(tables, { routines }),
    schema(targetTables, { routines: [] }),
  ];
}

/** The generated script as one string, so ordering can be read off it. */
function sql(source: SchemaSnapshot, target: SchemaSnapshot): string {
  return renderMigrationScript(generateMigration(compareSchemas(source, target)));
}

/** Where a fragment sits in the script. Fails loudly when it is not there. */
function at(script: string, fragment: RegExp): number {
  const index = script.search(fragment);
  if (index < 0) throw new Error(`not in the script: ${fragment}`);
  return index;
}

describe("a new function a new table cannot be built without", () => {
  it("is created before the table whose default calls it", () => {
    const [source, target] = sourceAndTarget(
      [table("events", [column("id", { typeDisplay: "text", columnDefault: "gen_ulid()" })])],
      [routine("gen_ulid")]
    );
    const script = sql(source, target);

    // The whole point: without this the CREATE TABLE runs first and the server
    // refuses it outright.
    expect(at(script, /CREATE OR REPLACE FUNCTION gen_ulid/)).toBeLessThan(
      at(script, /CREATE TABLE IF NOT EXISTS "events"/)
    );
  });

  it("is created before a table whose CHECK calls it", () => {
    const [source, target] = sourceAndTarget(
      [
        table("events", [column("code", { typeDisplay: "text" })], {
          checkConstraints: [check("events_code_ok", "CHECK (is_valid_code(code))")],
        }),
      ],
      [routine("is_valid_code", { identityArguments: "text" })]
    );
    const script = sql(source, target);

    expect(at(script, /CREATE OR REPLACE FUNCTION is_valid_code/)).toBeLessThan(
      at(script, /CREATE TABLE IF NOT EXISTS "events"/)
    );
  });

  it("is created before a table with a generated column calling it", () => {
    // A generated column's expression is held in its own field, never in
    // columnDefault, so reading defaults alone would miss this one entirely.
    const [source, target] = sourceAndTarget(
      [
        table("events", [
          column("body", { typeDisplay: "text" }),
          column("body_size", {
            typeDisplay: "integer",
            generated: { storage: "STORED", expression: "measure(body)" },
          }),
        ]),
      ],
      [routine("measure", { identityArguments: "text" })]
    );
    const script = sql(source, target);

    expect(at(script, /CREATE OR REPLACE FUNCTION measure/)).toBeLessThan(
      at(script, /CREATE TABLE IF NOT EXISTS "events"/)
    );
  });

  it("is still created exactly once", () => {
    // Moving a statement between phases is the kind of change that quietly
    // leaves a copy behind in the phase it came from.
    const [source, target] = sourceAndTarget(
      [table("events", [column("id", { typeDisplay: "text", columnDefault: "gen_ulid()" })])],
      [routine("gen_ulid")]
    );
    const script = sql(source, target);

    expect(script.match(/CREATE OR REPLACE FUNCTION gen_ulid/g)).toHaveLength(1);
  });

  it("comes after the types, because its signature can name one", () => {
    const [source, target] = sourceAndTarget(
      [table("events", [column("state", { typeDisplay: "mood", columnDefault: "default_mood()" })])],
      [routine("default_mood", { returnType: "mood" })]
    );
    const withTypes: SchemaSnapshot = {
      ...source,
      types: [
        {
          name: "mood",
          kind: "ENUM",
          labels: ["happy", "sad"],
          baseType: null,
          notNull: false,
          checks: [],
          attributes: [],
          definition: "",
          normalizedDefinition: "",
        },
      ],
    };
    const script = sql(withTypes, { ...target, types: [] });

    expect(at(script, /CREATE TYPE "mood"/)).toBeLessThan(
      at(script, /CREATE OR REPLACE FUNCTION default_mood/)
    );
  });
});

describe("a new function no new table needs", () => {
  it("stays after CREATE TABLE, so its body can read a new table", () => {
    // This is the order the hoist must not disturb. A function selecting from
    // a table the same migration creates is refused if it is written first.
    const [source, target] = sourceAndTarget(
      [table("events", [column("id", { typeDisplay: "text" })])],
      [
        routine("count_events", {
          definition:
            "CREATE OR REPLACE FUNCTION count_events()\n RETURNS bigint\n LANGUAGE sql\nAS $function$ SELECT count(*) FROM events $function$",
        }),
      ]
    );
    const script = sql(source, target);

    expect(at(script, /CREATE TABLE IF NOT EXISTS "events"/)).toBeLessThan(
      at(script, /CREATE OR REPLACE FUNCTION count_events/)
    );
  });

  it("is not hoisted because a column merely shares its name", () => {
    // `gen_ulid` on its own is a column reference, not a call. Hoisting on a
    // bare name would drag functions up for no reason and start eroding the
    // body-reads-a-table order that protects the rest.
    const [source, target] = sourceAndTarget(
      [table("events", [column("id", { typeDisplay: "text", columnDefault: "gen_ulid" })])],
      [routine("gen_ulid")]
    );
    const script = sql(source, target);

    expect(at(script, /CREATE TABLE IF NOT EXISTS "events"/)).toBeLessThan(
      at(script, /CREATE OR REPLACE FUNCTION gen_ulid/)
    );
  });

  it("is not hoisted when the default calls a longer name containing it", () => {
    // `gen_ulid` must not match inside `gen_ulid_v2`, or the wrong function
    // moves and the one that was actually needed stays behind.
    const [source, target] = sourceAndTarget(
      [table("events", [column("id", { typeDisplay: "text", columnDefault: "gen_ulid_v2()" })])],
      [routine("gen_ulid"), routine("gen_ulid_v2")]
    );
    const script = sql(source, target);

    const created = at(script, /CREATE TABLE IF NOT EXISTS "events"/);
    expect(at(script, /CREATE OR REPLACE FUNCTION gen_ulid_v2/)).toBeLessThan(created);
    expect(at(script, /CREATE OR REPLACE FUNCTION gen_ulid\(/)).toBeGreaterThan(created);
  });

  it("stays put when the default belongs to a table that already exists", () => {
    // An ALTER TABLE ... ADD COLUMN with that default runs after the routines
    // phase already, so there is nothing to fix and nothing to move.
    const existing = table("events", [
      column("id", { typeDisplay: "text" }),
      column("ref", { typeDisplay: "text", columnDefault: "gen_ulid()" }),
    ]);
    const [source, target] = sourceAndTarget(
      [existing],
      [routine("gen_ulid")],
      [table("events", [column("id", { typeDisplay: "text" })])]
    );
    const script = sql(source, target);

    expect(at(script, /CREATE OR REPLACE FUNCTION gen_ulid/)).toBeLessThan(
      at(script, /ADD COLUMN IF NOT EXISTS "ref"/)
    );
    expect(script).not.toMatch(/CREATE TABLE IF NOT EXISTS "events"/);
  });
});
