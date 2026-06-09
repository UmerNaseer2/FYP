import { NextRequest, NextResponse } from "next/server";
import pool from "@/lib/version-db";
import {
  ensureLineageTables,
  listTrackedSchemas,
  type TrackedSchemaListItem,
} from "@/lib/lineage-db";

// Re-export so existing callers can keep importing the list item type from here.
export type { TrackedSchemaListItem };

/** GET /api/lineage — list every tracked schema with its lineage HEAD + drift. */
export async function GET() {
  try {
    const items = await listTrackedSchemas();
    return NextResponse.json(items);
  } catch (error) {
    console.error("GET lineage error:", error);
    // Keep the dashboard readable: an empty list, not a crash.
    return NextResponse.json([], { status: 200 });
  }
}

/** DELETE /api/lineage — stop tracking a schema (cascades snapshots/lineage/drift). */
export async function DELETE(request: NextRequest) {
  try {
    await ensureLineageTables();

    const body = await request.json().catch(() => ({}));
    const id = Number(body.id);
    if (!id) {
      return NextResponse.json(
        { error: "A tracked-schema id is required." },
        { status: 400 }
      );
    }

    await pool.query("DELETE FROM tracked_schemas WHERE id = $1", [id]);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("DELETE lineage error:", error);
    return NextResponse.json(
      { error: "Failed to stop tracking this schema." },
      { status: 500 }
    );
  }
}
