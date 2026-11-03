// Who may take the Production label off a target, and what counts as one.
//
// The Production label is what makes a deploy or a rollback wait for a second
// person's approval (the two-person rule in lib/approvals-db). Anyone who may
// edit a connection may change its label, so without a rule here an Editor
// could relabel a production connection "dev", run the script with no
// approval, and put the label back. Two ways round it are closed here:
//
//   1. Taking the label off (a connection's or a tracked schema's), or
//      deleting a connection that carries it, needs the permission that
//      approves production deploys. Putting the label on stays open to every
//      editor, because an over-cautious label costs nobody anything.
//   2. A second saved connection that reaches the same database as one
//      labelled Production counts as Production too, whatever its own label
//      says. Otherwise saving the same database again as "dev" would do the
//      same job as relabelling it.
import pool from "@/lib/version-db";
import { buildPgConfig, type ConnectionInput } from "@/lib/connection-config";
import { isProduction, type Environment } from "@/lib/environments";

/** The permission that may take the Production label off a target. */
export const UNLABEL_PRODUCTION_PERMISSION = "approvals:approve" as const;

/** True when a change of label goes from Production to anything else. */
export function lowersProduction(before: Environment, after: Environment): boolean {
  return isProduction(before) && !isProduction(after);
}

/**
 * The refusal for someone who may not take the label off. `what` names the
 * target the way the screen does, for example `connection "Sales"`.
 */
export function unlabelRefusal(what: string, action: "relabel" | "delete" = "relabel"): string {
  const doing =
    action === "delete" ? `delete ${what}, which is labelled Production` : `take the Production label off ${what}`;
  return (
    `Only someone who may approve production deploys (an Admin, unless your organization ` +
    `changed it) can ${doing}. The label is what makes a deploy to it wait for an approval.`
  );
}

/** The columns of a connections row this file reads. */
export type ConnectionTargetRow = {
  host?: string | null;
  port?: number | string | null;
  database_name?: string | null;
  username?: string | null;
  password?: string | null;
  connection_string?: string | null;
  ssl?: boolean | null;
  ssl_mode?: string | null;
};

/**
 * Which database a saved connection reaches, as "host:port/database", or null
 * when it cannot be told (a saved secret this server cannot read).
 *
 * The host is compared as written, in lower case. Two names for one server
 * (an IP address and a DNS name, say) are not recognised as the same; that is
 * a limit of this check, not a promise.
 */
export function configIdentity(config: {
  host?: string | null;
  port?: number | string | null;
  database?: string | null;
}): string | null {
  const host = String(config.host ?? "").trim().toLowerCase();
  const database = String(config.database ?? "").trim();
  if (!host || !database) return null;
  return `${host}:${Number(config.port) || 5432}/${database}`;
}

/** databaseIdentity for a stored row: builds its config first. */
export function databaseIdentity(row: ConnectionTargetRow): string | null {
  const input: ConnectionInput = {
    host: row.host,
    port: row.port,
    database: row.database_name,
    user: row.username,
    password: row.password,
    connectionString: row.connection_string,
    ssl: row.ssl,
    sslMode: row.ssl_mode as ConnectionInput["sslMode"],
  };
  let config: ReturnType<typeof buildPgConfig>;
  try {
    config = buildPgConfig(input);
  } catch {
    return null;
  }
  return configIdentity(config);
}

/**
 * Another saved connection in this organization that reaches the same
 * database and is labelled Production, or null when there is none.
 *
 * `identity` is the target's own, from configIdentity on the config the route
 * has already built. Asked only when the target is not already Production, so
 * a run against a production target costs no extra query.
 */
export async function findProductionTwin(
  orgId: number,
  connectionId: number,
  identity: string | null
): Promise<{ id: number; name: string } | null> {
  if (identity === null) return null;
  const result = await pool.query<ConnectionTargetRow & { id: number; name: string; environment: string }>(
    `SELECT id, name, environment, host, port, database_name, username, password,
            connection_string, ssl, ssl_mode
       FROM connections
      WHERE org_id = $1 AND id <> $2 AND environment = 'prod'`,
    [orgId, connectionId]
  );
  for (const other of result.rows ?? []) {
    // The SQL already says so; checked again so a row read some other way
    // can never count.
    if (other.environment !== "prod" || Number(other.id) === connectionId) continue;
    if (databaseIdentity(other) === identity) return { id: Number(other.id), name: String(other.name) };
  }
  return null;
}

/** The refusal when a run would reach a database another connection labels Production. */
export function twinBlockReason(twinName: string): string {
  return (
    `Another saved connection, "${twinName}", reaches the same database and is labelled ` +
    `Production, so this run counts as one against production. Label this connection ` +
    `Production too, then confirm the production warning (and get an approval if your ` +
    `organization needs one) before running it.`
  );
}
