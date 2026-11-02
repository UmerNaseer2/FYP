/**
 * The paths anyone can reach, signed in or not.
 *
 * proxy.ts lets these through before it looks for a session, so they open
 * even on a server where sign-in is not set up. Everything else still needs a
 * session, and /login and NextAuth's own routes are left out by the proxy's
 * matcher instead.
 *
 * Exact paths only, no prefixes: "/" here must not open "/studio".
 *
 * Add a page here only when it shows nothing that belongs to an organization
 * or a person. A public page does its own deciding about who is signed in (the
 * landing page, app/page.tsx, sends a signed-in visitor on to the studio). An
 * endpoint on this list does its own checking (the drift tick has no person behind
 * it, and checks a shared secret). The phone app's two files have to be there for
 * a browser to install the app or show an alert, whoever is signed in, and hold
 * nothing about anyone.
 *
 * Edge-safe: the proxy runs on the edge runtime, so this file imports nothing.
 */
const PUBLIC_PATHS: ReadonlySet<string> = new Set([
  "/",
  "/api/internal/drift-tick",
  "/sw.js",
  "/manifest.webmanifest",
]);

/** True for a page that opens without a session. Takes a pathname, no query string. */
export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname);
}
