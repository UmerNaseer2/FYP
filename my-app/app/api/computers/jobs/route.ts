import { NextRequest, NextResponse } from "next/server";
import { createAgentJob } from "@/lib/agent-db";
import { connectionsIn, readAgentJob } from "@/lib/agent-jobs";
import { requirePermission } from "@/lib/auth-guard";

const NO_COMPUTER = "That computer is not linked to your account.";
const COMPUTER_OFF = "That computer is off or asleep. Open Schema Studio on it and try again.";
const NOT_SHARED = "That connection is not shared from this computer. Share it in Schema Studio's Settings there.";
const TOO_MANY = "That computer has too many questions waiting. Try again in a moment.";

/**
 * POST /api/computers/jobs { computerId, method, params }
 * Leave a question for one of this person's computers. Answers 201 with an id to
 * read the answer by (app/api/computers/jobs/[id]).
 */
export async function POST(request: NextRequest) {
  const gate = await requirePermission("compare:read");
  if (!gate.ok) return gate.response;
  const { principal } = gate;
  if (principal.profileId === null) return NextResponse.json({ error: NO_COMPUTER }, { status: 404 });

  const body = (await request.json().catch(() => null)) as
    | { computerId?: unknown; method?: unknown; params?: unknown }
    | null;
  const computerId = body?.computerId;
  if (typeof computerId !== "number" || !Number.isSafeInteger(computerId) || computerId < 1) {
    return NextResponse.json({ error: NO_COMPUTER }, { status: 404 });
  }
  const read = readAgentJob(body?.method, body?.params);
  if (!read.ok) return NextResponse.json({ error: read.error }, { status: 400 });

  try {
    const created = await createAgentJob(
      principal.orgId,
      principal.profileId,
      computerId,
      read.job,
      connectionsIn(read.job)
    );
    switch (created.kind) {
      case "created":
        return NextResponse.json({ id: created.id }, { status: 201 });
      case "no-computer":
        return NextResponse.json({ error: NO_COMPUTER }, { status: 404 });
      case "off":
        return NextResponse.json({ error: COMPUTER_OFF }, { status: 409 });
      case "not-shared":
        return NextResponse.json({ error: NOT_SHARED }, { status: 409 });
      case "too-many":
        return NextResponse.json({ error: TOO_MANY }, { status: 429 });
    }
  } catch (error) {
    console.error("Could not ask a computer:", error instanceof Error ? error.name : "unknown error");
    return NextResponse.json({ error: "Could not ask that computer." }, { status: 500 });
  }
}
