import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth-guard";
import { actorFor } from "@/lib/auth-mode";
import { rateAiCall } from "@/lib/ai/store";

/**
 * A thumbs up or down on an AI answer, from the person who asked for it.
 * POST `{ callId, rating }` with rating 1 or -1. The Admin AI tab counts them
 * per feature. Someone else's answer cannot be rated.
 */
export async function POST(request: NextRequest) {
  const gate = await requirePermission("ai:read");
  if (!gate.ok) return gate.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const { callId, rating } = (body ?? {}) as { callId?: unknown; rating?: unknown };
  if (typeof callId !== "number" || !Number.isInteger(callId) || callId <= 0 || (rating !== 1 && rating !== -1)) {
    return NextResponse.json({ error: "Send a callId and a rating of 1 or -1." }, { status: 400 });
  }

  try {
    const saved = await rateAiCall(gate.principal.orgId, actorFor(gate.principal), callId, rating);
    if (!saved) return NextResponse.json({ error: "That AI answer was not found." }, { status: 404 });
    return NextResponse.json({ saved: true });
  } catch (error) {
    console.error("Failed to save an AI rating:", error);
    return NextResponse.json({ error: "Could not save the rating." }, { status: 503 });
  }
}
