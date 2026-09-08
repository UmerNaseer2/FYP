import NextAuth from "next-auth";
import { NextResponse, type NextRequest } from "next/server";
import { authConfig } from "./auth.config";
import { BYPASS_AUTH } from "./lib/auth-mode";

/**
 * Edge middleware: the first line of defence for both pages and API routes.
 *
 * The project had no middleware at all, so the only thing standing between an
 * anonymous request and the whole API was a client-side React guard — which a
 * route handler never runs. This closes that at the edge, before any handler is
 * reached.
 *
 * It answers ONE question: is there a session? Roles are not checked here,
 * because the edge runtime cannot open a Postgres connection to read the
 * profile row. Per-route role enforcement lives in lib/auth-guard.ts, which runs
 * in the node runtime. Both read the same BYPASS_AUTH switch.
 */

type EdgeMiddleware = (request: NextRequest) => Response | Promise<Response>;

/**
 * Built on first use rather than at import time. NextAuth needs NEXTAUTH_SECRET,
 * and constructing it eagerly would make a missing secret break even the bypass
 * path — which is the one path that is supposed to work without any auth
 * configuration at all.
 */
let enforce: EdgeMiddleware | null = null;

function getEnforcer(): EdgeMiddleware {
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
    }) as unknown as EdgeMiddleware;
  }
  return enforce;
}

export default function middleware(request: NextRequest) {
  if (BYPASS_AUTH) return NextResponse.next();
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
