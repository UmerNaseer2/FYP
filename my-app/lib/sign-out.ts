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
 * its own. In a browser, next-auth ends the session and sends the page to the
 * login screen.
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
  await signOut({ callbackUrl });
}
