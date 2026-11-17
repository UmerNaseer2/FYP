import { NextResponse, type NextRequest } from "next/server";
import { handlers } from "@/auth";
import { authUsable } from "@/auth.config";

/**
 * NextAuth's own endpoints, with one thing in front of them.
 *
 * NextAuth throws if it has no secret, and it has no secret until someone sets
 * NEXTAUTH_SECRET. That threw on /api/auth/session too — the request the
 * SessionProvider makes on every page — so an app running on the auth bypass,
 * which is the configuration the project is developed in, answered 500 to a
 * question whose true answer is simply "nobody is signed in".
 *
 * So when sign-in cannot run, the three read-only endpoints answer honestly and
 * everything else says why in words. When it can, this is a pass-through.
 */

/** The answers that are true when there is no sign-in to be had. */
const OFFLINE_ANSWERS: Record<string, unknown> = {
  // No session, which is exactly what the browser needs to hear.
  session: null,
  // Nothing to sign in with — the login page reads this and says so.
  providers: {},
  // A token for a form that cannot be submitted anywhere.
  csrf: { csrfToken: "" },
};

/** The last path segment: "session", "providers", "signin", … */
function endpoint(request: NextRequest): string {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

function offlineResponse(request: NextRequest): NextResponse | null {
  if (authUsable) return null;

  const name = endpoint(request);
  if (name in OFFLINE_ANSWERS) {
    return NextResponse.json(OFFLINE_ANSWERS[name]);
  }
  return NextResponse.json(
    {
      error:
        "Sign-in is not set up on this server. It needs NEXTAUTH_SECRET and the " +
        "three AZURE_AD_* keys.",
    },
    { status: 503 }
  );
}

export async function GET(request: NextRequest) {
  return offlineResponse(request) ?? handlers.GET(request);
}

export async function POST(request: NextRequest) {
  return offlineResponse(request) ?? handlers.POST(request);
}
