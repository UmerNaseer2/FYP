import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  BYPASS_AUTH,
  BYPASS_PRINCIPAL,
  DEFAULT_ROLE,
  roleAtLeast,
  toRole,
  type Role,
} from "./auth-mode";

/**
 * Server-side authentication and role enforcement for API routes.
 *
 * Before this existed, exactly one of the twenty-one route handlers checked a
 * session (`/api/admin/users`). Everything else — saving credentials, running
 * DDL against a target database, reverting a migration, pushing to the script
 * registry — was reachable by anyone who could reach the app. The client-side
 * <AuthGuard> protected none of it, because a route handler never runs React.
 *
 * Every route now opens with one of these gates. They honour the same
 * BYPASS_AUTH switch as the UI (lib/auth-mode), so with the bypass on the whole
 * app behaves exactly as it did before, and turning the bypass off enforces
 * every route at once.
 */

export type Principal = {
  email: string;
  name: string;
  role: Role;
  /** True when this principal came from the bypass, not from a real session. */
  bypass: boolean;
};

export type Gate =
  | { ok: true; principal: Principal }
  | { ok: false; response: NextResponse };

/**
 * Resolve who is calling. Returns null when there is no session (and the bypass
 * is off). Never throws — an auth backend that is down must read as "not signed
 * in", not as a 500 that leaks the reason.
 */
export async function getPrincipal(): Promise<Principal | null> {
  if (BYPASS_AUTH) {
    return { ...BYPASS_PRINCIPAL, bypass: true };
  }

  try {
    const session = await auth();
    const email = session?.user?.email;
    if (!email) return null;

    return {
      email,
      name: session.user.name ?? email,
      role: toRole(session.user.role ?? DEFAULT_ROLE),
      bypass: false,
    };
  } catch (error) {
    console.error("Session lookup failed:", error);
    return null;
  }
}

/**
 * Require a session with at least `minimum` privilege.
 *
 * Returns a discriminated union rather than throwing, so the call site reads:
 *
 *     const gate = await requireRole("editor");
 *     if (!gate.ok) return gate.response;
 *
 * Using a union (rather than `instanceof NextResponse`) means TypeScript
 * narrows `gate.principal` for you and a forgotten check is a type error at the
 * point of use, not a silent hole.
 */
export async function requireRole(minimum: Role): Promise<Gate> {
  const principal = await getPrincipal();

  if (!principal) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Sign in to continue." },
        { status: 401 }
      ),
    };
  }

  if (!roleAtLeast(principal.role, minimum)) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: `This action needs the "${minimum}" role or higher. Yours is "${principal.role}".`,
        },
        { status: 403 }
      ),
    };
  }

  return { ok: true, principal };
}

/**
 * Reading data: listing connections, previewing a diff, running a preflight.
 * Nothing here changes state in the app or in a target database.
 */
export const requireViewer = () => requireRole("viewer");

/**
 * Changing something: saving a connection, applying or reverting a migration,
 * pushing to the registry, tracking or rebaselining a schema.
 */
export const requireEditor = () => requireRole("editor");

/** Managing other people's access. */
export const requireAdmin = () => requireRole("admin");
