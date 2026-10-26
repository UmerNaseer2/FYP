import { notFound, redirect } from "next/navigation";
import { isOrgSlug } from "@/lib/org-slug";

/**
 * An organization's own address, /acme, opens its dashboard.
 *
 * The slug is checked before it goes into the redirect. Next.js renders a
 * layout and its page side by side, so this cannot count on the layout's
 * check having run first, and the address's first part arrives decoded: an
 * address like /%2F%2Fexample.com would otherwise redirect to
 * //example.com/studio, which a browser reads as another site.
 */
export default async function OrganizationHome({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  if (!isOrgSlug(org)) notFound();
  redirect(`/${org}/studio`);
}
