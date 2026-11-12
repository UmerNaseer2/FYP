/**
 * Reading the saved PostgreSQL target an AI route works on.
 *
 * The migration review (/api/scripts/review) and the script writer
 * (/api/scripts/generate) both read one saved connection of the caller's
 * organization, refuse one that is not PostgreSQL, build its pool config and
 * read the schema. That was the same 50 lines in both routes; it lives here
 * now so a fix to one is a fix to both.
 *
 * Each route still says things in its own words: it passes the message for a
 * target that is not PostgreSQL and the prefix of its log lines.
 */
import { NextResponse } from "next/server";
import type { PoolConfig } from "pg";
import pool, { syncMetadataTables } from "../version-db";
import { fetchSchemaSnapshot, type SchemaSnapshot } from "../postgres";
import { buildPgConfig } from "../connection-config";
import { credentialsMessage } from "../secret-store";

/** How long the schema capture waits for a lock on the target. */
export const SNAPSHOT_LOCK_TIMEOUT_MS = 2_000;

/** The saved connection, as the connections table holds it. */
export type PgTargetRow = {
  name: string;
  type: string;
  host: string;
  port: number;
  database_name: string;
  username: string;
  password: string;
  connection_string: string | null;
  ssl: boolean | null;
  ssl_mode: string | null;
  execute_role: string | null;
};

/** Either the target, or the response the route sends back instead. */
export type PgTarget =
  | { ok: true; row: PgTargetRow; cfg: PoolConfig }
  | { ok: false; response: NextResponse };

/**
 * Reads connection `connectionId` of organization `orgId` and builds its pool
 * config. Another organization's connection reads as missing, like a deleted
 * one. The password stays encrypted until buildPgConfig reads it, and neither
 * it nor the host is ever written to the log.
 */
export async function loadPgTarget(
  orgId: number,
  connectionId: number,
  words: { notPostgresMessage: string; logPrefix: string }
): Promise<PgTarget> {
  let row: PgTargetRow;
  try {
    await syncMetadataTables();
    const result = await pool.query(
      `SELECT name, type, host, port, database_name, username, password, connection_string, ssl, ssl_mode,
              execute_role
         FROM connections
        WHERE id = $1 AND org_id = $2`,
      [connectionId, orgId]
    );
    if (result.rows.length === 0) {
      return refuse(`No saved connection found with id ${connectionId}.`, 404);
    }
    row = result.rows[0];
  } catch (error) {
    console.error(`${words.logPrefix}: could not read the connection:`, error instanceof Error ? error.message : error);
    return refuse("Could not read saved connection. Is the app database reachable?", 500);
  }
  if (row.type !== "PostgreSQL") {
    return refuse(words.notPostgresMessage, 400);
  }

  try {
    const cfg = buildPgConfig({
      host: row.host,
      port: row.port,
      database: row.database_name,
      user: row.username,
      password: row.password,
      connectionString: row.connection_string,
      ssl: Boolean(row.ssl),
      sslMode: row.ssl_mode,
    });
    return { ok: true, row, cfg };
  } catch (error) {
    console.error(
      `${words.logPrefix}: could not read the connection's credentials:`,
      error instanceof Error ? error.message : error
    );
    return refuse(credentialsMessage(error), 500);
  }
}

/**
 * Reads the target's schema, waiting at most SNAPSHOT_LOCK_TIMEOUT_MS for a
 * lock. A failure is a 502: the app is fine, the target did not answer.
 */
export async function readTargetSnapshot(
  cfg: PoolConfig,
  schemaName: string
): Promise<{ ok: true; snapshot: SchemaSnapshot } | { ok: false; response: NextResponse }> {
  const captured = await fetchSchemaSnapshot(cfg, schemaName, { lockTimeoutMs: SNAPSHOT_LOCK_TIMEOUT_MS });
  if (!captured.ok) {
    return refuse(`Could not read the target's schema: ${captured.error}`, 502);
  }
  return { ok: true, snapshot: captured.data };
}

function refuse(error: string, status: number): { ok: false; response: NextResponse } {
  return { ok: false, response: NextResponse.json({ error }, { status }) };
}
