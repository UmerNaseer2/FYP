// Pure, DB-free diffing of two schemas' applied-script ledgers (script_patch),
// for Version Sync / version replay. Given a Source (ahead) and a Target
// (behind), find the entries the Target is missing so they can be replayed to
// catch it up.
//
// Whole-schema flat log (locked decision 1): an entry is matched by
// (script_name, version). No React, no fetch, no DB — so it's unit-testable.

import { compareVersions } from "./script-status";

/** One applied-script entry from a schema's script_patch ledger. */
export type LedgerEntry = {
  scriptName: string;
  version: string;
  changeType: string;
  /** ISO timestamp. The replay order follows this. */
  appliedAt: string;
  /** Whether the stored SQL is present (i.e. replayable). */
  hasSql: boolean;
  /** The applied SQL, if stored (null for legacy rows from before P1). */
  sqlContent: string | null;
  /**
   * The rollback recorded with it, if any. Carried through the replay so a
   * version that arrives on the Target this way is as revertable there as it
   * is on the Source — without it, replay produced permanently one-way
   * migrations.
   */
  downSql: string | null;
};

export type LedgerDiff = {
  /** Source entries the Target lacks, in replay order (Source applied_at, then version). */
  missing: LedgerEntry[];
  /** Target entries the Source lacks — the schemas have diverged (warn, don't merge). */
  diverged: LedgerEntry[];
  /** True when the Target already has every Source entry. */
  upToDate: boolean;
  /** How many `missing` entries can't be replayed (no stored SQL). */
  missingWithoutSql: number;
};

/** Match key (locked decision 1: whole-schema flat log → family + version). */
function entryKey(e: { scriptName: string; version: string }): string {
  // NUL separator can't appear in a script_name/version, so the key is unambiguous.
  return JSON.stringify([e.scriptName, e.version]);
}

/**
 * Diff two ledgers.
 *   missing  = Source entries the Target lacks, ordered by the Source's original
 *              applied_at (the order that actually worked), tie-broken by version.
 *   diverged = Target entries the Source lacks (decision 2 — surface, never auto-merge).
 *   upToDate = the Target already has everything the Source has.
 */
export function diffLedgers(source: LedgerEntry[], target: LedgerEntry[]): LedgerDiff {
  const targetKeys = new Set(target.map(entryKey));
  const sourceKeys = new Set(source.map(entryKey));

  const missing = source
    .filter((e) => !targetKeys.has(entryKey(e)))
    .slice()
    .sort((a, b) => {
      const byTime = a.appliedAt.localeCompare(b.appliedAt);
      return byTime !== 0 ? byTime : compareVersions(a.version, b.version);
    });

  const diverged = target.filter((e) => !sourceKeys.has(entryKey(e)));

  return {
    missing,
    diverged,
    upToDate: missing.length === 0,
    missingWithoutSql: missing.reduce((n, e) => (e.hasSql ? n : n + 1), 0),
  };
}
