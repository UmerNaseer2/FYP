import type { NextAuthConfig, Profile } from "next-auth";
import GitHub from "next-auth/providers/github";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import { isPlaceholderSecret } from "./lib/placeholder-secrets";

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
 * Whether the Microsoft sign-in takes accounts from outside the home tenant:
 * other organizations' work accounts, and personal Microsoft accounts.
 *
 * Off unless set to exactly "true", because it has to match the app
 * registration in Azure. A registration that takes only its own tenant's
 * accounts refuses the sign-in page this switches to (Microsoft's
 * AADSTS50194), so turning it on before the registration allows "any
 * account" would lock everyone out, the home tenant included. The steps are
 * in the admin guide. Who may do what is unchanged either way: someone from
 * outside the home tenant gets an account and nothing more until an admin
 * invites them or they start an organization of their own
 * (lib/accounts-db.ts).
 */
export const entraAnyAccount = process.env.AZURE_AD_ANY_ACCOUNT === "true";

/**
 * GitHub sign-in, registered only when its OAuth app's two keys are set, for
 * the same reason as Entra above.
 */
export const githubConfigured = Boolean(
  process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
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
 *
 * The placeholder docker-compose.yml used to fill in does not count: it is
 * written in this repository, so anyone could sign a session cookie with it
 * and be let in as whoever they liked (lib/placeholder-secrets.ts).
 */
export const secretConfigured =
  Boolean(process.env.NEXTAUTH_SECRET) && !isPlaceholderSecret(process.env.NEXTAUTH_SECRET);

/**
 * True when a real sign-in could actually complete: somewhere to sign in to
 * (Microsoft or GitHub), and a secret to sign the resulting session with. When this is false the NextAuth routes cannot
 * run at all, and callers answer for them instead of letting them throw. See
 * app/api/auth/[...nextauth]/route.ts and proxy.ts.
 */
export const authUsable =
  (entraConfigured || githubConfigured) && secretConfigured;

/**
 * Reads who signed in with GitHub, and whether GitHub has checked their
 * address. Auth.js calls this in place of its own reading of the account.
 *
 * Its own reading takes the address on the public profile, and asks for the
 * list of addresses only when there is none, and keeps nothing about whether
 * an address was ever confirmed. This always asks for the list, takes the one
 * marked primary (the one GitHub sends mail to), and records its "verified"
 * flag as email_verified. lib/accounts-db.ts makes a new account only for a
 * checked address, because the address is what an invitation is sent to and
 * what another way of signing in would be matched on later. An unchecked one
 * could be anybody's.
 *
 * If the list cannot be read (the person turned down the user:email scope, or
 * GitHub is having a moment), the public address is kept and marked
 * unchecked, so that person can still sign in to an account they already
 * have but cannot start one.
 *
 * Exported for tests/auth-config-github.test.ts. Auth.js's GitHub helper is an
 * ES module Jest cannot load, so the tests replace it, and this would go with
 * it if it lived inside the helper's options.
 */
export async function readGitHubAccount({
  tokens,
}: {
  tokens: { access_token?: string };
}): Promise<Profile> {
  const headers = {
    Authorization: `Bearer ${tokens.access_token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "schema-studio",
  };
  const response = await fetch("https://api.github.com/user", { headers });
  if (!response.ok) {
    throw new Error(`GitHub did not say who signed in (HTTP ${response.status}).`);
  }
  const account = (await response.json()) as Profile;
  account.email_verified = false;

  const emails = await fetch("https://api.github.com/user/emails", { headers });
  if (emails.ok) {
    type Entry = { email?: unknown; primary?: unknown; verified?: unknown };
    const list = (await emails.json()) as Entry[];
    const primary = Array.isArray(list) ? list.find((entry) => entry?.primary === true) : undefined;
    if (primary && typeof primary.email === "string") {
      account.email = primary.email;
      account.email_verified = primary.verified === true;
    }
  }
  return account;
}

/**
 * Each kind of sign-in this file can offer. Named rather than left as
 * NextAuthConfig["providers"], which also allows a provider written as a
 * function and so has no `id` to read without calling it.
 */
type Provider = ReturnType<typeof MicrosoftEntraID> | ReturnType<typeof GitHub>;

/**
 * The ways to sign in, in the order the sign-in page shows them.
 *
 * The Microsoft issuer is the home tenant's own, or with entraAnyAccount the
 * "common" one, which takes any Microsoft account. Auth.js reads the tenant
 * out of a token from the common issuer and checks it against that tenant's
 * published keys and name, so a token is never taken on its own word.
 */
function providers(): Provider[] {
  const list: Provider[] = [];
  if (entraConfigured) {
    const tenant = entraAnyAccount ? "common" : process.env.AZURE_AD_TENANT_ID;
    list.push(
      MicrosoftEntraID({
        clientId: process.env.AZURE_AD_CLIENT_ID!,
        clientSecret: process.env.AZURE_AD_CLIENT_SECRET!,
        issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
      })
    );
  }
  if (githubConfigured) {
    list.push(
      GitHub({
        clientId: process.env.GITHUB_CLIENT_ID!,
        clientSecret: process.env.GITHUB_CLIENT_SECRET!,
        userinfo: { url: "https://api.github.com/user", request: readGitHubAccount },
      })
    );
  }
  return list;
}

export const authConfig = {
  providers: providers(),
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
