// POST /api/trial/reset: the Trial Admin's "Reset trial" button.
//
// Puts the shared trial organization back to how it started: its scripts,
// requests, history and demo schemas all go, and it is built again from
// nothing (lib/trial-sandbox.ts). Its GitHub repository and token and its AI
// settings are carried over, so a token saved once stays saved.
//
// When the demo database cannot be rebuilt, nothing changes, and the answer
// (503, code "trial_rebuild_failed") says why in words the Trial Admin can
// read, which the button shows: the database could not be reached, its
// password was changed, a run was holding its tables, and so on. Any other
// failure answers a plain 500. What actually went wrong goes to the log only,
// since it can name the database's host or user.
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
    // Known by its name: the class lives in the module loaded above, which may
    // be the very thing that failed to load. Its message is written for the
    // Trial Admin and names no host or user.
    if (error instanceof Error && error.name === "TrialRebuildError") {
      return NextResponse.json({ code: "trial_rebuild_failed", error: error.message }, { status: 503 });
    }
    return NextResponse.json({ error: "The trial could not be reset just now. Try again in a moment." }, { status: 500 });
  }
}
