import { NextRequest, NextResponse } from "next/server";
import { requireViewer } from "@/lib/auth-guard";
import { findTrackedSchema } from "@/lib/lineage-db";

/**
 * GET /api/lineage/lookup?connectionId=&schemaName=
 *
 * Bridge for client screens (Deploy) that need to know whether a target schema
 * is tracked — and if so, its tracked id, HEAD version and latest drift status.
 * Returns `{ tracked: false }` when the pair isn't tracked.
 */
export async function GET(request: NextRequest) {
  const gate = await requireViewer();
  if (!gate.ok) return gate.response;

  try {
    const sp = new URL(request.url).searchParams;
    const connectionId = Number(sp.get("connectionId"));
    const schemaName = (sp.get("schemaName") ?? "").trim();

    if (!connectionId || !schemaName) {
      return NextResponse.json(
        { error: "connectionId and schemaName are required." },
        { status: 400 }
      );
    }

    const head = await findTrackedSchema(connectionId, schemaName);
    if (!head) {
      return NextResponse.json({ tracked: false });
    }
    return NextResponse.json({ tracked: true, ...head });
  } catch (error) {
    // "Not tracked" is a real answer, and the Deploy screen acts on it: it
    // skips the drift pre-check and shows the target as having no environment
    // label. Saying it because the query failed turns a dead metadata database
    // into a green light.
    console.error("Lineage lookup error:", error);
    return NextResponse.json(
      { error: "Could not check whether this schema is tracked." },
      { status: 500 }
    );
  }
}
