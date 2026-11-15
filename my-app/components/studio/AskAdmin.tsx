"use client";

import Link from "next/link";
import { useOrg, useOrgHref } from "@/hooks/useOrg";
import { useUser } from "@/hooks/useUser";
import { DEFAULT_ROLE, isAdminOnly, type PermissionKey } from "@/lib/permissions";
import { TRIAL_BLOCKED_PERMISSIONS, TRIAL_ORG_SLUG } from "@/lib/trial-rules";

type AskAdminProps = {
  /** The permission the sentence before this is about. Requests opens with it picked. */
  permission?: PermissionKey;
  /**
   * Optional. What a Viewer reads instead of the standard line, for a page
   * that can say something more useful, such as "You can see deploys once
   * they run."
   */
  viewerNote?: string;
  /** Optional. True in a tight spot: only the link shows, without the sentence around it. */
  short?: boolean;
};

/**
 * The way forward from a sentence saying a role can't do something. What it
 * says follows the reader's role, so nobody is told to ask for something they
 * can do themselves, or shown a button that leads nowhere:
 *
 * - An Admin is never told to ask an admin. They get a link to
 *   Admin › Roles & permissions, where they can turn the permission on.
 * - A Viewer gets a plain sentence about what Viewers can do, and no link.
 * - Everyone else (Editors and custom roles) gets "Ask an Admin", a link to
 *   the Requests page with that permission already picked.
 *
 * Nothing shows while viewing the app as another role, where the answer is to
 * change "View as" back rather than to ask anybody. A refusal in a tooltip
 * can't hold a link, so only sentences on the page get one.
 */
export function AskAdmin({ permission, viewerNote, short = false }: AskAdminProps) {
  const { viewingAs, isAdmin, role } = useUser();
  const org = useOrg();
  const orgPath = useOrgHref();
  if (viewingAs) return null;

  const linkClass = "underline underline-offset-2 whitespace-nowrap";
  // Each sentence sits in its own span, so the sentence before it (the page's
  // own words) stays a separate piece of text.

  if (isAdmin) {
    // The shared trial switches a few things off for every role, Admin
    // included, and no setting brings them back.
    if (permission && org?.slug === TRIAL_ORG_SLUG && TRIAL_BLOCKED_PERMISSIONS.has(permission)) {
      return null;
    }
    return (
      <>
        {" "}
        {!short && <span>You&apos;re an Admin, so you can turn it on yourself. </span>}
        <Link href={orgPath("/admin?tab=roles")} className={linkClass}>
          Open Roles &amp; permissions
        </Link>
      </>
    );
  }

  // Some permissions can't be handed out through Requests at all.
  if (permission && isAdminOnly(permission)) {
    return short ? null : (
      <>
        {" "}
        <span>Only an Admin can do this, so there is nothing to ask for.</span>
      </>
    );
  }

  if (role === DEFAULT_ROLE) {
    if (short) return null;
    const standard = permission?.endsWith(":read")
      ? "An Admin decides what Viewers can see."
      : "Viewers can look around but not make changes. An Admin can move you to another role.";
    return (
      <>
        {" "}
        <span>{viewerNote ?? standard}</span>
      </>
    );
  }

  const target = permission ? `/requests?ask=${encodeURIComponent(permission)}` : "/requests";
  return (
    <>
      {" "}
      {!short && <span>Your ask lands in Requests, where any Admin can act on it. </span>}
      <Link href={orgPath(target)} className={linkClass}>
        Ask an Admin
      </Link>
    </>
  );
}
