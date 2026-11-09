/**
 * What a linked desktop reads to keep its copies of the website's connections
 * (docs/two-way-sync-plan.md). The routes are app/api/agent/sync and
 * app/api/agent/sync/connections; this is the part with the database in it.
 */
import { createHash } from "node:crypto";
import pool, { syncMetadataTables } from "@/lib/version-db";
import type { Principal } from "@/lib/auth-guard";
import { decryptSecret } from "@/lib/secret-store";
import { isLocalMarker, markerWithoutKey } from "@/lib/local-secrets";
import { hasPermission } from "@/lib/permissions";
import { listOwnDrift } from "@/lib/drift-sync";
import type { WebsiteDriftSchema } from "@/lib/agent-rules";
import { siteRoleOf, type SiteRole } from "@/lib/site-role";

/** The permissions that let someone see the Connections list, the same as GET /api/connections. */
export function maySeeConnections(principal: Principal): boolean {
  return hasPermission(
    principal,
    "connections:read",
    "dashboard:read",
    "scripts:read",
    "deploy:read",
    "version_sync:read",
    "performance:read",
    "visualizer:read"
  );
}

/**
 * A desktop keeps its copies in a database its person can open, so a
 * connection's secrets go to it only when that person could change the
 * connection anyway. Everyone else gets the copy without them.
 */
export function mayHoldSecrets(principal: Principal): boolean {
  return hasPermission(principal, "connections:update");
}

export type SyncedConnection = {
  id: number;
  name: string;
  host: string;
  port: number;
  database_name: string;
  type: string;
  username: string;
  /** Plain text, and only when mayHoldSecrets; otherwise "". */
  password: string;
  connection_string: string;
  has_password: boolean;
  ssl_mode: string;
  environment: string;
  application_table: string | null;
  execute_role: string;
  version: number;
  updated_at: string | null;
  updated_by: string | null;
};

/**
 * `role` is the person's role on the website, which the desktop works within
 * while it is linked (lib/site-role.ts, docs/two-way-sync-plan.md step 3).
 */
export type SyncAnswer =
  | { same: true; rev: string }
  | { same: false; rev: string; withSecrets: boolean; connections: SyncedConnection[]; role: SiteRole };

/** A short mark of a role, so that a change to it counts as a change to the answer. */
function roleMark(role: SiteRole): string {
  const print = JSON.stringify([role.role, role.label, [...role.permissions].sort()]);
  return createHash("md5").update(print).digest("hex").slice(0, 8);
}

/**
 * The organization's connections for a linked desktop, or `same` when nothing
 * changed since `knownRev`. The fingerprint covers every id and version,
 * whether secrets are included, and the person's role, so a role change also
 * counts as a change and reaches the desktop at its next sync. Costs one small
 * query when nothing moved.
 */
export async function readSync(principal: Principal, knownRev: string | null): Promise<SyncAnswer> {
  await syncMetadataTables();
  const allowed = maySeeConnections(principal);
  const withSecrets = allowed && mayHoldSecrets(principal);
  const { rows: fingerprint } = await pool.query<{ md5: string }>(
    `SELECT md5(COALESCE(string_agg(id || ':' || version, ',' ORDER BY id), '')) AS md5
       FROM connections WHERE org_id = $1`,
    [principal.orgId]
  );
  const role = siteRoleOf(principal);
  const rev = `${allowed ? fingerprint[0].md5 : "none"}.${withSecrets ? "s" : "p"}.${roleMark(role)}`;
  if (rev === knownRev) return { same: true, rev };
  if (!allowed) return { same: false, rev, withSecrets: false, connections: [], role };

  const { rows } = await pool.query<{
    id: number;
    name: string;
    host: string;
    port: number;
    database_name: string;
    type: string;
    username: string;
    password: string | null;
    connection_string: string | null;
    ssl_mode: string;
    environment: string;
    application_table: string | null;
    execute_role: string;
    version: number;
    updated_at: Date | null;
    updated_by: string | null;
  }>(
    `SELECT id, name, host, port, database_name, type, username, password, connection_string,
            ssl_mode, environment, application_table, execute_role, version, updated_at, updated_by
       FROM connections WHERE org_id = $1 ORDER BY id`,
    [principal.orgId]
  );
  const connections = rows.map((row): SyncedConnection => {
    // A secret this server cannot read (a changed APP_ENCRYPTION_KEY) goes as
    // none, the same as for someone not allowed it, rather than as ciphertext.
    let password = "";
    let connectionString = "";
    // A connection whose password is kept on one machine goes as its marker,
    // minus the key that finds the password: the desktop shows where it lives
    // and says so when someone tries to use it there.
    if (isLocalMarker(row.password)) {
      password = markerWithoutKey(row.password);
    } else if (withSecrets) {
      try {
        password = decryptSecret(row.password) ?? "";
        connectionString = decryptSecret(row.connection_string) ?? "";
      } catch {
        password = "";
        connectionString = "";
      }
    }
    return {
      id: row.id,
      name: row.name,
      host: row.host,
      port: Number(row.port),
      database_name: row.database_name,
      type: row.type,
      username: row.username,
      password,
      connection_string: connectionString,
      has_password: Boolean(row.password) || Boolean(row.connection_string),
      ssl_mode: row.ssl_mode,
      environment: row.environment,
      application_table: row.application_table,
      execute_role: row.execute_role,
      version: Number(row.version),
      updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      updated_by: row.updated_by,
    };
  });
  return { same: false, rev, withSecrets, connections, role };
}

/** The permissions that let someone see the Drift page, the same as GET /api/lineage. */
export function maySeeDrift(principal: Principal): boolean {
  return hasPermission(principal, "drift:read", "dashboard:read");
}

export type DriftSyncAnswer =
  | { same: true; rev: string }
  | { same: false; rev: string; allowed: boolean; orgSlug: string; schemas: WebsiteDriftSchema[] };

/**
 * The drift results of every schema the website watches, for a linked desktop
 * to show next to its own (docs/two-way-sync-plan.md, step 2), or `same` when
 * nothing changed since `knownRev`. Someone who may not see the Drift page
 * gets an empty list and `allowed: false`.
 */
export async function readDriftSync(principal: Principal, knownRev: string | null): Promise<DriftSyncAnswer> {
  const allowed = maySeeDrift(principal);
  const schemas = allowed ? await listOwnDrift(principal.orgId) : [];
  const rev = createHash("md5").update(JSON.stringify([principal.orgSlug, allowed, schemas])).digest("hex");
  if (rev === knownRev) return { same: true, rev };
  return { same: false, rev, allowed, orgSlug: principal.orgSlug, schemas };
}

/** A fingerprint as a desktop sent it back, or null. Never longer than one of ours. */
export function readRev(value: string | null): string | null {
  if (!value || value.length > 50 || !/^[a-z0-9.]+$/.test(value)) return null;
  return value;
}

/** For tests: the fingerprint of a list and a role, the way readSync makes it. */
export function revOf(list: { id: number; version: number }[], withSecrets: boolean, role: SiteRole): string {
  const joined = [...list]
    .sort((a, b) => a.id - b.id)
    .map((row) => `${row.id}:${row.version}`)
    .join(",");
  return `${createHash("md5").update(joined).digest("hex")}.${withSecrets ? "s" : "p"}.${roleMark(role)}`;
}
