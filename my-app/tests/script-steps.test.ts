// The steps list beside the full screen script: one step per statement, in run
// order, labelled from the generator's "-- [TAG] what it does" line, with the
// drops safe mode holds back and the notes listed too, so the list and the
// count under it agree with the script.
import { compareSchemas } from "@/lib/compare";
import { generateMigration, renderMigrationScript } from "@/lib/generate-sql";
import { scriptSteps, stepKind } from "@/lib/script-steps";
import { column, schema, table } from "./helpers/snapshots";

describe("scriptSteps", () => {
  it("labels each statement from the tag line above it", () => {
    const sql = [
      "-- [SAFE] Create table \"books\"",
      "CREATE TABLE books (id integer);",
      "",
      "-- [BREAKING] Widen \"title\" in \"courses\": varchar(100) → varchar(150)",
      "ALTER TABLE courses ALTER COLUMN title TYPE varchar(150);",
    ].join("\n");
    const steps = scriptSteps(sql);
    expect(steps).toEqual([
      { line: 2, offset: sql.indexOf("CREATE"), label: 'Create table "books"', kind: "add" },
      {
        line: 5,
        offset: sql.indexOf("ALTER"),
        label: 'Widen "title" in "courses": varchar(100) → varchar(150)',
        kind: "chg",
      },
    ]);
  });

  it("lists a drop held back by safe mode as a step that does not run", () => {
    const sql = [
      "-- [SAFE] Add column \"email\" to \"users\"",
      "ALTER TABLE users ADD COLUMN email text;",
      "-- [NOT EXECUTED — BREAKING] Drop column \"age\" from \"users\" — WARNING: removes the column and its data",
      "-- ALTER TABLE users DROP COLUMN age;",
    ].join("\n");
    const steps = scriptSteps(sql);
    expect(steps).toHaveLength(2);
    expect(steps[1]).toMatchObject({
      line: 3,
      label: 'Drop column "age" from "users"',
      kind: "rem",
      idle: "held",
    });
  });

  it("lists a tag with nothing under it as a note", () => {
    const steps = scriptSteps("-- [INFO] Comments differ on \"users\"\n");
    expect(steps).toEqual([
      expect.objectContaining({ line: 1, idle: "note", label: 'Comments differ on "users"' }),
    ]);
  });

  it("keeps a DO block with semicolons inside it as one step", () => {
    const sql = [
      "-- [SAFE] Create type \"mood\"",
      "DO $guard$ BEGIN",
      "  CREATE TYPE mood AS ENUM ('ok');",
      "EXCEPTION WHEN duplicate_object THEN NULL;",
      "END $guard$;",
      "-- [SAFE] Create table \"t\"",
      "CREATE TABLE t (m mood);",
    ].join("\n");
    const steps = scriptSteps(sql);
    expect(steps.map((step) => [step.line, step.label])).toEqual([
      [2, 'Create type "mood"'],
      [7, 'Create table "t"'],
    ]);
  });

  it("does not end a step at a semicolon inside a string or a comment", () => {
    const steps = scriptSteps("INSERT INTO notes VALUES ('a; b'); -- done; really\nSELECT 1;");
    expect(steps.map((step) => step.line)).toEqual([1, 2]);
  });

  it("labels a hand-written script without tags by its first line of code", () => {
    const sql = "create index on users (email);\n\ndrop table old_logs;\n";
    expect(scriptSteps(sql)).toEqual([
      { line: 1, offset: 0, label: "create index on users (email)", kind: "add" },
      { line: 3, offset: sql.indexOf("drop"), label: "drop table old_logs", kind: "rem" },
    ]);
  });

  it("counts one step per statement of a real generated script", () => {
    const report = compareSchemas(
      schema([
        table("users", [column("id"), column("email", { typeDisplay: "text" })]),
        table("books", [column("id")]),
      ]),
      schema([table("users", [column("id"), column("age")])]),
    );
    const script = generateMigration(report, { allowDataLoss: false });
    const steps = scriptSteps(renderMigrationScript(script));
    const running = steps.filter((step) => step.idle === undefined);
    const held = steps.filter((step) => step.idle === "held");
    expect(running.length + held.length).toBe(script.statements.length);
    expect(held.map((step) => step.kind)).toEqual(["rem"]);
    expect(steps.every((step) => !step.label.endsWith("…") || step.label.length === 96)).toBe(true);
  });
});

describe("stepKind", () => {
  it.each([
    ["CREATE TABLE t (id int)", "add"],
    ["create or replace view v as select 1", "chg"],
    ["ALTER TABLE t ADD COLUMN c int", "add"],
    ["ALTER TABLE t DROP COLUMN c", "rem"],
    ["ALTER TABLE t ALTER COLUMN c TYPE text", "chg"],
    ["DROP INDEX i", "rem"],
    ["GRANT SELECT ON t TO r", "add"],
    ["REVOKE SELECT ON t FROM r", "rem"],
  ])("%s is %s", (code, kind) => {
    expect(stepKind(code)).toBe(kind);
  });
});
