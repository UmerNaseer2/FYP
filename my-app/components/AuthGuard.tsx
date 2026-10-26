"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@/hooks/useUser";
import { signOutEverywhere } from "@/lib/sign-out";
import {
  isAdminOnly,
  permissionLabel,
  readKeyOf,
  type FeatureKey,
} from "@/lib/permissions";

/**
 * Client-side gate for the pages wrapped in <AuthGuard>.
 *
 * Each screen names the feature it belongs to, and the guard lets the person in
 * when their role may Read that feature. A screen that belongs to several
 * features names them all, and Read on any one of them is enough: the same
 * rule requirePermission applies on the server.
 *
 * The bypass value used to be a hard-coded const in this file, which meant the
 * UI and the API routes could disagree about whether auth was on. It now comes
 * from lib/auth-mode through useUser, the same module the edge proxy and the
 * server-side route gates read, so one environment variable moves all three
 * together. useUser answers with what the server says the person may do
 * (/api/me): their role in the organization, or with the bypass on the role
 * picked in View as, or a full admin when none is picked. So this guard shows
 * the screens the server will let through and no others, and none at all to
 * someone the server says is not a member.
 *
 * This guard is a convenience, not a security boundary. It only decides what
 * React renders. The real enforcement is proxy.ts (page requests) and
 * lib/auth-guard.ts (API routes), both of which run before any of this.
 */
export default function AuthGuard({
  children,
  feature,
}: {
  children: React.ReactNode;
  /**
   * The feature this screen belongs to, or several when it belongs to more
   * than one. The person needs Read on one of them. Omit for "any signed-in
   * person".
   */
  feature?: FeatureKey | FeatureKey[];
}) {
  const { user, roleLabel, loading, viewingAs, can, accessError, notMember, bypass } =
    useUser();
  const router = useRouter();

  const features =
    feature === undefined ? [] : Array.isArray(feature) ? feature : [feature];
  const [first, ...rest] = features.map(readKeyOf);
  const open = features.length === 0;

  useEffect(() => {
    // With the bypass on there is always a user (useUser stands one in), so
    // this only ever sends someone to sign in when sign-in is real.
    if (!loading && !user) {
      router.push("/login");
    }
  }, [user, loading, router]);

  if (loading) {
    return (
      <div className="loading-state">
        <div className="title">Checking your access…</div>
      </div>
    );
  }

  // The effect above is already sending them to /login; rendering the page for
  // a frame first would flash content they are not signed in to see.
  if (!user) return null;

  // Not a member of the organization the page is open in, so the server
  // answers every request behind every page with 404, the open pages'
  // included, and there is nothing here to show. With real sign-in an admin
  // removed them while the page was open, or they belong to no organization at
  // all (app/[org]/layout.tsx shows everyone else the 404 page). With the
  // bypass on there is nobody to remove: no organization has this address any
  // more, and signing out would change nothing.
  if (notMember) {
    return (
      <div className="loading-state">
        <div className="title">{"You are not a member of this organization."}</div>
        <div className="hint">
          {bypass
            ? "Authentication is off, and the app's database has no organization at this address."
            : "An admin may have removed you, or you were never added. Check with an admin, or sign out."}
        </div>
        {!bypass && (
          <div className="actions">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => void signOutEverywhere()}
            >
              Sign out
            </button>
          </div>
        )}
      </div>
    );
  }

  // The app could not say what the role may do, so every request behind this
  // page would be answered "try again" (503). Saying "your role can't" here
  // would send them to an admin about a problem no admin can fix. Changing
  // View as would not help either: the server needs the database to act as
  // any role, Admin included.
  if (!open && accessError) {
    return (
      <div className="loading-state">
        <div className="title">{"Could not check your access right now."}</div>
        <div className="hint">
          {"The app could not be reached, or its database did not answer. " +
            "Reload the page in a moment."}
        </div>
      </div>
    );
  }

  if (!open && !can(first, ...rest)) {
    return (
      <div className="loading-state">
        <div className="title">{`Your role (${roleLabel}) can't open this page.`}</div>
        <div className="hint">
          {viewingAs
            ? `You are viewing the app as ${roleLabel}. Change "View as" to Admin to see every screen again.`
            : `You are signed in as ${user.email || "an unknown account"}. ` +
              (isAdminOnly(first)
                ? "Only admins can open it."
                : `Ask an admin to allow "${permissionLabel(first)}" for your role, then reload.`)}
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
