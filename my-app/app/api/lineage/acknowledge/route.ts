import { NextRequest, NextResponse } from "next/server";
import pool from "@/lib/version-db";
import {
  computeDriftDetail,
  type DriftStatus,
} from "@/lib/lineage-db";

/**
 * POST /api/lineage/acknowledge  { trackedSchemaId }
 *
 * Mark the current drift as reviewed without changing the database. We recompute
 * the live state (so the audit row is honest about what was acknowledged) and
 * record a drift_events row stamped with acknowledged_at. The schema stays
 * whatever it actually is — acknowledging never pretends the drift is gone.
 */
export async function POST(request: NextRequest) {
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

  let comp;
  try {
    comp = await computeDriftDetail(trackedSchemaId);
  } catch (error) {
    console.error("Acknowledge — recompute failed:", error);
    return NextResponse.json({ error: "Could not read tracking metadata." }, { status: 500 });
  }

  if (comp.kind === "not_found") {
    return NextResponse.json({ error: "Tracked schema not found." }, { status: 404 });
  }
  if (comp.kind === "no_baseline") {
    return NextResponse.json(
      { error: "This tracked schema has no baseline snapshot to acknowledge against." },
      { status: 409 }
    );
  }

  const status: DriftStatus = comp.kind === "unreachable" ? "unreachable" : comp.status;
  const counts = comp.kind === "ok" ? comp.counts : null;
  const snapshotId = comp.expected.snapshotId;

  try {
    await pool.query(
      `INSERT INTO drift_events
         (tracked_schema_id, status, summary, detail, baseline_snapshot_id, acknowledged_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, CURRENT_TIMESTAMP)`,
      [
        trackedSchemaId,
        status,
        `Acknowledged · ${comp.summary}`,
        counts ? JSON.stringify(counts) : null,
        snapshotId,
      ]
    );
  } catch (error) {
    console.error("Acknowledge — failed to record drift_event:", error);
    return NextResponse.json(
      { error: "Could not record the acknowledgement." },
      { status: 500 }
    );
  }

  return NextResponse.json({
    success: true,
    trackedSchemaId,
    status,
    acknowledgedAt: new Date().toISOString(),
  });
}
