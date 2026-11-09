import { NextRequest, NextResponse } from "next/server";
import { requireAgent } from "@/lib/agent-auth";
import { agentPrincipal } from "@/lib/auth-guard";
import { readDriftSync, readRev } from "@/lib/agent-sync";

const COULD_NOT_READ = "Could not read this organization's drift results. Try again in a moment.";

/**
 * GET /api/agent/sync/drift?rev=<fingerprint>
 * A linked desktop asks, now and then, for the newest drift results of every
 * schema the website watches, so it can show them next to its own. Unchanged
 * costs one small answer. Results only: never a snapshot or a connection's
 * details (lib/drift-sync.ts).
 */
export async function GET(request: NextRequest) {
  const gate = await requireAgent(request);
  if (!gate.ok) return gate.response;
  try {
    const principal = await agentPrincipal(gate.agent);
    if (!principal) return NextResponse.json({ error: COULD_NOT_READ }, { status: 503 });
    const answer = await readDriftSync(principal, readRev(request.nextUrl.searchParams.get("rev")));
    return NextResponse.json(answer, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Could not read drift results for a computer:", error instanceof Error ? error.name : "unknown error");
    return NextResponse.json({ error: COULD_NOT_READ }, { status: 503 });
  }
}
