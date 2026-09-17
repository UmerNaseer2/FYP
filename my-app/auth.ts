import NextAuth from "next-auth";
import { authConfig, entraConfigured } from "./auth.config";
import { upsertProfile, getProfileRole } from "@/lib/version-db";
import { toRole, DEFAULT_ROLE } from "@/lib/auth-mode";

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
 *   2. Nothing ever created the `profiles` table the session callback reads, so
 *      even a correctly configured sign-in could not resolve a role. The table
 *      is now created on demand and a profile row is provisioned on first
 *      sign-in (see upsertProfile).
 */
export const { handlers, signIn, signOut, auth } = NextAuth({
  ...authConfig,
  callbacks: {
    ...authConfig.callbacks,

    /**
     * Runs on sign-in and on every token refresh. Provisioning happens here (not
     * in `session`) because it should happen once per sign-in, not on every
     * session read.
     */
    async jwt({ token, user }) {
      if (user?.email) {
        try {
          const profile = await upsertProfile(user.email, user.name ?? null);
          token.role = profile.role;
          token.profileId = profile.id;
        } catch (error) {
          // A provisioning failure must not hand out a role. Fall back to the
          // least privilege and let the session callback try again.
          console.error("Failed to provision profile on sign-in:", error);
          token.role = DEFAULT_ROLE;
        }
      }
      return token;
    },

    /**
     * The role is re-read from the database on each session read rather than
     * trusted from the token, so that an admin demoting someone takes effect
     * immediately instead of waiting for their token to expire.
     *
     * The token's own role is deliberately NOT used as a fallback. It used to
     * be, and that handed a deleted user their old role back: demote an admin
     * to viewer, delete them, and the lookup below returns null — no profile —
     * so the app fell back to what the 30-day sign-in token still said, which
     * is whatever they were when they signed in. Admin. The token is a copy of
     * the answer from up to a month ago; re-reading it on the one path where
     * the database says "this person is gone" undoes the whole point of
     * re-reading.
     *
     * null here means exactly one thing: getProfileRole found no row. A
     * database that cannot be read throws instead, and lands in the catch
     * below, so the two cases never arrive looking alike. No row means viewer
     * — the least this app gives anyone. They keep a session and can still see
     * the read-only screens; they simply cannot act. Signing them out would
     * also be defensible, but it turns a deleted profile into a confusing
     * logout loop for someone whose next sign-in would just re-provision them.
     */
    async session({ session, token }) {
      if (session.user?.email) {
        try {
          const role = await getProfileRole(session.user.email);
          session.user.role = toRole(role);
        } catch (error) {
          console.error("Failed to read profile role:", error);
          session.user.role = DEFAULT_ROLE;
        }
      }
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
      role?: string;
    };
  }
}

// Importing the type is what makes the augmentation target resolvable.
import type {} from "next-auth/jwt";

declare module "next-auth/jwt" {
  interface JWT {
    role?: string;
    profileId?: number;
  }
}
