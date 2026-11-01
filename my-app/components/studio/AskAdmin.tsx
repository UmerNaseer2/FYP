"use client";

import Link from "next/link";
import { useOrgHref } from "@/hooks/useOrg";
import { useUser } from "@/hooks/useUser";
import type { PermissionKey } from "@/lib/permissions";

/**
 * The way forward from a sentence saying a role can't do something: a link to
 * the Requests page, with that permission already picked.
 *
 * Not while viewing the app as another role, where the answer is to change
 * "View as" back rather than to ask anybody. A refusal in a tooltip can't hold
 * a link, so only sentences on the page get one.
 */
export function AskAdmin({ permission }: { permission?: PermissionKey }) {
  const { viewingAs } = useUser();
  const orgPath = useOrgHref();
  if (viewingAs) return null;
  const target = permission ? `/requests?ask=${encodeURIComponent(permission)}` : "/requests";
  return (
    <>
      {" "}
      <Link href={orgPath(target)} className="underline underline-offset-2 whitespace-nowrap">
        Ask for it
      </Link>
    </>
  );
}
