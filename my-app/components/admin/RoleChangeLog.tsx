"use client";

import { AI_KEY_LOG_SUBJECT } from "@/lib/ai/key-providers";
import { isPermissionKey } from "@/lib/permissions";
import { joinList, lineName } from "@/lib/role-summary";
import type { RoleChange } from "@/lib/roles-db";
import { timeAgo } from "@/lib/time-ago";

/**
 * "Recent changes" on the Roles & permissions tab: who changed which role,
 * and when.
 *
 * The database keeps one row per permission turned on or off (lib/roles-db.ts
 * says why). Read back one by one, a single save that changes six of them
 * would be six entries saying almost the same thing, so the rows of one save
 * are put back together here into one entry that names what it turned on and
 * off, by the names the tab's lines have ("Add a connection"). The rows of
 * one save are easy to find: one transaction writes them all, so they share
 * the role, the person and the timestamp, and they sit next to each other in
 * the log.
 */

/** One line of the log as the screen shows it. */
export type LogEntry = {
  /** The newest row's id, so React can tell the lines apart. */
  id: number;
  actor: string;
  createdAt: string;
  /** What the actor did. Follows their name: "changed what Editor can do". */
  text: string;
  /** What a save turned on, by the names the tab's lines have: "Add a connection". */
  turnedOn: string[];
  /** What a save turned off. */
  turnedOff: string[];
};

function roleName(change: RoleChange): string {
  // A role deleted since then has no label any more, only its key.
  return change.roleLabel ?? `${change.role} (deleted)`;
}

function lineOf(change: RoleChange): string {
  const key = `${change.feature}:${change.action}`;
  // A permission this build no longer has still gets a readable name.
  return isPermissionKey(key) ? lineName(key) : `${change.feature}: ${change.action}`;
}

/** “Add a connection” and “Delete a connection”, every name shown. */
function quotedList(names: readonly string[]): string {
  return joinList(
    names.map((name) => `“${name}”`),
    names.length
  );
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
    case "remove":
      // The role they had when they were removed, so the line still says what
      // was taken away once their row is gone from the Users tab.
      return `removed ${change.subject ?? "someone"} (${role})`;
    // The ones below are about the organization, not a role. Their rows name
    // the role of the person who made the change only because every row names one.
    case "rename-organization":
      // subject is the new name and detail the old one.
      return change.detail
        ? `renamed the organization from ${change.detail} to ${change.subject ?? "a new name"}`
        : `renamed the organization to ${change.subject ?? "a new name"}`;
    case "two-person-rule":
      return change.detail === "off"
        ? "switched the two-person rule off, so people can approve their own production deploys"
        : "switched the two-person rule on, so production deploys wait for a second person";
    case "github-settings": {
      // subject is the repository as owner/name, and detail what was saved.
      const repository = change.subject ?? "a repository";
      if (change.detail === "token") return `saved a new GitHub access token for ${repository}`;
      if (change.detail === "removed") return `removed the GitHub settings for ${repository}`;
      return `pointed the organization at the GitHub repository ${repository}`;
    }
    case "ai-settings":
      // The organization's own AI key: the detail is the service, or "removed".
      if (change.subject === AI_KEY_LOG_SUBJECT) {
        return change.detail === "removed"
          ? "removed the organization's own AI key, so AI uses the server's settings again"
          : `saved the organization's own AI key for ${change.detail ?? "an AI service"}`;
      }
      // No subject: AI assistance as a whole. A subject: one AI feature.
      if (!change.subject) {
        return change.detail === "off"
          ? "switched AI assistance off for the organization"
          : "switched AI assistance on, so schema structure can be sent to the AI service";
      }
      return `switched the AI feature ${change.subject} ${change.detail === "off" ? "off" : "on"}`;
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
          turnedOn: [],
          turnedOff: [],
        });
        openSave = save;
      }
      const entry = entries[entries.length - 1];
      // Newest first means the save's own rows arrive back to front, so each
      // name goes in at the start to keep the order they were written in.
      if (change.kind === "reset") entry.text = `reset ${roleName(change)} to its defaults`;
      else if (change.kind === "grant") entry.turnedOn.unshift(lineOf(change));
      else entry.turnedOff.unshift(lineOf(change));
      continue;
    }

    // Any other row ends the save before it, even one with the same timestamp.
    openSave = null;
    entries.push({
      id: change.id,
      actor: change.actor,
      createdAt: change.createdAt,
      text: sentenceFor(change),
      turnedOn: [],
      turnedOff: [],
    });
  }

  return entries;
}

export function RoleChangeLog({ changes }: { changes: readonly RoleChange[] }) {
  const entries = describeRoleChanges(changes);
  if (entries.length === 0) {
    return (
      <p className="help">
        Nothing has been changed yet. Roles made or deleted, lines turned on or off, roles
        given to people, invitations, people removed and changes to the organization all show
        here, with who made them.
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
          {entry.turnedOn.length > 0 && (
            <div className="help">Turned on {quotedList(entry.turnedOn)}</div>
          )}
          {entry.turnedOff.length > 0 && (
            <div className="help">Turned off {quotedList(entry.turnedOff)}</div>
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
