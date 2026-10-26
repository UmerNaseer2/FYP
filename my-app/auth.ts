import NextAuth from "next-auth";
import { authConfig, entraConfigured } from "./auth.config";
import { upsertProfile } from "@/lib/version-db";

export { entraConfigured };

/**
 * The full NextAuth setup: the edge-safe config plus the database-backed bits.
 *
 * Two things were broken here before and are fixed:
 *   1. It opened its own `new Pool({ connectionString: process.env.DATABASE_URL })`,
 *      and DATABASE_URL is never set — .env.local defines DATABASE_URL_A. Every
 *      role lookup therefore failed and silently fell back to "viewer". It now
 *      uses the app's existing metadata pool (lib/version-db), so there is one
 *      pool and one connection string.
 *   2. Nothing ever created the `profiles` table that role lookups read, so
 *      even a correctly configured sign-in could not resolve a role. The tables
 *      are now created on demand, and a profile and a membership are
 *      provisioned on first sign-in (see upsertProfile).
 */
export const { handlers, signIn, signOut, auth } = NextAuth({
  ...authConfig,
  callbacks: {
    ...authConfig.callbacks,

    /**
     * Runs on sign-in and on every token refresh. Provisioning happens here (not
     * in `session`) because it should happen once per sign-in, not on every
     * session read.
     *
     * When it fails (the database did not answer), nothing is handed out in
     * its place. No profile means no membership, and every gate refuses. It is
     * tried again on later requests until it works, which is what
     * token.profileId is for: a token that has one was provisioned. Once it is
     * there it is never tried again, so somebody an admin removes stays
     * removed until they sign in again, rather than rejoining on their next
     * click.
     */
    async jwt({ token, user }) {
      // At sign-in `user` is the person the provider has just vouched for.
      // After that only the token is left, and its email is the one from that
      // same sign-in.
      const email =
        user?.email ?? (typeof token.profileId !== "number" ? token.email : undefined);
      if (email) {
        try {
          const profile = await upsertProfile(email, user?.name ?? token.name ?? null);
          token.profileId = profile.id;
        } catch (error) {
          console.error("Failed to provision profile on sign-in:", error);
        }
      }
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
