import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth-guard";
import { actorFor } from "@/lib/auth-mode";
import { hasPermission, refusalMessage } from "@/lib/permissions";
import { runComparison } from "@/lib/compare-run";
import { aiResponse } from "@/lib/ai/respond";
import { aiGate, defaultAiDeps } from "@/lib/ai/run";
import { runSchemaChat } from "@/lib/ai/chat";
import { makeChatTools } from "@/lib/ai/chat-tools";
import { MAX_HISTORY_TURNS, MAX_QUESTION_CHARS, type ChatTurn } from "@/lib/ai/features/schema-chat-view";
import { GET as connections } from "@/app/api/connections/route";
import { GET as schemas } from "@/app/api/scripts/schemas/route";
import { GET as snapshot } from "@/app/api/schema/snapshot/route";
import { GET as versionHistory } from "@/app/api/compare/version-history/route";
import { GET as lineage } from "@/app/api/lineage/route";
import { GET as drift } from "@/app/api/lineage/drift/route";
import { GET as approvals } from "@/app/api/deploy/approvals/route";
import { GET as advice } from "@/app/api/performance/advice/route";

/** The earlier turns, as the drawer sent them. Anything else in the list is dropped. */
function readHistory(value: unknown): ChatTurn[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(-MAX_HISTORY_TURNS)
    .flatMap((turn): ChatTurn[] => {
      if (typeof turn !== "object" || turn === null) return [];
      const { role, text } = turn as Record<string, unknown>;
      if ((role !== "user" && role !== "assistant") || typeof text !== "string") return [];
      return [{ role, text: text.slice(0, MAX_QUESTION_CHARS) }];
    });
}

/**
 * POST /api/ai/chat  { question, history? }
 *
 * Answers a question about the organization's schemas. The AI looks things up
 * through the app's own read routes, run in this request as the person asking,
 * so each lookup passes or fails that route's own permission check. It cannot
 * change anything: a SQL draft in the answer is checked and shown, never run.
 *
 * Needs "Use AI assistance". Every other permission is the lookups' own.
 */
export async function POST(request: NextRequest) {
  const gate = await requirePermission("ai:read");
  if (!gate.ok) return gate.response;

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    body = typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return NextResponse.json({ error: "Invalid JSON in request body." }, { status: 400 });
  }
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) return NextResponse.json({ error: "Ask a question first." }, { status: 400 });
  if (question.length > MAX_QUESTION_CHARS) {
    return NextResponse.json(
      { error: `Keep the question under ${MAX_QUESTION_CHARS.toLocaleString("en-US")} characters.` },
      { status: 413 }
    );
  }

  const { principal } = gate;
  const caller = { orgId: principal.orgId, email: actorFor(principal) };
  const deps = defaultAiDeps();
  try {
    const refused = await aiGate(caller, "schema-chat", deps);
    if (refused) return aiResponse(refused);
  } catch (error) {
    console.error("POST ai chat: could not read the AI settings:", error);
    return NextResponse.json({ error: "Could not read this organization's AI settings. Is the app database reachable?" }, { status: 500 });
  }

  const tools = makeChatTools({
    baseUrl: request.nextUrl.origin,
    handlers: {
      connections: () => connections(),
      schemas,
      snapshot,
      versionHistory,
      lineage: () => lineage(),
      drift,
      approvals,
      advice,
    },
    // Never saved to the history, and never compares rows (no compareData).
    compare: (query) =>
      runComparison(principal.orgId, query, null, refusalMessage(principal.roleLabel, "comparison_sets:read")),
    refusal: (key) => (hasPermission(principal, key) ? null : refusalMessage(principal.roleLabel, key)),
  });

  try {
    const result = await runSchemaChat(caller, { question, history: readHistory(body.history), tools }, deps);
    return aiResponse(result);
  } catch (error) {
    console.error("POST ai chat error:", error);
    return NextResponse.json(
      { error: "Could not answer that. If this keeps happening, check that the app's database is running." },
      { status: 500 }
    );
  }
}
