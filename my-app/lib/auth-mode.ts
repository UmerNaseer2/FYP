/**
 * The single switch that decides whether authentication is enforced.
 *
 * This module is deliberately isomorphic — no "use client", no "use server", no
 * node-only imports — so the client guard (components/AuthGuard.tsx), the edge
 * proxy and the server route gate (lib/auth-guard.ts) all read the SAME
 * value. Before this existed the bypass was a hard-coded const inside a client
 * component, which meant the API routes were open whether or not the UI was.
 *
 * DEFAULT: bypass is OFF — authentication is enforced. Turning it on for
 * testing is one line in .env.local:
 *
 *     NEXT_PUBLIC_AUTH_BYPASS=true
 *
 * It used to be the other way round, because the Microsoft Entra keys are not
 * configured yet and a real sign-in cannot complete, so an unset variable let a
 * fresh checkout be used straight away. That is the wrong way for a switch that
 * decides whether an app is open to be wrong. Both mistakes are easy to make
 * and only one of them is visible: a checkout that comes up locked tells you so
 * on the first click, while one that comes up open used to look exactly like
 * one that is properly signed in — there is no sign-in screen either way. The
 * studio rail now says so out loud, under the name in its bottom-left corner:
 * an "auth off" pill beside the role whenever BYPASS_AUTH is true (see
 * components/studio/StudioSidebar.tsx). That makes the state readable; it does
 * not make it safe, because the pill is only on screens somebody opens, and a
 * deployment nobody has looked at is exactly the case this default is for. The
 * same asymmetry already decided the spellings below; it still decides the
 * default too.
 *
 * So the deployment that forgets this variable is refused rather than served.
 * What that costs is that a fresh checkout needs the line above before it can
 * be used at all, which is one line and one error message away from fixed.
 *
 * ...AND A REBUILD. A NEXT_PUBLIC_ variable is not read at run time: Next
 * substitutes the literal text `process.env.NEXT_PUBLIC_AUTH_BYPASS` below for
 * its value while compiling, so what ships is a hard-coded true or false. In
 * development the dev server recompiles and the edit takes effect on the next
 * request; a built app does not, and editing .env.local next to it changes
 * nothing at all. `npm run build` again, or for Docker pass it at build time
 * (`--build-arg NEXT_PUBLIC_AUTH_BYPASS=true` for a testing image, which is
 * what the ARG in the Dockerfile is for) — setting it in `docker run -e` is the
 * version that quietly does nothing. That substitution is also why the variable
 * is written out in full here rather than looked up through a helper or a
 * computed key: Next matches the text, so `process.env[name]` is never replaced
 * and always reads undefined in the browser.
 *
 * Everything the enforced path needs is built: the edge proxy, per-route role
 * gates, the `profiles` table and its bootstrap. What is still missing is the
 * four secrets (AZURE_AD_CLIENT_ID / _SECRET / _TENANT_ID, NEXTAUTH_SECRET), and
 * until they exist a sign-in cannot COMPLETE — so with this default a checkout
 * that has not set the variable is shut, not merely asked to sign in. That is
 * the intended reading: an app nobody can get into is a five-minute fix, and an
 * app everybody can get into is not something you find out about at all.
 */

/**
 * The spellings that turn the bypass ON, i.e. that switch real auth OFF.
 *
 * An allow-list rather than a deny-list, for the reason given above: what is
 * not understood has to land on the safe side. More than just "true" on
 * purpose — `True`, `TRUE`, `1`, `yes`, `on` and `true ` with a stray space
 * from the end of a line in .env.local are all things a person writes meaning
 * on, and each of them getting you a locked app you meant to leave open would
 * be an hour of confusion for no reason.
 *
 * Every OTHER value, including a typo, an empty string and the variable not
 * being set at all, leaves authentication enforced. A misspelling of "true"
 * costs you a sign-in prompt you expected not to see; a misspelling in the
 * deny-list this replaced left the app open to everybody with nothing to see.
 */
const BYPASS_ON = new Set(["true", "1", "yes", "on"]);

// Trimmed and lowercased first — see BYPASS_ON. Anything not in that set, unset
// included, means real authentication.
const bypassSetting = (process.env.NEXT_PUBLIC_AUTH_BYPASS ?? "").trim().toLowerCase();

export const BYPASS_AUTH: boolean = BYPASS_ON.has(bypassSetting);

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
