/**
 * Functions and procedures: the catalog query, and the step that builds the
 * RoutineSnapshot list.
 */
import type { PoolClient } from "pg";
import { normalizeDefinition, stripSchemaFromExpr } from "../normalize";
import type { RoutineSnapshot } from "../types";

export type RoutineRow = {
  name: string;
  kind: "function" | "procedure";
  args: string;
  arg_types: string | null;
  arg_names: string[] | null;
  definition: string;
  language: string;
  returns: string | null;
};

export async function readRoutines(client: PoolClient, schemaName: string): Promise<RoutineRow[]> {
  // prokind 'f'/'p' only: aggregates and window functions are declared, not
  // defined, and pg_get_functiondef() raises an error on them.
  const result = await client.query<RoutineRow>(
      `SELECT
         p.proname AS name,
         CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END AS kind,
         pg_get_function_identity_arguments(p.oid) AS args,
         -- The argument TYPES on their own. pg_get_function_identity_arguments
         -- above prints the names too ("a integer"), and building the identity
         -- out of that made a function whose argument was renamed look like one
         -- function added and a different one dropped — so the script created
         -- it before dropping it and PostgreSQL refused the whole migration.
         (SELECT string_agg(format_type(u.t, NULL), ', ' ORDER BY u.ord)
            FROM unnest(p.proargtypes) WITH ORDINALITY AS u(t, ord)) AS arg_types,
         -- proargnames rather than the printed argument list: it is already an
         -- array, so no parsing, and it stays clear of DEFAULT expressions —
         -- adding a default is something CREATE OR REPLACE is happy with.
         p.proargnames AS arg_names,
         pg_get_functiondef(p.oid) AS definition,
         l.lanname AS language,
         pg_get_function_result(p.oid) AS returns
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       JOIN pg_language l ON l.oid = p.prolang
       WHERE n.nspname = $1
         AND p.prokind IN ('f', 'p')
         -- 'e' is an extension's function. 'i' is one PostgreSQL made itself
         -- as part of another object: CREATE TYPE ... AS RANGE quietly adds
         -- five or six LANGUAGE internal constructors, and capturing those
         -- made the migration try to CREATE OR REPLACE them — against a type
         -- it had decided not to create — so it stopped on "type does not
         -- exist". They come back on their own with the type.
         AND NOT EXISTS (
           SELECT 1 FROM pg_depend dep
            WHERE dep.objid = p.oid
              AND dep.classid = 'pg_proc'::regclass
              AND dep.deptype IN ('e', 'i')
         )
       ORDER BY p.proname, pg_get_function_identity_arguments(p.oid)`,
      [schemaName]
  );
  return result.rows;
}

/** One RoutineSnapshot per function or procedure. */
export function buildRoutines(rows: RoutineRow[], schemaName: string): RoutineSnapshot[] {
  return rows.map((row) => {
    const definition = stripSchemaFromExpr(row.definition, schemaName) ?? row.definition;
    const identityArguments = stripSchemaFromExpr(row.args, schemaName) ?? row.args;
    // A function with no arguments has no rows to aggregate, so the subquery
    // hands back NULL rather than an empty string.
    const argumentTypes = stripSchemaFromExpr(row.arg_types ?? "", schemaName) ?? "";
    return {
      name: row.name,
      kind: row.kind === "procedure" ? "PROCEDURE" : "FUNCTION",
      identityArguments,
      // Postgres allows overloads, so the name alone is not an identity — but
      // the argument NAMES are not part of it either. Two functions cannot
      // differ by those alone, so a rename has to read as one function that
      // changed, not as two.
      signature: `${row.name}(${argumentTypes})`,
      returnType: stripSchemaFromExpr(row.returns, schemaName),
      // NULL means no argument is named at all, which is a recorded fact and
      // not a missing one — hence [] rather than undefined.
      argumentNames: row.arg_names ?? [],
      language: row.language,
      definition,
      normalizedDefinition: normalizeDefinition(definition),
    } satisfies RoutineSnapshot;
  });
}
