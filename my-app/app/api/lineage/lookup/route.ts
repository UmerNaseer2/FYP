import { NextRequest, NextResponse } from "next/server";
import { findTrackedSchema } from "@/lib/lineage-db";

/**
 * GET /api/lineage/lookup?connectionId=&schemaName=
 *
 * Bridge for client screens (Deploy) that need to know whether a target schema
 * is tracked — and if so, its tracked id, HEAD version and latest drift status.
 * Returns `{ tracked: false }` when the pair isn't tracked.
 */
export async function GET(request: NextRequest) {
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
    console.error("Lineage lookup error:", error);
    // Don't break the caller's screen — just report "not tracked".
    return NextResponse.json({ tracked: false }, { status: 200 });
  }
}
