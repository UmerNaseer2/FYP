"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Select } from "@/components/ui/Select";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  EditIcon,
  ConnectionsIcon,
  CheckIcon,
  AlertTriangleIcon,
  RefreshIcon,
} from "@/components/ui/icons";
import { containsTransactionControl, hasExecutableSql } from "@/lib/sql-guard";
import {
  gradeSql,
  levelWithArticle,
  quieterLevelWarning,
  type ScriptChangeType,
  type SqlGrade,
} from "@/lib/change-type";
import {
  bumpToLevel,
  bumpVersion,
  compareVersions,
  highestVersion,
  levelOfStep,
  levelToBump,
  type BumpLevel,
} from "@/lib/script-status";
import {
  readAppliedVersion,
  readFamilyVersions,
  type AppliedVersionRead,
  type FamilyVersionsRead,
} from "@/lib/family-reads";
import {
  describePush,
  MIGRATION_NO_STATEMENTS,
  normalizePushVersion,
  rollbackChoiceProblem,
  rollbackToSend,
  validateScriptName,
  type PulledRollbackState,
} from "@/lib/registry-push";
import { countOf } from "@/lib/plural";

// ── Shapes of the data we pull from existing endpoints ──────────────────────
type Connection = {
  id: number;
  name: string;
  host: string;
  database_name: string;
};

/** One saved version, as GET /api/github/pull lists it. */
type GitHubScript = {
  database_name: string;
  schema_name: string;
  script_name: string;
  version: string;
  path: string;
  sql_content: string;
  /** Sent only when rollback_state is "usable". */
  down_sql?: string;
  rollback_state: PulledRollbackState;
};

/** The registry pull, or why it failed. `code` is the route's error code. */
type RegistryRead =
  | { ok: true; scripts: GitHubScript[]; warnings: string[] }
  | { ok: false; error: string; code: string | null };

/** What POST /api/github/push answers (only the fields this page reads). */
type PushAnswer = {
  ok?: boolean;
  code?: string;
  error?: string;
  url?: string;
  version?: string;
  paths?: { migration?: string; rollback?: string | null };
  rollback_saved?: boolean;
  rollback_error?: string;
  rollback_error_code?: string;
  highest_version?: string;
};

// A read counts only for the question it answered: `key` names the family
// it was for, and `refresh` which re-read.
type FamilyRead = FamilyVersionsRead & { key: string; refresh: number };
type AppliedRead = AppliedVersionRead & { key: string };

/**
 * The last Save's outcome. "partial": the version is saved, its rollback is
 * not. key/version: the family and version saved. note: it went out without a
 * rollback. The lines about a missing rollback are dropped once the offer
 * below Save adds one, so the two boxes never disagree.
 */
type SaveResult =
  | { kind: "ok"; key: string; version: string; message: string; note: string | null; url: string | null }
  | { kind: "partial"; key: string; version: string; message: string; url: string | null; rollbackError: string }
  | { kind: "err"; message: string };

/** Adding a rollback to a version that is already saved (attach mode), for one family. */
type AttachStatus = { key: string; version: string; kind: "saving" | "ok" | "err"; message: string };

/** What the last successful Save sent, so the same migration is not saved twice. */
type LastSaved = { key: string; sql: string; rollbackSql: string; version: string; withRollback: boolean };

const BUMP_LEVELS: BumpLevel[] = ["patch", "minor", "major"];
// Shown on each button, so the person picking a level does not have to already
// know what semver means.
const BUMP_DESC: Record<BumpLevel, string> = {
  patch: "fixes and data — nothing changes shape",
  minor: "adds things — existing queries still work",
  major: "changes or removes things — existing queries can break",
};

// Name the keywords the guard actually rejects (lib/sql-guard.ts) — the old
// wording named BEGIN, which it ignores, and left out END and ABORT, which it
// blocks.
const TXN_IN_MIGRATION =
  "Remove the transaction statement — COMMIT, ROLLBACK, ABORT, a standalone END, or PREPARE TRANSACTION. Deploy runs the whole script in one transaction of its own, so the script must not open or close one.";
const TXN_IN_ROLLBACK =
  "Remove the transaction statement — COMMIT, ROLLBACK, ABORT, a standalone END, or PREPARE TRANSACTION. The revert runs the whole script in one transaction of its own, so the script must not open or close one.";

/**
 * The suggestion pill's text, e.g. "SQL reads as breaking (ALTER COLUMN … TYPE)
 * — unless it only widens the column". The statement words and the "unless"
 * sentence come straight from gradeSql, so the pill names exactly what drove
 * the suggestion, and says so when the SQL alone cannot settle it.
 */
function gradeSentence(grade: SqlGrade): string {
  let text = `SQL reads as ${grade.level}`;
  if (grade.because) text += ` (${grade.because})`;
  if (grade.unless) text += ` — unless ${grade.unless}`;
  return text;
}

/** A version without a leading "v": the screen adds its own, and "vv1.2.0" would be wrong. */
function bare(version: string): string {
  return version.trim().replace(/^v/i, "");
}

/** The same saved version: same family, and the same number (1.2 is 1.2.0). */
function sameVersion(a: GitHubScript, b: GitHubScript): boolean {
  return (
    a.database_name === b.database_name &&
    a.schema_name === b.schema_name &&
    a.script_name === b.script_name &&
    compareVersions(a.version, b.version) === 0
  );
}

/**
 * Whether a rollback can still be added to a saved version: only where there
 * is none, or where it runs nothing. The push route's attach mode has the
 * same rule, because a rollback with statements never changes once saved.
 */
function needsRollback(state: PulledRollbackState): boolean {
  return state === "none" || state === "no_statements";
}

/**
 * The registry as last pulled, plus the versions this page saved itself.
 * GitHub's listing can lag a moment behind a write, so a version saved here
 * is kept even when a reload does not list it yet, and a rollback saved here
 * stays saved even when a reload still shows the version without one.
 */
function combineRows(pulled: GitHubScript[], own: GitHubScript[]): GitHubScript[] {
  const rows = pulled.map((row): GitHubScript => {
    const mine = own.find((candidate) => sameVersion(candidate, row));
    return mine && mine.rollback_state === "usable" && needsRollback(row.rollback_state) ? mine : row;
  });
  for (const mine of own) {
    if (!pulled.some((row) => sameVersion(row, mine))) rows.push(mine);
  }
  return rows;
}

/** GET /api/github/pull: every saved version, and any part that could not be read. */
async function readRegistry(): Promise<RegistryRead> {
  try {
    const res = await fetch("/api/github/pull", { cache: "no-store" });
    const data = (await res.json().catch(() => null)) as
      | { scripts?: unknown; warnings?: unknown; error?: unknown; code?: unknown }
      | null;
    if (res.ok && data && Array.isArray(data.scripts)) {
      return {
        ok: true,
        scripts: data.scripts as GitHubScript[],
        warnings: Array.isArray(data.warnings)
          ? data.warnings.filter((warning): warning is string => typeof warning === "string")
          : [],
      };
    }
    return {
      ok: false,
      error:
        typeof data?.error === "string" && data.error.trim() !== ""
          ? data.error
          : `Could not read the GitHub registry (status ${res.status}).`,
      code: typeof data?.code === "string" ? data.code : null,
    };
  } catch {
    return { ok: false, error: "Could not reach the server to read the GitHub registry.", code: null };
  }
}

export default function ScriptEditorPage() {
  // ── Target selection ──────────────────────────────────────────────────────
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectionsLoaded, setConnectionsLoaded] = useState(false);
  const [connectionsFailed, setConnectionsFailed] = useState(false);
  const [connectionId, setConnectionId] = useState("");

  const [schemas, setSchemas] = useState<string[]>([]);
  const [schemasLoading, setSchemasLoading] = useState(false);
  const [schemasError, setSchemasError] = useState("");
  const [schema, setSchema] = useState("");

  // The GitHub registry as last pulled: the existing families, and every
  // saved version with how its rollback reads.
  const [registryRows, setRegistryRows] = useState<GitHubScript[]>([]);
  // Versions this page saved, or added a rollback to, itself (see combineRows).
  const [ownRows, setOwnRows] = useState<GitHubScript[]>([]);
  // Folders or files the pull could not read. The rest is still listed.
  const [pullWarnings, setPullWarnings] = useState<string[]>([]);
  const [githubError, setGithubError] = useState("");
  // The pull's error code. "github_unconfigured" means GitHub is not set up on
  // this server: read from the code rather than the wording of the message.
  const [pullCode, setPullCode] = useState<string | null>(null);
  // Starts true: before the pull lands, an empty registry is unknown, not empty.
  const [githubLoading, setGithubLoading] = useState(true);

  const [familyMode, setFamilyMode] = useState<"existing" | "new">("existing");
  const [existingFamily, setExistingFamily] = useState("");
  const [newFamily, setNewFamily] = useState("");

  // ── Script + version ────────────────────────────────────────────────────--
  const [sql, setSql] = useState("");
  // The script that undoes this one. Deploy can undo a version only when it
  // has one, so saving without one takes a tick (saveWithoutRollback).
  const [rollbackSql, setRollbackSql] = useState("");
  const [saveWithoutRollback, setSaveWithoutRollback] = useState(false);
  const [description, setDescription] = useState("");

  // The two reads the next version is worked out from (lib/family-reads.ts).
  // The Migration Workbench uses the same two, so both offer the same number.
  const [family, setFamily] = useState<FamilyRead | null>(null);
  const [familyRefresh, setFamilyRefresh] = useState(0);
  const [applied, setApplied] = useState<AppliedRead | null>(null);
  // Versions the server said exist (the highest_version of a 409). GitHub's
  // listing can lag a moment behind a write, so these keep the next number
  // above what is known to be there.
  const [learned, setLearned] = useState<{ key: string; versions: string[] }>({ key: "", versions: [] });

  // The picked level (or custom number) for one target and family. Under any
  // other key the page follows the SQL's suggestion again, so a family never
  // starts from the last family's pick.
  const [choice, setChoice] = useState<{ key: string; pick: BumpLevel | "custom"; custom: string } | null>(
    null,
  );
  // The quieter-level tick. It holds the key of what was agreed to (family,
  // warning and SQL), so changing any of them unticks it.
  const [quieterAck, setQuieterAck] = useState("");

  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<LastSaved | null>(null);
  const [saveResult, setSaveResult] = useState<SaveResult | null>(null);
  // Adding the rollback in the box to the version just saved (below Save).
  const [offerStatus, setOfferStatus] = useState<AttachStatus | null>(null);
  // One rollback save at a time. The buttons disable through state, but two
  // quick presses (or an edit to the box while a save runs) can let a second
  // press through before React re-renders; a ref is read and set at once.
  const attachInFlight = useRef(false);
  // The "Add a missing rollback" card: which saved version, and its rollback.
  const [fix, setFix] = useState<{ key: string; version: string; text: string }>({
    key: "",
    version: "",
    text: "",
  });
  const [fixStatus, setFixStatus] = useState<AttachStatus | null>(null);

  // ── Load connections + the GitHub registry once ─────────────────────────---
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/connections", { cache: "no-store" });
        // An unreadable list is not an empty one, and the two need different
        // advice — one is fixed by adding a connection, the other is not.
        const data = res.ok ? await res.json() : null;
        if (!active) return;
        if (Array.isArray(data)) setConnections(data);
        else setConnectionsFailed(true);
      } catch {
        if (active) setConnectionsFailed(true);
      } finally {
        if (active) setConnectionsLoaded(true);
      }
    })();
    (async () => {
      const read = await readRegistry();
      if (!active) return;
      if (read.ok) {
        setRegistryRows(read.scripts);
        setPullWarnings(read.warnings);
      } else {
        setGithubError(read.error);
        setPullCode(read.code);
      }
      setGithubLoading(false);
    })();
    return () => {
      active = false;
    };
  }, []);

  // ── Fetch schemas when the connection changes ───────────────────────────---
  useEffect(() => {
    // Clear the previous connection's schemas up front so a failed load can't
    // leave the old list selectable under the new target.
    setSchemas([]);
    if (!connectionId) return;
    let active = true;
    setSchemasLoading(true);
    setSchemasError("");
    (async () => {
      try {
        const res = await fetch(`/api/scripts/schemas?connectionId=${connectionId}`, { cache: "no-store" });
        const data = await res.json();
        if (!active) return;
        if (Array.isArray(data?.schemas)) setSchemas(data.schemas);
        else setSchemasError(data?.error ?? "Could not load schemas.");
      } catch {
        if (active) setSchemasError("Could not load schemas. Is the database reachable?");
      } finally {
        if (active) setSchemasLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [connectionId]);

  // ── Derived target context ──────────────────────────────────────────────--
  const selectedConnection = useMemo(
    () => connections.find((c) => String(c.id) === connectionId) ?? null,
    [connections, connectionId],
  );
  const databaseName = selectedConnection?.database_name ?? "";
  // How messages name the target: by the connection's own name.
  const targetLabel = selectedConnection?.name ?? "this database";
  // Without the three settings the pull failed AND a save would fail the same
  // way, so there is nothing to read the versions from or save into.
  const githubUnconfigured = pullCode === "github_unconfigured";

  const scriptName = (familyMode === "new" ? newFamily : existingFamily).trim();

  const rows = useMemo(() => combineRows(registryRows, ownRows), [registryRows, ownRows]);

  // Families that already exist in GitHub for this database + schema.
  const existingFamilies = useMemo(() => {
    if (!databaseName || !schema) return [];
    const names = rows
      .filter((s) => s.database_name === databaseName && s.schema_name === schema)
      .map((s) => s.script_name);
    return Array.from(new Set(names)).sort();
  }, [rows, databaseName, schema]);

  // Why the family name can't be used, or null. The push route checks the
  // same rule (validateScriptName), so the page never offers a doomed save.
  // That includes what the sanitizer leaves of junk like "@@@": "___", which
  // has no letter or digit in it.
  const nameProblem = !scriptName ? null : validateScriptName(scriptName);

  // A new family that differs from an existing one only by case would create a
  // duplicate, case-variant folder (GitHub paths are case-sensitive). Warn.
  const caseClash =
    familyMode === "new" && scriptName
      ? existingFamilies.find((f) => f.toLowerCase() === scriptName.toLowerCase() && f !== scriptName) ?? null
      : null;

  // ── The two reads behind the next version ────────────────────────────────
  // One key per question: which family in GitHub, and which family on which
  // target. Empty while the question can't be asked yet.
  const familyKey =
    databaseName && schema && scriptName && nameProblem === null
      ? JSON.stringify([databaseName, schema, scriptName])
      : "";
  const appliedKey = familyKey && connectionId ? JSON.stringify([connectionId, schema, scriptName]) : "";
  // A picked level belongs to one target and family.
  const choiceKey = JSON.stringify([connectionId, schema, scriptName]);
  const readsWanted = familyKey !== "" && !githubUnconfigured;

  // (a) The versions already in GitHub. Debounced so typing a family name
  // makes one request, not one per key. Re-run by bumping familyRefresh.
  useEffect(() => {
    if (!readsWanted) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const read = await readFamilyVersions(databaseName, schema, scriptName);
      if (!cancelled) setFamily({ ...read, key: familyKey, refresh: familyRefresh });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [readsWanted, familyKey, familyRefresh, databaseName, schema, scriptName]);

  // (b) The version applied to the target (its script_patch, via preflight).
  useEffect(() => {
    if (!readsWanted || !appliedKey) return;
    const id = Number(connectionId);
    let cancelled = false;
    const timer = setTimeout(async () => {
      const read = await readAppliedVersion(id, schema, scriptName);
      if (!cancelled) setApplied({ ...read, key: appliedKey });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [readsWanted, appliedKey, connectionId, schema, scriptName]);

  // A read counts only when it answers the CURRENT question: a result for
  // another family (or from before a refresh) is the same as no result yet.
  const familyCurrent =
    family !== null && family.key === familyKey && family.refresh === familyRefresh ? family : null;
  const familyLoading = readsWanted && familyCurrent === null;
  const familyError = readsWanted && familyCurrent !== null && !familyCurrent.ok ? familyCurrent.error : null;
  const appliedCurrent = appliedKey !== "" && applied !== null && applied.key === appliedKey ? applied : null;
  const appliedLoading = readsWanted && appliedKey !== "" && appliedCurrent === null;
  const appliedUnreadable = appliedCurrent !== null && !appliedCurrent.ok;
  const appliedVersion = appliedCurrent !== null && appliedCurrent.ok ? appliedCurrent.version : null;
  // The number is shown (and can be saved) only once both reads are back and
  // GitHub answered: before that it would be a guess. An unreadable applied
  // version does not hold it up; the pill says only GitHub was checked.
  const versionsReady = readsWanted && familyCurrent !== null && familyCurrent.ok && !appliedLoading;

  // This family's saved versions, as the registry lists them.
  const familyRows = useMemo(
    () =>
      familyKey === ""
        ? []
        : rows.filter(
            (r) => r.database_name === databaseName && r.schema_name === schema && r.script_name === scriptName,
          ),
    [rows, familyKey, databaseName, schema, scriptName],
  );

  // The floor: nothing may be created at or below it.
  //   floor = highest of (applied to the target, every version in GitHub)
  // The pulled rows and the learned versions only ever add what is known to
  // exist, so they can raise the floor but never lower it.
  const githubVersions = familyCurrent !== null && familyCurrent.ok ? familyCurrent.versions : [];
  const learnedVersions = learned.key === familyKey ? learned.versions : [];
  const githubTop = highestVersion([...familyRows.map((r) => r.version), ...githubVersions, ...learnedVersions]);
  const githubHighest = githubTop === null ? null : bare(githubTop);
  const floorTop = highestVersion([appliedVersion, githubHighest]);
  const floor = floorTop === null ? null : bare(floorTop);

  // ── Version computation ─────────────────────────────────────────────────--
  // The same reader Deploy grades scripts with, so the suggestion here is the
  // level the script will be shown as there.
  const sqlGrade = useMemo(() => gradeSql(sql), [sql]);
  const suggestedLevel = levelToBump(sqlGrade.level);
  const choiceHere = choice !== null && choice.key === choiceKey ? choice : null;
  // Follow the SQL-based suggestion until a level is picked for this family.
  const effectiveChoice: BumpLevel | "custom" = choiceHere ? choiceHere.pick : suggestedLevel;
  const customText = choiceHere ? choiceHere.custom : "";

  // The version this Save would use, or null while it can't be worked out.
  // A custom number is normalised the way the push route stores it ("v1.2"
  // becomes "1.2.0"), so the preview names the file that will really exist.
  let versionError: string | null = null;
  let version: string | null = null;
  if (effectiveChoice === "custom") {
    const typed = normalizePushVersion(customText);
    if (customText.trim() === "") versionError = "Enter a version.";
    else if ("error" in typed) versionError = typed.error;
    else if (versionsReady) {
      if (floor !== null && compareVersions(typed.version, floor) <= 0) {
        versionError = `Must be higher than v${floor}.`;
      } else {
        version = typed.version;
      }
    }
  } else if (versionsReady) {
    version = bumpVersion(floor, effectiveChoice);
  }

  // The level recorded with the file. A picked bump maps straight to its
  // level. A custom number takes the level its step above the floor implies,
  // so the number and the recorded level agree; a first version has no step,
  // so there the SQL reading decides.
  const changeLevel: ScriptChangeType =
    effectiveChoice === "custom"
      ? (version !== null ? levelOfStep(floor, version) : null) ?? sqlGrade.level
      : bumpToLevel(effectiveChoice);

  // A quieter level than the SQL reads as is allowed, but only with a tick
  // that names what it understates. A first version is 1.0.0 at every level,
  // so there only the recorded level can understate it.
  const quieterText =
    versionsReady && hasExecutableSql(sql)
      ? quieterLevelWarning(sqlGrade.level, changeLevel, sqlGrade.because, floor === null)
      : null;
  const ackKey = JSON.stringify([choiceKey, quieterText, sql]);
  const quieterAcked = quieterText !== null && quieterAck === ackKey;

  // The apply and revert routes both reject a script that opens or closes its
  // own transaction — they run one themselves. Catch it here so the user finds
  // out while they can still edit, not at deploy time.
  const txnInUp = containsTransactionControl(sql);
  const txnInDown = containsTransactionControl(rollbackSql);
  const txnError = txnInUp ? TXN_IN_MIGRATION : txnInDown ? TXN_IN_ROLLBACK : "";

  // ── The rollback choice (the same rules as the Migration Workbench) ──────
  // What goes out as down_sql: the rollback when it has statements and the
  // no-rollback box is not ticked, otherwise nothing.
  const rollbackRuns = hasExecutableSql(rollbackSql);
  const rollbackProblem = rollbackChoiceProblem(rollbackSql, saveWithoutRollback);
  const downSql = rollbackToSend(rollbackSql, saveWithoutRollback);

  // The push preview: the files the Save creates and the step it takes.
  const folder = `${databaseName}/${schema}/${scriptName}/`;
  const preview = version !== null ? describePush({ floor, version, withRollback: downSql !== undefined }) : null;

  // ── The same migration again ─────────────────────────────────────────────
  // Saving the SQL just saved would publish a copy of it as the next version,
  // and nothing downstream would notice. What the person usually means is to
  // add the rollback they have now written, so that is offered instead.
  const savedHere = lastSaved !== null && lastSaved.key === familyKey ? lastSaved : null;
  const sameMigration = savedHere !== null && sql === savedHere.sql;
  const savedRow =
    savedHere !== null
      ? familyRows.find((r) => compareVersions(r.version, savedHere.version) === 0) ?? null
      : null;
  const savedHasRollback = savedRow !== null ? !needsRollback(savedRow.rollback_state) : savedHere?.withRollback === true;
  const attachOffer =
    sameMigration &&
    savedRow !== null &&
    needsRollback(savedRow.rollback_state) &&
    rollbackRuns &&
    !txnInDown &&
    !saveWithoutRollback;
  const offerHere = offerStatus !== null && offerStatus.key === familyKey ? offerStatus : null;
  const offerSaving = offerHere?.kind === "saving";

  /**
   * Why Save can't be pressed right now, or null when it can. The first
   * reason wins; it is shown beside the button and as the button's title, so
   * a disabled button always says what to do about it.
   */
  function whySaveIsBlocked(): string | null {
    if (githubUnconfigured) return "The GitHub registry is not configured, so nothing can be saved.";
    if (!databaseName || !schema) return "Pick a connection and a schema above.";
    if (!scriptName) return "Pick a script family above.";
    if (nameProblem) return nameProblem;
    if (!hasExecutableSql(sql)) {
      return sql.trim() === "" ? "Write the SQL for this version above." : MIGRATION_NO_STATEMENTS;
    }
    if (txnInUp) return "Remove COMMIT, ROLLBACK or other transaction statements from the SQL (see the note above).";
    if (txnInDown) {
      return "Remove COMMIT, ROLLBACK or other transaction statements from the rollback (see the note above).";
    }
    if (familyLoading) return `Checking GitHub for the versions of ${scriptName}…`;
    if (appliedLoading) return `Checking which version of ${scriptName} is applied to ${targetLabel}…`;
    if (familyError) return familyError;
    if (versionError) return versionError;
    if (version === null) return "The next version is not worked out yet.";
    if (sameMigration && savedHere !== null) {
      const saved = savedHere.version;
      if (attachOffer) {
        return `Add the rollback to v${saved} with the button below, rather than saving the same migration again.`;
      }
      if (savedHasRollback) {
        return `v${saved} was saved with this same migration and already has a rollback, which can't be changed. Edit the SQL to save a new version.`;
      }
      if (rollbackRuns && saveWithoutRollback) {
        return `v${saved} was saved with this same migration. Edit the SQL to save a new version, or untick Save without a rollback to add the rollback above to v${saved}.`;
      }
      return `v${saved} was saved with this same migration. Edit the SQL to save a new version, or write a rollback to add to v${saved}.`;
    }
    if (rollbackProblem) return rollbackProblem;
    if (quieterText && !quieterAcked) {
      return `Tick "Publish it as ${changeLevel} anyway" above, or pick ${suggestedLevel}.`;
    }
    return null;
  }
  const blocker = whySaveIsBlocked();

  // ── Add a missing rollback ───────────────────────────────────────────────
  // Saved versions of this family that Deploy can't undo, newest first.
  const fixRows = useMemo(
    () =>
      familyRows
        .filter((r) => needsRollback(r.rollback_state))
        .sort((a, b) => compareVersions(b.version, a.version)),
    [familyRows],
  );
  const fixRow = fix.key === familyKey ? fixRows.find((r) => r.version === fix.version) ?? null : null;
  const fixVersion = fixRow !== null ? bare(fixRow.version) : "";
  const fixText = fix.key === familyKey ? fix.text : "";
  const fixRuns = hasExecutableSql(fixText);
  const fixTxn = containsTransactionControl(fixText);
  const fixHere = fixStatus !== null && fixStatus.key === familyKey ? fixStatus : null;
  const fixSaving = fixHere?.kind === "saving";

  function whyFixIsBlocked(): string | null {
    if (githubUnconfigured) return "The GitHub registry is not configured, so nothing can be saved.";
    if (fixRow === null) return "Pick the version to add a rollback to.";
    if (!fixRuns) return `Write the statements that undo v${fixVersion}'s migration.`;
    if (fixTxn) {
      return "Remove COMMIT, ROLLBACK or other transaction statements from the rollback (see the note above).";
    }
    return null;
  }
  const fixBlocker = whyFixIsBlocked();

  // An error describes the save as it was. Once anything it depends on is
  // edited it no longer does, so it is cleared rather than left to disagree
  // with the screen. A success stays: it is still true.
  function clearStaleError() {
    setSaveResult((current) => (current?.kind === "err" ? null : current));
  }

  function pickLevel(pick: BumpLevel | "custom") {
    setChoice((current) => ({
      key: choiceKey,
      pick,
      custom: current !== null && current.key === choiceKey ? current.custom : "",
    }));
    clearStaleError();
  }

  // Remember a version the server said exists, for this family only.
  function learn(key: string, known: string) {
    setLearned((current) => ({
      key,
      versions: current.key === key ? [...current.versions, known] : [known],
    }));
  }

  // Pull the registry again after a save whose outcome is unclear. A failed
  // reload keeps the list already on screen: an old list beats an empty one.
  async function reloadRegistry() {
    const read = await readRegistry();
    if (!read.ok) return;
    setRegistryRows(read.scripts);
    setPullWarnings(read.warnings);
    setGithubError("");
    setPullCode(null);
  }

  // Record that a saved version now has a rollback with statements, so the
  // offer and the "Add a missing rollback" card stop offering to add one.
  // After a rollback_exists answer the rollback found may not be one Deploy
  // can run; here "usable" only stands for "none can be added any more".
  function markRollbackSaved(row: GitHubScript, down: string | undefined) {
    const updated: GitHubScript = {
      ...row,
      rollback_state: "usable",
      ...(down !== undefined ? { down_sql: down } : {}),
    };
    setOwnRows((current) => [...current.filter((r) => !sameVersion(r, row)), updated]);
  }

  /**
   * Attach mode of the push route: add a rollback to a version that is
   * already saved. It never creates a version, and the route refuses when
   * the version already has a rollback with statements.
   */
  async function attachRollback(
    row: GitHubScript,
    down: string,
  ): Promise<{ ok: true } | { ok: false; message: string; hasRollback: boolean }> {
    const shown = bare(row.version);
    // Set before the first await, so a second press already sees it.
    attachInFlight.current = true;
    try {
      const res = await fetch("/api/github/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          attach_rollback: true,
          database_name: row.database_name,
          schema_name: row.schema_name,
          script_name: row.script_name,
          version: row.version,
          down_sql: down,
        }),
      });
      const data = (await res.json().catch(() => null)) as PushAnswer | null;
      if (res.ok && data?.ok === true) {
        markRollbackSaved(row, down);
        return { ok: true };
      }
      if (data?.code === "rollback_exists") {
        // After a dropped connection it may be OUR rollback that is there, so
        // don't claim it is someone else's. Either way none can be added now.
        markRollbackSaved(row, undefined);
        return {
          ok: false,
          message: `v${shown} already has a rollback with statements, so nothing more was saved. A saved rollback never changes.`,
          hasRollback: true,
        };
      }
      return {
        ok: false,
        message:
          typeof data?.error === "string" && data.error.trim() !== ""
            ? data.error
            : `Saving the rollback failed (status ${res.status}) without an explanation from the server.`,
        hasRollback: false,
      };
    } catch {
      return {
        ok: false,
        message: `The connection to the server dropped while saving the rollback for v${shown}, so it is not known whether it was saved. Trying again is safe: if it was saved, the retry changes nothing and says so.`,
        hasRollback: false,
      };
    } finally {
      attachInFlight.current = false;
    }
  }

  async function handleSave() {
    if (blocker !== null || saving || version === null) return;
    // Everything is taken from this render, so the answer is reported against
    // exactly what was sent even if the page changes while it runs.
    const sent = {
      key: familyKey,
      database: databaseName,
      schema,
      script: scriptName,
      version,
      level: changeLevel,
      sql,
      rollbackSql,
      downSql,
      custom: effectiveChoice === "custom",
      wasNewFamily: familyMode === "new",
    };
    const where = `${sent.database}/${sent.schema}/${sent.script}`;
    setSaving(true);
    setSaveResult(null);
    setOfferStatus(null);
    try {
      let res: Response;
      let data: PushAnswer | null;
      try {
        res = await fetch("/api/github/push", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            database_name: sent.database,
            schema_name: sent.schema,
            script_name: sent.script,
            version: sent.version,
            // Written into the file's "-- Change-type:" line by the route, so
            // Deploy shows the level this version was saved as.
            change_level: sent.level,
            sql_content: sent.sql,
            // Saved beside the script as v<ver>.down.sql so Deploy can undo the
            // version. Left out when nothing in it runs, or the box is ticked.
            down_sql: sent.downSql,
            description: description.trim() || undefined,
          }),
        });
        data = (await res.json().catch(() => null)) as PushAnswer | null;
      } catch {
        // The request may or may not have reached GitHub. Read GitHub again, so
        // the number offered next is right either way.
        setFamilyRefresh((n) => n + 1);
        void reloadRegistry();
        setSaveResult({
          kind: "err",
          message: `The connection to the server dropped while saving v${sent.version}, so it is not known whether it was saved. GitHub is being read again: if "In GitHub" above now shows v${sent.version}, the save went through.`,
        });
        return;
      }

      if (!res.ok || !data || data.ok !== true) {
        // version_exists / version_not_newer carry the highest version GitHub
        // has. Learn it at once, and re-read the family so the next free
        // number comes from GitHub itself, not from a guess.
        const highest = typeof data?.highest_version === "string" ? data.highest_version : null;
        if (highest !== null) learn(sent.key, highest);
        const message = typeof data?.error === "string" && data.error.trim() !== "" ? data.error : null;
        const unclear = message === null || data?.code === "outcome_unknown";
        // A 409 means GitHub holds something this page did not know about.
        if (highest !== null || unclear || res.status === 409) setFamilyRefresh((n) => n + 1);
        if (unclear || (res.status === 409 && highest === null)) void reloadRegistry();
        // The route words a taken version for the Push button and names the
        // number IT would pick. Here the button says Save, and the number
        // offered is worked out again above, so say it in this page's words.
        const taken =
          highest !== null && (data?.code === "version_exists" || data?.code === "version_not_newer")
            ? bare(highest)
            : null;
        const takenMessage =
          taken === null
            ? null
            : sent.custom
              ? `Nothing was saved: GitHub already has v${taken} of ${sent.script}, so v${sent.version} is not a new version. Enter a version higher than v${taken} above, then save again.`
              : `Nothing was saved: GitHub already has v${taken} of ${sent.script}, which this page did not know about when it offered v${sent.version}. The next version above is worked out again from GitHub, so it now comes after v${taken}. Check it, then save again.`;
        setSaveResult({
          kind: "err",
          message:
            takenMessage ??
            message ??
            `The server answered with an error (status ${res.status}) and no explanation. GitHub is being read again to see whether v${sent.version} was saved.`,
        });
        return;
      }

      const saved = typeof data.version === "string" && data.version.trim() !== "" ? data.version : sent.version;
      const rollbackSaved = data.rollback_saved === true;
      const url = typeof data.url === "string" ? data.url : null;
      // Reflect the new version locally, so the floor moves at once and the
      // same migration is not offered as the next version.
      const row: GitHubScript = {
        database_name: sent.database,
        schema_name: sent.schema,
        script_name: sent.script,
        version: saved,
        path: typeof data.paths?.migration === "string" ? data.paths.migration : `${where}/v${saved}.sql`,
        sql_content: sent.sql,
        rollback_state: rollbackSaved ? "usable" : "none",
        ...(rollbackSaved && sent.downSql !== undefined ? { down_sql: sent.downSql } : {}),
      };
      setOwnRows((current) => [...current.filter((r) => !sameVersion(r, row)), row]);
      setLastSaved({
        key: sent.key,
        sql: sent.sql,
        rollbackSql: sent.rollbackSql,
        version: saved,
        withRollback: sent.downSql !== undefined,
      });
      // The tick agreed to THIS version going out without a rollback.
      setSaveWithoutRollback(false);
      // If it was a new family, switch to "existing" so it shows in the list.
      if (sent.wasNewFamily) {
        setExistingFamily(sent.script);
        setFamilyMode("existing");
        setNewFamily("");
      }
      if (sent.downSql === undefined) {
        setSaveResult({
          kind: "ok",
          key: sent.key,
          version: saved,
          message: `v${saved} saved to ${where} on GitHub.`,
          note: "No rollback was saved, so Deploy cannot undo this version.",
          url,
        });
      } else if (rollbackSaved) {
        setSaveResult({
          kind: "ok",
          key: sent.key,
          version: saved,
          message: `v${saved} saved to ${where} on GitHub, with its rollback.`,
          note: null,
          url,
        });
      } else {
        // The version is saved; only its rollback is not. The offer below
        // Save adds the same rollback to the same version (no new version),
        // unless someone else's rollback is already there.
        if (data.rollback_error_code === "rollback_exists") markRollbackSaved(row, undefined);
        setSaveResult({
          kind: "partial",
          key: sent.key,
          version: saved,
          message: `v${saved} saved to ${where} on GitHub.`,
          url,
          rollbackError:
            typeof data.rollback_error === "string" && data.rollback_error.trim() !== ""
              ? data.rollback_error
              : `Its rollback was not saved, so Deploy cannot undo v${saved} yet.`,
        });
      }
    } finally {
      setSaving(false);
    }
  }

  // The offer below Save: add the rollback in the box to the version just
  // saved with this same migration.
  async function addRollbackToSaved() {
    if (!attachOffer || savedHere === null || savedRow === null || offerSaving) return;
    if (attachInFlight.current) return;
    const key = familyKey;
    const savedVersion = savedHere.version;
    const shown = bare(savedVersion);
    const text = rollbackSql;
    setOfferStatus({ key, version: shown, kind: "saving", message: "" });
    const result = await attachRollback(savedRow, text);
    if (result.ok) {
      // The rollback saved with this version is now the one in the box.
      setLastSaved((current) =>
        current !== null && current.key === key && compareVersions(current.version, savedVersion) === 0
          ? { ...current, rollbackSql: text, withRollback: true }
          : current,
      );
      setOfferStatus({ key, version: shown, kind: "ok", message: `Rollback saved. Deploy can now undo v${shown}.` });
    } else {
      setOfferStatus({ key, version: shown, kind: "err", message: result.message });
    }
    if (result.ok || result.hasRollback) {
      // The version holds a rollback now, so the save box's line about the
      // missing one is out of date: keep only the line about the version.
      setSaveResult((current) =>
        current !== null &&
        current.kind !== "err" &&
        current.key === key &&
        compareVersions(current.version, savedVersion) === 0
          ? { kind: "ok", key, version: current.version, message: current.message, note: null, url: current.url }
          : current,
      );
    }
  }

  // The "Add a missing rollback" card's button.
  async function saveFixRollback() {
    if (fixRow === null || fixBlocker !== null || fixSaving) return;
    if (attachInFlight.current) return;
    const key = familyKey;
    const row = fixRow;
    const shown = bare(row.version);
    const text = fixText;
    setFixStatus({ key, version: shown, kind: "saving", message: "" });
    const result = await attachRollback(row, text);
    if (result.ok) {
      setFix((current) =>
        current.key === key && current.version === row.version ? { key, version: "", text: "" } : current,
      );
      setFixStatus({ key, version: shown, kind: "ok", message: `Rollback saved. Deploy can now undo v${shown}.` });
    } else {
      setFixStatus({ key, version: shown, kind: "err", message: result.message });
    }
  }

  const retryLabel =
    savedHere !== null && savedHere.withRollback && rollbackSql === savedHere.rollbackSql
      ? "Retry saving the rollback"
      : `Add this rollback to v${savedHere !== null ? bare(savedHere.version) : ""}`;

  const fixCount = fixRows.length;
  const fixIntro = `${countOf(fixCount, "saved version")} of ${scriptName} ${
    fixCount === 1 ? "has" : "have"
  } no rollback that runs, so Deploy can't undo ${fixCount === 1 ? "it" : "them"}. ${
    fixCount === 1 ? "Pick it" : "Pick one"
  } and write its rollback: it is saved beside that version as a .down.sql file, and the migration itself is not changed.`;

  // ── Render ──────────────────────────────────────────────────────────────--
  return (
    <div className="p-4 sm:p-6 max-w-[1080px]">
      <div className="mb-4">
        <div className="section-title mb-2">Script Editor</div>
        <h1 className="text-[28px] font-semibold tracking-[-0.018em]">Write a migration script.</h1>
        <p className="text-[13.5px] mt-1.5 max-w-[64ch]" style={{ color: "var(--text-2)" }}>
          Hand-author SQL, give it a schema and a script family, and save it to the GitHub registry.
          The version is suggested from your SQL and is always kept above what is already applied or
          saved, in semver order.
        </p>
      </div>

      {connectionsLoaded && connections.length === 0 ? (
        <div style={{ minHeight: 360 }}>
          {connectionsFailed ? (
            <EmptyState
              icon={<EditIcon size={22} />}
              title="Could not load your connections"
              description="The saved connections could not be read just now. Reload the page to try again."
            />
          ) : (
            <EmptyState
              icon={<EditIcon size={22} />}
              title="Add a connection first"
              description="The editor needs a saved PostgreSQL connection to know the target database and read its applied versions."
              actions={
                <Link href="/connections" className="btn btn-primary btn-sm">
                  <ConnectionsIcon size={14} />
                  Go to Connections
                </Link>
              }
            />
          )}
        </div>
      ) : (
        <div className="grid gap-4">
          {/* ── Target ─────────────────────────────────────────────────────── */}
          <div className="card p-5">
            <div className="section-title mb-3">Where this script belongs</div>
            <p className="help mb-3">
              Nothing runs against this database. The connection only names the registry
              folder and lets us read which versions it has already applied, so the new
              version lands above them. Running the script is done on Deploy.
            </p>
            <div className="grid gap-4 grid-cols-1 md:grid-cols-3">
              <div>
                <label className="label" htmlFor="se-conn">Connection</label>
                <Select
                  variant="input"
                  id="se-conn"
                  className="mt-1"
                  ariaLabel="Connection"
                  value={connectionId}
                  placeholder="Select a connection…"
                  options={connections.map((c) => ({
                    value: String(c.id),
                    label: `${c.name} — ${c.host}/${c.database_name}`,
                  }))}
                  onChange={(value) => {
                    setConnectionId(value);
                    setSchema("");
                    setExistingFamily("");
                    setNewFamily("");
                    setSaveResult(null);
                  }}
                />
              </div>

              <div>
                <label className="label" htmlFor="se-schema">Schema</label>
                <Select
                  variant="input"
                  id="se-schema"
                  className="mt-1"
                  ariaLabel="Schema"
                  value={schema}
                  disabled={schemasLoading || !connectionId}
                  placeholder={
                    !connectionId
                      ? "Select a connection first"
                      : schemasLoading
                        ? "Loading schemas…"
                        : "Select a schema…"
                  }
                  options={schemas.map((s) => ({ value: s, label: s }))}
                  onChange={(value) => {
                    setSchema(value);
                    setExistingFamily("");
                    setNewFamily("");
                    setSaveResult(null);
                  }}
                />
                {schemasError && (
                  <p className="help mt-1" style={{ color: "var(--break)" }}>{schemasError}</p>
                )}
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <label className="label" htmlFor="se-family">Script family</label>
                  <button
                    type="button"
                    className="family-toggle text-[11px]"
                    style={{ color: "var(--brand)" }}
                    onClick={() => {
                      setFamilyMode((m) => (m === "existing" ? "new" : "existing"));
                      setSaveResult(null);
                    }}
                  >
                    {familyMode === "existing" ? "+ New family" : "Pick existing"}
                  </button>
                </div>
                {familyMode === "existing" ? (
                  <Select
                    variant="input"
                    id="se-family"
                    className="mt-1"
                    mono
                    ariaLabel="Script family"
                    value={existingFamily}
                    disabled={!schema}
                    placeholder={
                      !schema
                        ? "Select a schema first"
                        : githubLoading
                          ? "Loading families…"
                          : existingFamilies.length === 0
                            ? "No families yet — use + New family"
                            : "Select a family…"
                    }
                    options={existingFamilies.map((name) => ({ value: name, label: name }))}
                    onChange={(value) => {
                      setExistingFamily(value);
                      setSaveResult(null);
                    }}
                  />
                ) : (
                  <>
                    <input
                      id="se-family"
                      className="input mono mt-1"
                      placeholder="e.g. add_invoices"
                      value={newFamily}
                      disabled={!schema}
                      onChange={(e) => {
                        setNewFamily(e.target.value.replace(/[^a-zA-Z0-9_-]/g, "_"));
                        setSaveResult(null);
                      }}
                      aria-label="New script family name"
                    />
                    {newFamily.trim() && nameProblem && (
                      <p className="help mt-1" style={{ color: "var(--break)" }}>
                        {nameProblem}
                      </p>
                    )}
                    {caseClash && (
                      <p className="help mt-1" style={{ color: "var(--drift)" }}>
                        {`A family "${caseClash}" already exists — use that exact name to add to it.`}
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>
            {githubError && (
              <p
                className="help mt-3"
                style={{ color: githubUnconfigured ? "var(--break)" : "var(--drift)" }}
              >
                {githubUnconfigured ? (
                  <>
                    The GitHub registry is not configured, so nothing can be listed and
                    nothing can be saved. Set GITHUB_REPO_OWNER, GITHUB_REPO_NAME and
                    GITHUB_PAT, then reload.
                  </>
                ) : (
                  <>
                    {githubError}{" "}
                    Existing families can&apos;t be listed, but you can still add a new
                    one.
                  </>
                )}
              </p>
            )}
            {/* The pull lists what it could and names what it could not, so a
                family missing from the list is never a silent gap. */}
            {pullWarnings.length > 0 && (
              <div className="help mt-3" style={{ color: "var(--drift)" }}>
                <p>Some of the registry could not be read:</p>
                <ul className="list-disc pl-5 mt-1 space-y-0.5">
                  {pullWarnings.slice(0, 5).map((warning, index) => (
                    <li key={index} className="break-words">
                      {warning}
                    </li>
                  ))}
                </ul>
                {pullWarnings.length > 5 && <p className="mt-1">{`…and ${pullWarnings.length - 5} more.`}</p>}
                <p className="mt-1">
                  Scripts in those places are missing from the lists on this page. The version
                  below is still checked against GitHub directly.
                </p>
              </div>
            )}
          </div>

          {/* ── Script ─────────────────────────────────────────────────────── */}
          <div className="card p-5">
            <div className="section-title mb-3">Script</div>
            <label className="label" htmlFor="se-sql">SQL</label>
            <textarea
              id="se-sql"
              className="input mono mt-1 se-textarea"
              style={{ minHeight: 300, lineHeight: 1.6, resize: "vertical" }}
              spellCheck={false}
              placeholder={"ALTER TABLE invoices\n  ADD COLUMN due_date date;"}
              value={sql}
              onChange={(e) => {
                setSql(e.target.value);
                setSaveResult(null);
                setOfferStatus(null);
              }}
            />
            <label className="label mt-3 block" htmlFor="se-down">
              Rollback SQL{" "}
              <span style={{ color: "var(--text-3)" }}>(needed to undo this version from Deploy)</span>
            </label>
            <textarea
              id="se-down"
              className="input mono mt-1 se-textarea"
              style={{ minHeight: 160, lineHeight: 1.6, resize: "vertical" }}
              spellCheck={false}
              placeholder={"ALTER TABLE invoices\n  DROP COLUMN due_date;"}
              value={rollbackSql}
              onChange={(e) => {
                setRollbackSql(e.target.value);
                setSaveResult(null);
                setOfferStatus(null);
              }}
            />
            <p className="help mt-1">
              {rollbackRuns && !saveWithoutRollback
                ? "Saved beside the script as the .down.sql file Deploy runs when you revert this version. It restores structure, not rows — a rollback that drops a column deletes everything written into it since this version landed, and only a point-in-time restore brings that back. Where you can, undo by renaming or leaving the column in place instead of dropping it."
                : (rollbackProblem ??
                  "This version will be saved without a rollback, so Deploy will not be able to undo it.")}
            </p>
            {txnError && (
              <p className="help mt-1" style={{ color: "var(--break)" }}>{txnError}</p>
            )}
            {/* Saving without a rollback is a choice, not a default. The box
                appears when there is no rollback that runs (or when it is
                ticked, so it can be unticked). */}
            {(!rollbackRuns || saveWithoutRollback) && (
              <label
                className="flex items-start gap-2 text-[12px] mt-2"
                style={{ color: "var(--text-2)", cursor: "pointer" }}
              >
                <input
                  type="checkbox"
                  checked={saveWithoutRollback}
                  onChange={(e) => {
                    setSaveWithoutRollback(e.target.checked);
                    clearStaleError();
                  }}
                  style={{ marginTop: 2 }}
                />
                <span>Save without a rollback — Deploy will not be able to undo this version</span>
              </label>
            )}
            <label className="label mt-3 block" htmlFor="se-desc">
              Description <span style={{ color: "var(--text-3)" }}>(optional, used as the commit message)</span>
            </label>
            <input
              id="se-desc"
              className="input mt-1"
              placeholder="What this script does"
              // The push route refuses a longer description.
              maxLength={1000}
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
                clearStaleError();
              }}
            />
          </div>

          {/* ── Version ────────────────────────────────────────────────────── */}
          <div className="card p-5">
            <div className="section-title mb-3">Version</div>

            {scriptName ? (
              <>
                {nameProblem ? (
                  <p className="help">The version is worked out once the family name can be used.</p>
                ) : githubUnconfigured ? (
                  <p className="help">
                    {"The next version can't be worked out until the GitHub registry is configured (see above)."}
                  </p>
                ) : (
                  <>
                    <div className="flex items-center gap-2 mb-3 flex-wrap">
                      {!familyError && (familyLoading || appliedLoading || versionsReady) && (
                        <span
                          className="pill pill-neutral"
                          title={
                            versionsReady && floor !== null
                              ? "Every new version must be higher than both: the version applied to this database and the highest version in the GitHub registry."
                              : undefined
                          }
                        >
                          {familyLoading || appliedLoading
                            ? "Checking versions…"
                            : floor === null
                              ? "First version of this family"
                              : `Applied to ${targetLabel}: ${
                                  appliedUnreadable ? "unknown" : appliedVersion ? `v${appliedVersion}` : "none"
                                } · In GitHub: ${githubHighest ? `v${githubHighest}` : "none"}`}
                        </span>
                      )}
                      {sql.trim() && (
                        <span
                          className={`pill ${suggestedLevel === "major" ? "pill-break" : suggestedLevel === "minor" ? "pill-sync" : "pill-pending"}`}
                          title="Read from the statements that will run; comments and quoted text are ignored. Deploy grades scripts with this same rule."
                        >
                          {gradeSentence(sqlGrade)}
                        </span>
                      )}
                      {appliedUnreadable && (
                        <span className="pill pill-drift">
                          {"couldn't read the applied version — only GitHub is checked"}
                        </span>
                      )}
                    </div>

                    {familyError && (
                      <div className="mb-3">
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
                    )}

                    <div className="ver-seg" role="group" aria-label="Version bump">
                      {BUMP_LEVELS.map((level) => (
                        <button
                          key={level}
                          type="button"
                          aria-pressed={effectiveChoice === level}
                          className={`ver-seg-btn${effectiveChoice === level ? " is-active" : ""}`}
                          // Capped so the sentence below wraps inside the button
                          // instead of stretching the row wider than the card.
                          style={{ maxWidth: 200 }}
                          onClick={() => pickLevel(level)}
                        >
                          <span className="ver-seg-label">
                            {level}
                            {suggestedLevel === level && sql.trim() ? (
                              <span className="ver-seg-suggest">suggested</span>
                            ) : null}
                          </span>
                          {/* Inline styling, not a new class — app/globals.css is
                              owned elsewhere, and this is the only place the line
                              appears. */}
                          <span
                            style={{
                              fontSize: "10.5px",
                              color: "var(--text-3)",
                              lineHeight: 1.3,
                              textAlign: "left",
                              whiteSpace: "normal",
                            }}
                          >
                            {BUMP_DESC[level]}
                          </span>
                          {/* No number until both reads are back: before that it would be a guess. */}
                          <span className="ver-seg-ver mono">
                            {versionsReady ? `v${bumpVersion(floor, level)}` : "…"}
                          </span>
                        </button>
                      ))}
                      <button
                        type="button"
                        aria-pressed={effectiveChoice === "custom"}
                        className={`ver-seg-btn${effectiveChoice === "custom" ? " is-active" : ""}`}
                        onClick={() => pickLevel("custom")}
                      >
                        <span className="ver-seg-label">custom</span>
                        <span className="ver-seg-ver mono">x.y.z</span>
                      </button>
                    </div>

                    {effectiveChoice === "custom" && (
                      <div className="mt-3" style={{ maxWidth: 220 }}>
                        <input
                          className="input mono"
                          placeholder={versionsReady ? (floor !== null ? `above v${floor}` : "1.0.0") : ""}
                          value={customText}
                          onChange={(e) => {
                            setChoice({ key: choiceKey, pick: "custom", custom: e.target.value });
                            clearStaleError();
                          }}
                          aria-label="Custom version"
                        />
                        {versionError && (
                          <p className="help mt-1" style={{ color: "var(--break)" }}>{versionError}</p>
                        )}
                      </div>
                    )}

                    {/* The level written into the file, and why it is that level. */}
                    {version !== null && (
                      <p className="help mt-3">
                        {effectiveChoice !== "custom"
                          ? `Recorded as ${levelWithArticle(changeLevel)} change — the level Deploy shows for this version.`
                          : floor !== null
                            ? `Recorded as ${levelWithArticle(changeLevel)} change: the step from v${floor} to v${version} is a ${levelToBump(changeLevel)} bump.`
                            : `Recorded as ${levelWithArticle(changeLevel)} change, read from the SQL — a first version has no step to take a level from.`}
                      </p>
                    )}

                    {/* A quieter level than the SQL reads as needs a tick naming why. */}
                    {quieterText && (
                      <div className="prod-gate prod-gate--drift mt-3">
                        <label className="prod-gate__ack" style={{ marginTop: 0 }}>
                          <input
                            type="checkbox"
                            checked={quieterAcked}
                            onChange={(e) => {
                              setQuieterAck(e.target.checked ? ackKey : "");
                              clearStaleError();
                            }}
                          />
                          <span>{quieterText}</span>
                        </label>
                      </div>
                    )}
                  </>
                )}

                <div className="mt-4 pt-3 space-y-3" style={{ borderTop: "1px solid var(--border)" }}>
                  {/* The push preview: the step, and the exact files. Hidden for
                      the same migration again, which Save will not publish. */}
                  {preview !== null && !sameMigration && (
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
                    {blocker && !saving && <p className="help min-w-0 flex-1">{blocker}</p>}
                    <button
                      type="button"
                      className="btn btn-primary ml-auto"
                      disabled={saving || blocker !== null}
                      title={blocker ?? undefined}
                      onClick={handleSave}
                    >
                      {saving ? <RefreshIcon size={14} className="spin-icon" /> : <CheckIcon size={14} />}
                      {saving ? "Saving…" : version !== null ? `Save v${version} to GitHub` : "Save to GitHub"}
                    </button>
                  </div>
                </div>
              </>
            ) : (
              // The Save button lives inside this card, so until a family is
              // picked the page has no visible way to finish — say where it
              // will appear rather than leaving the reader hunting for it.
              <p className="help">
                Pick a schema and a script family above. The version and the Save button
                appear here once they are set.
              </p>
            )}

            {saveResult && (
              <div
                className="mt-3 banner"
                style={
                  saveResult.kind === "ok"
                    ? { background: "var(--sync-soft)", borderColor: "color-mix(in oklab, var(--sync) 30%, transparent)" }
                    : saveResult.kind === "partial"
                      ? { background: "var(--drift-soft)", borderColor: "color-mix(in oklab, var(--drift) 30%, transparent)" }
                      : undefined
                }
              >
                {saveResult.kind === "ok" ? (
                  <CheckIcon size={16} className="ico" />
                ) : (
                  <AlertTriangleIcon size={16} className="ico" />
                )}
                <div className="body">
                  <div
                    className="title"
                    style={
                      saveResult.kind === "ok"
                        ? { color: "var(--sync)" }
                        : saveResult.kind === "partial"
                          ? { color: "var(--text)" }
                          : undefined
                    }
                  >
                    {saveResult.message}
                  </div>
                  {saveResult.kind === "ok" && saveResult.note && (
                    <div style={{ color: "var(--text-2)" }}>{saveResult.note}</div>
                  )}
                  {saveResult.kind === "partial" && (
                    <div style={{ color: "var(--text-2)" }}>{saveResult.rollbackError}</div>
                  )}
                  {saveResult.kind !== "err" && saveResult.url && (
                    <a href={saveResult.url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--text-2)" }}>
                      View the file on GitHub →
                    </a>
                  )}
                </div>
              </div>
            )}

            {/* Add the rollback in the box to the version just saved with this
                same migration. Its outcome stays after the offer goes away. */}
            {(attachOffer || (offerHere !== null && offerHere.kind !== "saving")) && (
              <div className="panel p-3 mt-3" style={{ background: "var(--surface)" }}>
                {attachOffer && savedHere !== null && (
                  <>
                    <p className="text-[12.5px]" style={{ color: "var(--text-2)" }}>
                      {`This adds the rollback above to v${bare(savedHere.version)} as v${bare(savedHere.version)}.down.sql; no new version is made. A saved rollback cannot be changed afterwards, so read it carefully first.`}
                    </p>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm mt-2"
                      disabled={offerSaving}
                      onClick={addRollbackToSaved}
                    >
                      {offerSaving ? "Saving the rollback…" : retryLabel}
                    </button>
                  </>
                )}
                {offerHere !== null && offerHere.kind !== "saving" && (
                  <p
                    className={`text-[12.5px]${attachOffer ? " mt-2" : ""}`}
                    style={{ color: offerHere.kind === "ok" ? "var(--sync)" : "var(--drift)" }}
                  >
                    {offerHere.message}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* ── Add a missing rollback ─────────────────────────────────────── */}
          {familyKey !== "" && (fixCount > 0 || (fixHere !== null && fixHere.kind !== "saving")) && (
            <div className="card p-5">
              <div className="section-title mb-3">Add a missing rollback</div>
              {fixCount > 0 && (
                <>
                  <p className="help mb-3">{fixIntro}</p>
                  <div style={{ maxWidth: 320 }}>
                    <label className="label" htmlFor="se-fix-version">Saved version</label>
                    <Select
                      variant="input"
                      id="se-fix-version"
                      className="mt-1"
                      mono
                      ariaLabel="Saved version to add a rollback to"
                      value={fixRow !== null ? fixRow.version : ""}
                      placeholder="Pick a version…"
                      options={fixRows.map((r) => ({
                        value: r.version,
                        label:
                          r.rollback_state === "none"
                            ? `v${bare(r.version)} — no rollback`
                            : `v${bare(r.version)} — rollback has no statements`,
                      }))}
                      onChange={(value) => {
                        setFix((current) => ({
                          key: familyKey,
                          version: value,
                          text: current.key === familyKey ? current.text : "",
                        }));
                        setFixStatus(null);
                      }}
                    />
                  </div>
                  {fixRow !== null && (
                    <>
                      <label className="label mt-3 block" htmlFor="se-fix-up">
                        {`Migration SQL of v${fixVersion} (read-only)`}
                      </label>
                      <textarea
                        id="se-fix-up"
                        className="input mono mt-1 se-textarea"
                        style={{ minHeight: 120, lineHeight: 1.6, resize: "vertical" }}
                        spellCheck={false}
                        readOnly
                        value={fixRow.sql_content}
                      />
                      <label className="label mt-3 block" htmlFor="se-fix-down">
                        {`Rollback SQL for v${fixVersion}`}
                      </label>
                      <textarea
                        id="se-fix-down"
                        className="input mono mt-1 se-textarea"
                        style={{ minHeight: 120, lineHeight: 1.6, resize: "vertical" }}
                        spellCheck={false}
                        value={fixText}
                        onChange={(e) => {
                          setFix({ key: familyKey, version: fixRow.version, text: e.target.value });
                          setFixStatus(null);
                        }}
                      />
                      {fixText.trim() !== "" && !fixRuns && (
                        <p className="help mt-1" style={{ color: "var(--break)" }}>
                          {`This rollback contains only comments, so it would undo nothing. Write the statements that undo v${fixVersion}'s migration.`}
                        </p>
                      )}
                      {fixTxn && (
                        <p className="help mt-1" style={{ color: "var(--break)" }}>{TXN_IN_ROLLBACK}</p>
                      )}
                      <p className="help mt-2">
                        A saved rollback cannot be changed afterwards — read it carefully. Once saved,
                        Deploy can undo this version, including where it is already applied.
                      </p>
                    </>
                  )}
                  <div className="mt-3 flex items-center gap-3 flex-wrap">
                    {fixBlocker && !fixSaving && <p className="help min-w-0 flex-1">{fixBlocker}</p>}
                    <button
                      type="button"
                      className="btn btn-primary btn-sm ml-auto"
                      disabled={fixSaving || fixBlocker !== null}
                      title={fixBlocker ?? undefined}
                      onClick={saveFixRollback}
                    >
                      {fixSaving
                        ? "Saving the rollback…"
                        : fixRow !== null
                          ? `Save rollback for v${fixVersion}`
                          : "Save rollback"}
                    </button>
                  </div>
                </>
              )}
              {fixHere !== null && fixHere.kind !== "saving" && (
                <p
                  className={`text-[12.5px]${fixCount > 0 ? " mt-3" : ""}`}
                  style={{ color: fixHere.kind === "ok" ? "var(--sync)" : "var(--drift)" }}
                >
                  {fixHere.message}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
