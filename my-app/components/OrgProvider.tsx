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
  children,
}: {
  slug: string;
  name: string;
  children: ReactNode;
}) {
  // One object for as long as the organization stays the same, so a component
  // that memoises on it does not redo its work on every render.
  const org = useMemo(() => ({ slug, name }), [slug, name]);
  return <OrgContext.Provider value={org}>{children}</OrgContext.Provider>;
}
