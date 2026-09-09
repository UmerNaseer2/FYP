import { NextResponse } from "next/server";
import { requireViewer } from "@/lib/auth-guard";
import { getLineageDetail, type LineageDetail } from "@/lib/lineage-db";

// Re-export so the screen can import the shape from the route it calls.
export type { LineageDetail };

/**
 * GET /api/lineage/<id> — everything the schema detail screen shows, in one
 * read: the tracked schema, its connection, its lineage newest-first, and the
 * latest drift check.
 *
 * The screen used to call getLineageDetail itself while rendering, which put a
 * database query inside a UI component. It now goes through this route like
 * every other screen, so there is one place where a tracked schema is read and
 * one place where the permission to read it is checked.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const gate = await requireViewer();
  if (!gate.ok) return gate.response;

  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "That schema is not tracked." }, { status: 404 });
  }

  try {
    const detail = await getLineageDetail(id);
    if (!detail) {
      return NextResponse.json({ error: "That schema is not tracked." }, { status: 404 });
    }
    return NextResponse.json(detail);
  } catch (error) {
    console.error("GET lineage detail error:", error);
    return NextResponse.json(
      { error: "Could not read this schema's lineage." },
      { status: 500 }
    );
  }
}
