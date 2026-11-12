// POST /api/trial/reset: the Trial Admin's "Reset trial" button.
//
// Puts the shared trial organization back to how it started: its scripts,
// requests, history and demo databases all go, and it is built again from
// nothing (lib/trial-sandbox.ts). Its GitHub repository and token and its AI
// settings are carried over, so a token saved once stays saved.
//
// Only the Trial Admin, and only in the trial: any other organization answers
// 404, so this can never delete a real one. A reset pressed again within a few
// seconds of the last one does nothing, the trial being fresh already.

import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth-guard";
import { ADMIN_ROLE } from "@/lib/permissions";
import { isTrialOrg } from "@/lib/trial-rules";

export async function POST() {
  const gate = await requirePermission("organization:read");
  if (!gate.ok) return gate.response;
  if (!isTrialOrg(gate.principal.orgSlug)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  if (gate.principal.role !== ADMIN_ROLE) {
    return NextResponse.json({ error: "Only the Trial Admin can reset the trial." }, { status: 403 });
  }
  try {
    // Loaded here, since lib/trial-sandbox.ts opens the database as it loads.
    const { resetTrial } = await import("@/lib/trial-sandbox");
    await resetTrial();
    return NextResponse.json({ reset: true });
  } catch (error) {
    console.error("Could not reset the trial:", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ error: "The trial could not be reset just now. Try again in a moment." }, { status: 500 });
  }
}
