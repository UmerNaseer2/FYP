// Pure rollback planning: which stored rollback text runs, which versions a
// "roll back to vX" undoes, and whether a request undoes the newest versions
// first.
//
// Pure on purpose (no DB, no fetch, no React): the Deploy page and the revert
// route both import it, so the screen always shows the same SQL, and the same
// list of versions, that the server will run.
import type { ChangeLevel } from "./change-level";
import { compareVersions } from "./script-status";
import { containsTransactionControl, hasExecutableSql } from "./sql-guard";

/** Which rollback runs, or why none can. */
export type ResolvedRollback =
  | { sql: string; source: "ledger" | "registry" }
  | { problem: "none" | "transaction_control" };

// A copy can run as a rollback when it has a statement that runs and no
// COMMIT/ROLLBACK of its own: the revert runs inside one transaction, and a
// COMMIT in the middle would make the undo half-permanent.
function usable(text: string | null | undefined): text is string {
  return typeof text === "string" && hasExecutableSql(text) && !containsTransactionControl(text);
}

function blockedByTransactionControl(text: string | null | undefined): boolean {
  return typeof text === "string" && hasExecutableSql(text) && containsTransactionControl(text);
}

/**
 * Pick the rollback to run for one version.
 *
 * The ledger copy (script_patch.down_sql) wins: it was stored in the same
 * transaction as the migration it undoes, so it is the best evidence of what
 * belongs to that version. The registry copy (v<ver>.down.sql from GitHub)
 * covers versions deployed before the ledger stored rollbacks, and rollbacks
 * added later. A comment-only copy is no rollback at all and falls through.
 *
 * With no usable copy: "transaction_control" when a copy that has statements
 * was refused for containing COMMIT or ROLLBACK (so the message can say why),
 * otherwise "none".
 */
export function resolveRollback(
  stored: string | null | undefined,
  registry: string | null | undefined,
): ResolvedRollback {
  if (usable(stored)) return { sql: stored, source: "ledger" };
  if (usable(registry)) return { sql: registry, source: "registry" };
  if (blockedByTransactionControl(stored) || blockedByTransactionControl(registry)) {
    return { problem: "transaction_control" };
  }
  return { problem: "none" };
}

/**
 * The applied versions a "roll back to `target`" undoes: every one above the
 * target, newest first (the order they must run in). A null target means
 * "before the first version", so all of them. "1.1" and "1.1.0" are the same
 * version here, as everywhere else.
 */
export function versionsToUndo(applied: ReadonlyArray<string>, target: string | null): string[] {
  return applied
    .filter((version) => target === null || compareVersions(version, target) > 0)
    .sort((left, right) => compareVersions(right, left));
}

/** Whether a set of versions to undo is exactly the newest ones applied. */
export type NewestFirstCheck =
  | { ok: true }
  | {
      ok: false;
      /** Applied versions above the lowest one asked for that the request left out, newest first. */
      mustAlsoUndo: string[];
      /** Versions asked for more than once (1.2 and 1.2.0 count as the same). */
      duplicates: string[];
      /** Versions asked for that are not applied at all. */
      notApplied: string[];
    };

/**
 * A family's versions can only be undone newest first: undoing v2 while v3 is
 * still applied would leave v3 running on top of a structure it doesn't
 * expect. So the requested set must be exactly the top N applied versions,
 * each once. Callers refuse an empty request before asking (an empty list
 * passes here, since it breaks no order).
 */
export function checkNewestFirst(
  applied: ReadonlyArray<string>,
  requested: ReadonlyArray<string>,
): NewestFirstCheck {
  const same = (left: string) => (right: string) => compareVersions(left, right) === 0;

  const unique: string[] = [];
  const duplicates: string[] = [];
  for (const version of requested) {
    if (!unique.some(same(version))) unique.push(version);
    else if (!duplicates.some(same(version))) duplicates.push(version);
  }

  const notApplied = unique.filter((version) => !applied.some(same(version)));
  const requestedApplied = unique.filter((version) => applied.some(same(version)));

  // The lowest version asked for decides the cut: everything applied above it
  // has to be in the request too.
  let mustAlsoUndo: string[] = [];
  if (requestedApplied.length > 0) {
    const lowest = requestedApplied.reduce((low, version) =>
      compareVersions(version, low) < 0 ? version : low,
    );
    mustAlsoUndo = applied
      .filter((version) => compareVersions(version, lowest) > 0 && !unique.some(same(version)))
      .sort((left, right) => compareVersions(right, left));
  }

  if (mustAlsoUndo.length === 0 && duplicates.length === 0 && notApplied.length === 0) return { ok: true };
  return { ok: false, mustAlsoUndo, duplicates, notApplied };
}

// Same ranks as the apply route's loudestChangeType: the loudest level in a
// batch is the one recorded for the whole run.
const LEVEL_RANK: Record<ChangeLevel, number> = { unknown: 0, patch: 1, additive: 2, breaking: 3 };

/**
 * The loudest change level in a list (breaking > additive > patch > unknown),
 * for recording one level for a multi-version rollback. An empty list is
 * "unknown".
 */
export function loudestChangeLevel(levels: ReadonlyArray<ChangeLevel>): ChangeLevel {
  let loudest: ChangeLevel = "unknown";
  for (const level of levels) {
    if (LEVEL_RANK[level] > LEVEL_RANK[loudest]) loudest = level;
  }
  return loudest;
}
