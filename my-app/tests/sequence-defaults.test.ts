// A nextval default is a serial only when the column owns the sequence.
//
// The compare engine and the SQL generator both used to call every
// DEFAULT nextval(...) a serial. Two columns reading two different standalone
// sequences were then "the same serial": the compare showed no difference, and
// the script's only step was a DROP SEQUENCE that PostgreSQL refuses, because
// the column still reads the sequence. A column gaining a default on a shared
// sequence was turned into its owner and the sequence's value was moved.
//
// These tests pin the rule on hand-made snapshots. The same cases run on a real
// PostgreSQL in generate-sql-db.test.ts.
import { compareSchemas, serialSides } from "@/lib/compare";
import { generateMigration, statementsThatRun } from "@/lib/generate-sql";
import type { SchemaSnapshot, SequenceOptions, SequenceSnapshot } from "@/lib/postgres";
import { column, schema, table } from "./helpers/snapshots";

const OPTIONS: SequenceOptions = {
  dataType: "integer",
  startValue: "1",
  increment: "1",
  minValue: "1",
  maxValue: "2147483647",
  cycles: false,
  cacheSize: "1",
};

/** A sequence nothing owns, as CREATE SEQUENCE makes it. */
function freeSequence(name: string): SequenceSnapshot {
  return { ...OPTIONS, name, ownedByTable: null, ownedByColumn: null };
}

/** A column whose default reads a sequence it does not own. */
function reads(sequence: string) {
  return column("id", {
    nullable: false,
    columnDefault: `nextval('${sequence}'::regclass)`,
    sequenceOptions: null,
  });
}

/** A real serial column: it owns the sequence its default reads. */
function serial(sequence: string) {
  return column("id", {
    nullable: false,
    columnDefault: `nextval('${sequence}'::regclass)`,
    sequenceOptions: OPTIONS,
  });
}

/** The live statements of the script that makes `target` look like `source`. */
function running(source: SchemaSnapshot, target: SchemaSnapshot): string[] {
  const script = generateMigration(compareSchemas(source, target), { allowDataLoss: true });
  return statementsThatRun(script).map((statement) => statement.sql);
}

describe("serialSides", () => {
  it("calls a column a serial only when it owns its sequence", () => {
    expect(serialSides(serial("t_id_seq"), reads("shared_seq"))).toEqual({
      left: true,
      right: false,
    });
  });

  it("keeps the old answer for snapshots that never recorded ownership", () => {
    const old = column("id", { columnDefault: "nextval('t_id_seq'::regclass)" });
    expect(serialSides(old, old)).toEqual({ left: true, right: true });
    expect(serialSides(old, reads("shared_seq"))).toEqual({ left: true, right: true });
  });
});

describe("defaults on standalone sequences", () => {
  const both = { sequences: [freeSequence("seq_a"), freeSequence("seq_b")] };

  it("reports a default that reads a different sequence as a Default change", () => {
    const report = compareSchemas(
      schema([table("t", [reads("seq_a")])], both),
      schema([table("t", [reads("seq_b")])], both)
    );
    const changes = report.matchedTables[0].columnMatches[0].changes;
    expect(changes.map((change) => change.kind)).toEqual(["default"]);
  });

  it("sets the new default and leaves both sequences alone", () => {
    const sql = running(
      schema([table("t", [reads("seq_a")])], both),
      schema([table("t", [reads("seq_b")])], both)
    );
    expect(sql).toEqual([
      `ALTER TABLE "t" ALTER COLUMN "id" SET DEFAULT nextval('seq_a'::regclass);`,
    ]);
  });

  it("sets the new default before it drops the sequence the old one read", () => {
    const sql = running(
      schema([table("o", [reads("other_seq")])], { sequences: [freeSequence("other_seq")] }),
      schema([table("o", [reads("plain_seq")])], { sequences: [freeSequence("plain_seq")] })
    );
    const setDefault = sql.findIndex((s) => s.includes("SET DEFAULT nextval('other_seq'"));
    const dropOld = sql.findIndex((s) => s.includes('DROP SEQUENCE IF EXISTS "plain_seq"'));
    expect(setDefault).toBeGreaterThan(-1);
    expect(dropOld).toBeGreaterThan(setDefault);
  });

  it("does not take over a shared sequence or move its value", () => {
    const shared = { sequences: [freeSequence("shared_seq")] };
    const noDefault = column("id", { nullable: false, sequenceOptions: null });
    const sql = running(
      schema([table("a", [reads("shared_seq")]), table("b", [reads("shared_seq")])], shared),
      schema([table("a", [noDefault]), table("b", [reads("shared_seq")])], shared)
    );
    expect(sql).toEqual([
      `ALTER TABLE "a" ALTER COLUMN "id" SET DEFAULT nextval('shared_seq'::regclass);`,
    ]);
  });
});

describe("real serial columns", () => {
  it("still read as the same serial on both sides", () => {
    const report = compareSchemas(
      schema([table("t", [serial("t_id_seq")])]),
      schema([table("t", [serial("t_id_seq")])])
    );
    expect(report.matchedTables[0].columnMatches[0].changes).toEqual([]);
  });

  it("still tie the sequence to a column that gains a serial", () => {
    const noDefault = column("id", { nullable: false, sequenceOptions: null });
    const sql = running(
      schema([table("t", [serial("t_id_seq")])]),
      schema([table("t", [noDefault])])
    ).join("\n");
    expect(sql).toContain('OWNED BY "t"."id"');
  });

  it("keep a standalone sequence the script hands to the serial column", () => {
    const sql = running(
      schema([table("t", [serial("t_id_seq")])]),
      schema([table("t", [reads("t_id_seq")])], { sequences: [freeSequence("t_id_seq")] })
    ).join("\n");
    expect(sql).toContain('OWNED BY "t"."id"');
    expect(sql).not.toContain("DROP SEQUENCE");
  });

  it("let go of their sequence when the source reads a standalone one", () => {
    const tickets = { sequences: [freeSequence("ticket_numbers")] };
    const sql = running(
      schema([table("t", [reads("ticket_numbers")])], tickets),
      schema([table("t", [serial("t_id_seq")])], tickets)
    );
    expect(sql).toEqual([
      `ALTER TABLE "t" ALTER COLUMN "id" SET DEFAULT nextval('ticket_numbers'::regclass);`,
      `DROP SEQUENCE IF EXISTS "t_id_seq";`,
    ]);
  });
});
