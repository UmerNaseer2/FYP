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
 * approves it, and the number that may wait at once is capped: in all, and
 * for each caller, so that one caller cannot take every place.
 *
 * The page at `verifyPath` does not read the code from its address: the person
 * types the code their computer shows, so a link sent by a stranger cannot fill
 * it in for them. The code stays in the path only because desktop apps already
 * installed check for it.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const name = cleanLabel((body as { computerName?: unknown } | null)?.computerName, LONGEST_COMPUTER_NAME);
  try {
    const link = await openLink(name === "" ? "Computer" : name, callerAddress(request));
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

/**
 * The network address this request came from, or null when nothing says.
 *
 * The server in front of the app (Vercel, or a reverse proxy) writes it into a
 * header. `x-real-ip` is the plain one. `x-forwarded-for` is a list that each
 * server on the way adds to, so the last entry is the one the nearest server
 * saw for itself; earlier entries are whatever the caller chose to send.
 *
 * Where the app is reached directly, with no such server in front, a caller
 * can write these headers too. The per-caller cap is then only as good as the
 * caller is honest, and the cap on all waiting links is what holds.
 */
function callerAddress(request: NextRequest): string | null {
  const real = request.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const forwarded = request.headers.get("x-forwarded-for")?.split(",").pop()?.trim();
  return forwarded ? forwarded : null;
}
