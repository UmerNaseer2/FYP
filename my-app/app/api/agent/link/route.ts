import { NextRequest, NextResponse } from "next/server";
import { openLink } from "@/lib/agent-db";
import { LINK_MINUTES, LINK_POLL_SECONDS, cleanLabel, showUserCode } from "@/lib/agent-rules";

const LONGEST_COMPUTER_NAME = 60;

const TOO_MANY = "Too many computers are waiting to be linked. Try again in a few minutes.";
const COULD_NOT_START = "Could not start linking this computer.";

/**
 * POST /api/agent/link
 * A computer asks for a code to show its person. Open to anyone, because a
 * computer has nothing to prove yet: a link does nothing until someone signed in
 * approves it, and the number that may wait at once is capped.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const name = cleanLabel((body as { computerName?: unknown } | null)?.computerName, LONGEST_COMPUTER_NAME);
  try {
    const link = await openLink(name === "" ? "Computer" : name);
    if (link === null) return NextResponse.json({ error: TOO_MANY }, { status: 429 });
    const userCode = showUserCode(link.userCode);
    return NextResponse.json(
      {
        deviceCode: link.deviceCode,
        userCode,
        verifyPath: `/link-computer?code=${userCode}`,
        intervalSeconds: LINK_POLL_SECONDS,
        expiresInSeconds: LINK_MINUTES * 60,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("Could not start a computer link:", error instanceof Error ? error.name : "unknown error");
    return NextResponse.json({ error: COULD_NOT_START }, { status: 500 });
  }
}
