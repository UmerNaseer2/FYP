import type {
  ColumnSnapshot,
  SchemaSnapshot,
  TableSnapshot,
} from "@/lib/postgres";

/**
 * Small builders for the snapshot shapes the compare engine eats.
 *
 * A real snapshot comes off a live database with dozens of fields per column,
 * and writing one out by hand in every test would bury the one difference the
 * test is actually about. These fill in a plausible default for everything and
 * let a test name only what matters.
 *
 * Optionality is preserved deliberately: the engine reads `undefined` as "this
 * snapshot never recorded that" and `[]` as "recorded, and there are none", so
 * a builder that helpfully defaulted every optional array to `[]` would make
 * every test lie about what the snapshot knows.
 */
export function column(
  name: string,
  over: Partial<ColumnSnapshot> = {}
): ColumnSnapshot {
  return {
    name,
    ordinalPosition: 1,
    typeDisplay: "integer",
    nullable: true,
    columnDefault: null,
    isPrimaryKey: false,
    uniqueConstraintNames: [],
    foreignKeyConstraintNames: [],
    ...over,
  };
}

export function table(
  name: string,
  columns: ColumnSnapshot[],
  over: Partial<TableSnapshot> = {}
): TableSnapshot {
  return {
    name,
    columns: columns.map((c, index) => ({ ...c, ordinalPosition: index + 1 })),
    primaryKey: null,
    uniqueConstraints: [],
    foreignKeys: [],
    checkConstraints: [],
    excludeConstraints: [],
    ...over,
  };
}

export function schema(
  tables: TableSnapshot[],
  over: Partial<SchemaSnapshot> = {}
): SchemaSnapshot {
  return { database: "db", schema: "public", tables, ...over };
}
