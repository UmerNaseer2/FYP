/**
 * The desktop app's side of the two-way sync (docs/two-way-sync-plan.md): how
 * the copies of the linked website's connections are kept in this server's
 * database, and how the computer's own connections are read for the link.
 *
 * Only the desktop app's main process calls this, through
 * app/api/desktop/sync. That route answers nothing anywhere else: on a website
 * there is no desktop to sync with, and the token it checks only exists on a
 * desktop (the main process makes a new one at every start and hands it to the
 * server along with its other secrets). The app's windows never hold that
 * token, so a page cannot rewrite the copies either.
 *
 * A copy is an ordinary row of `connections` with `site_id` set to the
 * website's number for it. The Connections routes refuse to change or delete
 * one (lib/connection-writes.ts), so the only way a copy changes is the
 * website changing it.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import pool, { syncMetadataTables } from "@/lib/version-db";
import { checkConnectionTarget } from "@/lib/connection-config";
import { toSslMode, sslModeUsesTls } from "@/lib/connection-validate";
import { toEnvironment } from "@/lib/environments";
import { toExecuteRole } from "@/lib/connection-access";
import { decryptSecret, encryptSecret } from "@/lib/secret-store";
import { listOwnDrift } from "@/lib/drift-sync";
import type { SyncedDriftSchema } from "@/lib/agent-rules";

/** The header the main process puts its token in. */
export const SYNC_HEADER = "x-schema-studio-sync";

/** More than any organization has; a longer list is turned away whole. */
export const MOST_SYNCED = 2000;

/**
 * True only on a desktop, and only for the main process's own token. Compared
 * as hashes so that the comparison takes the same time whatever was sent.
 */
export function syncTokenMatches(given: string | null): boolean {
  if (process.env.SCHEMA_STUDIO_DESKTOP !== "1") return false;
  const expected = process.env.SCHEMA_STUDIO_SYNC_TOKEN ?? "";
  if (expected.length < 32 || !given) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** One of the website's connections, as the main process passes it on from GET /api/agent/sync. */
export type SiteCopy = {
  id: number;
  name: string;
  host: string;
  port: number;
  database_name: string;
  type: string;
  username: string;
  password: string;
  connection_string: string;
  ssl_mode: string;
  environment: string;
  application_table: string | null;
  execute_role: string;
  version: number;
  updated_at: string | null;
  updated_by: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, most: number): string | null {
  return typeof value === "string" && value.length <= most ? value : null;
}

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** One copy, or null when it is not shaped like one. Values the server keeps a fixed list of fall back to their defaults. */
export function readSiteCopy(value: unknown): SiteCopy | null {
  if (!isRecord(value)) return null;
  const id = positive(value.id);
  const version = positive(value.version);
  const port = positive(value.port);
  const name = text(value.name, 200);
  const host = text(value.host, 500);
  const database = text(value.database_name, 200);
  const type = text(value.type, 50);
  const username = text(value.username, 200);
  const password = text(value.password, 2000);
  const connectionString = text(value.connection_string, 4000);
  const table = value.application_table === null ? null : text(value.application_table, 200);
  const updatedAt = value.updated_at === null || value.updated_at === undefined ? null : text(value.updated_at, 40);
  const updatedBy = value.updated_by === null || value.updated_by === undefined ? null : text(value.updated_by, 200);
  if (
    id === null ||
    version === null ||
    port === null ||
    port > 65535 ||
    name === null ||
    name.trim() === "" ||
    host === null ||
    database === null ||
    type === null ||
    username === null ||
    password === null ||
    connectionString === null ||
    (value.application_table !== null && table === null)
  ) {
    return null;
  }
  return {
    id,
    name,
    host,
    port,
    database_name: database,
    type,
    username,
    password,
    connection_string: connectionString,
    ssl_mode: toSslMode(value.ssl_mode),
    environment: toEnvironment(value.environment),
    application_table: table,
    execute_role: toExecuteRole(value.execute_role),
    version,
    updated_at: updatedAt !== null && !Number.isNaN(Date.parse(updatedAt)) ? updatedAt : null,
    updated_by: updatedBy,
  };
}

/**
 * Makes this computer's copies match the website's list: each one in the list
 * is written over (or added), and every copy not in it is deleted. The
 * computer's own connections are never touched.
 *
 * A copy whose address this server would refuse to dial is left out, as if
 * the website had not sent it. The website checked it too, so this only
 * matters for a website that is not Schema Studio as this computer knows it.
 */
export async function applySiteCopies(orgId: number, list: SiteCopy[]): Promise<{ kept: number; skipped: number }> {
  await syncMetadataTables();
  let skipped = 0;
  const kept: number[] = [];
  for (const copy of list) {
    const target = checkConnectionTarget({
      host: copy.host,
      port: copy.port,
      database: copy.database_name,
      user: copy.username,
      password: copy.password,
      connectionString: copy.connection_string,
      sslMode: toSslMode(copy.ssl_mode),
    });
    if (!target.ok) {
      skipped += 1;
      continue;
    }
    const values = [
      copy.name,
      copy.host,
      copy.port,
      copy.database_name,
      copy.type,
      copy.username,
      encryptSecret(copy.password) ?? "",
      encryptSecret(copy.connection_string) || null,
      sslModeUsesTls(toSslMode(copy.ssl_mode)),
      copy.ssl_mode,
      copy.environment,
      copy.application_table,
      copy.execute_role,
      copy.version,
      copy.updated_at,
      copy.updated_by,
      copy.id,
      orgId,
    ];
    const updated = await pool.query(
      `UPDATE connections SET
         name = $1, host = $2, port = $3, database_name = $4, type = $5, username = $6,
         password = $7, connection_string = $8, ssl = $9, ssl_mode = $10, environment = $11,
         application_table = $12, execute_role = $13, version = $14, site_version = $14,
         updated_at = $15, updated_by = $16
       WHERE site_id = $17 AND org_id = $18`,
      values
    );
    if (!updated.rowCount) {
      await pool.query(
        `INSERT INTO connections
           (name, host, port, database_name, type, username, password, connection_string,
            ssl, ssl_mode, environment, application_table, execute_role, version, site_version,
            updated_at, updated_by, site_id, org_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,$15,$16,$17,$18)`,
        values
      );
    }
    kept.push(copy.id);
  }
  await pool.query(
    `DELETE FROM connections WHERE org_id = $1 AND site_id IS NOT NULL AND NOT (site_id = ANY($2::int[]))`,
    [orgId, kept]
  );
  return { kept: kept.length, skipped };
}

export type OwnConnection = { id: number; name: string; environment: string; drift?: SyncedDriftSchema[] };

/**
 * This computer's own connections: what the website lists as "On <computer>".
 * Names and environments only, and the drift results of the schemas watched on
 * each, so their owner sees those on the website too.
 */
export async function listOwnConnections(orgId: number): Promise<OwnConnection[]> {
  await syncMetadataTables();
  const { rows } = await pool.query<{ id: number; name: string; environment: string }>(
    `SELECT id, name, environment FROM connections WHERE org_id = $1 AND site_id IS NULL ORDER BY id`,
    [orgId]
  );
  // The results are extra. A list without them still keeps the website's list of this computer's connections right.
  let byConnection: Map<number, SyncedDriftSchema[]> | null = new Map();
  try {
    for (const found of await listOwnDrift(orgId)) {
      const schema: SyncedDriftSchema = {
        schema: found.schema,
        label: found.label,
        intervalMinutes: found.intervalMinutes,
        lastCheckedAt: found.lastCheckedAt,
        checks: found.checks,
      };
      const list = byConnection.get(found.connectionId);
      if (list) list.push(schema);
      else byConnection.set(found.connectionId, [schema]);
    }
  } catch (error) {
    console.warn("Could not read this computer's drift results:", error instanceof Error ? error.name : "unknown error");
    byConnection = null;
  }
  return rows.map((row) => {
    const id = Number(row.id);
    const own: OwnConnection = { id, name: row.name, environment: toEnvironment(row.environment) };
    if (byConnection !== null) own.drift = byConnection.get(id) ?? [];
    return own;
  });
}

/**
 * One of this computer's own connections, secrets included, for "Send to
 * website". The main process sends it straight to the website, which tests
 * it before it keeps it. Null for a copy or a missing row.
 */
export async function exportOwnConnection(orgId: number, id: number): Promise<Record<string, unknown> | null> {
  await syncMetadataTables();
  const { rows } = await pool.query<{
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
  }>(
    `SELECT name, host, port, database_name, type, username, password, connection_string,
            ssl_mode, environment, application_table, execute_role
       FROM connections WHERE id = $1 AND org_id = $2 AND site_id IS NULL`,
    [id, orgId]
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    name: row.name,
    host: row.host,
    port: Number(row.port),
    database_name: row.database_name,
    type: row.type,
    username: row.username,
    password: decryptSecret(row.password) ?? "",
    connection_string: decryptSecret(row.connection_string) ?? "",
    ssl_mode: row.ssl_mode,
    environment: row.environment,
    application_table: row.application_table,
    execute_role: row.execute_role,
  };
}

/**
 * Turns one of this computer's own connections into the copy of the website
 * connection it was just sent up as. The row keeps its number here, so the
 * drift history and saved comparisons that point at it keep working. A copy
 * of the same website connection that a sync added in the meantime is
 * dropped, so there is only one.
 */
export async function adoptOwnConnection(orgId: number, id: number, siteId: number, siteVersion: number): Promise<boolean> {
  await syncMetadataTables();
  await pool.query(`DELETE FROM connections WHERE org_id = $1 AND site_id = $2 AND id <> $3`, [orgId, siteId, id]);
  const { rowCount } = await pool.query(
    `UPDATE connections SET site_id = $3, site_version = $4, version = $4
      WHERE id = $1 AND org_id = $2 AND site_id IS NULL`,
    [id, orgId, siteId, siteVersion]
  );
  return Boolean(rowCount);
}
