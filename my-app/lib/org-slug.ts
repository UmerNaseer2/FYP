/**
 * The shape of an organization's slug, the part of its address after the
 * domain: lowercase letters, digits and dashes, 3 to 40 characters, starting
 * and ending with a letter or digit.
 *
 * Written once so the CHECK constraint in lib/db/bootstrap.ts and anything in
 * the app that validates a slug agree, the same way ENVIRONMENT_SQL_LIST there
 * is built from lib/environments.
 */
export const ORG_SLUG_PATTERN = "^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$";

const SLUG = new RegExp(ORG_SLUG_PATTERN);

/**
 * The header a screen's API calls carry to say which organization they act
 * in: the slug from the address the page was opened at (see lib/api-fetch.ts).
 * lib/auth-guard.ts reads it and checks the caller's membership there.
 *
 * A header rather than the slug in every API path, because the routes then
 * stay where they are and so do the phone and the desktop, which call them
 * from outside any page.
 */
export const ORG_HEADER = "x-schema-studio-org";

/**
 * Words an organization may not take as its slug, because the address they
 * make already means something else.
 *
 * An organization's pages sit at /<slug>/..., in app/[org]. Next.js serves a
 * folder with a fixed name before a dynamic one, so an organization called
 * "login" would never see its own pages: /login would always be the sign-in
 * page. Every top-level folder in app/ is listed here for that reason, and
 * tests/org-slug.test.ts fails when a new one is added without it. The
 * studio's own pages are among them, because their old addresses (/studio,
 * /compare and the rest) still work and send people on to their organization.
 *
 * The rest are kept back for pages that are likely to come, so that adding
 * one later never takes an address an organization already has. Anything
 * that cannot match ORG_SLUG_PATTERN anyway (_next, favicon.ico) is left out.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  // Folders in app/ today.
  "api",
  "login",
  "studio",
  "compare",
  "script-editor",
  "deploy",
  "versionsync",
  "drift",
  "performance",
  "visualizer",
  "connections",
  "admin",
  "schemas",
  // Kept back for pages to come.
  "invite",
  "invites",
  "onboarding",
  "new",
  "settings",
  "orgs",
  "organizations",
  "account",
  "signup",
  "logout",
  "auth",
  "help",
  "docs",
  "about",
  "pricing",
  "static",
  "public",
  "assets",
  "www",
  "app",
  "robots",
  "sitemap",
  "manifest",
]);

/** True for a word an organization may not take as its slug (see RESERVED_SLUGS). */
export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug);
}

/** True for a well-formed slug that is free for an organization to hold. */
export function isOrgSlug(value: string): boolean {
  return SLUG.test(value) && !isReservedSlug(value);
}

/**
 * The organization an address names, or null when it names none.
 *
 * "/acme/compare?x=1" names "acme". "/", "/login" and "/studio" name none:
 * the first is the landing page, and the others are the app's own pages, never
 * an organization's (see RESERVED_SLUGS). Only the path is read, so pass
 * location.pathname rather than the whole address.
 */
export function orgSlugFromPath(pathname: string): string | null {
  const first = pathname.split("/")[1] ?? "";
  return isOrgSlug(first) ? first : null;
}

/**
 * An address inside an organization: "/studio" in "acme" is "/acme/studio".
 *
 * With no organization it is the path as given, which is what the page tests
 * and the few screens that sit outside every organization want. `path` starts
 * with "/" and may carry a query or a fragment.
 */
export function orgHref(slug: string | null | undefined, path: string): string {
  return slug ? `/${slug}${path}` : path;
}
