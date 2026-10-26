import { signOut } from "next-auth/react";
import { getDesktopBridge } from "@/lib/desktop-bridge";

/**
 * Sign out, wherever the app is running. The Sign out button on the studio
 * rail uses it, and so does the guard's "not a member" screen.
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
export async function signOutEverywhere() {
  const desktop = getDesktopBridge();
  if (desktop) {
    await desktop.signOut();
    return;
  }
  await signOut({ callbackUrl: "/login" });
}
