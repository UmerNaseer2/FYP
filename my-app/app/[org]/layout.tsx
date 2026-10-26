import type { ReactNode } from "react";
import { notFound, redirect } from "next/navigation";
import { OrgProvider } from "@/components/OrgProvider";
import { resolveOrganization } from "@/lib/auth-guard";
import { isOrgSlug } from "@/lib/org-slug";
import { findLastOrganization, rememberLastOrganization } from "@/lib/orgs-db";

/** The desktop app starts this server with SCHEMA_STUDIO_DESKTOP=1 (see auth.config.ts). */
function onDesktop(): boolean {
  return process.env.SCHEMA_STUDIO_DESKTOP === "1";
}

/**
 * Every page of an organization sits under its address: /acme/studio,
 * /acme/compare and so on. This layout checks the address names an
 * organization the person belongs to before any of its pages is drawn, and
 * tells the pages which one it is (components/OrgProvider.tsx).
 *
 * It asks the same gate the API routes do (resolveOrganization in
 * lib/auth-guard.ts), for the organization in the address rather than the one
 * a request's header names, and the answers mean the same:
 *
 *   - A member: the pages are drawn. With real sign-in the organization is
 *     remembered as the one they used last, so an old address that names none
 *     (/studio) brings them back here (lib/org-redirect.ts).
 *
 *   - Not a member: the 404 page, the same answer the API gives for another
 *     organization's rows, so an address cannot be used to find out whether an
 *     organization exists. Except for someone signed in who belongs to no
 *     organization at all, whom a 404 would leave nowhere to go. In the
 *     browser they are sent to make one (/onboarding). In the desktop app,
 *     which has no such page, the pages' own guard (components/AuthGuard.tsx)
 *     says they are not a member and offers to sign out. It learns that from
 *     /api/me, which answers 404 too. They see the slug they typed, never the
 *     organization's name.
 *
 *   - The database did not answer: the pages are drawn with the slug for a
 *     name, and their guard says "Could not check your access", as it does
 *     whenever /api/me answers 503. A blank error page would say less.
 *
 * Signed-out visitors never get here with real sign-in: proxy.ts sends them
 * to /login first, with this address to come back to.
 */
export default async function OrganizationLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ org: string }>;
}) {
  const { org: slug } = await params;
  // Not the shape of a slug (/Acme, /a) or a word kept back for a page to
  // come (/settings): no organization can have this address.
  if (!isOrgSlug(slug)) notFound();

  const resolution = await resolveOrganization(slug);
  switch (resolution.kind) {
    case "ok": {
      const { principal } = resolution;
      if (!principal.bypass) {
        // Only a hint for the old addresses, so a failure to write it is
        // logged and the page is drawn anyway.
        try {
          // Never null here: only the bypass has no profile ID.
          await rememberLastOrganization(principal.profileId!, principal.orgId);
        } catch (error) {
          console.error("Could not remember the organization:", error);
        }
      }
      return (
        <OrgProvider slug={principal.orgSlug} name={principal.orgName}>
          {children}
        </OrgProvider>
      );
    }

    case "not-member": {
      // The bypass is everyone's stand-in, so for it this only means that no
      // organization has this address.
      if (resolution.profileId === null) notFound();
      let elsewhere: string | null | undefined;
      try {
        elsewhere = await findLastOrganization(resolution.profileId);
      } catch (error) {
        // Not knowing, draw the pages: their guard asks /api/me, which says
        // either "not a member" or "try again in a moment".
        console.error("Could not read the caller's organizations:", error);
        elsewhere = undefined;
      }
      if (typeof elsewhere === "string") notFound();
      // Outside the try above, because redirect() works by throwing.
      if (elsewhere === null && !onDesktop()) redirect("/onboarding");
      return (
        <OrgProvider slug={slug} name={slug}>
          {children}
        </OrgProvider>
      );
    }

    case "unavailable":
      return (
        <OrgProvider slug={slug} name={slug}>
          {children}
        </OrgProvider>
      );

    case "signed-out":
      // A session with no profile ID in it: the gates treat that as nobody.
      redirect("/login");
  }
}
