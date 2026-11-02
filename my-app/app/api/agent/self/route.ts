import { NextRequest, NextResponse } from "next/server";
import { requireAgent } from "@/lib/agent-auth";
import { removeAgent } from "@/lib/agent-db";

/** DELETE /api/agent/self: a linked computer unlinks itself. */
export async function DELETE(request: NextRequest) {
  const gate = await requireAgent(request);
  if (!gate.ok) return gate.response;
  try {
    await removeAgent(gate.agent.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Could not unlink a computer:", error instanceof Error ? error.name : "unknown error");
    return NextResponse.json({ error: "Could not unlink this computer." }, { status: 500 });
  }
}
