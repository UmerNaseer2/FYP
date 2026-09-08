import { NextRequest, NextResponse } from "next/server";
import { requireEditor } from "@/lib/auth-guard";
import pool, { ensureConnectionsTable } from "@/lib/version-db";
import { buildPgConfig } from "@/lib/connection-config";
import { fetchSchemaSnapshot } from "@/lib/postgres";
import {
  ensureLineageTables,
  BASELINE_VERSION,
  type TrackedSchemaRow,
} from "@/lib/lineage-db";
import { ENVIRONMENTS, toEnvironment, type Environment } from "@/lib/environments";

/**
 * POST /api/lineage/track
 *
 * Start tracking a schema. We capture a baseline snapshot of its live structure
 * and record it as lineage seq 1 (version 1.0.0). Body:
 *   { connectionId: number, schemaName: string, label?: string,
 *     environment?: "unset" | "dev" | "staging" | "prod" }
 *
 * `environment` is inherited from the connection when the body leaves it out,
 * which is the normal case — the caller already picked the connection, so it
 * has already said which environment this is. It can still be overridden
 * because one server can host a staging schema and a production one.
 */
export async function POST(request: NextRequest) {
  const gate = await requireEditor();
  if (!gate.ok) return gate.response;

  await ensureLineageTables();

  // ── 1. Parse + validate the body ──────────────────────────────────────────
  let body: {
    connectionId?: number;
    schemaName?: string;
    label?: string;
    environment?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON in request body." }, { status: 400 });
  }

  const connectionId = Number(body.connectionId);
  const schemaName =
    typeof body.schemaName === "string" ? body.schemaName.trim() : "";
  const label =
    typeof body.label === "string" && body.label.trim().length > 0
      ? body.label.trim()
      : null;
  // undefined means "inherit from the connection". A value that was sent but
  // is not one of ours is refused rather than narrowed: "production" would
  // become "unset", the lowest rank, and a schema the user believes they
  // labelled live would never warn anybody. Same rule as PATCH /api/lineage.
  const rawEnvironment =
    body.environment === undefined ? null : String(body.environment).trim().toLowerCase();
  if (rawEnvironment !== null && !(ENVIRONMENTS as readonly string[]).includes(rawEnvironment)) {
    return NextResponse.json(
      { error: `Environment must be one of: ${ENVIRONMENTS.join(", ")}.` },
      { status: 400 }
    );
  }
  const environmentOverride =
    rawEnvironment === null ? null : toEnvironment(rawEnvironment);

  if (!connectionId || !schemaName) {
    return NextResponse.json(
      { error: "connectionId and schemaName are required." },
      { status: 400 }
    );
  }

  // ── 2. Look up the saved connection (same pool the UI saves them to) ───────
  let conn: {
    name: string;
    host: string;
    port: number;
    database_name: string;
    type: string;
    username: string;
    password: string;
    connection_string: string | null;
    ssl: boolean;
    ssl_mode: string | null;
    environment: string | null;
  };
  try {
    // ssl_mode and environment are both added lazily; make sure they exist
    // before selecting them.
    await ensureConnectionsTable();
    const result = await pool.query(
      `SELECT name, host, port, database_name, type, username, password, connection_string, ssl, ssl_mode, environment
       FROM connections
       WHERE id = $1`,
      [connectionId]
    );
    if (result.rows.length === 0) {
      return NextResponse.json(
        { error: `No saved connection found with id ${connectionId}.` },
        { status: 404 }
      );
    }
    conn = result.rows[0];
  } catch (error) {
    console.error("Track — failed to read connection:", error);
    return NextResponse.json(
      { error: "Could not read saved connection. Is the app database reachable?" },
      { status: 500 }
    );
  }

  if (conn.type !== "PostgreSQL") {
    return NextResponse.json(
      { error: "Only PostgreSQL connections can be tracked right now." },
      { status: 400 }
    );
  }

  // ── 3. Capture the live baseline snapshot (SSL-aware, like the rest of app) ─
  const cfg = buildPgConfig({
    host: conn.host,
    port: conn.port,
    database: conn.database_name,
    user: conn.username,
    password: conn.password,
    connectionString: conn.connection_string,
    ssl: Boolean(conn.ssl),
    sslMode: conn.ssl_mode,
  });

  const snap = await fetchSchemaSnapshot(cfg, schemaName);
  if (!snap.ok) {
    return NextResponse.json(
      {
        error:
          `Could not read schema "${schemaName}" on "${conn.name}". ` +
          `Check the connection and that the schema exists. Details: ${snap.error}`,
      },
      { status: 502 }
    );
  }

  // ── 4. Write tracked_schema + baseline snapshot + lineage 0001 (one txn) ───
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Insert the tracked schema. If it's already tracked, the UNIQUE constraint
    // makes this insert no-op and we report a clean 409 instead of crashing.
    const environment: Environment =
      environmentOverride ?? toEnvironment(conn.environment);

    const trackedResult = await client.query<TrackedSchemaRow>(
      `INSERT INTO tracked_schemas (connection_id, schema_name, label, environment)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (connection_id, schema_name) DO NOTHING
       RETURNING id, connection_id, schema_name, label, environment, created_at`,
      [connectionId, schemaName, label, environment]
    );

    if (trackedResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return NextResponse.json(
        { error: `Schema "${schemaName}" on "${conn.name}" is already tracked.` },
        { status: 409 }
      );
    }

    const tracked = trackedResult.rows[0];
    const tableCount = snap.data.tables.length;

    const snapshotResult = await client.query<{ id: number }>(
      `INSERT INTO snapshots (tracked_schema_id, snapshot, table_count, label)
       VALUES ($1, $2::jsonb, $3, 'baseline')
       RETURNING id`,
      [tracked.id, JSON.stringify(snap.data), tableCount]
    );
    const baselineSnapshotId = snapshotResult.rows[0].id;

    await client.query(
      `INSERT INTO lineage_migrations
         (tracked_schema_id, seq, name, change_level, version, sql_ref, snapshot_id)
       VALUES ($1, 1, 'Baseline snapshot', 'additive', $2, NULL, $3)`,
      [tracked.id, BASELINE_VERSION, baselineSnapshotId]
    );

    await client.query("COMMIT");

    return NextResponse.json(
      {
        trackedSchema: tracked,
        baseline: {
          snapshotId: baselineSnapshotId,
          version: BASELINE_VERSION,
          tableCount,
        },
        connectionName: conn.name,
      },
      { status: 201 }
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Track — failed to write lineage:", error);
    return NextResponse.json(
      { error: "Failed to start tracking this schema." },
      { status: 500 }
    );
  } finally {
    client.release();
  }
}
