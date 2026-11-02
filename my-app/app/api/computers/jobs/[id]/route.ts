import { NextResponse } from "next/server";
import { readAgentJobFor } from "@/lib/agent-db";
import { TIMED_OUT, refusalSentence, type JobAnswer } from "@/lib/agent-rules";
import { requirePermission } from "@/lib/auth-guard";

const NO_SUCH_QUESTION = "That question is not there any more. Ask again.";

/** GET /api/computers/jobs/[id]: how a question to one of this person's computers stands. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("compare:read");
  if (!gate.ok) return gate.response;
  const { principal } = gate;
  const id = Number((await params).id);
  if (principal.profileId === null || !Number.isSafeInteger(id) || id < 1) {
    return NextResponse.json({ error: NO_SUCH_QUESTION }, { status: 404 });
  }
  try {
    const job = await readAgentJobFor(principal.orgId, principal.profileId, id);
    if (job === null) return NextResponse.json({ error: NO_SUCH_QUESTION }, { status: 404 });
    return NextResponse.json(answerFor(job));
  } catch (error) {
    console.error("Could not read a computer's answer:", error instanceof Error ? error.name : "unknown error");
    return NextResponse.json({ error: "Could not read that answer." }, { status: 500 });
  }
}

function answerFor(job: NonNullable<Awaited<ReturnType<typeof readAgentJobFor>>>): JobAnswer {
  switch (job.status) {
    case "done":
      return { status: "done", result: job.result };
    case "failed":
      return { status: "failed", error: refusalSentence(job.refusal) };
    case "timed-out":
      return { status: "failed", error: TIMED_OUT };
    default:
      return { status: "waiting" };
  }
}
