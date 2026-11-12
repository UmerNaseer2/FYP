import type { PillTone } from "@/components/ui/Pill";
import type { RequestStatus } from "./access-requests";
import type { ListedApproval } from "./approvals-db";
import { PERMISSIONS, permissionLabel } from "./permissions";

/**
 * How a request or a run reads on screen. The Requests page and the phone app
 * both use these, so the same request says the same thing on both.
 */

export const STATUS_PILLS: Record<RequestStatus, { label: string; tone: PillTone }> = {
  pending: { label: "Waiting", tone: "pending" },
  allowed: { label: "Allowed", tone: "sync" },
  declined: { label: "Declined", tone: "break" },
  done: { label: "Done", tone: "sync" },
  withdrawn: { label: "Withdrawn", tone: "neutral" },
};

export function formatWhen(value: string | null): string {
  if (!value) return "";
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * The asked-for permission by its line on the Roles & permissions tab (the
 * title), with a plain sentence of what it does.
 */
export function describeAsked(permission: string | null): { title: string; does: string | null } {
  if (permission === null) return { title: "Something else", does: null };
  const found = PERMISSIONS.find((entry) => entry.key === permission);
  return found
    ? { title: permissionLabel(found.key), does: found.does }
    : { title: permission, does: null };
}

export function deployHref(run: ListedApproval): string {
  const query = new URLSearchParams({
    connection: String(run.connection_id),
    schema: run.schema_name,
    script: run.script_name,
  });
  // A run's version is picked for the reader. A rollback's is chosen in its own card.
  if (run.action !== "revert") query.set("version", run.target_version);
  return `/deploy?${query.toString()}`;
}

export function runTitle(run: ListedApproval): string {
  // A rollback's target_version is the oldest version it undoes, not the one
  // the database ends at, so "to" would name the wrong version.
  return run.action === "revert"
    ? `Roll back ${run.script_name}, undoing v${run.target_version} and newer`
    : `Run ${run.script_name} to v${run.target_version}`;
}

export function runTarget(run: ListedApproval): string {
  return `${run.connection_name ?? "A connection that has been removed"}, schema ${run.schema_name}`;
}

export function ownRunStory(run: ListedApproval): { label: string; tone: PillTone; story: string } {
  const by = run.self_approved ? "you" : run.decided_by ?? "someone";
  switch (run.status) {
    case "pending":
      return {
        label: "Waiting",
        tone: "pending",
        story: "Waiting for an Admin. It is on the Requests page of anyone who can approve it.",
      };
    case "rejected":
      return { label: "Rejected", tone: "break", story: `Rejected by ${by}.` };
    case "used":
      return { label: "Run", tone: "neutral", story: `Approved by ${by}, and it has been run.` };
    default:
      if (run.expires_at && new Date(run.expires_at).getTime() <= Date.now()) {
        return {
          label: "Ran out",
          tone: "neutral",
          story: `Approved by ${by}, but it was not run in time. Ask again on Deploy to run it.`,
        };
      }
      return {
        label: "Approved",
        tone: "sync",
        story: run.run_by_requester
          ? `Approved by ${by}. You can run it once, until ${formatWhen(run.expires_at)}. Open it on Deploy (or Version Sync) and press Run.`
          : `Approved by ${by}. Ready to run until ${formatWhen(run.expires_at)}, by anyone who may run a deploy.`,
      };
  }
}
