/**
 * Extensions installed into the schema: the catalog query, and the step that
 * builds the ExtensionSnapshot list.
 */
import type { PoolClient } from "pg";
import { normalizeDefinition } from "../normalize";
import type { ExtensionElsewhere, ExtensionSnapshot } from "../types";

export type ExtensionRow = {
  name: string;
  version: string;
};

export async function readExtensions(client: PoolClient, schemaName: string): Promise<ExtensionRow[]> {
  // No filtering beyond the namespace. Everything else in this snapshot skips
  // what an extension owns; the extension itself is the one thing that has to
  // survive, because it is what puts all of that back.
  const result = await client.query<ExtensionRow>(
      `SELECT
         e.extname AS name,
         e.extversion AS version
       FROM pg_extension e
       JOIN pg_namespace n ON n.oid = e.extnamespace
       WHERE n.nspname = $1
       ORDER BY e.extname`,
      [schemaName]
  );
  return result.rows;
}

/** One ExtensionSnapshot per extension. */
export function buildExtensions(rows: ExtensionRow[]): ExtensionSnapshot[] {
  return rows.map((row) => {
    // Worded as the tail of the statement that installs it, so the line in
    // the report and the SQL that fixes it read the same way.
    const definition = `version ${row.version}`;
    return {
      name: row.name,
      version: row.version,
      definition,
      normalizedDefinition: normalizeDefinition(definition),
    } satisfies ExtensionSnapshot;
  });
}

export type ExtensionElsewhereRow = {
  name: string;
  version: string;
  schema: string;
  used_here: boolean;
};

export async function readExtensionsElsewhere(
  client: PoolClient,
  schemaName: string
): Promise<ExtensionElsewhereRow[]> {
  // Every extension that lives in another schema, with one more answer each:
  // does anything in the compared schema depend on something the extension
  // brought (a type, a function, an operator class)? PostgreSQL records both
  // halves in pg_depend: deptype 'e' ties an object to its extension, and an
  // ordinary row ties a column, default, constraint, index, view, function or
  // type to what it uses.
  //
  // plpgsql is left out: every database has it, and CREATE EXTENSION for it
  // would only be noise.
  const result = await client.query<ExtensionElsewhereRow>(
    `SELECT
       e.extname AS name,
       e.extversion AS version,
       en.nspname AS schema,
       EXISTS (
         SELECT 1
           FROM pg_depend member
           JOIN pg_depend used
             ON used.refclassid = member.classid
            AND used.refobjid = member.objid
            AND used.deptype <> 'e'
          WHERE member.refclassid = 'pg_extension'::regclass
            AND member.refobjid = e.oid
            AND member.deptype = 'e'
            AND (
              (used.classid = 'pg_class'::regclass AND used.objid IN
                 (SELECT c.oid FROM pg_class c WHERE c.relnamespace = here.oid))
              OR (used.classid = 'pg_type'::regclass AND used.objid IN
                 (SELECT t.oid FROM pg_type t WHERE t.typnamespace = here.oid))
              OR (used.classid = 'pg_proc'::regclass AND used.objid IN
                 (SELECT p.oid FROM pg_proc p WHERE p.pronamespace = here.oid))
              OR (used.classid = 'pg_constraint'::regclass AND used.objid IN
                 (SELECT k.oid FROM pg_constraint k WHERE k.connamespace = here.oid))
              OR (used.classid = 'pg_attrdef'::regclass AND used.objid IN
                 (SELECT d.oid FROM pg_attrdef d
                    JOIN pg_class c ON c.oid = d.adrelid
                   WHERE c.relnamespace = here.oid))
              OR (used.classid = 'pg_rewrite'::regclass AND used.objid IN
                 (SELECT r.oid FROM pg_rewrite r
                    JOIN pg_class c ON c.oid = r.ev_class
                   WHERE c.relnamespace = here.oid))
            )
       ) AS used_here
     FROM pg_extension e
     JOIN pg_namespace en ON en.oid = e.extnamespace
     JOIN pg_namespace here ON here.nspname = $1
     WHERE en.nspname <> $1
       AND e.extname <> 'plpgsql'
     ORDER BY e.extname`,
    [schemaName]
  );
  return result.rows;
}

export function buildExtensionsElsewhere(rows: ExtensionElsewhereRow[]): ExtensionElsewhere[] {
  return rows.map((row) => ({
    name: row.name,
    version: row.version,
    schema: row.schema,
    usedHere: row.used_here,
  }));
}
