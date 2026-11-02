/**
 * Who is calling a route under /api/agent/: a linked computer and its token.
 *
 * A computer sends no cookie and names no organization, because its token already
 * says which it belongs to. A database that cannot be read gets a 503, never a
 * 401, because a computer takes a 401 to mean it has been unlinked.
 */
import { NextRequest, NextResponse } from "next/server";
import { findAgent, type AgentCaller } from "@/lib/agent-db";
import { TOKEN_PREFIX } from "@/lib/agent-rules";

/** A token is under fifty characters. Anything much longer is not one, and is not worth hashing. */
const LONGEST_TOKEN = 200;

const NOT_LINKED = "This computer is not linked. Link it again in Schema Studio's Settings.";
const COULD_NOT_CHECK = "Could not check this computer's link. Try again in a moment.";

export type AgentGate = { ok: true; agent: AgentCaller } | { ok: false; response: NextResponse };

export async function requireAgent(request: NextRequest): Promise<AgentGate> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!token.startsWith(TOKEN_PREFIX) || token.length > LONGEST_TOKEN) {
    return { ok: false, response: NextResponse.json({ error: NOT_LINKED }, { status: 401 }) };
  }
  try {
    const agent = await findAgent(token);
    if (agent === null) {
      return { ok: false, response: NextResponse.json({ error: NOT_LINKED }, { status: 401 }) };
    }
    return { ok: true, agent };
  } catch (error) {
    console.error("Could not check a computer's link:", error instanceof Error ? error.name : "unknown error");
    return { ok: false, response: NextResponse.json({ error: COULD_NOT_CHECK }, { status: 503 }) };
  }
}
