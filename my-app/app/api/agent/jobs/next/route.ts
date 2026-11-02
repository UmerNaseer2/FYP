import { NextRequest, NextResponse } from "next/server";
import { requireAgent } from "@/lib/agent-auth";
import { nextAgentJob } from "@/lib/agent-db";

/**
 * POST /api/agent/jobs/next
 * A linked computer asks whether there is a question for it. A POST because
 * asking marks the question as being answered.
 */
export async function POST(request: NextRequest) {
  const gate = await requireAgent(request);
  if (!gate.ok) return gate.response;
  try {
    return NextResponse.json({ job: await nextAgentJob(gate.agent.id) });
  } catch (error) {
    console.error("Could not read a computer's next job:", error instanceof Error ? error.name : "unknown error");
    return NextResponse.json({ error: "Could not read the next question." }, { status: 500 });
  }
}
