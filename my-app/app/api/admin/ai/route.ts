import { NextRequest, NextResponse } from "next/server";
import { requirePermission, type Principal } from "@/lib/auth-guard";
import { actorFor } from "@/lib/auth-mode";
import { describeAiConfig, readAiConfig } from "@/lib/ai/config";
import { AI_FEATURES, FEATURE_LABELS } from "@/lib/ai/prompts";
import { readOrgAi, saveOrgAi, type OrgAiSettings } from "@/lib/ai/settings";
import { readAiUsage } from "@/lib/ai/store";
import { readAiSettingsChange, type AiAdminView } from "@/lib/ai/views";
import { hasPermission } from "@/lib/permissions";

/**
 * The AI tab on the Admin screen.
 *
 * GET (organization:read): whether this server has an AI service set up and
 * which models it uses, whether AI is on for the organization and for each
 * feature, and the last 30 days of use (calls, saved answers, tokens, how long
 * answers took, thumbs up and down).
 *
 * PATCH (organization:update): `{ enabled?, features?: { [feature]: boolean } }`.
 * Switching AI on means schema structure (table, column and index names, never
 * rows or connection details) can be sent to the AI service, so it is off
 * until an Admin switches it on. Every change goes in the change log.
 */
export async function GET() {
  const gate = await requirePermission("organization:read");
  if (!gate.ok) return gate.response;

  try {
    const settings = await readOrgAi(gate.principal.orgId);
    // The usage card is a nice to have: the switches still work without it.
    const usage = await readAiUsage(gate.principal.orgId).catch((error) => {
      console.error("Failed to read the AI usage:", error);
      return null;
    });
    return NextResponse.json(viewOf(settings, usage, gate.principal));
  } catch (error) {
    console.error("Failed to read the AI settings:", error);
    return NextResponse.json({ error: "Could not read the AI settings." }, { status: 503 });
  }
}

export async function PATCH(request: NextRequest) {
  const gate = await requirePermission("organization:update");
  if (!gate.ok) return gate.response;
  const { principal } = gate;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const change = readAiSettingsChange(body);
  if (typeof change === "string") return NextResponse.json({ error: change }, { status: 400 });

  try {
    const saved = await saveOrgAi(principal.orgId, change, { email: actorFor(principal), role: principal.role });
    if (saved.kind === "not-found") {
      return NextResponse.json({ error: "This organization no longer exists." }, { status: 404 });
    }
    const usage = await readAiUsage(principal.orgId).catch(() => null);
    return NextResponse.json({ ...viewOf(saved.settings, usage, principal), changed: saved.changed });
  } catch (error) {
    console.error("Failed to save the AI settings:", error);
    return NextResponse.json({ error: "Could not save the AI settings." }, { status: 503 });
  }
}

function viewOf(settings: OrgAiSettings, usage: AiAdminView["usage"], principal: Principal): AiAdminView {
  return {
    setup: describeAiConfig(),
    enabled: settings.enabled,
    features: AI_FEATURES.map((key) => ({ key, label: FEATURE_LABELS[key], on: settings.features[key] })),
    updatedBy: settings.updatedBy,
    updatedAt: settings.updatedAt ? new Date(settings.updatedAt).toISOString() : null,
    usage,
    dailyLimit: readAiConfig()?.dailyLimit ?? null,
    canUpdate: hasPermission(principal, "organization:update"),
  };
}
