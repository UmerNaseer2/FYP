"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";
import {
  ClipboardIcon,
  CheckIcon,
  RefreshIcon,
  AlertTriangleIcon,
} from "@/components/ui/icons";
import { containsTransactionControl, hasExecutableSql } from "@/lib/sql-guard";
import { countOf } from "@/lib/plural";
import { gradeSql, levelWithArticle, louderChangeType, quieterLevelWarning } from "@/lib/change-type";
import { bumpVersion, highestVersion, levelToBump } from "@/lib/script-status";
import { readAppliedVersion, readFamilyVersions } from "@/lib/family-reads";
import {
  CHANGE_LEVELS,
  describePush,
  MIGRATION_NO_STATEMENTS,
  rollbackChoiceProblem,
  rollbackToSend,
  validateScriptName,
} from "@/lib/registry-push";
// Type-only imports: compare-run opens the metadata database (pg) and
// version-detection reads target databases, so a value import would drag
// server code into the browser bundle.
import type { DetectedVersion } from "@/lib/compare-run";
import type { NewerSchemaVerdict } from "@/lib/version-detection";

// The change level a migration is published as. compare-run imports this name.
export type ChangeKind = "breaking" | "additive" | "patch";

// ---------------------------------------------------------------------------
// MigrationWorkbench — the right-hand "Generated migration" panel on Compare.
//
// The server page runs the compare engine and generateMigration, and hands us
// the finished SQL plus a suggested name, description and change level. Here
// the user edits the SQL, picks a level, and pushes it to the GitHub script
// registry (POST /api/github/push; the server holds the token). Applying a
// pushed script to a database happens later, on Deploy.
//
// The version number is never typed here. It is worked out exactly the way
// the Script Editor works it out, so both screens offer the same number:
//   floor = the highest of (the version applied to the target, the versions
//           already in GitHub); next = floor bumped by the chosen level; a
//           family with no version anywhere starts at 1.0.0.
// Push waits until both reads are back, and is refused with a reason (never a
// guess) when GitHub can't be read. If someone else takes the number first,
// the server answers 409 and one click pushes the next free number.
//
// Every "are you sure" here is a tick the user has to give: a level quieter
// than the SQL was graded, saving without a rollback, and a push that would
// move a newer target backwards. Each one names what it is agreeing to.
//
// Deliberately a plain <textarea>, not a contenteditable editor: robust,
// accessible and beginner-safe.
// ---------------------------------------------------------------------------

type Props = {
  /** Rendered migration SQL from renderMigrationScript(). */
  initialSql: string;
  /** Number of real statements (0 = schemas already in sync). */
  statementCount: number;
  /**
   * How many of those statements are commented out because safe mode is on.
   * They are still counted in statementCount — they exist in the script, they
   * just will not run. 0 when data loss is armed or nothing is destructive.
   */
  heldBackCount: number;
  /**
   * How many of those statements are MANUAL notes: comments describing work no
   * statement can do — a collation that has to be dropped with its columns
   * moved off it first, a range type the snapshot cannot describe well enough
   * to create. They are counted in statementCount because they are in the
   * script, but running the script performs none of them.
   */
  manualCount: number;
  rollbackManualCount: number;
  /**
   * Rendered rollback SQL from renderRollbackScript() — the down script that
   * undoes initialSql. "" when the schemas already match and there is nothing
   * to undo.
   */
  initialRollbackSql: string;
  /** Number of statements in the rollback script. */
  rollbackStatementCount: number;
  /**
   * Severity tally for the rollback's own statements.
   *
   * Kept apart from `counts` because the two scripts do not grade alike: a
   * migration whose single statement is a safe ADD COLUMN has a rollback whose
   * single statement is a breaking DROP COLUMN. The tally used to show the
   * forward numbers on both tabs, so that rollback read "0 breaking · 1 safe".
   */
  rollbackCounts: { breaking: number; safe: number; info: number };
  /**
   * What the rollback cannot put back, from generateRollback(). Shown above the
   * down script so nobody reads it as a full undo — it restores structure only.
   */
  rollbackWarnings: string[];
  suggestedName: string;
  suggestedDescription: string;
  /** The schema that the migration actually modifies (right/target). */
  targetLabel: string;
  /**
   * The bare target schema name (e.g. "public"). Combined with the target
   * database below to form the GitHub registry path the migration is pushed
   * into: <targetDatabase>/<targetSchema>/<script_name>/v<ver>.sql
   */
  targetSchema: string;
  /**
   * The target database name (from the connection). Top-level GitHub folder so
   * one database's scripts never mix with another's.
   */
  targetDatabase: string;
  /** Auto-suggested change level from the statement severities. */
  suggestedKind: ChangeKind;
  counts: { breaking: number; safe: number; info: number };
  warnings: string[];
  /**
   * The target's saved connection, used to read which version of this script
   * is already applied there (the same read-only preflight the Script Editor
   * makes). Null when the target came from the environment fallback: only
   * GitHub can be checked then, and the panel says so.
   */
  targetConnectionId: number | null;
  /**
   * Which side's own version table declares the newer version. "right" means
   * the TARGET is ahead, so this push would move it backwards and needs a
   * tick. Null when detection gave no verdict.
   */
  versionVerdict: NewerSchemaVerdict | null;
  /** What each side's version table says, for the backwards warning's numbers. */
  sourceVersion: DetectedVersion | null;
  targetVersion: DetectedVersion | null;
  /** "connection.schema" for each side: the same names the version bar above uses. */
  sourceName: string;
  targetName: string;
  /** The same comparison the other way round (buildSwapHref), or null. */
  swapHref: string | null;
};

/** What GitHub said about the family, stamped with the family and refresh it was read for. */
type FamilyRead =
  | { key: string; refresh: number; ok: true; versions: string[] }
  | { key: string; refresh: number; ok: false; error: string };

/** What the target says is applied for this script, stamped with what was asked. */
type AppliedRead = { key: string; ok: true; version: string | null } | { key: string; ok: false };

type PushState =
  | { kind: "idle" }
  | { kind: "pushing" }
  // key/version: the family and version saved, so a rollback added to it
  // later can update this box. rollbackLine: what became of the rollback when
  // it was not saved with the version (null when it was); cleared once GitHub
  // holds one, so this box never disagrees with the offer below it.
  // rollbackFailed: a rollback was sent and not saved, so the box is amber.
  | {
      kind: "ok";
      key: string;
      version: string;
      message: string;
      rollbackLine: string | null;
      rollbackFailed: boolean;
      url: string | null;
    }
  // offerNext: the server said the number was taken, so offer the next free
  // one. suggested: the number the server's message names, to spot when
  // GitHub moved on again before the re-read came back.
  | { kind: "err"; message: string; offerNext: boolean; suggested: string | null };

/** The last push that saved a version, as it was sent. */
type PushedVersion = {
  key: string;
  sql: string;
  version: string;
  /** The rollback sent with that push, or null when none was sent. */
  sentDown: string | null;
  /** GitHub holds a rollback with statements for it, so none can be added any more. */
  hasRollback: boolean;
};

/** Adding a rollback to the version just pushed, stamped with that version. */
type AttachStatus = { key: string; version: string; kind: "saving" | "ok" | "err"; message: string };

/** The fields of a /api/github/push answer this screen reads. */
type PushAnswer = {
  ok?: boolean;
  code?: string;
  error?: string;
  url?: string;
  version?: string;
  rollback_saved?: boolean;
  rollback_error?: string;
  rollback_error_code?: string;
  highest_version?: string;
  suggested?: string;
};

/**
 * A version table's value for a sentence: "v2.1.0" for a number, the text
 * as-is otherwise, so a Flyway "V3__init" never becomes "vV3__init".
 */
function asVersion(text: string): string {
  return /^\d/.test(text) ? `v${text}` : text;
}

export function MigrationWorkbench({
  initialSql,
  statementCount,
  heldBackCount,
  manualCount,
  rollbackManualCount,
  initialRollbackSql,
  rollbackStatementCount,
  rollbackCounts,
  rollbackWarnings,
  suggestedName,
  suggestedDescription,
  targetLabel,
  targetSchema,
  targetDatabase,
  suggestedKind,
  counts,
  warnings,
  targetConnectionId,
  versionVerdict,
  sourceVersion,
  targetVersion,
  sourceName,
  targetName,
  swapHref,
}: Props) {
  // Compare can show one workbench per target, so a hard-coded field id would
  // repeat down the page: duplicate ids are invalid HTML and every <label
  // htmlFor> would focus the first workbench's field instead of its own.
  const fieldId = useId();
  const [name, setName] = useState(suggestedName);
  const [description, setDescription] = useState(suggestedDescription);
  const [sql, setSql] = useState(initialSql);
  // The down script is edited and copied independently of the up script. Which
  // one the editor is showing:
  const [pane, setPane] = useState<"up" | "down">("up");
  const [rollbackSql, setRollbackSql] = useState(initialRollbackSql);
  // null = follow the suggestion. Set once the user clicks a level, after
  // which edits to the SQL no longer move it (same idea as the Script Editor).
  const [pickedLevel, setPickedLevel] = useState<ChangeKind | null>(null);
  // The three ticks. Each is reset when the thing it agreed to changes.
  const [quieterAck, setQuieterAck] = useState(false);
  const [pushWithoutRollback, setPushWithoutRollback] = useState(false);
  const [backwardsAck, setBackwardsAck] = useState(false);
  const [copied, setCopied] = useState(false);
  // The two reads the next version is worked out from.
  const [family, setFamily] = useState<FamilyRead | null>(null);
  const [familyRefresh, setFamilyRefresh] = useState(0);
  const [applied, setApplied] = useState<AppliedRead | null>(null);
  // Versions this screen learned from the server's own answers (our pushes,
  // and the highest_version of a 409). GitHub's listing can lag a moment
  // behind a write, so these keep the next number above what we know exists.
  const [learned, setLearned] = useState<{ key: string; versions: string[] }>({ key: "", versions: [] });
  // What was last pushed successfully. Pushing the same migration again would
  // publish a copy of it as the next version, so that is blocked, and the
  // rollback is offered for the version already pushed instead.
  const [lastPushed, setLastPushed] = useState<PushedVersion | null>(null);
  const [push, setPush] = useState<PushState>({ kind: "idle" });
  const [attach, setAttach] = useState<AttachStatus | null>(null);

  // Everything below reads the pane the user is currently looking at.
  const showingDown = pane === "down";
  const activeSql = showingDown ? rollbackSql : sql;
  const activeInitial = showingDown ? initialRollbackSql : initialSql;
  const activeStatementCount = showingDown ? rollbackStatementCount : statementCount;
  const activeCounts = showingDown ? rollbackCounts : counts;
  const activeManualCount = showingDown ? rollbackManualCount : manualCount;

  const edited = activeSql !== activeInitial;
  // Deploy wraps the whole run in one transaction, so manual BEGIN/COMMIT/
  // ROLLBACK would conflict. Same guard the apply route uses, so the two can
  // never disagree — and it ignores comments, which matters here because the
  // down script's own header contains the word ROLLBACK.
  const upTxnViolation = containsTransactionControl(sql);
  const downTxnViolation = containsTransactionControl(rollbackSql);
  // The inline warning is about the pane on screen; the push button is blocked
  // by a violation in either script, because both get saved together.
  const txnViolation = showingDown ? downTxnViolation : upTxnViolation;
  const lineCount = activeSql.split("\n").length;

  const inSync = statementCount === 0;

  // ── The script name ──────────────────────────────────────────────────────
  // The Script Editor's rule: anything but letters, digits, _ and - becomes _.
  // Computed once, so the preview, the saved path and the message agree.
  const scriptName = (name.trim() || suggestedName).replace(/[^a-zA-Z0-9_-]/g, "_");
  // A name can still fail after that: over-long, or left with no letter or
  // digit ("@@@" becomes "___"). The push route asks the same function.
  const nameProblem = validateScriptName(scriptName);
  const folder = `${targetDatabase}/${targetSchema}/${scriptName}/`;
  const familyKey = `${targetDatabase}/${targetSchema}/${scriptName}`;

  // ── The change level ─────────────────────────────────────────────────────
  // The generator's grade, raised (never lowered) by what edits add: a
  // hand-typed DROP TABLE makes the suggestion breaking.
  const grade = gradeSql(sql);
  const suggestion: ChangeKind =
    sql === initialSql ? suggestedKind : louderChangeType(suggestedKind, grade.sureLevel);
  const level: ChangeKind = pickedLevel ?? suggestion;

  // ── The rollback choice (the same rules as the Script Editor) ────────────
  // What goes out as down_sql: the rollback when it has statements and the
  // no-rollback box is not ticked, otherwise nothing.
  const downSql = rollbackToSend(rollbackSql, pushWithoutRollback);
  const rollbackProblem = rollbackChoiceProblem(rollbackSql, pushWithoutRollback);
  const rollbackRuns = hasExecutableSql(rollbackSql);

  // ── The two reads behind the next version ────────────────────────────────
  // Skipped when there is nothing to push, or when the name can't be used
  // (the server would refuse the read, and the name message says why).
  const readsWanted = !inSync && nameProblem === null;
  const appliedKey = `${targetConnectionId}/${targetSchema}/${scriptName}`;

  // (a) The versions already in GitHub. Debounced so typing a name makes one
  // request, not one per key. Re-run by bumping familyRefresh (after a 409).
  useEffect(() => {
    if (!readsWanted) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const read = await readFamilyVersions(targetDatabase, targetSchema, scriptName);
      if (!cancelled) setFamily({ ...read, key: familyKey, refresh: familyRefresh });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [readsWanted, familyKey, familyRefresh, targetDatabase, targetSchema, scriptName]);

  // (b) The version applied to the target, when it has a saved connection.
  useEffect(() => {
    if (!readsWanted || targetConnectionId === null) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const read = await readAppliedVersion(targetConnectionId, targetSchema, scriptName);
      if (!cancelled) setApplied({ ...read, key: appliedKey });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [readsWanted, appliedKey, targetConnectionId, targetSchema, scriptName]);

  // A read counts only when it answers the CURRENT question: a result for
  // another name (or from before a refresh) is the same as no result yet.
  const familyCurrent =
    family !== null && family.key === familyKey && family.refresh === familyRefresh ? family : null;
  const familyLoading = readsWanted && familyCurrent === null;
  const familyError = familyCurrent !== null && !familyCurrent.ok ? familyCurrent.error : null;
  const appliedCurrent =
    targetConnectionId !== null && applied !== null && applied.key === appliedKey ? applied : null;
  const appliedLoading = readsWanted && targetConnectionId !== null && appliedCurrent === null;
  const appliedKnown = appliedCurrent !== null && appliedCurrent.ok;
  const appliedVersion = appliedCurrent !== null && appliedCurrent.ok ? appliedCurrent.version : null;
  // The number is shown (and can be pushed) only once both reads are back
  // and GitHub answered: before that it would be a guess.
  const versionsReady = readsWanted && familyCurrent !== null && familyCurrent.ok && !appliedLoading;

  const githubVersions = familyCurrent !== null && familyCurrent.ok ? familyCurrent.versions : [];
  const learnedVersions = learned.key === familyKey ? learned.versions : [];
  const githubHighest = highestVersion([...githubVersions, ...learnedVersions]);
  const floor = highestVersion([appliedVersion, githubHighest]);
  const bump = levelToBump(level);
  const nextVersion = bumpVersion(floor, bump);
  // The push preview: the files it will create and the step it takes.
  const preview = describePush({ floor, version: nextVersion, withRollback: downSql !== undefined });
  // A quieter level than the grade is allowed, but only with a tick that
  // names what it understates. A first version is 1.0.0 at every level, so
  // there only the recorded level can understate it. Null when no tick is needed.
  const quieterText = quieterLevelWarning(suggestion, level, grade.because, versionsReady && floor === null);

  // ── Direction ────────────────────────────────────────────────────────────
  const movesBackwards = versionVerdict?.newer === "right" && !inSync;

  // ── The same migration again (the Script Editor's rule) ──────────────────
  // Judged on the migration alone: a rollback written or changed since does
  // not make it a new version. What the person usually means is to add that
  // rollback to the version already pushed, so the offer below Push does that.
  const pushedHere = lastPushed !== null && lastPushed.key === familyKey ? lastPushed : null;
  const sameMigration = pushedHere !== null && pushedHere.sql === sql;
  const attachOffer =
    pushedHere !== null &&
    sameMigration &&
    !pushedHere.hasRollback &&
    downSql !== undefined &&
    !downTxnViolation;
  const attachHere = attach !== null && attach.key === familyKey ? attach : null;
  const attachSaving = attachHere?.kind === "saving";

  /**
   * Why Push can't be pressed right now, or null when it can. The first
   * reason wins; it is shown beside the button and as the button's title, so
   * a disabled button always says what to do about it.
   */
  function whyPushIsBlocked(): string | null {
    if (nameProblem) return nameProblem;
    if (!hasExecutableSql(sql)) return MIGRATION_NO_STATEMENTS;
    if (upTxnViolation || downTxnViolation) {
      return `Remove BEGIN / COMMIT / ROLLBACK from the ${
        upTxnViolation ? "migration" : "rollback"
      } script before pushing.`;
    }
    if (familyLoading) return `Checking GitHub for the versions of ${scriptName}…`;
    if (appliedLoading) return `Checking which version of ${scriptName} is applied to ${targetLabel}…`;
    if (familyError) return familyError;
    if (pushedHere !== null && sameMigration) {
      const pushed = pushedHere.version;
      if (attachOffer) {
        return `Add the rollback to v${pushed} with the button below, rather than pushing the same migration again.`;
      }
      if (pushedHere.hasRollback) {
        return `v${pushed} was pushed with this same migration and already has a rollback, which can't be changed. Edit the migration to push a new version.`;
      }
      if (rollbackRuns && pushWithoutRollback) {
        return `v${pushed} was pushed with this same migration. Edit the migration to push a new version, or untick Save without a rollback to add the rollback on the Rollback tab to v${pushed}.`;
      }
      return `v${pushed} was pushed with this same migration. Edit the migration to push a new version, or write a rollback on the Rollback tab to add to v${pushed}.`;
    }
    if (rollbackProblem) return rollbackProblem;
    if (quieterText && !quieterAck) {
      return `Tick "Publish it as ${level} anyway" under Change level, or pick ${suggestion}.`;
    }
    if (movesBackwards && !backwardsAck) {
      return `Tick the box above to confirm ${targetName} should move back to the older schema.`;
    }
    return null;
  }
  const blocker = whyPushIsBlocked();

  // An error describes the push as it was. Once anything it depends on is
  // edited it no longer does, so it is cleared rather than left to disagree
  // with the screen. A success stays: it is still true.
  function clearStaleError() {
    setPush((current) => (current.kind === "err" ? { kind: "idle" } : current));
  }

  // Remember a version the server told us exists, for this family only.
  function learn(key: string, version: string) {
    setLearned((current) => ({
      key,
      versions: current.key === key ? [...current.versions, version] : [version],
    }));
  }

  function pickLevel(kind: ChangeKind) {
    setPickedLevel(kind);
    if (kind !== level) {
      setQuieterAck(false);
      clearStaleError();
    }
  }

  function editActiveSql(text: string) {
    if (showingDown) {
      setRollbackSql(text);
    } else {
      setSql(text);
      // The tick agreed to publishing THIS SQL quieter than graded.
      setQuieterAck(false);
    }
    clearStaleError();
  }

  async function copySql() {
    try {
      await navigator.clipboard.writeText(activeSql);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (e.g. insecure context) — leave the button as-is.
    }
  }

  function regenerate() {
    // This restores the generated script for the pane on screen only — the
    // other pane's edits survive, so the confirm has to say which one it means.
    const question = showingDown
      ? "Discard your edits to the rollback script? The migration pane is not affected."
      : "Discard your edits to the migration script? The rollback pane is not affected.";
    if (edited && !window.confirm(question)) {
      return;
    }
    editActiveSql(activeInitial);
  }

  // Push the migration to the GitHub script registry. The server route holds
  // the token, so there's no token or connection to pick here.
  async function pushToGitHub() {
    if (blocker !== null || push.kind === "pushing") return;
    // Everything is taken from this render, so the answer is reported against
    // exactly what was sent even if the user edits while it runs.
    const version = nextVersion;
    const sentKey = familyKey;
    const sentSql = sql;
    const sentDown = downSql;
    const where = `${targetDatabase}/${targetSchema}/${scriptName}`;
    setPush({ kind: "pushing" });
    // The last offer's outcome was about the version pushed before this one.
    setAttach(null);

    let res: Response;
    let data: PushAnswer | null;
    try {
      res = await fetch("/api/github/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          database_name: targetDatabase,
          schema_name: targetSchema,
          script_name: scriptName,
          version,
          // The level picked above. The route writes it into the file's
          // "-- Change-type:" line, so Deploy shows the level chosen here.
          change_level: level,
          sql_content: sentSql,
          // Saved beside it as v<ver>.down.sql so Deploy can undo the version.
          // Left out when there is no rollback that runs, or the box is ticked.
          down_sql: sentDown,
          description: description.trim() || undefined,
        }),
      });
      data = (await res.json().catch(() => null)) as PushAnswer | null;
    } catch {
      // The request may or may not have reached GitHub. Read GitHub again, so
      // the number shown next is right either way.
      setFamilyRefresh((n) => n + 1);
      setPush({
        kind: "err",
        message: `The connection to the server dropped while pushing v${version}, so it is not known whether it was saved. GitHub is being read again: if it now lists v${version}, the push went through.`,
        offerNext: false,
        suggested: null,
      });
      return;
    }

    if (!res.ok || !data || data.ok !== true) {
      // version_exists / version_not_newer carry the highest version GitHub
      // has. Learn it at once, and re-read the family so the next free number
      // comes from GitHub itself, not from a guess.
      const highest = typeof data?.highest_version === "string" ? data.highest_version : null;
      if (highest !== null) learn(sentKey, highest);
      const unknownOutcome = !data || data.code === "outcome_unknown";
      if (highest !== null || unknownOutcome) setFamilyRefresh((n) => n + 1);
      setPush({
        kind: "err",
        message:
          data?.error ??
          `The server answered with an error (status ${res.status}) and no explanation. GitHub is being read again to see whether v${version} was saved.`,
        offerNext: highest !== null,
        suggested: typeof data?.suggested === "string" ? data.suggested : null,
      });
      return;
    }

    const saved = typeof data.version === "string" ? data.version : version;
    learn(sentKey, saved);
    const url = typeof data.url === "string" ? data.url : null;
    if (sentDown === undefined) {
      setLastPushed({ key: sentKey, sql: sentSql, version: saved, sentDown: null, hasRollback: false });
      setPush({
        kind: "ok",
        key: sentKey,
        version: saved,
        message: `v${saved} pushed to ${where} on GitHub.`,
        rollbackLine: "No rollback was saved, so Deploy cannot undo this version.",
        rollbackFailed: false,
        url,
      });
    } else if (data.rollback_saved === true) {
      setLastPushed({ key: sentKey, sql: sentSql, version: saved, sentDown, hasRollback: true });
      setPush({
        kind: "ok",
        key: sentKey,
        version: saved,
        message: `v${saved} pushed to ${where} on GitHub, with its rollback.`,
        rollbackLine: null,
        rollbackFailed: false,
        url,
      });
    } else {
      // The version is saved; only its rollback is not. The offer below Push
      // adds the rollback to this same version (no new version), unless
      // someone else's rollback is already there: a saved rollback never changes.
      setLastPushed({
        key: sentKey,
        sql: sentSql,
        version: saved,
        sentDown,
        hasRollback: data.rollback_error_code === "rollback_exists",
      });
      setPush({
        kind: "ok",
        key: sentKey,
        version: saved,
        message: `v${saved} pushed to ${where} on GitHub.`,
        rollbackLine: data.rollback_error ?? `Its rollback was not saved, so Deploy cannot undo v${saved} yet.`,
        rollbackFailed: true,
        url,
      });
    }
  }

  // The offer below Push: add the rollback on the Rollback tab to the version
  // just pushed with this same migration. This is the push route's attach
  // mode: it never creates a version, and it refuses when the version already
  // has a rollback with statements.
  async function addRollbackToPushed() {
    if (!attachOffer || pushedHere === null || downSql === undefined || attachSaving) return;
    // Taken from this render, so the answer is reported against what was sent.
    const key = familyKey;
    const version = pushedHere.version;
    const text = downSql;
    setAttach({ key, version, kind: "saving", message: "" });

    let outcome: { kind: "ok" | "err"; message: string; hasRollback: boolean };
    try {
      const res = await fetch("/api/github/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          attach_rollback: true,
          database_name: targetDatabase,
          schema_name: targetSchema,
          script_name: scriptName,
          version,
          down_sql: text,
        }),
      });
      const data = (await res.json().catch(() => null)) as PushAnswer | null;
      if (res.ok && data?.ok === true) {
        outcome = { kind: "ok", message: `Rollback saved. Deploy can now undo v${version}.`, hasRollback: true };
      } else if (data?.code === "rollback_exists") {
        // After a dropped connection it may be OUR rollback that is there, so
        // don't claim it is someone else's. Either way none can be added now.
        outcome = {
          kind: "err",
          message: `v${version} already has a rollback with statements, so nothing more was saved. A saved rollback never changes.`,
          hasRollback: true,
        };
      } else {
        outcome = {
          kind: "err",
          message: data?.error ?? `Saving the rollback failed (status ${res.status}) without an explanation from the server.`,
          hasRollback: false,
        };
      }
    } catch {
      outcome = {
        kind: "err",
        message: `The connection to the server dropped while saving the rollback for v${version}, so it is not known whether it was saved. Trying again is safe: if it was saved, the retry changes nothing and says so.`,
        hasRollback: false,
      };
    }

    // Only this click's own status is replaced: a push started meanwhile
    // cleared it, and this answer is then about a version no longer shown.
    setAttach((current) =>
      current !== null && current.key === key && current.version === version && current.kind === "saving"
        ? { key, version, kind: outcome.kind, message: outcome.message }
        : current,
    );
    if (outcome.hasRollback) {
      // No rollback can be added to it any more, so the offer goes; and the
      // push box's line about the missing rollback is out of date, so it goes too.
      setLastPushed((current) =>
        current !== null && current.key === key && current.version === version
          ? { ...current, hasRollback: true }
          : current,
      );
      setPush((current) =>
        current.kind === "ok" && current.key === key && current.version === version
          ? { ...current, rollbackLine: null, rollbackFailed: false }
          : current,
      );
    }
  }

  // "Retry" only when the rollback on the tab is the one the push failed to save.
  const attachLabel =
    pushedHere !== null && pushedHere.sentDown !== null && pushedHere.sentDown === downSql
      ? "Retry saving the rollback"
      : `Add this rollback to v${pushedHere !== null ? pushedHere.version : ""}`;

  // The backwards warning's numbers, from each side's own version table.
  const targetDeclares = targetVersion?.version ? asVersion(targetVersion.version) : "a newer version";
  const inTable = targetVersion?.table ? ` in its ${targetVersion.table} table` : "";
  const sourceDeclares = sourceVersion?.version ? asVersion(sourceVersion.version) : "an older version";

  return (
    <aside>
      <div className="sticky-panel space-y-4">
        <div className="card overflow-hidden">
          {/* Header: name + description */}
          <div className="px-5 pt-4 pb-3">
            <div className="flex items-center gap-2 mb-3">
              <span className="section-title">Generated migration</span>
              <span className="pill pill-neutral">
                <span className="dot" style={{ background: "var(--text-3)" }} />
                draft
              </span>
              <span className="ml-auto text-[11px]" style={{ color: "var(--text-3)" }}>
                modifies <span className="mono">{targetLabel}</span>
              </span>
            </div>

            <label className="label" htmlFor={`${fieldId}-name`}>
              Migration name
            </label>
            <input
              id={`${fieldId}-name`}
              className="input mono mt-1"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                clearStaleError();
              }}
              placeholder="migration_name"
            />
            {/* The name the file is really saved under, whenever it is not
                exactly what was typed. */}
            {scriptName !== "" && name.trim() === "" && (
              <p className="help mt-1">
                Saved as <span className="mono">{scriptName}</span>, the suggested name.
              </p>
            )}
            {name.trim() !== "" && scriptName !== name.trim() && (
              <p className="help mt-1">
                Saved as <span className="mono">{scriptName}</span> — spaces and symbols become _.
              </p>
            )}
            {nameProblem && (
              <p className="help mt-1" style={{ color: "var(--break)" }}>
                {nameProblem}
              </p>
            )}
            <label className="label mt-2 block" htmlFor={`${fieldId}-description`}>
              Description
            </label>
            <textarea
              id={`${fieldId}-description`}
              className="input mt-1"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional title / description for the changelog…"
              rows={2}
              // The push route refuses a description over 1000 characters.
              maxLength={1000}
              style={{ resize: "none" }}
            />
          </div>

          {inSync ? (
            <div className="px-5 pb-5">
              <p className="help">
                No migration statements are needed — the two schemas are already in
                sync. There is nothing to save.
              </p>
            </div>
          ) : (
            <>
              {/* SQL editor */}
              <div className="px-5 pb-2">
                <div className="flex items-center justify-between mb-2">
                  <div className="seg" role="tablist" aria-label="Script direction">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={!showingDown}
                      className={showingDown ? "" : "active"}
                      onClick={() => setPane("up")}
                      title="The migration that makes the target match the source."
                    >
                      Migration
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={showingDown}
                      className={showingDown ? "active" : ""}
                      onClick={() => setPane("down")}
                      title="The down script that undoes the migration."
                    >
                      Rollback
                    </button>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={regenerate}
                      title="Discard edits in this pane and restore the generated script"
                    >
                      <RefreshIcon size={12} />
                      Reset
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={copySql}>
                      {copied ? <CheckIcon size={12} /> : <ClipboardIcon size={12} />}
                      {copied ? "Copied" : "Copy"}
                    </button>
                  </div>
                </div>

                {showingDown && rollbackWarnings.length > 0 && (
                  <div className="warn-inline mb-2">
                    <span className="ico">
                      <AlertTriangleIcon size={14} />
                    </span>
                    <div>
                      <b>This restores structure, not data.</b>
                      <ul className="mt-1 space-y-0.5">
                        {rollbackWarnings.map((w) => (
                          <li key={w}>· {w}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                )}

                {!showingDown && (
                  <p className="text-[11px] mb-1.5" style={{ color: "var(--text-3)" }}>
                    Safe to run twice: anything this script creates or adds, and any new name
                    it gives, is skipped if it is already there. Changed objects are rebuilt
                    and column types converted again on every run, so compare again afterwards.
                  </p>
                )}

                <textarea
                  className="sql-textarea mono"
                  // The tab strip above names the pane visually, but nothing tied
                  // it to the editor — so the only editable field on the panel
                  // was announced as an unnamed text box.
                  aria-label={showingDown ? "Rollback SQL — editable" : "Migration SQL — editable"}
                  value={activeSql}
                  onChange={(e) => editActiveSql(e.target.value)}
                  spellCheck={false}
                />

                <div
                  className="flex items-center justify-between mt-1.5 text-[11px]"
                  style={{ color: "var(--text-3)" }}
                >
                  <span>
                    {countOf(lineCount, "line")} ·{" "}
                    {countOf(activeStatementCount, "statement")}
                    {activeManualCount > 0 && (
                      <>
                        {" "}
                        <span style={{ color: "var(--drift)" }}>
                          ({activeManualCount} {activeManualCount === 1 ? "note" : "notes"},
                          nothing to run)
                        </span>
                      </>
                    )}
                    {!showingDown && heldBackCount > 0 && (
                      <>
                        {" "}
                        {/* "held back" is the word the diff report uses for the
                            same fact — say both so the two pages line up. */}
                        <span style={{ color: "var(--break)" }}>
                          ({heldBackCount} held back — commented out)
                        </span>
                      </>
                    )}{" "}
                    · {showingDown ? "rollback SQL" : "SQL"}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span
                      className="w-1.5 h-1.5 rounded-full"
                      style={{ background: edited ? "var(--drift)" : "var(--text-3)" }}
                    />
                    {edited ? "Edited" : "Unedited"}
                  </span>
                </div>

                {/* Severity tally from the generator */}
                <div className="flex items-center gap-1.5 mt-3">
                  <span className="delta delta-rem" style={activeCounts.breaking ? undefined : { opacity: 0.45 }}>
                    {activeCounts.breaking} breaking
                  </span>
                  <span className="delta delta-add" style={activeCounts.safe ? undefined : { opacity: 0.45 }}>
                    {activeCounts.safe} safe
                  </span>
                  <span className="delta delta-chg" style={activeCounts.info ? undefined : { opacity: 0.45 }}>
                    {activeCounts.info} info
                  </span>
                </div>

                {/* Transaction-control guardrail */}
                {txnViolation && (
                  <div className="warn-inline mt-3">
                    <span className="ico">
                      <AlertTriangleIcon size={14} />
                    </span>
                    <div>
                      <b>{"Transaction control isn't allowed."}</b> Deploy wraps the whole
                      run in one transaction. Remove <span className="mono">BEGIN</span>{" "}
                      / <span className="mono">COMMIT</span> / <span className="mono">ROLLBACK</span>{" "}
                      before pushing.
                    </div>
                  </div>
                )}

                {/* Generator warnings (e.g. tables/columns only in target — not dropped) */}
                {warnings.length > 0 && (
                  <div className="warn-inline mt-3" style={{ flexDirection: "column", gap: 6 }}>
                    <div className="flex items-center gap-2">
                      <span className="ico">
                        <AlertTriangleIcon size={14} />
                      </span>
                      <b>Not included in this migration ({warnings.length})</b>
                    </div>
                    <ul className="space-y-1 mt-1" style={{ paddingLeft: 22 }}>
                      {warnings.map((w) => (
                        <li key={w} className="text-[12px]" style={{ color: "var(--text-2)" }}>
                          {w}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              {/* Change level + the next version it makes */}
              <div
                className="px-5 py-4"
                style={{ borderTop: "1px solid var(--border)", background: "var(--surface-2)" }}
              >
                <div className="flex items-center justify-between mb-3">
                  <span className="section-title">Change level</span>
                  <span className="text-[11px]" style={{ color: "var(--text-3)" }}>
                    {level === suggestion ? "auto-suggested" : `suggested: ${suggestion}`}
                  </span>
                </div>
                <div className="seg" role="group" aria-label="Change level">
                  {CHANGE_LEVELS.map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      className={`lvl-${kind}${level === kind ? " active" : ""}`}
                      onClick={() => pickLevel(kind)}
                      aria-pressed={level === kind}
                    >
                      <span className="swatch" />
                      {kind}
                    </button>
                  ))}
                </div>

                {/* A quieter level than the grade needs a tick naming why. */}
                {quieterText && (
                  <div className="prod-gate prod-gate--drift mt-3">
                    <label className="prod-gate__ack" style={{ marginTop: 0 }}>
                      <input
                        type="checkbox"
                        checked={quieterAck}
                        onChange={(e) => {
                          setQuieterAck(e.target.checked);
                          clearStaleError();
                        }}
                      />
                      <span>{quieterText}</span>
                    </label>
                  </div>
                )}

                <div className="panel p-3 mt-4" style={{ background: "var(--surface)" }}>
                  {nameProblem ? (
                    <p className="help">
                      The next version is worked out once the script name can be used.
                    </p>
                  ) : familyLoading || appliedLoading ? (
                    <p className="help">
                      {familyLoading
                        ? `Checking GitHub for the versions of ${scriptName}…`
                        : `Checking which version of ${scriptName} is applied to ${targetLabel}…`}
                    </p>
                  ) : familyError ? (
                    <div>
                      <p className="text-[12px]" style={{ color: "var(--break)" }}>
                        {familyError}
                      </p>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm mt-2"
                        onClick={() => setFamilyRefresh((n) => n + 1)}
                      >
                        <RefreshIcon size={12} />
                        Check GitHub again
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <div className="text-[11px]" style={{ color: "var(--text-3)" }}>
                            Next version
                          </div>
                          <div className="text-[15px] mt-0.5 font-semibold mono">v{nextVersion}</div>
                        </div>
                        <span className="help break-words sm:text-right sm:max-w-[260px]">
                          {floor === null
                            ? // The push preview below already says "First version of this
                              // family"; this line says why, in the same shape as the one below.
                              `${appliedKnown ? `Applied to ${targetLabel}: none · ` : ""}In GitHub: none · a new family starts at v${nextVersion}; the level you pick is still recorded`
                            : `${
                                appliedKnown
                                  ? `Applied to ${targetLabel}: ${appliedVersion ? `v${appliedVersion}` : "none"} · `
                                  : ""
                              }In GitHub: ${githubHighest ? `v${githubHighest}` : "none"} · a ${bump} (${level}) change makes v${nextVersion}`}
                        </span>
                      </div>
                      {/* Only GitHub could be checked: say so, since a version
                          applied to the target could otherwise be missed. */}
                      {!appliedKnown && (
                        <p className="help mt-2">
                          {targetConnectionId === null
                            ? "The applied version can't be read — this target has no saved connection, so only GitHub is checked."
                            : `Couldn't read the versions applied to ${targetLabel}; only GitHub is checked.`}
                        </p>
                      )}
                    </>
                  )}
                </div>
              </div>

              {/* Footer: the confirmations, the preview, and Push */}
              <div
                className="px-5 py-3 space-y-3"
                style={{ borderTop: "1px solid var(--border)" }}
              >
                {/* The target's own version table says it is ahead: pushing
                    would take it back to the older schema. Allowed, never
                    silent. */}
                {movesBackwards && (
                  <div className="prod-gate prod-gate--drift">
                    <div className="prod-gate__head">
                      <AlertTriangleIcon size={15} className="ico" />
                      <span>This would move {targetName} backwards</span>
                    </div>
                    <p className="prod-gate__body">
                      {`${targetName} declares ${targetDeclares}${inTable}; ${sourceName} declares ${sourceDeclares}. The script below changes ${targetName} to match the older schema, so it may undo anything that arrived in the newer version.`}
                    </p>
                    {swapHref && (
                      <div className="mt-2">
                        <Link
                          href={swapHref}
                          className="btn btn-ghost btn-sm"
                          title={`Compare with ${targetName} as the source and ${sourceName} as the target`}
                        >
                          Compare the other way instead
                        </Link>
                      </div>
                    )}
                    <label className="prod-gate__ack">
                      <input
                        type="checkbox"
                        checked={backwardsAck}
                        onChange={(e) => {
                          setBackwardsAck(e.target.checked);
                          clearStaleError();
                        }}
                      />
                      <span>I have checked this and want {targetName} to match the older schema.</span>
                    </label>
                  </div>
                )}

                {/* The rollback's warnings live on the Rollback tab; point at
                    them from here, since that is where Push is pressed. */}
                {downSql !== undefined && rollbackWarnings.length > 0 && !showingDown && (
                  <div className="flex items-center justify-between gap-3 flex-wrap text-[12px]" style={{ color: "var(--text-2)" }}>
                    <span className="min-w-0 flex-1">
                      The rollback has {countOf(rollbackWarnings.length, "warning")} about what it
                      cannot put back — read them before pushing.
                    </span>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPane("down")}>
                      Open the Rollback tab
                    </button>
                  </div>
                )}

                {/* Saving without a rollback is a choice, not a default. The
                    box appears when there is no rollback that runs (or when it
                    is ticked, so it can be unticked). */}
                {(!rollbackRuns || pushWithoutRollback) && (
                  <label
                    className="flex items-start gap-2 text-[12px]"
                    style={{ color: "var(--text-2)", cursor: "pointer" }}
                  >
                    <input
                      type="checkbox"
                      checked={pushWithoutRollback}
                      onChange={(e) => {
                        setPushWithoutRollback(e.target.checked);
                        clearStaleError();
                      }}
                      style={{ marginTop: 2 }}
                    />
                    <span>Save without a rollback — Deploy will not be able to undo this version</span>
                  </label>
                )}

                {/* The push preview: the step, and the exact files. */}
                {versionsReady && (
                  <div className="text-[12px] space-y-0.5" style={{ color: "var(--text-2)" }}>
                    <div>{preview.stepLine}</div>
                    <div className="min-w-0">
                      Creates{" "}
                      {preview.files.map((file, index) => (
                        <span key={file}>
                          {index > 0 && " and "}
                          <span className="mono">{file}</span>
                        </span>
                      ))}{" "}
                      in <span className="mono break-all">{folder}</span>
                    </div>
                    {preview.noRollbackLine && (
                      <div style={{ color: "var(--drift)" }}>{preview.noRollbackLine}</div>
                    )}
                  </div>
                )}

                <div className="flex items-center gap-3 flex-wrap">
                  {blocker && push.kind !== "pushing" && (
                    <p className="help min-w-0 flex-1">{blocker}</p>
                  )}
                  <button
                    type="button"
                    className="btn btn-primary btn-sm ml-auto"
                    onClick={pushToGitHub}
                    disabled={push.kind === "pushing" || blocker !== null}
                    title={blocker ?? undefined}
                  >
                    {push.kind === "pushing"
                      ? "Pushing…"
                      : versionsReady
                        ? `Push v${nextVersion} to GitHub`
                        : "Push to GitHub"}
                  </button>
                </div>

                {/* Inline push result: green, or amber when a rollback was
                    sent and not saved. */}
                {push.kind === "ok" && (
                  <div
                    className="warn-inline"
                    style={push.rollbackFailed ? undefined : { background: "var(--sync-soft)" }}
                  >
                    <span className="ico" style={push.rollbackFailed ? undefined : { color: "var(--sync)" }}>
                      {push.rollbackFailed ? <AlertTriangleIcon size={14} /> : <CheckIcon size={14} />}
                    </span>
                    <div className="min-w-0">
                      <div>
                        {push.message}
                        {push.url && (
                          <>
                            {" "}
                            <a
                              href={push.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ color: "var(--brand)", textDecoration: "underline" }}
                            >
                              View on GitHub
                            </a>
                          </>
                        )}
                      </div>
                      {push.rollbackLine && <div className="mt-1">{push.rollbackLine}</div>}
                    </div>
                  </div>
                )}

                {/* Add the rollback on the Rollback tab to the version just
                    pushed with this same migration. Its outcome stays after
                    the offer goes away. */}
                {(attachOffer || (attachHere !== null && attachHere.kind !== "saving")) && (
                  <div className="panel p-3">
                    {attachOffer && pushedHere !== null && (
                      <>
                        <p className="text-[12.5px]" style={{ color: "var(--text-2)" }}>
                          {`This adds the rollback on the Rollback tab to v${pushedHere.version} as v${pushedHere.version}.down.sql; no new version is made. A saved rollback cannot be changed afterwards, so read it carefully first.`}
                        </p>
                        <button
                          type="button"
                          className="btn btn-primary btn-sm mt-2"
                          disabled={attachSaving}
                          onClick={addRollbackToPushed}
                        >
                          {attachSaving ? "Saving the rollback…" : attachLabel}
                        </button>
                      </>
                    )}
                    {attachHere !== null && attachHere.kind !== "saving" && (
                      <p
                        className={`text-[12.5px]${attachOffer ? " mt-2" : ""}`}
                        style={{ color: attachHere.kind === "ok" ? "var(--sync)" : "var(--drift)" }}
                      >
                        {attachHere.message}
                      </p>
                    )}
                  </div>
                )}
                {push.kind === "err" && (
                  <div className="warn-inline">
                    <span className="ico">
                      <AlertTriangleIcon size={14} />
                    </span>
                    <div className="min-w-0">
                      <div>{push.message}</div>
                      {push.offerNext && (
                        <>
                          {versionsReady && push.suggested !== null && push.suggested !== nextVersion && (
                            <div className="mt-1">
                              GitHub changed again since then, so the next free number is now v{nextVersion}.
                            </div>
                          )}
                          <button
                            type="button"
                            className="btn btn-primary btn-sm mt-2"
                            onClick={pushToGitHub}
                            disabled={blocker !== null}
                            title={blocker ?? undefined}
                          >
                            {versionsReady ? `Push as v${nextVersion} instead` : "Checking GitHub…"}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* "What this will do": only once the number is known, so it never
            names a file that would not be written. */}
        {!inSync && versionsReady && (
          <div className="card p-4">
            <div className="section-title mb-2">What this will do</div>
            <ul className="space-y-1.5 text-[12.5px]" style={{ color: "var(--text-2)" }}>
              <li className="flex gap-2">
                <span style={{ color: "var(--sync)" }}>●</span>
                <span className="min-w-0">
                  Push this migration to the GitHub registry at{" "}
                  <span className="mono break-all">
                    {folder}v{nextVersion}.sql
                  </span>
                  .
                </span>
              </li>
              {downSql !== undefined ? (
                <li className="flex gap-2">
                  <span style={{ color: "var(--sync)" }}>●</span>
                  <span className="min-w-0">
                    Save the rollback beside it as{" "}
                    <span className="mono break-all">v{nextVersion}.down.sql</span>, so Deploy can
                    undo this version.
                  </span>
                </li>
              ) : (
                <li className="flex gap-2">
                  <span style={{ color: "var(--drift)" }}>●</span>
                  <span className="min-w-0">
                    No rollback will be saved — this version cannot be undone from Deploy.
                  </span>
                </li>
              )}
              <li className="flex gap-2">
                <span style={{ color: "var(--sync)" }}>●</span>
                <span className="min-w-0">
                  {`Record it as ${levelWithArticle(level)} change in the file's Change-type line: the level Deploy shows for this version.`}
                </span>
              </li>
              <li className="flex gap-2">
                <span style={{ color: "var(--sync)" }}>●</span>
                <span className="min-w-0">
                  Make it available to apply to a database from{" "}
                  <span className="mono">Deploy</span>.
                </span>
              </li>
            </ul>
          </div>
        )}
      </div>
    </aside>
  );
}
