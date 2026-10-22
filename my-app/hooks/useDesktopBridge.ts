"use client";

import { useSyncExternalStore } from "react";
import { getDesktopBridge, type DesktopBridge } from "@/lib/desktop-bridge";

/**
 * Nothing to listen for: the desktop app's preload script has put the bridge
 * on `window` before any of this app's code runs, and it never changes after.
 */
function subscribe() {
  return () => {};
}

/** What the server renders with. It has no window, so never a bridge. */
function serverSnapshot(): DesktopBridge | null {
  return null;
}

/**
 * The desktop bridge for a component to render with, or null in a browser.
 *
 * Why a hook rather than calling getDesktopBridge() while rendering: the server
 * never has the bridge, so its HTML is always the browser version. A component
 * that read the bridge during its first render inside the desktop app would
 * draw different markup from the HTML it is hydrating, and React would throw
 * that markup away with a hydration error. useSyncExternalStore renders with
 * the server's answer first and then, straight after hydration, with the real
 * one, which is exactly the order needed.
 */
export function useDesktopBridge(): DesktopBridge | null {
  return useSyncExternalStore(subscribe, getDesktopBridge, serverSnapshot);
}
