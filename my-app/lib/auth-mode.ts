/**
 * The single switch that decides whether authentication is enforced.
 *
 * This module is deliberately isomorphic — no "use client", no "use server", no
 * node-only imports — so the client guard (components/AuthGuard.tsx), the edge
 * proxy and the server route gate (lib/auth-guard.ts) all read the SAME
 * value. Before this existed the bypass was a hard-coded const inside a client
 * component, which meant the API routes were open whether or not the UI was.
 *
 * DEFAULT: bypass is ON. The project is still being tested end to end and the
 * Microsoft Entra keys are not configured, so a real sign-in cannot complete.
 * Turning auth on is one line in .env.local:
 *
 *     NEXT_PUBLIC_AUTH_BYPASS=false
 *
 * ...AND A REBUILD. A NEXT_PUBLIC_ variable is not read at run time: Next
 * substitutes the literal text `process.env.NEXT_PUBLIC_AUTH_BYPASS` below for
 * its value while compiling, so what ships is a hard-coded true or false. In
 * development the dev server recompiles and the edit takes effect on the next
 * request; a built app does not, and editing .env.local next to it changes
 * nothing at all. `npm run build` again, or for Docker pass it at build time
 * (`--build-arg NEXT_PUBLIC_AUTH_BYPASS=false`, which is what Dockerfile:33-35
 * is for) — setting it in `docker run -e` is the version that quietly does
 * nothing. That substitution is also why the variable is written out in full
 * here rather than looked up through a helper or a computed key: Next matches
 * the text, so `process.env[name]` is never replaced and always reads
 * undefined in the browser.
 *
 * Everything needed for that flip is built: the edge proxy, per-route role gates,
 * the `profiles` table and its bootstrap. The only outstanding prerequisites are
 * the four secrets (AZURE_AD_CLIENT_ID / _SECRET / _TENANT_ID, NEXTAUTH_SECRET).
 */

/**
 * The spellings that turn the bypass OFF, i.e. that turn real auth ON.
 *
 * More than just "false" on purpose, and the asymmetry is the point. Getting
 * this wrong in one direction leaves an app open that its owner believes is
 * shut — and it looks fine, because there is no sign-in screen either way, so
 * nothing on screen says which one you got. `False`, `FALSE`, `0` and `false `
 * with a stray space from the end of a line in .env.local are all things a
 * person writes meaning off; every one of them used to leave the bypass on.
 * Wrong in the other direction merely locks you out of your own dev server,
 * which you notice within seconds.
 */
const BYPASS_OFF = new Set(["false", "0", "no", "off"]);

// Trimmed and lowercased first — see BYPASS_OFF. Unset still means ON, which is
// the documented default above and what every existing checkout relies on.
const bypassSetting = (process.env.NEXT_PUBLIC_AUTH_BYPASS ?? "").trim().toLowerCase();

export const BYPASS_AUTH: boolean = !BYPASS_OFF.has(bypassSetting);

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

/**
 * The shape actorFor needs. Principal (lib/auth-guard) satisfies it; this is
 * written structurally so the audit helper does not have to live beside the
 * gate that builds one — see below for why that matters.
 */
export type Actor = { email: string; bypass: boolean };

/**
 * What to record as the actor when a principal does something worth auditing.
 *
 * Deliberately not just `principal.email`. A principal from the bypass never
 * signed in — BYPASS_PRINCIPAL is a value in the config, the same one for
 * everybody — so writing its address into a ledger would record a named person
 * as having run a migration they may never have heard of. The audit-relevant
 * fact with the bypass on is that authentication was off, and that is what is
 * stored instead. It is not an email address on purpose: nothing reading the
 * column later can mistake it for one.
 *
 * It lives here rather than in lib/auth-guard because it is pure. auth-guard
 * imports next-auth, which ships as ESM Jest cannot load, so every route test
 * replaces that whole module with a stand-in — and a route importing this from
 * there would get `undefined` in every one of those tests. A function with no
 * dependencies has no business sitting behind one.
 */
export const BYPASS_ACTOR = "(authentication bypassed)";

/** Who to record. See BYPASS_ACTOR for why this is not always the email. */
export function actorFor(principal: Actor): string {
  return principal.bypass ? BYPASS_ACTOR : principal.email;
}
