import NextAuth from "next-auth";
import { authConfig, entraConfigured } from "./auth.config";
import { identityFrom, resolveIdentity } from "@/lib/accounts-db";

export { entraConfigured };

/**
 * The full NextAuth setup: the edge-safe config plus the database-backed bits.
 *
 * Signing in decides which person in this app someone is (lib/accounts-db.ts)
 * and puts that person's profile ID in the session. Everything after that
 * keys on the ID: the gates in lib/auth-guard.ts find the person's membership
 * by it on every request, and nothing reads the address a provider sent
 * again. The address is only how someone is first found, and only for the
 * accounts lib/accounts-db.ts trusts with it.
 */
export const { handlers, signIn, signOut, auth } = NextAuth({
  ...authConfig,
  callbacks: {
    ...authConfig.callbacks,

    /**
     * Runs once per sign-in, after the provider has vouched for the account
     * and before any session exists. It is the one place that asks the
     * database who this is, so a sign-in that cannot be settled never becomes
     * a session at all.
     *
     * A string sends the person back to the sign-in page with a reason it
     * explains (app/login/page.tsx). The reason is never "AccessDenied",
     * which is what Auth.js makes of a throw: that would tell somebody whose
     * database was down that they are not allowed in.
     *
     * Auth.js builds the session from this same `user` object once this
     * returns, so setting its ID here is what puts the profile ID in the token
     * (see jwt below). Its address is set to the one the app knows the person
     * by, which can differ from what the provider sent this time.
     */
    async signIn({ user, account, profile }) {
      const who = identityFrom({ user, account, profile });
      if (!who) return "/login?error=NoEmail";
      try {
        const resolved = await resolveIdentity(who);
        if (resolved.kind === "taken") return "/login?error=AccountExists";
        if (resolved.kind === "unverified") return "/login?error=EmailUnverified";
        user.id = String(resolved.profileId);
        user.email = resolved.email;
        return true;
      } catch (error) {
        console.error("Could not settle the account for a sign-in:", error);
        return "/login?error=AccountUnavailable";
      }
    },

    /**
     * Copies the profile ID from the sign-in into the token, and does nothing
     * else. At sign-in `user` is the object signIn above filled in; on every
     * later request there is no `user`, only the token, which already has it.
     * No database work happens here, so reading a session never waits on one.
     *
     * A token with no profile ID (one from before this, or from a sign-in that
     * never finished) reads as signed out everywhere, and its owner signs in
     * again.
     */
    jwt({ token, user }) {
      if (user?.id && /^\d+$/.test(user.id)) token.profileId = Number(user.id);
      return token;
    },

    /**
     * Who someone is, and nothing about what they may do.
     *
     * What a person may do used to be read here, on every session read, and
     * copied into the session. It now lives in `memberships`, one row for each
     * organization the person belongs to, and the gates in lib/auth-guard.ts
     * read it fresh on every request (the screens ask them, through /api/me).
     * So an admin changing someone's role, or ticking a box on the Roles tab,
     * still takes effect on that person's very next request.
     *
     * The token must never be trusted for access. It once was, as a fallback,
     * and that handed a deleted user their old role back: demote an admin to
     * viewer, delete them, and the lookup found no profile, so the app fell
     * back to what the 30-day sign-in token still said, which was whatever
     * they were when they signed in. Admin. The token is a copy of an answer
     * from up to a month ago. Someone with no membership now gets "not a
     * member" from every gate, whatever their token says.
     */
    session({ session, token }) {
      if (typeof token.profileId === "number") {
        session.user.id = String(token.profileId);
      }
      return session;
    },
  },
});

declare module "next-auth" {
  interface Session {
    user: {
      id?: string;
      name?: string;
      email?: string;
    };
  }
}

// Importing the type is what makes the augmentation target resolvable.
import type {} from "next-auth/jwt";

declare module "next-auth/jwt" {
  interface JWT {
    profileId?: number;
  }
}
