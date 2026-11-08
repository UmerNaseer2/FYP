import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth-guard";
import { actorFor } from "@/lib/auth-mode";
import { hasPermission, refusalMessage } from "@/lib/permissions";
import { computeDriftDetail } from "@/lib/lineage-db";
import { aiResponse } from "@/lib/ai/respond";
import { aiGate, defaultAiDeps, runAiTask } from "@/lib/ai/run";
import {
  buildDriftExplainTask,
  buildDriftScripts,
  citedDriftChanges,
  driftChanges,
  withAppManualNotes,
} from "@/lib/ai/features/drift-explain";

/**
 * POST /api/lineage/drift/explain  { trackedSchemaId }
 *
 * The AI's explanation of one tracked schema's drift, with the two ways out
 * the app writes itself: a script that puts live back to the baseline
 * ("revert") and one that writes the live changes as the registry's next
 * version ("adopt"). The drift is checked again here, so the answer is about
 * the database as it is now, not as a page loaded a while ago saw it.
 *
 * Nothing is changed and nothing is recorded but the AI call: the scripts are
 * handed back for a person to open as a Script Editor draft, and the AI's
 * choice between them is a suggestion only.
 *
 * Needs Read on Drift and "Use AI assistance".
 */
export async function POST(request: NextRequest) {
  const gate = await requirePermission("drift:read");
  if (!gate.ok) return gate.response;
  if (!hasPermission(gate.principal, "ai:read")) {
    return NextResponse.json({ error: refusalMessage(gate.principal.roleLabel, "ai:read") }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    body = typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return NextResponse.json({ error: "Invalid JSON in request body." }, { status: 400 });
  }
  const trackedSchemaId = Number(body.trackedSchemaId);
  if (!Number.isInteger(trackedSchemaId) || trackedSchemaId <= 0) {
    return NextResponse.json({ error: "Pick a tracked schema first." }, { status: 400 });
  }

  const caller = { orgId: gate.principal.orgId, email: actorFor(gate.principal) };
  const deps = defaultAiDeps();
  // Said before the database is read: with AI off there is nothing to read it for.
  try {
    const refused = await aiGate(caller, "drift-explain", deps);
    if (refused) return aiResponse(refused);
  } catch (error) {
    console.error("POST drift explain: could not read the AI settings:", error);
    return NextResponse.json({ error: "Could not read this organization's AI settings. Is the app database reachable?" }, { status: 500 });
  }

  try {
    const comp = await computeDriftDetail(gate.principal.orgId, trackedSchemaId);
    if (comp.kind === "not_found") {
      return NextResponse.json({ error: "That schema is not tracked in this organization." }, { status: 404 });
    }
    if (comp.kind !== "ok" || comp.status !== "drifted") {
      const why =
        comp.kind === "no_baseline"
          ? "This schema has no baseline yet, so there is no drift to explain."
          : comp.kind === "unreachable"
            ? "The database could not be reached just now, so there is no drift to explain. Try again when it is back."
            : "This schema matches its baseline now, so there is no drift to explain.";
      return NextResponse.json({ error: why }, { status: 409 });
    }

    const whatChanged = driftChanges(comp.report);
    const scripts = buildDriftScripts(comp.report, whatChanged, {
      schemaName: comp.schemaName,
      expectedVersion: comp.expected.version,
    });
    const task = buildDriftExplainTask(comp.report, whatChanged, { expectedVersion: comp.expected.version, scripts });
    if (!task) {
      return NextResponse.json({ error: "The check found drift but no change it can list, so there is nothing to explain." }, { status: 409 });
    }

    const result = await runAiTask(caller, task.spec, deps);
    if (result.kind !== "ok") return aiResponse(result);
    // The app's own notes are added here, after the check and after a saved
    // answer is read, so every explanation of this drift gets them.
    const answer = withAppManualNotes(result.value, task.facts);
    return aiResponse(
      { ...result, value: answer },
      {
        cited: citedDriftChanges(answer, task.facts),
        scripts,
        expectedVersion: comp.expected.version,
        target: { connectionId: comp.connection?.id ?? null, schemaName: comp.schemaName },
      }
    );
  } catch (error) {
    console.error("POST drift explain error:", error);
    return NextResponse.json(
      { error: "Could not explain this drift. If this keeps happening, check that the database and the app's database are running." },
      { status: 500 }
    );
  }
}
