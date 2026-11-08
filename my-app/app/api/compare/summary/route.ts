import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth-guard";
import { actorFor } from "@/lib/auth-mode";
import { hasPermission, refusalMessage } from "@/lib/permissions";
import { runComparison } from "@/lib/compare-run";
import { MAX_COMPARISON_TARGETS } from "@/lib/comparison-set-rules";
import { aiGateRefusal, aiPermissionRefusal, aiResponse } from "@/lib/ai/respond";
import { aiDepsFor, runAiTask } from "@/lib/ai/run";
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
 * Where the query names its targets, only the asked target is compared, and
 * the row data is never read (see summaryQuery).
 *
 * Needs "Run comparisons" and "Use AI assistance".
 */

/** The query parameters that name the targets, as compare-run reads them. */
const TARGET_KEYS = ["targetConnection", "rightConnection", "targetSchema", "rightSchema"] as const;

/**
 * The screen's query cut down to what one target's summary needs: the source,
 * the one target, and the data loss switch. Each target is compared on its
 * own, so its report is the same as on the screen, without reading the other
 * targets or any table rows.
 *
 * Returns the query and the index the target then has. A saved-set link with
 * no targets of its own, or one that adds or removes a target, is left whole:
 * its targets are only known once the set or the form is read.
 */
function summaryQuery(query: string, target: number): { params: URLSearchParams; index: number } {
  const params = new URLSearchParams(query);
  // The screen only shows a report after a run, so its query already says so;
  // set it anyway, since without it the engine only lists the pickers.
  params.set("run", "1");

  const explicit = TARGET_KEYS.some((key) => params.has(key));
  const reshapes = params.has("removeTarget") || params.has("addTarget");
  if (!explicit || reshapes) return { params, index: target };

  // compare-run reads targetConnection before rightConnection, and the same for schemas.
  const connections = params.has("targetConnection") ? params.getAll("targetConnection") : params.getAll("rightConnection");
  const schemas = params.has("targetSchema") ? params.getAll("targetSchema") : params.getAll("rightSchema");
  const slots = Math.min(Math.max(connections.length, schemas.length), MAX_COMPARISON_TARGETS);
  if (target < 0 || target >= slots) return { params, index: target };

  for (const key of TARGET_KEYS) params.delete(key);
  params.set("targetConnection", connections[target] ?? "");
  params.set("targetSchema", schemas[target] ?? "");
  // The summary reads only the schema report, never the row compare.
  params.delete("compareData");
  params.delete("dataTable");
  return { params, index: 0 };
}
export async function POST(request: NextRequest) {
  const gate = await requirePermission("compare:read");
  if (!gate.ok) return gate.response;
  const noAi = aiPermissionRefusal(gate.principal);
  if (noAi) return noAi;

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    parsed = undefined;
  }
  // A body of null, a number or a list is as unreadable as broken JSON.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return NextResponse.json({ error: "Invalid JSON in request body." }, { status: 400 });
  }
  const body = parsed as { query?: unknown; target?: unknown; refresh?: unknown };
  const target = typeof body.target === "number" && Number.isInteger(body.target) ? body.target : 0;
  const { params, index } = summaryQuery(typeof body.query === "string" ? body.query : "", target);

  const caller = { orgId: gate.principal.orgId, email: actorFor(gate.principal) };
  const deps = await aiDepsFor(caller.orgId);
  // Said before the comparison runs: with AI off there is nothing to compare for.
  const off = await aiGateRefusal(caller, "compare-summary", deps, "POST compare summary");
  if (off) return off;

  try {
    const screen = await runComparison(
      gate.principal.orgId,
      params,
      null,
      hasPermission(gate.principal, "comparison_sets:read")
        ? null
        : refusalMessage(gate.principal.roleLabel, "comparison_sets:read")
    );
    const outcome = screen.kind === "ready" ? screen.outcomes.find((o) => o.index === index) : undefined;
    if (!outcome || !outcome.report) {
      return NextResponse.json(
        { error: outcome?.error ?? "That comparison has no report to summarize. Run it again and try once more." },
        { status: 409 }
      );
    }
    const task = buildCompareSummaryTask(outcome.report, {
      allowDataLoss: screen.kind === "ready" && screen.allowDataLoss,
    });
    if (!task) {
      return NextResponse.json({ error: "The two schemas match, so there is nothing to summarize." }, { status: 409 });
    }

    const result = await runAiTask(caller, { ...task.spec, signal: request.signal, refresh: body.refresh === true }, deps);
    return aiResponse(result, result.kind === "ok" ? { changes: citedChanges(result.value, task.facts) } : {});
  } catch (error) {
    console.error("POST compare summary error:", error);
    return NextResponse.json(
      { error: "Could not summarize this comparison. If this keeps happening, check that the app's database is running." },
      { status: 500 }
    );
  }
}
