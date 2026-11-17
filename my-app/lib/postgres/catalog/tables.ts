/**
 * Tables, their columns and their partitioning: the three catalog queries,
 * and the steps that turn the rows into TableSnapshot entries.
 */
import type { PoolClient } from "pg";
import { COMPARE_IGNORED_TABLES, coerceTextArray } from "../helpers";
import { stripSchemaFromExpr } from "../normalize";
import type { TableSnapshot } from "../types";

export type TableRow = {
  table_name: string;
};

export type ColumnRow = {
  table_name: string;
  column_name: string;
  ordinal_position: number;
  type_display: string;
  is_nullable: boolean;
  column_default: string | null;
  /** pg_attribute.attidentity: 'a' ALWAYS, 'd' BY DEFAULT, '' not identity. */
  identity: string | null;
  /** pg_attribute.attgenerated: 's' STORED, 'v' VIRTUAL, '' not generated. */
  generated: string | null;
  /**
   * Both are null for a type that has no collation (an integer, say) and for
   * a column on the database default, the two cases that need no COLLATE
   * clause. The query joins pg_collation the same way
   * information_schema.columns does, which is where this rule came from.
   */
  collation_schema: string | null;
  collation_name: string | null;
};

export type PartitioningRow = {
  table_name: string;
  strategy: string | null;
  key: string | null;
  partition_of: string | null;
  bounds: string | null;
  inherits: string[] | null;
};

/**
 * A column's collation as it goes back into DDL, or null for the type default.
 *
 * pg_catalog is always on the search_path, so its collations are written bare
 * ("C", "und-x-icu") the way the type names beside them are. A collation in the
 * schema being captured is stripped of its qualifier for the same reason
 * typeDisplay is: `dev."ci"` and `staging."ci"` are the same collation seen from
 * two schemas, and leaving the qualifier on would report a difference that isn't
 * one — and pin the generated DDL to the source schema.
 */
function formatCollation(
  collationSchema: string | null,
  collationName: string | null,
  schemaName: string
): string | null {
  if (collationName === null) return null;
  const quoted = `"${collationName.replace(/"/g, '""')}"`;
  if (collationSchema === null || collationSchema === "pg_catalog") return quoted;
  const qualified = `"${collationSchema.replace(/"/g, '""')}"."${collationName.replace(/"/g, '""')}"`;
  return stripSchemaFromExpr(qualified, schemaName) ?? qualified;
}

export async function readTables(client: PoolClient, schemaName: string): Promise<TableRow[]> {
  // Tables and columns come straight from the system catalogs, like every
  // other query here. information_schema only lists a table or a column the
  // login has some privilege on, so a login without rights on a table saw
  // it vanish: drift reported it as removed, or said "in sync" while it had
  // changed, and compare and generate never saw it. The catalogs list
  // everything and can be read by any login.
  //
  // relkind 'r' is an ordinary table and 'p' a partitioned one: the two
  // kinds information_schema called BASE TABLE.
  const result = await client.query<TableRow>(
        `SELECT c.relname AS table_name
         FROM pg_class c
         JOIN pg_namespace n
           ON n.oid = c.relnamespace
         WHERE n.nspname = $1
           AND c.relkind IN ('r', 'p')
           AND c.relname <> ALL($2)
         ORDER BY c.relname`,
      [schemaName, COMPARE_IGNORED_TABLES]
  );
  return result.rows;
}

export async function readColumns(client: PoolClient, schemaName: string): Promise<ColumnRow[]> {
  // is_nullable and the collation join are written the way
  // information_schema.columns writes them, so every column reads exactly as
  // it did before, only without the privilege filter:
  // - a column is NOT NULL when it says so itself, or when its type is a
  //   domain declared NOT NULL;
  // - a collation is reported unless it is the database default (see
  //   ColumnRow above).
  const result = await client.query<ColumnRow>(
        `SELECT
           cls.relname AS table_name,
           a.attname AS column_name,
           a.attnum AS ordinal_position,
           pg_catalog.format_type(a.atttypid, a.atttypmod) AS type_display,
           NOT (a.attnotnull OR (t.typtype = 'd' AND t.typnotnull)) AS is_nullable,
           pg_get_expr(ad.adbin, ad.adrelid) AS column_default,
           a.attidentity AS identity,
           a.attgenerated AS generated,
           nco.nspname AS collation_schema,
           co.collname AS collation_name
         FROM pg_class cls
         JOIN pg_namespace n
           ON n.oid = cls.relnamespace
         JOIN pg_attribute a
           ON a.attrelid = cls.oid
          AND a.attnum > 0
          AND NOT a.attisdropped
         JOIN pg_type t
           ON t.oid = a.atttypid
         LEFT JOIN pg_attrdef ad
           ON ad.adrelid = cls.oid
          AND ad.adnum = a.attnum
         LEFT JOIN (pg_collation co JOIN pg_namespace nco ON nco.oid = co.collnamespace)
           ON co.oid = a.attcollation
          AND (nco.nspname, co.collname) <> ('pg_catalog', 'default')
         WHERE n.nspname = $1
           AND cls.relkind IN ('r', 'p')
           AND cls.relname <> ALL($2)
         ORDER BY cls.relname, a.attnum`,
      [schemaName, COMPARE_IGNORED_TABLES]
  );
  return result.rows;
}

export async function readPartitioning(client: PoolClient, schemaName: string): Promise<PartitioningRow[]> {
  // Partitioning and inheritance, which nothing else in a snapshot records.
  //
  // Three separate facts, all reachable from pg_class: a parent's strategy
  // and key (pg_partitioned_table + pg_get_partkeydef), a partition's bound
  // (relpartbound), and old-style INHERITS parents (pg_inherits, filtered to
  // the rows a partition does not produce). partstrat is a single char, so it
  // is spelled out here rather than left as 'r'/'l'/'h' for the UI to decode.
  const result = await client.query<PartitioningRow>(
      `SELECT
         c.relname AS table_name,
         CASE pt.partstrat
           WHEN 'r' THEN 'RANGE'
           WHEN 'l' THEN 'LIST'
           WHEN 'h' THEN 'HASH'
         END AS strategy,
         CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END AS key,
         CASE WHEN c.relispartition THEN (
           SELECT pc.relname
           FROM pg_inherits i
           JOIN pg_class pc ON pc.oid = i.inhparent
           WHERE i.inhrelid = c.oid
         ) END AS partition_of,
         CASE WHEN c.relispartition
           THEN pg_get_expr(c.relpartbound, c.oid)
         END AS bounds,
         CASE WHEN NOT c.relispartition THEN (
           SELECT array_agg(pc.relname ORDER BY i.inhseqno)
           FROM pg_inherits i
           JOIN pg_class pc ON pc.oid = i.inhparent
           WHERE i.inhrelid = c.oid
         ) END AS inherits
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_partitioned_table pt ON pt.partrelid = c.oid
       WHERE n.nspname = $1
         AND c.relkind IN ('r', 'p')
         AND c.relname <> ALL($2)
       ORDER BY c.relname`,
      [schemaName, COMPARE_IGNORED_TABLES]
  );
  return result.rows;
}

/** One empty TableSnapshot per table, keyed by name, for the later steps to fill. */
export function startTables(rows: TableRow[]): Map<string, TableSnapshot> {
  const tablesByName = new Map<string, TableSnapshot>();

  for (const row of rows) {
    tablesByName.set(row.table_name, {
      name: row.table_name,
      columns: [],
      primaryKey: null,
      uniqueConstraints: [],
      foreignKeys: [],
      checkConstraints: [],
      excludeConstraints: [],
      indexes: [],
      triggers: [],
      // Filled in by the two row-security steps (catalog/row-security.ts).
      // Starting at "off, no policies" is not a guess: every table the
      // catalog did not report a flag for genuinely has RLS off.
      rowSecurity: { enabled: false, forced: false, policies: [] },
      partitioning: {
        strategy: null,
        key: null,
        partitionOf: null,
        bounds: null,
        inherits: [],
      },
    });
  }
  return tablesByName;
}

/** Records each table's partitioning and inheritance. */
export function applyPartitioning(
  tablesByName: Map<string, TableSnapshot>,
  rows: PartitioningRow[]
): void {
  for (const row of rows) {
    const table = tablesByName.get(row.table_name);
    if (!table) continue;
    table.partitioning = {
      strategy: row.strategy,
      key: row.key,
      partitionOf: row.partition_of,
      bounds: row.bounds,
      inherits: coerceTextArray(row.inherits),
    };
  }
}

/** Adds each column to its table. */
export function addColumns(
  tablesByName: Map<string, TableSnapshot>,
  rows: ColumnRow[],
  schemaName: string
): void {
  for (const row of rows) {
    const table = tablesByName.get(row.table_name);
    if (!table) {
      continue;
    }

    const columnExpression = stripSchemaFromExpr(row.column_default ?? null, schemaName);
    // 'v' only ever appears on PostgreSQL 18 and up; older servers return ''
    // for every column, which reads as "not generated" and is correct there.
    const generatedStorage =
      row.generated === "s" ? "STORED" : row.generated === "v" ? "VIRTUAL" : null;

    table.columns.push({
      name: row.column_name,
      ordinalPosition: row.ordinal_position,
      // format_type() schema-qualifies a user-defined type (enum/domain/composite)
      // whose schema isn't on the introspection search_path, so `dev.order_status`
      // would falsely differ from `staging.order_status` and a generated ALTER
      // would pin the column to the SOURCE schema's type. Strip the own-schema
      // qualifier so types are schema-relative (built-in types are never qualified).
      typeDisplay: stripSchemaFromExpr(row.type_display, schemaName) ?? row.type_display,
      nullable: row.is_nullable,
      // A generated column keeps its expression in pg_attrdef, the same place a
      // DEFAULT lives, so the two are separated HERE and nowhere else. Leaving
      // it in columnDefault is what made every migration touching a generated
      // column emit `DEFAULT (price * qty)` and abort.
      columnDefault: generatedStorage === null ? columnExpression : null,
      generated:
        generatedStorage === null
          ? null
          : { storage: generatedStorage, expression: columnExpression ?? "" },
      identity:
        row.identity === "a" ? "ALWAYS" : row.identity === "d" ? "BY DEFAULT" : null,
      collation: formatCollation(row.collation_schema, row.collation_name, schemaName),
      // Filled in later by attachSequenceOptions (catalog/sequences.ts), once
      // the sequences have been built. null here means "no sequence behind
      // this column", which is true of most of them.
      sequenceOptions: null,
      isPrimaryKey: false,
      uniqueConstraintNames: [],
      foreignKeyConstraintNames: [],
    });
  }
}

/** Puts everything inside each table into its fixed order. */
export function sortTableContents(tablesByName: Map<string, TableSnapshot>): void {
  for (const table of tablesByName.values()) {
    table.columns.sort((a, b) => a.ordinalPosition - b.ordinalPosition);
    for (const column of table.columns) {
      column.uniqueConstraintNames.sort();
      column.foreignKeyConstraintNames.sort();
    }
    table.uniqueConstraints.sort((a, b) => a.name.localeCompare(b.name));
    table.foreignKeys.sort((a, b) => a.name.localeCompare(b.name));
    table.checkConstraints.sort((a, b) => a.name.localeCompare(b.name));
    table.excludeConstraints.sort((a, b) => a.name.localeCompare(b.name));
    table.indexes?.sort((a, b) => a.name.localeCompare(b.name));
    table.triggers?.sort((a, b) => a.name.localeCompare(b.name));
    table.rowSecurity?.policies.sort((a, b) => a.name.localeCompare(b.name));
  }
}
