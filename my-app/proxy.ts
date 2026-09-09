import NextAuth from "next-auth";
import { NextResponse, type NextRequest } from "next/server";
import { authConfig, authUsable } from "./auth.config";
import { BYPASS_AUTH } from "./lib/auth-mode";

/**
 * The edge proxy: the first line of defence for both pages and API routes.
 *
 * Next.js used to call this file middleware.ts and now calls it proxy.ts —
 * same hook, same position in the request path, renamed in Next 16. Nothing
 * about what it does changed with the name.
 *
 * The project had no such file at all, so the only thing standing between an
 * anonymous request and the whole API was a client-side React guard — which a
 * route handler never runs. This closes that at the edge, before any handler is
 * reached.
 *
 * It answers ONE question: is there a session? Roles are not checked here,
 * because the edge runtime cannot open a Postgres connection to read the
 * profile row. Per-route role enforcement lives in lib/auth-guard.ts, which runs
 * in the node runtime. Both read the same BYPASS_AUTH switch.
 */

type EdgeHandler = (request: NextRequest) => Response | Promise<Response>;

/**
 * Built on first use rather than at import time. NextAuth needs NEXTAUTH_SECRET,
 * and constructing it eagerly would make a missing secret break even the bypass
 * path — which is the one path that is supposed to work without any auth
 * configuration at all.
 */
let enforce: EdgeHandler | null = null;

function getEnforcer(): EdgeHandler {
  if (!enforce) {
    enforce = NextAuth(authConfig).auth((request) => {
      if (request.auth) return NextResponse.next();

      // An unauthenticated API call must get a 401 it can act on, not an HTML
      // redirect to the login page that fetch() would happily treat as success.
      if (request.nextUrl.pathname.startsWith("/api/")) {
        return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
      }

      const loginUrl = new URL("/login", request.nextUrl.origin);
      loginUrl.searchParams.set(
        "callbackUrl",
        request.nextUrl.pathname + request.nextUrl.search
      );
      return NextResponse.redirect(loginUrl);
    }) as unknown as EdgeHandler;
  }
  return enforce;
}

/**
 * Turning the bypass off without configuring sign-in used to reach NextAuth,
 * which threw on the missing secret and answered 500 to every page. Nobody can
 * be signed in in that state, so the answer is the same one an anonymous
 * visitor gets — a redirect to /login, which explains that sign-in is not set
 * up rather than offering a button that can only fail.
 */
function notConfigured(request: NextRequest): Response {
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "Sign-in is not set up on this server." },
      { status: 401 }
    );
  }
  const loginUrl = new URL("/login", request.nextUrl.origin);
  loginUrl.searchParams.set("error", "Configuration");
  return NextResponse.redirect(loginUrl);
}

export default function proxy(request: NextRequest) {
  if (BYPASS_AUTH) return NextResponse.next();
  if (!authUsable) return notConfigured(request);
  return getEnforcer()(request);
}

export const config = {
  /**
   * Everything except:
   *   - /api/auth/*  NextAuth's own endpoints (sign-in would be unreachable)
   *   - /login       the sign-in page itself
   *   - Next.js internals and static files
   */
  matcher: [
    "/((?!api/auth|login|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?)$).*)",
  ],
};
