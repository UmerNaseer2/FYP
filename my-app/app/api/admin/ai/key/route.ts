import { NextRequest, NextResponse } from "next/server";
import { requirePermission, type Principal } from "@/lib/auth-guard";
import { actorFor } from "@/lib/auth-mode";
import { readAiAdminView } from "@/lib/ai/admin-view";
import { removeOrgKey, saveOrgKey } from "@/lib/ai/org-key";
import type { AiActor } from "@/lib/ai/settings";
import { readAiKeyChange } from "@/lib/ai/views";
import { encryptionKeySource } from "@/lib/secret-store";

/**
 * The organization's own AI key, from the AI tab on the Admin screen
 * (lib/ai/org-key.ts). When one is saved, every AI call for the organization
 * uses it, with the service it was made for, instead of the server's AI
 * settings.
 *
 * PUT (organization:update) saves `{ provider, apiKey, modelFast?, modelSmart? }`,
 * replacing any key saved before. The provider is one of the fixed list in
 * lib/ai/key-providers.ts, so the key only ever goes to the service it was
 * made for. Empty model names keep that service's usual models.
 *
 * DELETE (organization:update) forgets the key, so the organization's AI
 * calls use the server's settings again.
 *
 * Write-only: no answer ever holds the key, only which service it is for and
 * its last four characters. Saving a key does not switch AI on. Both answer
 * with the whole AI tab, and every change goes in the change log.
 */

const NO_KEY =
  "This server has no encryption key, so it can't keep an AI key safe and won't save one. " +
  "Whoever runs the server can set APP_ENCRYPTION_KEY and restart it.";

const GONE = "This organization no longer exists.";

export async function PUT(request: NextRequest) {
  const gate = await requirePermission("organization:update");
  if (!gate.ok) return gate.response;
  const { principal } = gate;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const input = readAiKeyChange(body);
  if (typeof input === "string") return NextResponse.json({ error: input }, { status: 400 });
  if (encryptionKeySource() === "none") return NextResponse.json({ error: NO_KEY }, { status: 400 });

  try {
    const saved = await saveOrgKey(principal.orgId, input, actorOf(principal));
    if (saved.kind === "no-key") return NextResponse.json({ error: NO_KEY }, { status: 400 });
    if (saved.kind === "not-found") return NextResponse.json({ error: GONE }, { status: 404 });
    return NextResponse.json(await readAiAdminView(principal));
  } catch (error) {
    console.error("Failed to save the organization's AI key:", (error as Error).message);
    return NextResponse.json({ error: "Could not save the AI key. Try again in a moment." }, { status: 503 });
  }
}

export async function DELETE() {
  const gate = await requirePermission("organization:update");
  if (!gate.ok) return gate.response;
  const { principal } = gate;

  try {
    const { removed } = await removeOrgKey(principal.orgId, actorOf(principal));
    return NextResponse.json({ ...(await readAiAdminView(principal)), removed });
  } catch (error) {
    console.error("Failed to remove the organization's AI key:", (error as Error).message);
    return NextResponse.json({ error: "Could not remove the AI key. Try again in a moment." }, { status: 503 });
  }
}

function actorOf(principal: Principal): AiActor {
  return { email: actorFor(principal), role: principal.role };
}
