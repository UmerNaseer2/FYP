"use client";

import type { ReactNode } from "react";
import { ViewAsCookieSeen } from "@/hooks/useUser";

/**
 * Tells useUser whether the request that drew this page carried a View as
 * cookie.
 *
 * The browser can read the cookie as well, but only once the page is running,
 * and the server draws the first frame before that. Without this the first
 * frame would have to guess. Guess "admin" and someone viewing the app as a
 * viewer watches admin screens flash up and vanish. Guess "not known yet" and
 * everyone else gets "Checking your access…" on every page load for nothing.
 * The studio layout reads the cookie on the server and passes the answer down
 * through this, so the first frame is already right.
 *
 * Only rendered while the bypass is on. With real sign-in there is no View as.
 * It is its own file because the layout is a server component, and a context
 * can only be provided from a client one.
 */
export function ViewAsCookie({ seen, children }: { seen: boolean; children: ReactNode }) {
  return <ViewAsCookieSeen.Provider value={seen}>{children}</ViewAsCookieSeen.Provider>;
}
