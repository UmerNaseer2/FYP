"use client";

import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  DeployIcon,
  RefreshIcon,
  CheckIcon,
  XIcon,
  AlertCircleIcon,
  AlertTriangleIcon,
  DriftIcon,
  InfoIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  EyeIcon,
  LogoIcon,
} from "@/components/ui/icons";
import {
  compareVersions,
  buildVersionLedger,
  levelOfStep,
  pendingPrefixThrough,
  versionKey,
  type LedgerEntry,
} from "@/lib/script-status";
import {
  containsTransactionControl,
  findRowDestroyingStatements,
  ROW_DESTROYING_NOT_BREAKING,
} from "@/lib/sql-guard";
import { analyseRunRisk } from "@/lib/deploy-risk";
import {
  describeChangeType,
  louderChangeType,
  type ChangeTypeReading,
  type ScriptChangeType,
} from "@/lib/change-type";
import { countOf } from "@/lib/plural";
import { Select } from "@/components/ui/Select";
import { EnvironmentPill } from "@/components/ui/EnvironmentPill";
import {
  isProduction,
  louderEnvironment,
  toEnvironment,
  DEFAULT_ENVIRONMENT,
  type Environment,
} from "@/lib/environments";
import { fingerprintBody, rollbackFingerprintBody } from "@/lib/approval-fingerprint";
import {
  listVersions,
  MAX_ROLLBACK_VERSIONS,
  planRollback,
  rollbackTargets,
  versionRange,
  vLabel,
  type RollbackStep,
} from "@/lib/rollback-plan";
import type { PulledRollbackState } from "@/lib/registry-push";
import { normalizeChangeLevel } from "@/lib/change-level";
import {
  displayVersion,
  mergeTimelines,
  outdatedSideOfEntries,
  timelineKey,
  type TimelineEntry,
  type TimelineRow,
  type TimelineStatus,
} from "@/lib/version-timeline";
import { useUser } from "@/hooks/useUser";
import { ApprovalPanel, sha256Hex, type ApprovalRow } from "@/components/studio/ApprovalPanel";
import { ProductionGate, RiskGate } from "@/components/studio/RiskGate";
import { VersionTimeline } from "@/components/studio/VersionTimeline";

// ---------------------------------------------------------------------------
// Deploy (S5) — Pre-flight → Run → Verify stepper.
//
// This is the Pass-6 reskin of the deploy panel that used to live inside the
// legacy /scripts page. The backend flow is reused verbatim (it is proven):
//   • GitHub is the source of truth for migration scripts (/api/github/pull).
//   • /api/scripts/preflight reads the target DB's script_patch ledger and
//     tells us the current version + applied history.
//   • pendingScripts = GitHub scripts for (schema, group) whose semver is
//     greater than the target's current version.
//   • /api/scripts/apply takes the WHOLE batch in one request and runs it in
//     one transaction. All of them or none of them — a failure anywhere rolls
//     the run back, so there is no partial deploy to unwind by hand. The same
//     call with dryRun rehearses the batch and always ends in ROLLBACK.
//
// Nothing on this screen is stubbed. The drift pre-check (stage 1) and the
// verify re-diff after a run (stage 3) are live: runDriftCheck finds the
// target's lineage snapshot (/api/lineage/lookup) and diffs the live schema
// against it (/api/lineage/drift), and DriftPanel draws the answer (the
// rollback card reuses it). Versions, the pending list, per-step timing and
// the ledger re-read after a run are all read from the target too.
//
// Each registry version of the family is Applied, Pending or Skipped
// (buildVersionLedger in lib/script-status). Skipped means never applied and
// below the version applied to the target. Deploys only move forward, so a
// skipped version never runs; the version timeline, the up-to-date card and
// the run panel each say so, so none of them reads as still to do.
//
// The pending list selects rather than runs: each row's "Run …" button (and
// "Run all (N)…") picks the pending versions up to that row
// (pendingPrefixThrough), and the Deploy and Dry run buttons name that range.
// The approval hash, a clean rehearsal and the recovery bar all compare the
// selection by its fingerprintBody text, so none of them can speak for a
// different range or for SQL a re-pull has changed.
// ---------------------------------------------------------------------------

// The deploy screen's own name for a script's change type. The grading itself
// lives in lib/change-type, so this screen and the generator can never disagree
// about what a script does.
type ChangeKind = ScriptChangeType;

// A migration script, loaded from the GitHub repo (the source of truth).
type GitHubScript = {
  database_name: string;
  schema_name: string;
  script_name: string;
  version: string;
  path: string;
  sql_content: string;
  /**
   * The rollback saved beside this version in the registry (v<ver>.down.sql).
   * Sent only when rollback_state is "usable": the pull leaves out a file that
   * is blank or only comments, contains COMMIT or ROLLBACK, or could not be
   * downloaded, and says which in rollback_state.
   */
  down_sql?: string;
  /** How the rollback file read. Optional: an older pull route did not say. */
  rollback_state?: PulledRollbackState;
};

// A saved connection from /api/connections.
type Connection = {
  id: number;
  name: string;
  host: string;
  port: number;
  database_name: string;
  type: string;
  /** dev / staging / prod, or "unset" when nobody has labelled it. */
  environment: Environment;
};

// One row of the target's applied history.
type PatchEntry = {
  version: string;
  title: string | null;
  change_type: string;
  applied_at: string;
  /** Whether the ledger row kept its own rollback. Optional: an older API. */
  has_down_sql?: boolean;
  /** The rollback stored on the row. Optional for the same reason. */
  down_sql?: string | null;
  /**
   * The SQL that ran, as the ledger row stored it: the only copy for a
   * version Version Sync replayed. Optional for the same reason.
   */
  sql_content?: string | null;
};

// What /api/scripts/preflight returns.
type PreflightResult = {
  hasVersionTable: boolean;
  needsInit: boolean;
  currentVersion: string | null;
  timeline: PatchEntry[];
  schema: string;
  scriptName: string | null;
  message: string;
  /**
   * Rollback history for this family, newest first (at most 50). Optional:
   * an older preflight route did not send it.
   */
  reverted?: RevertedEntry[];
  /**
   * Other families' versions applied after this family's first version,
   * oldest first (at most 200). The "Roll back to" panel narrows it to the
   * versions it would undo. Optional for the same reason.
   */
  otherScripts?: OtherScriptEntry[];
};

// One row of the rollback history (script_patch_reverted). Mirrors
// RevertedEntry in app/api/scripts/preflight/route.ts.
type RevertedEntry = {
  script_name: string;
  version: string;
  title: string | null;
  change_type: string | null;
  applied_at: string | null;
  reverted_at: string;
};

// A version of ANOTHER script family applied after this family's versions.
// The preflight and the revert route both send these. applied_at is typed as
// nullable because the revert route's copy comes straight from the ledger.
type OtherScriptEntry = {
  script_name: string;
  version: string;
  applied_at: string | null;
};

// Live status of a single migration during a run.
//
// "rehearsed" is a dry run's version of "applied": the SQL really executed
// against the target and then the whole run was rolled back.
// "unknown" is not a state the run passes through — it is what is left when
// the answer never arrived: the COMMIT did not report back, or the request
// itself never completed. Neither "applied" nor "skipped" is a thing this page
// can claim then, and picking one would send the reader off to do the wrong
// thing about half the time.
// "not-in-run" is a pending row the chosen target version stops short of. It
// is not a run state at all — the run never reaches it — but the pending list
// draws the same rows, and calling those "queued" promised the reader a run
// they had not asked for.
type RunStatus =
  | "queued"
  | "not-in-run"
  | "running"
  | "applied"
  | "rehearsed"
  | "failed"
  | "skipped"
  | "unknown";
// `statements` is how many statements PostgreSQL ran for this migration, as the
// server counted them. There is deliberately no per-migration duration: the run
// is one request and one transaction, so the only honest timing is the run's.
type RunCell = { status: RunStatus; error?: string; statements?: number };

// What POST /api/scripts/apply reports for one migration in the run.
type ApplyOutcome = {
  script_name: string;
  version: string;
  status: "applied" | "rehearsed" | "failed" | "skipped" | "unknown";
  statements?: number;
  error?: string;
};
// The parts of the apply response this page reads.
type ApplyResponse = {
  success?: boolean;
  error?: string;
  results?: ApplyOutcome[];
  message?: string;
  /** Set on a dry run the server could not rehearse — see the 55P04 branch. */
  dryRunLimitation?: boolean;
  /** Set when the COMMIT did not report back — see the route's catch block. */
  outcomeUnknown?: boolean;
};

// The change_type this page sends with a migration, to the apply route and to
// the approvals route: its stamp when it has one, its SQL's grade otherwise.
// The page's own risk reading (runRisk) is given the same value, so the boxes
// on this page and the server's checks read every migration the same way.
function changeTypeSent(sql: string): ScriptChangeType {
  return describeChangeType(sql).recorded;
}

// The parts of POST /api/scripts/revert's response this page reads. Every
// refusal carries `error` and every success carries `message`: a sentence that
// says what happened and what state the target is in now. The page shows it
// as written, so the screen and the server never tell two different stories.
type RevertResponse = {
  success?: boolean;
  error?: string;
  message?: string;
  dryRun?: boolean;
  /** The versions the route undid, or rehearsed, newest first. */
  versions?: string[];
  /**
   * Other families' versions applied after the oldest version this rollback
   * undoes, as the server counted them. Sent with a dry run's result and with
   * the refusal that asks for the other-scripts tick.
   */
  otherScripts?: OtherScriptEntry[];
  /** Production, and nobody else has approved this exact rollback yet. */
  needsApproval?: boolean;
  /** The COMMIT did not report back, so nobody knows whether it happened. */
  outcomeUnknown?: boolean;
  /**
   * Why the route refused, as a short code. "not_applied" and "not_newest"
   * mean this page's copy of the ledger is out of date, so it reads it again.
   */
  code?: string;
};

// ── Phase 6 drift pre-check (lineage) ──────────────────────────────────────
// The bits we use from POST /api/lineage/drift. The deploy page shows the
// status + human summary; the full Expected-vs-Actual report belongs to the
// drift detail screen, so we deliberately don't pull it in here.
type DriftCounts = {
  tablesAdded: number;
  tablesRemoved: number;
  tablesChanged: number;
  constraintsChanged: number;
};
type DriftResult = {
  status: "in_sync" | "drifted" | "unreachable";
  summary: string;
  counts: DriftCounts | null;
  expectedVersion: string | null;
  checkedAt: string;
};
// Where the lineage drift check stands for the chosen target.
type DriftPhase = "idle" | "loading" | "untracked" | "ready" | "error";

// Version comparison + the Applied/Pending ledger live in lib/script-status so
// they can be unit-tested in isolation; compareVersions is imported above.
function sortGitHubScriptsByVersion(scripts: GitHubScript[]): GitHubScript[] {
  return [...scripts].sort((a, b) => compareVersions(a.version, b.version));
}

// Stable unique key — must include schema_name because two schemas can hold the
// same script_name@version pair.
function scriptKey(s: GitHubScript): string {
  return `${s.schema_name}@${s.script_name}@${s.version}`;
}

function getSqlLineCount(sql: string): number {
  return sql.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

// The version bump a change kind implies — used for the "bump" summary.
function bumpWord(kind: ChangeKind): "major" | "minor" | "patch" {
  if (kind === "breaking") return "major";
  if (kind === "additive") return "minor";
  return "patch";
}

// The COMMIT/ROLLBACK pre-flight check uses the SAME helper as the server apply
// route (lib/sql-guard), so the advisory warning here can never disagree with
// what the route actually rejects — including the dollar-quoted-body handling.

// "1 statement" / "4 statements" — the count PostgreSQL reported for one script.
function fmtStatements(n: number): string {
  return `${n} statement${n === 1 ? "" : "s"}`;
}

function fmtSecs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

// Short, safe date for the ledger's applied rows. Returns "" for a missing or
// unparseable timestamp rather than "Invalid Date".
function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// Applied / Pending / Skipped (the version ledger, lib/script-status) → the
// "This database" status in the version timeline.
//
// - `current` is the version applied to the target ("v5.0.2"). A skipped
//   version's tooltip names it, so the reason it will not run is one hover
//   away.
// - `rolledBack` is the version's latest rollback, given only when it is not
//   applied now. The status then says when it was rolled back, so "Pending"
//   is not read as "never deployed". The status word stays Pending or
//   Skipped, because that word is what a deploy will do with it.
// - `pullWarned` says part of the registry could not be read. That is a
//   second reason an applied version can have no registry file.
function ledgerStatus(
  entry: LedgerEntry,
  rolledBack: RevertedEntry | null,
  current: string,
  pullWarned: boolean
): TimelineStatus {
  if (entry.status === "applied") {
    if (entry.inRegistry) return { text: "Applied", tone: "applied" };
    return {
      text: "Applied — no registry file",
      tone: "applied",
      title: pullWarned
        ? "Applied to this database, but the registry has no file for it: applied directly, " +
          "replayed here by Version Sync, or its file could not be read (see the top of the page)."
        : "Applied to this database, but the registry has no file for it: applied directly, " +
          "or replayed here by Version Sync.",
    };
  }
  // " · rolled back 3 Sep 2026", or without the date when it is unreadable.
  const undone = rolledBack ? fmtDate(rolledBack.reverted_at) : "";
  const note = rolledBack ? ` · rolled back${undone ? ` ${undone}` : ""}` : "";
  if (entry.status === "pending") {
    return {
      text: `Pending${note}`,
      tone: "pending",
      title: rolledBack
        ? rolledBackTitle(rolledBack, "pending", current)
        : "Not applied to this database yet. A deploy that includes it runs it.",
    };
  }
  return {
    text: `Skipped${note}`,
    tone: "skipped",
    title: rolledBack
      ? rolledBackTitle(rolledBack, "skipped", current)
      : `Never applied, and below ${current}, the version applied to the target. ` +
        "Deploys only move forward, so this version will not run.",
  };
}

// The note above the version timeline that explains its Skipped rows: what
// happened, that a deploy will not run them, and how to still ship the change
// (the Script Editor saves a change as the family's next version, above the
// version applied to the target).
function skippedNote(skipped: ReadonlyArray<string>, current: string): string {
  if (skipped.length === 1) {
    return (
      `Skipped: ${listVersions(skipped)} was never applied and is below ${current}, ` +
      `the version applied to the target. Deploys only move forward, so it will not run. ` +
      `If its change is still needed, save it in the Script Editor as a new version above ${current}.`
    );
  }
  return (
    `Skipped: ${listVersions(skipped)} were never applied and are below ${current}, ` +
    `the version applied to the target. Deploys only move forward, so they will not run. ` +
    `If their changes are still needed, save them in the Script Editor as new versions above ${current}.`
  );
}

// Tooltip for "rolled back <date>" on a version that is not applied now: when
// it ran, when it was undone, and whether a deploy would run it again. A
// pending version is in the next deploy's list; a skipped one is below the
// target's version, and deploys only move forward.
function rolledBackTitle(row: RevertedEntry, status: LedgerEntry["status"], current: string): string {
  const applied = fmtDate(row.applied_at);
  const undone = fmtDate(row.reverted_at);
  const history =
    (applied ? `Applied ${applied}, then rolled back` : "Rolled back") +
    (undone ? ` ${undone}` : "") +
    ", so it is not applied now.";
  return status === "pending"
    ? `${history} A deploy that includes it runs it again.`
    : `${history} It is below ${current}, the version applied to the target, so a deploy will not run it again.`;
}

// The text an approval of this batch is hashed from (lib/approval-fingerprint,
// the same text the server hashes). The rehearsal pin and the recovery bar
// compare these strings directly: equal text means the same scripts, in the
// same order, with the same SQL, so no hashing is needed to tell.
function batchBody(scripts: ReadonlyArray<GitHubScript>): string {
  return fingerprintBody(
    scripts.map((s) => ({ scriptName: s.script_name, version: s.version, sqlContent: s.sql_content }))
  );
}

// How the selected batch differs from one that already ran (a rehearsal, or
// the run on screen), so the page can say why that run no longer speaks for
// the selection. null when it still does (the same body).
// - "nothing": nothing is selected now (a re-read found it all applied).
// - "scripts": the same versions, but the SQL changed (a re-pull).
// - "range":   a different set of versions.
type SelectionChange = "nothing" | "range" | "scripts";
function selectionChange(
  ranBody: string | null,
  ran: ReadonlyArray<GitHubScript>,
  selected: ReadonlyArray<GitHubScript>,
  selectedBody: string
): SelectionChange | null {
  if (ranBody !== null && ranBody === selectedBody) return null;
  if (selected.length === 0) return "nothing";
  const sameVersions =
    ran.length === selected.length &&
    ran.every((s, i) => versionKey(s.version) === versionKey(selected[i].version));
  return sameVersions ? "scripts" : "range";
}

// Names for two different runs of one family, so a sentence that sets them
// side by side never prints the same words twice. The range reads
// "v5.0.1 → v6.0.0". If the ranges read the same, the counts tell them apart
// ("(3)" and "(2)" when a version between them was added or removed). Failing
// that, every version is listed.
function nameTwoRuns(ran: ReadonlyArray<string>, now: ReadonlyArray<string>): [string, string] {
  const a = versionRange(ran);
  const b = versionRange(now);
  if (a !== b) return [a, b];
  if (ran.length !== now.length) return [`${a} (${ran.length})`, `${b} (${now.length})`];
  return [listVersions(ran), listVersions(now)];
}

// Change-kind → status pill.
function kindPill(kind: ChangeKind) {
  if (kind === "breaking") {
    return (
      <span className="pill pill-break">
        <span className="dot" />
        breaking
      </span>
    );
  }
  if (kind === "additive") {
    return (
      <span className="pill pill-pending">
        <span className="dot" />
        additive
      </span>
    );
  }
  return (
    <span className="pill pill-neutral">
      <span className="dot" style={{ background: "var(--text-3)" }} />
      patch
    </span>
  );
}

// The right-hand status cell of a mig-row.
function RightStatus({ cell }: { cell: RunCell }) {
  if (cell.status === "running") {
    return (
      <span className="right-status">
        <span className="spin" style={{ width: 12, height: 12 }} />
        running…
      </span>
    );
  }
  if (cell.status === "applied" || cell.status === "rehearsed") {
    return (
      <span className="right-status" style={{ color: "var(--sync)" }}>
        <span className="status-ico applied">
          <CheckIcon size={11} />
        </span>
        {cell.status}
        {cell.statements !== undefined ? ` · ${fmtStatements(cell.statements)}` : ""}
      </span>
    );
  }
  if (cell.status === "failed") {
    return (
      <span className="right-status" style={{ color: "var(--break)" }}>
        <span className="status-ico failed">
          <XIcon size={11} />
        </span>
        failed
      </span>
    );
  }
  if (cell.status === "skipped") {
    return (
      <span className="right-status">
        <span className="status-ico skipped">
          <XIcon size={11} />
        </span>
        skipped
      </span>
    );
  }
  if (cell.status === "unknown") {
    return (
      <span className="right-status" style={{ color: "var(--drift)" }}>
        <span className="status-ico unknown">
          <AlertTriangleIcon size={11} />
        </span>
        not known
      </span>
    );
  }
  if (cell.status === "not-in-run") {
    return <span className="right-status">not in this run</span>;
  }
  // queued — waiting to run is not a warning, so it gets a dot, not an alert.
  return (
    <span className="right-status">
      <span
        className="w-[6px] h-[6px] rounded-full inline-block flex-none"
        style={{ background: "var(--text-3)" }}
      />
      queued
    </span>
  );
}

// One migration row, shared by the pending list (stage 1) and run list (stage 2/3).
function MigRow({
  seq,
  name,
  kind,
  sub,
  rightPill,
  cell,
  selected,
  sql,
  sqlOpen,
  notes,
  action,
}: {
  seq: string;
  name: string;
  kind: ChangeKind;
  sub: string;
  rightPill: string;
  cell: RunCell;
  selected?: boolean;
  /**
   * The statements this row will run. When given, the row opens to show them.
   *
   * The checklist beside this list asks the reader to tick "I have read the
   * breaking migrations and know what they remove" — an attestation about SQL
   * that, until this existed, appeared nowhere on the page and had no link out
   * to it. A tick box in front of text nobody can read is not a safety gate,
   * it is a formality, so the text is here.
   */
  sql?: string;
  /** Start expanded. Used for the breaking ones, which are the point. */
  sqlOpen?: boolean;
  /**
   * Short sentences under the row: why it counts as breaking when its label
   * says less, a version step that disagrees with its level, and whether a
   * rollback will be saved with it. `warn` colours the ones worth acting on.
   */
  notes?: { text: string; warn: boolean }[];
  /** A control under the notes. The pending list puts its "Run …" button here. */
  action?: ReactNode;
}) {
  const cls = ["mig-row", cell.status, selected ? "selected" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="mig-item">
      <div className={cls}>
        <div className="seq-circle">{seq}</div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="name">{name}</span>
            {kindPill(kind)}
          </div>
          <div className="sub mono">{sub}</div>
          {notes?.map((note, index) => (
            <div
              key={index}
              className="help mt-0.5"
              style={note.warn ? { color: "var(--drift)" } : undefined}
            >
              {note.text}
            </div>
          ))}
          {action && <div className="mig-row__action">{action}</div>}
        </div>
        <span className="pill pill-outline mono">{rightPill}</span>
        <RightStatus cell={cell} />
      </div>
      {cell.error && <pre className="err-pre">{cell.error}</pre>}
      {sql && (
        <details className="mig-sql" open={sqlOpen}>
          <summary>
            <ChevronDownIcon className="chev" size={12} />
            <span>SQL</span>
            <span className="mono">{countOf(getSqlLineCount(sql), "line")}</span>
          </summary>
          <pre className="sql">{sql.trim()}</pre>
        </details>
      )}
    </div>
  );
}

// The "Roll back to" choice that undoes every applied version of the family.
// Not a version number, so it can never collide with one.
const BEFORE_FIRST = "__before_first__";

type RowNote = { text: string; warn: boolean };

// How the pull read a version's rollback file (its rollback_state). Not
// lib/registry-push's rollbackFileState: that one classifies a file's text,
// this one only reads the answer the pull already worked out. The pull sets
// it on every script; without one, the fallback agrees with the apply body,
// which sends down_sql whenever there is one.
function pulledRollbackState(script: GitHubScript): PulledRollbackState {
  return script.rollback_state ?? (script.down_sql ? "usable" : "none");
}

/**
 * The short notes under one pending migration in stage 1, in reading order:
 *   1. its SQL is always breaking though its label says less (counted anyway);
 *   2. its version number moves by a different step than its level;
 *   3. whether Deploy will be able to undo it once it is applied.
 * `reading` is describeChangeType of its SQL, which the row has worked out
 * already. `previous` is the version it follows on the target: the pending
 * version before it, or the target's current version for the first one.
 */
function pendingRowNotes(
  script: GitHubScript,
  reading: ChangeTypeReading,
  previous: string | null
): RowNote[] {
  const notes: RowNote[] = [];
  const v = vLabel(script.version);

  if (reading.louderNote) notes.push({ text: reading.louderNote, warn: true });

  // The level wins everywhere on this page (the pill, the bump, what is
  // recorded), so a version number that says otherwise gets a sentence. It is
  // a warning when the number says more than the level: the reader sees, say,
  // a major version that the breaking checks do not count.
  const step = previous ? levelOfStep(previous, script.version) : null;
  if (previous && step && step !== reading.recorded) {
    const why = reading.declared
      ? `this migration is marked ${reading.recorded}`
      : `its SQL grades as ${reading.recorded}`;
    const uncounted =
      step === "breaking" && !reading.countsAsBreaking
        ? " It is not counted in the breaking checks."
        : "";
    notes.push({
      text:
        `${v} is a ${bumpWord(step)} step from ${vLabel(previous)}, but ${why}, ` +
        `so it is recorded as ${reading.recorded}.${uncounted} ` +
        "Major = breaking, minor = additive, patch = small change.",
      warn: louderChangeType(step, reading.recorded) === step,
    });
  }

  const file = `${v}.down.sql`;
  const state = pulledRollbackState(script);
  if (state === "usable") {
    notes.push({
      text: `Has a rollback (${file}). Deploying saves it with this version, so Deploy can undo it later.`,
      warn: false,
    });
  } else if (state === "none") {
    notes.push({
      text: `No rollback file (${file}) in the registry. Once applied, Deploy can undo it only after one is added in the Script Editor.`,
      warn: false,
    });
  } else if (state === "no_statements") {
    notes.push({
      text: `Its rollback file (${file}) is blank or only comments, so it counts as none. Once applied, Deploy can undo it only after a real one is written in the Script Editor.`,
      warn: false,
    });
  } else if (state === "transaction_control") {
    notes.push({
      text: `Its rollback file (${file}) contains COMMIT or ROLLBACK, so it is not saved with this version and Deploy cannot run it. Remove those statements in the Script Editor.`,
      warn: true,
    });
  } else {
    notes.push({
      text: `Its rollback file (${file}) could not be downloaded, so deploying now does not save it with this version. Reload the page to read it again.`,
      warn: true,
    });
  }
  return notes;
}

/**
 * Why one version in a "Roll back to" plan cannot be undone from Deploy, and
 * what to do about it. `editor` is true when the fix is in the Script Editor,
 * so the panel can link there.
 *
 * A registry rollback that cannot run never reaches planRollback (the pull
 * leaves its text out), so the file's rollback_state is what says why.
 * `registryComplete` is false when the pull could not read part of the
 * registry: then a file that seems to be missing may only be unread.
 */
function rollbackProblemText(
  step: RollbackStep<GitHubScript>,
  registryComplete: boolean
): { text: string; editor: boolean } {
  const v = vLabel(step.version);
  const file = `${v}.down.sql`;
  const fileState = step.registry ? pulledRollbackState(step.registry) : null;

  if ("problem" in step.resolved && step.resolved.problem === "transaction_control") {
    // The copy saved on the ledger row ends the transaction itself, and the
    // registry has nothing that could run in its place.
    const saved =
      `The rollback saved when ${v} was applied contains COMMIT or ROLLBACK, so it ` +
      "cannot run inside the transaction that protects this rollback.";
    if (fileState === null) {
      return {
        text: registryComplete
          ? `${saved} Run it by hand from a SQL console.`
          : `${saved} Part of the registry could not be read (see the top of the page), so a ${file} that could run instead may be missing. Reload the page to try again, or run it by hand from a SQL console.`,
        editor: false,
      };
    }
    if (fileState === "unreadable") {
      return {
        text: `${saved} ${file} could not be downloaded to run instead. Reload the page to read it again, or run the rollback by hand from a SQL console.`,
        editor: false,
      };
    }
    if (fileState === "transaction_control") {
      return {
        text: `${saved} So does ${file} in the registry. Remove those statements from it in the Script Editor, or run the rollback by hand from a SQL console.`,
        editor: true,
      };
    }
    return {
      text: `${saved} A ${file} without them runs instead: write one in the Script Editor, or run the rollback by hand from a SQL console.`,
      editor: true,
    };
  }

  // No rollback that runs, saved or in the registry.
  if (fileState === null) {
    return {
      text: registryComplete
        ? `${v} has no rollback saved with it and no file in the registry for this schema, so Deploy has nothing to run. Undo it by hand from a SQL console, or fix it forward with a new version.`
        : `${v} has no rollback saved with it, and no ${file} was read from the registry: part of the registry could not be read (see the top of the page). Reload the page to try again.`,
      editor: false,
    };
  }
  if (fileState === "unreadable") {
    return {
      text: `${v} has no rollback saved with it, and ${file} could not be downloaded from GitHub. Reload the page to read it again.`,
      editor: false,
    };
  }
  if (fileState === "transaction_control") {
    return {
      text: `${v} has no rollback saved with it, and ${file} contains COMMIT or ROLLBACK, so it cannot run inside the transaction that protects this rollback. Remove those statements from it in the Script Editor, or run it by hand from a SQL console.`,
      editor: true,
    };
  }
  if (fileState === "no_statements") {
    return {
      text: `${v} has no rollback saved with it, and ${file} is blank or only comments. Write the rollback in the Script Editor, then open Deploy again.`,
      editor: true,
    };
  }
  return {
    text: `${v} has no rollback: none was saved when it was applied, and the registry has no ${file}. Add one in the Script Editor (Add a missing rollback), then open Deploy again.`,
    editor: true,
  };
}

export default function DeployPage() {
  // Who is looking. The approval panel needs two things from this: whether to
  // offer Approve at all (admins decide), and whether this is the same person
  // who asked for the run (nobody clears their own).
  const { user, isAdmin, bypass } = useUser();

  // ── Selection state ──────────────────────────────────────────────────────
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectionsLoaded, setConnectionsLoaded] = useState(false);
  const [connectionsFailed, setConnectionsFailed] = useState(false);
  const [connectionId, setConnectionId] = useState<string>("");
  const [schemas, setSchemas] = useState<string[]>([]);
  const [schemasLoading, setSchemasLoading] = useState(false);
  const [schemasError, setSchemasError] = useState<string | null>(null);
  const [schema, setSchema] = useState<string>("");
  const [scriptGroup, setScriptGroup] = useState<string>("");

  // ── GitHub script source ─────────────────────────────────────────────────
  const [githubScripts, setGithubScripts] = useState<GitHubScript[] | null>(null);
  const [pullLoading, setPullLoading] = useState(false);
  const [pullError, setPullError] = useState<string | null>(null);
  // What the pull could not read: a family folder, a version file, a rollback
  // file. The rest of the registry still loads, so the page lists what is
  // missing instead of letting it pass as "not there".
  const [pullWarnings, setPullWarnings] = useState<string[]>([]);

  // ── Pre-flight + target ──────────────────────────────────────────────────
  const [preflightResult, setPreflightResult] = useState<PreflightResult | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [targetVersion, setTargetVersion] = useState<string>("");
  // Where a "Run …" button takes the reader: the run panel, at its first
  // unticked box or else its Deploy button. And where "Roll back to here…" in
  // the version timeline takes them: the Roll back card.
  const runPanelRef = useRef<HTMLDivElement>(null);
  const deployButtonRef = useRef<HTMLButtonElement>(null);
  const rollbackCardRef = useRef<HTMLDivElement>(null);

  // ── Environment of the chosen target ─────────────────────────────────────
  // The connection carries one label; the tracked schema can carry a louder one
  // (a prod schema on a box nobody labelled). We learn the schema's only when
  // the lineage lookup runs, so this starts unset and is filled in by the
  // pre-flight check — the connection's label alone is enough to warn with in
  // the meantime.
  const [schemaEnvironment, setSchemaEnvironment] =
    useState<Environment>(DEFAULT_ENVIRONMENT);
  // True when the lineage lookup failed, so the schema's own label was never
  // read. The pill then shows only the connection's label, which is the quieter
  // of the two — the page has to say that rather than let it pass as the answer.
  const [environmentUnknown, setEnvironmentUnknown] = useState(false);
  // Ticked in the ProductionGate. One per destructive action, never shared.
  const [deployAcknowledged, setDeployAcknowledged] = useState(false);

  // Ticked beside the risk they belong to, never shared with each other or
  // with the production tick — three different things to have read.
  const [breakingAcknowledged, setBreakingAcknowledged] = useState(false);
  const [dataLossAcknowledged, setDataLossAcknowledged] = useState(false);
  const [driftAcknowledged, setDriftAcknowledged] = useState(false);

  // ── Deploy approvals (the two-person rule) ───────────────────────────────
  // runHash identifies the exact batch on screen. It is compared against the
  // run_fingerprint of the rows below, so the panel can only ever call a run
  // approved when the approved SQL is the SQL that would run.
  const [runHash, setRunHash] = useState<string | null>(null);
  const [hashError, setHashError] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [approvalsLoading, setApprovalsLoading] = useState(false);
  // Why the list could not be read. Kept apart from a failed request or
  // decision, because only this one means "the approval state is unknown".
  const [approvalsReadError, setApprovalsReadError] = useState<string | null>(null);
  // A deploy approval request or decision that failed.
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [approvalNote, setApprovalNote] = useState("");
  // Bumped after a request or a decision to re-read the list. A counter rather
  // than a shared loader function keeps the fetch in one effect, with one
  // cancellation path.
  const [approvalReloadKey, setApprovalReloadKey] = useState(0);

  // ── Drift pre-check (Phase 6 lineage) ────────────────────────────────────
  const [driftPhase, setDriftPhase] = useState<DriftPhase>("idle");
  const [driftResult, setDriftResult] = useState<DriftResult | null>(null);
  const [driftError, setDriftError] = useState<string | null>(null);
  // The last drift result on record for this target, as the lineage lookup
  // reported it before this check ran. The apply route holds a run to that
  // record, so when this check fails the drift tick is still asked for (see
  // driftGateStatus).
  const [storedDriftStatus, setStoredDriftStatus] = useState<DriftResult["status"] | null>(null);

  // ── Roll back to (undo the newest applied versions of this family) ──────
  // rollbackChoice is the version picked in "Roll back to", or BEFORE_FIRST
  // for "undo every version". null means nothing picked yet; the panel then
  // offers the smallest rollback there is (see rollbackPick).
  const [rollbackChoice, setRollbackChoice] = useState<string | null>(null);
  // Whether the planner (the pick, the preview, the checks and the buttons) is
  // open. It opens on request, so the deploy below stays the main thing here.
  const [rollbackOpen, setRollbackOpen] = useState(false);
  // Which request is in flight, so only its own button says so.
  const [rollbackBusy, setRollbackBusy] = useState<"dry" | "real" | null>(null);
  // One database-changing request at a time (a deploy or a rollback). The
  // buttons disable through state, but two quick presses can both run before
  // React re-renders; a ref is read and set at once.
  const writeInFlight = useRef(false);
  // Why the last request failed, in the revert route's own words, and the
  // plan it was about. `sticky` keeps the message on screen when the ledger
  // is read again because of it and the plan changes: after an outcome
  // nobody knows, and after a refusal caused by an out-of-date ledger.
  const [rollbackError, setRollbackError] = useState<{
    key: string;
    message: string;
    sticky: boolean;
  } | null>(null);
  // A dry run's result, kept with the plan it rehearsed (rollbackKey), so a
  // different plan never shows another plan's "Dry run passed".
  const [rollbackDryRun, setRollbackDryRun] = useState<{ key: string; message: string } | null>(null);
  // The route's message after a real rollback, shown until the next action.
  const [rollbackDone, setRollbackDone] = useState<{ message: string } | null>(null);
  // The other families' versions the server found after the oldest version a
  // plan undoes. Once known for a plan, it replaces the page's estimate.
  const [rollbackOtherScripts, setRollbackOtherScripts] = useState<{
    key: string;
    list: OtherScriptEntry[];
  } | null>(null);
  // One tick per risk, never shared with the deploy's ticks.
  const [rollbackProdAck, setRollbackProdAck] = useState(false);
  const [rollbackDataLossAck, setRollbackDataLossAck] = useState(false);
  const [rollbackOtherAck, setRollbackOtherAck] = useState(false);
  // The rollback's own approval: the fingerprint of the rollback SQL on
  // screen, and the note and errors of its request and decisions.
  const [rollbackHash, setRollbackHash] = useState<string | null>(null);
  const [rollbackHashError, setRollbackHashError] = useState<string | null>(null);
  const [rollbackApprovalError, setRollbackApprovalError] = useState<string | null>(null);
  const [rollbackApprovalNote, setRollbackApprovalNote] = useState("");

  // ── Stepper + run ────────────────────────────────────────────────────────
  const [stage, setStage] = useState<1 | 2 | 3>(1);
  const [isDeploying, setIsDeploying] = useState(false);
  // The exact ordered batch captured at run start — the run/verify lists render
  // from this, so a post-run preflight refresh can't reshuffle them.
  const [runScripts, setRunScripts] = useState<GitHubScript[]>([]);
  // Where the run started from, captured before it starts. See handleRun.
  const [runFromVersion, setRunFromVersion] = useState<string>("");
  const [runStatus, setRunStatus] = useState<Record<string, RunCell>>({});
  const [runComplete, setRunComplete] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  // True while the run on screen is a rehearsal. Kept separate from the button
  // that started it so the whole stage-2 view can say so, including after it
  // finishes and the button is no longer in the picture.
  const [runIsDryRun, setRunIsDryRun] = useState(false);
  // What the last clean dry run rehearsed (its batchBody), or null. "Deploy
  // for real" deploys the current selection, so it is offered only while the
  // selection's body is this one: a rehearsal of v5.0.1 → v5.0.2 must not
  // clear a deploy of v5.0.1 → v6.0.0, nor SQL that a re-pull has changed.
  const [rehearsedBody, setRehearsedBody] = useState<string | null>(null);
  // A failure that belongs to the run rather than to any one migration — a
  // rejected request, an unreadable response, a connection that never landed.
  const [runError, setRunError] = useState<string | null>(null);
  // True when the server turned the last run away (a 4xx answer): it checked
  // the request and applied none of it. The rows and the recovery bar then say
  // "refused" rather than "rolled back", which would describe a run that never
  // got going.
  const [runRefused, setRunRefused] = useState(false);

  const timerRef = useRef<number | null>(null);
  const runStartRef = useRef(0);

  // ── Toast ────────────────────────────────────────────────────────────────
  // The toast carries failures as well as successes, so it has to know which
  // it is holding — a green tick over "Deploy failed" reads as the opposite of
  // what happened. It is mounted only while it is on screen, so the aria-live
  // announcement fires once per run instead of sitting invisible in the DOM.
  const [toast, setToast] = useState<{ kind: "ok" | "bad"; msg: string } | null>(null);
  const toastTimer = useRef<number | null>(null);

  function showToast(msg: string, kind: "ok" | "bad" = "ok") {
    setToast({ kind, msg });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 1900);
  }

  // ── Load connections + GitHub scripts on mount ───────────────────────────
  useEffect(() => {
    fetch("/api/connections", { cache: "no-store" })
      .then(async (r) => (r.ok ? ((await r.json()) as unknown) : null))
      .then((data: unknown) => {
        // An unreadable list is not an empty one. Saying "add a connection
        // first" when the app database is down sends the user to a page that
        // will fail the same way.
        if (Array.isArray(data)) setConnections(data as Connection[]);
        else setConnectionsFailed(true);
      })
      .catch(() => setConnectionsFailed(true))
      .finally(() => setConnectionsLoaded(true));

    void handlePull();
  }, []);

  // Clean up the elapsed-time interval if the user navigates away mid-run.
  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    };
  }, []);

  // Load schemas from the target DB whenever the connection changes.
  useEffect(() => {
    if (!connectionId) {
      setSchemas([]);
      setSchemasError(null);
      return;
    }
    void fetchSchemas(connectionId);
  }, [connectionId]);

  // ── Derived data ─────────────────────────────────────────────────────────
  const activeConn = useMemo(
    () => connections.find((c) => String(c.id) === connectionId) ?? null,
    [connections, connectionId]
  );

  // What we warn about. louderEnvironment is the same rule the compare screen
  // uses, so a target cannot look calmer here — where the SQL actually runs —
  // than it does there.
  const targetEnvironment = louderEnvironment(
    toEnvironment(activeConn?.environment),
    schemaEnvironment
  );
  const targetIsProduction = isProduction(targetEnvironment);

  // Scope the pulled scripts to the selected connection's database. GitHub now
  // stores scripts under <database_name>/<schema>/..., so a script only belongs
  // to this deploy if its database_name matches the chosen connection. With no
  // connection picked yet we don't scope, so nothing is hidden prematurely.
  const scopedScripts = useMemo(
    () =>
      (githubScripts ?? []).filter(
        (s) => !activeConn || s.database_name === activeConn.database_name
      ),
    [githubScripts, activeConn]
  );

  const groupedScripts = useMemo(() => {
    return scopedScripts.reduce<Record<string, GitHubScript[]>>((acc, s) => {
      (acc[s.script_name] ??= []).push(s);
      return acc;
    }, {});
  }, [scopedScripts]);

  // Script groups that actually exist in the chosen schema's GitHub folder.
  const schemaScriptNames = useMemo(() => {
    if (!schema) return [];
    return Array.from(
      new Set(
        scopedScripts.filter((s) => s.schema_name === schema).map((s) => s.script_name)
      )
    ).sort();
  }, [scopedScripts, schema]);

  // Scripts not yet applied to the target — strictly greater than its version.
  const pendingScripts = useMemo<GitHubScript[]>(() => {
    if (!scriptGroup || !preflightResult) return [];
    const groupVersions = (groupedScripts[scriptGroup] ?? []).filter(
      (s) => s.schema_name === schema
    );
    const sorted = sortGitHubScriptsByVersion(groupVersions);
    if (!preflightResult.currentVersion) return sorted;
    return sorted.filter(
      (s) => compareVersions(s.version, preflightResult.currentVersion!) > 0
    );
  }, [scriptGroup, preflightResult, groupedScripts, schema]);

  // What a run to the chosen version applies, oldest first: the pending
  // versions up to and including it. pendingPrefixThrough is the one rule for
  // a partial run; a pick that is not pending gives an empty run, never every
  // version below it.
  const scriptsUpToTarget = useMemo(
    () => pendingPrefixThrough(pendingScripts, targetVersion),
    [pendingScripts, targetVersion]
  );
  // The selection's body and the body of the run on screen. The approval
  // hash, the rehearsal pin and the recovery bar all compare these.
  const selectionBody = useMemo(() => batchBody(scriptsUpToTarget), [scriptsUpToTarget]);
  const runBody = useMemo(() => batchBody(runScripts), [runScripts]);

  // Forward view (Phase 3): every GitHub version of the chosen family labelled
  // Applied / Pending / Skipped against the target's applied history. Both
  // inputs are scoped to one (database, schema, script_name) — scopedScripts is
  // already database-filtered, the schema filter narrows it, and the preflight
  // timeline is the target DB's script_patch for this exact family — so two
  // databases sharing a script_name@version can never cross-contaminate.
  const versionLedger = useMemo<LedgerEntry[]>(() => {
    if (!scriptGroup || !preflightResult) return [];
    const familyVersions = (groupedScripts[scriptGroup] ?? [])
      .filter((s) => s.schema_name === schema)
      .map((s) => s.version);
    return buildVersionLedger(familyVersions, preflightResult.timeline);
  }, [scriptGroup, preflightResult, groupedScripts, schema]);

  const appliedCount = versionLedger.filter((e) => e.status === "applied").length;
  const pendingCount = versionLedger.filter((e) => e.status === "pending").length;
  // Versions a deploy will never run: never applied and below the target's
  // version. The ledger, the up-to-date card and the run panel all name them.
  const skippedVersions = versionLedger
    .filter((e) => e.status === "skipped")
    .map((e) => e.version);

  // A version we asked for is not a version we read — never print one as the
  // other. A failed ledger read leaves preflightResult null, and "fresh" there
  // would be a claim about the target that nothing has checked.
  // vLabel, not a bare "v" prefix: the ledger may store "v5.0.2", and the
  // label must read "v5.0.2", not "vv5.0.2". Declared up here because the
  // version timeline's statuses name it.
  const currentLabel = !preflightResult
    ? "unknown"
    : preflightResult.currentVersion
      ? vLabel(preflightResult.currentVersion)
      : "fresh";

  // ── Roll back to ─────────────────────────────────────────────────────────
  // The registry's versions of this family in this schema. A version with no
  // rollback saved on its ledger row finds one here (v<ver>.down.sql).
  const familyRegistry = useMemo(
    () => (groupedScripts[scriptGroup] ?? []).filter((s) => s.schema_name === schema),
    [groupedScripts, scriptGroup, schema]
  );

  // The applied versions, newest first. Read from the target's ledger rather
  // than the registry, so a version with no registry file (replayed here by
  // Version Sync) is still listed.
  const appliedNewestFirst = useMemo(
    () =>
      (preflightResult?.timeline ?? [])
        .map((row) => row.version)
        .sort((a, b) => compareVersions(b, a)),
    [preflightResult]
  );

  // The choices, each saying what it undoes, so nobody has to work out that
  // "roll back to v1.0.0" also takes v1.1.0 off. rollbackTargets leaves out
  // any choice that undoes more than MAX_ROLLBACK_VERSIONS versions (the
  // revert route refuses those), so every choice here can run, and a family
  // further back than that is rolled back in several steps.
  const rollbackOptions = useMemo(() => {
    const undone = (count: number) => {
      const versions = appliedNewestFirst.slice(0, count);
      return versions.length > 3
        ? `${versions.length} versions, ${vLabel(versions[0])} down to ${vLabel(versions[versions.length - 1])}`
        : listVersions(versions);
    };
    return rollbackTargets(appliedNewestFirst).map(({ target, undoCount }) =>
      target !== null
        ? { value: target, label: `${vLabel(target)} — undo ${undone(undoCount)}` }
        : {
            value: BEFORE_FIRST,
            label:
              undoCount === 1
                ? `Before the first version — undo ${vLabel(appliedNewestFirst[0])}`
                : `Before the first version — undo all ${undoCount} versions`,
          }
    );
  }, [appliedNewestFirst]);
  // The list above stops short of the oldest version, so the panel says why.
  const rollbackListCapped = appliedNewestFirst.length > MAX_ROLLBACK_VERSIONS;

  // The picked "Roll back to" version. Until someone picks one, or when the
  // pick is no longer offered, it is the version below the newest, so the
  // default undoes as little as possible: one version.
  const rollbackPick =
    rollbackChoice !== null && rollbackOptions.some((option) => option.value === rollbackChoice)
      ? rollbackChoice
      : appliedNewestFirst[1] ?? BEFORE_FIRST;
  // The version the family goes back to, or null for "before the first".
  const rollbackTarget = rollbackPick === BEFORE_FIRST ? null : rollbackPick;

  // What the rollback would do: each version above the pick, newest first,
  // with the rollback that undoes it. planRollback picks each one with the
  // revert route's own rule (resolveRollback), so this preview is the SQL
  // the server will run.
  const rollbackSteps = useMemo(
    () => planRollback(preflightResult?.timeline ?? [], familyRegistry, rollbackTarget),
    [preflightResult, familyRegistry, rollbackTarget]
  );

  // One string for "this exact plan": the target, the family, and every step
  // with the SQL that undoes it. The ticks, a dry run's result and the
  // server's list of other scripts each belong to one plan.
  const rollbackKey = useMemo(
    () =>
      [
        connectionId,
        schema,
        scriptGroup,
        ...rollbackSteps.map((step) =>
          "sql" in step.resolved
            ? `${step.version}:${step.resolved.sql}`
            : `${step.version}:${step.resolved.problem}`
        ),
      ].join("|"),
    [connectionId, schema, scriptGroup, rollbackSteps]
  );

  // Versions in the plan that cannot be undone from here, and why.
  const rollbackProblems = useMemo(
    () =>
      rollbackSteps
        .filter((step) => "problem" in step.resolved)
        .map((step) => ({
          version: step.version,
          ...rollbackProblemText(step, pullWarnings.length === 0),
        })),
    [rollbackSteps, pullWarnings]
  );
  const rollbackReady = rollbackSteps.length > 0 && rollbackProblems.length === 0;

  // Rollback statements that destroy rows, named per version. A rollback
  // restores structure; the rows these statements remove do not come back.
  const rollbackDataLoss = useMemo(
    () =>
      rollbackSteps.flatMap((step) => {
        if (!("sql" in step.resolved)) return [];
        const kinds = [...new Set(findRowDestroyingStatements(step.resolved.sql))];
        return kinds.length > 0 ? [{ version: step.version, kinds }] : [];
      }),
    [rollbackSteps]
  );

  // Other families' versions applied after the oldest version this plan
  // undoes: a rollback can remove something they use, and a DROP ... CASCADE
  // takes their objects with it. Once a dry run or a refusal has sent the
  // server's own list for this plan, that list is the answer. Until then the
  // pre-flight's list is narrowed by time, which errs towards listing too
  // many: a version deployed in the same moment is kept.
  const rollbackOthers = useMemo<OtherScriptEntry[]>(() => {
    if (rollbackOtherScripts && rollbackOtherScripts.key === rollbackKey) {
      return rollbackOtherScripts.list;
    }
    const oldest = rollbackSteps[rollbackSteps.length - 1];
    if (!oldest) return [];
    const from = oldest.appliedAt ? new Date(oldest.appliedAt).getTime() : Number.NaN;
    return (preflightResult?.otherScripts ?? []).filter((other) => {
      if (Number.isNaN(from) || !other.applied_at) return true;
      return new Date(other.applied_at).getTime() >= from;
    });
  }, [rollbackOtherScripts, rollbackKey, rollbackSteps, preflightResult]);

  // Every approval row for this exact rollback, newest first. The action is
  // checked as well as the fingerprint: only the revert route spends a
  // "revert" row, so a deploy's approval can never clear a rollback.
  const rollbackApprovals = useMemo(
    () =>
      rollbackHash
        ? approvals.filter((a) => a.action === "revert" && a.run_fingerprint === rollbackHash)
        : [],
    [approvals, rollbackHash]
  );
  const approvedRollback = rollbackApprovals.find((a) => a.status === "approved") ?? null;
  const pendingRollback = rollbackApprovals.find((a) => a.status === "pending") ?? null;
  const latestRollback = rollbackApprovals[0] ?? null;

  // What stops both rollback buttons. The server asks for the production tick
  // on a dry run too, because a dry run runs every statement against the
  // real target before undoing them.
  const rollbackBlocked =
    !rollbackReady ||
    rollbackBusy !== null ||
    isDeploying ||
    (targetIsProduction && !rollbackProdAck) ||
    (rollbackDataLoss.length > 0 && !rollbackDataLossAck);
  // What additionally stops the real rollback. The server checks the other
  // scripts and the approval only on a real run, so the page does the same.
  const rollbackRunBlocked =
    rollbackBlocked ||
    (rollbackOthers.length > 0 && !rollbackOtherAck) ||
    (targetIsProduction && !approvedRollback);
  // The line under the buttons: the first reason they are disabled, or what
  // pressing will do. Same order as the checks above.
  const rollbackHint = !rollbackReady
    ? "Every version above needs a rollback that can run before anything runs"
    : isDeploying
      ? "A deploy is running on this target — wait for it to finish"
      : (targetIsProduction && !rollbackProdAck) ||
          (rollbackDataLoss.length > 0 && !rollbackDataLossAck)
        ? "Tick every box above to enable this"
        : rollbackOthers.length > 0 && !rollbackOtherAck
          ? "Tick the box about the other scripts to roll back — a dry run does not need it"
          : targetIsProduction && !approvedRollback
            ? "Rolling back needs a second person's approval — a dry run does not"
            : "The rollback runs in one transaction — every version above or none";
  // The last refusal is shown only with the plan it refused; a sticky one
  // (see rollbackError) is shown whatever the plan.
  const rollbackErrorShown =
    rollbackError && (rollbackError.sticky || rollbackError.key === rollbackKey)
      ? rollbackError.message
      : null;
  const rollbackPlannerShown = rollbackOpen && appliedNewestFirst.length > 0;
  // The oldest version the plan undoes. "Applied since" is measured from it.
  const rollbackOldest =
    rollbackSteps.length > 0 ? rollbackSteps[rollbackSteps.length - 1].version : null;
  // This family's rollbacks on the target, newest first.
  const revertedHistory = preflightResult?.reverted ?? [];

  // ── Version timeline ─────────────────────────────────────────────────────
  // The registry's versions of this family (left) against the target's
  // ledger rows (right), one row per version, newest first (mergeTimelines).
  // A registry file's dot is read from its SQL the way the pending list and
  // the run read it (describeChangeType); a ledger row's dot is the
  // change_type it stored when it ran. The right-hand status is the version
  // ledger's Applied / Pending / Skipped, so the timeline, the pending list
  // and the up-to-date card never disagree about a version.
  const timeline = useMemo(() => {
    const left: TimelineEntry[] = familyRegistry.map((s) => ({
      scriptName: scriptGroup,
      version: s.version,
      appliedAt: null,
      changeType: describeChangeType(s.sql_content).recorded,
      sqlContent: s.sql_content,
    }));
    const right: TimelineEntry[] = (preflightResult?.timeline ?? []).map((row) => ({
      scriptName: scriptGroup,
      version: row.version,
      appliedAt: row.applied_at,
      changeType: normalizeChangeLevel(row.change_type),
      sqlContent: row.sql_content ?? null,
      // Deploy stores the family's name as the title, which says nothing
      // beside the family's own heading. Any other title is shown.
      label: row.title && row.title !== scriptGroup ? row.title : null,
    }));
    const reverted = preflightResult?.reverted ?? [];
    const rows = mergeTimelines(left, right).map((row) => {
      const entry = versionLedger.find((e) => timelineKey(e.version) === row.key);
      if (!entry) return row;
      // A version that is not applied now but was rolled back says when. The
      // history is newest first, so this is its latest rollback. Matched on
      // the family and on versionKey, so "v1.2" there finds "1.2.0" here.
      const rolledBack =
        entry.status === "applied"
          ? null
          : reverted.find(
              (r) => r.script_name === scriptGroup && versionKey(r.version) === versionKey(entry.version)
            ) ?? null;
      return { ...row, rightStatus: ledgerStatus(entry, rolledBack, currentLabel, pullWarnings.length > 0) };
    });
    // "(Outdated)" goes on the side that is behind, by the version detector's
    // rule (each side's newest version): the database when the registry has a
    // newer version (so something is pending), the registry when the
    // database's newest version is above every file the registry has.
    return { rows, outdatedSide: outdatedSideOfEntries(left, right) };
  }, [familyRegistry, preflightResult, scriptGroup, versionLedger, currentLabel, pullWarnings]);

  // Every version the Roll back card offers to go back to ("Before the first
  // version" has no row of its own). Each one's row gets "Roll back to here…",
  // which only picks it in that card: nothing runs from the timeline.
  const revertableVersions = rollbackOptions
    .filter((option) => option.value !== BEFORE_FIRST)
    .map((option) => option.value);

  // A new target or family starts the panel over: nothing picked, and no
  // result from another family's rollback left on screen.
  useEffect(() => {
    setRollbackChoice(null);
    setRollbackOpen(false);
    setRollbackError(null);
    setRollbackDryRun(null);
    setRollbackDone(null);
    setRollbackOtherScripts(null);
    setRollbackApprovalNote("");
  }, [connectionId, schema, scriptGroup]);

  // The ticks and the approval error belong to one exact plan. The rollback
  // error carries its own plan instead (see rollbackError), because some have
  // to stay on screen after the plan changes: an outcome nobody knows, and a
  // refusal caused by an out-of-date list of applied versions (the page reads
  // the ledger again, which changes the plan).
  useEffect(() => {
    setRollbackProdAck(false);
    setRollbackDataLossAck(false);
    setRollbackOtherAck(false);
    setRollbackApprovalError(null);
  }, [rollbackKey]);

  // The fingerprint of the rollback on screen, hashed the way the server
  // hashes it (rollbackFingerprintBody over the steps, newest first, each
  // version spelled as the ledger spells it), so the approval panel can tell
  // whether an approval covers exactly this rollback. Production only, and
  // only when every step has SQL: an approval covers the SQL that runs.
  useEffect(() => {
    // Cleared first, so the previous plan's hash never matches for a moment.
    setRollbackHash(null);
    setRollbackHashError(null);
    if (!targetIsProduction || !rollbackReady) return;
    const body = rollbackFingerprintBody(
      rollbackSteps.map((step) => ({
        scriptName: scriptGroup.trim(),
        version: step.version,
        sqlContent: "sql" in step.resolved ? step.resolved.sql : "",
      }))
    );
    let cancelled = false;
    sha256Hex(body)
      .then((hex) => {
        if (!cancelled) setRollbackHash(hex);
      })
      .catch(() => {
        if (cancelled) return;
        setRollbackHashError(
          "This browser cannot check the approval — crypto.subtle needs " +
            "https or localhost. Open the app over https to approve a rollback."
        );
      });
    return () => {
      cancelled = true;
    };
  }, [targetIsProduction, rollbackReady, rollbackSteps, scriptGroup]);

  // An acknowledgement is for one exact batch against one exact target. Change
  // any part of what would run and it has to be given again — otherwise a tick
  // meant for two patch migrations on dev could carry over to a breaking one on
  // production. targetVersion is in here because it decides how far the run
  // goes, not just where.
  useEffect(() => {
    setDeployAcknowledged(false);
    setBreakingAcknowledged(false);
    setDataLossAcknowledged(false);
    setDriftAcknowledged(false);
  }, [connectionId, schema, scriptGroup, targetVersion]);

  // The schema's own label belongs to one (connection, schema) pair. Drop it the
  // moment that pair changes, so a prod schema's label can never linger over a
  // dev one picked next.
  useEffect(() => {
    setSchemaEnvironment(DEFAULT_ENVIRONMENT);
  }, [connectionId, schema]);

  // Default the target to the latest pending version once pre-flight returns.
  // Re-runs after a partial deploy keep a still-valid pick, else snap to latest.
  useEffect(() => {
    if (stage !== 1) return;
    if (pendingScripts.length === 0) {
      if (targetVersion) setTargetVersion("");
      return;
    }
    const versions = pendingScripts.map((s) => s.version);
    if (!targetVersion || !versions.includes(targetVersion)) {
      setTargetVersion(pendingScripts[pendingScripts.length - 1].version);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingScripts, stage]);

  // What the chosen batch risks, from one reading of its SQL. The same helper
  // (lib/deploy-risk) decides what the apply route refuses without a tick and
  // the breaking count an approver is shown, so every box this page asks for
  // is a box the server asks for too. Each migration is read with the
  // change_type runBatch sends with it, exactly as the server will read it.
  const runRisk = useMemo(
    () =>
      analyseRunRisk(
        scriptsUpToTarget.map((s) => ({
          scriptName: s.script_name,
          version: s.version,
          sqlContent: s.sql_content,
          changeType: changeTypeSent(s.sql_content),
        }))
      ),
    [scriptsUpToTarget]
  );
  // Summary stats for the chosen batch. A migration counts as breaking when
  // describeChangeType says so: stamped breaking, graded breaking with no
  // stamp, or holding a statement that is always breaking whatever the stamp.
  const breakingCount = runRisk.breaking.length;
  // Of those, the ones whose label says less than their SQL. The breaking
  // gate says why they are in it.
  const louderCount = runRisk.breaking.filter((entry) => entry.louderNote !== null).length;
  const linesOfSql = scriptsUpToTarget.reduce(
    (sum, s) => sum + getSqlLineCount(s.sql_content),
    0
  );
  const bumps = useMemo(() => {
    const order: Array<"major" | "minor" | "patch"> = ["major", "minor", "patch"];
    const present = new Set(
      scriptsUpToTarget.map((s) => bumpWord(describeChangeType(s.sql_content).recorded))
    );
    return order.filter((b) => present.has(b)).join(" + ") || "—";
  }, [scriptsUpToTarget]);
  const txnViolationScripts = scriptsUpToTarget.filter((s) => containsTransactionControl(s.sql_content));
  const hasTxnViolation = txnViolationScripts.length > 0;
  // Asked separately from the change type, because they are separate questions.
  // The change type answers "how far does the version move", and a TRUNCATE moves
  // it not at all — so a run that empties a table used to arrive here graded
  // "patch" with the checklist reporting that nothing in it was breaking.
  // The migrations that delete rows, each with the statements that do it.
  const dataLossScripts = runRisk.dataLoss;
  // Named rather than counted: "TRUNCATE, DELETE" tells the reader what to go
  // and look for, where "3 statements" tells them only that there are three.
  const dataLossKinds = useMemo(
    () => [...new Set(dataLossScripts.flatMap((entry) => entry.kinds))].join(", "),
    [dataLossScripts]
  );
  // The kinds in that list the breaking grade never sees. For these the
  // deletes-rows gate is the only warning on the page. Every DROP it names is
  // graded breaking as well, so "nothing else catches this" would be wrong there.
  const unflaggedDataLossKinds = useMemo(
    () =>
      [...new Set(dataLossScripts.flatMap((entry) => entry.kinds))].filter((kind) =>
        ROW_DESTROYING_NOT_BREAKING.includes(kind)
      ),
    [dataLossScripts]
  );

  // The third risk, and the only one of the three that is not about what
  // succeeding costs you. These statements are valid SQL that the rows already
  // in the table can refuse: a NOT NULL column with no default, a UNIQUE
  // constraint over duplicates. Nothing above catches them — they break no
  // contract and delete nothing — so a run that cannot possibly commit used to
  // arrive here with a clean checklist.
  //
  // Warned about, not gated. The run is one transaction, so a failure here
  // leaves the target exactly as it was; making the user tick a box to proceed
  // would spend a confirmation on the one outcome that costs nothing.
  const mightFailScripts = runRisk.mightFail;
  const mightFailKinds = useMemo(
    () => [...new Set(mightFailScripts.flatMap((entry) => entry.kinds))].join(", "),
    [mightFailScripts]
  );

  // The one thing in a run that is NOT all-or-nothing.
  //
  // PostgreSQL refuses to let a value added by ALTER TYPE … ADD VALUE be used
  // by another statement in the same transaction, so the apply route lifts
  // those statements out and runs them first, on their own, in autocommit. They
  // are therefore committed before the transaction that this page promises will
  // undo everything — six times over — has even opened, and PostgreSQL has no
  // statement that removes an enum value, so a failed run leaves them behind
  // for good. Small and usually harmless, but the page said the opposite of it.
  // runRisk reads them across the whole batch, the way the apply route hoists them.
  const enumAdditions = runRisk.enumAdditions;

  // ── What the approval covers ─────────────────────────────────────────────
  // Hash the batch the same way the server does, so this screen can say
  // "approved" only when the approved SQL is the SQL that would run. Recomputed
  // whenever the batch changes, which includes an edited migration arriving in
  // a fresh GitHub pull.
  useEffect(() => {
    if (scriptsUpToTarget.length === 0) {
      setRunHash(null);
      setHashError(null);
      return;
    }
    let cancelled = false;
    setHashError(null);
    sha256Hex(selectionBody)
      .then((hex) => {
        if (!cancelled) setRunHash(hex);
      })
      .catch(() => {
        if (cancelled) return;
        // crypto.subtle is missing outside a secure context. Say so instead of
        // silently reporting every run as unapproved, which would look like the
        // approval had gone missing.
        setRunHash(null);
        setHashError(
          "This browser cannot check the approval — crypto.subtle needs " +
            "https or localhost. Open the app over https to approve a run."
        );
      });
    return () => {
      cancelled = true;
    };
    // The body, not the array: a re-read that finds the same scripts builds
    // a new array, and the hash of the same text is the same hash.
  }, [scriptsUpToTarget.length, selectionBody]);

  // Approvals are only read for a production target, because production is the
  // only place the server asks for one. Fetching them elsewhere would put a
  // panel on screen that gates nothing.
  useEffect(() => {
    if (!targetIsProduction || !connectionId || !schema || !scriptGroup) {
      setApprovals([]);
      setApprovalsReadError(null);
      return;
    }
    let cancelled = false;
    setApprovalsLoading(true);
    const url =
      `/api/deploy/approvals?connectionId=${encodeURIComponent(connectionId)}` +
      `&schemaName=${encodeURIComponent(schema)}` +
      `&scriptName=${encodeURIComponent(scriptGroup)}`;
    fetch(url, { cache: "no-store" })
      .then(async (res) => {
        const data = (await res.json()) as { approvals?: ApprovalRow[]; error?: string };
        if (cancelled) return;
        if (!res.ok || !data.approvals) {
          setApprovals([]);
          setApprovalsReadError(data.error ?? "Could not read the approvals for this target.");
          return;
        }
        setApprovals(data.approvals);
        setApprovalsReadError(null);
      })
      .catch(() => {
        if (cancelled) return;
        setApprovals([]);
        setApprovalsReadError("Network error reading the approvals for this target.");
      })
      .finally(() => {
        if (!cancelled) setApprovalsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [targetIsProduction, connectionId, schema, scriptGroup, approvalReloadKey]);

  // Every approval row for this exact batch, newest first (the API orders by
  // id DESC). Anything with a different fingerprint belongs to different SQL
  // and must not count towards this run.
  const runApprovals = useMemo(
    () =>
      runHash
        ? approvals.filter(
            // A row with no action predates rollback approvals, so it is a deploy.
            (a) => (a.action ?? "deploy") === "deploy" && a.run_fingerprint === runHash
          )
        : [],
    [approvals, runHash]
  );
  const approvedRun = runApprovals.find((a) => a.status === "approved") ?? null;
  const pendingRun = runApprovals.find((a) => a.status === "pending") ?? null;
  const latestRun = runApprovals[0] ?? null;
  // The newest approved, unspent deploy approval for this target that is not
  // for this selection: approved for another range, or for SQL that has
  // changed since. The approval panel names it, so "Needs a second person"
  // never sits beside an approval without saying why it does not count.
  const otherApproval = useMemo(
    () =>
      !approvedRun && runHash
        ? approvals.find(
            (a) =>
              (a.action ?? "deploy") === "deploy" &&
              a.status === "approved" &&
              a.run_fingerprint !== runHash
          ) ?? null
        : null,
    [approvals, approvedRun, runHash]
  );
  // The pending version that range ends at, as the registry spells it, so
  // "Select that range" can pick it. null when it is not pending any more (it
  // ran, or left the registry); the panel then says it cannot be selected.
  const otherApprovalVersion = otherApproval
    ? pendingScripts.find((s) => versionKey(s.version) === versionKey(otherApproval.target_version))
        ?.version ?? null
    : null;
  // What stops a run starting at all. Deploy and Dry run share it: a rehearsal
  // writes nothing but still executes every statement against the real target,
  // so the same preconditions apply to both.
  // A drift result that is not "in sync" means the target is not the database
  // these migrations were written against. That is a reason to stop and look,
  // not a reason to forbid the run outright — so it is a tick, like production.
  //
  // Which drift result the tick answers for, or null when none needs one. A
  // check that finished speaks for itself (it is also the new record). A check
  // that failed this time falls back to the last result on record: the apply
  // route holds a run to that same record and refuses without the tick when it
  // says drifted or unreachable, so the page asks for the tick too rather than
  // send a run the server will turn away.
  const driftGateStatus: "drifted" | "unreachable" | null =
    driftPhase === "ready" && driftResult !== null && driftResult.status !== "in_sync"
      ? driftResult.status
      : driftPhase === "error" &&
          (storedDriftStatus === "drifted" || storedDriftStatus === "unreachable")
        ? storedDriftStatus
        : null;
  // True when the tick is about the record because this check failed.
  const driftGateFromRecord = driftGateStatus !== null && driftPhase === "error";
  const driftBlocks = driftGateStatus !== null;
  // A drift check that is still running holds both runs back. Its result
  // replaces the record the apply route holds a run to, and until it lands
  // this page cannot show the tick that record may ask for, so a run sent now
  // could be refused over a warning the reader never saw.
  const driftChecking = driftPhase === "loading";
  // Every box the reader has to tick, in one place.
  //
  // It is one name rather than a repeated expression because it is read twice —
  // once to disable the buttons, once to write the line under them saying why
  // they are disabled — and those two lists had already drifted apart: the
  // data-loss box disabled the button while the line under it went on
  // announcing that all migrations run in one transaction, leaving the reader
  // with a dead button and no reason for it.
  const unacknowledgedGates =
    (targetIsProduction && !deployAcknowledged) ||
    (breakingCount > 0 && !breakingAcknowledged) ||
    (dataLossScripts.length > 0 && !dataLossAcknowledged) ||
    (driftBlocks && !driftAcknowledged);
  const runBlocked =
    scriptsUpToTarget.length === 0 ||
    hasTxnViolation ||
    isDeploying ||
    // A rollback in flight is changing the same ledger.
    rollbackBusy !== null ||
    driftChecking ||
    unacknowledgedGates;
  // What additionally stops a real deploy. A dry run is exempt because the
  // server exempts it: a rehearsal writes nothing, and charging a second person
  // for a rehearsal would make the careful path the expensive one.
  const deployBlocked = runBlocked || (targetIsProduction && !approvedRun);

  // ── The selection, by name ───────────────────────────────────────────────
  // Deploy and Dry run start scriptsUpToTarget: the range the last "Run …"
  // button picked. Every label that names it is built here from that list,
  // so the buttons, "Deploy to", the summary and the approval panel all read
  // the same range: "Deploy v5.0.1 → v5.0.2 (2)", "Dry run v5.0.1 → v5.0.2".
  const selectionVersions = scriptsUpToTarget.map((s) => s.version);
  const selectionCount = selectionVersions.length;
  const selectionRange = versionRange(selectionVersions);
  const deployLabel =
    selectionCount === 0
      ? "Deploy"
      : `Deploy ${selectionRange}${selectionCount > 1 ? ` (${selectionCount})` : ""}` +
        (targetIsProduction ? " to production" : "");
  const dryRunLabel = selectionCount === 0 ? "Dry run" : `Dry run ${selectionRange}`;
  // The version the selection ends at, for "Deploy to" and the summary.
  const selectionLastLabel =
    selectionCount > 0 ? vLabel(selectionVersions[selectionCount - 1]) : "—";

  // The run on screen (the Run stage) against the selection. "Deploy for
  // real" after a clean rehearsal and "Run again" after a failed run both
  // start the selection, not the batch on screen, so each is offered only
  // while the two are the same; otherwise its card says what changed.
  const runVersions = runScripts.map((s) => s.version);
  const runRange = versionRange(runVersions);
  const runLastVersion = runVersions.length > 0 ? runVersions[runVersions.length - 1] : "";
  const rehearsalChange = selectionChange(rehearsedBody, runScripts, scriptsUpToTarget, selectionBody);
  const repeatChange = selectionChange(runBody, runScripts, scriptsUpToTarget, selectionBody);
  const [ranName, nowName] = nameTwoRuns(runVersions, selectionVersions);
  // Pre-flight boxes still to tick for the selection, said on the Run stage
  // too, whose buttons they hold back. (While the drift check runs, those
  // buttons say so themselves.)
  const untickedOnPreflight = unacknowledgedGates && !driftChecking;
  // The pending rows in the selection, marked in the list by the script
  // itself rather than by comparing versions, so the list cannot mark a row
  // the run would leave out.
  const inRunKeys = new Set(scriptsUpToTarget.map((s) => scriptKey(s)));

  // ── Data loaders ─────────────────────────────────────────────────────────
  async function handlePull() {
    setPullLoading(true);
    setPullError(null);
    setPullWarnings([]);
    try {
      const res = await fetch("/api/github/pull");
      const data = (await res.json()) as {
        scripts?: GitHubScript[];
        warnings?: unknown;
        error?: string;
      };
      if (!res.ok || !data.scripts) {
        setPullError(data.error ?? "Could not fetch scripts from GitHub.");
      } else {
        setGithubScripts(data.scripts);
        // The parts of the registry the pull could not read. Only strings are
        // kept, because they go on screen as written.
        setPullWarnings(
          Array.isArray(data.warnings)
            ? data.warnings.filter((warning): warning is string => typeof warning === "string")
            : []
        );
      }
    } catch {
      setPullError("Network error fetching scripts from GitHub.");
    } finally {
      setPullLoading(false);
    }
  }

  async function fetchSchemas(id: string) {
    setSchemasLoading(true);
    setSchemasError(null);
    setSchemas([]);
    try {
      const res = await fetch(`/api/scripts/schemas?connectionId=${id}`);
      const data = (await res.json()) as { schemas?: string[]; error?: string };
      if (!res.ok || !data.schemas) {
        setSchemasError(data.error ?? "Could not load schemas from this connection.");
      } else {
        setSchemas(data.schemas);
      }
    } catch {
      setSchemasError("Network error loading schemas.");
    } finally {
      setSchemasLoading(false);
    }
  }

  // Bare pre-flight call — also used to refresh the ledger after a run.
  // Resolves true when the ledger was read, so a caller can say whether the
  // page now shows the target as it is.
  async function runPreflightCheck(id: string, sch: string, group: string): Promise<boolean> {
    setPreflightLoading(true);
    setPreflightError(null);
    try {
      const res = await fetch("/api/scripts/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId: Number(id),
          schemaName: sch || "public",
          scriptName: group || undefined,
        }),
      });
      const data = (await res.json()) as PreflightResult & { error?: string };
      if (!res.ok) {
        setPreflightError(data.error ?? "Pre-flight check failed.");
        setPreflightResult(null);
        return false;
      }
      setPreflightResult(data);
      return true;
    } catch {
      setPreflightError("Network error during pre-flight check.");
      setPreflightResult(null);
      return false;
    } finally {
      setPreflightLoading(false);
    }
  }

  // ── Roll back to ─────────────────────────────────────────────────────────
  // Run, or rehearse, the rollback on screen. The server reads the ledger
  // again inside its own transaction and picks each rollback with the same
  // rule as the preview (resolveRollback). A registry rollback is sent only
  // for a step that uses one, because that is the only case the server reads.
  async function handleRollback(dryRun: boolean) {
    if (writeInFlight.current) return;
    writeInFlight.current = true;
    try {
      await runRollback(dryRun);
    } finally {
      writeInFlight.current = false;
    }
  }

  async function runRollback(dryRun: boolean) {
    if (!connectionId || !schema || !scriptGroup) return;
    // The disabled buttons already say this, but a disabled button is a hint,
    // not a rule — this is the rule.
    if (dryRun ? rollbackBlocked : rollbackRunBlocked) return;
    // Captured now: the plan changes once the ledger is read again below.
    const key = rollbackKey;
    const steps = rollbackSteps;
    const doneLabel = rollbackTarget
      ? `Rolled back to ${vLabel(rollbackTarget)}`
      : "Rolled back every version";
    // A refusal belongs to the plan it refused. An outcome nobody knows, and
    // a refusal caused by an out-of-date ledger, are sticky: they stay after
    // the ledger is read again and the plan changes.
    const fail = (message: string, sticky = false) =>
      setRollbackError({ key, message, sticky });

    setRollbackBusy(dryRun ? "dry" : "real");
    setRollbackError(null);
    setRollbackDone(null);
    try {
      const res = await fetch("/api/scripts/revert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId: Number(connectionId),
          schemaName: schema,
          script_name: scriptGroup,
          // Newest first, spelled as the ledger spells them: the order the
          // server runs them in, and the spelling its approval check hashes.
          versions: steps.map((step) => step.version),
          registryRollbacks: steps.flatMap((step) =>
            "sql" in step.resolved && step.resolved.source === "registry"
              ? [{ version: step.version, down_sql: step.resolved.sql }]
              : []
          ),
          dryRun,
          acknowledgeProduction: rollbackProdAck,
          acknowledgeOtherScripts: rollbackOtherAck,
          // The revert route reads the same rows-deleting statements from the
          // same rollback SQL, and refuses without this tick, dry runs included.
          acknowledgeDataLoss: rollbackDataLossAck,
        }),
      });
      // Read as text first: an error page from a proxy is not JSON, and
      // "Unexpected token <" says nothing about the state of the database.
      const text = await res.text();
      let data: RevertResponse = {};
      try {
        data = JSON.parse(text) as RevertResponse;
      } catch {
        data = {};
      }

      // The server's own list of other scripts replaces the page's estimate
      // for this plan, whether it came with a dry run or with a refusal.
      if (Array.isArray(data.otherScripts)) {
        setRollbackOtherScripts({ key, list: data.otherScripts });
      }

      if (data.success !== true) {
        if (typeof data.error !== "string") {
          // No answer this page can read. A dry run always ends in ROLLBACK,
          // so it changed nothing; a real run may have committed.
          if (dryRun) {
            fail(
              `The server's answer to the dry run could not be read (HTTP ${res.status}). ` +
                "A dry run changes nothing, so it is safe to try again."
            );
            return;
          }
          fail(
            `The server's answer could not be read (HTTP ${res.status}), so this page ` +
              "cannot say whether the rollback ran. The ledger is being read again: " +
              "check it before you try again.",
            true
          );
          showToast("Rollback outcome unknown — check the ledger", "bad");
          await refreshAfterRollback();
          return;
        }
        // From this page, "not applied" and "not newest" mean its copy of the
        // ledger is out of date: it always sends the newest versions of the
        // ledger it read, so someone deployed or rolled back since then.
        const staleLedger = data.code === "not_applied" || data.code === "not_newest";
        const refusal = data.error;
        // The route's sentence says what happened and what to do next.
        fail(refusal, data.outcomeUnknown === true || staleLedger);
        if (data.outcomeUnknown) {
          showToast("Rollback outcome unknown — check the ledger", "bad");
          await refreshAfterRollback();
        } else if (data.needsApproval) {
          setApprovalReloadKey((reload) => reload + 1);
        } else if (staleLedger) {
          // Check the database again, as the route asks, so the picker and
          // the plan show what is applied now, and say whether that worked.
          const read = await refreshAfterRollback();
          fail(
            read
              ? `${refusal} This page has checked the database again and now shows what is ` +
                  "applied, so read the rollback plan again before you run it."
              : `${refusal} This page could not check the database again. Press Check ` +
                  "database on Pre-flight before you run anything.",
            true
          );
        }
        return;
      }

      if (dryRun) {
        setRollbackDryRun({ key, message: data.message ?? "Dry run passed. Nothing changed." });
        showToast("Dry run passed — nothing changed");
        return;
      }

      setRollbackDone({ message: data.message ?? `${doneLabel}.` });
      showToast(doneLabel);
      // The next plan starts from the smallest rollback again, closed, so a
      // second rollback is always a new decision. The run panel still
      // describes the deploy that put these versions on the target, so clear
      // it too — leaving it up would contradict the ledger.
      setRollbackChoice(null);
      setRollbackOpen(false);
      resetRun();
      setStage(1);
      await refreshAfterRollback();
    } catch {
      // The request never came back, so a real rollback may or may not have run.
      if (dryRun) {
        fail(
          "Network error while running the dry run. A dry run changes nothing, so it is " +
            "safe to try again."
        );
      } else {
        fail(
          "Network error while running the rollback, so this page cannot say whether it " +
            "ran. Press Check database and read the ledger before you try again.",
          true
        );
      }
    } finally {
      setRollbackBusy(null);
    }
  }

  // After a rollback, one whose outcome is unknown, or a refusal caused by an
  // out-of-date ledger: read the ledger and the live schema again, so the
  // page shows the target as it now is, and read the approvals again (a
  // production rollback spends one). Resolves true when the ledger was read.
  async function refreshAfterRollback(): Promise<boolean> {
    setApprovalReloadKey((reload) => reload + 1);
    const read = await runPreflightCheck(connectionId, schema, scriptGroup);
    void runDriftCheck(connectionId, schema);
    return read;
  }

  // ── Approvals ────────────────────────────────────────────────────────────
  // Ask for a second person's sign-off on exactly the batch on screen. The
  // server hashes the SQL again from this request body rather than trusting a
  // fingerprint the browser sends, so a tampered request cannot approve one set
  // of migrations and run another.
  async function handleRequestApproval() {
    if (!connectionId || !schema || !scriptGroup || !targetVersion) return;
    if (scriptsUpToTarget.length === 0 || approvalBusy) return;

    setApprovalBusy(true);
    setApprovalError(null);
    try {
      const res = await fetch("/api/deploy/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "deploy",
          connectionId: Number(connectionId),
          schemaName: schema || "public",
          scriptName: scriptGroup,
          targetVersion,
          note: approvalNote.trim() || undefined,
          // No count is sent: the server counts the breaking migrations from
          // this SQL, read with the same change_type the run will send.
          scripts: scriptsUpToTarget.map((script) => ({
            script_name: script.script_name,
            version: script.version,
            sql_content: script.sql_content,
            change_type: changeTypeSent(script.sql_content),
          })),
        }),
      });
      const data = (await res.json()) as { approval?: ApprovalRow; error?: string };
      if (!res.ok || !data.approval) {
        setApprovalError(data.error ?? "Could not record the approval request.");
        return;
      }
      setApprovalNote("");
      showToast("Approval requested — someone else has to clear it");
    } catch {
      setApprovalError("Network error requesting the approval.");
    } finally {
      setApprovalBusy(false);
      setApprovalReloadKey((key) => key + 1);
    }
  }

  // The same for the rollback on screen. `scripts` holds the rollback SQL
  // that will run, newest first, exactly as the revert route claims it, so
  // the fingerprint the server stores is the one it will look for.
  async function handleRequestRollbackApproval() {
    if (!connectionId || !schema || !scriptGroup || !rollbackReady || approvalBusy) return;

    setApprovalBusy(true);
    setRollbackApprovalError(null);
    try {
      const res = await fetch("/api/deploy/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "revert",
          connectionId: Number(connectionId),
          schemaName: schema,
          scriptName: scriptGroup,
          // The oldest version this rollback undoes. "Before the first
          // version" has no version to go back to, so every rollback approval
          // is labelled by the last version it takes off.
          targetVersion: rollbackSteps[rollbackSteps.length - 1].version,
          // No count is sent. For a rollback the risk the approver weighs is
          // lost rows, and the server counts the rollbacks below that delete them.
          note: rollbackApprovalNote.trim() || undefined,
          scripts: rollbackSteps.map((step) => ({
            script_name: scriptGroup,
            version: step.version,
            sql_content: "sql" in step.resolved ? step.resolved.sql : "",
          })),
        }),
      });
      const data = (await res.json()) as { approval?: ApprovalRow; error?: string };
      if (!res.ok || !data.approval) {
        setRollbackApprovalError(data.error ?? "Could not record the approval request.");
        return;
      }
      setRollbackApprovalNote("");
      showToast("Approval requested — someone else has to clear it");
    } catch {
      setRollbackApprovalError("Network error requesting the approval.");
    } finally {
      setApprovalBusy(false);
      setApprovalReloadKey((key) => key + 1);
    }
  }

  // The second person's half. A 409 here means someone decided it first; their
  // decision stands, and the reload below puts it on screen. `action` says
  // which panel asked, so its note is sent and any error lands in it.
  async function handleDecideApproval(
    id: number,
    decision: "approve" | "reject",
    action: "deploy" | "revert"
  ) {
    if (approvalBusy) return;
    const note = action === "revert" ? rollbackApprovalNote : approvalNote;
    const setError = action === "revert" ? setRollbackApprovalError : setApprovalError;
    const setNote = action === "revert" ? setRollbackApprovalNote : setApprovalNote;
    setApprovalBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/deploy/approvals/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, note: note.trim() || undefined }),
      });
      const data = (await res.json()) as { approval?: ApprovalRow; error?: string };
      if (!res.ok || !data.approval) {
        setError(data.error ?? "Could not record the decision.");
        return;
      }
      setNote("");
      const what = action === "revert" ? "Rollback" : "Run";
      showToast(
        decision === "approve" ? `${what} approved` : `${what} rejected`,
        decision === "approve" ? "ok" : "bad"
      );
    } catch {
      setError("Network error recording the decision.");
    } finally {
      setApprovalBusy(false);
      setApprovalReloadKey((key) => key + 1);
    }
  }

  function resetDrift() {
    setDriftPhase("idle");
    setDriftResult(null);
    setDriftError(null);
    setStoredDriftStatus(null);
    setEnvironmentUnknown(false);
    // An acknowledgement belongs to one drift result. Dropping it here means a
    // fresh check always has to be read again, rather than inheriting a tick
    // given for a report that no longer exists.
    setDriftAcknowledged(false);
  }

  // Phase 6 drift pre-check. If the chosen target (connection + schema) is
  // tracked, compare its live structure against its expected snapshot via the
  // real lineage APIs. When it isn't tracked we say so honestly — never a fake
  // diff. The drift POST also records a drift_events row, which feeds the audit
  // log. Used both as a stage-1 pre-check and a stage-3 post-deploy verify.
  async function runDriftCheck(id: string, sch: string) {
    if (!id || !sch) {
      resetDrift();
      return;
    }
    setDriftPhase("loading");
    setDriftError(null);
    setDriftResult(null);
    setStoredDriftStatus(null);
    setDriftAcknowledged(false);
    setEnvironmentUnknown(false);
    try {
      const lookupRes = await fetch(
        `/api/lineage/lookup?connectionId=${encodeURIComponent(id)}&schemaName=${encodeURIComponent(sch)}`,
        { cache: "no-store" }
      );
      // A failed lookup must not read as "not tracked" — that answer skips the
      // drift pre-check and leaves the environment label unset, so a dead
      // metadata database would quietly remove both warnings.
      if (!lookupRes.ok) {
        setDriftPhase("error");
        setEnvironmentUnknown(true);
        return;
      }
      const lookup = (await lookupRes.json()) as {
        tracked?: boolean;
        trackedSchemaId?: number;
        environment?: string;
        /** The last drift result on record, which the apply route holds a run to. */
        driftStatus?: DriftResult["status"] | null;
      };
      // Worth keeping even when the drift check itself can't run: the warning
      // above the Deploy button needs this, and an untracked schema simply has
      // no label of its own to add.
      setSchemaEnvironment(toEnvironment(lookup.environment));
      // Kept for the same reason: if the drift check below fails, this record
      // is what the apply route will hold the run to.
      setStoredDriftStatus(lookup.driftStatus ?? null);
      if (!lookup.tracked || !lookup.trackedSchemaId) {
        setDriftPhase("untracked");
        return;
      }
      const driftRes = await fetch("/api/lineage/drift", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackedSchemaId: lookup.trackedSchemaId }),
      });
      const data = (await driftRes.json()) as DriftResult & { error?: string };
      if (!driftRes.ok || !data.status) {
        setDriftError(data.error ?? "Drift check failed.");
        setDriftPhase("error");
        return;
      }
      setDriftResult(data);
      setDriftPhase("ready");
    } catch {
      setDriftError("Network error during the drift check.");
      setDriftPhase("error");
    }
  }

  // "Check database" button — resets the run and re-reads the ledger.
  async function handlePreflight() {
    if (!connectionId || !schema || !scriptGroup) return;
    resetRun();
    // A fresh read of the target: results and the server's list of other
    // scripts from before it may no longer be true.
    setRollbackError(null);
    setRollbackDryRun(null);
    setRollbackDone(null);
    setRollbackOtherScripts(null);
    setStage(1);
    setPreflightResult(null);
    setTargetVersion("");
    await runPreflightCheck(connectionId, schema, scriptGroup);
    void runDriftCheck(connectionId, schema);
  }

  function resetRun() {
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setIsDeploying(false);
    setRunScripts([]);
    setRunStatus({});
    setRunComplete(false);
    setRunError(null);
    setRunRefused(false);
    setRunIsDryRun(false);
    setRehearsedBody(null);
    setElapsedMs(0);
  }

  // ── Picking the run ──────────────────────────────────────────────────────
  // The pending list's "Run …" buttons select rather than run: the run
  // becomes every pending version up to that row (pendingPrefixThrough), the
  // rows outside it read "not in this run", and focus moves on to what is
  // left to do. Nothing runs until Deploy or Dry run is pressed.
  function selectRun(version: string) {
    if (version !== targetVersion) {
      // The acknowledgement effect's rule: a tick is for one batch. Cleared
      // here too, in the same render as the new selection, so the focus below
      // finds these boxes already unticked instead of racing the effect.
      setDeployAcknowledged(false);
      setBreakingAcknowledged(false);
      setDataLossAcknowledged(false);
      setDriftAcknowledged(false);
    }
    setTargetVersion(version);
    // After React has drawn the new selection's gates.
    window.requestAnimationFrame(focusNextStep);
  }

  // The run panel's first box still to tick, else its Deploy button when it
  // can be pressed, else the panel itself.
  function focusNextStep() {
    const panel = runPanelRef.current;
    if (!panel) return;
    const box = panel.querySelector<HTMLInputElement>(
      'input[type="checkbox"]:not(:checked):not(:disabled)'
    );
    const button = deployButtonRef.current;
    const target: HTMLElement = box ?? (button && !button.disabled ? button : panel);
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.focus({ preventScroll: true });
  }

  // "Roll back to here…" in the version timeline: pick that version in the
  // Roll back card and open its planner. The card then works as it always
  // does (preview, ticks, approval); nothing runs from the timeline.
  function rollBackTo(row: TimelineRow) {
    const option = rollbackOptions.find(
      (candidate) => candidate.value !== BEFORE_FIRST && timelineKey(candidate.value) === row.key
    );
    if (!option) return;
    setRollbackChoice(option.value);
    setRollbackOpen(true);
    window.requestAnimationFrame(() => {
      const card = rollbackCardRef.current;
      if (!card) return;
      card.scrollIntoView({ behavior: "smooth", block: "start" });
      card.focus({ preventScroll: true });
    });
  }

  // ── The deploy run ───────────────────────────────────────────────────────
  // One call to /api/scripts/apply carrying the whole batch. The server runs
  // every migration inside ONE transaction, so the run is all-or-nothing: there
  // is no state where some of these are applied and the rest are not, and there
  // is nothing to "stop" partway — by the time a failure is visible here, the
  // database has already put itself back.
  //
  // `dryRun` rehearses instead: the SQL really executes against the target and
  // the transaction ends in ROLLBACK. Later scripts see the earlier ones' work,
  // which is why the rehearsal has to be one request too.
  async function handleRun(dryRun: boolean) {
    if (writeInFlight.current) return;
    writeInFlight.current = true;
    try {
      await runBatch(dryRun);
    } finally {
      writeInFlight.current = false;
    }
  }

  async function runBatch(dryRun: boolean) {
    const batch = scriptsUpToTarget;
    // The disabled buttons say all of this already, but a disabled button is a
    // hint, not a rule — this is the rule. A rehearsal is held to everything
    // except the approval, exactly as the apply route holds it.
    if (dryRun ? runBlocked : deployBlocked) return;
    // This run replaces the one on screen, and with it any rehearsal pin.
    setRehearsedBody(null);

    // A deploy changes the ledger the rollback panel read, so its last result
    // no longer describes the target.
    setRollbackError(null);
    setRollbackDryRun(null);
    setRollbackDone(null);
    setRollbackOtherScripts(null);
    setRunScripts(batch);
    // The ledger is re-read before Verify shows, so the live current version is
    // already the new one — the arrow has to remember where the run started.
    setRunFromVersion(currentLabel);
    setRunIsDryRun(dryRun);
    setRunError(null);
    setRunRefused(false);
    // Every migration goes to "running" at once because they really do run
    // together. Ticking them off one at a time would be a story about a loop
    // that no longer exists.
    setRunStatus(
      Object.fromEntries(batch.map((s) => [scriptKey(s), { status: "running" } as RunCell]))
    );
    setRunComplete(false);
    setIsDeploying(true);
    setStage(2);

    runStartRef.current = performance.now();
    setElapsedMs(0);
    timerRef.current = window.setInterval(() => {
      setElapsedMs(performance.now() - runStartRef.current);
    }, 100);

    let outcomes: ApplyOutcome[] | null = null;
    let failure: string | null = null;
    // Whether this page cannot say how the run ended. Only three things leave
    // it not knowing: the request never completed, the answer could not be
    // read, or the server itself says its COMMIT did not report back. Any other
    // answer is the server's own account of what happened.
    let outcomeUnknown = false;
    // The server turned the run away (a 4xx): it applied none of it.
    let refused = false;

    try {
      const res = await fetch("/api/scripts/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId: Number(connectionId),
          schemaName: schema || "public",
          dryRun,
          acknowledgeProduction: deployAcknowledged,
          // The other three ticks. The route reads the same risks from the
          // same SQL (lib/deploy-risk) and refuses a run with a risk nobody
          // ticked, so each box on this page is also a rule on the server.
          acknowledgeBreaking: breakingAcknowledged,
          acknowledgeDataLoss: dataLossAcknowledged,
          acknowledgeDrift: driftAcknowledged,
          scripts: batch.map((script) => ({
            script_name: script.script_name,
            sql_content: script.sql_content,
            version: script.version,
            title: script.script_name,
            // The level this page showed and bumped by. The server stores it
            // only when it is louder than what the SQL says, never quieter.
            change_type: changeTypeSent(script.sql_content),
            // Link the applied row back to the GitHub file it came from.
            source_ref: script.path,
            // The registry's rollback, saved on the applied row so Deploy can
            // undo this version later even if the file changes or goes. The
            // pull sends it only when it can run (rollback_state "usable").
            ...(script.down_sql ? { down_sql: script.down_sql } : {}),
          })),
        }),
      });

      // Read the body as text and parse it separately. A proxy 502 or a Next.js
      // error page is HTML, and letting res.json() throw inside this try would
      // drop into the catch below and report "could not reach the server" about
      // a request that reached it — and, before the run became one transaction,
      // may well have committed something.
      const raw = await res.text();
      let data: ApplyResponse | null = null;
      try {
        data = JSON.parse(raw) as ApplyResponse;
      } catch {
        data = null;
      }

      if (data?.results) outcomes = data.results;
      if (!res.ok || !data?.success) {
        failure =
          data?.error ??
          `The apply API answered ${res.status} with a response this page could ` +
          `not read. Re-check the target before retrying.`;
      }
      outcomeUnknown = data === null || data.outcomeUnknown === true;
      // Every 4xx but one is the server turning the run away before any of its
      // SQL ran. The exception is 422: a dry run whose SQL did run, until
      // PostgreSQL refused to use a new enum value inside it. That is a
      // rehearsal that failed, so it keeps the "failed" wording.
      refused =
        !outcomeUnknown && res.status >= 400 && res.status < 500 && res.status !== 422;
    } catch {
      // A genuine transport failure: the request may or may not have reached the
      // server, so this must not claim nothing happened.
      // The route path is an implementation detail; the reader needs the button
      // that answers the question instead.
      failure =
        "The request to the server never completed, so this page cannot say " +
        "whether the migrations ran. Go back to Pre-flight and press Check " +
        "database to read what the target actually has before you retry.";
      outcomeUnknown = true;
    }

    // Map the server's verdict onto the rows.
    //
    // A row the server said nothing about is "not known" only when the whole
    // outcome is (outcomeUnknown above): then the server reporting nothing is
    // not the server reporting that nothing happened, because the request may
    // have run every migration. Any other answer says the run did not commit
    // (a refusal before anything ran lists no rows at all), so a row it leaves
    // out was skipped. One answer, because three surfaces need it: the rows,
    // the toast, and the recovery bar.
    const unreported: RunStatus = outcomeUnknown ? "unknown" : "skipped";
    // The server's answer for one script of this batch, if it gave one.
    const outcomeOf = (script: GitHubScript) =>
      outcomes?.find((o) => o.script_name === script.script_name && o.version === script.version);
    setRunStatus(() => {
      const next: Record<string, RunCell> = {};
      for (const script of batch) {
        const outcome = outcomeOf(script);
        next[scriptKey(script)] = outcome
          ? { status: outcome.status, error: outcome.error, statements: outcome.statements }
          : { status: unreported };
      }
      return next;
    });
    setRunError(failure);
    setRunRefused(refused);
    // A clean rehearsal pins what it rehearsed. "Clean" is the rehearsal
    // card's own rule (every script came back rehearsed), so the card and the
    // pin always appear together.
    if (dryRun && batch.length > 0 && batch.every((script) => outcomeOf(script)?.status === "rehearsed")) {
      setRehearsedBody(batchBody(batch));
    }

    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setElapsedMs(performance.now() - runStartRef.current);
    setIsDeploying(false);
    setRunComplete(true);

    // Always re-read the ledger so the current version reflects what is really
    // applied — a dry run should leave it exactly where it was, and this is what
    // proves that on screen rather than asserting it.
    await runPreflightCheck(connectionId, schema, scriptGroup);
    // Re-run the drift check so the Verify step reflects the post-deploy state.
    void runDriftCheck(connectionId, schema);
    // A real run spends its approval. Re-read them so the panel says so rather
    // than still offering a green light that the server would now refuse.
    setApprovalReloadKey((key) => key + 1);

    if (failure) {
      showToast(
        outcomeUnknown
          ? "Deploy outcome not known — check the target before retrying"
          : refused
            ? dryRun
              ? "Dry run refused — nothing was run"
              : "Deploy refused — nothing was applied"
            : dryRun
              ? "Dry run failed — nothing was written"
              : "Deploy failed — nothing was applied",
        "bad"
      );
    } else if (dryRun) {
      showToast(`Dry run clean · ${batch.length} migration${batch.length === 1 ? "" : "s"} rehearsed`);
    } else {
      setStage(3);
      // The batch's own last version: the selection can move after this.
      showToast(`Deploy complete · up to ${vLabel(batch[batch.length - 1].version)}`);
    }
  }

  // ── Stepper helpers ──────────────────────────────────────────────────────
  const appliedScripts = runScripts.filter(
    (s) => runStatus[scriptKey(s)]?.status === "applied"
  );
  // A clean run: every migration came back applied, or — for a rehearsal —
  // every one came back rehearsed. Only the first unlocks Verify, because only
  // the first left anything behind to verify.
  const allApplied =
    runScripts.length > 0 &&
    runScripts.every((s) => runStatus[scriptKey(s)]?.status === "applied");
  const allRehearsed =
    runScripts.length > 0 &&
    runScripts.every((s) => runStatus[scriptKey(s)]?.status === "rehearsed");
  const runProgress = runScripts.filter((s) => {
    const status = runStatus[scriptKey(s)]?.status;
    return status === "applied" || status === "rehearsed";
  }).length;
  // "0 of 3 applied" is itself a claim, and on an unknown outcome it is the
  // wrong one — it reads as "nothing happened", which is the half of the
  // possibilities the reader must not assume.
  const runOutcomeUnknown = runScripts.some(
    (s) => runStatus[scriptKey(s)]?.status === "unknown"
  );
  const totalStatements = runScripts.reduce(
    (sum, s) => sum + (runStatus[scriptKey(s)]?.statements ?? 0),
    0
  );

  function canGoStage(n: 1 | 2 | 3): boolean {
    if (isDeploying) return false;
    if (n === 1) return true;
    if (n === 2) return runScripts.length > 0;
    return allApplied; // verify only after a fully clean run
  }

  function stepClass(n: 1 | 2 | 3): string {
    if (n === stage) {
      if (n === 2 && isDeploying) return "step running";
      return "step active";
    }
    return n < stage ? "step done" : "step";
  }

  const STEPS: { n: 1 | 2 | 3; name: string; sub: string }[] = [
    { n: 1, name: "Pre-flight", sub: "checks · pending list" },
    { n: 2, name: "Run", sub: "one transaction · all or nothing" },
    { n: 3, name: "Verify", sub: "ledger re-read" },
  ];

  return (
    <div style={{ background: "var(--bg)", minHeight: "100%" }}>
      {/* ——— Page header ——— */}
      <section className="px-4 sm:px-8 pt-8 pb-2">
        <div className="section-title mb-2">Deploy</div>
        <h1 className="text-[28px] font-semibold tracking-[-0.018em]">
          Bring the database up to a version.
        </h1>
        <p className="text-[13.5px] mt-1.5 max-w-[64ch]" style={{ color: "var(--text-2)" }}>
          Pick a target connection, schema and script group, then rehearse or apply the
          pending migrations. The whole run goes in one transaction — all of them or none.
        </p>
        {pullError && (
          <div className="banner mt-3">
            <span className="ico">
              <AlertCircleIcon size={16} />
            </span>
            <span>{pullError}</span>
          </div>
        )}
        {/* The pull lists what it could and names what it could not, so a
            version missing below is never a silent gap. */}
        {pullWarnings.length > 0 && (
          <div className="help mt-3 max-w-[80ch]" style={{ color: "var(--drift)" }}>
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
              Everything below is built from what was read. Reload the page to read the
              registry again.
            </p>
          </div>
        )}
      </section>

      {/* ——— Stepper ——— */}
      <section className="px-4 sm:px-8 pt-6 pb-4">
        <div className="stepper">
          {STEPS.map((s, i) => (
            <Fragment key={s.n}>
              {i > 0 && (
                <div
                  className={`step-sep${stage > i ? " done" : stage === i ? " active" : ""}`}
                />
              )}
              <button
                type="button"
                className={stepClass(s.n)}
                disabled={!canGoStage(s.n)}
                onClick={() => canGoStage(s.n) && setStage(s.n)}
              >
                <div className="n">
                  {s.n === 2 && isDeploying ? <span className="spin" /> : s.n}
                </div>
                <div className="label">
                  <div className="name">{s.name}</div>
                  <div className="sub">{s.sub}</div>
                </div>
              </button>
            </Fragment>
          ))}
        </div>
      </section>

      {/* ═══════════════════ STAGE 1 — PRE-FLIGHT ═══════════════════ */}
      {stage === 1 && (
        <section className="px-4 sm:px-8 pb-12 space-y-6">
          {/* Selection */}
          <div className="card p-5">
            <div className="section-title mb-3">Target</div>
            <div className="grid gap-4 grid-cols-1 sm:grid-cols-3">
              <div>
                <label className="label" htmlFor="dep-conn">Connection</label>
                <Select
                  variant="input"
                  id="dep-conn"
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
                    setScriptGroup("");
                    setPreflightResult(null);
                    setPreflightError(null);
                    setTargetVersion("");
                    resetRun();
                    resetDrift();
                  }}
                />
                {connectionsLoaded && connections.length === 0 && (
                  <p className="help mt-1">
                    {connectionsFailed
                      ? "Could not read your saved connections. Reload the page to try again."
                      : "No connections saved yet. Add one on the Connections page first."}
                  </p>
                )}
                {activeConn && (
                  <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                    <EnvironmentPill environment={targetEnvironment} />
                    {targetEnvironment === "unset" && (
                      <span className="help">
                        Unlabelled — label it on Connections so this page can warn you.
                      </span>
                    )}
                    {environmentUnknown && (
                      <span className="help" style={{ color: "var(--drift)" }}>
                        {"This schema's own label could not be read, so the target " +
                          "may be production even though this reads " +
                          targetEnvironment +
                          ". Press Check database again before you run anything."}
                      </span>
                    )}
                  </div>
                )}
              </div>

              <div>
                <label className="label" htmlFor="dep-schema">Schema</label>
                <Select
                  variant="input"
                  id="dep-schema"
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
                    setScriptGroup("");
                    setPreflightResult(null);
                    setPreflightError(null);
                    setTargetVersion("");
                    resetRun();
                    resetDrift();
                  }}
                />
                {schemasError && <p className="help mt-1" style={{ color: "var(--break)" }}>{schemasError}</p>}
              </div>

              <div>
                <label className="label" htmlFor="dep-group">Script group</label>
                <Select
                  variant="input"
                  id="dep-group"
                  className="mt-1"
                  ariaLabel="Script group"
                  value={scriptGroup}
                  disabled={!schema}
                  placeholder={!schema ? "Select a schema first" : "Select a script group…"}
                  options={schemaScriptNames.map((name) => ({ value: name, label: name }))}
                  onChange={(value) => {
                    setScriptGroup(value);
                    setPreflightResult(null);
                    setPreflightError(null);
                    setTargetVersion("");
                    resetRun();
                    resetDrift();
                  }}
                />
                {/*
                  This used to be a note beside the Check button, and it required
                  scriptGroup to be set — which it can never be when the list is
                  empty, because an empty list is exactly what leaves the picker
                  on its placeholder. So the one case it was written for was the
                  one case it never appeared in: the reader opened the picker,
                  read "No options", and got no explanation of what a script
                  group is or where one comes from.
                */}
                {githubScripts && schema && schemaScriptNames.length === 0 && (
                  <p className="help mt-1">
                    No scripts saved for <span className="mono">{schema}</span>{" "}
                    yet. A script group is one named family of migrations — one
                    name, many versions — that a schema is carried forward by.
                    Author one on Compare &amp; Author, or write it by hand in
                    the Script Editor; it shows up here once it is saved.
                  </p>
                )}
              </div>
            </div>

            <div className="flex items-center gap-3 mt-4">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={!connectionId || !schema || !scriptGroup || preflightLoading || pullLoading}
                onClick={handlePreflight}
              >
                {preflightLoading ? <span className="spin" style={{ width: 13, height: 13 }} /> : <RefreshIcon size={13} />}
                {preflightLoading ? "Checking…" : "Check database"}
              </button>
            </div>
          </div>

          {preflightError && (
            <div className="banner">
              <span className="ico"><AlertCircleIcon size={16} /></span>
              <span>{preflightError}</span>
            </div>
          )}

          {/* Target context card + pending grid — once pre-flight has run */}
          {preflightResult && activeConn && (
            <>
              <div className="target-card flex-wrap">
                <div
                  className="w-11 h-11 rounded-xl grid place-items-center flex-none"
                  style={{ background: "var(--brand-soft)", color: "var(--brand)" }}
                >
                  <LogoIcon size={20} />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                    <span className="mono text-[16px] font-semibold">{preflightResult.schema}</span>
                    <span className="mono text-[12px]" style={{ color: "var(--text-3)" }}>@</span>
                    <span className="mono text-[14px]" style={{ color: "var(--text-2)" }}>{activeConn.name}</span>
                    <EnvironmentPill environment={targetEnvironment} />
                    <span className="pill pill-sync"><span className="dot" />reachable</span>
                  </div>
                  <div className="text-[12px]" style={{ color: "var(--text-3)" }}>
                    <span className="mono">{activeConn.host}:{activeConn.port}/{activeConn.database_name}</span>
                  </div>
                </div>
                <div className="ml-auto flex items-center gap-4 flex-wrap">
                  <div className="text-center">
                    {/* "Applied": the highest script version recorded in the
                        target's script_patch, the same word Compare and the
                        Script Editor use. Not the lineage number. */}
                    <div className="section-title">Applied to target</div>
                    <div className="mono text-[18px] font-semibold mt-1">{currentLabel}</div>
                  </div>
                  <ChevronRightIcon size={20} />
                  <div className="text-center">
                    <div className="section-title">Deploy to</div>
                    <div className="mono text-[18px] font-semibold mt-1" style={{ color: "var(--brand)" }}>
                      {selectionLastLabel}
                    </div>
                  </div>
                </div>
              </div>

              {/* The version timeline: every version of this family, the
                  registry's file on the left and the target's ledger row on
                  the right, newest first. The right-hand status is the version
                  ledger's Applied / Pending / Skipped, the same one the pending
                  list below runs from. Always shown once pre-flight has run.
                  "Roll back to here…" only picks that version in the Roll back
                  card below, which does the undoing. */}
              {versionLedger.length > 0 && (
                <div className="card p-4">
                  <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
                    <div className="section-title">
                      Version timeline · <span className="mono">{scriptGroup}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="pill pill-sync"><span className="dot" />{appliedCount} applied</span>
                      <span className="pill pill-pending"><span className="dot" />{pendingCount} pending</span>
                      {/* The same colour as the Skipped status in the rows. */}
                      {skippedVersions.length > 0 && (
                        <span className="pill pill-drift"><span className="dot" />{skippedVersions.length} skipped</span>
                      )}
                    </div>
                  </div>
                  {/* Skipped rows would read as "still to do" without this. */}
                  {skippedVersions.length > 0 && (
                    <p className="help mb-3">{skippedNote(skippedVersions, currentLabel)}</p>
                  )}
                  {/* Roll back to here… is withheld while a rollback runs: it
                      would change the choice under a running request. */}
                  <VersionTimeline
                    leftLabel="Registry (GitHub)"
                    rightLabel="This database"
                    rows={timeline.rows}
                    outdatedSide={timeline.outdatedSide}
                    revertableVersions={revertableVersions}
                    revertableFamily={scriptGroup}
                    onRevert={rollbackBusy === null ? rollBackTo : undefined}
                    leftNoScript="The registry file for this version is empty."
                    rightNoScript="The ledger row for this version did not store its SQL (rows written before the ledger kept a copy have none)."
                  />
                </div>
              )}

              {/* Roll back: undo the newest applied versions of this family,
                  newest first, in one transaction. The preview is what the
                  revert route will run (planRollback shares its rule), and
                  the panel asks for what the route asks for: the production
                  tick, a tick for rollbacks that delete rows, a tick for other
                  scripts applied since, and on production a second person's
                  approval of this exact rollback SQL. */}
              {(appliedNewestFirst.length > 0 || rollbackDone || revertedHistory.length > 0) && (
                <div className="card p-4" ref={rollbackCardRef} tabIndex={-1}>
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="section-title">
                      Roll back · <span className="mono">{scriptGroup}</span>
                    </div>
                    {appliedNewestFirst.length > 0 && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={rollbackBusy !== null}
                        onClick={() => setRollbackOpen((open) => !open)}
                      >
                        {rollbackOpen ? "Close" : "Plan a rollback"}
                      </button>
                    )}
                  </div>
                  <p className="help mt-1">
                    {appliedNewestFirst.length === 0
                      ? `No version of ${scriptGroup} is applied to ${preflightResult.schema} now, so there is nothing to roll back.`
                      : "Pick a version to go back to: every applied version above it is " +
                        "undone, newest first, in one transaction — all of them or none. A " +
                        "rollback restores structure, not rows."}
                  </p>

                  {rollbackDone && (
                    <div className="mt-3 space-y-3">
                      <div className="flex items-start gap-2 text-[12.5px]" style={{ color: "var(--text-2)" }}>
                        <span className="flex-none mt-0.5" style={{ color: "var(--sync)" }}>
                          <CheckIcon size={14} />
                        </span>
                        <span>{rollbackDone.message}</span>
                      </div>
                      {/* Re-verify: the live schema read again after the rollback. */}
                      <DriftPanel
                        phase={driftPhase}
                        result={driftResult}
                        error={driftError}
                        context="rollback"
                        targetVersion={preflightResult.currentVersion ?? ""}
                      />
                    </div>
                  )}

                  {/* A sticky message (see rollbackError) is shown even with the planner shut. */}
                  {!rollbackPlannerShown && rollbackErrorShown && (
                    <pre className="err-pre mt-3">{rollbackErrorShown}</pre>
                  )}

                  {rollbackPlannerShown && (
                    <div className="mt-3 space-y-3">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[12px]" style={{ color: "var(--text-3)" }}>Roll back to</span>
                        <Select
                          variant="input"
                          ariaLabel="Roll back to version"
                          style={{ width: "auto" }}
                          mono
                          disabled={rollbackBusy !== null}
                          value={rollbackPick}
                          options={rollbackOptions}
                          onChange={(value) => setRollbackChoice(value)}
                        />
                      </div>
                      {rollbackListCapped && (
                        <p className="text-[12px]" style={{ color: "var(--text-3)" }}>
                          A rollback undoes at most {MAX_ROLLBACK_VERSIONS} versions at a time, so this
                          list stops at {vLabel(appliedNewestFirst[MAX_ROLLBACK_VERSIONS])}. To go further
                          back, run this rollback first, then roll back again from there.
                        </p>
                      )}

                      <div>
                        <div className="section-title mb-1">Runs in this order</div>
                        {rollbackSteps.map((step, index) => {
                          const v = vLabel(step.version);
                          const problem =
                            rollbackProblems.find((entry) => entry.version === step.version) ?? null;
                          // Open the SQL that deletes rows, as the deploy opens
                          // its breaking migrations: those are the ones to read.
                          const deletesRows = rollbackDataLoss.some(
                            (loss) => loss.version === step.version
                          );
                          return (
                            <div
                              key={step.version}
                              className="py-2"
                              style={{ borderTop: "1px solid var(--border)" }}
                            >
                              <div className="flex items-center justify-between gap-3">
                                <span className="mono text-[13px]">{`${index + 1}. Undo ${v}`}</span>
                                {step.appliedAt && (
                                  <span className="text-[11px]" style={{ color: "var(--text-3)" }}>
                                    {`applied ${fmtDate(step.appliedAt)}`}
                                  </span>
                                )}
                              </div>
                              {"sql" in step.resolved ? (
                                <>
                                  <div className="help mt-0.5">
                                    {step.resolved.source === "ledger"
                                      ? `Runs the rollback saved when ${v} was applied.`
                                      : `Runs ${v}.down.sql from the registry. No rollback was saved when ${v} was applied.`}
                                  </div>
                                  {step.registryDiffers && (
                                    <div className="help mt-0.5" style={{ color: "var(--drift)" }}>
                                      {`The registry's ${v}.down.sql differs from the copy saved when ${v} was applied. The saved copy is the one that runs.`}
                                    </div>
                                  )}
                                  <details className="mig-sql" open={deletesRows}>
                                    <summary>
                                      <ChevronDownIcon className="chev" size={12} />
                                      <span>Rollback SQL</span>
                                      <span className="mono">
                                        {countOf(getSqlLineCount(step.resolved.sql), "line")}
                                      </span>
                                    </summary>
                                    <pre className="sql">{step.resolved.sql.trim()}</pre>
                                  </details>
                                </>
                              ) : problem ? (
                                <div className="help mt-0.5" style={{ color: "var(--break)" }}>
                                  {problem.text}
                                  {problem.editor && (
                                    <>
                                      {" "}
                                      <Link href="/script-editor" className="underline">
                                        Open the Script Editor
                                      </Link>
                                    </>
                                  )}
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>

                      {targetIsProduction && (
                        <ProductionGate
                          kind="rollback"
                          what={
                            rollbackTarget
                              ? `roll back ${scriptGroup} to ${vLabel(rollbackTarget)}`
                              : `roll back every version of ${scriptGroup}`
                          }
                          acknowledged={rollbackProdAck}
                          onAcknowledge={setRollbackProdAck}
                        />
                      )}
                      {rollbackDataLoss.length > 0 && (
                        <RiskGate
                          tone="break"
                          title={`${countOf(rollbackDataLoss.length, "rollback")} ${rollbackDataLoss.length === 1 ? "deletes" : "delete"} rows`}
                          body={
                            rollbackDataLoss
                              .map((loss) => `The rollback of ${vLabel(loss.version)} contains ${loss.kinds.join(", ")}.`)
                              .join(" ") +
                            " Those take rows out of a live table, and deploying the " +
                            "version again does not bring them back — it rebuilds " +
                            "structure, not data. Have a backup you can restore from " +
                            "before running this."
                          }
                          ack="I have read these statements and know which rows they delete."
                          acknowledged={rollbackDataLossAck}
                          onAcknowledge={setRollbackDataLossAck}
                        />
                      )}
                      {rollbackOthers.length > 0 && rollbackOldest && (
                        <RiskGate
                          tone="drift"
                          title={`${countOf(rollbackOthers.length, "other script")} applied since ${vLabel(rollbackOldest)}`}
                          body={
                            `These were applied to ${preflightResult.schema} after ` +
                            `${vLabel(rollbackOldest)}, the oldest version this rollback ` +
                            "undoes. They may use what the rollback removes, and a DROP " +
                            "... CASCADE takes their objects with it."
                          }
                          ack="I have checked these scripts and mean to roll back anyway."
                          acknowledged={rollbackOtherAck}
                          onAcknowledge={setRollbackOtherAck}
                        >
                          <ul className="mono text-[12px] space-y-0.5">
                            {rollbackOthers.slice(0, 10).map((other) => (
                              <li key={`${other.script_name}@${other.version}`}>
                                {`${other.script_name} ${vLabel(other.version)}`}
                                {other.applied_at ? ` · applied ${fmtDate(other.applied_at)}` : ""}
                              </li>
                            ))}
                          </ul>
                          {rollbackOthers.length > 10 && (
                            <div className="help mt-1">{`…and ${rollbackOthers.length - 10} more.`}</div>
                          )}
                          {/* Until the server has listed them for this plan,
                              the list is the database check's, narrowed by time. */}
                          {rollbackOtherScripts?.key !== rollbackKey && (
                            <div className="help mt-1">
                              From the last database check. A dry run lists them again
                              from the ledger.
                            </div>
                          )}
                        </RiskGate>
                      )}
                      {targetIsProduction && (
                        <ApprovalPanel
                          action="revert"
                          migrationCount={rollbackReady ? rollbackSteps.length : 0}
                          targetVersion={rollbackOldest ?? ""}
                          versionsLabel={listVersions(rollbackSteps.map((step) => step.version))}
                          hashReady={rollbackHash !== null}
                          hashError={rollbackHashError}
                          loading={approvalsLoading}
                          error={rollbackApprovalError ?? approvalsReadError}
                          unreadable={approvalsReadError !== null && approvals.length === 0}
                          busy={approvalBusy}
                          approved={approvedRollback}
                          pending={pendingRollback}
                          latest={latestRollback}
                          viewerEmail={user?.email ?? ""}
                          isAdmin={isAdmin}
                          bypass={bypass}
                          note={rollbackApprovalNote}
                          onNoteChange={setRollbackApprovalNote}
                          onRequest={handleRequestRollbackApproval}
                          onDecide={(id, decision) => void handleDecideApproval(id, decision, "revert")}
                        />
                      )}

                      {rollbackErrorShown && <pre className="err-pre">{rollbackErrorShown}</pre>}
                      {rollbackDryRun && rollbackDryRun.key === rollbackKey && (
                        <div className="flex items-start gap-2 text-[12.5px]" style={{ color: "var(--text-2)" }}>
                          <span className="flex-none mt-0.5" style={{ color: "var(--sync)" }}>
                            <CheckIcon size={14} />
                          </span>
                          <span>{rollbackDryRun.message}</span>
                        </div>
                      )}

                      <div className="flex items-center gap-2 flex-wrap">
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          disabled={rollbackBlocked}
                          onClick={() => void handleRollback(true)}
                        >
                          <EyeIcon size={13} />
                          {rollbackBusy === "dry" ? "Running the dry run…" : "Dry run the rollback"}
                        </button>
                        <button
                          type="button"
                          className="btn btn-destructive btn-sm"
                          disabled={rollbackRunBlocked}
                          onClick={() => void handleRollback(false)}
                        >
                          {rollbackBusy === "real"
                            ? "Rolling back…"
                            : rollbackTarget
                              ? `Roll back to ${vLabel(rollbackTarget)}`
                              : "Roll back every version"}
                        </button>
                      </div>
                      <div className="text-[11px]" style={{ color: "var(--text-3)" }}>
                        {rollbackHint}
                      </div>
                      {!targetIsProduction && (
                        <div className="text-[11px]" style={{ color: "var(--text-3)" }}>
                          Outside production a rollback runs as soon as you press it — no
                          second person is needed.
                        </div>
                      )}
                    </div>
                  )}

                  {revertedHistory.length > 0 && (
                    <div className="mt-4">
                      <div className="section-title mb-1">Rollback history</div>
                      {revertedHistory.slice(0, 10).map((row) => (
                        <div
                          key={`${row.version}@${row.reverted_at}`}
                          className="flex items-center justify-between gap-3 py-1.5"
                          style={{ borderTop: "1px solid var(--border)" }}
                        >
                          <span className="mono text-[13px]">{vLabel(row.version)}</span>
                          <span className="text-[11px]" style={{ color: "var(--text-3)" }}>
                            {`${row.applied_at ? `applied ${fmtDate(row.applied_at)} · ` : ""}rolled back ${fmtDate(row.reverted_at)}`}
                          </span>
                        </div>
                      ))}
                      {revertedHistory.length > 10 && (
                        <div className="help mt-1">{`…and ${revertedHistory.length - 10} more.`}</div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {pendingScripts.length === 0 ? (
                <div className="card p-8 text-center">
                  <div className="w-12 h-12 rounded-full grid place-items-center mx-auto mb-3" style={{ background: "var(--sync-soft)", color: "var(--sync)" }}>
                    <CheckIcon size={22} />
                  </div>
                  <div className="text-[15px] font-semibold">You’re up-to-date!</div>
                  <p className="help mt-1">
                    No pending migrations for <span className="mono">{scriptGroup}</span> in{" "}
                    <span className="mono">{preflightResult.schema}</span>. The ledger is at{" "}
                    <span className="mono">{currentLabel}</span>.
                  </p>
                  {/* Skipped versions are not pending, so they do not stop this
                      card; one line keeps them from going unmentioned. */}
                  {skippedVersions.length > 0 && (
                    <p className="help mt-1">
                      {`${countOf(skippedVersions.length, "older version")} ${
                        skippedVersions.length === 1 ? "was" : "were"
                      } never applied and will not run. See Skipped in the version timeline above.`}
                    </p>
                  )}
                </div>
              ) : (
                <div className="grid gap-6 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px]">
                  {/* Left: pending list + drift pre-check */}
                  <div className="space-y-4">
                    <div className="flex items-end justify-between gap-3 flex-wrap">
                      <div>
                        <div className="section-title">Pending migrations</div>
                        <h2 className="text-[18px] font-semibold tracking-[-0.005em] mt-1">
                          {pendingScripts.length} pending · {scriptsUpToTarget.length} in this run
                        </h2>
                        {/* Skipped versions are not in the list below, so say
                            why rather than leave them missing without a word. */}
                        {skippedVersions.length > 0 && (
                          <p className="help mt-1">
                            {`Not in this run: ${listVersions(skippedVersions)} ${
                              skippedVersions.length === 1 ? "was" : "were"
                            } skipped — never applied and below ${currentLabel}, the version applied to the target. See Skipped in the version timeline above.`}
                          </p>
                        )}
                      </div>
                      {/* Every pending version at once. Each row's own
                          "Run …" picks a shorter run, from the first pending
                          version up to that row. */}
                      {pendingScripts.length > 1 && (
                        <button
                          type="button"
                          className="btn btn-sm btn-secondary"
                          disabled={isDeploying}
                          title="Selects every pending version for the run below. Nothing runs until you press Deploy or Dry run."
                          onClick={() => selectRun(pendingScripts[pendingScripts.length - 1].version)}
                        >
                          {`Run all (${pendingScripts.length})…`}
                        </button>
                      )}
                    </div>

                    <div>
                      {pendingScripts.map((script, i) => {
                        const reading = describeChangeType(script.sql_content);
                        const kind = reading.recorded;
                        const from = i === 0 ? currentLabel : vLabel(pendingScripts[i - 1].version);
                        // The version this one follows on the target, for the
                        // step note. null on a fresh target: there is no step.
                        const previous =
                          i === 0 ? preflightResult.currentVersion : pendingScripts[i - 1].version;
                        // In the run when the selection holds this script, so
                        // the rows marked here are exactly what Deploy sends.
                        const inRun = inRunKeys.has(scriptKey(script));
                        // This row's button selects every pending version up to
                        // it. A run always starts at the first pending version:
                        // deploys only move forward, one version after another.
                        const through = pendingPrefixThrough(pendingScripts, script.version);
                        const runLabel =
                          through.length <= 1
                            ? `Run ${vLabel(script.version)}…`
                            : `Run ${versionRange(through.map((s) => s.version))} (${through.length})…`;
                        return (
                          <MigRow
                            key={scriptKey(script)}
                            seq={String(i + 1).padStart(2, "0")}
                            name={script.script_name}
                            kind={kind}
                            sub={`${from} → ${vLabel(script.version)} · ${countOf(getSqlLineCount(script.sql_content), "line")}`}
                            rightPill={bumpWord(kind)}
                            cell={{ status: inRun ? "queued" : "not-in-run" }}
                            selected={inRun}
                            sql={script.sql_content}
                            sqlOpen={inRun && reading.countsAsBreaking}
                            notes={pendingRowNotes(script, reading, previous)}
                            action={
                              <button
                                type="button"
                                className="btn btn-sm btn-secondary"
                                disabled={isDeploying}
                                title="Selects this range for the run below. Nothing runs until you press Deploy or Dry run."
                                onClick={() => selectRun(script.version)}
                              >
                                {runLabel}
                              </button>
                            }
                          />
                        );
                      })}
                    </div>

                    {/* Drift pre-check — real lineage compare when the target is tracked */}
                    <DriftPanel
                      phase={driftPhase}
                      result={driftResult}
                      error={driftError}
                      context="precheck"
                      targetVersion={targetVersion}
                    />
                  </div>

                  {/* Right: summary + checklist */}
                  <aside className="space-y-4">
                    <div className="card p-5" ref={runPanelRef} tabIndex={-1}>
                      <div className="section-title mb-2">Summary</div>
                      <div className="vline mt-2">
                        <span className="vchip">{currentLabel}</span>
                        <ChevronRightIcon size={16} />
                        <span className="vchip next"><b>{selectionLastLabel}</b></span>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-2 gap-x-4 mt-4 text-[12.5px]">
                        {/* The target is named at the top of the page, which is
                            not where the button is. */}
                        <div className="flex justify-between col-span-2">
                          <span style={{ color: "var(--text-3)" }}>Target</span>
                          <span className="mono">{schema} @ {activeConn.name}</span>
                        </div>
                        <div className="col-span-2 text-[11px] mono" style={{ color: "var(--text-3)" }}>
                          {activeConn.host}:{activeConn.port}/{activeConn.database_name}
                        </div>
                        <div className="flex justify-between"><span style={{ color: "var(--text-3)" }}>Migrations</span><span className="mono">{scriptsUpToTarget.length}</span></div>
                        <div className="flex justify-between"><span style={{ color: "var(--text-3)" }}>Bump</span><span>{bumps}</span></div>
                        {/* Two rows, because they are two questions. Breaking
                            is what stops working after this succeeds; deletes
                            rows is what you need a backup for. A rename is the
                            first and not the second. */}
                        <div className="flex justify-between" title="Migrations marked breaking, or containing SQL that is always breaking"><span style={{ color: "var(--text-3)" }}>Breaking</span><span className="mono">{breakingCount}</span></div>
                        <div className="flex justify-between"><span style={{ color: "var(--text-3)" }}>Deletes rows</span><span className="mono">{dataLossScripts.length}</span></div>
                        <div className="flex justify-between"><span style={{ color: "var(--text-3)" }}>Lines of SQL</span><span className="mono">{linesOfSql}</span></div>
                        <div className="flex justify-between"><span style={{ color: "var(--text-3)" }}>Strategy</span><span>one transaction</span></div>
                      </div>

                      <div className="space-y-3 mt-4">
                        {targetIsProduction && (
                          <ProductionGate
                            what={`run ${scriptsUpToTarget.length} migration${scriptsUpToTarget.length === 1 ? "" : "s"}`}
                            acknowledged={deployAcknowledged}
                            onAcknowledge={setDeployAcknowledged}
                          />
                        )}
                        {breakingCount > 0 && (
                          <RiskGate
                            tone="break"
                            title={`${breakingCount} breaking migration${breakingCount === 1 ? "" : "s"}`}
                            body={
                              // "Breaking" grades a contract break, not data loss —
                              // a rename is breaking and loses nothing. The rows
                              // question belongs to the deletes-rows gate below,
                              // which asks its own tick and names its own backup.
                              "A breaking migration drops or rewrites structure that is " +
                              "already there. Anything reading the old shape — an app, a " +
                              "view, a report — stops working the moment this commits. The " +
                              "breaking ones in the list on the left are open already, " +
                              "showing the statements they will run." +
                              (louderCount === 0
                                ? ""
                                : louderCount === 1
                                  ? " One of them is marked less than breaking but has a " +
                                    "statement that is always breaking, so it is counted here."
                                  : ` ${louderCount} of them are marked less than breaking but ` +
                                    "have a statement that is always breaking, so they are " +
                                    "counted here.")
                            }
                            ack={`I have read the ${breakingCount === 1 ? "breaking migration" : "breaking migrations"} and know what stops working.`}
                            acknowledged={breakingAcknowledged}
                            onAcknowledge={setBreakingAcknowledged}
                          />
                        )}
                        {dataLossScripts.length > 0 && (
                          <RiskGate
                            tone="break"
                            title={`${dataLossScripts.length} ${dataLossScripts.length === 1 ? "migration deletes" : "migrations delete"} rows`}
                            body={
                              `This run contains ${dataLossKinds}. Those take rows out of ` +
                              "a live table, and no rollback puts them back — a down " +
                              "script rebuilds structure, not data. " +
                              (unflaggedDataLossKinds.length === 0
                                ? ""
                                : unflaggedDataLossKinds.length === 1
                                  ? `A ${unflaggedDataLossKinds[0]} changes no structure, so it is never ` +
                                    "graded breaking and gets no breaking pill — this box is the only " +
                                    "warning it gets. "
                                  : `${unflaggedDataLossKinds.join(" and ")} change no structure, so they ` +
                                    "are never graded breaking and get no breaking pill — this box is " +
                                    "the only warning they get. ") +
                              "Have a backup you can restore from before running this."
                            }
                            ack="I have read these statements and know which rows they delete."
                            acknowledged={dataLossAcknowledged}
                            onAcknowledge={setDataLossAcknowledged}
                          />
                        )}
                        {mightFailScripts.length > 0 && (
                          // No tick. See the mightFailScripts comment above: the
                          // whole run is one transaction, so this is the risk
                          // that costs nothing when it happens, and a gate here
                          // would teach the reader to tick past the two that do.
                          <div className="warn-inline">
                            <span className="ico">
                              <AlertTriangleIcon size={14} />
                            </span>
                            <span>
                              <b>
                                {countOf(mightFailScripts.length, "migration")} may be
                                refused by the data already in the table.
                              </b>{" "}
                              This run contains {mightFailKinds}. Those are valid SQL
                              that PostgreSQL checks against every existing row — one
                              NULL, one duplicate or one value that will not cast and
                              the statement stops. Nothing is half-applied if that
                              happens: the run is one transaction, so it rolls back and
                              the target is left as it is now.
                            </span>
                          </div>
                        )}
                        {enumAdditions.length > 0 && (
                          <RiskGate
                            tone="drift"
                            title={
                              enumAdditions.length === 1
                                ? "1 enum value runs before the transaction"
                                : `${enumAdditions.length} enum values run before the transaction`
                            }
                            body={
                              "PostgreSQL will not let a value added by ALTER TYPE … ADD " +
                              "VALUE be used by another statement in the same transaction, " +
                              "so the run adds " +
                              (enumAdditions.length === 1 ? "this one" : "these") +
                              " first, on their own. They commit straight away. If the run " +
                              "then fails, everything else is rolled back and " +
                              (enumAdditions.length === 1 ? "this stays" : "these stay") +
                              " — there is no statement in PostgreSQL that removes an enum " +
                              "value, so it cannot be undone by hand either. A label " +
                              "nothing uses does no harm; it is simply the one part of the " +
                              "run that is not all-or-nothing. A dry run cannot lift them " +
                              "out without leaving them behind, so it runs them inside the " +
                              "transaction instead — which is why rehearsing a script that " +
                              "uses its own new value fails where the real run succeeds."
                            }
                          />
                        )}
                        {driftGateStatus !== null && (
                          <RiskGate
                            tone="drift"
                            title={
                              driftGateFromRecord
                                ? driftGateStatus === "drifted"
                                  ? "The last drift check found the target drifted"
                                  : "The last drift check could not reach the target"
                                : driftGateStatus === "drifted"
                                  ? "The target has drifted"
                                  : "The target could not be checked"
                            }
                            body={
                              driftGateFromRecord
                                ? "This drift check failed, so nothing here has confirmed " +
                                  "what state the target is in now, and the last check on " +
                                  "record found it " +
                                  (driftGateStatus === "drifted"
                                    ? "different from the snapshot these migrations were written against. "
                                    : "unreachable. ") +
                                  "The server holds a run to that last result. Press Check " +
                                  "database to run the drift check again, or tick below to run anyway."
                                : driftGateStatus === "drifted"
                                  ? "The live schema no longer matches the snapshot these " +
                                    "migrations were written against, so a migration may hit " +
                                    "an object that is not the one it expects. Read the drift " +
                                    "report on the left before running this."
                                  : "The drift check could not reach the target, so nothing " +
                                    "here has confirmed what state it is in. The run will " +
                                    "still connect — this only means it starts unverified."
                            }
                            ack={
                              driftGateFromRecord
                                ? "I mean to run without a drift check that passed."
                                : driftGateStatus === "drifted"
                                  ? "I have read the drift and mean to run anyway."
                                  : "I mean to run without a drift check."
                            }
                            acknowledged={driftAcknowledged}
                            onAcknowledge={setDriftAcknowledged}
                          />
                        )}
                        {targetIsProduction && (
                          <ApprovalPanel
                            migrationCount={scriptsUpToTarget.length}
                            targetVersion={targetVersion}
                            hashReady={runHash !== null}
                            hashError={hashError}
                            loading={approvalsLoading}
                            error={approvalError ?? approvalsReadError}
                            unreadable={approvalsReadError !== null && approvals.length === 0}
                            busy={approvalBusy}
                            approved={approvedRun}
                            pending={pendingRun}
                            latest={latestRun}
                            viewerEmail={user?.email ?? ""}
                            isAdmin={isAdmin}
                            bypass={bypass}
                            note={approvalNote}
                            onNoteChange={setApprovalNote}
                            onRequest={handleRequestApproval}
                            onDecide={(id, decision) => void handleDecideApproval(id, decision, "deploy")}
                            otherApproval={otherApproval}
                            onSelectOther={
                              otherApprovalVersion ? () => selectRun(otherApprovalVersion) : undefined
                            }
                            runButton={deployLabel}
                          />
                        )}
                      </div>

                      <div className="flex items-center justify-end mt-5">
                        <EnvironmentPill environment={targetEnvironment} />
                      </div>
                      <button
                        type="button"
                        className={`btn btn-lg w-full mt-2 ${targetIsProduction ? "btn-destructive" : "btn-primary"}`}
                        disabled={deployBlocked}
                        onClick={() => handleRun(false)}
                        ref={deployButtonRef}
                      >
                        <DeployIcon size={14} />
                        {/* Names the range it deploys, as the "Run …" button that
                            picked it did: "Deploy v5.0.1 → v5.0.2 (2)". */}
                        {deployLabel}
                      </button>
                      {/* A rehearsal writes nothing, but it really runs the SQL —
                          including any statement that takes a heavy lock — so it
                          sits behind the same production confirmation. */}
                      <button
                        type="button"
                        className="btn btn-secondary w-full mt-2"
                        disabled={runBlocked}
                        onClick={() => handleRun(true)}
                        title="Runs this SQL on the target inside one transaction, then rolls it back: nothing is written."
                      >
                        <EyeIcon size={14} />
                        {dryRunLabel}
                      </button>
                      <div className="text-[11px] mt-2 text-center" style={{ color: "var(--text-3)" }}>
                        {hasTxnViolation
                          ? "Remove the COMMIT or ROLLBACK from the versions named in " +
                            "the checklist, then pull again"
                          : driftChecking
                            ? "Checking the target for drift first — these unlock when the check finishes"
                          : unacknowledgedGates
                            ? "Tick every box above to enable this"
                            : targetIsProduction && !approvedRun
                              ? "Deploy needs a second person's approval — a dry run does not"
                              : enumAdditions.length > 0
                              ? "All migrations run in one transaction — all of them or " +
                                "none, apart from the enum values noted above"
                              : "All migrations run in one transaction — all of them or none"}
                      </div>
                    </div>

                    <div className="card p-5">
                      <div className="section-title mb-3">Pre-flight checklist</div>
                      <ul className="space-y-2 text-[12.5px]" style={{ color: "var(--text-2)" }}>
                        <ChecklistItem ok>Target reachable · {activeConn.host}</ChecklistItem>
                        {targetIsProduction ? (
                          <ChecklistItem ok={deployAcknowledged}>
                            Environment · production —{" "}
                            {deployAcknowledged ? "confirmed" : "needs an explicit confirmation"}
                          </ChecklistItem>
                        ) : targetEnvironment === "unset" ? (
                          <ChecklistItem info>
                            Environment · unlabelled — nothing here can warn you about this target
                          </ChecklistItem>
                        ) : (
                          <ChecklistItem ok>
                            Environment · {targetEnvironment}
                          </ChecklistItem>
                        )}
                        <ChecklistItem ok>
                          Applied state read · {preflightResult.currentVersion ? <>at <span className="mono">{vLabel(preflightResult.currentVersion)}</span></> : "fresh — no versions yet"}
                        </ChecklistItem>
                        <ChecklistItem ok={!hasTxnViolation}>
                          {/* A count leaves the reader to open every script and
                              hunt. The versions are already in scope — name them,
                              and state the rule the apply route enforces. */}
                          {hasTxnViolation
                            ? `COMMIT or ROLLBACK found in ${txnViolationScripts
                                .map((s) => vLabel(s.version))
                                .join(", ")} — the run is already one transaction, so ` +
                              "remove them from the SQL"
                            : "No transaction-control in SQL"}
                        </ChecklistItem>
                        {breakingCount > 0 ? (
                          <ChecklistItem ok={breakingAcknowledged}>
                            {/* Counted as describeChangeType counts: marked
                                breaking, or containing SQL that is always
                                breaking whatever the mark says. */}
                            Breaking changes · {breakingCount}
                            {louderCount > 0
                              ? `, including ${louderCount} marked less than breaking whose SQL is always breaking`
                              : ""}{" "}
                            {breakingAcknowledged ? "· acknowledged" : "· need acknowledging"}
                          </ChecklistItem>
                        ) : (
                          <ChecklistItem ok>
                            Nothing in this run drops or rewrites structure
                          </ChecklistItem>
                        )}
                        {dataLossScripts.length > 0 ? (
                          <ChecklistItem ok={dataLossAcknowledged}>
                            Deletes rows · {dataLossKinds} in{" "}
                            {countOf(dataLossScripts.length, "script")}{" "}
                            {dataLossAcknowledged ? "· acknowledged" : "· needs acknowledging"}
                          </ChecklistItem>
                        ) : (
                          <ChecklistItem ok>Nothing in this run deletes rows</ChecklistItem>
                        )}
                        {mightFailScripts.length > 0 ? (
                          // `info`, not a failed tick: this is a thing that might
                          // happen, not a thing that is wrong.
                          <ChecklistItem info>
                            May be refused by existing rows · {mightFailKinds} in{" "}
                            {countOf(mightFailScripts.length, "script")} · rolls back if
                            it is
                          </ChecklistItem>
                        ) : (
                          <ChecklistItem ok>
                            Nothing in this run can be refused by existing rows
                          </ChecklistItem>
                        )}
                        {enumAdditions.length > 0 && (
                          <ChecklistItem info>
                            {countOf(enumAdditions.length, "enum value")}{" "}
                            {enumAdditions.length === 1 ? "commits" : "commit"} before the
                            transaction · not undone by a rollback
                          </ChecklistItem>
                        )}
                        {targetIsProduction &&
                          (approvalsReadError && !approvedRun ? (
                            // "not requested yet" would be a reading of a list
                            // this page never managed to read.
                            <ChecklistItem info>Approval · could not be read</ChecklistItem>
                          ) : (
                            <ChecklistItem ok={Boolean(approvedRun)}>
                              {approvedRun
                                ? `Approved by ${approvedRun.decided_by ?? "a second person"}`
                                : pendingRun
                                  ? "Approval requested · waiting for a second person"
                                  : "Approval · not requested yet"}
                            </ChecklistItem>
                          ))}
                        {preflightResult.needsInit ? (
                          <ChecklistItem info>
                            {/* The apply route creates it before BEGIN, so it is
                                not covered by the run's rollback either. */}
                            Ledger table will be created on first deploy — it is
                            created before the transaction opens, so it stays even if
                            the run fails
                          </ChecklistItem>
                        ) : (
                          <ChecklistItem ok>Ledger table present · <span className="mono">script_patch</span></ChecklistItem>
                        )}
                        {driftPhase === "loading" && (
                          <ChecklistItem info>Drift check · checking the target…</ChecklistItem>
                        )}
                        {driftPhase === "untracked" && (
                          <ChecklistItem stub>Drift check · target not tracked</ChecklistItem>
                        )}
                        {driftPhase === "error" &&
                          (driftGateFromRecord ? (
                            <ChecklistItem ok={driftAcknowledged}>
                              Drift check · check failed, and the last check on record found
                              the target {driftGateStatus === "drifted" ? "drifted" : "unreachable"}
                              {driftAcknowledged ? " · acknowledged" : ""}
                            </ChecklistItem>
                          ) : (
                            <ChecklistItem ok={false}>Drift check · check failed</ChecklistItem>
                          ))}
                        {driftPhase === "ready" && driftResult && (
                          driftResult.status === "in_sync" ? (
                            <ChecklistItem ok>
                              Drift check · in sync
                              {driftResult.expectedVersion ? (
                                <> with lineage <span className="mono">{vLabel(driftResult.expectedVersion)}</span></>
                              ) : null}
                            </ChecklistItem>
                          ) : driftResult.status === "drifted" ? (
                            <ChecklistItem ok={driftAcknowledged}>
                              Drift check · live schema has drifted
                              {driftAcknowledged ? " · acknowledged" : ""}
                            </ChecklistItem>
                          ) : (
                            <ChecklistItem ok={driftAcknowledged}>
                              Drift check · target unreachable
                              {driftAcknowledged ? " · acknowledged" : ""}
                            </ChecklistItem>
                          )
                        )}
                        {driftPhase === "idle" && (
                          <ChecklistItem stub>Drift check · run a check to see status</ChecklistItem>
                        )}
                      </ul>
                    </div>
                  </aside>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {/* ═══════════════════ STAGE 2 — RUN ═══════════════════ */}
      {stage === 2 && (
        <section className="px-4 sm:px-8 pb-12">
          <div
            className="card p-5 mb-5 flex items-center gap-3 flex-wrap"
            style={{
              background: "color-mix(in oklab, var(--brand) 4%, var(--surface))",
              borderColor: "color-mix(in oklab, var(--brand) 35%, var(--border))",
            }}
          >
            <DeployIcon size={18} />
            <div className="flex-1 min-w-0">
              <div className="text-[14px] font-semibold">
                {/* "nothing was applied" is a verdict, and on an unknown outcome
                    it is the wrong one — it used to sit directly above an error
                    saying the run may still have landed. */}
                {isDeploying
                  ? runIsDryRun
                    ? "Rehearsing migrations…"
                    : "Applying migrations…"
                  : runOutcomeUnknown
                    ? "Run outcome not known — check the target before retrying"
                    : allApplied
                      ? "Run finished"
                      : allRehearsed
                        ? "Dry run finished — nothing was written"
                        : runRefused
                          ? runIsDryRun
                            ? "Dry run refused — nothing was run"
                            : "Run refused — nothing was applied"
                          : runIsDryRun
                            ? "Dry run halted"
                            : "Run halted — nothing was applied"}
              </div>
              <div className="text-[12.5px]" style={{ color: "var(--text-2)" }}>
                {/* The enum values are lifted out and committed before the
                    transaction opens, so the unqualified promise is false for
                    exactly this run — the same exception the gate above states. */}
                {runIsDryRun
                  ? "Every migration really runs against the target, inside one transaction that always ends in ROLLBACK."
                  : enumAdditions.length > 0
                    ? "Every migration runs inside one transaction. A failure rolls " +
                      "the whole run back — all of them or none, apart from the enum " +
                      "values that were committed first."
                    : "Every migration runs inside one transaction. A failure rolls the whole run back — all of them or none."}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {/* Which database this is landing on, while it is landing. */}
              <EnvironmentPill environment={targetEnvironment} />
              {runIsDryRun && (
                <span className="pill pill-neutral">
                  <span className="dot" style={{ background: "var(--text-3)" }} />
                  dry run
                </span>
              )}
              <span className="mono text-[12.5px]" style={{ color: "var(--text-3)" }}>elapsed {fmtSecs(elapsedMs)}</span>
            </div>
          </div>

          {/* A failure that belongs to the run, not to any one migration. */}
          {runError && (
            <div
              className="card p-4 mb-5 flex items-start gap-3"
              style={{
                borderColor: "color-mix(in oklab, var(--break) 40%, var(--border))",
                background: "color-mix(in oklab, var(--break) 5%, var(--surface))",
              }}
            >
              <AlertTriangleIcon size={16} />
              <div className="text-[12.5px] min-w-0" style={{ color: "var(--text-2)" }}>
                {runError}
              </div>
            </div>
          )}

          <div>
            {runScripts.map((script, i) => {
              // The same reading as the pending list: the pill is the recorded
              // level, and a script counted as breaking for its SQL says so.
              const reading = describeChangeType(script.sql_content);
              const kind = reading.recorded;
              const cell = runStatus[scriptKey(script)] ?? { status: "queued" };
              const ran = cell.statements !== undefined ? ` · ${fmtStatements(cell.statements)}` : "";
              const subByStatus: Record<RunStatus, string> = {
                queued: "queued · waiting",
                // Only the pending list can produce this one; stage 2 renders
                // the captured batch, and everything in it is in the run.
                "not-in-run": "not in this run",
                running: "running · in the run's transaction",
                applied: `applied · committed with the run${ran}`,
                rehearsed: `rehearsed · rolled back with the run${ran}`,
                // The row says what happened; the err-pre below says what
                // Postgres said — one each, not both twice.
                // A refused run never got going, so there is nothing to have
                // rolled back; the row names the refusal instead.
                failed: runRefused
                  ? "refused · the server's reason is below"
                  : "failed · the whole run was rolled back",
                skipped: runRefused
                  ? "skipped · the server refused the run, and nothing in it was applied"
                  : "skipped · the run rolled back before this one could commit",
                unknown: "not known · the commit never reported back — read script_patch",
              };
              return (
                <MigRow
                  key={scriptKey(script)}
                  seq={String(i + 1).padStart(2, "0")}
                  name={script.script_name}
                  kind={kind}
                  sub={subByStatus[cell.status]}
                  rightPill={vLabel(script.version)}
                  cell={cell}
                  sql={script.sql_content}
                  notes={reading.louderNote ? [{ text: reading.louderNote, warn: true }] : undefined}
                />
              );
            })}
          </div>

          <div className="mt-6 flex items-center justify-between text-[12px] flex-wrap gap-2" style={{ color: "var(--text-3)" }}>
            <span>
              {runOutcomeUnknown
                ? `outcome of ${countOf(runScripts.length, "migration")} not known`
                : `${runProgress} of ${runScripts.length} ${runIsDryRun ? "rehearsed" : "applied"}`}
              {totalStatements > 0 ? ` · ${fmtStatements(totalStatements)}` : ""} ·{" "}
              <span className="mono">{schema} @ {activeConn?.name}</span>
            </span>
            <span>
              {runOutcomeUnknown
                ? "one transaction · but nothing here saw how it ended"
                : "one transaction · a failure rolls the whole run back"}
            </span>
          </div>

          {/* Clean rehearsal — say what it proved, and offer the real thing. */}
          {runComplete && allRehearsed && (
            <div
              className="card p-4 mt-4 flex items-center gap-3 flex-wrap"
              style={{
                borderColor: "color-mix(in oklab, var(--sync) 40%, var(--border))",
                background: "color-mix(in oklab, var(--sync) 5%, var(--surface))",
              }}
            >
              <CheckIcon size={16} />
              <div className="flex-1 min-w-0">
                <div className="text-[13.5px] font-semibold">
                  Rehearsal clean — the target accepted every migration.
                </div>
                <div className="text-[12px]" style={{ color: "var(--text-2)" }}>
                  Then it was rolled back: no ledger rows, no lineage advance, no schema
                  change. The ledger has been re-read and still reads{" "}
                  <span className="mono">
                    {preflightResult?.currentVersion ? vLabel(preflightResult.currentVersion) : "no versions yet"}
                  </span>.
                </div>
                {targetIsProduction && !approvedRun && (
                  <div className="text-[12px] mt-1" style={{ color: "var(--drift)" }}>
                    A clean rehearsal is not an approval. Go back to Pre-flight to ask
                    someone else to clear the real run.
                  </div>
                )}
                {/* Deploy for real deploys the selection, not the batch above,
                    so it waits while the two differ: another range picked, the
                    SQL re-pulled, or the re-read ledger moved what is pending. */}
                {rehearsalChange !== null && (
                  <div className="text-[12px] mt-1" style={{ color: "var(--drift)" }}>
                    {rehearsalChange === "range"
                      ? `You rehearsed ${ranName}; the selection is now ${nowName}. Rehearse this selection, or pick the rehearsed range again.`
                      : rehearsalChange === "scripts"
                        ? `The registry’s copy of ${runRange} has changed since you rehearsed it, so this rehearsal no longer covers what would run. Go back to Pre-flight and rehearse it again.`
                        : `You rehearsed ${runRange}, but nothing is selected to deploy now. Go back to Pre-flight to see what is pending.`}
                  </div>
                )}
                {rehearsalChange === null && untickedOnPreflight && (
                  <div className="text-[12px] mt-1" style={{ color: "var(--drift)" }}>
                    Pre-flight has boxes that are not ticked for this run. Go back to
                    Pre-flight to tick them.
                  </div>
                )}
              </div>
              <button
                type="button"
                className={`btn btn-sm ${targetIsProduction ? "btn-destructive" : "btn-primary"}`}
                disabled={deployBlocked || rehearsalChange !== null}
                onClick={() => handleRun(false)}
              >
                <DeployIcon size={13} />
                {/* The drift check re-runs after every run (see driftChecking). */}
                {driftChecking ? "Checking the target for drift…" : "Deploy for real"}
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setStage(1)}>
                Back to Pre-flight
              </button>
            </div>
          )}

          {/* Recovery bar — only after a failed run */}
          {runComplete && !allApplied && !allRehearsed && (
            <div
              className="card p-4 mt-4 flex items-center gap-3 flex-wrap"
              style={{
                borderColor: "color-mix(in oklab, var(--break) 40%, var(--border))",
                background: "color-mix(in oklab, var(--break) 5%, var(--surface))",
              }}
            >
              <AlertCircleIcon size={16} />
              <div className="flex-1 min-w-0">
                <div className="text-[13.5px] font-semibold">
                  {runOutcomeUnknown
                    ? "Run outcome not known."
                    : runRefused
                      ? "Run refused."
                      : "Run did not complete."}
                </div>
                <div className="text-[12px]" style={{ color: "var(--text-2)" }}>
                  {/* Only a response we actually read licenses the claim that
                      nothing changed. "Fix the script" is gone too — a lock
                      timeout and a duplicate version have no script to fix, and
                      the server's own instruction is already in the card above. */}
                  {runOutcomeUnknown
                    ? "This page never saw the run finish, so it cannot say what the " +
                      "target has now. Press Check database on Pre-flight and read the " +
                      "ledger before you run this again."
                    : runRefused
                    ? "The server refused this run, so none of the migrations above " +
                      "are applied. Its reason is in the card above."
                    : "The run rolled back, so none of the migrations above are " +
                      "applied. Anything that had to commit before the transaction " +
                      "opened is still there — the ledger table on a first deploy, and " +
                      "any enum value listed on Pre-flight. The ledger has been re-read."}
                </div>
                {/* Run again starts the selection, not the batch above, so it
                    waits while the two differ. That also keeps a run whose
                    commit may have landed from going out twice: the re-read
                    ledger moves what is pending, and with it the selection. */}
                {repeatChange !== null && (
                  <div className="text-[12px] mt-1" style={{ color: "var(--drift)" }}>
                    {repeatChange === "range"
                      ? `Pre-flight now selects ${nowName}, and this ${runIsDryRun ? "rehearsal" : "run"} was ${ranName}, so it cannot be repeated from here. Go back to Pre-flight to start the one you want.`
                      : repeatChange === "scripts"
                        ? `The registry’s copy of ${runRange} has changed since this ${runIsDryRun ? "rehearsal" : "run"}, so it cannot be repeated from here. Go back to Pre-flight to read the new SQL and start it from there.`
                        : `Nothing is selected to run now, so this ${runIsDryRun ? "rehearsal" : "run"} cannot be repeated from here. Go back to Pre-flight to see what is pending.`}
                  </div>
                )}
                {repeatChange === null && untickedOnPreflight && (
                  <div className="text-[12px] mt-1" style={{ color: "var(--drift)" }}>
                    Pre-flight has boxes that are not ticked for this run. Go back to
                    Pre-flight to tick them.
                  </div>
                )}
                {repeatChange === null &&
                  !untickedOnPreflight &&
                  !driftChecking &&
                  !runIsDryRun &&
                  targetIsProduction &&
                  !approvedRun && (
                    <div className="text-[12px] mt-1" style={{ color: "var(--drift)" }}>
                      Deploy needs a second person&apos;s approval. Go back to Pre-flight to
                      ask for one.
                    </div>
                  )}
              </div>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={(runIsDryRun ? runBlocked : deployBlocked) || repeatChange !== null}
                onClick={() => handleRun(runIsDryRun)}
              >
                {driftChecking
                  ? "Checking the target for drift…"
                  : runIsDryRun
                    ? "Rehearse again"
                    : "Run again"}
              </button>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setStage(1)}>
                Back to Pre-flight
              </button>
            </div>
          )}
        </section>
      )}

      {/* ═══════════════════ STAGE 3 — VERIFY ═══════════════════ */}
      {stage === 3 && (
        <section className="px-4 sm:px-8 pb-12">
          {/* The ledger re-read is the only thing that knows what the target
              reports now. When it failed, its error belongs on this stage too —
              until now it only ever rendered on Pre-flight. */}
          {preflightError && (
            <div className="banner mb-4">
              <span className="ico"><AlertCircleIcon size={16} /></span>
              <span>{preflightError}</span>
            </div>
          )}
          <div className="verify-hero">
            <div className="ring" />
            <div className="relative flex items-start gap-5 flex-wrap">
              <div className="check-big">
                <CheckIcon size={28} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="section-title" style={{ color: "color-mix(in oklab, var(--sync) 70%, var(--text-3))" }}>
                  Deployed
                </div>
                <h2 className="text-[26px] font-semibold tracking-[-0.015em] mt-1">
                  Migrations applied to the target.
                </h2>
                {preflightResult ? (
                  <p className="text-[14px] mt-2" style={{ color: "var(--text-2)" }}>
                    <span className="mono" style={{ color: "var(--text)" }}>{schema}</span> on{" "}
                    <span className="mono" style={{ color: "var(--text)" }}>{activeConn?.name}</span>{" "}
                    now reports{" "}
                    <span className="mono" style={{ color: "var(--text)" }}>
                      {preflightResult.currentVersion
                        ? vLabel(preflightResult.currentVersion)
                        : "no versions yet"}
                    </span>{" "}
                    in its migration ledger.
                  </p>
                ) : (
                  <p className="text-[14px] mt-2" style={{ color: "var(--text-2)" }}>
                    The deploy committed, but the ledger could not be read back
                    afterwards — this page cannot confirm what the target now
                    reports.
                  </p>
                )}
                <div className="vline mt-4">
                  <span className="vchip">{runFromVersion}</span>
                  <ChevronRightIcon size={16} />
                  {/* The batch that ran, not the selection: Pre-flight can move
                      the selection after a deploy. */}
                  <span className="vchip ok"><b>{runLastVersion ? vLabel(runLastVersion) : "—"}</b></span>
                  <span className="text-[12px] ml-2" style={{ color: "var(--text-3)" }}>
                    {fmtSecs(elapsedMs)} · {appliedScripts.length} migration{appliedScripts.length === 1 ? "" : "s"} in one transaction · 0 errors
                  </span>
                </div>
                <div className="flex gap-2 mt-5 flex-wrap">
                  <button type="button" className="btn btn-primary" onClick={handlePreflight}>
                    Re-check target
                  </button>
                  <button type="button" className="btn btn-secondary" onClick={() => setStage(1)}>
                    Back to Pre-flight
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mt-5">
            <div className="card p-5">
              <div className="section-title mb-3">What was applied</div>
              <div className="space-y-1">
                {appliedScripts.map((s, i) => (
                  <div key={scriptKey(s)} className="ssr">
                    <span className="mono">
                      <span style={{ color: "var(--text-3)" }}>{String(i + 1).padStart(2, "0")}</span>{" "}
                      {s.script_name} <span style={{ color: "var(--text-3)" }}>{vLabel(s.version)}</span>
                    </span>
                    <span className="pill pill-sync">
                      <span className="dot" />
                      applied · {fmtStatements(runStatus[scriptKey(s)]?.statements ?? 0)}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Verify re-diff — real lineage compare when the target is tracked */}
            <div className="card p-5">
              <div className="section-title mb-3">Verify diff</div>
              <DriftPanel
                phase={driftPhase}
                result={driftResult}
                error={driftError}
                context="verify"
                targetVersion={runLastVersion}
              />
            </div>
          </div>
        </section>
      )}

      <footer className="px-4 sm:px-8 pb-8 text-[12px]" style={{ color: "var(--text-3)" }}>
        Schema Studio · Deploy (S5)
      </footer>

      {/* Toast */}
      {toast && (
        <div className="toast show" role="status" aria-live="polite">
          {toast.kind === "ok" ? <CheckIcon size={14} /> : <AlertTriangleIcon size={14} />}
          <span>{toast.msg}</span>
        </div>
      )}
    </div>
  );
}

// Drift pre-check panel (Phase 6). Renders the real lineage drift state for the
// chosen target — or an honest "not tracked" message — in place of the old stub.
// Shared by the stage-1 pre-check, the stage-3 post-deploy verify and the check
// after a rollback; the copy shifts slightly via `context`.
function DriftPanel({
  phase,
  result,
  error,
  context,
  targetVersion,
}: {
  phase: DriftPhase;
  result: DriftResult | null;
  error: string | null;
  /**
   * "precheck" before a deploy, "verify" after one, "rollback" after a
   * rollback. The last two re-read a schema that has just changed.
   */
  context: "precheck" | "verify" | "rollback";
  targetVersion: string;
}) {
  // Defaults cover the loading state; each case below overrides what it needs.
  let icon = <span className="spin" style={{ width: 16, height: 16 }} />;
  let circle: React.CSSProperties = { background: "var(--surface-3)", color: "var(--text-3)" };
  let title =
    context === "precheck" ? "Checking the target for drift…" : "Re-checking the schema…";
  let body: React.ReactNode = "Comparing the live schema against its tracked snapshot.";
  let pillClass = "pill pill-neutral";
  let pillText = "checking";

  if (phase === "idle") {
    icon = <DriftIcon size={16} />;
    title = "Drift check not run yet";
    body = "Run a database check to compare the live schema against its tracked snapshot.";
    pillText = "idle";
  } else if (phase === "untracked") {
    icon = <DriftIcon size={16} />;
    title = "Target schema isn't tracked";
    body =
      "Track this schema on the Dashboard to capture a baseline snapshot — drift checks then compare the live structure against it. Until then Deploy assumes the target matches its migration ledger.";
    pillText = "not tracked";
  } else if (phase === "error") {
    icon = <AlertCircleIcon size={16} />;
    title = "Drift check couldn't run";
    body = error ?? "Something went wrong running the drift check.";
    pillText = "error";
  } else if (phase === "ready" && result) {
    // The snapshot's number is Schema Studio's lineage counter, not a script
    // version, so it says so, the way the dashboard labels it.
    const v = result.expectedVersion ? `lineage ${displayVersion(result.expectedVersion, true)}` : "its snapshot";
    if (result.status === "unreachable") {
      icon = <AlertTriangleIcon size={16} />;
      circle = {
        background: "color-mix(in oklab, var(--drift) 12%, var(--surface))",
        color: "var(--drift)",
      };
      title = "Target unreachable";
      body = result.summary;
      pillText = "unreachable";
    } else if (result.status === "in_sync") {
      icon = <CheckIcon size={16} />;
      circle = { background: "var(--sync-soft)", color: "var(--sync)" };
      title =
        context === "precheck"
          ? `No drift — target matches ${v}`
          : `Verified — live schema matches ${v}`;
      body = result.summary;
      pillClass = "pill pill-sync";
      pillText = "in sync";
    } else {
      // drifted
      icon = <DriftIcon size={16} />;
      circle = {
        background: "color-mix(in oklab, var(--drift) 12%, var(--surface))",
        color: "var(--drift)",
      };
      title = "Schema drift detected";
      body = (
        <>
          {result.summary}{" "}
          {context === "verify" ? (
            <>
              Re-snapshot the target on the Dashboard to record its structure after{" "}
              <span className="mono">{vLabel(targetVersion)}</span> as the new expected baseline.
            </>
          ) : context === "rollback" ? (
            /* The revert route records the structure it leaves as the new
               baseline, and its message says "Lineage advanced to ..." when it
               did, so drift seen here is not the rollback itself. */
            "A rollback records the structure it leaves as the new baseline, so this " +
            "drift is not the rollback itself. Either that record failed (the message " +
            "above says “Lineage advanced to …” when it worked), or something changed " +
            "the schema outside Schema Studio. Check the difference on the Dashboard " +
            "before re-snapshotting the target there."
          ) : (
            "Review before deploying — the live structure differs from its tracked snapshot."
          )}
        </>
      );
      pillClass = "pill pill-pending";
      pillText = "drift";
    }
  }

  return (
    <div className="precheck-muted">
      <div
        className="w-9 h-9 rounded-full grid place-items-center flex-none"
        style={circle}
      >
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[13.5px] font-semibold">{title}</div>
        <div className="text-[12.5px] mt-0.5" style={{ color: "var(--text-2)" }}>
          {body}
        </div>
      </div>
      <span className={pillClass}>{pillText}</span>
    </div>
  );
}

// Small checklist line — green check (ok), warn (ok=false), info, or stub.
function ChecklistItem({
  ok,
  info,
  stub,
  children,
}: {
  ok?: boolean;
  info?: boolean;
  stub?: boolean;
  children: React.ReactNode;
}) {
  let icon = <CheckIcon size={13} style={{ color: "var(--sync)" }} />;
  if (stub) icon = <span className="w-[13px] h-[13px] rounded-full inline-block flex-none" style={{ border: "1.5px dashed var(--text-3)" }} />;
  else if (info) icon = <InfoIcon size={13} style={{ color: "var(--pending)" }} />;
  else if (ok === false) icon = <AlertTriangleIcon size={13} style={{ color: "var(--drift)" }} />;
  return (
    <li className="flex items-center gap-2">
      <span className="flex-none grid place-items-center">{icon}</span>
      <span style={stub ? { color: "var(--text-3)" } : undefined}>{children}</span>
    </li>
  );
}
