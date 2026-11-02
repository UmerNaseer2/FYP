import { NextRequest, NextResponse } from "next/server";
import { claimLink } from "@/lib/agent-db";

/** A device code is 43 characters. */
const LONGEST_DEVICE_CODE = 100;

const NOT_A_CODE = "Send the device code this computer was given.";
const GONE = "This link has ended. Start again from Schema Studio's Settings.";
const COULD_NOT_CHECK = "Could not check this link. Try again in a moment.";

/**
 * POST /api/agent/link/claim
 * A waiting computer asks whether it has been approved: 202 not yet, 200 with its
 * token once, 410 if the link expired or was turned away.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const deviceCode = (body as { deviceCode?: unknown } | null)?.deviceCode;
  if (typeof deviceCode !== "string" || deviceCode === "" || deviceCode.length > LONGEST_DEVICE_CODE) {
    return NextResponse.json({ error: NOT_A_CODE }, { status: 400 });
  }
  try {
    const claim = await claimLink(deviceCode);
    if (claim.kind === "waiting") return NextResponse.json({ waiting: true }, { status: 202 });
    if (claim.kind === "gone") return NextResponse.json({ error: GONE }, { status: 410 });
    return NextResponse.json({ token: claim.token, org: claim.org });
  } catch (error) {
    console.error("Could not check a computer link:", error instanceof Error ? error.name : "unknown error");
    return NextResponse.json({ error: COULD_NOT_CHECK }, { status: 500 });
  }
}
