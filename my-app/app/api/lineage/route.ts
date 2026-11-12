import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth-guard";
import pool, { syncMetadataTables } from "@/lib/version-db";
import {
  listTrackedSchemas,
  type TrackedSchemaListItem,
} from "@/lib/lineage-db";

// Re-export so existing callers can keep importing the list item type from here.
export type { TrackedSchemaListItem };

/**
 * GET /api/lineage — list every tracked schema in the caller's organization
 * with its lineage HEAD + drift.
 */
export async function GET() {
  const gate = await requirePermission("drift:read", "dashboard:read");
  if (!gate.ok) return gate.response;

  try {
    const items = await listTrackedSchemas(gate.principal.orgId);
    return NextResponse.json(items);
  } catch (error) {
    // This used to answer `[]` with a 200. A dashboard showing "nothing tracked
    // yet" when the metadata database is unreachable is worse than an error —
    // it invites you to track a schema that is already tracked, and it hides
    // every drift warning you actually needed to see.
    console.error("GET lineage error:", error);
    return NextResponse.json(
      { error: "Could not read your tracked schemas. Is the app database reachable?" },
      { status: 500 }
    );
  }
}

/** DELETE /api/lineage — stop tracking a schema (cascades snapshots/lineage/drift). */
export async function DELETE(request: NextRequest) {
  const gate = await requirePermission("drift:delete");
  if (!gate.ok) return gate.response;

  try {
    await syncMetadataTables();

    const body = await request.json().catch(() => ({}));
    const id = Number(body.id);
    if (!id) {
      return NextResponse.json(
        { error: "A tracked-schema id is required." },
        { status: 400 }
      );
    }

    // Only inside the caller's organization. Another organization's id deletes
    // nothing and answers the same success an already-untracked one does.
    await pool.query("DELETE FROM tracked_schemas WHERE id = $1 AND org_id = $2", [
      id,
      gate.principal.orgId,
    ]);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("DELETE lineage error:", error);
    return NextResponse.json(
      { error: "Failed to stop tracking this schema." },
      { status: 500 }
    );
  }
}
