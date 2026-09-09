import { NextRequest, NextResponse } from "next/server";
import { requireViewer } from "@/lib/auth-guard";
import { listDriftEvents, type DriftEventFeedItem } from "@/lib/lineage-db";

/** One row in the audit feed (shape unchanged — now sourced from lib). */
export type AuditEvent = DriftEventFeedItem;

/** Rows returned when no ?limit is given — the same default lib/lineage-db uses. */
const DEFAULT_LIMIT = 200;

/**
 * GET /api/lineage/audit — drift check history, newest first.
 * Optional ?trackedSchemaId=N to scope to a single tracked schema, and
 * ?limit=N for callers that only want the last few (the drift detail screen
 * shows six). An unreadable or out-of-range limit falls back to the default
 * rather than erroring — a bad query string should not empty the audit log.
 */
export async function GET(request: NextRequest) {
  const gate = await requireViewer();
  if (!gate.ok) return gate.response;

  try {
    const params = new URL(request.url).searchParams;
    const idParam = params.get("trackedSchemaId");
    const trackedSchemaId = idParam ? Number(idParam) : null;

    const rawLimit = Number(params.get("limit"));
    const limit =
      Number.isInteger(rawLimit) && rawLimit > 0 && rawLimit <= DEFAULT_LIMIT
        ? rawLimit
        : DEFAULT_LIMIT;

    const events = await listDriftEvents(trackedSchemaId, limit);
    return NextResponse.json(events);
  } catch (error) {
    console.error("GET audit error:", error);
    return NextResponse.json([], { status: 200 });
  }
}
