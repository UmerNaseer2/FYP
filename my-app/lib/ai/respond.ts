// SERVER-ONLY: the HTTP answers an AI route gives: its two AI checks, and
// what runAiTask's result becomes.
import { NextResponse } from "next/server";
import type { Principal } from "@/lib/auth-guard";
import { hasPermission, refusalMessage } from "@/lib/permissions";
import type { AiFeature } from "./prompts";
import { aiGate, aiRefusalStatus, type AiCaller, type AiDeps, type AiRunResult } from "./run";

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

/**
 * First check of every AI route, right after its own permission check: the
 * person needs "Use AI assistance" as well. requirePermission lets in any one
 * of the keys it is given, so this box is asked for on its own.
 * Returns the 403 to send, or null to go on.
 */
export function aiPermissionRefusal(principal: Principal): NextResponse | null {
  if (hasPermission(principal, "ai:read")) return null;
  return NextResponse.json({ error: refusalMessage(principal.roleLabel, "ai:read") }, { status: 403 });
}

/**
 * Second check, once the route has read its request body and before it reads
 * any database: is AI set up, and on for this organization and feature?
 * Returns the answer to send when it is not, or null to go on.
 *
 * runAiTask and runSchemaChat check again when they start. That second read
 * is on purpose: it catches AI being switched off during the seconds a route
 * spends reading the schema.
 */
export async function aiGateRefusal(
  caller: AiCaller,
  feature: AiFeature,
  deps: Pick<AiDeps, "config" | "provider" | "readSettings">,
  logPrefix: string
): Promise<NextResponse | null> {
  try {
    const refused = await aiGate(caller, feature, deps);
    return refused ? aiResponse(refused) : null;
  } catch (error) {
    console.error(`${logPrefix}: could not read the AI settings:`, error);
    return NextResponse.json(
      { error: "Could not read this organization's AI settings. Is the app database reachable?" },
      { status: 500 }
    );
  }
}
