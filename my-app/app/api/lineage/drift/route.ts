import { NextRequest, NextResponse } from "next/server";
import pool from "@/lib/version-db";
import type { CompareReport } from "@/lib/compare-types";
import {
  computeDriftDetail,
  type DriftCounts,
  type DriftStatus,
} from "@/lib/lineage-db";

// Re-export so existing callers can keep importing DriftCounts from here.
export type { DriftCounts };

export type DriftCheckResult = {
  trackedSchemaId: number;
  status: DriftStatus;
  summary: string;
  counts: DriftCounts | null;
  expectedVersion: string | null;
  checkedAt: string;
  /** Full structural report (Expected vs Actual) for the drift detail screen. */
  report: CompareReport | null;
};

/**
 * POST /api/lineage/drift  { trackedSchemaId }
 *
 * Compare a tracked schema's EXPECTED structure (the snapshot at lineage HEAD)
 * against its ACTUAL live structure right now, via the shared recompute in
 * `lib/lineage-db` (the same engine /compare uses). Records a drift_events row
 * and returns the status plus the full report for the drift detail screen.
 *
 * "Unreachable" (can't connect / read the schema) is returned cleanly with a
 * 200 — it's a normal state for a tracked schema, not a server error.
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
    console.error("Drift — recompute failed:", error);
    return NextResponse.json({ error: "Could not read tracking metadata." }, { status: 500 });
  }

  if (comp.kind === "not_found") {
    return NextResponse.json({ error: "Tracked schema not found." }, { status: 404 });
  }
  if (comp.kind === "no_baseline") {
    return NextResponse.json(
      { error: "This tracked schema has no baseline snapshot to compare against." },
      { status: 409 }
    );
  }

  const status: DriftStatus = comp.kind === "unreachable" ? "unreachable" : comp.status;
  const counts = comp.kind === "ok" ? comp.counts : null;
  const report = comp.kind === "ok" ? comp.report : null;

  // Record the check for the audit feed. A failed insert shouldn't fail the
  // check itself — the user still gets their result.
  try {
    await pool.query(
      `INSERT INTO drift_events (tracked_schema_id, status, summary, detail, baseline_snapshot_id)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [
        trackedSchemaId,
        status,
        comp.summary,
        counts ? JSON.stringify(counts) : null,
        comp.expected.snapshotId,
      ]
    );
  } catch (error) {
    console.error("Drift — failed to record drift_event:", error);
  }

  const result: DriftCheckResult = {
    trackedSchemaId,
    status,
    summary: comp.summary,
    counts,
    expectedVersion: comp.expected.version,
    checkedAt: new Date().toISOString(),
    report,
  };
  return NextResponse.json(result);
}
