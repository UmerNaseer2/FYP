// SERVER-ONLY: the HTTP answer an AI route gives for runAiTask's result.
import { NextResponse } from "next/server";
import { aiRefusalStatus, type AiRunResult } from "./run";

/** What the screens get back with an answer. Mirrored by AiAnswerBody in views.ts. */
export function aiResponse<T>(result: AiRunResult<T>, extra: Record<string, unknown> = {}) {
  if (result.kind === "ok") {
    const { value, callId, model, saved, ms, retries, usage } = result;
    return NextResponse.json({
      answer: value,
      meta: { callId, model, saved, ms, retries, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
      ...extra,
    });
  }
  return NextResponse.json(
    { error: result.message, reason: result.kind === "unavailable" ? result.reason : result.kind },
    { status: aiRefusalStatus(result) }
  );
}
