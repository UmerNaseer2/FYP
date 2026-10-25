import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { authUsable, desktopMode } from "@/auth.config";
import { LandingPage } from "@/components/landing/LandingPage";
import { BYPASS_AUTH } from "@/lib/auth-mode";
import { encryptionKeySource } from "@/lib/secret-store";

/**
 * The front door: the landing page for a visitor, and a quick hop into the
 * studio for someone who is already signed in.
 *
 * Who sees what:
 *   - Inside the desktop app it forwards to /studio. The app itself only ever
 *     opens /login and /studio, so this is for a "/" typed into the address
 *     bar, and a landing page with "Create account" on it means nothing there.
 *   - On a server with sign-in switched off (NEXT_PUBLIC_AUTH_BYPASS) it shows
 *     the landing page with both buttons going straight into the studio,
 *     because there is no sign-in for them to go to.
 *   - Signed in, it forwards to /studio, the same place a sign-in lands.
 *   - Otherwise it shows the landing page with both buttons going to /login.
 *     The first sign-in is what creates an account, so "Create account" has
 *     nowhere else to go. When sign-in is not set up on this server, /login
 *     says so itself.
 *
 * The proxy lets "/" through without a session (lib/public-paths.ts), so all
 * of the deciding happens here.
 *
 * Rendered on every request, never once at build time. Whether this is the
 * desktop app and whether the server has an encryption key are read from the
 * server's environment, and a page prerendered by `next build` would keep the
 * build machine's answers forever: the Docker image and CI both build with
 * placeholder settings. Only the bypass switch is fixed at build time, because
 * Next writes NEXT_PUBLIC_ values into the code (see lib/auth-mode.ts).
 *
 * NOTE: this is a Server Component, and nothing here may touch `window`. An
 * earlier version tried to finish the Azure sign-in on this page, calling
 * signIn() from "next-auth/react" when the browser came back to "/?code=…".
 * That helper only works in a browser, so every return from Microsoft became a
 * 500 on the front door. NextAuth finishes that exchange at its own callback
 * route (/api/auth/callback/[provider]), and nothing on this page takes part.
 */
export const dynamic = "force-dynamic";

export default async function RootPage() {
  if (desktopMode) redirect("/studio");

  const encryptsPasswords = encryptionKeySource() !== "none";

  if (BYPASS_AUTH) {
    return (
      <LandingPage
        createAccountHref="/studio"
        logInHref="/studio"
        encryptsPasswords={encryptsPasswords}
        demo
      />
    );
  }

  // Outside any try/catch on purpose: redirect() works by throwing, and a catch
  // around it would swallow the redirect and show the landing page instead.
  if (authUsable && (await isSignedIn())) redirect("/studio");

  return <LandingPage createAccountHref="/login" logInHref="/login" encryptsPasswords={encryptsPasswords} />;
}

/**
 * Whether the visitor has a session. Only asked when sign-in is set up: with
 * no secret, NextAuth would throw on the read.
 *
 * A failed read shows the landing page rather than an error page. The visitor
 * can still press "Log in", and the studio checks the session again for itself
 * before it shows anything.
 */
async function isSignedIn(): Promise<boolean> {
  try {
    const session = await auth();
    return Boolean(session?.user);
  } catch (error) {
    console.error("[landing] Could not read the session, so showing the landing page.", error);
    return false;
  }
}
