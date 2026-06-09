import { NextRequest, NextResponse } from "next/server";
import pool from "@/lib/version-db";
import { buildPgConfig } from "@/lib/connection-config";
import { fetchSchemaSnapshot, type SchemaSnapshot } from "@/lib/postgres";
import { compareSchemas } from "@/lib/compare";
import { summarizeStructuralSeverity } from "@/lib/version-detection";
import {
  ensureLineageTables,
  getNextLineageVersion,
  buildDriftSummary,
} from "@/lib/lineage-db";

/**
 * POST /api/lineage/rebaseline  { trackedSchemaId }
 *
 * Accept the live database as the new expected snapshot. We capture the live
 * structure, record it as the next lineage entry (seq + 1, version bumped by the
 * change level we infer against the previous HEAD), and write an in-sync drift
 * event. After this the schema is "in sync" again and its timeline gains a node.
 *
 * This is honest about what it stores: the new entry has no migration SQL of its
 * own — it was captured from the live DB, exactly like the original baseline.
 */
export async function POST(request: NextRequest) {
  await ensureLineageTables();

  let body: { trackedSchemaId?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON in request body." }, { status: 400 });
  }

  const trackedSchemaId = Number(body.trackedSchemaId);
  if (!trackedSchemaId) {
    return NextResponse.json({ error: "trackedSchemaId is required." }, { status: 400 });
  }

  // ── 1. Load the tracked schema + connection (LEFT JOIN: may be removed) ────
  let tracked: {
    schema_name: string;
    connection_name: string | null;
    host: string | null;
    port: number | null;
    database_name: string | null;
    type: string | null;
    username: string | null;
    password: string | null;
    connection_string: string | null;
    ssl: boolean | null;
  };
  try {
    const result = await pool.query(
      `SELECT
         ts.schema_name,
         c.name AS connection_name, c.host, c.port, c.database_name, c.type,
         c.username, c.password, c.connection_string, c.ssl
       FROM tracked_schemas ts
       LEFT JOIN connections c ON c.id = ts.connection_id
       WHERE ts.id = $1`,
      [trackedSchemaId]
    );
    if (result.rows.length === 0) {
      return NextResponse.json({ error: "Tracked schema not found." }, { status: 404 });
    }
    tracked = result.rows[0];
  } catch (error) {
    console.error("Rebaseline — failed to load tracked schema:", error);
    return NextResponse.json({ error: "Could not read tracking metadata." }, { status: 500 });
  }

  if (!tracked.connection_name || tracked.type !== "PostgreSQL") {
    return NextResponse.json(
      {
        error: tracked.connection_name
          ? "Only PostgreSQL connections can be re-baselined."
          : "The connection for this tracked schema has been removed — re-baseline isn't possible.",
      },
      { status: 409 }
    );
  }

  // ── 2. Capture the live structure (the new expected snapshot) ──────────────
  const cfg = buildPgConfig({
    host: tracked.host,
    port: tracked.port,
    database: tracked.database_name,
    user: tracked.username,
    password: tracked.password,
    connectionString: tracked.connection_string,
    ssl: Boolean(tracked.ssl),
  });

  const live = await fetchSchemaSnapshot(cfg, tracked.schema_name);
  if (!live.ok) {
    return NextResponse.json(
      {
        error: `Could not read live schema "${tracked.schema_name}" on "${tracked.connection_name}": ${live.error}`,
      },
      { status: 502 }
    );
  }

  // ── 3. Current HEAD (for the next seq/version + change-level classification) ─
  let headVersion: string | null = null;
  let headSeq = 0;
  let headSnapshot: SchemaSnapshot | null = null;
  try {
    const head = await pool.query<{ version: string; seq: number; snapshot: SchemaSnapshot | null }>(
      `SELECT lm.version, lm.seq, s.snapshot
       FROM lineage_migrations lm
       LEFT JOIN snapshots s ON s.id = lm.snapshot_id
       WHERE lm.tracked_schema_id = $1
       ORDER BY lm.seq DESC
       LIMIT 1`,
      [trackedSchemaId]
    );
    if (head.rows.length > 0) {
      headVersion = head.rows[0].version;
      headSeq = head.rows[0].seq;
      headSnapshot = head.rows[0].snapshot;
    }
  } catch (error) {
    console.error("Rebaseline — failed to read lineage HEAD:", error);
  }

  // Infer the bump from how the live structure differs from the previous HEAD.
  const changeLevel = headSnapshot
    ? summarizeStructuralSeverity(compareSchemas(headSnapshot, live.data)).level
    : "additive";
  const nextSeq = headSeq + 1;
  const nextVersion = getNextLineageVersion(headVersion, changeLevel);
  const tableCount = live.data.tables.length;

  // ── 4. Write snapshot + lineage entry + in-sync drift event (one txn) ──────
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const snapResult = await client.query<{ id: number }>(
      `INSERT INTO snapshots (tracked_schema_id, snapshot, table_count, label)
       VALUES ($1, $2::jsonb, $3, 'rebaseline')
       RETURNING id`,
      [trackedSchemaId, JSON.stringify(live.data), tableCount]
    );
    const snapshotId = snapResult.rows[0].id;

    await client.query(
      `INSERT INTO lineage_migrations
         (tracked_schema_id, seq, name, change_level, version, sql_ref, snapshot_id)
       VALUES ($1, $2, 'Re-baseline (captured from live)', $3, $4, NULL, $5)`,
      [trackedSchemaId, nextSeq, changeLevel, nextVersion, snapshotId]
    );

    const counts = { tablesAdded: 0, tablesRemoved: 0, tablesChanged: 0, constraintsChanged: 0 };
    await client.query(
      `INSERT INTO drift_events (tracked_schema_id, status, summary, detail, baseline_snapshot_id)
       VALUES ($1, 'in_sync', $2, $3::jsonb, $4)`,
      [
        trackedSchemaId,
        `Re-baselined to live — ${buildDriftSummary(nextVersion, counts)}`,
        JSON.stringify(counts),
        snapshotId,
      ]
    );

    await client.query("COMMIT");

    return NextResponse.json({
      success: true,
      trackedSchemaId,
      snapshotId,
      seq: nextSeq,
      version: nextVersion,
      changeLevel,
      tableCount,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Rebaseline — failed to write lineage:", error);
    return NextResponse.json(
      { error: "Failed to re-baseline this schema." },
      { status: 500 }
    );
  } finally {
    client.release();
  }
}
