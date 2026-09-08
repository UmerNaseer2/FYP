/**
 * The single switch that decides whether authentication is enforced.
 *
 * This module is deliberately isomorphic — no "use client", no "use server", no
 * node-only imports — so the client guard (components/AuthGuard.tsx), the edge
 * middleware and the server route gate (lib/auth-guard.ts) all read the SAME
 * value. Before this existed the bypass was a hard-coded const inside a client
 * component, which meant the API routes were open whether or not the UI was.
 *
 * DEFAULT: bypass is ON. The project is still being tested end to end and the
 * Microsoft Entra keys are not configured, so a real sign-in cannot complete.
 * Turning auth on is one line in .env.local:
 *
 *     NEXT_PUBLIC_AUTH_BYPASS=false
 *
 * Everything needed for that flip is built: middleware, per-route role gates,
 * the `profiles` table and its bootstrap. The only outstanding prerequisites are
 * the four secrets (AZURE_AD_CLIENT_ID / _SECRET / _TENANT_ID, NEXTAUTH_SECRET).
 */
export const BYPASS_AUTH: boolean = process.env.NEXT_PUBLIC_AUTH_BYPASS !== "false";

/** Roles, lowest privilege first. Order is meaningful — see roleAtLeast(). */
export const ROLES = ["viewer", "editor", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const DEFAULT_ROLE: Role = "viewer";

/** Narrow an arbitrary string (a DB value, a token claim) to a known role. */
export function toRole(value: unknown): Role {
  return (ROLES as readonly string[]).includes(String(value))
    ? (String(value) as Role)
    : DEFAULT_ROLE;
}

/** True when `actual` is at least as privileged as `required`. */
export function roleAtLeast(actual: Role, required: Role): boolean {
  return ROLES.indexOf(actual) >= ROLES.indexOf(required);
}

/**
 * Who the app acts as while the bypass is on. Full privileges, so testing sees
 * exactly the app a real admin would; clearly labelled so it can never be
 * mistaken for a signed-in person in a log or an audit row.
 */
export const BYPASS_PRINCIPAL = {
  email: "bypass@local",
  name: "Auth bypass (testing)",
  role: "admin" as Role,
};
