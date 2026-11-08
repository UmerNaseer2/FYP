import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth-guard";
import { actorFor } from "@/lib/auth-mode";
import { readAiAdminView } from "@/lib/ai/admin-view";
import { saveOrgAi } from "@/lib/ai/settings";
import { readAiSettingsChange } from "@/lib/ai/views";

/**
 * The AI tab on the Admin screen.
 *
 * GET (organization:read): which AI service and models the organization's
 * calls use (its own key when an Admin saved one, else the server's), whether
 * AI is on for the organization and for each feature, and the last 30 days of
 * use (calls, saved answers, tokens, how long answers took, thumbs up and
 * down). The organization's own key is saved at /api/admin/ai/key.
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
    return NextResponse.json(await readAiAdminView(gate.principal));
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
    return NextResponse.json({ ...(await readAiAdminView(principal, saved.settings)), changed: saved.changed });
  } catch (error) {
    console.error("Failed to save the AI settings:", error);
    return NextResponse.json({ error: "Could not save the AI settings." }, { status: 503 });
  }
}
