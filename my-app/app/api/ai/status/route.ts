import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth-guard";
import { describeAiConfig } from "@/lib/ai/config";
import { readOrgAi } from "@/lib/ai/settings";
import type { AiStatusView } from "@/lib/ai/views";

/**
 * Whether the caller can use AI here, feature by feature. The AI panels on
 * Compare, Deploy, Drift and the Script Editor ask this before drawing a
 * button, so nobody is offered a button that can only be refused.
 *
 * Needs ai:read (Editors and Admins out of the box). Says nothing about the
 * key or the service's address.
 */
export async function GET() {
  const gate = await requirePermission("ai:read");
  if (!gate.ok) return gate.response;

  try {
    const setup = describeAiConfig();
    const settings = await readOrgAi(gate.principal.orgId);
    const view: AiStatusView = {
      configured: setup.configured,
      service: setup.service,
      enabled: settings.enabled,
      features: settings.features,
    };
    return NextResponse.json(view);
  } catch (error) {
    console.error("Failed to read the AI settings:", error);
    return NextResponse.json({ error: "Could not read the AI settings." }, { status: 503 });
  }
}
