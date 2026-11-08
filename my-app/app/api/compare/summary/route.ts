import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth-guard";
import { actorFor } from "@/lib/auth-mode";
import { hasPermission, refusalMessage } from "@/lib/permissions";
import { runComparison } from "@/lib/compare-run";
import { aiResponse } from "@/lib/ai/respond";
import { runAiTask } from "@/lib/ai/run";
import { buildCompareSummaryTask, citedChanges } from "@/lib/ai/features/compare-summary";

/**
 * POST /api/compare/summary  { query, target }
 *
 * The AI change summary for one target of the comparison the Compare screen
 * shows. `query` is the screen's own query string, as POST /api/compare takes
 * it, and `target` is the target's index on the form.
 *
 * The comparison is run again here rather than sent up by the screen, so the
 * summary is always of what the engine found, never of a report a browser
 * could have edited. Nothing is recorded: asking for a summary is not a run.
 *
 * Needs "Run comparisons" and "Use AI assistance".
 */
export async function POST(request: NextRequest) {
  const gate = await requirePermission("compare:read");
  if (!gate.ok) return gate.response;
  // requirePermission lets in any one of the keys it is given, so the AI box
  // is asked for on its own: both are needed.
  if (!hasPermission(gate.principal, "ai:read")) {
    return NextResponse.json({ error: refusalMessage(gate.principal.roleLabel, "ai:read") }, { status: 403 });
  }

  let body: { query?: unknown; target?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON in request body." }, { status: 400 });
  }
  const target = typeof body.target === "number" && Number.isInteger(body.target) ? body.target : 0;
  const params = new URLSearchParams(typeof body.query === "string" ? body.query : "");
  // The screen only shows a report after a run, so its query already says so;
  // set it anyway, since without it the engine only lists the pickers.
  params.set("run", "1");

  try {
    const screen = await runComparison(
      gate.principal.orgId,
      params,
      null,
      hasPermission(gate.principal, "comparison_sets:read")
        ? null
        : refusalMessage(gate.principal.roleLabel, "comparison_sets:read")
    );
    const outcome = screen.kind === "ready" ? screen.outcomes.find((o) => o.index === target) : undefined;
    if (!outcome || !outcome.report) {
      return NextResponse.json(
        { error: outcome?.error ?? "That comparison has no report to summarise. Run it again and try once more." },
        { status: 409 }
      );
    }
    const task = buildCompareSummaryTask(outcome.report, {
      allowDataLoss: screen.kind === "ready" && screen.allowDataLoss,
    });
    if (!task) {
      return NextResponse.json({ error: "The two schemas match, so there is nothing to summarise." }, { status: 409 });
    }

    const result = await runAiTask({ orgId: gate.principal.orgId, email: actorFor(gate.principal) }, task.spec);
    return aiResponse(result, result.kind === "ok" ? { changes: citedChanges(result.value, task.facts) } : {});
  } catch (error) {
    console.error("POST compare summary error:", error);
    return NextResponse.json(
      { error: "Could not summarise this comparison. If this keeps happening, check that the app's database is running." },
      { status: 500 }
    );
  }
}
