import type { NextAuthConfig } from "next-auth";
import type { CredentialsConfig } from "next-auth/providers/credentials";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";

/**
 * The edge-safe half of the NextAuth configuration.
 *
 * proxy.ts runs on the edge runtime, where `pg` cannot load. So the config
 * is split: everything the edge proxy needs (providers, pages, the JWT shape)
 * lives here with no node-only imports, and the database-backed callbacks live
 * in auth.ts, which only ever runs in the node runtime.
 *
 * This is the standard NextAuth v5 split — without it, importing `auth` into
 * the proxy pulls the Postgres driver into the edge bundle and the whole app
 * fails to build.
 */

/**
 * True inside the Schema Studio desktop app (desktop/ at the root of this
 * repository), which starts this server with SCHEMA_STUDIO_DESKTOP=1.
 *
 * The desktop app signs people in its own way, with the "desktop" provider
 * below; lib/desktop-sign-in.ts explains why it cannot use the browser one.
 */
export const desktopMode = process.env.SCHEMA_STUDIO_DESKTOP === "1";

/**
 * Entra ID is only registered when it is actually configured. With the keys
 * absent, constructing the provider yields one that can never complete a
 * sign-in but still throws confusing errors on the callback route; leaving it
 * out entirely means /login simply has nothing to offer, which is the truth.
 *
 * Never inside the desktop app, even if all three keys were somehow set. The
 * desktop build carries no client secret, and Microsoft would refuse to send a
 * person back to the desktop server anyway: it listens on a port picked at
 * random on each start, which is not an address the app registration lists.
 */
export const entraConfigured =
  !desktopMode &&
  Boolean(
    process.env.AZURE_AD_CLIENT_ID &&
      process.env.AZURE_AD_CLIENT_SECRET &&
      process.env.AZURE_AD_TENANT_ID
  );

/**
 * The desktop app's sign-in needs only the two IDs, neither of which is a
 * secret: the app does the Microsoft sign-in itself, in the system browser,
 * and this server only checks the ID token it hands over.
 */
export const desktopConfigured =
  desktopMode &&
  Boolean(process.env.AZURE_AD_CLIENT_ID && process.env.AZURE_AD_TENANT_ID);

/**
 * NextAuth signs its session cookie with this and refuses to start without it.
 *
 * It is checked separately from the provider keys because the failure mode is
 * different: with no secret, NextAuth throws on the FIRST request to any of its
 * routes — including the session read every page makes — so a deployment that
 * simply never set it answered 500 to /api/auth/session on every single page
 * load. Nothing broke visibly, because the bypass supplies its own principal,
 * but the console filled with errors that had nothing to do with the page.
 */
export const secretConfigured = Boolean(process.env.NEXTAUTH_SECRET);

/**
 * True when a real sign-in could actually complete: somewhere to sign in to
 * (the browser's Entra sign-in, or the desktop app's), and a secret to sign
 * the resulting session with. When this is false the NextAuth routes cannot
 * run at all, and callers answer for them instead of letting them throw. See
 * app/api/auth/[...nextauth]/route.ts and proxy.ts.
 */
export const authUsable = (entraConfigured || desktopConfigured) && secretConfigured;

/**
 * How the desktop app signs a person in. By the time this runs the app has
 * already been through Microsoft's sign-in in the system browser, and it posts
 * the ID token it got back; authorize() decides whether to believe it.
 *
 * Written out as a plain object rather than with Auth.js's Credentials()
 * helper, because that helper lives in an ES module that Jest cannot load,
 * and the tests that import this file (proxy.test.ts among them) would all
 * have to mock it. The object is exactly what the helper returns, and
 * `satisfies` still has the compiler check its shape.
 *
 * The token check is imported only when a sign-in is actually being checked.
 * The edge proxy imports this file too, and it never signs anyone in, so it
 * never needs to load the checker or the JWT library under it.
 */
const desktopProvider = {
  id: "desktop",
  name: "Microsoft (desktop app)",
  type: "credentials",
  credentials: { idToken: {} },
  async authorize(credentials) {
    const { verifyDesktopIdToken } = await import("./lib/desktop-sign-in");
    return verifyDesktopIdToken(credentials?.idToken);
  },
} satisfies CredentialsConfig;

export const authConfig = {
  providers: entraConfigured
    ? [
        MicrosoftEntraID({
          clientId: process.env.AZURE_AD_CLIENT_ID!,
          clientSecret: process.env.AZURE_AD_CLIENT_SECRET!,
          issuer: `https://login.microsoftonline.com/${process.env.AZURE_AD_TENANT_ID}/v2.0`,
        }),
      ]
    : desktopConfigured
      ? [desktopProvider]
      : [],
  pages: {
    signIn: "/login",
    error: "/login",
  },
  session: { strategy: "jwt" },
  callbacks: {
    /**
     * Consulted by the edge proxy for page requests. Permissions are NOT checked
     * here: the edge runtime cannot reach the database, so this only answers "is
     * there a session at all". Permission checks happen in lib/auth-guard.ts, on
     * the node side, where what each role may do is readable.
     */
    authorized({ auth }) {
      return Boolean(auth?.user);
    },
  },
  secret: process.env.NEXTAUTH_SECRET,
  trustHost: true,
} satisfies NextAuthConfig;
