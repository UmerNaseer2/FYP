import { createContext, useCallback, useContext } from "react";
import { orgHref } from "@/lib/org-slug";

/**
 * The organization a page is open in: its slug (the address), its name, and
 * whether a production run needs a second person to approve it
 * (Organization.twoPersonRule in lib/orgs-db.ts).
 */
export type Org = { slug: string; name: string; twoPersonRule: boolean };

/**
 * The organization the page is open in, from app/[org]/layout.tsx through
 * components/OrgProvider.tsx. Null on a page outside every organization (the
 * landing page, sign-in) and in a component test that renders no provider.
 */
export const OrgContext = createContext<Org | null>(null);

/** The organization the page is open in, or null outside every organization. */
export function useOrg(): Org | null {
  return useContext(OrgContext);
}

/**
 * Builds the address of another page in the same organization. With
 * `const orgPath = useOrgHref()`, `orgPath("/compare?left=4")` is
 * "/acme/compare?left=4" on a page in "acme".
 *
 * Every link between the studio's pages goes through this, so a link never
 * takes someone out of the organization they are working in. Outside every
 * organization it returns the path as given, and the old addresses (/studio,
 * /compare and the rest) send people on to their own organization.
 */
export function useOrgHref(): (path: string) => string {
  const slug = useContext(OrgContext)?.slug ?? null;
  return useCallback((path: string) => orgHref(slug, path), [slug]);
}
