import { NextRequest, NextResponse } from "next/server";
import { requireAgent } from "@/lib/agent-auth";
import { finishAgentJob, runningJobMethod } from "@/lib/agent-db";
import { readAgentAnswer } from "@/lib/agent-jobs";
import { MAX_ANSWER_BYTES, keptRefusal } from "@/lib/agent-rules";

const NOT_RUNNING = "This computer is not answering that question.";
const TOO_BIG = "That answer is too big.";
const NOT_AN_ANSWER = "That is not an answer to this question.";
const COULD_NOT_KEEP = "Could not keep the answer.";

/**
 * POST /api/agent/jobs/[id]
 * A linked computer answers: { result } or { refusal: "<word>" }. Never a sentence
 * of its own (lib/agent-rules.ts), and only the fields lib/agent-jobs.ts copies
 * are kept. An answer too big to keep still ends the question, so the person hears
 * why rather than waiting for it to time out.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireAgent(request);
  if (!gate.ok) return gate.response;
  const jobId = Number((await params).id);
  if (!Number.isSafeInteger(jobId) || jobId < 1) {
    return NextResponse.json({ error: NOT_RUNNING }, { status: 404 });
  }
  try {
    const method = await runningJobMethod(gate.agent.id, jobId);
    if (method === null) return NextResponse.json({ error: NOT_RUNNING }, { status: 404 });

    const text = await request.text();
    if (Buffer.byteLength(text) > MAX_ANSWER_BYTES) {
      await finishAgentJob(gate.agent.id, jobId, { refusal: "too-big" });
      return NextResponse.json({ error: TOO_BIG }, { status: 413 });
    }
    const body = parse(text);
    if (body !== null && "refusal" in body) {
      await finishAgentJob(gate.agent.id, jobId, { refusal: keptRefusal(body.refusal) });
      return NextResponse.json({ ok: true });
    }
    const result = readAgentAnswer(method, body?.result);
    if (result === null) {
      await finishAgentJob(gate.agent.id, jobId, { refusal: "failed" });
      return NextResponse.json({ error: NOT_AN_ANSWER }, { status: 400 });
    }
    await finishAgentJob(gate.agent.id, jobId, { result });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Could not keep a computer's answer:", error instanceof Error ? error.name : "unknown error");
    return NextResponse.json({ error: COULD_NOT_KEEP }, { status: 500 });
  }
}

function parse(text: string): { result?: unknown; refusal?: unknown } | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? value : null;
  } catch {
    return null;
  }
}
