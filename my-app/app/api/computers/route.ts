import { NextRequest, NextResponse } from "next/server";
import { listComputers } from "@/lib/agent-db";
import { requirePermission } from "@/lib/auth-guard";

/**
 * GET /api/computers
 * The computers this person has linked in this organization. Only theirs: a
 * colleague's laptop is that colleague's, whatever role the two of them hold.
 * `?connections=all` adds the connections they did not share with the phone,
 * for the "On <computer>" rows of the Connections page.
 */
export async function GET(request: NextRequest) {
  const gate = await requirePermission("compare:read");
  if (!gate.ok) return gate.response;
  const { principal } = gate;
  if (principal.profileId === null) return NextResponse.json({ computers: [] });
  try {
    return NextResponse.json({ computers: await listComputers(principal.orgId, principal.profileId, request.nextUrl.searchParams.get("connections") === "all") });
  } catch (error) {
    console.error("Could not list computers:", error instanceof Error ? error.name : "unknown error");
    return NextResponse.json({ error: "Could not list your computers." }, { status: 500 });
  }
}
