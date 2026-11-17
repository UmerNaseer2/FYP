/**
 * Views and materialized views: the catalog query, and the steps that build
 * and sort the ViewSnapshot list. Their indexes and triggers are added by
 * catalog/indexes-triggers.ts.
 */
import type { PoolClient } from "pg";
import { coerceTextArray } from "../helpers";
import { normalizeDefinition, stripSchemaFromExpr } from "../normalize";
import type { ViewSnapshot } from "../types";

export type ViewRow = {
  name: string;
  kind: "v" | "m";
  definition: string | null;
  columns: string[] | null;
  depends_on: string[] | null;
  options: string[] | null;
};

export async function readViews(client: PoolClient, schemaName: string): Promise<ViewRow[]> {
  // relkind 'v' = view, 'm' = materialized view. The table query
  // (catalog/tables.ts) reads relkind 'r' and 'p' only, which is what keeps
  // both out of the tables.
  const result = await client.query<ViewRow>(
      `SELECT
         c.relname AS name,
         c.relkind AS kind,
         pg_get_viewdef(c.oid, true) AS definition,
         c.reloptions AS options,
         (SELECT array_agg(a.attname ORDER BY a.attnum)
            FROM pg_attribute a
           WHERE a.attrelid = c.oid
             AND a.attnum > 0
             AND NOT a.attisdropped) AS columns,
         (SELECT array_agg(DISTINCT src.relname)
            FROM pg_rewrite rw
            JOIN pg_depend dp
              ON dp.objid = rw.oid
             AND dp.classid = 'pg_rewrite'::regclass
             AND dp.refclassid = 'pg_class'::regclass
             AND dp.refobjid <> c.oid
            JOIN pg_class src
              ON src.oid = dp.refobjid
             AND src.relnamespace = c.relnamespace
           WHERE rw.ev_class = c.oid) AS depends_on
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1
         AND c.relkind IN ('v', 'm')
       ORDER BY c.relname`,
      [schemaName]
  );
  return result.rows;
}

/** One ViewSnapshot per view, with empty index and trigger lists to fill. */
export function buildViews(rows: ViewRow[], schemaName: string): ViewSnapshot[] {
  return rows.map((row) => {
    const raw = row.definition ?? "";
    const definition = stripSchemaFromExpr(raw, schemaName) ?? raw;
    return {
      name: row.name,
      materialized: row.kind === "m",
      definition,
      normalizedDefinition: normalizeDefinition(definition),
      columns: coerceTextArray(row.columns),
      dependsOn: coerceTextArray(row.depends_on).sort(),
      options: coerceTextArray(row.options).sort(),
      indexes: [],
      triggers: [],
    };
  });
}

/** Puts each view's indexes and triggers into their fixed order. */
export function sortViewContents(views: ViewSnapshot[]): void {
  for (const view of views) {
    view.indexes?.sort((a, b) => a.name.localeCompare(b.name));
    view.triggers?.sort((a, b) => a.name.localeCompare(b.name));
  }
}
