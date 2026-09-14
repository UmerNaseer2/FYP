import { compareSchemas } from "@/lib/compare";
import {
  generateMigration,
  migrationChangeLevel,
  renderMigrationScript,
} from "@/lib/generate-sql";
import {
  changeTypeOf,
  describeChangeType,
  gradeSql,
  inferChangeTypeFromSql,
  isScriptChangeType,
  louderChangeType,
  loudestChangeLevel,
  levelWithArticle,
  quieterLevelWarning,
  readChangeTypeHeader,
  stampChangeType,
} from "@/lib/change-type";
import type {
  ForeignKeySnapshot,
  IndexSnapshot,
  SchemaSnapshot,
  TriggerSnapshot,
} from "@/lib/postgres";
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

  // These used to match no branch at all and fall through to "patch", so a
  // script whose whole job was dropping a view told the deploy checklist that
  // nothing in the run was breaking.
  it("grades a dropped view, index, function or schema breaking too", () => {
    expect(inferChangeTypeFromSql("DROP VIEW big_orders;")).toBe("breaking");
    expect(inferChangeTypeFromSql("DROP MATERIALIZED VIEW totals;")).toBe("breaking");
    expect(inferChangeTypeFromSql("DROP INDEX orders_status_idx;")).toBe("breaking");
    expect(inferChangeTypeFromSql("DROP FUNCTION recalc(int);")).toBe("breaking");
    expect(inferChangeTypeFromSql("DROP TRIGGER audit_ins ON orders;")).toBe("breaking");
    expect(inferChangeTypeFromSql("DROP SEQUENCE order_no;")).toBe("breaking");
    expect(inferChangeTypeFromSql("DROP TYPE mood;")).toBe("breaking");
    expect(inferChangeTypeFromSql("DROP SCHEMA staging CASCADE;")).toBe("breaking");
  });

  // The change type answers how far the version moves, and a TRUNCATE moves it
  // nowhere. That is correct, and it is why the deploy screen asks about row
  // loss separately — see findRowDestroyingStatements.
  it("leaves a row-only change on patch", () => {
    expect(inferChangeTypeFromSql("TRUNCATE TABLE orders;")).toBe("patch");
  });

  // A generated script runs some statements from inside a DO block, behind a
  // lookup that skips them on a second run. maskNonCode blanks such a body
  // whole, so it is read on its own.
  it("reads the statements inside a DO block", () => {
    const sql = [
      "DO $guard$",
      "BEGIN",
      "  IF NOT EXISTS (SELECT 1) THEN",
      '    ALTER TABLE "orders" RENAME COLUMN "a" TO "b";',
      "  END IF;",
      "END",
      "$guard$;",
    ].join("\n");
    expect(inferChangeTypeFromSql(sql)).toBe("breaking");
  });

  it("still ignores a comment or a string inside a DO block", () => {
    const sql = "DO $$ BEGIN\n  -- DROP TABLE legacy\n  RAISE NOTICE 'drop table';\nEND $$;";
    expect(inferChangeTypeFromSql(sql)).toBe("patch");
  });

  // Creating a function runs nothing inside it. It does add a function, which
  // is how the generator grades CREATE FUNCTION too — so additive, never
  // breaking.
  it("does not read a function body as if it ran", () => {
    const sql =
      "CREATE FUNCTION purge() RETURNS void LANGUAGE plpgsql AS $$ BEGIN DROP TABLE legacy; END $$;";
    expect(inferChangeTypeFromSql(sql)).toBe("additive");
  });
});

describe("gradeSql — the generator's rules, read from the text", () => {
  it("leaves a changed default or a dropped NOT NULL on patch", () => {
    expect(gradeSql("ALTER TABLE t ALTER COLUMN a SET DEFAULT 0;").level).toBe("patch");
    expect(gradeSql("ALTER TABLE t ALTER COLUMN a DROP NOT NULL;").level).toBe("patch");
  });

  // A widening is safe and a narrowing is not, and the old type is not in
  // the text — so it is breaking unless, never sure.
  it("reads a type change as breaking unless it only widens the column", () => {
    const grade = gradeSql('ALTER TABLE t ALTER COLUMN "Note" TYPE text;');
    expect(grade.level).toBe("breaking");
    expect(grade.sureLevel).toBe("patch");
    expect(grade.because).toBe("ALTER COLUMN … TYPE");
    expect(grade.unless).toBe("it only widens the column, for example varchar(100) to varchar(200)");
  });

  it("does not read a new column named type as a type change", () => {
    expect(gradeSql("ALTER TABLE t ADD COLUMN type text;").level).toBe("additive");
  });

  it("reads a new unique index as surely breaking", () => {
    const grade = gradeSql("CREATE UNIQUE INDEX u ON t(a);");
    expect(grade.level).toBe("breaking");
    expect(grade.sureLevel).toBe("breaking");
    expect(grade.because).toBe("CREATE UNIQUE INDEX");
    expect(grade.unless).toBeNull();
  });

  it("reads a new constraint as breaking unless the table is new", () => {
    const grade = gradeSql("ALTER TABLE t ADD CONSTRAINT c CHECK (a > 0);");
    expect(grade.level).toBe("breaking");
    expect(grade.sureLevel).toBe("patch");
    expect(grade.because).toBe("ADD CONSTRAINT");
  });

  it("reads row security, policies, revokes and dropped collations as breaking", () => {
    expect(gradeSql("ALTER TABLE t ENABLE ROW LEVEL SECURITY;").level).toBe("breaking");
    expect(gradeSql("CREATE POLICY p ON t USING (true);").level).toBe("breaking");
    expect(gradeSql("REVOKE SELECT ON t FROM app;").level).toBe("breaking");
    expect(gradeSql("DROP COLLATION c;").level).toBe("breaking");
  });

  // The generator writes a changed trigger or index as a DROP straight
  // followed by the CREATE, and grades the pair by what is created.
  it("grades a replaced trigger or index by what is created", () => {
    const trigger = [
      "DROP TRIGGER IF EXISTS trg ON t;",
      "CREATE TRIGGER trg AFTER INSERT ON t FOR EACH ROW EXECUTE FUNCTION f();",
    ].join("\n");
    expect(gradeSql(trigger).level).toBe("additive");
    expect(gradeSql("DROP INDEX i; CREATE INDEX i ON t(b);").level).toBe("additive");
    expect(gradeSql("DROP INDEX i; CREATE UNIQUE INDEX i ON t(b);").level).toBe("breaking");
  });

  // Only the CREATE that puts the same thing back makes a replacement. Any
  // other pair takes the trigger or the index away for good.
  it("still counts a DROP followed by the CREATE of something else", () => {
    const otherTrigger = [
      "DROP TRIGGER audit_trg ON orders;",
      "CREATE TRIGGER other_trg AFTER INSERT ON orders FOR EACH ROW EXECUTE FUNCTION f();",
    ].join("\n");
    expect(gradeSql(otherTrigger).sureLevel).toBe("breaking");
    expect(gradeSql(otherTrigger).because).toBe("DROP TRIGGER");
    const otherTable =
      "DROP TRIGGER trg ON orders; CREATE TRIGGER trg AFTER INSERT ON invoices FOR EACH ROW EXECUTE FUNCTION f();";
    expect(gradeSql(otherTable).sureLevel).toBe("breaking");
    const otherSchema =
      "DROP TRIGGER trg ON sales.orders; CREATE TRIGGER trg AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION f();";
    expect(gradeSql(otherSchema).sureLevel).toBe("breaking");

    expect(gradeSql("DROP INDEX i; CREATE INDEX j ON t(b);").level).toBe("breaking");
    // An index created without a name gets a new one.
    expect(gradeSql("DROP INDEX i; CREATE INDEX ON t(b);").level).toBe("breaking");
    expect(gradeSql("DROP INDEX i, j; CREATE INDEX i ON t(b);").level).toBe("breaking");
    // An index lives in its table's schema.
    expect(gradeSql("DROP INDEX sales.i; CREATE INDEX i ON public.t(b);").level).toBe("breaking");
    expect(gradeSql("DROP INDEX sales.i; CREATE INDEX i ON sales.t(b);").level).toBe("additive");
  });

  it("reads quoted names the way PostgreSQL does", () => {
    // The generator's own shape: quoted names in the DROP, and PostgreSQL's
    // text, with the schema in front of the table, in the CREATE.
    const sameTrigger =
      'DROP TRIGGER IF EXISTS "Audit" ON "Orders"; ' +
      'CREATE TRIGGER "Audit" AFTER UPDATE ON public."Orders" FOR EACH ROW EXECUTE FUNCTION f();';
    expect(gradeSql(sameTrigger).level).toBe("additive");
    expect(
      gradeSql('DROP INDEX IF EXISTS "orders_note_idx"; CREATE INDEX orders_note_idx ON orders (note);').level
    ).toBe("additive");

    // A quoted name keeps its case, so "Audit" and audit are two triggers.
    const otherCase =
      'DROP TRIGGER "Audit" ON orders; CREATE TRIGGER audit AFTER UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION f();';
    expect(gradeSql(otherCase).sureLevel).toBe("breaking");

    // A column called "on" is not the ON that names the table.
    const quotedOn =
      'DROP TRIGGER trg ON t; CREATE TRIGGER trg AFTER UPDATE OF "on" ON t FOR EACH ROW EXECUTE FUNCTION f();';
    expect(gradeSql(quotedOn).level).toBe("additive");
  });

  it("still grades a lone dropped index or trigger breaking", () => {
    expect(gradeSql("DROP INDEX orders_status_idx;").level).toBe("breaking");
    expect(gradeSql("DROP INDEX orders_status_idx;").sureLevel).toBe("patch");
    expect(gradeSql("DROP TRIGGER audit_ins ON orders;").sureLevel).toBe("breaking");
  });

  it("leaves a new enum value on patch", () => {
    expect(gradeSql("ALTER TYPE mood ADD VALUE 'meh';").level).toBe("patch");
  });

  // PostgreSQL accepts DROP without the COLUMN keyword.
  it("reads a column drop written without the COLUMN keyword", () => {
    expect(gradeSql("ALTER TABLE t DROP legacy;").sureLevel).toBe("breaking");
    expect(gradeSql('ALTER TABLE t DROP "Legacy";').sureLevel).toBe("breaking");
    expect(gradeSql("ALTER TABLE t DROP legacy;").because).toBe("DROP COLUMN");
  });

  it("reads a new view as additive", () => {
    expect(gradeSql("CREATE VIEW v AS SELECT 1;").level).toBe("additive");
  });

  // The statement named to the user is a sure one, even when an uncertain one
  // comes first in the script.
  it("names a surely breaking statement before an uncertain one", () => {
    const grade = gradeSql("ALTER TABLE t ADD CONSTRAINT c CHECK (a > 0);\nDROP TABLE legacy;");
    expect(grade.because).toBe("DROP TABLE");
    expect(grade.unless).toBeNull();
  });
});

/**
 * The reader and the generator must never disagree in the loud direction. If a
 * generated script's SQL read as SURELY breaking while the generator graded it
 * quieter, every generated trigger or index change would reach Deploy with a
 * "Marked additive, but…" note it does not deserve.
 */
describe("gradeSql agrees with the generator", () => {
  const note = column("note", { typeDisplay: "text" });

  function withTrigger(event: "INSERT" | "UPDATE"): SchemaSnapshot {
    const definition =
      `CREATE TRIGGER orders_audit AFTER ${event} ON public.orders ` +
      "FOR EACH ROW EXECUTE FUNCTION audit()";
    const trigger: TriggerSnapshot = {
      name: "orders_audit",
      definition,
      normalizedDefinition: definition,
      functionName: "audit",
      enabled: true,
    };
    return schema([table("orders", [column("id"), note], { triggers: [trigger] })]);
  }

  function withIndex(columns: string[]): SchemaSnapshot {
    const definition = `CREATE INDEX orders_note_idx ON orders USING btree (${columns.join(", ")})`;
    const index: IndexSnapshot = {
      name: "orders_note_idx",
      definition,
      normalizedDefinition: definition,
      columns,
      isUnique: false,
      method: "btree",
      predicate: null,
    };
    return schema([table("orders", [column("id"), note], { indexes: [index] })]);
  }

  const customers = table("customers", [column("id", { nullable: false })]);
  const invoiceFk: ForeignKeySnapshot = {
    name: "invoices_customer_fk",
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
  const invoices = table(
    "invoices",
    [column("id", { nullable: false }), column("customer_id")],
    { foreignKeys: [invoiceFk] }
  );

  function withNoteType(typeDisplay: string): SchemaSnapshot {
    return schema([table("orders", [column("id"), column("note", { typeDisplay })])]);
  }

  // `shows` is a piece of SQL the fixture must really produce, so a fixture
  // that silently stopped generating its statement fails here instead of
  // passing for the wrong reason.
  const cases = [
    {
      name: "a changed trigger",
      source: withTrigger("UPDATE"),
      target: withTrigger("INSERT"),
      allowDataLoss: false,
      shows: "DROP TRIGGER IF EXISTS",
    },
    {
      name: "a changed non-unique index",
      source: withIndex(["note", "id"]),
      target: withIndex(["note"]),
      allowDataLoss: false,
      shows: "CREATE INDEX",
    },
    {
      name: "a new table with a foreign key",
      source: schema([customers, invoices]),
      target: schema([customers]),
      allowDataLoss: false,
      shows: "FOREIGN KEY",
    },
    {
      name: "a widened varchar",
      source: withNoteType("character varying(200)"),
      target: withNoteType("character varying(100)"),
      allowDataLoss: false,
      shows: "TYPE character varying(200)",
    },
    {
      name: "a dropped column with data loss armed",
      source: schema([table("orders", [column("id")])]),
      target: schema([table("orders", [column("id"), column("legacy")])]),
      allowDataLoss: true,
      shows: "DROP COLUMN",
    },
    {
      name: "a safe-mode script whose drop is held back",
      source: SOURCE,
      target: TARGET,
      allowDataLoss: false,
      shows: "CREATE TABLE",
    },
  ];

  it.each(cases)("$name", ({ source, target, allowDataLoss, shows }) => {
    const script = generateMigration(compareSchemas(source, target), { allowDataLoss });
    const generated = migrationChangeLevel(script);
    // The generator never answers "unknown". Failing loudly here keeps the
    // checks below typed as the three levels a script can carry.
    if (generated === "unknown") throw new Error("the generator graded a script unknown");
    const sql = renderMigrationScript(script);
    expect(sql).toContain(shows);

    expect(louderChangeType(gradeSql(sql).sureLevel, generated)).toBe(generated);

    // So Deploy shows no note on a script straight from the generator, and
    // counts it as breaking exactly when the generator did.
    const reading = describeChangeType(sql);
    expect(reading.louderNote).toBeNull();
    expect(reading.countsAsBreaking).toBe(generated === "breaking");
  });
});

describe("stampChangeType", () => {
  it("replaces the value of an existing header line", () => {
    expect(stampChangeType("-- Change-type: additive\nSELECT 1;", "breaking")).toBe(
      "-- Change-type: breaking\nSELECT 1;"
    );
  });

  it("replaces the line where it is, lower in the header", () => {
    const sql = "-- Sync orders\n-- Change-type: patch\n\nSELECT 1;";
    expect(stampChangeType(sql, "additive")).toBe(
      "-- Sync orders\n-- Change-type: additive\n\nSELECT 1;"
    );
  });

  it("inserts the line at the top when there is none", () => {
    expect(stampChangeType("ALTER TABLE t ADD COLUMN a int;", "additive")).toBe(
      "-- Change-type: additive\nALTER TABLE t ADD COLUMN a int;"
    );
  });

  // A line of the same shape after the first statement is not the header, so
  // it is left alone and the stamp goes on top, where the reader looks.
  it("does not mistake a line below the first statement for the header", () => {
    const sql = "SELECT 1;\n-- Change-type: patch\n";
    expect(stampChangeType(sql, "breaking")).toBe(`-- Change-type: breaking\n${sql}`);
  });

  it("leaves one line when a script is stamped twice", () => {
    const twice = stampChangeType(stampChangeType("SELECT 1;", "patch"), "breaking");
    expect(twice.match(/Change-type:/g)).toHaveLength(1);
    expect(twice).toBe("-- Change-type: breaking\nSELECT 1;");
  });

  it("round-trips through readChangeTypeHeader", () => {
    for (const level of ["breaking", "additive", "patch"] as const) {
      expect(readChangeTypeHeader(stampChangeType("SELECT 1;", level))).toBe(level);
      expect(readChangeTypeHeader(stampChangeType("-- Change-type: patch\nSELECT 1;", level))).toBe(
        level
      );
    }
  });

  it("changes nothing in a generated script restamped with its own level", () => {
    const sql = renderMigrationScript(additiveWithHeldBackDrop());
    expect(readChangeTypeHeader(sql)).toBe("additive");
    expect(stampChangeType(sql, "additive")).toBe(sql);
  });
});

describe("describeChangeType", () => {
  it("keeps the label's level but counts an always-breaking drop", () => {
    const reading = describeChangeType("-- Change-type: additive\nDROP TABLE x;");
    expect(reading.declared).toBe("additive");
    expect(reading.recorded).toBe("additive");
    expect(reading.countsAsBreaking).toBe(true);
    expect(reading.louderNote).toBe(
      "Marked additive, but its SQL has DROP TABLE, which is always breaking — " +
        "it is counted in the breaking checks."
    );
  });

  // The CREATE here adds a different trigger, so audit_trg is gone for good.
  it("counts a dropped trigger that the next statement does not put back", () => {
    const reading = describeChangeType(
      [
        "-- Change-type: additive",
        "DROP TRIGGER audit_trg ON orders;",
        "CREATE TRIGGER other_trg AFTER INSERT ON orders FOR EACH ROW EXECUTE FUNCTION f();",
      ].join("\n")
    );
    expect(reading.recorded).toBe("additive");
    expect(reading.countsAsBreaking).toBe(true);
    expect(reading.louderNote).toBe(
      "Marked additive, but its SQL has DROP TRIGGER, which is always breaking — " +
        "it is counted in the breaking checks."
    );
  });

  // Whoever wrote the label knew the old column type; the SQL does not say.
  it("lets the label settle a type change the SQL alone cannot", () => {
    const reading = describeChangeType(
      "-- Change-type: patch\nALTER TABLE t ALTER COLUMN a TYPE varchar(200);"
    );
    expect(reading.recorded).toBe("patch");
    expect(reading.countsAsBreaking).toBe(false);
    expect(reading.louderNote).toBeNull();
  });

  it("does not flag a foreign key on a table the same script creates", () => {
    const sql = [
      "-- Change-type: additive",
      "CREATE TABLE invoices (id int, customer_id int);",
      "ALTER TABLE invoices ADD CONSTRAINT invoices_customer_fk",
      "  FOREIGN KEY (customer_id) REFERENCES customers(id);",
    ].join("\n");
    const reading = describeChangeType(sql);
    expect(reading.countsAsBreaking).toBe(false);
    expect(reading.louderNote).toBeNull();
  });

  it("falls back to the SQL reading when there is no label", () => {
    const reading = describeChangeType("ALTER TABLE t ADD CONSTRAINT c CHECK (a > 0);");
    expect(reading.declared).toBeNull();
    expect(reading.recorded).toBe("breaking");
    expect(reading.countsAsBreaking).toBe(true);
    expect(reading.louderNote).toBeNull();
  });

  it("counts a script labelled breaking even when its SQL looks harmless", () => {
    const reading = describeChangeType("-- Change-type: breaking\nCOMMENT ON TABLE t IS 'x';");
    expect(reading.recorded).toBe("breaking");
    expect(reading.countsAsBreaking).toBe(true);
    expect(reading.louderNote).toBeNull();
  });

  // script_patch.change_type and the lineage bump read `recorded`, so it must
  // stay exactly what changeTypeOf has always returned.
  it("records exactly what changeTypeOf returns", () => {
    const scripts = [
      "-- Change-type: additive\nDROP TABLE x;",
      "ALTER TABLE t ADD COLUMN note text;",
      "DROP VIEW v;",
      renderMigrationScript(additiveWithHeldBackDrop()),
    ];
    for (const sql of scripts) {
      expect(describeChangeType(sql).recorded).toBe(changeTypeOf(sql));
    }
  });
});

describe("louderChangeType", () => {
  it("keeps the louder of two levels", () => {
    expect(louderChangeType("patch", "breaking")).toBe("breaking");
    expect(louderChangeType("additive", "patch")).toBe("additive");
    expect(louderChangeType("patch", "patch")).toBe("patch");
  });

  it("ranks unknown below patch, so a missing level never outranks a real one", () => {
    expect(louderChangeType("patch", "unknown")).toBe("patch");
    expect(louderChangeType("unknown", "patch")).toBe("patch");
    expect(louderChangeType("unknown", "unknown")).toBe("unknown");
    expect(louderChangeType("additive", "breaking")).toBe("breaking");
    expect(louderChangeType("breaking", "additive")).toBe("breaking");
  });
});

describe("loudestChangeLevel", () => {
  it("records the loudest level in a run, and unknown for an empty one", () => {
    expect(loudestChangeLevel(["patch", "breaking", "additive"])).toBe("breaking");
    expect(loudestChangeLevel(["unknown", "patch"])).toBe("patch");
    expect(loudestChangeLevel(["unknown"])).toBe("unknown");
    expect(loudestChangeLevel([])).toBe("unknown");
  });
});

describe("isScriptChangeType", () => {
  it("accepts exactly the three levels a script can carry", () => {
    expect(["breaking", "additive", "patch"].every(isScriptChangeType)).toBe(true);
    for (const value of ["unknown", "Breaking", "major", "", null, undefined, 3]) {
      expect(isScriptChangeType(value)).toBe(false);
    }
  });
});

describe("quieterLevelWarning — the tick for publishing quieter than graded", () => {
  it("asks for a tick, naming the statement, when a breaking script is published quieter", () => {
    expect(quieterLevelWarning("breaking", "additive", "DROP TABLE")).toBe(
      "This is graded breaking because of DROP TABLE. Publish it as additive anyway — the version number will understate the change.",
    );
  });

  it("leaves the reason out when there is no statement to name", () => {
    expect(quieterLevelWarning("breaking", "patch", null)).toBe(
      "This is graded breaking. Publish it as patch anyway — the version number will understate the change.",
    );
  });

  it("names no statement for an additive grade, even if one is passed", () => {
    expect(quieterLevelWarning("additive", "patch", "CREATE TABLE")).toBe(
      "This is graded additive. Publish it as patch anyway — the version number will understate the change.",
    );
  });

  it("needs no tick for the same level or a louder one", () => {
    expect(quieterLevelWarning("additive", "additive", null)).toBeNull();
    expect(quieterLevelWarning("patch", "breaking", null)).toBeNull();
    expect(quieterLevelWarning("additive", "breaking", null)).toBeNull();
    expect(quieterLevelWarning("breaking", "breaking", "DROP TABLE")).toBeNull();
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

describe("quieterLevelWarning — a family's first version", () => {
  it("names the recorded level, not the number, since a first version is 1.0.0 at every level", () => {
    expect(quieterLevelWarning("breaking", "patch", "DROP TABLE", true)).toBe(
      "This is graded breaking because of DROP TABLE. Publish it as patch anyway — the level recorded with it will understate the change.",
    );
  });

  it("still needs no tick for the same or a louder level", () => {
    expect(quieterLevelWarning("additive", "breaking", null, true)).toBeNull();
    expect(quieterLevelWarning("patch", "patch", null, true)).toBeNull();
  });
});

describe("levelWithArticle", () => {
  it("gives each level its article, so no sentence says 'a additive'", () => {
    expect(levelWithArticle("breaking")).toBe("a breaking");
    expect(levelWithArticle("additive")).toBe("an additive");
    expect(levelWithArticle("patch")).toBe("a patch");
  });
});
