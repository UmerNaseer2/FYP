/**
 * Extensions installed into the schema: the catalog query, and the step that
 * builds the ExtensionSnapshot list.
 */
import type { PoolClient } from "pg";
import { normalizeDefinition } from "../normalize";
import type { ExtensionSnapshot } from "../types";

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
