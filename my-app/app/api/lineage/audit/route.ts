import { NextRequest, NextResponse } from "next/server";
import { listDriftEvents, type DriftEventFeedItem } from "@/lib/lineage-db";

/** One row in the audit feed (shape unchanged — now sourced from lib). */
export type AuditEvent = DriftEventFeedItem;

/**
 * GET /api/lineage/audit — drift check history, newest first.
 * Optional ?trackedSchemaId=N to scope to a single tracked schema.
 */
export async function GET(request: NextRequest) {
  try {
    const idParam = new URL(request.url).searchParams.get("trackedSchemaId");
    const trackedSchemaId = idParam ? Number(idParam) : null;
    const events = await listDriftEvents(trackedSchemaId);
    return NextResponse.json(events);
  } catch (error) {
    console.error("GET audit error:", error);
    return NextResponse.json([], { status: 200 });
  }
}
