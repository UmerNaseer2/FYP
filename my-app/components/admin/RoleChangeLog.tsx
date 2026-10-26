"use client";

import { isPermissionKey, permissionLabel } from "@/lib/permissions";
import type { RoleChange } from "@/lib/roles-db";
import { timeAgo } from "@/lib/time-ago";

/**
 * "Recent changes" on the Roles & permissions tab: who changed which role,
 * and when.
 *
 * The database keeps one row per box ticked or unticked (lib/roles-db.ts says
 * why). Read back one by one, a single save of six boxes would be six lines
 * saying almost the same thing, so the rows of one save are put back together
 * here into one line with the boxes listed under it. The rows of one save are
 * easy to find: one transaction writes them all, so they share the role, the
 * person and the timestamp, and they sit next to each other in the log.
 */

/** One line of the log as the screen shows it. */
export type LogEntry = {
  /** The newest row's id, so React can tell the lines apart. */
  id: number;
  actor: string;
  createdAt: string;
  /** What the actor did. Follows their name: "changed what Editor can do". */
  text: string;
  /** Boxes ticked, as "Connections: Create". */
  gave: string[];
  /** Boxes unticked. */
  tookAway: string[];
};

function roleName(change: RoleChange): string {
  // A role deleted since then has no label any more, only its key.
  return change.roleLabel ?? `${change.role} (deleted)`;
}

function boxName(change: RoleChange): string {
  const key = `${change.feature}:${change.action}`;
  // A permission this build no longer has still gets a readable name.
  return isPermissionKey(key) ? permissionLabel(key) : `${change.feature}: ${change.action}`;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * What one row says on its own, for every kind but the three a save writes.
 * It follows the actor's name, so it starts with a verb.
 */
function sentenceFor(change: RoleChange): string {
  const role = roleName(change);
  switch (change.kind) {
    case "create-role":
      // detail is "Copied from Editor", or null for a role made empty.
      return `created ${role}` + (change.detail ? ` (${lowerFirst(change.detail)})` : "");
    case "delete-role":
      // The role is gone, so its label is not in the roles table any more:
      // the row kept it in `detail` for exactly this.
      return `deleted ${change.detail ?? change.role}`;
    case "invite": {
      // An invitation to an address names it. A link names nobody, and its
      // detail is how many days it was made to last, which is worth saying:
      // a link anyone can use is a bigger door the longer it stays open.
      if (change.subject) return `invited ${change.subject} as ${role}`;
      const days = Number(change.detail);
      return Number.isInteger(days) && days > 0
        ? `made a ${days}-day invitation link to join as ${role}`
        : `made an invitation link to join as ${role}`;
    }
    case "cancel-invite":
      return change.subject
        ? `cancelled the invitation for ${change.subject}`
        : `cancelled an invitation link to join as ${role}`;
    case "join":
      // The actor is the person who joined, so the line is about them.
      return change.detail === "link"
        ? `joined as ${role} with an invitation link`
        : `joined as ${role} by invitation`;
    default:
      // "assign": a role given to someone, by an Admin on the Users tab.
      return (
        `gave ${change.subject ?? "someone"} the ${role} role` +
        (change.detail ? `, instead of ${change.detail}` : "")
      );
  }
}

/** The log's rows, newest first, as the lines the screen shows. */
export function describeRoleChanges(changes: readonly RoleChange[]): LogEntry[] {
  const entries: LogEntry[] = [];
  // Which save the last line belongs to, while it can still take more of that
  // save's rows: the role, the person and the time, which one save shares.
  let openSave: string | null = null;

  for (const change of changes) {
    if (change.kind === "grant" || change.kind === "revoke" || change.kind === "reset") {
      const save = `${change.role}\n${change.actor}\n${change.createdAt}`;
      if (save !== openSave) {
        entries.push({
          id: change.id,
          actor: change.actor,
          createdAt: change.createdAt,
          text: `changed what ${roleName(change)} can do`,
          gave: [],
          tookAway: [],
        });
        openSave = save;
      }
      const entry = entries[entries.length - 1];
      // Newest first means the save's own rows arrive back to front, so each
      // box goes in at the start to keep the order they were written in.
      if (change.kind === "reset") entry.text = `reset ${roleName(change)} to its defaults`;
      else if (change.kind === "grant") entry.gave.unshift(boxName(change));
      else entry.tookAway.unshift(boxName(change));
      continue;
    }

    // Any other row ends the save before it, even one with the same timestamp.
    openSave = null;
    entries.push({
      id: change.id,
      actor: change.actor,
      createdAt: change.createdAt,
      text: sentenceFor(change),
      gave: [],
      tookAway: [],
    });
  }

  return entries;
}

export function RoleChangeLog({ changes }: { changes: readonly RoleChange[] }) {
  const entries = describeRoleChanges(changes);
  if (entries.length === 0) {
    return (
      <p className="help">
        Nothing has been changed yet. Every role made or deleted, every box ticked or unticked,
        every role given to someone and every invitation made, cancelled or taken is listed
        here, with who did it.
      </p>
    );
  }
  return (
    <ul className="role-log">
      {entries.map((entry) => (
        <li key={entry.id}>
          <div className="text-[13px]">
            <span className="font-medium">{entry.actor}</span> {entry.text}
          </div>
          {entry.gave.length > 0 && <div className="help">Gave: {entry.gave.join(", ")}</div>}
          {entry.tookAway.length > 0 && (
            <div className="help">Took away: {entry.tookAway.join(", ")}</div>
          )}
          <time
            className="help"
            dateTime={entry.createdAt}
            title={new Date(entry.createdAt).toLocaleString()}
          >
            {timeAgo(entry.createdAt)}
          </time>
        </li>
      ))}
    </ul>
  );
}
