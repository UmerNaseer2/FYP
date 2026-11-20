// Quick run: type SQL (or have AI write it) and run it on one schema from the
// Deploy page, without first saving a script in the Script Editor.
//
// It is still an ordinary versioned run. The SQL goes through the same apply
// route as every Deploy run, so it lands in the schema's script_patch ledger
// as one version of one script group, and the route's own registry step saves
// that version to GitHub after the commit. This file holds the parts the
// panel works out before it sends anything, kept apart from the component so
// they can be tested on their own.
//
// The version is picked the way every screen that saves a script picks it
// (lib/versions/family-reads.ts):
//
//   floor = highestVersion([applied, ...versions in GitHub])
//   next  = bumpVersion(floor, levelToBump(level))
//
// This file is safe to import from a client component: everything in it is
// plain text work.
import { describeChangeType, stampChangeType, type ScriptChangeType } from "@/lib/versions/change-type";
import { bumpVersion, compareVersions, highestVersion, levelToBump, versionKey } from "@/lib/versions/script-status";
import { validateScriptName } from "@/lib/github/registry-push";
import { containsTransactionControl, hasExecutableSql } from "@/lib/sql/guard";

/** The script group every quick run is saved under, unless the user names another. */
export const QUICK_RUN_GROUP = "quick-changes";

/** The longest SQL (and rollback) the panel sends. The same order as the AI writer's limit. */
export const MAX_QUICK_SQL_CHARS = 100_000;

/** The change level a quick run is recorded and versioned by. The same rule Deploy uses. */
export function quickRunLevel(sql: string): ScriptChangeType {
  return describeChangeType(sql).recorded;
}

/** What the next version of the group will be, and why. */
export type QuickVersion = {
  /** The version this run is saved as, e.g. "1.4.0". */
  version: string;
  /** The change level it was bumped by. */
  level: ScriptChangeType;
  /** The highest version the group already has, or null for a new group. */
  floor: string | null;
};

/**
 * The version a quick run is saved as.
 *
 * `known` is every version the group already has that this screen could read:
 * the one applied to the schema and the ones in GitHub. A group with none
 * starts at 1.0.0, like every other new script.
 */
export function nextQuickVersion(
  sql: string,
  known: ReadonlyArray<string | null | undefined>,
): QuickVersion {
  const level = quickRunLevel(sql);
  const floor = highestVersion(known);
  return { version: bumpVersion(floor, levelToBump(level)), level, floor };
}

/**
 * GitHub's versions of the group that this schema has not run, oldest first,
 * leaving out the retired ones.
 *
 * A quick run saves above all of them (nextQuickVersion counts every version
 * in GitHub, retired ones too, since a retired number stays taken), so Deploy
 * will not offer them on this schema any more and the panel says so. A
 * retired version is offered to no database anyway, so it needs no warning.
 */
export function quickVersionsAhead(
  applied: string | null,
  github: ReadonlyArray<string>,
  retired: ReadonlyArray<string>,
): string[] {
  const retiredKeys = new Set(retired.map((version) => versionKey(version)));
  return github
    .filter((version) => applied === null || compareVersions(version, applied) > 0)
    .filter((version) => !retiredKeys.has(versionKey(version)))
    .sort(compareVersions);
}

/**
 * The exact text sent for the run: the SQL with its "-- Change-type:" line.
 *
 * The push route and the registry step both stamp a file with its level
 * before they save it. Stamping it here first means the script_patch row, the
 * GitHub file and an approval request all hold the same bytes, so an Admin's
 * approval (a fingerprint of the SQL) matches the file Deploy later runs.
 * Stamping text that already carries the same level changes nothing.
 */
export function quickRunSql(sql: string): string {
  return stampChangeType(sql, quickRunLevel(sql));
}

/** The first reason this SQL can't be sent as a quick run, or null. `what` names it in the message. */
export function quickSqlProblem(sql: string, what: "SQL" | "rollback"): string | null {
  if (!hasExecutableSql(sql)) {
    return what === "SQL"
      ? "Type the SQL to run. Comments on their own run nothing."
      : "The rollback has only comments, so it would undo nothing. Write the statements that undo the SQL, or untick Save a rollback.";
  }
  if (sql.length > MAX_QUICK_SQL_CHARS) {
    return `The ${what} is ${sql.length.toLocaleString("en")} characters long. Keep it under ${MAX_QUICK_SQL_CHARS.toLocaleString("en")}, or save it as a script in the Script Editor.`;
  }
  if (containsTransactionControl(sql)) {
    return `The ${what} opens or closes its own transaction (COMMIT, ROLLBACK, ABORT, END or PREPARE TRANSACTION). Quick run already runs it in one transaction, so take that statement out.`;
  }
  return null;
}

/** The first reason the group name can't be used, or null. The same rule as every saved script. */
export function quickGroupProblem(name: string): string | null {
  return validateScriptName(name.trim());
}

/** The words for a level, as the panel's chip shows them. */
export function quickLevelLabel(level: ScriptChangeType): string {
  if (level === "breaking") return "Breaking";
  if (level === "additive") return "Additive";
  return "Patch";
}
