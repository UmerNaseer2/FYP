import { NextResponse } from "next/server";
import { listOrgComputers } from "@/lib/agent-db";
import { requirePermission } from "@/lib/auth-guard";

/**
 * GET /api/connections/computers
 * Every computer linked in this organization and the connections kept only on
 * it, by name and environment, so everyone who can read connections sees them
 * listed under the org. Their passwords never leave the computer, and only
 * its owner can compare through it (GET /api/computers).
 */
export async function GET() {
  const gate = await requirePermission("connections:read");
  if (!gate.ok) return gate.response;
  const { principal } = gate;
  try {
    return NextResponse.json({ computers: await listOrgComputers(principal.orgId, principal.profileId) });
  } catch (error) {
    console.error("Could not list the organization's computers:", error instanceof Error ? error.name : "unknown error");
    return NextResponse.json({ error: "Could not list the linked computers." }, { status: 500 });
  }
}
