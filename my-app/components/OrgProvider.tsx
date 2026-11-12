"use client";

import { useMemo, type ReactNode } from "react";
import { OrgContext } from "@/hooks/useOrg";

/**
 * Tells the page which organization it is open in (see hooks/useOrg.ts).
 *
 * Its own file because app/[org]/layout.tsx is a server component, and a
 * context can only be provided from a client one. The same reason as
 * components/ViewAsCookie.tsx.
 */
export function OrgProvider({
  slug,
  name,
  twoPersonRule = false,
  trial = false,
  children,
}: {
  slug: string;
  name: string;
  /**
   * Left out where the layout could not read the organization. Off then, the
   * rule's default: the screens let the run go ahead, and the server, which
   * reads the real setting on every request, is the one that decides.
   */
  twoPersonRule?: boolean;
  /** The shared trial organization, which gets the trial's strip (components/studio/TrialBar.tsx). */
  trial?: boolean;
  children: ReactNode;
}) {
  // One object for as long as the organization stays the same, so a component
  // that memoises on it does not redo its work on every render.
  const org = useMemo(() => ({ slug, name, twoPersonRule, trial }), [slug, name, twoPersonRule, trial]);
  return <OrgContext.Provider value={org}>{children}</OrgContext.Provider>;
}
