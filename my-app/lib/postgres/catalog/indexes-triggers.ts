/**
 * Indexes and triggers: the two catalog queries, and the steps that hang each
 * row off the table or view it belongs to.
 */
import type { PoolClient } from "pg";
import { COMPARE_IGNORED_TABLES, coerceTextArray } from "../helpers";
import { normalizeDefinition, stripSchemaFromExpr } from "../normalize";
import type { IndexSnapshot, TriggerSnapshot } from "../types";

export type IndexRow = {
  table_name: string;
  index_name: string;
  definition: string;
  is_unique: boolean;
  method: string;
  columns: string[] | null;
  predicate: string | null;
};

export type TriggerRow = {
  table_name: string;
  name: string;
  definition: string;
  function_name: string;
  enabled: boolean;
};

/**
 * Tables and views together, by name. An index or a trigger can belong to
 * either, and the steps here do not need to know which.
 */
export type RelationsByName = Map<
  string,
  { indexes?: IndexSnapshot[]; triggers?: TriggerSnapshot[] }
>;

/**
 * An index's leading key columns, as the snapshot records them.
 *
 * The query that feeds this already stops at the first thing that is not a
 * plain column, so a null should never reach here. Handled anyway, and by
 * TRUNCATING rather than dropping: an entry that is not a column name breaks
 * the run of leading columns, and removing it from the middle would leave
 * (a, lower(b), c) reading as an index on (a, c) — a list the rules would
 * happily match a lookup on (a, c) against, which this index cannot serve.
 * Dropping also used to happen by accident the other way: String(null) is the
 * four letters "null", which went into the list as if it were a column.
 */
function leadingColumns(value: unknown): string[] {
  if (!Array.isArray(value)) return coerceTextArray(value);
  const stop = value.findIndex((entry) => entry === null || entry === undefined);
  return coerceTextArray(stop === -1 ? value : value.slice(0, stop));
}

export async function readIndexes(client: PoolClient, schemaName: string): Promise<IndexRow[]> {
  // Non-constraint indexes only. An index that backs a PRIMARY KEY or UNIQUE
  // constraint is already reported as that constraint, so including it here
  // would make every primary key show up as two separate differences — and
  // the generated migration would try to drop an index Postgres owns.
  //
  // Only p/u/x own an index, and the contype filter matters: a FOREIGN KEY's
  // conindid is not an index it owns, it is the index on the OTHER table that
  // the key reads to check itself. PostgreSQL is happy for that to be a plain
  // CREATE UNIQUE INDEX rather than a constraint — and asking only "is any
  // constraint pointing at this index" then threw that index away. It
  // vanished from the snapshot, so a comparison saw nothing to report and a
  // generated script never created it; the foreign key that needed it then
  // failed with "there is no unique constraint matching given keys".
  // (Confirmed on PostgreSQL 18: the referencing key's conindid really does
  // name the parent's standalone index.)
  //
  // 'm' is in the relkind list beside the tables: a materialized view stores
  // its rows and is indexed like a table, and REFRESH ... CONCURRENTLY does
  // not work without a unique index on it. Reading only 'r' and 'p' meant a
  // migration that rebuilt a matview left it with no index at all, and
  // nothing in the report mentioned it.
  //
  // Partition indexes are skipped for the same reason. An index on a
  // partitioned parent makes PostgreSQL create a matching one on every
  // partition, attached via pg_inherits. Recording those meant the script
  // emitted a CREATE INDEX for the parent and then another for each child,
  // and the second one failed on a name PostgreSQL had just taken.
  const result = await client.query<IndexRow>(
      `SELECT
         c.relname AS table_name,
         i.relname AS index_name,
         pg_get_indexdef(x.indexrelid) AS definition,
         x.indisunique AS is_unique,
         am.amname AS method,
         -- The leading KEY columns only, and only as far as the first thing
         -- that is not a plain column. indkey holds more than the columns a
         -- lookup can use:
         --   • everything after indnkeyatts is an INCLUDE column, carried in
         --     the index's rows but not searchable. Recorded as a key column,
         --     an index on (customer_id) INCLUDE (total) looked like it could
         --     serve a foreign key on (customer_id, total), which it cannot.
         --   • an expression (lower(email)) is written as attnum 0, which
         --     matches no row in pg_attribute. It used to be kept as a NULL,
         --     which then became the literal text "null" further up. Stopping
         --     at it is also what the rules want: in (a, lower(b), c) only a
         --     is a usable leading column, because c sits behind lower(b).
         -- indnkeyatts is PostgreSQL 11 and later, which INCLUDE itself is too;
         -- the app already needs 12 for the views the Suggestions tab reads.
         (SELECT COALESCE(array_agg(a.attname ORDER BY k.ord), '{}'::text[])
            FROM unnest(x.indkey) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a
              ON a.attrelid = c.oid AND a.attnum = k.attnum
           WHERE k.ord <= x.indnkeyatts
             AND NOT EXISTS (
               SELECT 1 FROM unnest(x.indkey) WITH ORDINALITY AS e(attnum, ord)
                WHERE e.attnum = 0 AND e.ord <= k.ord
             )) AS columns,
         pg_get_expr(x.indpred, x.indrelid) AS predicate
       FROM pg_index x
       JOIN pg_class c ON c.oid = x.indrelid
       JOIN pg_class i ON i.oid = x.indexrelid
       JOIN pg_am am ON am.oid = i.relam
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1
         AND c.relkind IN ('r', 'p', 'm')
         AND c.relname <> ALL($2)
         AND NOT EXISTS (
           SELECT 1 FROM pg_constraint con
            WHERE con.conindid = x.indexrelid
              AND con.contype IN ('p', 'u', 'x')
         )
         AND NOT EXISTS (
           SELECT 1 FROM pg_inherits ii WHERE ii.inhrelid = x.indexrelid
         )
       ORDER BY c.relname, i.relname`,
      [schemaName, COMPARE_IGNORED_TABLES]
  );
  return result.rows;
}

export async function readTriggers(client: PoolClient, schemaName: string): Promise<TriggerRow[]> {
  // NOT tgisinternal skips the hidden triggers Postgres creates to enforce
  // foreign keys — those are the FK, and are already recorded as one.
  // tgparentid = 0 skips the copies cloned onto each partition from a trigger
  // on the parent; the parent's trigger is what recreates them.
  const result = await client.query<TriggerRow>(
      `SELECT
         c.relname AS table_name,
         t.tgname AS name,
         pg_get_triggerdef(t.oid, true) AS definition,
         p.proname AS function_name,
         (t.tgenabled <> 'D') AS enabled
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE n.nspname = $1
         AND NOT t.tgisinternal
         AND t.tgparentid = 0
         AND c.relname <> ALL($2)
       ORDER BY c.relname, t.tgname`,
      [schemaName, COMPARE_IGNORED_TABLES]
  );
  return result.rows;
}

/** Adds each index to its table or materialized view. */
export function addIndexes(
  relationsByName: RelationsByName,
  rows: IndexRow[],
  schemaName: string
): void {
  for (const row of rows) {
    const relation = relationsByName.get(row.table_name);
    if (!relation) {
      continue;
    }

    // pg_get_indexdef() qualifies the table and any user function or type it
    // mentions, for the same reason pg_get_constraintdef() does: nothing sets
    // a search_path here. Strip the own-schema qualifier so the same index in
    // two schemas compares equal and replays into either one.
    const definition = stripSchemaFromExpr(row.definition, schemaName) ?? row.definition;

    relation.indexes?.push({
      name: row.index_name,
      definition,
      normalizedDefinition: normalizeDefinition(definition),
      columns: leadingColumns(row.columns),
      isUnique: row.is_unique,
      method: row.method,
      predicate: stripSchemaFromExpr(row.predicate ?? null, schemaName),
    });
  }
}

/** Adds each trigger to its table or view. */
export function addTriggers(
  relationsByName: RelationsByName,
  rows: TriggerRow[],
  schemaName: string
): void {
  for (const row of rows) {
    const relation = relationsByName.get(row.table_name);
    if (!relation) {
      continue;
    }

    const definition = stripSchemaFromExpr(row.definition, schemaName) ?? row.definition;

    relation.triggers?.push({
      name: row.name,
      definition,
      normalizedDefinition: normalizeDefinition(definition),
      functionName: row.function_name,
      enabled: row.enabled,
    });
  }
}
