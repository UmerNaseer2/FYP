import { signOut } from "next-auth/react";
import { getDesktopBridge } from "@/lib/desktop-bridge";

/**
 * Sign out, wherever the app is running. The Sign out button on the studio
 * rail uses it, and so does the guard's "not a member" screen.
 *
 * In a browser the page goes to `callbackUrl` afterwards: the login screen
 * unless the caller says otherwise. The invitation page says otherwise, so
 * that someone who signs out to use another account comes back to the same
 * invitation once they have (lib/callback-url.ts loginHref). The desktop app
 * always shows its own login screen; it has no invitation page to come back to.
 *
 * The desktop app also holds the Microsoft account itself, so that it can keep
 * checking it in the background. Signing out of the session alone would leave
 * that behind, so the app signs out of both and then shows the login screen on
 * its own.
 *
 * In a browser, next-auth ends the session, and then this asks the server
 * whether a session is still there. It can be: a call to /api/auth/session
 * that was still open when the person pressed Sign out comes back afterwards
 * and hands the browser its cookie again. If so, it signs out again (a few
 * tries at most), and only then loads the login screen. Without the second
 * look, Sign out sometimes left the person signed in.
 *
 * Both ways load a new page, so nothing the old page knew survives to be shown
 * to whoever signs in next, including what hooks/useUser learned about the
 * person's access. That is why nothing here has to be forgotten by hand.
 */
export async function signOutEverywhere(callbackUrl = "/login") {
  const desktop = getDesktopBridge();
  if (desktop) {
    await desktop.signOut();
    return;
  }
  for (let attempt = 0; attempt < SIGN_OUT_TRIES; attempt++) {
    await signOut({ redirect: false });
    if (!(await stillSignedIn())) break;
  }
  pageLoader.load(callbackUrl);
}

/** How many times Sign out tries before it loads the next page anyway. */
const SIGN_OUT_TRIES = 3;

/**
 * Loads a page the ordinary way, so nothing the old page knew survives. It is
 * an object so that a test can watch it: a test page cannot really go anywhere.
 */
export const pageLoader = {
  load(url: string) {
    window.location.assign(url);
  },
};

/** Asks the server whether this browser still has a session. */
async function stillSignedIn(): Promise<boolean> {
  try {
    const response = await fetch("/api/auth/session", { cache: "no-store" });
    const session = (await response.json()) as { user?: unknown } | null;
    return Boolean(session?.user);
  } catch {
    // No answer is not a session. The login screen is the right place to land.
    return false;
  }
}
