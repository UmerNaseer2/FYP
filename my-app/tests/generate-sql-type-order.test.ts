// generate-sql: new types are created after the types they are built from,
// and dropped before them.
//
// The comparison sorts its diffs by kind and then by name (composite types,
// domains, enums, ranges), and the generator wrote types in that order.
// CREATE DOMAIN needs its base type to exist, so a new domain "happy_mood" over
// a new enum "mood" came first and the migration stopped on
// `type "mood" does not exist`. A composite field and a range subtype need the
// same. DROP TYPE carries no CASCADE, so drops need the mirror image, or the
// rollback stops on "cannot drop type ... because other objects depend on it".
//
// Checked on a real PostgreSQL 18 while fixing it, with the types below plus
// a range, a domain over it and the two chained domains: before, the
// migration stopped on its first statement (`type "happy_mood[]" does not
// exist`, from the composite) and dropping them all stopped on "a_base";
// after, all eight are created, the rollback drops them, and so does the drop.
import { compareSchemas } from "@/lib/compare";
import { generateMigration, generateRollback, statementsThatRun } from "@/lib/generate-sql";
import type { SchemaSnapshot, TypeSnapshot } from "@/lib/postgres";
import { schema } from "./helpers/snapshots";

function type(name: string, over: Partial<TypeSnapshot>): TypeSnapshot {
  const base: TypeSnapshot = {
    name,
    kind: "ENUM",
    labels: [],
    baseType: null,
    notNull: false,
    checks: [],
    attributes: [],
    definition: "",
    normalizedDefinition: "",
    ...over,
  };
  const text = `${base.kind} ${base.labels.join(",")} ${base.baseType ?? ""} ${base.attributes.join(",")}`;
  return { ...base, definition: text, normalizedDefinition: text };
}

const mood = type("mood", { kind: "ENUM", labels: ["sad", "happy"] });
// Domains sort before enums, so this came first, which is the whole problem.
const happyMood = type("happy_mood", { kind: "DOMAIN", baseType: "mood" });
const feeling = type("a_feeling", {
  kind: "COMPOSITE",
  attributes: ["how happy_mood[]", "note text"],
});
const unrelated = type("b_colour", { kind: "ENUM", labels: ["red"] });

const withTypes = (types: TypeSnapshot[]): SchemaSnapshot => schema([], { types });

/** Where each type's CREATE is in the statements that run. */
function createdAt(sql: string[], name: string): number {
  return sql.findIndex((s) => new RegExp(`CREATE (DOMAIN|TYPE) "${name}"`).test(s));
}

function droppedAt(sql: string[], name: string): number {
  return sql.findIndex((s) => new RegExp(`DROP (DOMAIN|TYPE) IF EXISTS "${name}"`).test(s));
}

describe("creating types", () => {
  const report = compareSchemas(withTypes([feeling, unrelated, happyMood, mood]), withTypes([]));
  const sql = statementsThatRun(generateMigration(report)).map((s) => s.sql);

  it("creates each type after the types it is built from", () => {
    for (const name of ["mood", "happy_mood", "a_feeling", "b_colour"]) {
      expect(createdAt(sql, name)).toBeGreaterThanOrEqual(0);
    }
    // A domain over an enum, and a composite with a field of that domain.
    expect(createdAt(sql, "mood")).toBeLessThan(createdAt(sql, "happy_mood"));
    expect(createdAt(sql, "happy_mood")).toBeLessThan(createdAt(sql, "a_feeling"));
  });

  it("keeps types that need nothing in the order the comparison listed them", () => {
    const size = type("c_size", { kind: "ENUM", labels: ["s"] });
    const out = statementsThatRun(
      generateMigration(compareSchemas(withTypes([size, unrelated]), withTypes([])))
    ).map((s) => s.sql);
    expect(createdAt(out, "b_colour")).toBeGreaterThanOrEqual(0);
    expect(createdAt(out, "b_colour")).toBeLessThan(createdAt(out, "c_size"));
  });

  it("does not read a composite field's own name as a type", () => {
    // A field called "mood" of type text needs no enum called mood.
    const named = type("a_note", { kind: "COMPOSITE", attributes: ["mood text"] });
    const out = statementsThatRun(
      generateMigration(compareSchemas(withTypes([named, mood]), withTypes([])))
    ).map((s) => s.sql);
    expect(createdAt(out, "a_note")).toBeLessThan(createdAt(out, "mood"));
  });

  it("puts a domain after the range it is a domain over", () => {
    // Domains sort before ranges, so this one failed the same way.
    const span = type("span", {
      kind: "RANGE",
      baseType: "numeric",
      rangeDetails: {
        subtypeOpclass: null,
        collation: null,
        canonical: null,
        subtypeDiff: null,
        multirangeName: null,
        needsManualCreate: false,
      },
    });
    const shortSpan = type("short_span", { kind: "DOMAIN", baseType: "span" });
    const out = statementsThatRun(
      generateMigration(compareSchemas(withTypes([span, shortSpan]), withTypes([])))
    ).map((s) => s.sql);
    expect(createdAt(out, "span")).toBeGreaterThanOrEqual(0);
    expect(createdAt(out, "span")).toBeLessThan(createdAt(out, "short_span"));
  });
});

describe("dropping types", () => {
  // Types of one kind sort by name, so "a_base" came before "b_derived", which
  // is built on it, and DROP DOMAIN "a_base" stopped on the domain still using it.
  const base = type("a_base", { kind: "DOMAIN", baseType: "text" });
  const derived = type("b_derived", { kind: "DOMAIN", baseType: "a_base" });

  it("drops each type before the types it is built from", () => {
    const sql = statementsThatRun(
      generateMigration(compareSchemas(withTypes([]), withTypes([derived, base])), { allowDataLoss: true })
    ).map((s) => s.sql);
    expect(droppedAt(sql, "a_base")).toBeGreaterThanOrEqual(0);
    expect(droppedAt(sql, "b_derived")).toBeGreaterThanOrEqual(0);
    expect(droppedAt(sql, "b_derived")).toBeLessThan(droppedAt(sql, "a_base"));
  });

  it("does the same in the rollback", () => {
    const report = compareSchemas(
      withTypes([feeling, unrelated, happyMood, mood, base, derived]),
      withTypes([])
    );
    const sql = generateRollback(report).statements.map((s) => s.sql);

    for (const name of ["mood", "happy_mood", "a_feeling", "a_base", "b_derived"]) {
      expect(droppedAt(sql, name)).toBeGreaterThanOrEqual(0);
    }
    expect(droppedAt(sql, "a_feeling")).toBeLessThan(droppedAt(sql, "happy_mood"));
    expect(droppedAt(sql, "happy_mood")).toBeLessThan(droppedAt(sql, "mood"));
    expect(droppedAt(sql, "b_derived")).toBeLessThan(droppedAt(sql, "a_base"));
  });
});
