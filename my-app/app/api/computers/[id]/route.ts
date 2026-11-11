import { NextResponse } from "next/server";
import { removeComputer, removeOrgComputer } from "@/lib/agent-db";
import { requirePermission } from "@/lib/auth-guard";
import { hasPermission } from "@/lib/permissions";

const NOT_YOURS = "That computer is not linked to your account.";
const NOT_HERE = "That computer is not linked to this organization.";

/**
 * DELETE /api/computers/[id]: unlink a computer, for instance a lost one.
 *
 * Anyone may unlink a computer they linked themselves. Someone who may remove
 * members (an Admin) may unlink any computer of the organization, so a lost
 * or wrongly linked one can be cut off when its owner is not around.
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("compare:read", "users:delete");
  if (!gate.ok) return gate.response;
  const { principal } = gate;
  const { orgId, profileId } = principal;
  const mayUnlinkAny = hasPermission(principal, "users:delete");
  const notFound = NextResponse.json({ error: mayUnlinkAny ? NOT_HERE : NOT_YOURS }, { status: 404 });
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id < 1) return notFound;
  try {
    // Under the sign-in bypass nobody has an account, so nobody has a computer of their own.
    const removed = mayUnlinkAny
      ? await removeOrgComputer(orgId, id)
      : profileId !== null && (await removeComputer(orgId, profileId, id));
    if (!removed) return notFound;
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Could not unlink a computer:", error instanceof Error ? error.name : "unknown error");
    return NextResponse.json({ error: "Could not unlink that computer." }, { status: 500 });
  }
}
