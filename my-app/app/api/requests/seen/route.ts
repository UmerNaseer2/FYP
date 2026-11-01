import { NextResponse } from "next/server";
import { requireMember } from "@/lib/auth-guard";
import { markRequestsSeen } from "@/lib/access-requests-db";

/**
 * The Requests page has been read, so the answers shown on it stop counting
 * toward the number in the rail. It is kept per organization, on the membership.
 * The sign-in bypass has no membership and no such count.
 */
export async function POST() {
  const gate = await requireMember();
  if (!gate.ok) return gate.response;
  const { principal } = gate;
  try {
    if (principal.profileId !== null) {
      await markRequestsSeen(principal.orgId, principal.profileId);
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Could not mark requests as read:", error);
    return NextResponse.json({ error: "Could not update this." }, { status: 500 });
  }
}
