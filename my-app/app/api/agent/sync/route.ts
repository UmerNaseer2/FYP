import { NextRequest, NextResponse } from "next/server";
import { requireAgent } from "@/lib/agent-auth";
import { agentPrincipal } from "@/lib/auth-guard";
import { readRev, readSync } from "@/lib/agent-sync";

const COULD_NOT_READ = "Could not read this organization's connections. Try again in a moment.";

/**
 * GET /api/agent/sync?rev=<fingerprint>
 * A linked desktop asks, on every poll, whether its organization's connections
 * changed since the fingerprint it holds. Unchanged costs one small answer;
 * changed sends the whole list, with passwords only for a person who could
 * change the connections on the website (lib/agent-sync.ts).
 */
export async function GET(request: NextRequest) {
  const gate = await requireAgent(request);
  if (!gate.ok) return gate.response;
  try {
    const principal = await agentPrincipal(gate.agent);
    if (!principal) return NextResponse.json({ error: COULD_NOT_READ }, { status: 503 });
    const answer = await readSync(principal, readRev(request.nextUrl.searchParams.get("rev")));
    return NextResponse.json(answer, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Could not read connections for a computer:", error instanceof Error ? error.name : "unknown error");
    return NextResponse.json({ error: COULD_NOT_READ }, { status: 503 });
  }
}
