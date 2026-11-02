import { NextResponse } from "next/server";
import { removeComputer } from "@/lib/agent-db";
import { requirePermission } from "@/lib/auth-guard";

const NOT_YOURS = "That computer is not linked to your account.";

/** DELETE /api/computers/[id]: unlink one of this person's computers, for instance a lost one. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("compare:read");
  if (!gate.ok) return gate.response;
  const { principal } = gate;
  const id = Number((await params).id);
  if (principal.profileId === null || !Number.isSafeInteger(id) || id < 1) {
    return NextResponse.json({ error: NOT_YOURS }, { status: 404 });
  }
  try {
    const removed = await removeComputer(principal.orgId, principal.profileId, id);
    if (!removed) return NextResponse.json({ error: NOT_YOURS }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Could not unlink a computer:", error instanceof Error ? error.name : "unknown error");
    return NextResponse.json({ error: "Could not unlink that computer." }, { status: 500 });
  }
}
