import { NextRequest, NextResponse } from "next/server";
import { requireEditor } from "@/lib/auth-guard";
import pool, { syncMetadataTables } from "@/lib/version-db";
import { buildPgConfig } from "@/lib/connection-config";
import { UNREADABLE_CREDENTIALS_MESSAGE } from "@/lib/secret-store";
import { fetchSchemaSnapshot, type SchemaSnapshot } from "@/lib/postgres";
import { compareSchemas } from "@/lib/compare";
import { summarizeStructuralSeverity } from "@/lib/version-detection";
import {
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
  const gate = await requireEditor();
  if (!gate.ok) return gate.response;

  await syncMetadataTables();

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
    ssl_mode: string | null;
  };
  try {
    // The ssl_mode column is added lazily; make sure it exists before selecting it.
    await syncMetadataTables();
    const result = await pool.query(
      `SELECT
         ts.schema_name,
         c.name AS connection_name, c.host, c.port, c.database_name, c.type,
         c.username, c.password, c.connection_string, c.ssl, c.ssl_mode
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

  // ── 2. Note where the lineage stands BEFORE reading the schema ────────────
  // The read below talks to another server and takes as long as that server
  // takes. A deploy that finishes inside that window writes its own snapshot as
  // the new head — and this request, still holding a reading of the schema from
  // BEFORE that deploy, would then save the older picture on top of it as a
  // newer version. The next drift check compares against that older picture and
  // reports the deploy's own new table as an unexplained change, on a lineage
  // that now records a breaking major version for a re-baseline that was only
  // ever meant to agree with the database.
  //
  // The advisory lock below cannot stop this on its own. It serialises the two
  // writers, which is a different thing from noticing that one of them is
  // holding stale data: this request waits its turn, gets the lock, and writes
  // its out-of-date reading perfectly safely. So the head is noted here and
  // checked again once the lock is held, and the request gives up if it moved.
  let seqBeforeRead: number;
  try {
    const before = await pool.query<{ seq: number }>(
      `SELECT seq FROM lineage_migrations
       WHERE tracked_schema_id = $1
       ORDER BY seq DESC
       LIMIT 1`,
      [trackedSchemaId]
    );
    // 0 for a schema with no lineage yet, which is a real starting point and
    // not a missing answer — the check below is an equality either way.
    seqBeforeRead = before.rows[0]?.seq ?? 0;
  } catch (error) {
    console.error("Rebaseline — failed to read the current head:", error);
    return NextResponse.json({ error: "Could not read tracking metadata." }, { status: 500 });
  }

  // ── 3. Capture the live structure (the new expected snapshot) ──────────────
  // buildPgConfig decrypts the saved password, and throws when this server's
  // APP_ENCRYPTION_KEY is missing or is not the key it was saved with. Left
  // uncaught, that was a bare 500 instead of an error the screen can show.
  let cfg: ReturnType<typeof buildPgConfig>;
  try {
    cfg = buildPgConfig({
      host: tracked.host,
      port: tracked.port,
      database: tracked.database_name,
      user: tracked.username,
      password: tracked.password,
      connectionString: tracked.connection_string,
      ssl: Boolean(tracked.ssl),
      sslMode: tracked.ssl_mode,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Rebaseline — could not read the saved connection's credentials:", message);
    return NextResponse.json({ error: UNREADABLE_CREDENTIALS_MESSAGE }, { status: 500 });
  }

  const live = await fetchSchemaSnapshot(cfg, tracked.schema_name);
  if (!live.ok) {
    return NextResponse.json(
      {
        error: `Could not read live schema "${tracked.schema_name}" on "${tracked.connection_name}": ${live.error}`,
      },
      { status: 502 }
    );
  }

  const tableCount = live.data.tables.length;

  // ── 4. Read HEAD + write snapshot/lineage/event, all under one lock (one txn) ─
  // The HEAD read is done INSIDE the transaction after taking the same advisory
  // lock recordAppliedMigrationToLineage uses, so a rebaseline and a concurrent
  // deploy can't both read the same HEAD seq and collide on UNIQUE(tracked, seq).
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock($1)`, [trackedSchemaId]);

    const head = await client.query<{ version: string; seq: number; snapshot: SchemaSnapshot | null }>(
      `SELECT lm.version, lm.seq, s.snapshot
       FROM lineage_migrations lm
       LEFT JOIN snapshots s ON s.id = lm.snapshot_id
       WHERE lm.tracked_schema_id = $1
       ORDER BY lm.seq DESC
       LIMIT 1`,
      [trackedSchemaId]
    );
    const headVersion = head.rows[0]?.version ?? null;
    const headSeq = head.rows[0]?.seq ?? 0;
    const headSnapshot = head.rows[0]?.snapshot ?? null;

    // Somebody wrote to this lineage while the schema was being read, so the
    // reading in hand is older than the head it would be saved on top of. There
    // is nothing to merge — the only correct answer is a fresh read — so the
    // request stops here rather than recording a version that is a step
    // backwards. Its own transaction has written nothing yet.
    if (headSeq !== seqBeforeRead) {
      await client.query("ROLLBACK");
      return NextResponse.json(
        {
          error:
            "This schema changed while it was being read — a deploy or another " +
            "re-baseline finished first, so this reading is already out of date. " +
            "Nothing was saved. Try again.",
        },
        { status: 409 }
      );
    }

    // Infer the bump from how the live structure differs from the previous HEAD.
    const changeLevel = headSnapshot
      ? summarizeStructuralSeverity(compareSchemas(headSnapshot, live.data)).level
      : "additive";
    const nextSeq = headSeq + 1;
    const nextVersion = getNextLineageVersion(headVersion, changeLevel);

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
      `INSERT INTO drift_events
         (tracked_schema_id, status, summary, detail, baseline_snapshot_id, source)
       VALUES ($1, 'in_sync', $2, $3::jsonb, $4, 'rebaseline')`,
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
    // A concurrent writer that beat us to this seq (despite the lock, e.g. a path
    // that doesn't take it) surfaces as a unique violation — report it as a clean
    // conflict rather than a generic 500.
    const code = (error as { code?: string })?.code;
    if (code === "23505") {
      return NextResponse.json(
        { error: "This schema was just re-baselined by another request. Refresh and try again." },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: "Failed to re-baseline this schema." },
      { status: 500 }
    );
  } finally {
    client.release();
  }
}
