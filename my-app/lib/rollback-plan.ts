// Pure rollback planning: which stored rollback text runs, which versions a
// "roll back to vX" undoes, and whether a request undoes the newest versions
// first.
//
// Pure on purpose (no DB, no fetch, no React): the Deploy page and the revert
// route both import it, so the screen always shows the same SQL, and the same
// list of versions, that the server will run.
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

/**
 * The most versions one rollback may undo. One number for three places, so
 * they agree: the revert route refuses a longer list, the approvals route
 * will not record an approval for one (no rollback could ever spend it), and
 * the Deploy page offers only "Roll back to" choices within it. A family with
 * more applied versions can still go all the way back, in several rollbacks.
 */
export const MAX_ROLLBACK_VERSIONS = 50;

/** One "Roll back to" choice: where the family goes back to (null for "before the first version") and how many versions that undoes. */
export type RollbackTarget = { target: string | null; undoCount: number };

/**
 * The "Roll back to" choices, given the applied versions newest first: each
 * version below the newest (undoing every version above it), then "before
 * the first version" (undoing all of them). A choice that would undo more
 * than MAX_ROLLBACK_VERSIONS versions is left out, so the screen never offers
 * a rollback the revert route refuses.
 */
export function rollbackTargets(appliedNewestFirst: ReadonlyArray<string>): RollbackTarget[] {
  const targets: RollbackTarget[] = appliedNewestFirst
    .slice(1, MAX_ROLLBACK_VERSIONS + 1)
    .map((target, index) => ({ target, undoCount: index + 1 }));
  if (appliedNewestFirst.length > 0 && appliedNewestFirst.length <= MAX_ROLLBACK_VERSIONS) {
    targets.push({ target: null, undoCount: appliedNewestFirst.length });
  }
  return targets;
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

// ─── Version labels, for messages ───────────────────────────────────────────
// The revert route's messages and the Deploy screen's rollback panel name the
// same versions, so both use these two and read the same way.

/** "v1.2.0" whether the caller wrote "1.2.0" or "v1.2.0". */
export function vLabel(version: string): string {
  return `v${version.trim().replace(/^v/i, "")}`;
}

/** "v3.0.0", "v3.0.0 and v2.0.0", "v3.0.0, v2.0.0 and v1.0.0". */
export function listVersions(versions: ReadonlyArray<string>): string {
  const labels = versions.map(vLabel);
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/**
 * The versions a deploy runs, as the buttons that run them name it: "v5.0.1"
 * for one, "v5.0.1 → v5.0.2" for several (the first and last as given, so
 * pass them in the order they run), "" for none. The count is left to the
 * caller, since only some labels show it.
 */
export function versionRange(versions: ReadonlyArray<string>): string {
  if (versions.length === 0) return "";
  const first = vLabel(versions[0]);
  const last = vLabel(versions[versions.length - 1]);
  return versions.length === 1 ? first : `${first} → ${last}`;
}

// ─── A whole "roll back to" plan, for the Deploy screen ─────────────────────

/** One applied version of the family, as the pre-flight read reports it. */
export type AppliedRollbackRow = {
  version: string;
  applied_at: string | null;
  down_sql?: string | null;
};

/** One step of a rollback plan: a version to undo, and what undoes it. */
export type RollbackStep<Registry> = {
  /**
   * The version as the ledger spells it. The revert request and the approval
   * fingerprint both use this spelling: the route claims approvals over the
   * ledger's own text, so a registry "1.1" would not match a ledger "1.1.0".
   */
  version: string;
  appliedAt: string | null;
  /** The rollback that will run, or why none can: the same pick the revert route makes. */
  resolved: ResolvedRollback;
  /** The registry's entry for this version ("1.1" matches "1.1.0"), or null when it has none. */
  registry: Registry | null;
  /**
   * True when the copy saved with the version runs and the registry holds a
   * different rollback for it (the file was edited later). The saved copy
   * still wins; the screen says so, so nobody assumes the file they can see
   * in GitHub is the one that runs.
   */
  registryDiffers: boolean;
};

// Line endings and blank lines at either end are not a difference worth
// reporting: apply stores the rollback trimmed, and Windows editors add \r.
function sameRollbackText(left: string, right: string): boolean {
  const tidy = (text: string) => text.replace(/\r\n/g, "\n").trim();
  return tidy(left) === tidy(right);
}

/**
 * Plan a "roll back to `target`": each applied version above it, newest
 * first, with the rollback that will undo it. A null target means "before
 * the first version", so every applied version.
 *
 * `registry` is the family's versions from the GitHub registry. Each entry
 * comes back unchanged on its step, so the caller keeps whatever else it
 * knows about the file (for example, why its rollback could not be read).
 */
export function planRollback<Registry extends { version: string; down_sql?: string | null }>(
  applied: ReadonlyArray<AppliedRollbackRow>,
  registry: ReadonlyArray<Registry>,
  target: string | null,
): RollbackStep<Registry>[] {
  const steps: RollbackStep<Registry>[] = [];
  for (const version of versionsToUndo(applied.map((row) => row.version), target)) {
    // versionsToUndo hands back the same strings, so an exact match finds the row.
    const row = applied.find((candidate) => candidate.version === version);
    if (!row) continue;
    const entry = registry.find((candidate) => compareVersions(candidate.version, version) === 0) ?? null;
    const registryText = entry?.down_sql ?? null;
    const resolved = resolveRollback(row.down_sql, registryText);
    const registryDiffers =
      "sql" in resolved &&
      resolved.source === "ledger" &&
      typeof registryText === "string" &&
      hasExecutableSql(registryText) &&
      !sameRollbackText(resolved.sql, registryText);
    steps.push({ version, appliedAt: row.applied_at, resolved, registry: entry, registryDiffers });
  }
  return steps;
}

// The loudest change level in a list, recorded as one level for a
// multi-version rollback. It lives with the one ranking of levels in
// lib/change-type.ts; it is re-exported here because the revert route already
// reads it from this module.
export { loudestChangeLevel } from "./change-type";
