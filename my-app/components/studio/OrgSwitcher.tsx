"use client";

import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Select, type SelectOption } from "@/components/ui/Select";
import { useOrg } from "@/hooks/useOrg";
import { apiFetch } from "@/lib/api-fetch";
import { isOrgListing, type OrgListing } from "@/lib/organization-list";
import { orgHref } from "@/lib/org-slug";

/**
 * The option that leaves for "Your organizations" to make a new one.
 *
 * It sits in the same list as the organizations' addresses, so it needs a
 * value no address can ever be. Addresses are lowercase letters, digits and
 * hyphens (ORG_SLUG_PATTERN in lib/org-slug.ts), so a colon can never start
 * one.
 */
const NEW_ORGANIZATION = ":new";

/**
 * "Organization", on the studio rail: which organization this is, and a way
 * to open another one.
 *
 * The list comes from GET /api/organizations, the same answer the
 * "Your organizations" page draws. Picking one opens that organization's
 * studio home rather than the same page there, because most pages here are
 * open on something (a connection, a comparison) that belongs to the
 * organization being left, and the other one has never heard of it.
 *
 * A client-side navigation is enough to change organizations safely. The
 * studio's shell is drawn inside app/[org]/, so a new address mounts a new
 * one, and the one thing the app keeps between pages, what this person may do
 * (hooks/useUser.ts), remembers which organization its answer is about and
 * asks again for the new one.
 *
 * Draws nothing when there is nothing to choose: one organization and no way
 * to make another. That is the desktop app, which keeps a single hidden
 * organization of its own, and a demo with one organization. It also draws
 * nothing until the list arrives, and nothing if it never does: the name of
 * the organization is already in the top bar, so a picker that could only
 * fail would add a broken control and nothing else.
 */
export function OrgSwitcher() {
  const id = useId();
  const org = useOrg();
  const router = useRouter();
  const [listing, setListing] = useState<OrgListing | null>(null);
  const slug = org?.slug ?? null;

  useEffect(() => {
    if (slug === null) return;
    // Set by the cleanup, so an answer that arrives after the picker has gone
    // (or after the organization changed under it) is dropped, not drawn.
    let cancelled = false;
    async function load() {
      try {
        // no-store: the list changes when someone makes an organization or is
        // added to one, and a cached answer would leave the new one out.
        const response = await apiFetch("/api/organizations", { cache: "no-store" });
        if (!response.ok) return;
        const body: unknown = await response.json();
        if (!cancelled && isOrgListing(body)) setListing(body);
      } catch {
        // Unreachable, or not JSON. Nothing is drawn; see above.
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (org === null || listing === null) return null;
  const others = listing.organizations.filter((each) => each.slug !== org.slug);
  if (others.length === 0 && !listing.canCreate) return null;

  // The organization open now comes first and is named from the page rather
  // than from the list, so the picker shows the right name even when the list
  // was read a moment before a rename.
  const options: SelectOption[] = [
    { value: org.slug, label: org.name },
    ...others.map((each) => ({ value: each.slug, label: each.name })),
  ];
  if (listing.canCreate) options.push({ value: NEW_ORGANIZATION, label: "New organization…" });

  function open(value: string) {
    if (org === null || value === org.slug) return;
    router.push(value === NEW_ORGANIZATION ? "/onboarding" : orgHref(value, "/studio"));
  }

  return (
    <div className="flex flex-col gap-1">
      <label className="section-title" htmlFor={id}>
        Organization
      </label>
      <Select
        id={id}
        ariaLabel="Organization"
        variant="input"
        className="org-switcher"
        value={org.slug}
        options={options}
        onChange={open}
      />
    </div>
  );
}
