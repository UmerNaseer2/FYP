import { NextRequest, NextResponse } from "next/server";
import { requireEditor, requireViewer } from "@/lib/auth-guard";
import pool, { syncMetadataTables } from "@/lib/version-db";
import {
  listTrackedSchemas,
  type TrackedSchemaListItem,
} from "@/lib/lineage-db";
import { ENVIRONMENTS, toEnvironment } from "@/lib/environments";

// Re-export so existing callers can keep importing the list item type from here.
export type { TrackedSchemaListItem };

/** GET /api/lineage — list every tracked schema with its lineage HEAD + drift. */
export async function GET() {
  const gate = await requireViewer();
  if (!gate.ok) return gate.response;

  try {
    const items = await listTrackedSchemas();
    return NextResponse.json(items);
  } catch (error) {
    console.error("GET lineage error:", error);
    // Keep the dashboard readable: an empty list, not a crash.
    return NextResponse.json([], { status: 200 });
  }
}

/**
 * PATCH /api/lineage — relabel a tracked schema's environment.
 * Body: { id: number, environment: "unset" | "dev" | "staging" | "prod" }
 *
 * The environment is inherited from the connection when tracking starts, but
 * it has to be changeable afterwards: a schema gets promoted, a server gets
 * repurposed, and every row that existed before the column did arrived as
 * "unset". A label nobody can correct is a label nobody will trust.
 *
 * Unlike the tracking route this rejects an unknown value rather than quietly
 * narrowing it — the caller here is a deliberate edit, and silently writing
 * "unset" because of a typo would be the same lie the free-text name was.
 */
export async function PATCH(request: NextRequest) {
  const gate = await requireEditor();
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

    const raw = String(body.environment ?? "").trim().toLowerCase();
    if (!(ENVIRONMENTS as readonly string[]).includes(raw)) {
      return NextResponse.json(
        { error: `Environment must be one of: ${ENVIRONMENTS.join(", ")}.` },
        { status: 400 }
      );
    }
    const environment = toEnvironment(raw);

    const result = await pool.query<{ id: number; environment: string }>(
      `UPDATE tracked_schemas SET environment = $1 WHERE id = $2
       RETURNING id, environment`,
      [environment, id]
    );
    if (result.rows.length === 0) {
      return NextResponse.json(
        { error: "That schema is not tracked." },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true, environment });
  } catch (error) {
    console.error("PATCH lineage error:", error);
    return NextResponse.json(
      { error: "Failed to change this schema's environment." },
      { status: 500 }
    );
  }
}

/** DELETE /api/lineage — stop tracking a schema (cascades snapshots/lineage/drift). */
export async function DELETE(request: NextRequest) {
  const gate = await requireEditor();
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
