// The session settings a deploy or a rollback runs its scripts under, and the
// one function that puts them in place. Used by app/api/scripts/apply and
// app/api/scripts/revert.
//
// Why this is its own function: the routes run every script of a request in
// ONE transaction, and a script may change a setting itself. A plain
// `SET search_path TO public` inside a transaction replaces the route's
// `SET LOCAL` for the REST of that transaction, so the next script of the same
// run would resolve its unqualified names in the wrong schema (checked on
// PostgreSQL 18: the next script's DROP TABLE landed in public). A later
// SET LOCAL wins again, so the routes call this before every script and each
// one starts from the same settings.

import type { PoolClient } from "pg";
import { readStringsTheStandardWay } from "@/lib/script-transaction";

export type RunSettings = {
  /** Double-quoted schema names, target schema first: see runSearchPath. */
  searchPath: string;
  /** How long a statement waits for a lock before giving up. */
  lockTimeoutMs: number;
  /** The longest one statement may take, or null for no limit (a real run). */
  statementTimeoutMs: number | null;
};

// Safely quote a PostgreSQL identifier (the same rule the routes use).
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Put the run's settings in place. Must be called inside the run's
 * transaction: every line is a SET LOCAL, so nothing outlives it.
 */
export async function applyRunSettings(client: PoolClient, settings: RunSettings): Promise<void> {
  // A script's own SET ROLE would otherwise carry into the next script.
  await client.query("RESET ROLE");
  await client.query(`SET LOCAL lock_timeout = ${settings.lockTimeoutMs}`);
  if (settings.statementTimeoutMs !== null) {
    await client.query(`SET LOCAL statement_timeout = ${settings.statementTimeoutMs}`);
  }
  await client.query(`SET LOCAL search_path TO ${settings.searchPath}`);
  // What pg_dump does before it restores anything. With the check on,
  // CREATE FUNCTION reads the body straight away, so a function written
  // before the column or table it uses fails ("column qty does not exist")
  // although the finished script is correct. The body is still checked the
  // first time the function is called.
  await client.query("SET LOCAL check_function_bodies = off");
  await readStringsTheStandardWay(client);
}

/**
 * The search_path for a run: the target schema, then every schema that holds
 * nothing but installed extensions.
 *
 * The target schema alone is not enough when a script uses an extension type
 * such as citext, or an index class such as gin_trgm_ops, without a schema
 * name, and the extension lives somewhere else (Supabase keeps them in a
 * schema called "extensions"). The run then failed with: type "citext" does
 * not exist.
 *
 * A schema that also holds the user's own tables, views, functions or types is
 * NOT added, even when an extension is installed in it (often "public"). With
 * it on the path, an unqualified DROP or ALTER of something the target schema
 * does not have would fall through and hit that schema's object of the same
 * name. A script for such a database has to write the schema name itself, for
 * example public.citext.
 */
export async function runSearchPath(client: PoolClient, schemaName: string): Promise<string> {
  // "Part of an extension" is a pg_depend row of type 'e'. Indexes and TOAST
  // tables follow their table, and a table's row type and every array type
  // follow their own type, so those are left out of the "anything else?" check.
  const result = await client.query<{ nspname: string }>(
    `SELECT n.nspname
       FROM pg_namespace n
      WHERE n.oid IN (SELECT extnamespace FROM pg_extension)
        AND n.nspname <> 'pg_catalog'
        AND n.nspname <> $1
        AND NOT EXISTS (
              SELECT 1 FROM pg_class c
               WHERE c.relnamespace = n.oid
                 AND c.relkind NOT IN ('i', 'I', 't', 'c')
                 AND NOT EXISTS (SELECT 1 FROM pg_depend d
                                  WHERE d.classid = 'pg_class'::regclass
                                    AND d.objid = c.oid AND d.deptype = 'e'))
        AND NOT EXISTS (
              SELECT 1 FROM pg_proc p
               WHERE p.pronamespace = n.oid
                 AND NOT EXISTS (SELECT 1 FROM pg_depend d
                                  WHERE d.classid = 'pg_proc'::regclass
                                    AND d.objid = p.oid AND d.deptype = 'e'))
        AND NOT EXISTS (
              SELECT 1 FROM pg_type t
               WHERE t.typnamespace = n.oid
                 AND t.typcategory <> 'A'
                 AND (t.typrelid = 0 OR EXISTS (SELECT 1 FROM pg_class c
                                                 WHERE c.oid = t.typrelid AND c.relkind = 'c'))
                 AND NOT EXISTS (SELECT 1 FROM pg_depend d
                                  WHERE d.classid = 'pg_type'::regclass
                                    AND d.objid = t.oid AND d.deptype = 'e'))
      ORDER BY n.nspname`,
    [schemaName]
  );
  const schemas = [schemaName, ...result.rows.map((row) => row.nspname)];
  return schemas.map(quoteIdent).join(", ");
}
