// Query analysis: what the route reads from the catalog about a plan's tables.
//
// Holds the PlanCatalog types, catalogFromRows, which builds one from query
// rows, and planRelations, which lists the tables a plan touches.

import type { PlanStep } from "./plan-types";

/**
 * How many rows each table actually holds, keyed `"schema.table"`.
 *
 * A plan says how many rows a step will HAND ON, not how many it will READ.
 * `SELECT * FROM orders WHERE id = 7` shows a sequential scan expecting one
 * row — which is exactly the query the whole-table rule exists to catch (planFindings),
 * and exactly the one it would miss reading the plan alone. Nothing in EXPLAIN
 * carries the table's size, so the route reads it from the catalog and passes
 * it in; a caller that cannot gets the weaker reading rather than an invented
 * one.
 */
export type TableRows = Record<string, number>;

/** One column of a table the plan reads. */
export type CatalogColumn = {
  name: string;
  /** As format_type prints it: "integer", "character varying(40)", … */
  type: string;
  notNull: boolean;
};

/** One index on a table the plan reads. */
export type CatalogIndex = {
  name: string;
  primary: boolean;
  unique: boolean;
  /**
   * False while a CREATE INDEX CONCURRENTLY is unfinished or has failed. The
   * planner does not use such an index, so it must not count as "already
   * indexed".
   */
  valid: boolean;
  /**
   * Key columns in index order. INCLUDE columns are left out, because they
   * cannot be searched on; an expression key (LOWER(email)) is null.
   */
  columns: (string | null)[];
};

/** The server settings that decide how hard the planner tries with many joins. */
export type PlannerSettings = {
  joinCollapseLimit: number;
  geqoThreshold: number;
  geqo: boolean;
};

/**
 * Everything the route reads from the target's catalog about the tables in
 * one plan. Every part is optional to readPlan: a rule that needs a missing
 * part falls back to the plan's own numbers, or stays quiet.
 */
export type PlanCatalog = {
  /** Rows per table, keyed "schema.table". */
  tableRows: TableRows;
  /** Columns per table, keyed "schema.table", in table order. */
  columns: Record<string, CatalogColumn[]>;
  /** Indexes per table, keyed "schema.table". */
  indexes: Record<string, CatalogIndex[]>;
  /**
   * Every relation name (tables, indexes, views, sequences, …) in each schema
   * the plan touches, keyed by schema. A new index needs a name nothing else
   * in the schema already has.
   */
  relationNames: Record<string, string[]>;
  /** The planner's join settings, or null when they could not be read. */
  settings: PlannerSettings | null;
};

/**
 * The catalog query results, row for row, as node-pg returns them.
 *
 * Column names match the SELECTs in app/api/performance/analyze/route.ts.
 * bigint arrives as a string (node-pg keeps values past 2^53 intact that way),
 * and current_setting always returns text, which is why the types below are
 * looser than PlanCatalog's.
 */
export type CatalogRows = {
  sizes: { schema_name: string; table_name: string; row_count: string | number }[];
  columns: {
    schema_name: string;
    table_name: string;
    column_name: string;
    data_type: string;
    not_null: boolean;
  }[];
  indexes: {
    schema_name: string;
    table_name: string;
    index_name: string;
    is_primary: boolean;
    is_unique: boolean;
    is_valid: boolean;
    columns: unknown;
  }[];
  relationNames: { schema_name: string; relname: string }[];
  settings: { join_collapse_limit: string; geqo_threshold: string; geqo: string } | null;
};

/**
 * Turn the catalog query results into the lookup maps readPlan uses.
 *
 * Pure, so the conversions (bigint strings, "on"/"off", an unanalysed table's
 * size) are tested without a server. Any part may be missing, because the
 * route stops reading at the first failure and keeps what it already has.
 */
export function catalogFromRows(rows: Partial<CatalogRows>): PlanCatalog {
  const catalog: PlanCatalog = {
    tableRows: {},
    columns: {},
    indexes: {},
    relationNames: {},
    settings: null,
  };

  for (const row of rows.sizes ?? []) {
    // reltuples is -1 until a table has been analysed, and the query's
    // GREATEST has already turned that into 0 — which means "unknown", and
    // falls through to the plan's own number rather than claiming the table is
    // empty.
    const count = Number(row.row_count);
    if (Number.isFinite(count) && count > 0) {
      catalog.tableRows[`${row.schema_name}.${row.table_name}`] = count;
    }
  }

  for (const row of rows.columns ?? []) {
    const key = `${row.schema_name}.${row.table_name}`;
    (catalog.columns[key] ??= []).push({
      name: row.column_name,
      type: row.data_type,
      notNull: Boolean(row.not_null),
    });
  }

  for (const row of rows.indexes ?? []) {
    const key = `${row.schema_name}.${row.table_name}`;
    const columns = Array.isArray(row.columns)
      ? row.columns.map((c) => (typeof c === "string" ? c : null))
      : [];
    (catalog.indexes[key] ??= []).push({
      name: row.index_name,
      primary: Boolean(row.is_primary),
      unique: Boolean(row.is_unique),
      valid: Boolean(row.is_valid),
      columns,
    });
  }

  for (const row of rows.relationNames ?? []) {
    (catalog.relationNames[row.schema_name] ??= []).push(row.relname);
  }

  if (rows.settings) {
    const joinCollapseLimit = Number(rows.settings.join_collapse_limit);
    const geqoThreshold = Number(rows.settings.geqo_threshold);
    if (Number.isFinite(joinCollapseLimit) && Number.isFinite(geqoThreshold)) {
      catalog.settings = {
        joinCollapseLimit,
        geqoThreshold,
        geqo: rows.settings.geqo === "on",
      };
    }
  }

  return catalog;
}

/**
 * The tables a plan reads, as two parallel lists: schemas[i] holds names[i].
 *
 * Two lists rather than one list of pairs because that is what the route's
 * catalog queries take — `unnest($1::text[], $2::text[])` pairs them back up
 * on the server, and the names never become part of the SQL text. Each table
 * appears once, however many steps read it.
 */
export function planRelations(steps: PlanStep[]): { schemas: string[]; names: string[] } {
  const seen = new Set<string>();
  const schemas: string[] = [];
  const names: string[] = [];
  for (const step of steps) {
    if (step.relation === null || step.relationSchema === null) continue;
    const key = `${step.relationSchema}.${step.relation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    schemas.push(step.relationSchema);
    names.push(step.relation);
  }
  return { schemas, names };
}
