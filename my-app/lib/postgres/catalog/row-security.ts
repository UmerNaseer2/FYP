/**
 * Row-level security: the query for each table's on/off switch, the query for
 * its policies, and the steps that record both on the table.
 */
import type { PoolClient } from "pg";
import { COMPARE_IGNORED_TABLES, coerceTextArray, quoteRole } from "../helpers";
import { normalizeDefinition, stripSchemaFromExpr } from "../normalize";
import type { TableSnapshot } from "../types";

export type RowSecurityRow = {
  table_name: string;
  enabled: boolean;
  forced: boolean;
};

export type PolicyRow = {
  table_name: string;
  name: string;
  permissive: boolean;
  command: string;
  roles: string[] | null;
  using: string | null;
  with_check: string | null;
};

/**
 * Everything after `CREATE POLICY <name> ON <table> `, in the order the grammar
 * requires: AS, FOR, TO, USING, WITH CHECK.
 */
function buildPolicyDefinition(policy: {
  permissive: boolean;
  command: string;
  roles: string[];
  using: string | null;
  withCheck: string | null;
}): string {
  const parts = [
    `AS ${policy.permissive ? "PERMISSIVE" : "RESTRICTIVE"}`,
    `FOR ${policy.command}`,
  ];
  // An empty role list should never come back from the catalog, but writing
  // `TO ` with nothing after it is a syntax error rather than a wrong answer,
  // so fall back to the value pg_policies uses for "everybody".
  parts.push(`TO ${(policy.roles.length > 0 ? policy.roles : ["public"]).map(quoteRole).join(", ")}`);
  if (policy.using !== null) parts.push(`USING (${policy.using})`);
  if (policy.withCheck !== null) parts.push(`WITH CHECK (${policy.withCheck})`);
  return parts.join(" ");
}

export async function readRowSecurity(client: PoolClient, schemaName: string): Promise<RowSecurityRow[]> {
  // Two queries for row-level security, because the switch and the rules live
  // in different places: relrowsecurity says whether policies are enforced at
  // all, pg_policy holds the policies themselves. Reading only one of them
  // gives an answer that is confidently wrong — three policies with the
  // switch off enforce nothing.
  const result = await client.query<RowSecurityRow>(
      `SELECT
         c.relname AS table_name,
         c.relrowsecurity AS enabled,
         c.relforcerowsecurity AS forced
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1
         AND c.relkind IN ('r', 'p')
         AND c.relname <> ALL($2)
       ORDER BY c.relname`,
      [schemaName, COMPARE_IGNORED_TABLES]
  );
  return result.rows;
}

export async function readPolicies(client: PoolClient, schemaName: string): Promise<PolicyRow[]> {
  // pg_policies rather than pg_policy: it already resolves role OIDs to names
  // and runs pg_get_expr for us, and being a view owned by a superuser it is
  // readable by an ordinary login role — pg_authid underneath it is not.
  const result = await client.query<PolicyRow>(
      `SELECT
         p.tablename AS table_name,
         p.policyname AS name,
         (p.permissive = 'PERMISSIVE') AS permissive,
         p.cmd AS command,
         p.roles AS roles,
         p.qual AS "using",
         p.with_check AS with_check
       FROM pg_policies p
       WHERE p.schemaname = $1
         AND p.tablename <> ALL($2)
       ORDER BY p.tablename, p.policyname`,
      [schemaName, COMPARE_IGNORED_TABLES]
  );
  return result.rows;
}

/** Records whether row-level security is on, and forced, for each table. */
export function applyRowSecurity(
  tablesByName: Map<string, TableSnapshot>,
  rows: RowSecurityRow[]
): void {
  for (const row of rows) {
    const table = tablesByName.get(row.table_name);
    if (!table?.rowSecurity) {
      continue;
    }
    table.rowSecurity.enabled = row.enabled;
    table.rowSecurity.forced = row.forced;
  }
}

/** Adds each policy to its table. */
export function addPolicies(
  tablesByName: Map<string, TableSnapshot>,
  rows: PolicyRow[],
  schemaName: string
): void {
  for (const row of rows) {
    const table = tablesByName.get(row.table_name);
    if (!table?.rowSecurity) {
      continue;
    }

    // A policy expression names tables and functions the same way a CHECK
    // does, so it carries the same own-schema qualifier that would make two
    // identical policies in two schemas read as different.
    const using = stripSchemaFromExpr(row.using, schemaName);
    const withCheck = stripSchemaFromExpr(row.with_check, schemaName);
    const roles = coerceTextArray(row.roles);
    const definition = buildPolicyDefinition({
      permissive: row.permissive,
      command: row.command,
      roles,
      using,
      withCheck,
    });

    table.rowSecurity.policies.push({
      name: row.name,
      table: row.table_name,
      permissive: row.permissive,
      command: row.command,
      roles,
      using,
      withCheck,
      definition,
      normalizedDefinition: normalizeDefinition(definition),
    });
  }
}
