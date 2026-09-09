import type { NextAuthConfig } from "next-auth";
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
 * Entra ID is only registered when it is actually configured. With the keys
 * absent, constructing the provider yields one that can never complete a
 * sign-in but still throws confusing errors on the callback route; leaving it
 * out entirely means /login simply has nothing to offer, which is the truth.
 */
export const entraConfigured = Boolean(
  process.env.AZURE_AD_CLIENT_ID &&
    process.env.AZURE_AD_CLIENT_SECRET &&
    process.env.AZURE_AD_TENANT_ID
);

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
 * True when a real sign-in could actually complete: somewhere to sign in to,
 * and a secret to sign the resulting session with. When this is false the
 * NextAuth routes cannot run at all, and callers answer for them instead of
 * letting them throw — see app/api/auth/[...nextauth]/route.ts and proxy.ts.
 */
export const authUsable = entraConfigured && secretConfigured;

export const authConfig = {
  providers: entraConfigured
    ? [
        MicrosoftEntraID({
          clientId: process.env.AZURE_AD_CLIENT_ID!,
          clientSecret: process.env.AZURE_AD_CLIENT_SECRET!,
          issuer: `https://login.microsoftonline.com/${process.env.AZURE_AD_TENANT_ID}/v2.0`,
        }),
      ]
    : [],
  pages: {
    signIn: "/login",
    error: "/login",
  },
  session: { strategy: "jwt" },
  callbacks: {
    /**
     * Consulted by the edge proxy for page requests. Roles are NOT checked here —
     * the edge runtime cannot reach the database, so this only answers "is there
     * a session at all". Role enforcement happens in lib/auth-guard.ts, on the
     * node side, where the profile row is readable.
     */
    authorized({ auth }) {
      return Boolean(auth?.user);
    },
  },
  secret: process.env.NEXTAUTH_SECRET,
  trustHost: true,
} satisfies NextAuthConfig;
