import type { SchemaSnapshot, TableSnapshot } from "./postgres";

/**
 * Performance advice read out of a schema's structure, and out of PostgreSQL's
 * own statistics when the database is reachable.
 *
 * Two halves, kept apart on purpose:
 *
 *   • `analyzeSchemaPerformance` looks only at a snapshot. It therefore works
 *     against a STORED baseline, which means the Performance screen still has
 *     something to say about a database that is down, and means every rule here
 *     is a pure function that a unit test can pin down exactly.
 *
 *   • `analyzeTableStats` looks at pg_stat_user_tables / pg_stat_user_indexes,
 *     which describe what has actually happened on the server rather than what
 *     the schema allows. Those rules cannot be derived from structure at all —
 *     no snapshot can tell you an index has never been used.
 *
 * Every rule states a cost and a fix. A finding a reader cannot act on is not
 * advice, it is a complaint, so nothing here reports a fact ("this table has 9
 * indexes") without saying what it costs and what to do instead.
 *
 * Deliberately conservative about missing information: an optional collection
 * that a snapshot never recorded means the rule that needs it is SKIPPED for
 * that table, not answered with a guess. Reporting "no index supports this
 * foreign key" because the snapshot predates index capture would be worse than
 * saying nothing.
 */

export type AdviceSeverity = "high" | "medium" | "low";

export type PerfAdvice = {
  /** Stable rule id — used for grouping, filtering and tests. */
  id: string;
  severity: AdviceSeverity;
  /** One line naming what is wrong. */
  title: string;
  /** What it is wrong about: "orders" or "orders.customer_id". */
  object: string;
  /** Why it costs something. */
  detail: string;
  /** What to do instead. SQL when there is a single obvious statement. */
  fix: string;
};

/** Severity order for sorting — high first, and stable within a severity. */
const SEVERITY_RANK: Record<AdviceSeverity, number> = { high: 0, medium: 1, low: 2 };

/**
 * Sort advice the way a reader wants to read it: worst first, then by object.
 *
 * Generic so a caller that has added a field of its own — which half of the
 * screen a finding came from, say — gets its own type back rather than having
 * that field erased on the way through.
 */
export function sortAdvice<T extends PerfAdvice>(advice: T[]): T[] {
  return [...advice].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.object.localeCompare(b.object) ||
      a.id.localeCompare(b.id)
  );
}

/** How many of each severity, for a header that has to fit on one line. */
export function summarizeAdvice(advice: PerfAdvice[]): {
  high: number;
  medium: number;
  low: number;
  total: number;
} {
  return {
    high: advice.filter((a) => a.severity === "high").length,
    medium: advice.filter((a) => a.severity === "medium").length,
    low: advice.filter((a) => a.severity === "low").length,
    total: advice.length,
  };
}

/** Quote an identifier the way PostgreSQL wants it inside generated SQL. */
function quote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** `schema.table` with both halves quoted. */
function qualified(schema: string, table: string): string {
  return `${quote(schema)}.${quote(table)}`;
}

/**
 * Column lists that can serve as the leading edge of a lookup.
 *
 * A foreign key on (a, b) is supported by any index whose FIRST columns are
 * a then b — the index does not have to stop there. Both the primary key and
 * every unique constraint have an index behind them that the snapshot does not
 * list separately (see the note on IndexSnapshot in lib/postgres.ts), so they
 * have to be added by hand or every primary key column would look unindexed.
 *
 * Returns null when this table's snapshot predates index capture, which is the
 * caller's signal to skip rather than guess.
 */
function indexPrefixes(table: TableSnapshot): string[][] | null {
  if (!table.indexes) return null;
  const prefixes: string[][] = [];
  if (table.primaryKey) prefixes.push(table.primaryKey.columns);
  for (const unique of table.uniqueConstraints) prefixes.push(unique.columns);
  for (const index of table.indexes) {
    // An expression index has no column entries, and a partial index only
    // covers the rows its WHERE matches — neither can be relied on to support
    // an arbitrary lookup, so neither counts here.
    if (index.columns.length === 0 || index.predicate) continue;
    prefixes.push(index.columns);
  }
  return prefixes;
}

/** True when `columns` are the leading columns of one of the given prefixes. */
function isCoveredBy(columns: string[], prefixes: string[][]): boolean {
  const wanted = columns.map((c) => c.toLowerCase());
  return prefixes.some((prefix) => {
    if (prefix.length < wanted.length) return false;
    return wanted.every((c, i) => prefix[i]?.toLowerCase() === c);
  });
}

/**
 * Lower-cased type name with any length/precision stripped: "varchar(30)" →
 * "varchar", "numeric(10,2)" → "numeric".
 *
 * Deliberately removes the parenthetical rather than truncating at it. Postgres
 * renders a precision in the MIDDLE of a two-word type name — format_type gives
 * "timestamp(3) with time zone" — so truncating turned a timestamptz column
 * into the bare string "timestamp" and the rule below then offered to convert
 * an already-zoned column to timestamptz.
 */
function baseType(typeDisplay: string): string {
  return typeDisplay
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The sequence name inside a serial column's default, or null.
 *
 * `nextval('shop.orders_id_seq'::regclass)` — the quoted middle is the only
 * place the old sequence's name survives once the default is dropped, and the
 * advice below has to name it or the sequence is orphaned silently.
 */
function oldSequenceName(columnDefault: string): string | null {
  const match = /nextval\('([^']+)'/i.exec(columnDefault);
  return match ? match[1] : null;
}

/**
 * Every schema-structure rule, run over one snapshot.
 *
 * The rules are inline rather than a registry of rule objects: there are a
 * dozen of them, each needs different parts of the table, and a table of
 * predicates would make every one of them harder to read than it is here.
 */
export function analyzeSchemaPerformance(snapshot: SchemaSnapshot): PerfAdvice[] {
  const advice: PerfAdvice[] = [];
  const schema = snapshot.schema;

  for (const table of snapshot.tables) {
    const object = table.name;
    const prefixes = indexPrefixes(table);
    const columnTypes = new Map(
      table.columns.map((c) => [c.name.toLowerCase(), baseType(c.typeDisplay)])
    );

    // ── No primary key ───────────────────────────────────────────────────
    // A partition inherits its parent's key, so a missing one there is the
    // parent's problem and reporting it on every partition would bury the one
    // row that matters.
    if (!table.primaryKey && !table.partitioning?.partitionOf) {
      advice.push({
        id: "no-primary-key",
        severity: "high",
        title: "Table has no primary key",
        object,
        detail:
          "Without a primary key there is no cheap way to address a single row: " +
          "every UPDATE and DELETE by identity has to be written against some " +
          "other column and may match more rows than intended. Logical " +
          "replication also refuses to publish updates to a table with no " +
          "replica identity.",
        fix:
          `Add one, over the columns that already identify a row:\n` +
          `ALTER TABLE ${qualified(schema, table.name)} ADD PRIMARY KEY (<columns>);`,
      });
    }

    // ── Foreign key with nothing to look it up by ────────────────────────
    // Skipped entirely when the snapshot has no index record, because "no
    // index" and "no record of indexes" are not the same claim.
    if (prefixes) {
      for (const fk of table.foreignKeys) {
        if (isCoveredBy(fk.columns, prefixes)) continue;
        const cascades = fk.onDelete.toUpperCase().includes("CASCADE");
        advice.push({
          id: "foreign-key-not-indexed",
          severity: cascades ? "high" : "medium",
          title: "Foreign key has no index on this side",
          object: `${table.name}.${fk.columns.join(", ")}`,
          detail:
            `PostgreSQL indexes the side a foreign key POINTS AT, never the side ` +
            `that holds it. So a join through ${fk.name} scans ${table.name} in ` +
            `full, and so does every delete or key update on ` +
            `${fk.referencedTable ?? "the parent table"} — the server has to prove no ` +
            `child row still references the row being removed.` +
            (cascades
              ? " This key is ON DELETE CASCADE, so that full scan happens on every parent delete."
              : ""),
          fix:
            `CREATE INDEX ON ${qualified(schema, table.name)} ` +
            `(${fk.columns.map(quote).join(", ")});`,
        });
      }
    }

    if (table.indexes) {
      // ── Two indexes that do the same job ───────────────────────────────
      // Matched on the definition with the index name removed: PostgreSQL
      // renders the rest identically for two indexes that are genuinely the
      // same, and it is the only field that covers expression indexes.
      const byShape = new Map<string, string[]>();
      for (const index of table.indexes) {
        const shape = index.normalizedDefinition.replace(index.name, "").trim();
        byShape.set(shape, [...(byShape.get(shape) ?? []), index.name]);
      }
      for (const [, names] of byShape) {
        if (names.length < 2) continue;
        advice.push({
          id: "duplicate-index",
          severity: "medium",
          title:
            names.length === 2
              ? "Two indexes with the same definition"
              : `${names.length} indexes with the same definition`,
          object: `${table.name} (${names.join(", ")})`,
          detail:
            "Identical indexes cost the disk and the write work of every copy — " +
            "each INSERT, UPDATE and DELETE maintains all of them — and the " +
            "planner can only ever use one.",
          // Every duplicate but the first, not just the second: dropping one of
          // three leaves the finding true and the user thinking they fixed it.
          fix: names
            .slice(1)
            .map((name) => `DROP INDEX ${quote(schema)}.${quote(name)};`)
            .join("\n"),
        });
      }

      // ── An index whose columns are the front of another index ──────────
      const plain = table.indexes.filter(
        (index) => index.columns.length > 0 && !index.predicate && !index.isUnique
      );
      for (const narrow of plain) {
        const wider = plain.find(
          (other) =>
            other !== narrow &&
            other.method === narrow.method &&
            other.columns.length > narrow.columns.length &&
            narrow.columns.every(
              (c, i) => other.columns[i]?.toLowerCase() === c.toLowerCase()
            )
        );
        if (!wider) continue;
        advice.push({
          id: "redundant-index",
          severity: "low",
          title: "Index is already covered by a wider one",
          object: `${table.name}.${narrow.name}`,
          detail:
            `Any lookup ${narrow.name} can serve, ${wider.name} can serve too — ` +
            `an index on (${wider.columns.join(", ")}) is usable for a query that ` +
            `only constrains (${narrow.columns.join(", ")}). Keeping both pays the ` +
            `write cost twice for one capability.`,
          fix: `DROP INDEX ${quote(schema)}.${quote(narrow.name)};`,
        });
      }

      // ── An index over a single boolean ─────────────────────────────────
      for (const index of table.indexes) {
        if (index.columns.length !== 1 || index.predicate || index.isUnique) continue;
        if (columnTypes.get(index.columns[0].toLowerCase()) !== "boolean") continue;
        advice.push({
          id: "boolean-index",
          severity: "low",
          title: "Index over a single boolean column",
          object: `${table.name}.${index.name}`,
          detail:
            "A boolean splits the table roughly in half, and the planner will " +
            "read the table directly rather than use an index that eliminates so " +
            "little. The index is maintained on every write and rarely chosen.",
          fix:
            `-- Worth keeping only if one of the two values is rare, and then the\n` +
            `-- index belongs on the columns the query actually filters or orders\n` +
            `-- by, with the boolean as the predicate. Indexing the boolean inside\n` +
            `-- its own predicate stores the same value in every entry.\n` +
            `CREATE INDEX ON ${qualified(schema, table.name)} ` +
            `(/* the column you look up by */) WHERE ${quote(index.columns[0])};\n` +
            `-- Swap the predicate for NOT ${quote(index.columns[0])} if false is the\n` +
            `-- rare value. If neither value is rare, there is nothing to keep:\n` +
            `DROP INDEX ${quote(schema)}.${quote(index.name)};`,
        });
      }

      // ── Enough indexes that writes are paying for them ─────────────────
      const indexCount =
        table.indexes.length + table.uniqueConstraints.length + (table.primaryKey ? 1 : 0);
      if (indexCount > 6) {
        advice.push({
          id: "many-indexes",
          severity: "low",
          title: `${indexCount} indexes on one table`,
          object,
          detail:
            "Every index is maintained inside every INSERT, UPDATE and DELETE on " +
            "this table, so writes slow down roughly in proportion to the count. " +
            "Past about half a dozen it is worth checking which ones the planner " +
            "actually chooses.",
          fix:
            "Compare with the live index statistics on this screen — an index " +
            "with no scans since the counters were last reset is not earning its " +
            "write cost.",
        });
      }
    }

    // ── Column-level rules ───────────────────────────────────────────────
    for (const column of table.columns) {
      const type = baseType(column.typeDisplay);

      if (type === "timestamp without time zone" || type === "timestamp") {
        advice.push({
          id: "timestamp-without-timezone",
          severity: "medium",
          title: "Timestamp column carries no time zone",
          object: `${table.name}.${column.name}`,
          detail:
            "`timestamp without time zone` stores a wall clock and throws the " +
            "offset away, so the same value means different instants depending on " +
            "who reads it. Comparisons across zones, and any index used to serve " +
            "them, are then answering the wrong question.",
          fix:
            `ALTER TABLE ${qualified(schema, table.name)} ` +
            `ALTER COLUMN ${quote(column.name)} TYPE timestamptz;\n` +
            `-- Check what zone the existing values were written in first: this ` +
            `rewrites the table and reads them in the session's TimeZone.`,
        });
      }

      if (type === "character" || type === "bpchar") {
        advice.push({
          id: "blank-padded-char",
          severity: "low",
          title: "Column is character(n)",
          object: `${table.name}.${column.name}`,
          detail:
            "character(n) pads every value out to n with spaces and strips them " +
            "again on the way out, which costs storage on short values and makes " +
            "comparisons subtly different from text. PostgreSQL's own " +
            "documentation recommends against it; there is no performance " +
            "advantage over text.",
          fix:
            `ALTER TABLE ${qualified(schema, table.name)} ` +
            `ALTER COLUMN ${quote(column.name)} TYPE text;`,
        });
      }

      // A `serial` column is a plain integer with a nextval default and a
      // sequence the table does not own in the catalog's eyes.
      if (column.columnDefault?.toLowerCase().startsWith("nextval(")) {
        const target = qualified(schema, table.name);
        const col = quote(column.name);
        // Three things the obvious two-line version gets wrong on a populated
        // table, each of which breaks the next INSERT rather than the ALTER:
        // identity requires NOT NULL, a new identity starts at 1 and collides
        // with every existing row, and the serial's own sequence is left behind
        // still existing and no longer owned by anything.
        const steps = [];
        if (column.nullable) {
          steps.push(
            `ALTER TABLE ${target} ALTER COLUMN ${col} SET NOT NULL;` +
              ` -- identity columns cannot be nullable`
          );
        }
        steps.push(`ALTER TABLE ${target} ALTER COLUMN ${col} DROP DEFAULT;`);
        steps.push(
          `ALTER TABLE ${target} ALTER COLUMN ${col} ` +
            `ADD GENERATED BY DEFAULT AS IDENTITY;`
        );
        steps.push(
          `-- Start the new identity above the rows already there, or the next ` +
            `insert collides.\n` +
            `SELECT setval(pg_get_serial_sequence('${schema}.${table.name}', ` +
            `'${column.name}'), (SELECT max(${col}) FROM ${target}));`
        );
        const orphan = oldSequenceName(column.columnDefault);
        if (orphan) {
          steps.push(
            `-- The serial's own sequence is now unused. Check nothing else ` +
              `names it, then:\n-- DROP SEQUENCE ${orphan};`
          );
        }
        advice.push({
          id: "serial-not-identity",
          severity: "low",
          title: "Column uses serial rather than an identity",
          object: `${table.name}.${column.name}`,
          detail:
            "A serial column's sequence is a separate object with its own " +
            "permissions and its own way of being left behind by a dump, and " +
            "nothing stops a client writing straight past it. GENERATED AS " +
            "IDENTITY is the standard spelling and ties the sequence to the column.",
          fix: steps.join("\n"),
        });
      }
    }

    // ── A wide, variable-length primary key ──────────────────────────────
    if (table.primaryKey) {
      const wide = table.primaryKey.columns.filter((c) => {
        const type = columnTypes.get(c.toLowerCase());
        return type === "text" || type === "character varying" || type === "varchar";
      });
      if (wide.length > 0) {
        advice.push({
          id: "text-primary-key",
          severity: "low",
          title: "Primary key is a text column",
          object: `${table.name}.${wide.join(", ")}`,
          detail:
            "Every foreign key pointing at this table stores a full copy of the " +
            "key, and so does every index entry on both sides. A long text key " +
            "makes all of them larger, which means fewer entries per page and more " +
            "pages read per lookup.",
          fix:
            "If the text is genuinely the identity, leave it. If it is a code that " +
            "happens to be unique, consider an identity column as the key and a " +
            "UNIQUE constraint on the code.",
        });
      }
    }
  }

  return sortAdvice(advice);
}

/**
 * One row of PostgreSQL's own per-table statistics.
 *
 * Field names follow pg_stat_user_tables rather than this project's camelCase,
 * because the whole point of these numbers is that they came from the server —
 * renaming them would make the rule harder to check against the catalog.
 */
export type TableStats = {
  table_name: string;
  seq_scan: number;
  idx_scan: number;
  n_live_tup: number;
  n_dead_tup: number;
  /** Null when the table has never been analysed by hand or by autovacuum. */
  last_analyzed: string | null;
  /** Heap pages served from cache and read from disk, for the hit ratio. */
  heap_blks_hit: number;
  heap_blks_read: number;
};

/** One row of pg_stat_user_indexes, joined to whether the index is a constraint. */
export type IndexStats = {
  table_name: string;
  index_name: string;
  idx_scan: number;
  /** Unique indexes are enforcing something, so an unused one is not waste. */
  is_unique: boolean;
  size_bytes: number;
};

/** Render a byte count the way a person would say it. */
function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Rules that need the server's counters rather than the schema.
 *
 * Every threshold below has a floor on table size as well as a ratio, because
 * a ratio over a nearly empty table says nothing: a hundred sequential scans of
 * a twelve-row lookup table is the correct plan, not a problem.
 *
 * The counters are cumulative since the last `pg_stat_reset()`, which the
 * caller has no way to know the age of — so nothing here says "recently", and
 * the fix text says what to compare against instead.
 */
export function analyzeTableStats(
  schema: string,
  tables: TableStats[],
  indexes: IndexStats[]
): PerfAdvice[] {
  const advice: PerfAdvice[] = [];

  for (const t of tables) {
    const reads = t.seq_scan + t.idx_scan;

    if (t.n_live_tup >= 10_000 && t.seq_scan > 100 && t.seq_scan > t.idx_scan * 10) {
      advice.push({
        id: "sequential-scan-heavy",
        severity: "high",
        title: "Almost every read of this table scans all of it",
        object: t.table_name,
        detail:
          `${t.seq_scan.toLocaleString()} sequential scans against ` +
          `${t.idx_scan.toLocaleString()} index scans, over about ` +
          `${t.n_live_tup.toLocaleString()} rows. At that size the planner would ` +
          `use an index if one matched the WHERE clauses being sent.`,
        fix:
          "Run the queries that hit this table through Query Analysis on this " +
          "screen — the plan names the filter it could not use an index for.",
      });
    }

    if (t.n_live_tup >= 1_000 && t.n_dead_tup > t.n_live_tup * 0.2) {
      advice.push({
        id: "dead-tuples",
        severity: "medium",
        title: "A fifth of this table is dead rows",
        object: t.table_name,
        detail:
          `${t.n_dead_tup.toLocaleString()} dead row versions against ` +
          `${t.n_live_tup.toLocaleString()} live ones. Dead rows still occupy pages, ` +
          `so every scan reads them and then discards them, and the planner's size ` +
          `estimates drift with them.`,
        fix:
          `VACUUM (ANALYZE) ${qualified(schema, t.table_name)};\n` +
          `-- If it comes back, autovacuum is not keeping up with the write rate ` +
          `on this table; lower its scale factor.`,
      });
    }

    if (t.last_analyzed === null && t.n_live_tup >= 1_000) {
      advice.push({
        id: "never-analyzed",
        severity: "medium",
        title: "The planner has no statistics for this table",
        object: t.table_name,
        detail:
          "Neither ANALYZE nor autovacuum has ever collected statistics here, so " +
          "the planner is estimating row counts from defaults. Every plan over " +
          "this table is a guess, and joins are where that goes worst.",
        fix: `ANALYZE ${qualified(schema, t.table_name)};`,
      });
    }

    const blocks = t.heap_blks_hit + t.heap_blks_read;
    if (blocks >= 10_000 && t.heap_blks_hit / blocks < 0.9 && reads > 0) {
      advice.push({
        id: "low-cache-hit",
        severity: "low",
        title: "This table is mostly read from disk",
        object: t.table_name,
        detail:
          `${Math.round((t.heap_blks_hit / blocks) * 100)}% of page reads were served ` +
          `from the buffer cache. Below about 90% the table is being pulled off ` +
          `disk repeatedly, which usually means it does not fit in shared_buffers ` +
          `or the queries reading it take more of it than they need.`,
        fix:
          "Narrow what the queries select, or index them so they touch fewer " +
          "pages. Raising shared_buffers only helps if the working set would then fit.",
      });
    }
  }

  for (const index of indexes) {
    if (index.idx_scan > 0 || index.is_unique) continue;
    advice.push({
      id: "unused-index",
      severity: "medium",
      title: "Index has never been used",
      object: `${index.table_name}.${index.index_name}`,
      detail:
        `No scan has used this index since the statistics were last reset, and it ` +
        `occupies ${humanBytes(index.size_bytes)}. It is still maintained on every ` +
        `write to ${index.table_name}.`,
      fix:
        `Check how long the counters have been running (pg_stat_reset resets them) ` +
        `before acting. If they cover a full business cycle:\n` +
        `DROP INDEX ${quote(schema)}.${quote(index.index_name)};`,
    });
  }

  return sortAdvice(advice);
}
