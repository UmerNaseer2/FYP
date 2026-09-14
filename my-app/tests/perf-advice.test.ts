import {
  analyzeSchemaPerformance as analyzeSchemaPerformanceRaw,
  analyzeTableStats as analyzeTableStatsRaw,
  attachForeignKeyIndexes as attachForeignKeyIndexesRaw,
  describeStatsError,
  describeStructureError,
  foreignKeyIndexes,
  sortAdvice,
  summarizeAdvice,
  withoutRepeatedDrops,
  type ForeignKeyIndexes,
  type IndexStats,
  type PerfAdvice,
  type TableStats,
} from "@/lib/perf-advice";
import type { FixKind } from "@/lib/perf-sql";
import type {
  ColumnSnapshot,
  ConstraintSnapshot,
  ForeignKeySnapshot,
  IndexSnapshot,
  SchemaSnapshot,
  SequenceSnapshot,
  TablePartitioning,
  TableSnapshot,
} from "@/lib/postgres";
import { allFixProblems, fixProblems } from "./helpers/fix-invariants";

/**
 * Performance advice is the one feature in this app that tells a user their own
 * database is wrong, so the bar for a finding is high: it has to be right, and
 * it has to stay quiet when it does not know.
 *
 * Two properties are worth more than the individual rules and are checked
 * hardest here. First, an optional collection a snapshot never recorded means
 * the rules that need it are SKIPPED — a baseline captured before indexes were
 * read must not produce "no index supports this foreign key" for every key in
 * the schema. Second, every stats rule has a floor on table size as well as a
 * ratio, because a hundred sequential scans of a twelve-row lookup table is the
 * correct plan and reporting it would teach the reader to ignore the screen.
 *
 * The fixes are pasted into real servers, so every finding any test here
 * produces is kept, and the last block holds each fix to what its kind
 * promises (tests/helpers/fix-invariants.ts): a change or maintenance fix is
 * complete, runnable SQL; a decision is comments only, even when a name in it
 * has a line break.
 */

/** Ids of the advice returned, so a test can assert on what fired. */
function ids(advice: PerfAdvice[]): string[] {
  return advice.map((a) => a.id);
}

/** The one finding with this id; the test fails when there is not exactly one. */
function one(advice: PerfAdvice[], id: string): PerfAdvice {
  const found = advice.filter((a) => a.id === id);
  expect(found).toHaveLength(1);
  return found[0];
}

/**
 * Every finding the tests below produce, so the last block can hold all of
 * them to the promises their kind makes, edge cases included. Jest runs the
 * tests in a file in the order they are written, so it is full by then.
 */
const collected: PerfAdvice[] = [];

/** analyzeSchemaPerformance, keeping what it returns in `collected`. */
function analyzeSchemaPerformance(...args: Parameters<typeof analyzeSchemaPerformanceRaw>): PerfAdvice[] {
  const advice = analyzeSchemaPerformanceRaw(...args);
  collected.push(...advice);
  return advice;
}

/** analyzeTableStats, keeping what it returns in `collected`. */
function analyzeTableStats(...args: Parameters<typeof analyzeTableStatsRaw>): PerfAdvice[] {
  const advice = analyzeTableStatsRaw(...args);
  collected.push(...advice);
  return advice;
}

/** attachForeignKeyIndexes, keeping what it returns in `collected`. */
function attachForeignKeyIndexes(advice: PerfAdvice[]): PerfAdvice[] {
  const attached = attachForeignKeyIndexesRaw(advice);
  collected.push(...attached);
  return attached;
}

function column(name: string, typeDisplay: string, extra: Partial<ColumnSnapshot> = {}): ColumnSnapshot {
  return {
    name,
    ordinalPosition: 1,
    typeDisplay,
    nullable: true,
    columnDefault: null,
    isPrimaryKey: false,
    uniqueConstraintNames: [],
    foreignKeyConstraintNames: [],
    ...extra,
  };
}

function pk(columns: string[]): ConstraintSnapshot {
  return {
    name: `pk_${columns.join("_")}`,
    kind: "PRIMARY KEY",
    columns,
    definition: `PRIMARY KEY (${columns.join(", ")})`,
    normalizedDefinition: `PRIMARY KEY (${columns.join(", ")})`,
  };
}

/** A unique constraint, as pg_get_constraintdef prints it unless `definition` says otherwise. */
function unique(name: string, columns: string[], definition = `UNIQUE (${columns.join(", ")})`): ConstraintSnapshot {
  return { name, kind: "UNIQUE", columns, definition, normalizedDefinition: definition };
}

function fk(
  name: string,
  columns: string[],
  extra: Partial<ForeignKeySnapshot> = {}
): ForeignKeySnapshot {
  return {
    name,
    kind: "FOREIGN KEY",
    columns,
    definition: `FOREIGN KEY (${columns.join(", ")}) REFERENCES parent(id)`,
    normalizedDefinition: `FOREIGN KEY (${columns.join(", ")}) REFERENCES parent(id)`,
    referencedSchema: "public",
    referencedTable: "parent",
    referencedColumns: ["id"],
    onUpdate: "NO ACTION",
    onDelete: "NO ACTION",
    ...extra,
  };
}

/**
 * An index as the snapshot records it. The definition is what the rules
 * read, so it is written the way pg_get_indexdef prints one (with the
 * snapshot's own schema taken out), from the method and uniqueness given.
 */
function index(name: string, columns: string[], extra: Partial<IndexSnapshot> = {}): IndexSnapshot {
  const definition =
    `CREATE ${extra.isUnique ? "UNIQUE " : ""}INDEX ${name} ON t ` +
    `USING ${extra.method ?? "btree"} (${columns.join(", ")})`;
  return {
    name,
    definition,
    normalizedDefinition: definition,
    columns,
    isUnique: false,
    method: "btree",
    predicate: null,
    ...extra,
  };
}

function table(name: string, extra: Partial<TableSnapshot> = {}): TableSnapshot {
  return {
    name,
    columns: [],
    primaryKey: pk(["id"]),
    uniqueConstraints: [],
    foreignKeys: [],
    checkConstraints: [],
    excludeConstraints: [],
    ...extra,
  };
}

function snapshot(tables: TableSnapshot[], extra: Partial<SchemaSnapshot> = {}): SchemaSnapshot {
  return { database: "shop", schema: "public", tables, ...extra };
}

/** How a partitioned table (the parent) is recorded. */
function partitionedBy(key: string): TablePartitioning {
  return { strategy: key.split(" ")[0], key, partitionOf: null, bounds: null, inherits: [] };
}

/** How one partition is recorded. */
const PARTITION_OF_EVENTS: TablePartitioning = {
  strategy: null,
  key: null,
  partitionOf: "events",
  bounds: "FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')",
  inherits: [],
};

/** Lines of the fix that run, comments and blanks left out. */
function runnable(sql: string): string[] {
  return sql.split("\n").filter((line) => line.trim() !== "" && !line.startsWith("--"));
}

// ── Structure rules ──────────────────────────────────────────────────────────

describe("analyzeSchemaPerformance", () => {
  it("reports a table with no primary key", () => {
    const advice = analyzeSchemaPerformance(snapshot([table("events", { primaryKey: null })]));
    expect(ids(advice)).toContain("no-primary-key");
  });

  it("says nothing about a partition with no key of its own", () => {
    const advice = analyzeSchemaPerformance(
      snapshot([table("events_2026", { primaryKey: null, partitioning: PARTITION_OF_EVENTS })])
    );
    expect(ids(advice)).not.toContain("no-primary-key");
  });

  it("reports a foreign key with no index on the holding side", () => {
    const advice = analyzeSchemaPerformance(
      snapshot([table("orders", { foreignKeys: [fk("orders_customer_fk", ["customer_id"])], indexes: [] })])
    );
    expect(ids(advice)).toContain("foreign-key-not-indexed");
  });

  it("treats an unindexed cascading foreign key as more serious than a plain one", () => {
    const plain = analyzeSchemaPerformance(
      snapshot([table("orders", { foreignKeys: [fk("f", ["customer_id"])], indexes: [] })])
    );
    const cascading = analyzeSchemaPerformance(
      snapshot([
        table("orders", {
          foreignKeys: [fk("f", ["customer_id"], { onDelete: "CASCADE" })],
          indexes: [],
        }),
      ])
    );
    expect(plain[0].severity).toBe("medium");
    expect(cascading[0].severity).toBe("high");
  });

  it("builds the foreign key's index under a free name, and the undo drops that name", () => {
    // orders_customer_id_idx is taken by another table's index, so the new
    // one is orders_customer_id_idx1: the name PostgreSQL would pick next.
    const advice = analyzeSchemaPerformance(
      snapshot([
        table("orders", { foreignKeys: [fk("f", ["customer_id"])], indexes: [] }),
        table("archive", { indexes: [index("orders_customer_id_idx", ["x"])] }),
      ])
    );
    const found = one(advice, "foreign-key-not-indexed");
    expect(found.fixKind).toBe("change");
    expect(runnable(found.fix)).toEqual([
      'CREATE INDEX "orders_customer_id_idx1" ON "public"."orders" ("customer_id");',
    ]);
    expect(found.undo).toBe('DROP INDEX "public"."orders_customer_id_idx1";');
    // The table travels with it, so a whole-table-read finding can find it.
    expect(found.table).toBe("orders");
  });

  it("on a partitioned table, says what to do instead of CONCURRENTLY", () => {
    const advice = analyzeSchemaPerformance(
      snapshot([
        table("events", {
          primaryKey: pk(["id", "created_at"]),
          partitioning: partitionedBy("RANGE (created_at)"),
          foreignKeys: [fk("f", ["account_id"])],
          indexes: [],
        }),
      ])
    );
    const fix = one(advice, "foreign-key-not-indexed").fix;
    expect(fix).toContain("This table is partitioned");
    expect(fix).not.toContain("run this by hand as CREATE INDEX CONCURRENTLY");
  });

  it("accepts an index that merely starts with the foreign key columns", () => {
    const advice = analyzeSchemaPerformance(
      snapshot([
        table("orders", {
          foreignKeys: [fk("f", ["customer_id"])],
          indexes: [index("i", ["customer_id", "placed_at"])],
        }),
      ])
    );
    expect(ids(advice)).not.toContain("foreign-key-not-indexed");
  });

  it("does not accept an index that merely contains the foreign key columns", () => {
    const advice = analyzeSchemaPerformance(
      snapshot([
        table("orders", {
          foreignKeys: [fk("f", ["customer_id"])],
          indexes: [index("i", ["placed_at", "customer_id"])],
        }),
      ])
    );
    expect(ids(advice)).toContain("foreign-key-not-indexed");
  });

  it("counts the primary key's own index as covering a foreign key", () => {
    const advice = analyzeSchemaPerformance(
      snapshot([
        table("order_lines", {
          primaryKey: pk(["order_id", "line_no"]),
          foreignKeys: [fk("f", ["order_id"])],
          indexes: [],
        }),
      ])
    );
    expect(ids(advice)).not.toContain("foreign-key-not-indexed");
  });

  it("skips every index rule when the snapshot has no record of indexes", () => {
    const advice = analyzeSchemaPerformance(
      snapshot([table("orders", { foreignKeys: [fk("f", ["customer_id"])] })])
    );
    expect(ids(advice)).not.toContain("foreign-key-not-indexed");
    expect(ids(advice)).not.toContain("duplicate-index");
  });

  it("ignores a partial index when deciding a foreign key is covered", () => {
    const advice = analyzeSchemaPerformance(
      snapshot([
        table("orders", {
          foreignKeys: [fk("f", ["customer_id"])],
          indexes: [index("i", ["customer_id"], { predicate: "state = 'open'" })],
        }),
      ])
    );
    expect(ids(advice)).toContain("foreign-key-not-indexed");
  });

  it("reports two indexes with the same definition once, not twice", () => {
    const advice = analyzeSchemaPerformance(
      snapshot([
        table("orders", { indexes: [index("orders_a", ["customer_id"]), index("orders_b", ["customer_id"])] }),
      ])
    );
    const found = one(advice, "duplicate-index");
    expect(found.fixKind).toBe("change");
    expect(runnable(found.fix)).toEqual(['DROP INDEX "public"."orders_b";']);
    // The undo builds the dropped copy again, name and all.
    expect(found.undo).toBe('CREATE INDEX "orders_b" ON "public"."orders" USING btree (customer_id);');
  });

  it("drops every duplicate but the first, not just the second", () => {
    // Dropping one of three leaves the finding true, and the reader believing
    // they have dealt with it.
    const same = (name: string) => index(name, ["customer_id"]);
    const advice = analyzeSchemaPerformance(
      snapshot([
        table("orders", { indexes: [same("orders_a"), same("orders_b"), same("orders_c")] }),
      ])
    );
    const found = one(advice, "duplicate-index");
    expect(found.title).toBe("3 indexes with the same definition");
    expect(found.fix).toContain('-- Keeps "orders_a"');
    expect(runnable(found.fix)).toEqual([
      'DROP INDEX "public"."orders_b";',
      'DROP INDEX "public"."orders_c";',
    ]);
  });

  it("keeps the primary key's index and drops a unique index that copies it", () => {
    const advice = analyzeSchemaPerformance(
      snapshot([
        table("orders", { indexes: [index("orders_id_key", ["id"], { isUnique: true })] }),
      ])
    );
    const found = one(advice, "duplicate-index");
    expect(found.object).toBe("orders (pk_id, orders_id_key)");
    expect(found.fixKind).toBe("change");
    expect(found.fix).toContain('-- Keeps "pk_id", the index behind the primary key');
    // A foreign key elsewhere may be bound to exactly this unique index.
    expect(found.fix).toContain("If a foreign key in another table relies on \"orders_id_key\"");
    expect(runnable(found.fix)).toEqual(['DROP INDEX "public"."orders_id_key";']);
    expect(found.undo).toBe(
      'CREATE UNIQUE INDEX "orders_id_key" ON "public"."orders" USING btree (id);'
    );
  });

  it("leaves two constraints over the same columns to a person, because code may name them", () => {
    const advice = analyzeSchemaPerformance(
      snapshot([
        table("customers", {
          uniqueConstraints: [unique("customers_email_key", ["email"]), unique("customers_email_key1", ["email"])],
          indexes: [],
        }),
      ])
    );
    const found = one(advice, "duplicate-index");
    expect(found.fixKind).toBe("decision");
    expect(found.fix).toContain('-- Keep "customers_email_key".');
    expect(found.fix).toContain(
      '-- ALTER TABLE "public"."customers" DROP CONSTRAINT "customers_email_key1";'
    );
    expect(found.undo).toBeUndefined();
  });

  it("keeps the primary key when a unique constraint repeats it", () => {
    const advice = analyzeSchemaPerformance(
      snapshot([table("customers", { uniqueConstraints: [unique("customers_id_key", ["id"])], indexes: [] })])
    );
    const found = one(advice, "duplicate-index");
    expect(found.fixKind).toBe("decision");
    expect(found.fix).toContain("-- Keep the primary key.");
    expect(found.fix).toContain('DROP CONSTRAINT "customers_id_key";');
  });

  it("does not treat a DEFERRABLE unique constraint as a copy of the primary key", () => {
    // It lets a statement break the rule until the statement ends; the
    // primary key does not. They are not the same index.
    const advice = analyzeSchemaPerformance(
      snapshot([
        table("customers", {
          uniqueConstraints: [unique("customers_id_key", ["id"], "UNIQUE (id) DEFERRABLE")],
          indexes: [],
        }),
      ])
    );
    expect(ids(advice)).not.toContain("duplicate-index");
  });

  it("treats an index with an operator class as neither a copy nor a cover of a plain one", () => {
    // text_pattern_ops serves LIKE 'abc%'; the plain index serves = and
    // sorting. Each does something the other cannot.
    const advice = analyzeSchemaPerformance(
      snapshot([
        table("customers", {
          indexes: [
            index("by_email", ["email"]),
            index("by_email_pattern", ["email"], {
              definition: "CREATE INDEX by_email_pattern ON t USING btree (email text_pattern_ops)",
            }),
            index("by_email_pattern_wide", ["email", "name"], {
              definition: "CREATE INDEX by_email_pattern_wide ON t USING btree (email text_pattern_ops, name)",
            }),
          ],
        }),
      ])
    );
    expect(ids(advice)).not.toContain("duplicate-index");
    expect(ids(advice)).not.toContain("redundant-index");
  });

  it("reports a narrow index already covered by a wider one, and the undo builds it again", () => {
    const advice = analyzeSchemaPerformance(
      snapshot([
        table("orders", {
          indexes: [index("narrow", ["customer_id"]), index("wide", ["customer_id", "placed_at"])],
        }),
      ])
    );
    const found = one(advice, "redundant-index");
    expect(found.object).toBe("orders.narrow");
    expect(found.fix).toBe('DROP INDEX "public"."narrow";');
    expect(found.undo).toBe('CREATE INDEX "narrow" ON "public"."orders" USING btree (customer_id);');
  });

  it("never has two findings drop the same index", () => {
    // a and b are copies, and both are covered by c. The duplicate finding
    // keeps a and drops b; the redundant finding may drop a, but never b again.
    const advice = analyzeSchemaPerformance(
      snapshot([
        table("orders", {
          indexes: [
            index("a", ["customer_id"]),
            index("b", ["customer_id"]),
            index("c", ["customer_id", "placed_at"]),
          ],
        }),
      ])
    );
    const drops = advice.flatMap((a) => runnable(a.fix)).filter((l) => l.startsWith("DROP INDEX"));
    expect(drops.sort()).toEqual(['DROP INDEX "public"."a";', 'DROP INDEX "public"."b";']);
  });

  it("leaves a narrow index alone when the wider one uses a different method", () => {
    const advice = analyzeSchemaPerformance(
      snapshot([
        table("orders", {
          indexes: [
            index("narrow", ["payload"]),
            index("wide", ["payload", "placed_at"], { method: "gin" }),
          ],
        }),
      ])
    );
    expect(ids(advice)).not.toContain("redundant-index");
  });

  it("reports an index over a single boolean column", () => {
    const advice = analyzeSchemaPerformance(
      snapshot([
        table("orders", {
          columns: [column("is_paid", "boolean"), column("placed_at", "timestamp with time zone")],
          indexes: [index("i", ["is_paid"])],
        }),
      ])
    );
    const found = one(advice, "boolean-index");
    expect(found.fixKind).toBe("decision");
    // The example indexes the rare rows by another column, not by the flag.
    expect(found.fix).toContain('-- CREATE INDEX ON "public"."orders" ("placed_at") WHERE "is_paid";');
  });

  it("leaves a partial index over a boolean alone, because that is the fix", () => {
    const advice = analyzeSchemaPerformance(
      snapshot([
        table("orders", {
          columns: [column("is_paid", "boolean")],
          indexes: [index("i", ["is_paid"], { predicate: "is_paid" })],
        }),
      ])
    );
    expect(ids(advice)).not.toContain("boolean-index");
  });

  it("reports a timestamp column that carries no time zone", () => {
    const advice = analyzeSchemaPerformance(
      snapshot([table("orders", { columns: [column("placed_at", "timestamp without time zone")] })])
    );
    expect(ids(advice)).toContain("timestamp-without-timezone");
  });

  it("keeps the column's precision when it sets out the conversion", () => {
    const advice = analyzeSchemaPerformance(
      snapshot([table("orders", { columns: [column("placed_at", "timestamp(3) without time zone")] })])
    );
    const found = one(advice, "timestamp-without-timezone");
    // Which zone the old values meant is only known to whoever wrote them.
    expect(found.fixKind).toBe("decision");
    expect(found.fix).toContain(
      '-- ALTER TABLE "public"."orders" ALTER COLUMN "placed_at" TYPE timestamp(3) with time zone ' +
        "USING \"placed_at\" AT TIME ZONE 'UTC';"
    );
  });

  it("says nothing about a timestamptz column", () => {
    const advice = analyzeSchemaPerformance(
      snapshot([table("orders", { columns: [column("placed_at", "timestamp with time zone")] })])
    );
    expect(ids(advice)).not.toContain("timestamp-without-timezone");
  });

  it("says nothing about a timestamptz column that carries a precision", () => {
    // Postgres renders the precision in the MIDDLE of the type name, so a rule
    // that reads only up to the first bracket sees "timestamp" and offers to
    // convert a column that is already zoned.
    const advice = analyzeSchemaPerformance(
      snapshot([table("orders", { columns: [column("placed_at", "timestamp(3) with time zone")] })])
    );
    expect(ids(advice)).not.toContain("timestamp-without-timezone");
  });

  it("reports character(n) but not character varying(n)", () => {
    const padded = analyzeSchemaPerformance(
      snapshot([table("t", { columns: [column("code", "character(4)")] })])
    );
    const varying = analyzeSchemaPerformance(
      snapshot([table("t", { columns: [column("code", "character varying(4)")] })])
    );
    expect(ids(padded)).toContain("blank-padded-char");
    expect(ids(varying)).not.toContain("blank-padded-char");
  });

  it("converts character(n) to text, and the undo puts the exact type back", () => {
    const advice = analyzeSchemaPerformance(
      snapshot([table("t", { columns: [column("code", "character(4)")] })])
    );
    const found = one(advice, "blank-padded-char");
    expect(found.fixKind).toBe("change");
    expect(runnable(found.fix)).toEqual(['ALTER TABLE "public"."t" ALTER COLUMN "code" TYPE text;']);
    expect(found.undo).toBe('ALTER TABLE "public"."t" ALTER COLUMN "code" TYPE character(4);');
  });

  it("leaves a partition's columns to the parent's findings", () => {
    // PostgreSQL refuses to change a column's type on one partition alone.
    const advice = analyzeSchemaPerformance(
      snapshot([
        table("events_2026", {
          partitioning: PARTITION_OF_EVENTS,
          columns: [
            column("code", "character(4)"),
            column("at", "timestamp without time zone"),
            column("id", "integer", { columnDefault: "nextval('events_id_seq'::regclass)" }),
          ],
        }),
      ])
    );
    expect(advice).toEqual([]);
  });

  it("reports a text primary key", () => {
    const advice = analyzeSchemaPerformance(
      snapshot([table("t", { primaryKey: pk(["code"]), columns: [column("code", "text")] })])
    );
    expect(ids(advice)).toContain("text-primary-key");
  });

  it("counts constraint-backed indexes towards the too-many-indexes rule", () => {
    const advice = analyzeSchemaPerformance(
      snapshot([
        table("t", {
          uniqueConstraints: [unique("t_a_key", ["a"]), unique("t_b_key", ["b"]), unique("t_c_key", ["c"])],
          indexes: [index("i1", ["d"]), index("i2", ["e"]), index("i3", ["f"])],
        }),
      ])
    );
    // 3 unique + 3 plain + 1 primary key = 7, which is past the threshold of 6.
    expect(ids(advice)).toContain("many-indexes");
  });

  it("on a partitioned table, says where the per-partition usage counters are", () => {
    const many = ["a", "b", "c", "d", "e", "f", "g"].map((c) => index(`events_${c}_idx`, [c]));
    const advice = analyzeSchemaPerformance(
      snapshot([
        table("events", {
          primaryKey: pk(["id", "created_at"]),
          partitioning: partitionedBy("RANGE (created_at)"),
          indexes: many,
        }),
      ])
    );
    expect(one(advice, "many-indexes").fix).toContain("per partition");
  });

  it("returns nothing at all for a schema with no tables", () => {
    expect(analyzeSchemaPerformance(snapshot([]))).toEqual([]);
  });

  it("quotes an identifier that would otherwise break the generated SQL", () => {
    const advice = analyzeSchemaPerformance(
      snapshot([table("order lines", { primaryKey: null })])
    );
    expect(advice[0].fix).toContain(`"public"."order lines"`);
  });
});

describe("the duplicate and redundant rules, next to an invalid index", () => {
  // Queries never use an invalid index, so it copies nothing. Counted as a
  // copy, it could be the one kept while the copy that works is dropped.
  const copies = () =>
    snapshot([
      table("orders", { indexes: [index("orders_a", ["customer_id"]), index("orders_b", ["customer_id"])] }),
    ]);

  it("names the copy a duplicate finding keeps, for withoutRepeatedDrops", () => {
    const found = one(analyzeSchemaPerformance(copies()), "duplicate-index");
    expect(runnable(found.fix)).toEqual(['DROP INDEX "public"."orders_b";']);
    expect(found.keeps).toBe('"public"."orders_a"');
  });

  it("does not count an invalid index as a copy, even when it would be the one kept", () => {
    // By name orders_a would be kept, and orders_b, the one that works, dropped.
    const advice = analyzeSchemaPerformance(copies(), new Set(["orders_a"]));
    expect(ids(advice)).not.toContain("duplicate-index");
  });

  it("knows a copy REINDEX CONCURRENTLY left behind by its name, without being told", () => {
    const advice = analyzeSchemaPerformance(
      snapshot([
        table("orders", {
          indexes: [
            index("orders_customer_idx", ["customer_id"]),
            index("orders_customer_idx_ccnew", ["customer_id"]),
            index("orders_customer_idx_ccold2", ["customer_id"]),
          ],
        }),
      ])
    );
    expect(ids(advice)).not.toContain("duplicate-index");
  });

  it("does not drop a narrow index for a wider one that is invalid", () => {
    const tables = snapshot([
      table("orders", {
        indexes: [index("narrow", ["customer_id"]), index("wide", ["customer_id", "placed_at"])],
      }),
    ]);
    expect(one(analyzeSchemaPerformance(tables), "redundant-index").keeps).toBe('"public"."wide"');
    expect(ids(analyzeSchemaPerformance(tables, new Set(["wide"])))).not.toContain("redundant-index");
  });

  it("still counts an invalid index as serving a foreign key, since its own finding rebuilds it", () => {
    // Suggesting a second index here would sit next to the invalid-index
    // finding's REINDEX, which already gives the key a working one.
    const advice = analyzeSchemaPerformance(
      snapshot([
        table("orders", {
          foreignKeys: [fk("orders_customer_fk", ["customer_id"])],
          indexes: [index("orders_customer_idx", ["customer_id"])],
        }),
      ]),
      new Set(["orders_customer_idx"])
    );
    expect(ids(advice)).not.toContain("foreign-key-not-indexed");
  });
});

describe("the fix for a table with no primary key", () => {
  it("turns a unique index over NOT NULL columns into the key, renamed the way PostgreSQL will", () => {
    const advice = analyzeSchemaPerformance(
      snapshot([
        table("events", {
          primaryKey: null,
          columns: [column("event_id", "bigint", { nullable: false }), column("note", "text")],
          indexes: [index("events_event_id_key", ["event_id"], { isUnique: true })],
        }),
      ])
    );
    const found = one(advice, "no-primary-key");
    expect(found.fixKind).toBe("change");
    expect(found.fix).toBe(
      '-- The unique index "events_event_id_key" already allows only one row per (event_id),\n' +
        "-- and event_id is declared NOT NULL, so it can become the key without building anything.\n" +
        '-- PostgreSQL renames the index to "events_pkey" when it does.\n' +
        'ALTER TABLE "public"."events" ADD CONSTRAINT "events_pkey" PRIMARY KEY USING INDEX "events_event_id_key";'
    );
    // Dropping the key drops the index it took over, so the undo builds the
    // index again under its old name.
    expect(found.undo).toBe(
      'ALTER TABLE "public"."events" DROP CONSTRAINT "events_pkey";\n' +
        'CREATE UNIQUE INDEX "events_event_id_key" ON "public"."events" USING btree (event_id);'
    );
  });

  it("says nothing about a rename when the index already has the key's name", () => {
    const advice = analyzeSchemaPerformance(
      snapshot([
        table("events", {
          primaryKey: null,
          columns: [column("event_id", "bigint", { nullable: false })],
          indexes: [index("events_pkey", ["event_id"], { isUnique: true })],
        }),
      ])
    );
    const found = one(advice, "no-primary-key");
    expect(found.fix).not.toContain("renames");
    expect(runnable(found.fix)).toEqual([
      'ALTER TABLE "public"."events" ADD CONSTRAINT "events_pkey" PRIMARY KEY USING INDEX "events_pkey";',
    ]);
  });

  it("passes over a partial, a descending or a nullable unique index, none of which can be the key", () => {
    // PostgreSQL only takes a plain btree with the default sort order, over
    // columns that can never be NULL.
    const advice = analyzeSchemaPerformance(
      snapshot([
        table("events", {
          primaryKey: null,
          columns: [column("event_id", "bigint", { nullable: false }), column("note", "text")],
          indexes: [
            index("a_partial", ["event_id"], {
              isUnique: true,
              predicate: "(event_id > 0)",
              definition: "CREATE UNIQUE INDEX a_partial ON t USING btree (event_id) WHERE (event_id > 0)",
            }),
            index("b_descending", ["event_id"], {
              isUnique: true,
              definition: "CREATE UNIQUE INDEX b_descending ON t USING btree (event_id DESC)",
            }),
            index("c_nullable", ["note"], { isUnique: true }),
            index("d_plain", ["event_id"], { isUnique: true }),
          ],
        }),
      ])
    );
    expect(runnable(one(advice, "no-primary-key").fix)).toEqual([
      'ALTER TABLE "public"."events" ADD CONSTRAINT "events_pkey" PRIMARY KEY USING INDEX "d_plain";',
    ]);
  });

  it("makes a unique constraint's NOT NULL columns the key, and leaves dropping the constraint to the reader", () => {
    const advice = analyzeSchemaPerformance(
      snapshot([
        table("accounts", {
          primaryKey: null,
          columns: [
            column("tenant_id", "integer", { nullable: false }),
            column("email", "text", { nullable: false }),
          ],
          uniqueConstraints: [unique("accounts_tenant_email_key", ["tenant_id", "email"])],
          indexes: [],
        }),
      ])
    );
    const found = one(advice, "no-primary-key");
    expect(found.fixKind).toBe("change");
    expect(found.fix).toContain("-- and tenant_id and email are declared NOT NULL");
    expect(runnable(found.fix)).toEqual([
      'ALTER TABLE "public"."accounts" ADD CONSTRAINT "accounts_pkey" PRIMARY KEY ("tenant_id", "email");',
    ]);
    // A foreign key in another table may use the constraint's index, so the
    // DROP is only offered.
    expect(found.fix).toContain(
      '-- ALTER TABLE "public"."accounts" DROP CONSTRAINT "accounts_tenant_email_key";'
    );
    // The fix offers that DROP, so the undo says how to put the constraint
    // back for whoever ran it.
    expect(found.undo).toBe(
      'ALTER TABLE "public"."accounts" DROP CONSTRAINT "accounts_pkey";\n' +
        '-- If you dropped "accounts_tenant_email_key" as well, add it back:\n' +
        '-- ALTER TABLE "public"."accounts" ADD CONSTRAINT "accounts_tenant_email_key" UNIQUE (tenant_id, email);'
    );
  });

  it("does not make a DEFERRABLE, INCLUDE or nullable unique constraint the key", () => {
    // Only a plain UNIQUE (...) over NOT NULL columns is taken. A DEFERRABLE
    // one lets a statement break the rule until it ends, which a key would
    // not, and a column that can be NULL cannot be part of a key at all.
    const advice = analyzeSchemaPerformance(
      snapshot([
        table("accounts", {
          primaryKey: null,
          columns: [
            column("email", "text", { nullable: false }),
            column("code", "text", { nullable: false }),
            column("nickname", "text"),
          ],
          uniqueConstraints: [
            unique("accounts_email_key", ["email"], "UNIQUE (email) DEFERRABLE"),
            unique("accounts_code_key", ["code"], "UNIQUE (code) INCLUDE (nickname)"),
            unique("accounts_nickname_key", ["nickname"]),
          ],
          indexes: [],
        }),
      ])
    );
    const found = one(advice, "no-primary-key");
    expect(found.fixKind).toBe("decision");
    expect(found.undo).toBeUndefined();
  });

  it("otherwise sets out the choice, with a new column under a name the table does not use", () => {
    const logs = (names: string[]) =>
      one(
        analyzeSchemaPerformance(
          snapshot([table("logs", { primaryKey: null, columns: names.map((n) => column(n, "text")) })])
        ),
        "no-primary-key"
      );
    const found = logs(["message"]);
    expect(found.fixKind).toBe("decision");
    expect(found.fix).toBe(
      "-- No unique index or constraint here can become the key as it is, so the key\n" +
        "-- has to be chosen. If some columns already identify a row, make them the key,\n" +
        "-- after checking that no two rows share a value and none of them is NULL.\n" +
        // Checked on PostgreSQL 17: adding an identity column writes the table
        // out again (its file changes) to number the rows 1, 2, 3..., under
        // ACCESS EXCLUSIVE, which makes reads wait as well as writes.
        "-- Or add a new column for it. That rewrites the table to number the rows already\n" +
        "-- there, and the table is blocked, reads included, until that finishes:\n" +
        '-- ALTER TABLE "public"."logs" ADD COLUMN "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY;'
    );
    expect(logs(["id", "message"]).fix).toContain('ADD COLUMN "row_id" bigint');
    expect(logs(["id", "row_id"]).fix).toContain('ADD COLUMN "row_id_2" bigint');
  });

  it("on a partitioned table, puts the partition key's columns in the key and never takes over an index", () => {
    // PostgreSQL refuses ADD ... USING INDEX on a partitioned table, so even a
    // unique index that would do on a plain one is passed over.
    const advice = analyzeSchemaPerformance(
      snapshot([
        table("events", {
          primaryKey: null,
          partitioning: partitionedBy("RANGE (created_at)"),
          columns: [column("created_at", "timestamp with time zone", { nullable: false })],
          indexes: [index("events_created_at_key", ["created_at"], { isUnique: true })],
        }),
      ])
    );
    const found = one(advice, "no-primary-key");
    expect(found.fixKind).toBe("decision");
    expect(found.fix).toBe(
      "-- This table is partitioned by RANGE (created_at), so its primary key has to\n" +
        "-- include created_at. If some columns identify a row together with created_at,\n" +
        "-- make them the key, after checking that no two rows share a value and none of them is NULL.\n" +
        // Checked on PostgreSQL 17: one statement with both is refused; of
        // these two, the first rewrites every partition, and each holds ACCESS
        // EXCLUSIVE on the table and its partitions while it runs.
        "-- Or add a new column for it (an identity column on a partitioned table needs\n" +
        "-- PostgreSQL 17 or later). The first statement rewrites every partition to number\n" +
        "-- the rows already there, and the table is blocked, reads included, while each\n" +
        "-- statement runs:\n" +
        '-- ALTER TABLE "public"."events" ADD COLUMN "id" bigint GENERATED ALWAYS AS IDENTITY;\n' +
        '-- ALTER TABLE "public"."events" ADD PRIMARY KEY ("id", "created_at");'
    );
  });

  it("says a key cannot be enforced on a table partitioned by an expression", () => {
    const found = one(
      analyzeSchemaPerformance(
        snapshot([
          table("accounts", {
            primaryKey: null,
            partitioning: partitionedBy("LIST (lower(region))"),
            columns: [column("region", "text", { nullable: false })],
          }),
        ])
      ),
      "no-primary-key"
    );
    expect(found.fixKind).toBe("decision");
    expect(found.fix).toContain(
      "-- This table is partitioned by LIST (lower(region)), and PostgreSQL\n" +
        "-- cannot enforce a primary key on a table partitioned by an expression."
    );
    expect(found.fix).not.toContain("ADD PRIMARY KEY");
  });

  it("warns that a partition key with a collation may refuse the key", () => {
    const found = one(
      analyzeSchemaPerformance(
        snapshot([
          table("accounts", {
            primaryKey: null,
            partitioning: partitionedBy('LIST (code COLLATE "C")'),
            columns: [column("code", "text", { nullable: false })],
          }),
        ])
      ),
      "no-primary-key"
    );
    expect(found.fix).toContain(
      "-- include code. PostgreSQL may refuse that key because of the partition\n" +
        "-- key's collation or operator class"
    );
    expect(found.fix).not.toContain("ADD PRIMARY KEY");
  });
});

// ── Serial columns ───────────────────────────────────────────────────────────

/** An integer column whose default draws from a sequence, the way serial makes one. */
function serialColumn(columnDefault: string, extra: Partial<ColumnSnapshot> = {}): ColumnSnapshot {
  return column("id", "integer", { nullable: false, isPrimaryKey: true, columnDefault, ...extra });
}

/** The sequence record a snapshot keeps for t_id_seq, owned as given. */
function sequenceRecord(ownedByTable: string | null, ownedByColumn: string | null): SequenceSnapshot {
  return {
    name: "t_id_seq",
    ownedByTable,
    ownedByColumn,
    dataType: "integer",
    startValue: "1",
    increment: "1",
    minValue: "1",
    maxValue: "2147483647",
    cycles: false,
    cacheSize: "1",
  };
}

describe("the fix for a serial column", () => {
  it("converts it in the order that keeps the next insert working", () => {
    const advice = analyzeSchemaPerformance(
      snapshot([table("Order Lines", { columns: [serialColumn(`nextval('"Order Lines_id_seq"'::regclass)`)] })])
    );
    const found = one(advice, "serial-not-identity");
    expect(found.fixKind).toBe("change");
    expect(found.fix).toBe(
      [
        'ALTER TABLE "public"."Order Lines" ALTER COLUMN "id" DROP DEFAULT;',
        "-- Detach the old sequence, or the setval below would reach it instead of the new one.",
        'ALTER SEQUENCE "public"."Order Lines_id_seq" OWNED BY NONE;',
        'ALTER TABLE "public"."Order Lines" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY;',
        "-- Carry on from the number the old sequence would have handed out next, or from",
        "-- above the highest value if a row holds a higher one, so no number comes twice.",
        // pg_get_serial_sequence reads its first argument as a SQL name, so
        // the quotes go inside the string; the column is taken as written.
        // Checked on PostgreSQL 17: after the newest row is deleted, the next
        // insert gets a new number (max(id) alone would hand that one out
        // again); an empty table carries on from the old sequence; a row given
        // 100 by hand makes the next one 101; a never-used serial starts at 1.
        `SELECT setval(pg_get_serial_sequence('"public"."Order Lines"', 'id'), ` +
          `GREATEST(nextval('"public"."Order Lines_id_seq"'), (SELECT max("id") + 1 FROM "public"."Order Lines")), false);`,
        "-- The serial's own sequence is now unused. Check nothing else names it, then:",
        '-- DROP SEQUENCE "public"."Order Lines_id_seq";',
      ].join("\n")
    );
    // Going back needs the old sequence, which the last step invites the
    // reader to drop, so the undo only sets the steps out. The old sequence
    // moves past the identity's numbers first, while the identity is still
    // there to say where it got to; checked on PostgreSQL 17, after which
    // inserts carry on and pg_get_serial_sequence finds the old one again.
    expect(found.undo).toBe(
      [
        "-- To go back, while the old sequence still exists (not after DROP SEQUENCE).",
        "-- First move the old sequence past every number the identity handed out:",
        `-- SELECT setval('"public"."Order Lines_id_seq"', ` +
          `GREATEST(nextval(pg_get_serial_sequence('"public"."Order Lines"', 'id')), ` +
          `(SELECT max("id") + 1 FROM "public"."Order Lines")), false);`,
        '-- ALTER TABLE "public"."Order Lines" ALTER COLUMN "id" DROP IDENTITY;',
        `-- ALTER TABLE "public"."Order Lines" ALTER COLUMN "id" SET DEFAULT nextval('"public"."Order Lines_id_seq"');`,
        '-- ALTER SEQUENCE "public"."Order Lines_id_seq" OWNED BY "public"."Order Lines"."id";',
      ].join("\n")
    );
  });

  it("makes a nullable column NOT NULL first, and the undo lets it be null again", () => {
    const found = one(
      analyzeSchemaPerformance(
        snapshot([
          table("t", { columns: [column("n", "bigint", { columnDefault: "nextval('t_n_seq'::regclass)" })] }),
        ])
      ),
      "serial-not-identity"
    );
    // Checked on PostgreSQL 17: ADD GENERATED on a nullable column stops with
    // "must be declared NOT NULL", and SET NOT NULL over a NULL row stops with
    // "contains null values".
    expect(found.fix.split("\n").slice(0, 2)).toEqual([
      "-- An identity column cannot be NULL, so make this one NOT NULL first. If a row",
      "-- holds NULL here, this stops with an error before anything has changed.",
    ]);
    expect(runnable(found.fix).slice(0, 2)).toEqual([
      'ALTER TABLE "public"."t" ALTER COLUMN "n" SET NOT NULL;',
      'ALTER TABLE "public"."t" ALTER COLUMN "n" DROP DEFAULT;',
    ]);
    expect(found.undo?.split("\n").pop()).toBe('-- ALTER TABLE "public"."t" ALTER COLUMN "n" DROP NOT NULL;');
  });

  it("puts the sequence in the snapshot's own schema when the default leaves the schema out", () => {
    // The snapshot takes its own schema's name out of every default, so a
    // bare name there means that schema.
    const found = one(
      analyzeSchemaPerformance(
        snapshot([table("t", { columns: [serialColumn("nextval('t_id_seq'::regclass)")] })], { schema: "shop" })
      ),
      "serial-not-identity"
    );
    expect(found.fix).toContain('ALTER SEQUENCE "shop"."t_id_seq" OWNED BY NONE;');
    expect(found.fix).toContain('-- DROP SEQUENCE "shop"."t_id_seq";');
  });

  it("leaves a column alone when its sequence is in another schema, which may share it", () => {
    const advice = analyzeSchemaPerformance(
      snapshot([table("t", { columns: [serialColumn("nextval('other.t_id_seq'::regclass)")] })])
    );
    expect(ids(advice)).not.toContain("serial-not-identity");
  });

  it("converts only when the snapshot's sequence record says this column owns the sequence", () => {
    const fires = (record: SequenceSnapshot) =>
      ids(
        analyzeSchemaPerformance(
          snapshot([table("t", { columns: [serialColumn("nextval('t_id_seq'::regclass)")] })], {
            sequences: [record],
          })
        )
      ).includes("serial-not-identity");
    expect(fires(sequenceRecord("t", "id"))).toBe(true);
    // Owned by nothing, by another column, or by another table: something
    // else may draw numbers from it, and the fix ends by offering to drop it.
    expect(fires(sequenceRecord(null, null))).toBe(false);
    expect(fires(sequenceRecord("t", "other_id"))).toBe(false);
    expect(fires(sequenceRecord("orders", "id"))).toBe(false);
    expect(fires(sequenceRecord("other.t", "id"))).toBe(false);

    // regclass quotes a name that needs it; the owner is still this table.
    const quoted = analyzeSchemaPerformance(
      snapshot([table("Order Lines", { columns: [serialColumn(`nextval('"Order Lines_id_seq"'::regclass)`)] })], {
        sequences: [{ ...sequenceRecord('"Order Lines"', "id"), name: "Order Lines_id_seq" }],
      })
    );
    expect(ids(quoted)).toContain("serial-not-identity");
  });

  it("does not call a column a serial unless it is an integer", () => {
    // An identity has to be an integer, so a nextval default on any other
    // type is left alone.
    const advice = analyzeSchemaPerformance(
      snapshot([
        table("t", { columns: [column("code", "text", { columnDefault: "nextval('t_code_seq'::regclass)" })] }),
      ])
    );
    expect(ids(advice)).not.toContain("serial-not-identity");
  });

  it("sets the steps out in words when the default names its sequence some other way", () => {
    // The form a serial made on a very old server keeps after an upgrade.
    const found = one(
      analyzeSchemaPerformance(
        snapshot([table("t", { columns: [serialColumn("nextval(('t_id_seq'::text)::regclass)")] })])
      ),
      "serial-not-identity"
    );
    expect(found.fixKind).toBe("decision");
    expect(found.fix.startsWith("-- This default does not name its sequence the usual way")).toBe(true);
    expect(found.undo).toBeUndefined();
  });
});

// ── Statistics rules ─────────────────────────────────────────────────────────

function stats(extra: Partial<TableStats> = {}): TableStats {
  return {
    table_name: "orders",
    seq_scan: 0,
    seq_tup_read: 0,
    idx_scan: 0,
    n_live_tup: 0,
    n_dead_tup: 0,
    last_analyzed: "2026-09-01T00:00:00.000Z",
    has_statistics: true,
    heap_blks_hit: 0,
    heap_blks_read: 0,
    ...extra,
  };
}

/** An index as the statistics pass reads it: fully qualified, since nothing is on the search_path. */
function indexStat(extra: Partial<IndexStats> = {}): IndexStats {
  return {
    table_name: "orders",
    index_name: "orders_customer_idx",
    idx_scan: 0,
    is_unique: false,
    is_primary: false,
    is_valid: true,
    backs_constraint: false,
    is_partition_child: false,
    size_bytes: 8192,
    definition: "CREATE INDEX orders_customer_idx ON shop.orders USING btree (customer_id)",
    ...extra,
  };
}

/** When the counters in these tests started counting, and a moment 40 days later. */
const COUNTERS = "2026-08-01T00:00:00.000Z";
const NOW = new Date("2026-09-10T00:00:00.000Z");

/** The moment `days` whole days after COUNTERS. */
function daysAfterCounters(days: number): Date {
  return new Date(Date.parse(COUNTERS) + days * 86_400_000);
}

/** The statistics pass over these tables alone, in schema "shop". */
function tableAdvice(...tables: TableStats[]): PerfAdvice[] {
  return analyzeTableStats("shop", tables, [], COUNTERS, NOW);
}

/** The statistics pass over these indexes alone, in schema "shop". */
function indexAdvice(indexes: IndexStats[], since: string | null = COUNTERS, now: Date = NOW): PerfAdvice[] {
  return analyzeTableStats("shop", [], indexes, since, now);
}

/** A large table read almost only by whole-table scans. */
const SCANNED_IN_FULL: Partial<TableStats> = {
  n_live_tup: 50_000,
  seq_scan: 5_000,
  seq_tup_read: 250_000_000,
  idx_scan: 10,
};

describe("analyzeTableStats", () => {
  it("reports a large table whose reads are almost all whole-table scans, and links to the analyser", () => {
    const found = one(tableAdvice(stats(SCANNED_IN_FULL)), "sequential-scan-heavy");
    expect(found.severity).toBe("high");
    // Which index would help depends on the queries, which the counters do not record.
    expect(found.fixKind).toBe("decision");
    expect(found.action).toEqual({
      label: "Analyse a query on this table",
      href: "/performance?tab=analyse&table=shop.orders",
    });
  });

  it("encodes the table's name in that link", () => {
    const found = one(
      tableAdvice(stats({ ...SCANNED_IN_FULL, table_name: "Order Lines" })),
      "sequential-scan-heavy"
    );
    expect(found.action?.href).toBe("/performance?tab=analyse&table=shop.Order%20Lines");
  });

  it("says nothing when each scan stops after a few rows", () => {
    // A LIMIT or an EXISTS is counted as a sequential scan too; five rows a
    // scan is not a table being read in full.
    const advice = tableAdvice(stats({ ...SCANNED_IN_FULL, seq_tup_read: 25_000 }));
    expect(ids(advice)).not.toContain("sequential-scan-heavy");
  });

  it("says nothing about a small lookup table that is always scanned in full", () => {
    const advice = tableAdvice(stats({ n_live_tup: 12, seq_scan: 5_000, seq_tup_read: 60_000 }));
    expect(ids(advice)).not.toContain("sequential-scan-heavy");
  });

  it("reports a table that is a fifth dead rows, with a VACUUM to run by hand", () => {
    const found = one(tableAdvice(stats({ n_live_tup: 10_000, n_dead_tup: 2_500 })), "dead-tuples");
    expect(found.title).toBe("Many dead rows are waiting to be cleaned up");
    expect(found.fixKind).toBe("maintenance");
    // VACUUM refuses to run inside a transaction, so it is the only statement.
    expect(runnable(found.fix)).toEqual(['VACUUM (ANALYZE) "shop"."orders";']);
    expect(found.fix).toContain(
      '-- ALTER TABLE "shop"."orders" SET (autovacuum_vacuum_scale_factor = 0.05);'
    );
  });

  it("says nothing about dead rows on a table too small for them to matter", () => {
    expect(ids(tableAdvice(stats({ n_live_tup: 500, n_dead_tup: 400 })))).not.toContain("dead-tuples");
  });

  it("reports a table with neither statistics nor any record of ANALYZE", () => {
    const found = one(
      tableAdvice(stats({ n_live_tup: 5_000, last_analyzed: null, has_statistics: false })),
      "never-analyzed"
    );
    expect(found.fixKind).toBe("maintenance");
    expect(runnable(found.fix)).toEqual(['ANALYZE "shop"."orders";']);
  });

  it("trusts either sign that ANALYZE has run", () => {
    // A statistics reset forgets when ANALYZE last ran but keeps what it
    // collected; an ANALYZE of a table that was empty collects nothing.
    const forgotten = tableAdvice(stats({ n_live_tup: 5_000, last_analyzed: null, has_statistics: true }));
    const emptyAtTheTime = tableAdvice(stats({ n_live_tup: 5_000, has_statistics: false }));
    expect(ids(forgotten)).not.toContain("never-analyzed");
    expect(ids(emptyAtTheTime)).not.toContain("never-analyzed");
  });

  it("reports a low cache hit ratio, rounded down so 89.99% never reads as 90%", () => {
    const found = one(
      tableAdvice(stats({ heap_blks_hit: 8_999, heap_blks_read: 1_001, seq_scan: 1 })),
      "low-cache-hit"
    );
    expect(found.detail.startsWith("Only 89% of this table's page reads")).toBe(true);
    expect(found.fixKind).toBe("decision");
  });

  it("waits for enough page reads before judging the cache", () => {
    const advice = tableAdvice(stats({ heap_blks_hit: 500, heap_blks_read: 500, seq_scan: 1 }));
    expect(ids(advice)).not.toContain("low-cache-hit");
  });

  it("offers to drop an index unused for 40 days, and says what the counters cannot vouch for", () => {
    const found = one(indexAdvice([indexStat()]), "unused-index");
    expect(found.severity).toBe("medium");
    expect(found.object).toBe("orders.orders_customer_idx");
    expect(found.detail).toBe(
      "This server's usage counters have been running at least since 1 Aug 2026, 40 days ago, " +
        "and no query has used this index in that time. It takes up 8 kB, and writes to orders " +
        "still have to keep it up to date. These are this server's own counters, so an index " +
        "used only on a read replica looks unused here. If the index was created after " +
        "1 Aug 2026, it has had less time than that to be used."
    );
    expect(found.fixKind).toBe("change");
    expect(found.fix).toBe(
      "-- Only if nothing that runs less often than every 40 days (a quarterly report, a yearly job) needs it.\n" +
        'DROP INDEX "shop"."orders_customer_idx";'
    );
    // Built again from the server's own definition, under the same name.
    expect(found.undo).toBe(
      'CREATE INDEX "orders_customer_idx" ON "shop"."orders" USING btree (customer_id);'
    );
  });

  it("names only the jobs rarer than the span the counters cover", () => {
    // After 200 days a quarterly report has run twice and would have used it.
    const after = (days: number) =>
      one(indexAdvice([indexStat()], COUNTERS, daysAfterCounters(days)), "unused-index").fix;
    expect(after(89)).toContain("every 89 days (a quarterly report, a yearly job) needs it.");
    expect(after(200)).toContain("every 200 days (a yearly job, say) needs it.");
    expect(after(400)).toContain("every 400 days needs it.");
  });

  it("only suggests looking again while the counters cover less than 30 days", () => {
    const found = one(indexAdvice([indexStat()], COUNTERS, daysAfterCounters(10)), "unused-index");
    expect(found.severity).toBe("low");
    expect(found.fixKind).toBe("decision");
    expect(found.detail).toContain("at least since 1 Aug 2026, 10 days ago, and no query");
    expect(found.fix.split("\n")[0]).toBe(
      "-- 10 days of counting is too short to be sure nothing needs it."
    );
    expect(found.fix.split("\n").pop()).toBe('-- DROP INDEX "shop"."orders_customer_idx";');
    expect(found.undo).toBeUndefined();
  });

  it("says less than a day rather than 0 days", () => {
    const threeHoursIn = new Date(Date.parse(COUNTERS) + 3 * 3_600_000);
    const found = one(indexAdvice([indexStat()], COUNTERS, threeHoursIn), "unused-index");
    expect(found.detail).toContain(
      "This server's usage counters have been running at least since 1 Aug 2026, " +
        "less than a day ago, and no query has used this index in that time."
    );
    expect(found.fix.split("\n")[0]).toBe(
      "-- Less than a day of counting is too short to be sure nothing needs it."
    );
    // And one day, not "1 days".
    const oneDayIn = one(indexAdvice([indexStat()], COUNTERS, daysAfterCounters(1)), "unused-index");
    expect(oneDayIn.detail).toContain("at least since 1 Aug 2026, 1 day ago, and no query");
  });

  it("says so when the server does not say when its counters started", () => {
    for (const since of [null, "not a date"]) {
      const found = one(indexAdvice([indexStat()], since), "unused-index");
      expect(found.severity).toBe("low");
      expect(found.fixKind).toBe("decision");
      expect(found.detail).toContain(
        "No query has used this index since the server's usage counters last started, " +
          "and this server does not say when that was. It takes up 8 kB,"
      );
      expect(found.detail).not.toContain("If the index was created after");
    }
  });

  it("leaves alone an index that is used, enforces a rule, or belongs to a partition", () => {
    const advice = indexAdvice([
      indexStat({ index_name: "used", idx_scan: 3 }),
      indexStat({ index_name: "unique_one", is_unique: true }),
      indexStat({ index_name: "the_key", is_primary: true, is_unique: true }),
      // An exclusion constraint's index is not unique, but it enforces a rule.
      indexStat({ index_name: "no_overlap", backs_constraint: true }),
      // One partition's piece of a partitioned index cannot be dropped or
      // rebuilt on its own.
      indexStat({ index_name: "orders_2026_customer_idx", is_partition_child: true }),
      indexStat({ index_name: "orders_2027_customer_idx", is_partition_child: true, is_valid: false }),
    ]);
    expect(advice).toEqual([]);
  });

  describe("an unused index that a foreign key is checked through", () => {
    /** orders.customer_id points at customers, and orders_customer_idx is its only index. */
    const KEY: ForeignKeyIndexes = {
      table: "orders",
      name: "orders_customer_fk",
      columns: ["customer_id"],
      referencedTable: "customers",
      indexes: ["orders_customer_idx"],
    };
    const keyAdvice = (
      indexes: IndexStats[],
      keys: ForeignKeyIndexes[],
      since: string | null = COUNTERS,
      now: Date = NOW
    ) => analyzeTableStats("shop", [], indexes, since, now, keys);

    it("is kept at any age, and the finding says why", () => {
      expect(one(keyAdvice([indexStat()], [KEY]), "unused-index").detail).toBe(
        "This server's usage counters have been running at least since 1 Aug 2026, 40 days ago, " +
          "and no query has used this index in that time. It takes up 8 kB, and writes to orders " +
          "still have to keep it up to date. These are this server's own counters, so an index " +
          "used only on a read replica looks unused here. If the index was created after " +
          "1 Aug 2026, it has had less time than that to be used. It is also the only index that " +
          "foreign key orders_customer_fk (on customer_id) can be checked through. Without it, " +
          "every delete or key update on customers has to read all of orders, to check that no " +
          "row still refers to the row being changed."
      );
      const ages: [string | null, Date][] = [
        [COUNTERS, NOW],
        [COUNTERS, daysAfterCounters(10)],
        [null, NOW],
      ];
      for (const [since, now] of ages) {
        const found = one(keyAdvice([indexStat()], [KEY], since, now), "unused-index");
        expect(found.severity).toBe("low");
        expect(found.fixKind).toBe("decision");
        expect(found.undo).toBeUndefined();
        expect(found.detail).toContain("It is also the only index that foreign key orders_customer_fk");
        expect(found.fix).toBe(
          "-- Keep it while rows of customers can be deleted or have their key changed.\n" +
            "-- If neither ever happens it can go, though this screen will then suggest\n" +
            "-- an index for the foreign key again:\n" +
            '-- DROP INDEX "shop"."orders_customer_idx";'
        );
      }
    });

    it("offers the DROP as usual when another index the key can use is in use, or is unique", () => {
      const two: ForeignKeyIndexes = { ...KEY, indexes: ["orders_customer_idx", "orders_customer_placed_idx"] };
      for (const other of [{ idx_scan: 5 }, { is_unique: true }]) {
        const found = one(
          keyAdvice([indexStat(), indexStat({ index_name: "orders_customer_placed_idx", ...other })], [two]),
          "unused-index"
        );
        expect(found.object).toBe("orders.orders_customer_idx");
        expect(found.fixKind).toBe("change");
        expect(runnable(found.fix)).toEqual(['DROP INDEX "shop"."orders_customer_idx";']);
      }
    });

    it("asks to keep one of several when none of them is in use", () => {
      const two: ForeignKeyIndexes = { ...KEY, indexes: ["orders_customer_idx", "orders_customer_status_idx"] };
      const found = keyAdvice([indexStat(), indexStat({ index_name: "orders_customer_status_idx" })], [two]).filter(
        (a) => a.id === "unused-index"
      );
      expect(found.map((a) => a.fixKind)).toEqual(["decision", "decision"]);
      for (const item of found) {
        expect(item.detail).toContain(
          "It is also one of 2 indexes that foreign key orders_customer_fk (on customer_id) can be " +
            "checked through, and the other one is not in use either. Without any of them, every delete"
        );
        expect(item.fix.split("\n").slice(0, 3)).toEqual([
          "-- Keep at least one of the 2 indexes the key can be checked through while",
          "-- rows of customers can be deleted or have their key changed. This one can",
          "-- go as long as another of them stays:",
        ]);
      }
      const three: ForeignKeyIndexes = { ...two, indexes: [...two.indexes, "orders_customer_paid_idx"] };
      const ofThree = one(keyAdvice([indexStat()], [three]), "unused-index");
      expect(ofThree.detail).toContain("one of 3 indexes");
      expect(ofThree.detail).toContain("and none of the others is in use either. Without any of them,");
      // An invalid index is no help: queries, the key's checks among them,
      // never use one, whatever its counter says.
      const withInvalid = keyAdvice(
        [indexStat(), indexStat({ index_name: "orders_customer_status_idx", is_valid: false, idx_scan: 9 })],
        [two]
      );
      expect(one(withInvalid, "unused-index").fixKind).toBe("decision");
    });

    it("leaves an index alone when the key is on another table or goes through another index", () => {
      expect(one(keyAdvice([indexStat()], [{ ...KEY, table: "invoices" }]), "unused-index").fixKind).toBe("change");
      expect(
        one(keyAdvice([indexStat()], [{ ...KEY, indexes: ["orders_placed_idx"] }]), "unused-index").fixKind
      ).toBe("change");
    });

    it("keeps a line break in the parent table's name out of the SQL", () => {
      const evil = "customers\nDROP TABLE users; SELECT 1";
      const one1 = keyAdvice([indexStat()], [{ ...KEY, referencedTable: evil }]);
      const two = keyAdvice([indexStat(), indexStat({ index_name: "orders_customer_status_idx" })], [
        { ...KEY, referencedTable: evil, indexes: ["orders_customer_idx", "orders_customer_status_idx"] },
      ]);
      for (const item of [...one1, ...two]) expect(fixProblems(item)).toEqual([]);
    });
  });

  it("rebuilds an expression index exactly as the server printed it", () => {
    // Read with nothing on the search_path, so the function keeps its schema
    // and the undo needs no note about the search_path.
    const found = one(
      indexAdvice([
        indexStat({
          index_name: "orders_email_idx",
          definition: "CREATE INDEX orders_email_idx ON shop.orders USING btree (shop.normalize(email))",
        }),
      ]),
      "unused-index"
    );
    expect(found.undo).toBe(
      'CREATE INDEX "orders_email_idx" ON "shop"."orders" USING btree (shop.normalize(email));'
    );
  });

  it("offers to rebuild an invalid index, after checking no build is still running", () => {
    const found = one(indexAdvice([indexStat({ is_valid: false })]), "invalid-index");
    expect(found.fixKind).toBe("maintenance");
    // The check comes before anything that would break into a running build.
    expect(found.fix.split("\n").slice(0, 5)).toEqual([
      "-- An index is also marked invalid while CREATE INDEX CONCURRENTLY or REINDEX",
      "-- CONCURRENTLY is still building it. Check first that its table is not in the",
      "-- list this prints:",
      "-- SELECT relid::regclass AS table_name, command, phase",
      "-- FROM pg_stat_progress_create_index WHERE datname = current_database();",
    ]);
    expect(runnable(found.fix)).toEqual(['REINDEX INDEX "shop"."orders_customer_idx";']);
    expect(found.fix).not.toContain("unique index");
    expect(found.undo).toBeUndefined();
  });

  it("warns that an invalid unique index fails the same way until the duplicates go", () => {
    const found = one(indexAdvice([indexStat({ is_valid: false, is_unique: true })]), "invalid-index");
    // Checked on PostgreSQL 17: REINDEX of an invalid unique index over two
    // equal values stops with "could not create unique index", naming them.
    expect(found.fix).toContain(
      "-- It is a unique index, so if two rows share a value the rebuild stops with an\n" +
        "-- error naming that value. Fix those rows first.\n" +
        'REINDEX INDEX "shop"."orders_customer_idx";'
    );
  });

  it("drops a copy REINDEX CONCURRENTLY left behind instead of rebuilding it", () => {
    const ccnew = one(
      indexAdvice([indexStat({ index_name: "orders_customer_idx_ccnew", is_valid: false })]),
      "invalid-index"
    );
    // Maintenance, run by hand: only this server has the copy, so saved as a
    // migration the DROP would fail on every other database.
    expect(ccnew.fixKind).toBe("maintenance");
    expect(ccnew.undo).toBeUndefined();
    expect(fixProblems(ccnew)).toEqual([]);
    expect(ccnew.fix).toContain("pg_stat_progress_create_index");
    expect(ccnew.fix).toContain("the rebuild stopped before this copy was ready");
    expect(runnable(ccnew.fix)).toEqual(['DROP INDEX "shop"."orders_customer_idx_ccnew";']);

    const ccold = one(
      indexAdvice([indexStat({ index_name: "orders_customer_idx_ccold1", is_valid: false })]),
      "invalid-index"
    );
    expect(ccold.fix).toContain("the rebuild finished but could not remove the old copy");
    expect(runnable(ccold.fix)).toEqual(['DROP INDEX "shop"."orders_customer_idx_ccold1";']);
  });

  it("qualifies every statement with the schema it read, quoted", () => {
    const advice = analyzeTableStats(
      "Sales Dept",
      [stats({ n_live_tup: 10_000, n_dead_tup: 2_500 })],
      [indexStat()],
      COUNTERS,
      NOW
    );
    expect(runnable(one(advice, "dead-tuples").fix)).toEqual(['VACUUM (ANALYZE) "Sales Dept"."orders";']);
    expect(runnable(one(advice, "unused-index").fix)).toEqual([
      'DROP INDEX "Sales Dept"."orders_customer_idx";',
    ]);
    expect(one(advice, "unused-index").undo).toBe(
      'CREATE INDEX "orders_customer_idx" ON "Sales Dept"."orders" USING btree (customer_id);'
    );
  });
});

describe("attachForeignKeyIndexes", () => {
  /** The structure and statistics findings for one orders table, as the route puts them together. */
  function ordersAdvice(foreignKeys: ForeignKeySnapshot[]): PerfAdvice[] {
    const structural = analyzeSchemaPerformance(snapshot([table("orders", { foreignKeys, indexes: [] })]));
    const runtime = analyzeTableStats("public", [stats(SCANNED_IN_FULL)], [], COUNTERS, NOW);
    return [...structural, ...runtime];
  }

  it("gives a whole-table-read finding the index of an unindexed foreign key on the same table", () => {
    const advice = ordersAdvice([fk("orders_customer_fk", ["customer_id"])]);
    const foreignKey = one(advice, "foreign-key-not-indexed");
    const scans = one(attachForeignKeyIndexes(advice), "sequential-scan-heavy");
    expect(scans.fixKind).toBe("change");
    expect(scans.fix).toBe(
      "-- This table also has a foreign key with no index (orders.customer_id). That is\n" +
        "-- a common cause of whole-table reads, and the cheapest thing to try first.\n" +
        "-- It is the same statement as on that suggestion, so run it once.\n" +
        foreignKey.fix
    );
    expect(runnable(scans.fix)).toEqual([
      'CREATE INDEX "orders_customer_id_idx" ON "public"."orders" ("customer_id");',
    ]);
    expect(scans.undo).toBe(foreignKey.undo);
    // The link to the analyser stays: the index is only the likeliest cause.
    expect(scans.action?.label).toBe("Analyse a query on this table");
  });

  it("leaves the findings it was given alone", () => {
    const advice = ordersAdvice([fk("orders_customer_fk", ["customer_id"])]);
    const scans = one(advice, "sequential-scan-heavy");
    const copy = { ...scans };
    attachForeignKeyIndexes(advice);
    expect(one(advice, "sequential-scan-heavy")).toBe(scans);
    expect(scans).toEqual(copy);
  });

  it("changes nothing when the table has no unindexed foreign key", () => {
    const advice = ordersAdvice([]);
    expect(attachForeignKeyIndexes(advice)).toEqual(advice);
  });

  it("takes the first unindexed foreign key when there are several", () => {
    const advice = ordersAdvice([fk("a_fk", ["customer_id"]), fk("b_fk", ["shipper_id"])]);
    const scans = one(attachForeignKeyIndexes(advice), "sequential-scan-heavy");
    expect(runnable(scans.fix)).toEqual([
      'CREATE INDEX "orders_customer_id_idx" ON "public"."orders" ("customer_id");',
    ]);
  });

  it("does not attach another table's foreign key", () => {
    const structural = analyzeSchemaPerformance(
      snapshot([table("invoices", { foreignKeys: [fk("f", ["order_id"])], indexes: [] })])
    );
    const runtime = analyzeTableStats("public", [stats(SCANNED_IN_FULL)], [], COUNTERS, NOW);
    const scans = one(attachForeignKeyIndexes([...structural, ...runtime]), "sequential-scan-heavy");
    expect(scans.fixKind).toBe("decision");
  });
});

describe("withoutRepeatedDrops", () => {
  /**
   * Two copies of one index, as the route sees them: the structure pass finds
   * the copies, and the statistics pass finds both unused. Both passes read
   * schema "public", so their DROPs name the same index.
   */
  function copiesAdvice(now: Date = NOW): PerfAdvice[] {
    const structural = analyzeSchemaPerformance(
      snapshot([
        table("orders", { indexes: [index("orders_a", ["customer_id"]), index("orders_b", ["customer_id"])] }),
      ])
    );
    const unused = (name: string) =>
      indexStat({ index_name: name, definition: `CREATE INDEX ${name} ON public.orders USING btree (customer_id)` });
    const runtime = analyzeTableStats("public", [], [unused("orders_a"), unused("orders_b")], COUNTERS, now);
    return [...structural, ...runtime];
  }

  /** The objects of the unused-index findings, in order. */
  function unusedObjects(advice: PerfAdvice[]): string[] {
    return advice.filter((a) => a.id === "unused-index").map((a) => a.object);
  }

  it("leaves out the unused findings for both copies: the one dropped, and the one kept", () => {
    // Saved as two migrations, the second DROP INDEX "orders_b" would fail,
    // because the first had already dropped it. And dropping orders_a too,
    // for being unused, would leave no copy at all.
    const advice = withoutRepeatedDrops(copiesAdvice());
    expect(runnable(one(advice, "duplicate-index").fix)).toEqual(['DROP INDEX "public"."orders_b";']);
    expect(unusedObjects(advice)).toEqual([]);
    const drops = advice.flatMap((a) => runnable(a.fix)).filter((l) => l.startsWith("DROP INDEX"));
    expect(drops).toEqual(['DROP INDEX "public"."orders_b";']);
  });

  it("also leaves out unused findings that are only decisions", () => {
    // Under 30 days the unused finding says to wait and see. The duplicate
    // finding's reason does not depend on the counters, so waiting is not the
    // advice for either copy.
    const before = copiesAdvice(daysAfterCounters(10));
    expect(before.filter((a) => a.id === "unused-index").map((a) => a.fixKind)).toEqual([
      "decision",
      "decision",
    ]);
    expect(unusedObjects(withoutRepeatedDrops(before))).toEqual([]);
  });

  it("keeps the copy a duplicate finding keeps, even when that copy is the unused one", () => {
    // The copy to keep is chosen by name: orders_a stays and orders_b, the
    // one the queries use, goes. Dropping orders_a as well, for being unused,
    // would leave those queries no index. Once orders_b is gone they use
    // orders_a, and the next check shows it.
    const structural = analyzeSchemaPerformance(
      snapshot([
        table("orders", { indexes: [index("orders_a", ["customer_id"]), index("orders_b", ["customer_id"])] }),
      ])
    );
    const stat = (name: string, idx_scan: number) =>
      indexStat({
        index_name: name,
        idx_scan,
        definition: `CREATE INDEX ${name} ON public.orders USING btree (customer_id)`,
      });
    const runtime = analyzeTableStats("public", [], [stat("orders_a", 0), stat("orders_b", 500)], COUNTERS, NOW);
    expect(one(runtime, "unused-index").object).toBe("orders.orders_a");
    const advice = withoutRepeatedDrops([...structural, ...runtime]);
    expect(ids(advice)).not.toContain("unused-index");
    expect(advice.flatMap((a) => runnable(a.fix))).toEqual(['DROP INDEX "public"."orders_b";']);
  });

  it("leaves out the unused finding for a narrow index that a wider one covers", () => {
    const structural = analyzeSchemaPerformance(
      snapshot([
        table("orders", {
          indexes: [index("narrow", ["customer_id"]), index("wide", ["customer_id", "placed_at"])],
        }),
      ])
    );
    const runtime = analyzeTableStats(
      "public",
      [],
      [
        indexStat({ index_name: "narrow", definition: "CREATE INDEX narrow ON public.orders USING btree (customer_id)" }),
        indexStat({
          index_name: "wide",
          idx_scan: 120,
          definition: "CREATE INDEX wide ON public.orders USING btree (customer_id, placed_at)",
        }),
      ],
      COUNTERS,
      NOW
    );
    expect(one(runtime, "unused-index").object).toBe("orders.narrow");
    const advice = withoutRepeatedDrops([...structural, ...runtime]);
    expect(one(advice, "redundant-index").fix).toBe('DROP INDEX "public"."narrow";');
    expect(ids(advice)).not.toContain("unused-index");
  });

  it("keeps the wider index when the narrow one it covers is the one in use", () => {
    // The redundant finding drops narrow and keeps wide. Dropping wide too,
    // for being unused, would leave lookups by customer_id no index at all.
    const structural = analyzeSchemaPerformance(
      snapshot([
        table("orders", {
          indexes: [index("narrow", ["customer_id"]), index("wide", ["customer_id", "placed_at"])],
        }),
      ])
    );
    const runtime = analyzeTableStats(
      "public",
      [],
      [
        indexStat({
          index_name: "narrow",
          idx_scan: 120,
          definition: "CREATE INDEX narrow ON public.orders USING btree (customer_id)",
        }),
        indexStat({ index_name: "wide", definition: "CREATE INDEX wide ON public.orders USING btree (customer_id, placed_at)" }),
      ],
      COUNTERS,
      NOW
    );
    expect(one(runtime, "unused-index").object).toBe("orders.wide");
    const advice = withoutRepeatedDrops([...structural, ...runtime]);
    expect(advice.flatMap((a) => runnable(a.fix))).toEqual(['DROP INDEX "public"."narrow";']);
  });

  it("keeps an unused finding when the other finding only names the drop in a comment", () => {
    // A decision runs nothing, so the unused finding's DROP is the only one
    // that would run.
    const advice = copiesAdvice();
    const commented: PerfAdvice = {
      ...one(advice, "duplicate-index"),
      fixKind: "decision",
      fix: '-- DROP INDEX "public"."orders_b";',
      undo: undefined,
    };
    const unused = advice.filter((a) => a.id === "unused-index");
    expect(withoutRepeatedDrops([commented, ...unused])).toEqual([commented, ...unused]);
  });

  it("keeps everything else in the order given, and leaves the list it was given alone", () => {
    const advice = copiesAdvice();
    const before = [...advice];
    const result = withoutRepeatedDrops(advice);
    expect(advice).toEqual(before);
    expect(result).not.toBe(advice);
    const removed = advice.filter((a) => a.id === "unused-index");
    expect(removed.map((a) => a.object).sort()).toEqual(["orders.orders_a", "orders.orders_b"]);
    expect(result).toEqual(advice.filter((a) => !removed.includes(a)));
  });
});

describe("describeStatsError", () => {
  /** An error the way the pg driver throws one: a message and a SQLSTATE code. */
  const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });

  it("explains a statement timeout, with the limit the route sets", () => {
    expect(describeStatsError(pgError("57014", "canceling statement due to statement timeout"))).toBe(
      "Reading the usage statistics took longer than 5 seconds, so it was stopped; suggestions " +
        "based on how the tables are used are missing. Try again when the server is quieter."
    );
  });

  it("explains a lock wait, the kind another session's ALTER TABLE causes", () => {
    expect(describeStatsError(pgError("55P03", "canceling statement due to lock timeout"))).toBe(
      "Another session holds a lock on a table or index in this schema (a running ALTER TABLE, " +
        "for example), so the statistics could not be read within 2 seconds; suggestions based " +
        "on how the tables are used are missing. Try again once it has finished."
    );
  });

  it("quotes any other error from PostgreSQL as the server's own words", () => {
    expect(describeStatsError(pgError("42501", "permission denied for schema shop"))).toBe(
      "The server's usage statistics could not be read, so suggestions based on how the tables " +
        "are used are missing. PostgreSQL said: permission denied for schema shop"
    );
  });

  it("does not pass off a dropped connection as something PostgreSQL said", () => {
    // Node's own codes can look like a SQLSTATE, but no SQLSTATE starts with E.
    expect(describeStatsError(pgError("EPIPE", "write EPIPE"))).toBe(
      "The server's usage statistics could not be read (write EPIPE), so suggestions based on " +
        "how the tables are used are missing."
    );
    expect(describeStatsError("socket closed")).toBe(
      "The server's usage statistics could not be read (socket closed), so suggestions based on " +
        "how the tables are used are missing."
    );
  });
});

describe("describeStructureError", () => {
  it("says a lock stopped it, with the limit the route sets, rather than blaming the connection", () => {
    expect(
      describeStructureError("Shop", "prod", {
        error: "canceling statement due to lock timeout",
        code: "55P03",
      })
    ).toBe(
      'Another session holds a lock on a table or view in "Shop" on "prod" (a running ALTER TABLE, ' +
        "for example), so its structure could not be read within 5 seconds. Try again once that has finished."
    );
  });

  it("says a timeout stopped it", () => {
    expect(
      describeStructureError("Shop", "prod", {
        error: "canceling statement due to statement timeout",
        code: "57014",
      })
    ).toBe(
      'Reading the structure of "Shop" on "prod" took too long, so it was stopped. ' +
        "The server may be busy; try again when it is quieter."
    );
  });

  it("points at the connection details for anything else, in the server's own words", () => {
    expect(
      describeStructureError("Shop", "prod", { error: 'permission denied for schema "Shop"', code: "42501" })
    ).toBe('Could not read "Shop" on "prod". Check the connection details. Details: permission denied for schema "Shop"');
    expect(describeStructureError("Shop", "prod", { error: "connect ECONNREFUSED 127.0.0.1:5432" })).toBe(
      'Could not read "Shop" on "prod". Check the connection details. Details: connect ECONNREFUSED 127.0.0.1:5432'
    );
  });
});

describe("foreignKeyIndexes", () => {
  it("lists each foreign key with the indexes its checks can go through", () => {
    const keys = foreignKeyIndexes(
      snapshot([
        table("orders", {
          foreignKeys: [
            fk("orders_customer_fk", ["customer_id"], { referencedTable: "customers" }),
            // No index at all: the foreign-key rule's business, nothing to protect.
            fk("orders_region_fk", ["region_id"]),
          ],
          indexes: [
            index("orders_customer_idx", ["customer_id"]),
            index("orders_customer_placed_idx", ["customer_id", "placed_at"]),
            // The key's column second: a check cannot start with it.
            index("orders_placed_customer_idx", ["placed_at", "customer_id"]),
            // Holds only the rows its WHERE matches.
            index("orders_open_customer_idx", ["customer_id"], { predicate: "(status = 'open'::text)" }),
            // An expression index lists no columns.
            index("orders_lower_idx", [], {
              definition: "CREATE INDEX orders_lower_idx ON t USING btree (lower(status))",
            }),
          ],
        }),
      ])
    );
    expect(keys).toEqual([
      {
        table: "orders",
        name: "orders_customer_fk",
        columns: ["customer_id"],
        referencedTable: "customers",
        indexes: ["orders_customer_idx", "orders_customer_placed_idx"],
      },
    ]);
  });

  it("leaves out a key a constraint's index serves, and a table with no record of indexes", () => {
    const keys = foreignKeyIndexes(
      snapshot([
        // The primary key starts with order_id, so the key always has an index.
        table("order_lines", {
          primaryKey: pk(["order_id", "line_no"]),
          foreignKeys: [fk("order_lines_order_fk", ["order_id"])],
          indexes: [index("order_lines_order_idx", ["order_id"])],
        }),
        table("memberships", {
          uniqueConstraints: [unique("memberships_user_team_key", ["user_id", "team_id"])],
          foreignKeys: [fk("memberships_user_fk", ["user_id"])],
          indexes: [index("memberships_user_idx", ["user_id"])],
        }),
        // Taken before indexes were read: nothing to protect, and nothing to guess.
        table("invoices", { foreignKeys: [fk("invoices_order_fk", ["order_id"])] }),
      ])
    );
    expect(keys).toEqual([]);
  });
});

describe("sortAdvice", () => {
  it("puts the worst findings first", () => {
    const advice: PerfAdvice[] = [
      { id: "c", severity: "low", title: "", object: "a", detail: "", fix: "", fixKind: "decision" },
      { id: "a", severity: "high", title: "", object: "b", detail: "", fix: "", fixKind: "decision" },
      { id: "b", severity: "medium", title: "", object: "c", detail: "", fix: "", fixKind: "decision" },
    ];
    expect(sortAdvice(advice).map((a) => a.severity)).toEqual(["high", "medium", "low"]);
  });

  it("groups findings of one severity by the object they are about", () => {
    const advice: PerfAdvice[] = [
      { id: "x", severity: "low", title: "", object: "zebra", detail: "", fix: "", fixKind: "decision" },
      { id: "y", severity: "low", title: "", object: "apple", detail: "", fix: "", fixKind: "decision" },
    ];
    expect(sortAdvice(advice).map((a) => a.object)).toEqual(["apple", "zebra"]);
  });

  it("leaves the input array untouched", () => {
    const advice: PerfAdvice[] = [
      { id: "c", severity: "low", title: "", object: "a", detail: "", fix: "", fixKind: "decision" },
      { id: "a", severity: "high", title: "", object: "b", detail: "", fix: "", fixKind: "decision" },
    ];
    sortAdvice(advice);
    expect(advice[0].id).toBe("c");
  });
});

describe("summarizeAdvice", () => {
  it("counts each severity and the total", () => {
    const advice: PerfAdvice[] = [
      { id: "a", severity: "high", title: "", object: "", detail: "", fix: "", fixKind: "decision" },
      { id: "b", severity: "low", title: "", object: "", detail: "", fix: "", fixKind: "decision" },
      { id: "c", severity: "low", title: "", object: "", detail: "", fix: "", fixKind: "decision" },
    ];
    expect(summarizeAdvice(advice)).toEqual({ high: 1, medium: 0, low: 2, total: 3 });
  });

  it("returns zeroes for an empty list rather than anything falsy", () => {
    expect(summarizeAdvice([])).toEqual({ high: 0, medium: 0, low: 0, total: 0 });
  });
});

// ── Every fix, held to its kind ──────────────────────────────────────────────
// Last in the file on purpose: `collected` holds every finding the tests above
// produced by the time these run.

describe("every finding's fix", () => {
  it("stays safe to paste when a name in it has a line break", () => {
    // PostgreSQL allows any character in a quoted name. Inside a comment line
    // a line break would end the comment and run the rest of the name, so the
    // names here carry a statement after one. The SELECT is there so a leak
    // shows up as a statement no kind of fix allows.
    const evil = (label: string, lineBreak = "\n") => `${label}${lineBreak}DROP TABLE users; SELECT 1`;
    const snap = snapshot([
      // No key, and nothing to make one from: the table's name is in the
      // commented-out ALTER TABLE.
      table(evil("logs"), { primaryKey: null, columns: [column("message", "text")] }),
      // No key, but a unique index to take over; its name has a lone \r.
      table("events", {
        primaryKey: null,
        columns: [column("event_id", "bigint", { nullable: false })],
        indexes: [
          index(evil("events_key", "\r"), ["event_id"], {
            isUnique: true,
            definition: `CREATE UNIQUE INDEX "${evil("events_key", "\r")}" ON t USING btree (event_id)`,
          }),
        ],
      }),
      // No key on a partitioned table, whose partition key column is the name.
      table("regions", {
        primaryKey: null,
        partitioning: partitionedBy(`LIST ("${evil("region")}")`),
        columns: [column(evil("region"), "text", { nullable: false })],
      }),
      // Two unique constraints doing one job, left to a person.
      table("customers", {
        columns: [column("email", "text", { nullable: false })],
        uniqueConstraints: [
          unique(evil("customers_email_key"), ["email"]),
          unique(evil("customers_email_key", "\r\n"), ["email"]),
        ],
        indexes: [],
      }),
      // A boolean index, a timestamp and a serial, all with such names.
      table("orders", {
        columns: [
          column(evil("is_paid"), "boolean"),
          column(evil("placed_at"), "timestamp without time zone"),
          column(evil("n"), "integer", {
            nullable: false,
            columnDefault: `nextval('"${evil("orders_n_seq")}"'::regclass)`,
          }),
        ],
        indexes: [
          index(evil("orders_is_paid_idx"), [evil("is_paid")], {
            definition: `CREATE INDEX "${evil("orders_is_paid_idx")}" ON t USING btree ("${evil("is_paid")}")`,
          }),
        ],
      }),
      // An unindexed foreign key, which the whole-table-read finding takes up.
      table(evil("invoices"), { foreignKeys: [fk("f", [evil("order_id")])], indexes: [] }),
    ]);
    const structural = analyzeSchemaPerformance(snap);
    const runtime = analyzeTableStats(
      "public",
      [
        stats({ table_name: evil("carts"), n_live_tup: 10_000, n_dead_tup: 2_500 }),
        stats({ ...SCANNED_IN_FULL, table_name: evil("invoices") }),
      ],
      [
        indexStat({
          table_name: evil("carts"),
          index_name: evil("carts_idx"),
          definition: `CREATE INDEX "${evil("carts_idx")}" ON public."${evil("carts")}" USING btree (a)`,
        }),
        indexStat({ index_name: evil("orders_n_idx"), is_valid: false }),
        indexStat({ index_name: `${evil("orders_n_idx")}_ccnew`, is_valid: false }),
      ],
      // Ten days, so the unused index gets the decision with the commented-out DROP.
      COUNTERS,
      daysAfterCounters(10)
    );
    const advice = attachForeignKeyIndexes([...structural, ...runtime]);

    // Every rule that puts a name into a comment line had its turn.
    expect(new Set(ids(advice))).toEqual(
      new Set([
        "no-primary-key",
        "duplicate-index",
        "boolean-index",
        "timestamp-without-timezone",
        "serial-not-identity",
        "foreign-key-not-indexed",
        "dead-tuples",
        "sequential-scan-heavy",
        "unused-index",
        "invalid-index",
      ])
    );
    for (const item of advice) expect(fixProblems(item)).toEqual([]);
  });

  it("keeps the promise its kind makes", () => {
    expect(collected.length).toBeGreaterThan(50);
    expect(allFixProblems(collected)).toEqual([]);
  });

  it("gives each rule only the kinds of fix it is meant to have", () => {
    // Pinned, so a rule that starts handing out a new kind of fix does so on
    // purpose; and every kind listed has a test above that produces it.
    const kinds = new Map<string, Set<FixKind>>();
    for (const item of collected) {
      kinds.set(item.id, (kinds.get(item.id) ?? new Set<FixKind>()).add(item.fixKind));
    }
    const seen = Object.fromEntries([...kinds].map(([id, set]) => [id, [...set].sort()]));
    expect(seen).toEqual({
      "blank-padded-char": ["change"],
      "boolean-index": ["decision"],
      "dead-tuples": ["maintenance"],
      "duplicate-index": ["change", "decision"],
      "foreign-key-not-indexed": ["change"],
      "invalid-index": ["maintenance"],
      "low-cache-hit": ["decision"],
      "many-indexes": ["decision"],
      "never-analyzed": ["maintenance"],
      "no-primary-key": ["change", "decision"],
      "redundant-index": ["change"],
      "sequential-scan-heavy": ["change", "decision"],
      "serial-not-identity": ["change", "decision"],
      "text-primary-key": ["decision"],
      "timestamp-without-timezone": ["decision"],
      "unused-index": ["change", "decision"],
    });
  });
});
