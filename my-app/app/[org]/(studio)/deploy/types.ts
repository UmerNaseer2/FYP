// The shapes the Deploy page works with: a script pulled from GitHub, a saved
// connection, the answers of the preflight, apply and revert routes, and the
// state of a run and of the drift check. Types only, no code.

import type { TargetApplications } from "@/lib/deploy/application-targeting";
import type { ScriptChangeType } from "@/lib/versions/change-type";
import type { PulledRollbackState } from "@/lib/github/registry-push";

// The deploy screen's own name for a script's change type. The grading itself
// lives in lib/versions/change-type, so this screen and the generator can never disagree
// about what a script does.
export type ChangeKind = ScriptChangeType;

// A migration script, loaded from the GitHub repo (the source of truth).
export type GitHubScript = {
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
  /**
   * Retired in GitHub (a v<version>.retired.md note beside it): Deploy no
   * longer offers it. Optional, since an older pull route did not say.
   */
  retired?: boolean;
};

// A saved connection from /api/connections.
export type Connection = {
  id: number;
  name: string;
  host: string;
  port: number;
  database_name: string;
  type: string;
  /** Who may run migrations here: none, editor or admin. See lib/connections/access.ts. */
  execute_role?: string | null;
};

// One row of the target's applied history.
export type PatchEntry = {
  version: string;
  title: string | null;
  /**
   * The change log stored with the row (spec 07, "change logs with user
   * notes"). Optional: a row written by an older build, or by another tool,
   * has none.
   */
  description?: string | null;
  change_type: string;
  applied_at: string;
  /**
   * Who ran it. Optional: an older preflight route did not send it, and a
   * ledger row written before the column existed has no answer to give.
   */
  applied_by?: string | null;
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
export type PreflightResult = {
  hasVersionTable: boolean;
  needsInit: boolean;
  /** Does the schema exist on the target? See lib/deploy/init.ts. */
  /**
   * What the target says it hosts, read from the connection's application
   * table. Used here only to say so on screen, the apply route runs the same
   * check again and is the one that refuses, because a screen is a courtesy
   * and the rule has to hold whatever reaches the endpoint.
   */
  applications: TargetApplications;
  schemaExists: boolean;
  /** Its ordinary tables, not counting this app's own ledger tables. */
  tableCount: number;
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
export type RevertedEntry = {
  script_name: string;
  version: string;
  title: string | null;
  change_type: string | null;
  applied_at: string | null;
  /** Who applied it, carried into the archive by the revert route. Optional. */
  applied_by?: string | null;
  reverted_at: string;
  /** Who rolled it back. Optional for the same reason as applied_by. */
  reverted_by?: string | null;
};

// A version of ANOTHER script family applied after this family's versions.
// The preflight and the revert route both send these. applied_at is typed as
// nullable because the revert route's copy comes straight from the ledger.
export type OtherScriptEntry = {
  script_name: string;
  version: string;
  applied_at: string | null;
};

// Live status of a single migration during a run.
//
// "rehearsed" is a dry run's version of "applied": the SQL really executed
// against the target and then the whole run was rolled back.
// "unknown" is not a state the run passes through, it is what is left when
// the answer never arrived: the COMMIT did not report back, or the request
// itself never completed. Neither "applied" nor "skipped" is a thing this page
// can claim then, and picking one would send the reader off to do the wrong
// thing about half the time.
// "not-in-run" is a pending row the chosen target version stops short of. It
// is not a run state at all, the run never reaches it, but the pending list
// draws the same rows, and calling those "queued" promised the reader a run
// they had not asked for.
export type RunStatus =
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
// `warnings` are the warnings PostgreSQL sent while it ran, such as an owner
// change the login may not make (lib/deploy/run-warnings.ts), and
// `moreWarnings` counts any past the ones listed.
export type RunCell = {
  status: RunStatus;
  error?: string;
  statements?: number;
  warnings?: string[];
  moreWarnings?: number;
  /** Dry runs only: how the rehearsal of this version's rollback went. */
  rollbackCheck?: RollbackCheck;
  /** What PostgreSQL said when that rollback failed. */
  rollbackError?: string;
};

// How a dry run's try of one version's rollback went (the apply route's
// rehearseRollbacks). "none": the version has no rollback. "not_checked":
// the rehearsal stopped at a later version first.
export type RollbackCheck = "ok" | "failed" | "none" | "not_checked";

// What POST /api/scripts/apply reports for one migration in the run.
export type ApplyOutcome = {
  script_name: string;
  version: string;
  status: "applied" | "rehearsed" | "failed" | "skipped" | "unknown";
  statements?: number;
  error?: string;
  warnings?: string[];
  moreWarnings?: number;
  rollbackCheck?: RollbackCheck;
  rollbackError?: string;
};
// The parts of the apply response this page reads.
export type ApplyResponse = {
  success?: boolean;
  error?: string;
  results?: ApplyOutcome[];
  message?: string;
  /** Set on a dry run the server could not rehearse, see the 55P04 branch. */
  dryRunLimitation?: boolean;
  /** Set when the COMMIT did not report back, see the route's catch block. */
  outcomeUnknown?: boolean;
  /**
   * Set on every answer the route gives before its first write to the target
   * (answerBeforeRun there). lib/deploy/apply-failure is the one reading of it.
   */
  nothingRan?: boolean;
  /**
   * What the run recorded in the GitHub registry (spec 07). Unknown rather
   * than typed, because readArchivedVersions is the one place that decides
   * what a well-formed entry is, and an older server sends no such field.
   *
   * Nearly always absent HERE: Deploy's scripts were pulled from the registry,
   * so their files are already in it and the route leaves those out. It shows
   * up when a version could not be recorded, which on this screen means GitHub
   * went unreachable partway through a deploy.
   */
  registry?: unknown;
  /**
   * "run_stopped" when the run was ended partway: by Stop, or by one of its
   * time limits (lib/deploy/run-limits.ts). It rolled back like any failed run.
   */
  code?: string;
};

// The parts of POST /api/scripts/revert's response this page reads. Every
// refusal carries `error` and every success carries `message`: a sentence that
// says what happened and what state the target is in now. The page shows it
// as written, so the screen and the server never tell two different stories.
export type RevertResponse = {
  success?: boolean;
  error?: string;
  message?: string;
  dryRun?: boolean;
  /** The versions the route undid, or rehearsed, newest first. */
  versions?: string[];
  /**
   * Other families' versions applied after the oldest version this rollback
   * undoes, as the server counted them. Sent with a dry run's result and with
   * a refusal.
   */
  otherScripts?: OtherScriptEntry[];
  /** The caller may only run this with an approval, and none covers this exact rollback yet. */
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
export type DriftCounts = {
  tablesAdded: number;
  tablesRemoved: number;
  tablesChanged: number;
  constraintsChanged: number;
};
export type DriftResult = {
  status: "in_sync" | "drifted" | "unreachable";
  summary: string;
  counts: DriftCounts | null;
  expectedVersion: string | null;
  checkedAt: string;
};
// Where the lineage drift check stands for the chosen target.
export type DriftPhase = "idle" | "loading" | "untracked" | "ready" | "error";
