// Pure, DB-free diffing of two schemas' applied-script ledgers (script_patch),
// for Version Sync / version replay. Given a Source (ahead) and a Target
// (behind), find the entries the Target is missing so they can be replayed to
// catch it up.
//
// Whole-schema flat log (locked decision 1): an entry is matched by
// (script_name, version). No React, no fetch, no DB — so it's unit-testable.
//
// A replay only moves forward, the same as a deploy: the apply route refuses a
// version at or below one already applied in its script group
// (checkForwardOnly in lib/deploy-risk). So a missing version the Target is
// already past is not "missing" in any way a replay can fix — diffLedgers
// lists it apart, as `belowTarget`, and cutForwardOnly stops a run before the
// first version the route would refuse. The screen then never offers a run the
// server is certain to turn down.

import { compareVersions, highestVersion } from "./script-status";
import { timelineKey } from "./version-timeline";
import { readApplyFailure, type ApplyFailure } from "./apply-failure";

/** One applied-script entry from a schema's script_patch ledger. */
export type LedgerEntry = {
  scriptName: string;
  version: string;
  /**
   * The row's level as its pill shows it: "breaking", "additive", "patch" or
   * "unknown". The ledger route reads change_type with normalizeChangeLevel,
   * so an old ledger's "major" arrives as "breaking" and a replay sends a word
   * the apply route counts, instead of one it ignores.
   */
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
  /**
   * The row's title and description, or null when it has none. A replay
   * writes them on the Target's row too, so the version reads the same on
   * both sides instead of taking its own number as its title.
   */
  title: string | null;
  description: string | null;
};

export type LedgerDiff = {
  /**
   * Source entries the Target lacks and could still take, in replay order: the
   * order the Source ran them (applied_at, then the ledger's own order). Each
   * version appears once, however many spellings of it the Source recorded.
   */
  missing: LedgerEntry[];
  /**
   * Source entries the Target lacks but is already past: each one's version is
   * at or below the highest version the Target has applied in that script
   * group. A replay only moves forward, so these cannot be replayed. Same order
   * as `missing`.
   */
  belowTarget: LedgerEntry[];
  /** Target entries the Source lacks — the schemas have diverged (warn, don't merge). */
  diverged: LedgerEntry[];
  /** True when nothing can be replayed forward: `missing` is empty. */
  upToDate: boolean;
  /** How many `missing` entries can't be replayed (no stored SQL). */
  missingWithoutSql: number;
};

/**
 * The key two ledgers' entries are matched on: the script group, and the
 * version's timelineKey.
 *
 * timelineKey is versionKey for a plain version, so "v5.0.2" in one ledger
 * matches "5.0.2" in the other — matching the raw text used to list a version
 * the Target already had as missing, and a replay of it was refused as
 * "already applied". A version that is not a plain number ("init", a
 * Laravel-style name) is matched exactly as written instead: versionKey reads
 * only the digits, so two different names could share one key. It is also the
 * key the merged timeline's rows use, so the list and the timeline on the
 * Version Sync screen agree about which versions match.
 *
 * Exported so the screen matches with this rule rather than a copy of it.
 */
export function entryKey(e: { scriptName: string; version: string }): string {
  // JSON of a pair, so no script name or version can run into the other.
  return JSON.stringify([e.scriptName, timelineKey(e.version)]);
}

/**
 * Each script group's highest applied version, per highestVersion (non-versions
 * never count). The Version Sync screen names the Target's head with it when it
 * explains why a version is below the Target.
 */
export function headsByFamily(entries: ReadonlyArray<LedgerEntry>): Map<string, string> {
  const versions = new Map<string, string[]>();
  for (const e of entries) {
    const list = versions.get(e.scriptName) ?? [];
    list.push(e.version);
    versions.set(e.scriptName, list);
  }
  const heads = new Map<string, string>();
  for (const [family, list] of versions) {
    const head = highestVersion(list);
    if (head !== null) heads.set(family, head);
  }
  return heads;
}

/**
 * Diff two ledgers.
 *   missing     = Source entries the Target lacks and can still take, in the
 *                 order the Source ran them (the order that actually worked):
 *                 by applied_at, and entries with the same applied_at keep the
 *                 order they arrived in.
 *   belowTarget = Source entries the Target lacks but is already past (see
 *                 LedgerDiff). A replay cannot run them.
 *   diverged    = Target entries the Source lacks (decision 2 — surface, never auto-merge).
 *   upToDate    = nothing is left to replay forward.
 */
export function diffLedgers(source: LedgerEntry[], target: LedgerEntry[]): LedgerDiff {
  const targetKeys = new Set(target.map(entryKey));
  const sourceKeys = new Set(source.map(entryKey));
  const targetHeads = headsByFamily(target);

  // Sorted by time only. Every ledger row one deploy writes shares that
  // deploy's applied_at (the transaction's timestamp), so a tie means "ran in
  // the same run", and version order says nothing about the order inside it:
  // users 2.0.0 may have run before orders 1.1.0. The ledger route sends the
  // rows in the order they were written (applied_at, then id), and sort keeps
  // the order of equal items, so a tie keeps that order.
  const lacking = source
    .filter((e) => !targetKeys.has(entryKey(e)))
    .slice()
    .sort((a, b) => a.appliedAt.localeCompare(b.appliedAt));

  const missing: LedgerEntry[] = [];
  const belowTarget: LedgerEntry[] = [];
  const seen = new Set<string>();
  for (const e of lacking) {
    // A Source ledger written by an older build can hold one version twice
    // ("v1.2.0" and "1.2.0"). The first one applied is the one listed: a run
    // that sent both would be refused as "listed twice".
    const key = entryKey(e);
    if (seen.has(key)) continue;
    seen.add(key);

    const head = targetHeads.get(e.scriptName);
    if (head !== undefined && compareVersions(e.version, head) <= 0) belowTarget.push(e);
    else missing.push(e);
  }

  const diverged = target.filter((e) => !sourceKeys.has(entryKey(e)));

  return {
    missing,
    belowTarget,
    diverged,
    upToDate: missing.length === 0,
    missingWithoutSql: missing.reduce((n, e) => (e.hasSql ? n : n + 1), 0),
  };
}

/** How far a replay can go before the apply route would refuse a version. */
export type ForwardOnlyCut = {
  /** The leading entries that can run, in the order given. */
  runnable: LedgerEntry[];
  /** The first entry the route would refuse, or null when every entry can run. */
  stoppedBefore: LedgerEntry | null;
  /** Why the run stops, or null when it does not. */
  reason: "out-of-order" | null;
  /**
   * The version `stoppedBefore` would have had to beat: the Target's own head
   * in that script group, or a version earlier in this same run. Null when the
   * run does not stop. Returned so the screen can name it ("the Source applied
   * it after v1.2.0") without working the rule out again.
   */
  blockedBy: string | null;
};

/**
 * Cut a replay at the first entry that would not move its script group forward.
 *
 * The Source applied its versions in the order that worked for it, and that is
 * not always version order: it may have applied v1.2.0 and then v1.1.0. The
 * apply route refuses a version at or below the highest one of its group that
 * is already applied, or at or below one earlier in the same run
 * (checkForwardOnly, lib/deploy-risk), and it refuses the whole run, not just
 * that version. So the run is cut here, before that entry, and the screen says
 * why rather than sending a run the route turns down.
 *
 * Each group is judged on its own, starting from the Target's highest applied
 * version in that group. A Target row that does not start with a number never
 * sets that starting mark, because the route ignores those rows too. Inside the
 * run every entry moves the mark on, as it does in the route, so "init" listed
 * after v1.0.0 stops the run (it reads as 0.0.0).
 *
 * One mark per group is enough: an entry the run accepted was already above the
 * Target's head, so beating it also beats the head.
 */
export function cutForwardOnly(entries: LedgerEntry[], targetEntries: LedgerEntry[]): ForwardOnlyCut {
  // The version each group has to beat: the Target's head, then each version
  // this run has already accepted in that group.
  const marks = headsByFamily(targetEntries);
  for (let index = 0; index < entries.length; index++) {
    const e = entries[index];
    const mark = marks.get(e.scriptName);
    if (mark !== undefined && compareVersions(e.version, mark) <= 0) {
      return { runnable: entries.slice(0, index), stoppedBefore: e, reason: "out-of-order", blockedBy: mark };
    }
    // Every entry the run accepts moves the mark on, a non-version too: the
    // route's own run mark (runMark in checkForwardOnly) does the same.
    marks.set(e.scriptName, e.version.trim());
  }
  return { runnable: entries.slice(), stoppedBefore: null, reason: null, blockedBy: null };
}

/**
 * How a replay's call to the apply route ended. A failure is read by
 * readApplyFailure (lib/apply-failure), the reading Deploy uses too.
 */
export type ReplayOutcome = { ok: true } | { ok: false; failure: ApplyFailure; error: string };

/** An apply-route answer as JSON. Only the fields named here are read. */
export type ReplayAnswer = {
  success?: unknown;
  error?: unknown;
  outcomeUnknown?: unknown;
  nothingRan?: unknown;
  [field: string]: unknown;
};

/**
 * Read the apply route's answer to a replay. Pass `status: null` when the
 * request never came back and `answer: null` when its body was not JSON.
 *
 * A success needs a 2xx AND `success: true`, so a future soft-failure shape is
 * never read as applied. Anything else is a failure, read by readApplyFailure.
 * The Version Sync page used to read failures by hand, and took a results list
 * to mean "the run reached the Target and rolled back". But the route's
 * forward-only and ledger refusals (409) list the run's scripts too, so a
 * refusal read "Replay failed", and a 503 from before the first write read
 * "refused". The route marks those with nothingRan, and readApplyFailure
 * reads it.
 */
export function readReplayAnswer(status: number | null, answer: ReplayAnswer | null): ReplayOutcome {
  if (status === null) {
    return { ok: false, failure: readApplyFailure(null, null), error: "Could not reach the server." };
  }
  if (answer === null) {
    return {
      ok: false,
      failure: readApplyFailure(status, null),
      error: `The server answered ${status} with a reply this page could not read.`,
    };
  }
  if (status >= 200 && status < 300 && answer.success === true) return { ok: true };
  const error =
    typeof answer.error === "string" && answer.error.trim() !== ""
      ? answer.error
      : `The server answered ${status} with no message.`;
  return { ok: false, failure: readApplyFailure(status, answer), error };
}
