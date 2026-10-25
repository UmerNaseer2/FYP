/**
 * The phone app's rules and words for deploy and rollback requests: what a
 * request is called, what the person holding the phone may do with it, and
 * what to say when the phone's passkey could not be used. Kept apart from
 * the screens, with no page in sight, so the tests
 * (src/test/phone-approvals.test.ts) can check them in Node.
 *
 * The phone only ever asks: the computer checks the passkey's signature and
 * the request again before it records anything (desktop/src/main/
 * phone-approvals.ts). These rules are there so the phone never offers a
 * button the computer would turn down.
 */
import { countText, dayText } from "./format.js";
import type { ApprovalAction, ApprovalDecision } from "../shared/remote/approval.js";
import type { ApprovalList, ApprovalRead, ApprovalSummary } from "../shared/remote/rpc.js";

/** What each kind of request is called, as the web app's Deploy screen calls it. */
export const ACTION_LABELS: Record<ApprovalAction, string> = {
  deploy: "Deploy",
  revert: "Rollback",
};

/** What the phone says once the computer has recorded a decision. Approving only records it: the person who asked still runs it. */
export const DECIDED_TEXT: Record<ApprovalDecision, string> = {
  approve: "Approved. The person who asked can run it from the Deploy screen in Schema Studio.",
  reject: "Rejected. It will not run unless someone asks for approval again.",
};

/** A version as the web app writes one, as in "v3", whether or not it was saved with its "v". */
export function versionText(version: string): string {
  return `v${version.trim().replace(/^v/i, "")}`;
}

/** A request's name, as in "Run migrations through v3". A rollback names the oldest version it undoes. */
export function requestTitle(summary: Pick<ApprovalSummary, "action" | "targetVersion">): string {
  const version = versionText(summary.targetVersion);
  return summary.action === "revert" ? `Roll back through ${version}` : `Run migrations through ${version}`;
}

/** How much a request runs, as in "3 migrations, 1 breaking change". */
export function requestSize(summary: Pick<ApprovalSummary, "action" | "migrationCount" | "breakingCount">): string {
  const count =
    summary.action === "revert"
      ? countText(summary.migrationCount, "version to undo", "versions to undo")
      : countText(summary.migrationCount, "migration", "migrations");
  return summary.breakingCount > 0 ? `${count}, ${countText(summary.breakingCount, "breaking change", "breaking changes")}` : count;
}

/** Who asked, and on which day, as in "Asked for by sam@example.com on 23 Oct 2026". The day is left out when the computer sent one the phone cannot read. */
export function requestedText(summary: Pick<ApprovalSummary, "requestedBy" | "requestedAt">): string {
  const time = Date.parse(summary.requestedAt);
  return Number.isNaN(time) ? `Asked for by ${summary.requestedBy}` : `Asked for by ${summary.requestedBy} on ${dayText(time)}`;
}

/** What the person holding the phone may do with a request, and why not, when they may not do both. */
export type Choices = { approve: boolean; reject: boolean; reason: string | null };

/**
 * What the phone offers for one request, from the list it came from, what
 * the computer showed of it, and the fingerprint the phone worked out itself
 * from that SQL (null when the computer showed none).
 *
 * The checks go from what no setup on the phone could change (the role, and
 * who asked) to what it could (its passkey), then to the request itself.
 * Approving needs the SQL on screen to be exactly the SQL the request runs,
 * so a request whose SQL the computer could not show may only be rejected.
 */
export function decisionChoices(
  list: Pick<ApprovalList, "passkey" | "canApprove">,
  summary: ApprovalSummary,
  read: ApprovalRead,
  hashed: string | null,
): Choices {
  const none = (reason: string): Choices => ({ approve: false, reject: false, reason });
  if (!list.canApprove) return none("The role signed in on the computer may not approve or reject requests.");
  if (summary.ownRequest) return none("The person signed in on the computer asked for this request, so someone else has to decide it.");
  switch (list.passkey) {
    case "none":
      return none("To approve or reject requests from this phone, set up approvals on it first. Requests shows how.");
    case "allowed":
      return none("Set up approvals on this phone first: go back to Requests and choose Set up approvals.");
    case "other-person":
      return none("The person signed in on the computer is not the one who set up approvals on this phone. Set them up again to decide as whoever is signed in now.");
    case "ready":
      break;
  }
  if (read.id !== summary.id || read.action !== summary.action || read.fingerprint !== summary.fingerprint || (read.scripts !== null && hashed !== summary.fingerprint)) {
    return none("This request changed on the computer while it was open here. Go back to Requests and open it again.");
  }
  if (summary.sql === "missing" || read.scripts === null) {
    return {
      approve: false,
      reject: true,
      reason: "The computer cannot show the SQL this request runs, so it cannot be approved from a phone. Reject it here, or decide it in Schema Studio on the computer.",
    };
  }
  return { approve: true, reject: true, reason: null };
}

/**
 * What to say when the browser would not make the phone's passkey ("create")
 * or use it ("get"), from the name of the error it gave. The browser's own
 * message is never shown: it is written for developers, and differs from
 * one browser to the next.
 */
export function passkeyErrorText(name: string, kind: "create" | "get"): string {
  switch (name) {
    case "NotAllowedError":
    case "AbortError":
      return kind === "create"
        ? "The passkey was not made, because it was cancelled or took too long. Try again."
        : "Nothing was decided, because the passkey check was cancelled or took too long. Try again.";
    case "NotSupportedError":
      return "This browser cannot make the kind of passkey approvals need. Try the phone's own browser: Safari on an iPhone, or Chrome on Android.";
    case "SecurityError":
      return "This browser would not use a passkey for this address. Approvals need the relay to be opened over HTTPS.";
    default:
      return kind === "create" ? "The phone could not make a passkey. Try again." : "The phone could not use its passkey. Try again.";
  }
}
