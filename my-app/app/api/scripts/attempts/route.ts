import { NextRequest, NextResponse } from "next/server";
import { requireViewer } from "@/lib/auth-guard";
import { listDeployAttempts, type DeployAttemptRow } from "@/lib/deploy-attempts-db";

// GET /api/scripts/attempts?connectionId=<id>&schema=<name>&limit=<n>
//
// The deploy audit trail for one schema — spec feature 07, "Track SQL
// execution history for auditing".
//
// Everything else that reads deploy history reads the TARGET: preflight reads
// its script_patch table for what it has applied, and the revert route reads
// script_patch_reverted for what was undone. Both of those are records of
// things that worked. This route reads the app's own database instead, where
// the apply route records every attempt — including the ones the target has no
// memory of, because the transaction that would have written them was rolled
// back, or was never opened at all.
//
// A viewer gate rather than an editor one: reading what was attempted is how
// somebody who cannot deploy finds out why a deploy did not happen, and an
// audit trail only the people being audited can read is not much of one. No
// credentials are involved — this route never opens the target.

export type DeployAttemptsResponse = {
  schema: string;
  attempts: DeployAttemptRow[];
};

export async function GET(request: NextRequest) {
  const gate = await requireViewer();
  if (!gate.ok) return gate.response;

  const params = request.nextUrl.searchParams;
  const connectionId = Number(params.get("connectionId"));
  const schema = (params.get("schema") ?? "").trim();
  const rawLimit = params.get("limit");

  if (!Number.isInteger(connectionId) || connectionId <= 0) {
    return NextResponse.json({ error: "connectionId must be a positive integer." }, { status: 400 });
  }
  if (!schema) {
    return NextResponse.json({ error: "schema is required." }, { status: 400 });
  }

  try {
    // A limit that will not parse is left out rather than refused: the reader
    // wants the history, and the query clamps whatever it is given anyway.
    const limit = rawLimit !== null && Number.isFinite(Number(rawLimit)) ? Number(rawLimit) : undefined;
    const attempts = await listDeployAttempts({ connectionId, schemaName: schema, limit });
    const body: DeployAttemptsResponse = { schema, attempts };
    return NextResponse.json(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Deploy attempts — read failed:", message);
    return NextResponse.json(
      {
        error:
          `Could not read the deploy history for schema "${schema}". This reads the app's ` +
          `own database, not the target, so the target is not the problem. Details: ${message}`,
      },
      { status: 503 }
    );
  }
}
