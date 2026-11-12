/**
 * What phone alerts say and who gets each one.
 *
 * A lock screen is public, so an alert names only a schema, a connection and an
 * organization, the same names anyone in the room could read off the app. It
 * never holds a host, SQL, a person's name or anything a person typed. The
 * reason to look is in the alert, and the rest is behind sign-in in the app.
 *
 * One exception, when an organization has AI assistance on: a "Drift found"
 * alert (new drift, plan 6.3 3a) can carry the AI's one line on what changed,
 * which names the tables and columns involved. Every name in it, in backticks
 * or not, is checked against the two schemas, and a line that names anything
 * unchecked is dropped. What is left is cleaned to one plain line and capped
 * (lib/ai/features/drift-explain.ts). No other alert carries it.
 *
 * Recipients are worked out when an alert is sent, from memberships and roles
 * at that moment, so taking a permission away also takes away its alerts.
 *
 * Every alert here is a side effect of something already done, so nothing here
 * throws: a check or a decision never fails because an alert could not be sent.
 *
 * Tested in tests/push-alerts.test.ts.
 */
import { after } from "next/server";
import type { AccessRequest } from "@/lib/access-requests";
import type { ApprovalAction, DeployApproval } from "@/lib/approvals-db";
import type { Principal } from "@/lib/auth-guard";
import type { DriftRun } from "@/lib/drift-runner";
import { orgHref } from "@/lib/org-slug";
import {
  hasPermission,
  isPermissionKey,
  permissionLabel,
  type PermissionKey,
} from "@/lib/permissions";
import { subscriptionsInOrganization, type OrganizationSubscription } from "@/lib/push-db";
import { sendAlert, type Alert } from "@/lib/push-send";
import { getRoleAccess } from "@/lib/roles-db";
import pool from "@/lib/version-db";

/** The longest a name gets in an alert, in characters. Lock screens show little more. */
const NAME_LIMIT = 48;

export type DriftAlertKind = "drifted" | "changed" | "in_sync" | "unreachable" | "reachable";

/** The part of the person acting that an alert needs. */
type Actor = Pick<Principal, "orgId" | "orgSlug" | "orgName">;

/**
 * Runs an alert after the response has gone, so nobody waits on a push service.
 * Outside a request there is nothing to run after, which only happens in a test.
 */
export function afterResponse(task: () => Promise<void>): void {
  try {
    after(task);
  } catch {
    // Not inside a request.
  }
}

/** A name fit for one line: no invisible or control characters, and cut short with an ellipsis. */
export function cleanName(text: string | null): string | null {
  if (text === null) return null;
  const clean = text
    .replace(/\p{Cf}+/gu, "")
    .replace(/[\s\p{Cc}]+/gu, " ")
    .trim();
  if (clean === "") return null;
  const characters = Array.from(clean);
  if (characters.length <= NAME_LIMIT) return clean;
  return `${characters.slice(0, NAME_LIMIT - 1).join("").trimEnd()}\u{2026}`;
}

/**
 * Whether this outcome is news, compared with the last one on record. A first
 * check that finds everything in order is not, and neither is the same drift
 * again. Null means nothing to say.
 */
export function driftAlertKind(
  status: string,
  before: string | null,
  fingerprint: string | null,
  previousFingerprint: string | null
): DriftAlertKind | null {
  switch (status) {
    case "unreachable":
      return before === "unreachable" ? null : "unreachable";
    case "in_sync":
      if (before === "drifted") return "in_sync";
      return before === "unreachable" ? "reachable" : null;
    case "drifted":
      if (before === "unreachable") return "reachable";
      if (before !== "drifted") return "drifted";
      return fingerprint !== null && previousFingerprint !== null && fingerprint !== previousFingerprint
        ? "changed"
        : null;
    default:
      return null;
  }
}

const DRIFT_TITLES: Record<DriftAlertKind, string> = {
  drifted: "Drift found",
  changed: "Drift changed",
  in_sync: "Back in sync",
  unreachable: "Database not reachable",
  reachable: "Database reachable again",
};

/** What a drift alert says, about a subject such as "orders on Sales". */
export function driftAlertText(
  kind: DriftAlertKind,
  subject: string,
  status: string,
  aiSummary: string | null = null
): { title: string; body: string } {
  const line = aiSummary ? ` ${aiSummary}` : "";
  const bodies: Record<DriftAlertKind, string> = {
    drifted: `${subject} no longer matches its baseline.${line}`,
    // The plan gives the AI line to new drift only, so "changed" has none.
    // The desktop app's alerts (src/core/drift-alerts.ts) follow the same rule.
    changed: `The drift in ${subject} has changed.`,
    in_sync: `${subject} matches its baseline again.`,
    unreachable: `Schema Studio could not reach ${subject} to check it for drift. It tries again at the next check.`,
    reachable:
      status === "drifted"
        ? `Schema Studio can reach ${subject} again, but it differs from its baseline.`
        : `Schema Studio can reach ${subject} again, and it matches its baseline.`,
  };
  return { title: DRIFT_TITLES[kind], body: bodies[kind] };
}

/** "orders on Sales", or just "orders" when the connection has no name to show. */
export function subjectOf(name: string, connectionName: string | null): string {
  return connectionName === null ? name : `${name} on ${connectionName}`;
}

function sameEmail(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** The organization's devices whose holder has one of these permissions now, leaving one person out. */
async function devicesHolding(
  orgId: number,
  keys: [PermissionKey, ...PermissionKey[]],
  leaveOut: string | null = null
): Promise<OrganizationSubscription[]> {
  const devices = await subscriptionsInOrganization(orgId);
  const byRole = new Map<string, boolean>();
  const chosen: OrganizationSubscription[] = [];
  for (const device of devices) {
    if (leaveOut !== null && sameEmail(device.email, leaveOut)) continue;
    let holds = byRole.get(device.role);
    if (holds === undefined) {
      holds = hasPermission(await getRoleAccess(orgId, device.role), ...keys);
      byRole.set(device.role, holds);
    }
    if (holds) chosen.push(device);
  }
  return chosen;
}

/** One person's devices in this organization. */
async function devicesOf(orgId: number, email: string): Promise<OrganizationSubscription[]> {
  const devices = await subscriptionsInOrganization(orgId);
  return devices.filter((device) => sameEmail(device.email, email));
}

/** Runs one alert's work, and keeps whatever goes wrong from reaching what caused it. */
async function quietly(what: string, send: () => Promise<unknown>): Promise<void> {
  try {
    await send();
  } catch (error) {
    console.error(`Could not send ${what}:`, error instanceof Error ? error.name : "unknown error");
  }
}

/** Tells the organization when a scheduled check found something new. */
export async function alertDriftChange(orgId: number, run: DriftRun): Promise<void> {
  // Not recorded means the check found what the last one did, or could not
  // write it down, in which case the next check sees the same change and tells.
  if (!run.recorded || run.previous === undefined) return;
  const kind = driftAlertKind(
    run.status,
    run.previous?.status ?? null,
    run.fingerprint,
    run.previous?.fingerprint ?? null
  );
  if (kind === null) return;
  await quietly("a drift alert", async () => {
    const found = await pool.query<{
      slug: string;
      schema_name: string;
      label: string | null;
      connection_name: string | null;
    }>(
      `SELECT o.slug, t.schema_name, t.label, c.name AS connection_name
         FROM tracked_schemas t
         JOIN organizations o ON o.id = t.org_id
         LEFT JOIN connections c ON c.id = t.connection_id AND c.org_id = t.org_id
        WHERE t.id = $1 AND t.org_id = $2`,
      [run.trackedSchemaId, orgId]
    );
    const row = found.rows[0];
    if (!row) return;
    const name = cleanName(row.label) ?? cleanName(row.schema_name) ?? `Schema ${run.trackedSchemaId}`;
    const alert: Alert = {
      kind: "drift",
      ...driftAlertText(kind, subjectOf(name, cleanName(row.connection_name)), run.status, run.aiSummary ?? null),
      url: orgHref(row.slug, "/phone"),
    };
    await sendAlert(await devicesHolding(orgId, ["drift:read"]), alert);
  });
}

/** "orders on Sales", for a run on one of this organization's connections. */
async function runSubject(orgId: number, approval: DeployApproval): Promise<string> {
  const found = await pool.query<{ name: string }>(
    "SELECT name FROM connections WHERE id = $1 AND org_id = $2",
    [approval.connection_id, orgId]
  );
  const name = cleanName(approval.schema_name) ?? "a schema";
  return subjectOf(name, cleanName(found.rows[0]?.name ?? null));
}

function runWord(action: ApprovalAction): string {
  return action === "revert" ? "rollback" : "deploy";
}

/** Tells everyone who could approve a run that one is waiting, apart from the person asking. */
export async function alertRunWaiting(actor: Actor, approval: DeployApproval): Promise<void> {
  await quietly("an approval alert", async () => {
    const subject = await runSubject(actor.orgId, approval);
    await sendAlert(await devicesHolding(actor.orgId, ["approvals:approve"], approval.requested_by), {
      kind: "approval",
      title: "Approval needed",
      body: `A ${runWord(approval.action)} of ${subject} is waiting for approval.`,
      url: orgHref(actor.orgSlug, "/phone?tab=approvals"),
    });
  });
}

/** Tells the person who asked how their run was decided, unless they decided it themselves. */
export async function alertRunDecided(actor: Actor, approval: DeployApproval): Promise<void> {
  if (approval.decided_by !== null && sameEmail(approval.decided_by, approval.requested_by)) return;
  await quietly("a decision alert", async () => {
    const subject = await runSubject(actor.orgId, approval);
    const approved = approval.status === "approved";
    await sendAlert(await devicesOf(actor.orgId, approval.requested_by), {
      kind: "approval",
      title: approved ? "Run approved" : "Run rejected",
      body: `Your ${runWord(approval.action)} of ${subject} was ${approved ? "approved" : "rejected"}.`,
      url: orgHref(actor.orgSlug, "/phone?tab=approvals"),
    });
  });
}

function requestedLabel(request: AccessRequest): string | null {
  return request.permission !== null && isPermissionKey(request.permission)
    ? permissionLabel(request.permission)
    : null;
}

/** Tells everyone who can answer that a member asked for something, apart from that member. */
export async function alertRequestMade(actor: Actor, request: AccessRequest): Promise<void> {
  await quietly("a request alert", async () => {
    const organization = cleanName(actor.orgName) ?? "your organization";
    const label = requestedLabel(request);
    await sendAlert(
      await devicesHolding(actor.orgId, ["users:update", "roles:update"], request.requested_by),
      {
        kind: "request",
        title: "Access request",
        body:
          label === null
            ? `A member of ${organization} sent a request.`
            : `A member of ${organization} asked for "${label}".`,
        url: orgHref(actor.orgSlug, "/phone?tab=approvals"),
      }
    );
  });
}

/** Tells the member who asked what the answer was, unless they answered it themselves. */
export async function alertRequestAnswered(actor: Actor, request: AccessRequest): Promise<void> {
  if (request.decided_by !== null && sameEmail(request.decided_by, request.requested_by)) return;
  await quietly("a request alert", async () => {
    const label = requestedLabel(request);
    const what = label === null ? "Your request" : `Your request for "${label}"`;
    const answers: Record<string, string> = {
      allowed: "was allowed",
      declined: "was declined",
      done: "was marked as done",
    };
    await sendAlert(await devicesOf(actor.orgId, request.requested_by), {
      kind: "request",
      title: "Request answered",
      body: `${what} ${answers[request.status] ?? "was answered"}.`,
      url: orgHref(actor.orgSlug, "/phone?tab=approvals"),
    });
  });
}
