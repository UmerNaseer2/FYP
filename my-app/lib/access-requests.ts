import type { ListedApproval } from "./approvals-db";
import {
  ADMIN_ROLE,
  hasPermission,
  isAdminOnly,
  isPermissionKey,
  type PermissionHolder,
} from "./permissions";

/**
 * Requests: how someone asks for something their role can't do.
 *
 * The app sends no email, so a request waits on the Requests page until someone
 * who can answer opens it. The rail shows a count beside the page's name, which
 * is what tells them it is there. The same page also lists the production runs
 * waiting on them and tells a person how their own were answered, because those
 * were the other things nobody was ever told about.
 *
 * Asking needs only membership, so a role cannot be locked out of asking for
 * more. Answering asks for the rights that could actually do something about
 * it. An answer changes nothing by itself: the page calls the existing Roles
 * and Users routes first, which keeps their guards and their audit trail, and
 * then records the answer here.
 *
 * This file is safe to import in the browser; the queries are in
 * lib/access-requests-db.ts.
 */

export type RequestStatus = "pending" | "allowed" | "declined" | "done" | "withdrawn";

export const REQUEST_ANSWERS = ["allowed", "declined", "done"] as const;
export type RequestAnswer = (typeof REQUEST_ANSWERS)[number];

/** The longest message or note, in characters. */
export const REQUEST_TEXT_MAX = 500;

/** How many requests one person may have waiting at a time. */
export const WAITING_REQUESTS_MAX = 20;

/** Fired on the window when a request changes, so the rail's count catches up. */
export const REQUESTS_CHANGED_EVENT = "schema-studio:requests-changed";

export type AccessRequest = {
  id: number;
  requested_by: string;
  requested_by_name: string | null;
  /** The permission asked for, or null for "something else". */
  permission: string | null;
  message: string | null;
  status: RequestStatus;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
  /**
   * When an Admin allowed just this person, for a while: the end of that
   * while. Until then they may do what they asked, whatever their role says.
   */
  granted_until: string | null;
};

/** A request as the people answering it see it: with the asker as they are now. */
export type InboxRequest = AccessRequest & {
  /** All three are null once the person has left the organization. */
  member_id: number | null;
  member_role: string | null;
  member_role_label: string | null;
};

export type RequestCounts = {
  /** Things waiting on this person to do something. */
  waiting: number;
  /** Their own requests answered since they last opened the page. */
  answered: number;
};

/** What GET /api/requests answers. */
export type RequestsPayload = {
  mine: AccessRequest[];
  inbox: InboxRequest[];
  /** What people were allowed for a day and still hold. Only for those who can answer requests. */
  lent: AccessRequest[];
  runsToApprove: ListedApproval[];
  runsToRun: ListedApproval[];
  myRuns: ListedApproval[];
  canAnswer: boolean;
  lastSeenAt: string | null;
  counts: RequestCounts;
};

/**
 * Who may answer a request. Allowing one means changing a role or moving someone
 * to another, so these are the rights that can do that. An Admin always may:
 * in the shared trial, where changing roles is switched off, an Admin can still
 * answer, and allow somebody for a day (grantProblem), which needs neither.
 */
export function canAnswerRequests(holder: PermissionHolder & { role?: string }): boolean {
  return hasPermission(holder, "users:update", "roles:update") || holder?.role === ADMIN_ROLE;
}

/** How long "Allow just them" lasts. */
export const GRANT_HOURS = 24;

/**
 * Why this request cannot be answered "just them, for a day", or null when it
 * can. Only a request for one named permission, never one only an Admin may
 * hold (those come with the Admin role and nothing else), and only by somebody
 * who holds it themselves: nobody hands out more than they have.
 */
export function grantProblem(holder: PermissionHolder, permission: string | null): string | null {
  if (permission === null || !isPermissionKey(permission)) {
    return "This request is not for one thing the app can switch on, so it cannot be allowed for a day.";
  }
  if (isAdminOnly(permission)) {
    return "Only an Admin may do that, so it cannot be lent to anyone. Make them an Admin instead.";
  }
  if (!hasPermission(holder, permission)) {
    return "You cannot do that yourself, so you cannot let somebody else do it.";
  }
  return null;
}
