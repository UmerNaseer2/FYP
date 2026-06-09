import { NextRequest, NextResponse } from "next/server";
import pool from "@/lib/version-db";
import { buildPgConfig } from "@/lib/connection-config";
import { fetchSchemaSnapshot } from "@/lib/postgres";
import {
  ensureLineageTables,
  BASELINE_VERSION,
  type TrackedSchemaRow,
} from "@/lib/lineage-db";

/**
 * POST /api/lineage/track
 *
 * Start tracking a schema. We capture a baseline snapshot of its live structure
 * and record it as lineage seq 1 (version 1.0.0). Body:
 *   { connectionId: number, schemaName: string, label?: string }
 */
export async function POST(request: NextRequest) {
  await ensureLineageTables();

  // ── 1. Parse + validate the body ──────────────────────────────────────────
  let body: { connectionId?: number; schemaName?: string; label?: string };
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
  };
  try {
    const result = await pool.query(
      `SELECT name, host, port, database_name, type, username, password, connection_string, ssl
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
    const trackedResult = await client.query<TrackedSchemaRow>(
      `INSERT INTO tracked_schemas (connection_id, schema_name, label)
       VALUES ($1, $2, $3)
       ON CONFLICT (connection_id, schema_name) DO NOTHING
       RETURNING id, connection_id, schema_name, label, created_at`,
      [connectionId, schemaName, label]
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
