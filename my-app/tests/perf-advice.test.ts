import {
  analyzeSchemaPerformance,
  analyzeTableStats,
  sortAdvice,
  summarizeAdvice,
  type IndexStats,
  type PerfAdvice,
  type TableStats,
} from "@/lib/perf-advice";
import type {
  ColumnSnapshot,
  ConstraintSnapshot,
  ForeignKeySnapshot,
  IndexSnapshot,
  SchemaSnapshot,
  TableSnapshot,
} from "@/lib/postgres";

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
 */

/** Ids of the advice returned, so a test can assert on what fired. */
function ids(advice: PerfAdvice[]): string[] {
  return advice.map((a) => a.id);
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

function index(name: string, columns: string[], extra: Partial<IndexSnapshot> = {}): IndexSnapshot {
  const cols = columns.join(", ");
  return {
    name,
    definition: `CREATE INDEX ${name} ON t USING btree (${cols})`,
    normalizedDefinition: `CREATE INDEX ${name} ON t USING btree (${cols})`,
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

function snapshot(tables: TableSnapshot[]): SchemaSnapshot {
  return { database: "shop", schema: "public", tables };
}

// ── Structure rules ──────────────────────────────────────────────────────────

describe("analyzeSchemaPerformance", () => {
  it("reports a table with no primary key", () => {
    const advice = analyzeSchemaPerformance(snapshot([table("events", { primaryKey: null })]));
    expect(ids(advice)).toContain("no-primary-key");
  });

  it("says nothing about a partition with no key of its own", () => {
    const advice = analyzeSchemaPerformance(
      snapshot([
        table("events_2026", {
          primaryKey: null,
          partitioning: { strategy: null, key: null, partitionOf: "events", bounds: null, inherits: [] },
        }),
      ])
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
        table("orders", {
          indexes: [
            index("orders_a", ["customer_id"], {
              normalizedDefinition: "CREATE INDEX orders_a ON t USING btree (customer_id)",
            }),
            index("orders_b", ["customer_id"], {
              normalizedDefinition: "CREATE INDEX orders_b ON t USING btree (customer_id)",
            }),
          ],
        }),
      ])
    );
    expect(ids(advice).filter((id) => id === "duplicate-index")).toHaveLength(1);
  });

  it("reports a narrow index already covered by a wider one", () => {
    const advice = analyzeSchemaPerformance(
      snapshot([
        table("orders", {
          indexes: [index("narrow", ["customer_id"]), index("wide", ["customer_id", "placed_at"])],
        }),
      ])
    );
    const found = advice.find((a) => a.id === "redundant-index");
    expect(found?.object).toBe("orders.narrow");
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
          columns: [column("is_paid", "boolean")],
          indexes: [index("i", ["is_paid"])],
        }),
      ])
    );
    expect(ids(advice)).toContain("boolean-index");
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

  it("says nothing about a timestamptz column", () => {
    const advice = analyzeSchemaPerformance(
      snapshot([table("orders", { columns: [column("placed_at", "timestamp with time zone")] })])
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

  it("reports a serial column, recognised by its nextval default", () => {
    const advice = analyzeSchemaPerformance(
      snapshot([
        table("t", {
          columns: [column("id", "integer", { columnDefault: "nextval('t_id_seq'::regclass)" })],
        }),
      ])
    );
    expect(ids(advice)).toContain("serial-not-identity");
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
          uniqueConstraints: [pk(["a"]), pk(["b"]), pk(["c"])],
          indexes: [index("i1", ["d"]), index("i2", ["e"]), index("i3", ["f"])],
        }),
      ])
    );
    // 3 unique + 3 plain + 1 primary key = 7, which is past the threshold of 6.
    expect(ids(advice)).toContain("many-indexes");
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

// ── Statistics rules ─────────────────────────────────────────────────────────

function stats(extra: Partial<TableStats> = {}): TableStats {
  return {
    table_name: "orders",
    seq_scan: 0,
    idx_scan: 0,
    n_live_tup: 0,
    n_dead_tup: 0,
    last_analyzed: "2026-09-01T00:00:00.000Z",
    heap_blks_hit: 0,
    heap_blks_read: 0,
    ...extra,
  };
}

function indexStat(extra: Partial<IndexStats> = {}): IndexStats {
  return {
    table_name: "orders",
    index_name: "orders_customer_idx",
    idx_scan: 0,
    is_unique: false,
    size_bytes: 8192,
    ...extra,
  };
}

describe("analyzeTableStats", () => {
  it("reports a large table that is almost always scanned in full", () => {
    const advice = analyzeTableStats(
      [stats({ n_live_tup: 50_000, seq_scan: 5_000, idx_scan: 10 })],
      []
    );
    expect(ids(advice)).toContain("sequential-scan-heavy");
  });

  it("says nothing about a small lookup table that is always scanned in full", () => {
    const advice = analyzeTableStats([stats({ n_live_tup: 12, seq_scan: 5_000, idx_scan: 0 })], []);
    expect(ids(advice)).not.toContain("sequential-scan-heavy");
  });

  it("reports a table that is a fifth dead rows", () => {
    const advice = analyzeTableStats([stats({ n_live_tup: 10_000, n_dead_tup: 4_000 })], []);
    expect(ids(advice)).toContain("dead-tuples");
  });

  it("says nothing about dead rows on a table too small for it to matter", () => {
    const advice = analyzeTableStats([stats({ n_live_tup: 100, n_dead_tup: 90 })], []);
    expect(ids(advice)).not.toContain("dead-tuples");
  });

  it("reports a table the planner has never had statistics for", () => {
    const advice = analyzeTableStats([stats({ n_live_tup: 5_000, last_analyzed: null })], []);
    expect(ids(advice)).toContain("never-analyzed");
  });

  it("reports a low cache hit ratio only once the table has been read enough", () => {
    const busy = analyzeTableStats(
      [stats({ seq_scan: 10, heap_blks_hit: 5_000, heap_blks_read: 45_000 })],
      []
    );
    const quiet = analyzeTableStats(
      [stats({ seq_scan: 10, heap_blks_hit: 50, heap_blks_read: 450 })],
      []
    );
    expect(ids(busy)).toContain("low-cache-hit");
    expect(ids(quiet)).not.toContain("low-cache-hit");
  });

  it("reports an index nothing has ever used", () => {
    const advice = analyzeTableStats([], [indexStat()]);
    expect(ids(advice)).toContain("unused-index");
  });

  it("leaves an unused unique index alone, because it is enforcing something", () => {
    const advice = analyzeTableStats([], [indexStat({ is_unique: true })]);
    expect(ids(advice)).toEqual([]);
  });

  it("leaves an index that has been used alone", () => {
    const advice = analyzeTableStats([], [indexStat({ idx_scan: 1 })]);
    expect(ids(advice)).toEqual([]);
  });

  it("names the index size in the finding, so the reader can judge it", () => {
    const advice = analyzeTableStats([], [indexStat({ size_bytes: 5 * 1024 * 1024 })]);
    expect(advice[0].detail).toContain("5 MB");
  });
});

// ── Presentation helpers ─────────────────────────────────────────────────────

describe("sortAdvice", () => {
  it("puts the worst findings first", () => {
    const advice: PerfAdvice[] = [
      { id: "c", severity: "low", title: "", object: "a", detail: "", fix: "" },
      { id: "a", severity: "high", title: "", object: "b", detail: "", fix: "" },
      { id: "b", severity: "medium", title: "", object: "c", detail: "", fix: "" },
    ];
    expect(sortAdvice(advice).map((a) => a.severity)).toEqual(["high", "medium", "low"]);
  });

  it("groups findings of one severity by the object they are about", () => {
    const advice: PerfAdvice[] = [
      { id: "x", severity: "low", title: "", object: "zebra", detail: "", fix: "" },
      { id: "y", severity: "low", title: "", object: "apple", detail: "", fix: "" },
    ];
    expect(sortAdvice(advice).map((a) => a.object)).toEqual(["apple", "zebra"]);
  });

  it("leaves the input array untouched", () => {
    const advice: PerfAdvice[] = [
      { id: "c", severity: "low", title: "", object: "a", detail: "", fix: "" },
      { id: "a", severity: "high", title: "", object: "b", detail: "", fix: "" },
    ];
    sortAdvice(advice);
    expect(advice[0].id).toBe("c");
  });
});

describe("summarizeAdvice", () => {
  it("counts each severity and the total", () => {
    const advice: PerfAdvice[] = [
      { id: "a", severity: "high", title: "", object: "", detail: "", fix: "" },
      { id: "b", severity: "low", title: "", object: "", detail: "", fix: "" },
      { id: "c", severity: "low", title: "", object: "", detail: "", fix: "" },
    ];
    expect(summarizeAdvice(advice)).toEqual({ high: 1, medium: 0, low: 2, total: 3 });
  });

  it("returns zeroes for an empty list rather than anything falsy", () => {
    expect(summarizeAdvice([])).toEqual({ high: 0, medium: 0, low: 0, total: 0 });
  });
});
