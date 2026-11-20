"use client";

import "@/app/styles/atelier-deploy.css";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { TargetPicker, type TargetChoice } from "@/components/studio/TargetPicker";
import { QuickRun, QuickRunButton, type QuickRunTarget } from "./QuickRun";
import { CheckIcon, AlertTriangleIcon } from "@/components/ui/icons";
import {
  compareVersions,
  buildVersionLedger,
  pendingPrefixThrough,
  versionKey,
  type LedgerEntry,
} from "@/lib/versions/script-status";
import { deployStage, patchPrompt, stagePrompt } from "@/lib/deploy/init";
import { checkApplications, readAppliesToHeader } from "@/lib/deploy/application-targeting";
import {
  containsTransactionControl,
  findRowDestroyingStatements,
  ROW_DESTROYING_NOT_BREAKING,
} from "@/lib/sql/guard";
import { analyseRunRisk } from "@/lib/deploy/risk";
import { readApplyFailure, type ApplyFailure } from "@/lib/deploy/apply-failure";
import { readRunWarnings } from "@/lib/deploy/run-warnings";
import { describeRegistry, readArchivedVersions, type RegistryNote } from "@/lib/github/registry-report";
import { describeChangeType } from "@/lib/versions/change-type";
import { changeNoteSummary, readChangeNote } from "@/lib/versions/change-note";
import type { DeployAttemptRow } from "@/lib/deploy/attempts";
import { countOf } from "@/lib/ui/plural";
import { ErrorNotice } from "@/components/ui/ErrorNotice";
import { SetupChecklist, type SetupStep } from "@/components/ui/SetupChecklist";
import { canExecute, toExecuteRole } from "@/lib/connections/access";
import { describeError } from "@/lib/ui/friendly-error";
import { refusalMessage } from "@/lib/roles/permissions";
import { rollbackFingerprintBody } from "@/lib/deploy/approval-fingerprint";
import {
  listVersions,
  MAX_ROLLBACK_VERSIONS,
  planRollback,
  rollbackTargets,
  versionRange,
  vLabel,
} from "@/lib/deploy/rollback-plan";
import { normalizeChangeLevel } from "@/lib/versions/change-level";
import {
  mergeTimelines,
  outdatedSideOfEntries,
  timelineKey,
  versionTitle,
  type TimelineEntry,
  type TimelineRow,
} from "@/lib/versions/timeline";
import { useUser } from "@/hooks/useUser";
import { useOrgHref } from "@/hooks/useOrg";
import { sha256Hex, type ApprovalRow } from "@/components/studio/ApprovalPanel";
import { RunTimeline } from "./RunTimeline";
import { PageHeader } from "@/components/studio/PageHeader";
import { apiFetch } from "@/lib/ui/api-fetch";
import { newRunId } from "@/lib/deploy/run-id";
import { REQUESTS_CHANGED_EVENT } from "@/lib/roles/access-requests";
import type {
  GitHubScript,
  Connection,
  PreflightResult,
  OtherScriptEntry,
  RunStatus,
  RunCell,
  ApplyOutcome,
  ApplyResponse,
  RevertResponse,
  DriftResult,
  DriftPhase,
} from "./types";
import {
  changeTypeSent,
  sortGitHubScriptsByVersion,
  scriptKey,
  getSqlLineCount,
  bumpWord,
  ledgerStatus,
  batchBody,
  selectionChange,
  nameTwoRuns,
  retiredNote,
  warningCount,
  readRollbackCheck,
} from "./helpers";
import {
  BEFORE_FIRST,
  rollbackProblemText,
  rowLossKinds,
  APPROVAL_REQUESTED_TOAST,
} from "./row-notes";
import { DriftPanel } from "./DriftPanel";
import { HeadNotes, TargetCard, ShipsCard, VersionTimelineCard } from "./PreflightCards";
import { RollbackCard } from "./RollbackCard";
import { PendingCard } from "./PendingCard";
import { ShipChecklist } from "./ShipChecklist";
import { RunPanel } from "./RunPanel";
import { RunHead, RunList, RunResults } from "./RunStage";
import { VerifyCards } from "./VerifyStage";
import { RetireVersionDialog } from "./RetireVersionDialog";

// ---------------------------------------------------------------------------
// Deploy (S5): Pre-flight → Run → Verify stepper.
//
// This is the Pass-6 reskin of the deploy panel that used to live inside the
// legacy /scripts page. The page previews the run and warns about each risk
// it finds; the server does not take its word for any of it.
// /api/scripts/apply refuses a run that is out of order, or that needs an
// approval it does not have. The flow:
//   • GitHub is the source of truth for migration scripts (/api/github/pull).
//   • /api/scripts/preflight reads the target DB's script_patch ledger and
//     returns the current version + applied history.
//   • pendingScripts = GitHub scripts for (schema, group) whose semver is
//     greater than the target's current version.
//   • /api/scripts/apply takes the WHOLE batch in one request and runs it in
//     one transaction. All of them or none of them, a failure anywhere rolls
//     the run back, so there is no partial deploy to unwind by hand. A real run
//     first commits the ledger table and any enum value the batch adds, which
//     no rollback can take back. The same call with dryRun skips those two and
//     rehearses the batch in a transaction that always ends in ROLLBACK.
//
// Nothing on this screen is stubbed. The drift pre-check (stage 1) and the
// verify re-diff after a run (stage 3) are live: runDriftCheck finds the
// target's lineage snapshot (/api/lineage/lookup) and diffs the live schema
// against it (/api/lineage/drift), and DriftPanel draws the answer (the
// rollback card reuses it). Versions, the pending list, per-step timing and
// the ledger re-read after a run are all read from the target too.
//
// Each registry version of the family is Applied, Pending or Skipped
// (buildVersionLedger in lib/versions/script-status). Skipped means never applied and
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

function DeployBody() {
  // Who is looking, and what their role may do here. The approval panel needs
  // to know whether to offer Approve at all (a box an admin ticks for a role
  // on the Admin screen), and whether this is the same person who asked for
  // the run (nobody approves their own).
  const { user, role, roleLabel, isAdmin, bypass, can, viewingAs, loading: sessionLoading } = useUser();
  const orgPath = useOrgHref();
  const mayReadApprovals = can("approvals:read");
  // Said at the top of the page, as Dashboard and Connections do, so a role
  // that may only look finds out before picking a target rather than after.
  // A rehearsal runs through the same route as a real run, so it needs the
  // same permission.
  const runRefusal =
    sessionLoading || can("deploy:run") ? null : refusalMessage(roleLabel, "deploy:run");
  // A link from the Requests page names the run it is about, so the reader lands
  // on that target with it checked. Each part is used when its list arrives, and
  // one no list holds is ignored, because the link may be old. Choosing anything
  // by hand drops what is left of it.
  const searchParams = useSearchParams();
  const linked = useRef({
    connection: searchParams.get("connection"),
    schema: searchParams.get("schema"),
    script: searchParams.get("script"),
    version: searchParams.get("version"),
  });
  const forgetLink = () => {
    linked.current = { connection: null, schema: null, script: null, version: null };
  };
  const mayApprove = can("approvals:approve");

  // ── Selection state ──────────────────────────────────────────────────────
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectionsLoaded, setConnectionsLoaded] = useState(false);
  const [connectionsFailed, setConnectionsFailed] = useState(false);
  const [connectionId, setConnectionId] = useState<string>("");
  const [schemas, setSchemas] = useState<string[]>([]);
  const [schemasLoading, setSchemasLoading] = useState(false);
  const [schemasError, setSchemasError] = useState<string | null>(null);
  const [schema, setSchema] = useState<string>("");
  // The connection whose schemas were asked for last, so an answer for a
  // connection the reader has already moved away from is ignored.
  const schemasFor = useRef("");
  const [scriptGroup, setScriptGroup] = useState<string>("");

  // ── GitHub script source ─────────────────────────────────────────────────
  const [githubScripts, setGithubScripts] = useState<GitHubScript[] | null>(null);
  const [pullLoading, setPullLoading] = useState(false);
  const [pullError, setPullError] = useState<string | null>(null);
  // True when the pull answered that GitHub is not set up for this
  // organization. That is a setup step still to do, not a failure, so the
  // page shows it in the setup checklist and not as an error.
  const [githubMissing, setGithubMissing] = useState(false);
  // What the pull could not read: a family folder, a version file, a rollback
  // file. The rest of the registry still loads, so the page lists what is
  // missing instead of letting it pass as "not there".
  const [pullWarnings, setPullWarnings] = useState<string[]>([]);

  // ── Pre-flight + target ──────────────────────────────────────────────────
  const [preflightResult, setPreflightResult] = useState<PreflightResult | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  // A ticket number for the newest read of the target: one for the ledger, one
  // for the drift check. Changing the target takes a new ticket, so an answer
  // still on its way for the old target is dropped when it lands, instead of
  // being shown under the new target's name.
  const preflightSeq = useRef(0);
  const driftSeq = useRef(0);
  const [targetVersion, setTargetVersion] = useState<string>("");
  /**
   * What has been ATTEMPTED against this schema, successful or not (spec 07,
   * "Track SQL execution history for auditing").
   *
   * Separate from the applied history above, and read from a different
   * database, because it answers a different question. The target's ledger is
   * written inside the run's transaction, so a run that failed, was refused or
   * timed out waiting for a lock leaves nothing behind on the target at all.
   * These rows are this app's own record of the attempt, which no ROLLBACK on
   * the target can reach.
   */
  const [attempts, setAttempts] = useState<DeployAttemptRow[]>([]);
  // Where a "Run …" button takes the reader: the run panel, at its Deploy
  // button. And where "Roll back to here…" in
  // the version timeline takes them: the Roll back card.
  const runPanelRef = useRef<HTMLDivElement>(null);
  const deployButtonRef = useRef<HTMLButtonElement>(null);
  const rollbackCardRef = useRef<HTMLDivElement>(null);

  // ── Deploy approvals ─────────────────────────────────────────────────────
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
  // reported it before this check ran. When this check fails the drift
  // warning is still shown from that record (see driftGateStatus).
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
  // The deploy or rollback going now, so Stop can name it to the server. The
  // page makes the run's id itself and sends it with the run, so Stop works
  // while the run's own request is still waiting for its answer. null when
  // nothing is running.
  const activeRunRef = useRef<{ runId: string; connectionId: number } | null>(null);
  // True from a Stop press until the run ends, so the button says so.
  const [stopBusy, setStopBusy] = useState(false);
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
  // The rollback's own approval: the fingerprint of the rollback SQL on
  // screen, and the note and errors of its request and decisions.
  const [rollbackHash, setRollbackHash] = useState<string | null>(null);
  const [rollbackHashError, setRollbackHashError] = useState<string | null>(null);
  const [rollbackApprovalError, setRollbackApprovalError] = useState<string | null>(null);
  const [rollbackApprovalNote, setRollbackApprovalNote] = useState("");

  // ── Stepper + run ────────────────────────────────────────────────────────
  const [stage, setStage] = useState<1 | 2 | 3>(1);
  const [isDeploying, setIsDeploying] = useState(false);
  // Quick run: the side panel that runs typed (or AI-written) SQL as the next
  // version of a script group, through the same apply route. See QuickRun.tsx.
  const [quickOpen, setQuickOpen] = useState(false);
  // Retire: the version the Retire dialog asks about (null while it is
  // closed) and its request. See RetireVersionDialog.tsx and
  // app/api/github/retire/route.ts.
  const [retireScript, setRetireScript] = useState<GitHubScript | null>(null);
  const [retireBusy, setRetireBusy] = useState(false);
  const [retireError, setRetireError] = useState<string | null>(null);
  // The exact ordered batch captured at run start, the run/verify lists render
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
  // Was the target empty when this run started? Spec feature 11 asks the
  // screen to offer the patches "after initialization", and by the time the
  // run finishes the ledger has been re-read and the target is no longer
  // empty, so the answer has to be taken before the run, not worked out
  // afterwards from a target that has already changed under it.
  const [runInitialised, setRunInitialised] = useState(false);
  // What the last clean dry run rehearsed (its batchBody), or null. "Deploy
  // for real" deploys the current selection, so it is offered only while the
  // selection's body is this one: a rehearsal of v5.0.1 → v5.0.2 must not
  // clear a deploy of v5.0.1 → v6.0.0, nor SQL that a re-pull has changed.
  const [rehearsedBody, setRehearsedBody] = useState<string | null>(null);
  // A failure that belongs to the run rather than to any one migration, a
  // rejected request, an unreadable response, a connection that never landed.
  const [runError, setRunError] = useState<string | null>(null);
  // How the last run failed, as lib/deploy/apply-failure reads the answer; null after
  // a success and before any run. A refused run (a 4xx) and one that never
  // started (a 5xx the server marks nothingRan) never got going, so the rows,
  // the header and the recovery bar name what happened rather than saying
  // "rolled back", which would describe a run that did. An unknown outcome
  // shows in the rows themselves (runOutcomeUnknown below).
  const [runFailure, setRunFailure] = useState<ApplyFailure | null>(null);
  // What the last run added to the GitHub registry, and what it could not.
  // Null when there is nothing to say, which is the usual answer here.
  const [runRegistry, setRunRegistry] = useState<RegistryNote | null>(null);
  const runRefused = runFailure === "refused";
  const runNotStarted = runFailure === "not-started";
  // The last dry run stopped on a limit of the rehearsal itself (the server's
  // dryRunLimitation): an enum value added and then used in one run. The page
  // says so instead of calling the script failed.
  const [runLimited, setRunLimited] = useState(false);
  // What the ledger re-read after a run found (runBatch starts it right after
  // runComplete). While it is in flight the old reading is still on screen,
  // and a failed one sets preflightResult to null (nothing else does once a
  // run has started), so neither may be described as a re-read ledger. The
  // failure is said here on the Run step, because its preflightError banner
  // only shows on Pre-flight and Verify.
  const ledgerReread: "reading" | "read" | "failed" = preflightLoading
    ? "reading"
    : preflightResult !== null
      ? "read"
      : "failed";
  // A server message can end without a full stop ('... does not exist'), and
  // the next sentence follows it, so one is added when it is missing.
  const rereadReason = (preflightError ?? "the pre-flight check failed").trim();
  const ledgerRereadFailed =
    `The ledger could not be read again: ${rereadReason}${/[.!?]$/.test(rereadReason) ? "" : "."} ` +
    "Press Check database on Pre-flight to read it.";

  const timerRef = useRef<number | null>(null);
  const runStartRef = useRef(0);

  // ── Toast ────────────────────────────────────────────────────────────────
  // The toast carries failures as well as successes, so it has to know which
  // it is holding, a green tick over "Deploy failed" reads as the opposite of
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
    apiFetch("/api/connections", { cache: "no-store" })
      .then(async (r) => (r.ok ? ((await r.json()) as unknown) : null))
      .then((data: unknown) => {
        // An unreadable list is not an empty one. Saying "add a connection
        // first" when the app database is down sends the user to a page that
        // will fail the same way.
        if (Array.isArray(data)) {
          const list = data as Connection[];
          setConnections(list);
          const wanted = linked.current.connection;
          if (wanted && list.some((c) => String(c.id) === wanted)) {
            setConnectionId(wanted);
            setSchemasLoading(true);
          }
        } else {
          setConnectionsFailed(true);
        }
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

  // ── Setup: what Deploy needs before it can do anything ───────────────────
  // Three things: a connection, GitHub set up for the organization, and at
  // least one saved migration. All three come from the two lists the page
  // already loads (connections and the GitHub pull), so nothing extra is asked.
  const mayDeploy = can("deploy:run");
  const maySetUpGitHub = can("github:update");
  // GitHub was set up, but the saved token was locked with another key.
  const githubTokenUnreadable = githubMissing && /can.?t be read/i.test(pullError ?? "");
  // Nothing is said about setup until both lists and the role have arrived.
  const setupKnown = connectionsLoaded && !pullLoading && !sessionLoading;
  const hasConnection = connections.length > 0;
  const savedMigrationCount = githubScripts?.length ?? 0;
  // A list that could not be read is a failure, not a missing step, so it
  // does not put the checklist up by itself.
  const connectionMissing = !connectionsFailed && !hasConnection;
  const migrationMissing = githubMissing || (githubScripts !== null && savedMigrationCount === 0);
  const needsSetup = setupKnown && (connectionMissing || migrationMissing);
  // Somebody who can neither run a deploy nor set up GitHub has nothing to do
  // on a checklist, so they get one plain line and the run history instead.
  const onlyLooks = !mayDeploy && !maySetUpGitHub;
  const historyOnly = needsSetup && onlyLooks;

  // The selected target's execution setting, and whether this caller clears it.
  //
  // useUser reads the role out of the same session the API routes read it out
  // of, so the page can answer this rather than hedge. It is still only a
  // prediction of what the route will say, the route re-checks on its own, and
  // it is the one that counts, but a button that greys itself out for the
  // right stated reason beats one that lets you press it and come back with a
  // 403 you have to interpret.
  //
  // Read-only is the case worth separating: it refuses everybody, admins
  // included, so it is not "your role is too low" and must not be worded that
  // way. See lib/connection-access.
  const targetExecuteRole = toExecuteRole(activeConn?.execute_role);
  const targetIsReadOnly = targetExecuteRole === "none";
  const mayExecuteOnTarget = canExecute(
    { isAdmin, mayDeploy: can("deploy:run") },
    targetExecuteRole
  );
  // Why not, for the short lines under the buttons. Admins only is named first
  // because it is the one "Deploy: Run" would not fix: on such a connection a
  // role that may deploy everywhere else is still refused.
  const executeBlockedWhy =
    targetExecuteRole === "admin"
      ? "is limited to admins"
      : `needs a role that may run deployments, and yours (${roleLabel}) may not`;
  // Somebody who may not run here by themselves can still ask an Admin to
  // approve one exact run (or rollback), and then run it once. Never on a
  // read-only connection, and never as a dry run: the routes refuse both.
  const askToRun = !sessionLoading && !mayExecuteOnTarget && !targetIsReadOnly;
  // The approvals are read for somebody who has to ask, and for somebody who
  // may answer. Anybody else just runs, so there is nothing to show them.
  const approvalsWanted = askToRun || (!sessionLoading && mayApprove);
  // Which approvals this person's run may use, the same rule as the server's:
  // somebody asking to run spends only their own one-off. Nobody else needs
  // an approval at all.
  const viewerEmailLower = (user?.email ?? "").toLowerCase();
  const usableApproval = useCallback(
    (a: ApprovalRow) =>
      askToRun && a.run_by_requester === true && a.requested_by.toLowerCase() === viewerEmailLower,
    [askToRun, viewerEmailLower]
  );
  // Somebody else's ask that this person may answer.
  const answerableAsk = useCallback(
    (a: ApprovalRow) =>
      mayApprove &&
      a.status === "pending" &&
      a.run_by_requester === true &&
      a.requested_by.toLowerCase() !== viewerEmailLower,
    [mayApprove, viewerEmailLower]
  );

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

  // Every version in GitHub strictly greater than the target's version,
  // oldest first, retired or not.
  const aboveTarget = useMemo<GitHubScript[]>(() => {
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

  // Scripts not yet applied to the target, strictly greater than its version.
  // A version retired in GitHub (a .retired.md note beside it) is left out, so
  // it no longer blocks the versions after it. The retired ones are named on
  // screen instead, so none of them disappears without a word.
  const aheadOfTarget = useMemo(() => aboveTarget.filter((s) => !s.retired), [aboveTarget]);
  const retiredAhead = useMemo(
    () => aboveTarget.filter((s) => s.retired).map((s) => s.version),
    [aboveTarget]
  );

  // Of those, the ones addressed to some other application, the target's
  // application table was read, it names applications, and none of them is one
  // the script's "Applies-to" header lists.
  //
  // They are separated out rather than left in the list because a run is a
  // contiguous range of versions: a script that cannot run and cannot be
  // stepped over blocks every later version behind it, and the screen ends up
  // telling the reader to "pick a range without it" when no such range exists.
  // Stepping over this one case is safe by the feature's own premise, the
  // script touches another application's tables, which are not in this
  // database, and it is the only refusal that may be stepped over. See
  // addressedElsewhere in lib/deploy/application-targeting.ts for the other two.
  const addressedElsewhere = useMemo<GitHubScript[]>(() => {
    const applications = preflightResult?.applications ?? { known: false, names: [], source: null };
    return aheadOfTarget.filter(
      (s) => checkApplications(readAppliesToHeader(s.sql_content), applications).addressedElsewhere
    );
  }, [aheadOfTarget, preflightResult]);

  // What this database is actually being asked to run. Nothing disappears
  // quietly: the versions taken out are listed on screen right below.
  const pendingScripts = useMemo<GitHubScript[]>(() => {
    if (addressedElsewhere.length === 0) return aheadOfTarget;
    const skip = new Set(addressedElsewhere.map((s) => scriptKey(s)));
    return aheadOfTarget.filter((s) => !skip.has(scriptKey(s)));
  }, [aheadOfTarget, addressedElsewhere]);

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
  // inputs are scoped to one (database, schema, script_name), scopedScripts is
  // already database-filtered, the schema filter narrows it, and the preflight
  // timeline is the target DB's script_patch for this exact family, so two
  // databases sharing a script_name@version can never cross-contaminate.
  const versionLedger = useMemo<LedgerEntry[]>(() => {
    if (!scriptGroup || !preflightResult) return [];
    const familyScripts = (groupedScripts[scriptGroup] ?? []).filter(
      (s) => s.schema_name === schema
    );
    return buildVersionLedger(
      familyScripts.map((s) => s.version),
      preflightResult.timeline,
      familyScripts.filter((s) => s.retired).map((s) => s.version)
    );
  }, [scriptGroup, preflightResult, groupedScripts, schema]);

  const appliedCount = versionLedger.filter((e) => e.status === "applied").length;
  const pendingCount = versionLedger.filter((e) => e.status === "pending").length;
  // Versions a deploy will never run: never applied and below the target's
  // version. The ledger, the up-to-date card and the run panel all name them.
  const skippedVersions = versionLedger
    .filter((e) => e.status === "skipped")
    .map((e) => e.version);

  // A version we asked for is not a version we read, never print one as the
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

  // Spec feature 11: "If no schema or tables exist, prompt to run
  // /scripts_init." Which of the three states this target is in, and the one
  // thing worth saying about it. Both come from lib/deploy/init.ts rather than
  // being decided here, because the after-the-run prompt has to agree with
  // this one about what "initialised" meant.
  const targetStage = preflightResult
    ? deployStage({
        schemaExists: preflightResult.schemaExists,
        tableCount: preflightResult.tableCount,
        hasVersionTable: preflightResult.hasVersionTable,
        currentVersion: preflightResult.currentVersion,
      })
    : null;
  const targetPrompt =
    preflightResult && targetStage
      ? stagePrompt(
          {
            schemaExists: preflightResult.schemaExists,
            tableCount: preflightResult.tableCount,
            hasVersionTable: preflightResult.hasVersionTable,
            currentVersion: preflightResult.currentVersion,
          },
          targetStage,
          pendingScripts.length > 0 ? vLabel(pendingScripts[0].version) : null,
          (preflightResult.reverted ?? []).length > 0
        )
      : null;

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
        ? { value: target, label: `${vLabel(target)} · undo ${undone(undoCount)}` }
        : {
            value: BEFORE_FIRST,
            label:
              undoCount === 1
                ? `Before the first version · undo ${vLabel(appliedNewestFirst[0])}`
                : `Before the first version · undo all ${undoCount} versions`,
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
  // with the SQL that undoes it. A dry run's result and the
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
  // False when all that was found is SQL that could not be read: the box then
  // says "may delete rows", not "deletes rows".
  const rollbackLossSure = rollbackDataLoss.some((loss) => rowLossKinds(loss.kinds).named.length > 0);

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
        ? approvals.filter(
            (a) => a.action === "revert" && a.run_fingerprint === rollbackHash && usableApproval(a)
          )
        : [],
    [approvals, rollbackHash, usableApproval]
  );
  const approvedRollback = rollbackApprovals.find((a) => a.status === "approved") ?? null;
  const pendingRollback = rollbackApprovals.find((a) => a.status === "pending") ?? null;
  const latestRollback = rollbackApprovals[0] ?? null;
  // Somebody else asking to run exactly this rollback, for the person who may answer.
  const rollbackAsk = useMemo(
    () =>
      rollbackHash
        ? approvals.find(
            (a) => a.action === "revert" && a.run_fingerprint === rollbackHash && answerableAsk(a)
          ) ?? null
        : null,
    [approvals, rollbackHash, answerableAsk]
  );

  // What stops both rollback buttons. The warnings about lost rows and other
  // scripts are shown and stop nothing.
  const rollbackBlocked =
    !rollbackReady ||
    // A target this caller may not execute against refuses a rollback for the
    // same reason it refuses a deploy: a rollback executes SQL. It is if
    // anything the one to be surer about, it drops what a migration added.
    // Unless they may ask for one: then the approval below is what stops it.
    (!mayExecuteOnTarget && !askToRun) ||
    rollbackBusy !== null ||
    isDeploying;
  // What additionally stops the real rollback: the approval, for somebody who
  // may only run with one.
  const rollbackRunBlocked = rollbackBlocked || (askToRun && !approvedRollback);
  // The line under the buttons: the first reason they are disabled, or what
  // pressing will do. Same order as the checks above.
  const rollbackHint = !rollbackReady
    ? "Every version above needs a rollback that can run before anything runs"
    : targetIsReadOnly
      ? "This connection is marked read-only, so nothing here will run against it"
    : !mayExecuteOnTarget && !askToRun
      ? `Rolling back on this connection ${executeBlockedWhy}`
    : isDeploying
      ? "A deploy is running on this target. Wait for it to finish"
      : askToRun && !approvedRollback
        ? "Your role may not roll back here by itself, so this waits for an Admin to approve it. " +
          "A dry run runs the same SQL on the live database, so your role can't start one here either"
        : "The rollback runs in one transaction: every version above or none";
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
      appliedBy: row.applied_by ?? null,
      changeType: normalizeChangeLevel(row.change_type),
      sqlContent: row.sql_content ?? null,
      // A title that is only the script group's name or the version itself
      // says nothing beside the group heading and the version, so it is not
      // shown. Any other title is, and failing that, the change log the
      // author wrote, which is the only human sentence most rows carry (this
      // screen sends the script's own name as the title). Only its first line
      // goes here, since a row is one line; the rest is in the note's header,
      // visible with the script when the row is opened.
      label: versionTitle(row.title, row.version, scriptGroup) ?? changeNoteSummary(row.description),
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

  // The approval error belongs to one exact plan. The rollback
  // error carries its own plan instead (see rollbackError), because some have
  // to stay on screen after the plan changes: an outcome nobody knows, and a
  // refusal caused by an out-of-date list of applied versions (the page reads
  // the ledger again, which changes the plan).
  useEffect(() => {
    setRollbackApprovalError(null);
  }, [rollbackKey]);

  // The fingerprint of the rollback on screen, hashed the way the server
  // hashes it (rollbackFingerprintBody over the steps, newest first, each
  // version spelled as the ledger spells it), so the approval panel can tell
  // whether an approval covers exactly this rollback. Only for somebody who
  // asks or answers, and only when every step has SQL: an approval covers the
  // SQL that runs.
  useEffect(() => {
    // Cleared first, so the previous plan's hash never matches for a moment.
    setRollbackHash(null);
    setRollbackHashError(null);
    if (!approvalsWanted || !rollbackReady) return;
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
          "This browser could not hash the rollback to check its approval. " +
            "Reload the page and try again."
        );
      });
    return () => {
      cancelled = true;
    };
  }, [approvalsWanted, rollbackReady, rollbackSteps, scriptGroup]);

  // The runs the AI review reads, spelled the way the approval request spells
  // them, so the review and an approval are about the same scripts.
  const reviewScripts = useMemo(
    () =>
      scriptsUpToTarget.map((s) => ({ scriptName: s.script_name, version: s.version, sqlContent: s.sql_content })),
    [scriptsUpToTarget]
  );
  const rollbackReviewScripts = useMemo(
    () =>
      rollbackSteps.map((step) => ({
        scriptName: scriptGroup.trim(),
        version: step.version,
        sqlContent: "sql" in step.resolved ? step.resolved.sql : "",
      })),
    [rollbackSteps, scriptGroup]
  );

  // The last of a link from the Requests page: its script, then the same read of
  // the target that "Check database" does, which is what the reader came to see.
  useEffect(() => {
    const wanted = linked.current.script;
    if (!wanted || !connectionId || !schema || !schemaScriptNames.includes(wanted)) return;
    linked.current.script = null;
    setScriptGroup(wanted);
    void runPreflightCheck(connectionId, schema, wanted);
    void runDriftCheck(connectionId, schema);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schemaScriptNames]);

  // Default the target to the latest pending version once pre-flight returns.
  // Re-runs after a partial deploy keep a still-valid pick, else snap to latest.
  useEffect(() => {
    if (stage !== 1) return;
    if (pendingScripts.length === 0) {
      if (targetVersion) setTargetVersion("");
      return;
    }
    const versions = pendingScripts.map((s) => s.version);
    const wanted = linked.current.version;
    if (wanted && versions.includes(wanted)) {
      linked.current.version = null;
      setTargetVersion(wanted);
      return;
    }
    if (!targetVersion || !versions.includes(targetVersion)) {
      setTargetVersion(pendingScripts[pendingScripts.length - 1].version);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingScripts, stage]);

  // What the chosen batch risks, from one reading of its SQL. The same helper
  // (lib/deploy/risk) gives the breaking count an approver is shown. Each migration is read with the
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
    return order.filter((b) => present.has(b)).join(" + ") || "None";
  }, [scriptsUpToTarget]);
  const txnViolationScripts = scriptsUpToTarget.filter((s) => containsTransactionControl(s.sql_content));
  const hasTxnViolation = txnViolationScripts.length > 0;
  // Asked separately from the change type, because they are separate questions.
  // The change type answers "how far does the version move", and a TRUNCATE moves
  // it not at all, so a run that empties a table used to arrive here graded
  // "patch" with the checklist reporting that nothing in it was breaking.
  // The migrations that delete rows, each with the statements that do it.
  const dataLossScripts = runRisk.dataLoss;
  // Named rather than counted: "TRUNCATE, DELETE" tells the reader what to go
  // and look for, where "3 statements" tells them only that there are three.
  const dataLoss = useMemo(
    () => rowLossKinds([...new Set(dataLossScripts.flatMap((entry) => entry.kinds))]),
    [dataLossScripts]
  );
  const dataLossKinds = dataLoss.named.join(", ");
  // False when all that was found is SQL that could not be read (an EXECUTE in
  // a DO block). The page then says "may delete rows", not "deletes rows".
  const dataLossSure = dataLoss.named.length > 0;
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
  // constraint over duplicates. Nothing above catches them, they break no
  // contract and delete nothing, so a run that cannot possibly commit used to
  // arrive here with a clean checklist.
  //
  // Warned about quietly. The run is one transaction, so a failure here
  // leaves the target exactly as it was.
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
  // undo everything, six times over, has even opened, and PostgreSQL has no
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
        // sha256Hex falls back to a plain version when crypto.subtle is
        // missing, so this is rare. Say so instead of silently reporting every
        // run as unapproved, which would look like the approval had gone missing.
        setRunHash(null);
        setHashError(
          "This browser could not hash the run to check its approval. " +
            "Reload the page and try again."
        );
      });
    return () => {
      cancelled = true;
    };
    // The body, not the array: a re-read that finds the same scripts builds
    // a new array, and the hash of the same text is the same hash.
  }, [scriptsUpToTarget.length, selectionBody]);

  // Approvals are only read for somebody who has to ask for one, or who may
  // answer one. Fetching them for anybody else would put a panel on screen
  // that gates nothing.
  //
  // Nor for a role that may not see them. The route would refuse anyway, and
  // saying why up front reads better than a 403. The panel then calls the
  // state unknown rather than "nothing requested yet", which is the truth.
  useEffect(() => {
    if (!approvalsWanted || !connectionId || !schema || !scriptGroup) {
      setApprovals([]);
      setApprovalsReadError(null);
      return;
    }
    if (!mayReadApprovals) {
      setApprovals([]);
      setApprovalsLoading(false);
      setApprovalsReadError(refusalMessage(roleLabel, "approvals:read"));
      return;
    }
    let cancelled = false;
    setApprovalsLoading(true);
    const url =
      `/api/deploy/approvals?connectionId=${encodeURIComponent(connectionId)}` +
      `&schemaName=${encodeURIComponent(schema)}` +
      `&scriptName=${encodeURIComponent(scriptGroup)}`;
    apiFetch(url, { cache: "no-store" })
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
  }, [
    approvalsWanted,
    connectionId,
    schema,
    scriptGroup,
    approvalReloadKey,
    mayReadApprovals,
    roleLabel,
  ]);

  // Whatever moved this on may have changed the number beside Requests on the rail.
  useEffect(() => {
    if (approvalReloadKey > 0) window.dispatchEvent(new Event(REQUESTS_CHANGED_EVENT));
  }, [approvalReloadKey]);

  // Every approval row for this exact batch, newest first (the API orders by
  // id DESC). Anything with a different fingerprint belongs to different SQL
  // and must not count towards this run.
  const runApprovals = useMemo(
    () =>
      runHash
        ? approvals.filter(
            // A row with no action predates rollback approvals, so it is a deploy.
            (a) => (a.action ?? "deploy") === "deploy" && a.run_fingerprint === runHash && usableApproval(a)
          )
        : [],
    [approvals, runHash, usableApproval]
  );
  const approvedRun = runApprovals.find((a) => a.status === "approved") ?? null;
  const pendingRun = runApprovals.find((a) => a.status === "pending") ?? null;
  const latestRun = runApprovals[0] ?? null;
  // Somebody else asking to run exactly this batch, for the person who may answer.
  const runAsk = useMemo(
    () =>
      runHash
        ? approvals.find(
            (a) => (a.action ?? "deploy") === "deploy" && a.run_fingerprint === runHash && answerableAsk(a)
          ) ?? null
        : null,
    [approvals, runHash, answerableAsk]
  );
  // The newest approved, unspent deploy approval for this target that is not
  // for this selection: approved for another range, or for SQL that has
  // changed since. The approval panel names it, so "Needs an Admin's approval"
  // never sits beside an approval without saying why it does not count.
  const otherApproval = useMemo(
    () =>
      !approvedRun && runHash
        ? approvals.find(
            (a) =>
              (a.action ?? "deploy") === "deploy" &&
              a.status === "approved" &&
              a.run_fingerprint !== runHash &&
              usableApproval(a)
          ) ?? null
        : null,
    [approvals, approvedRun, runHash, usableApproval]
  );
  // The pending version that range ends at, as the registry spells it, so
  // "Select that range" can pick it. null when it is not pending any more (it
  // ran, or left the registry); the panel then says it cannot be selected.
  const otherApprovalVersion = otherApproval
    ? pendingScripts.find((s) => versionKey(s.version) === versionKey(otherApproval.target_version))
        ?.version ?? null
    : null;
  // Versions in the selection this target is not allowed to run, by their
  // "Applies-to" header. The apply route refuses the whole run over any one of
  // them, so a dry run is blocked too: a rehearsal that stops at the same 409
  // teaches the reader nothing the row note has not already said.
  const blockedByApplication = scriptsUpToTarget.filter(
    (script) =>
      !checkApplications(
        readAppliesToHeader(script.sql_content),
        preflightResult?.applications ?? { known: false, names: [], source: null }
      ).allowed
  );

  // What stops a run starting at all. Deploy and Dry run share it: a rehearsal
  // writes nothing but still executes every statement against the real target,
  // so the same preconditions apply to both.
  // A drift result that is not "in sync" means the target is not the database
  // these migrations were written against. That is a reason to stop and look,
  // not a reason to forbid the run, so it is a warning.
  //
  // Which drift result the warning is about, or null when there is none. A
  // check that finished speaks for itself (it is also the new record). A check
  // that failed this time falls back to the last result on record.
  const driftGateStatus: "drifted" | "unreachable" | null =
    driftPhase === "ready" && driftResult !== null && driftResult.status !== "in_sync"
      ? driftResult.status
      : driftPhase === "error" &&
          (storedDriftStatus === "drifted" || storedDriftStatus === "unreachable")
        ? storedDriftStatus
        : null;
  // True when the warning is about the record because this check failed.
  const driftGateFromRecord = driftGateStatus !== null && driftPhase === "error";
  // A drift check that is still running holds both runs back, so a run never
  // starts before the reader has seen the warning its result may bring.
  const driftChecking = driftPhase === "loading";
  const runBlocked =
    scriptsUpToTarget.length === 0 ||
    // Dry runs included, because the route refuses those too: a rehearsal
    // really executes the script against the target and only then rolls back.
    // A button that started one here would be a promise this app cannot keep.
    // Somebody who may ask is let through to the approval; their dry run
    // buttons are off on their own (see dryRunBlocked).
    (!mayExecuteOnTarget && !askToRun) ||
    hasTxnViolation ||
    blockedByApplication.length > 0 ||
    isDeploying ||
    // A rollback in flight is changing the same ledger.
    rollbackBusy !== null ||
    driftChecking;
  // A real deploy by somebody who may only run with an approval waits for it.
  const deployBlocked = runBlocked || (askToRun && !approvedRun);
  // A rehearsal runs the SQL too, and an approval never covers one, so
  // somebody who may run here only with an approval may not rehearse.
  const dryRunBlocked = runBlocked || askToRun;
  // The target pickers hold still while a rollback runs: its outcome, and the
  // ledger it reads afterwards, belong to the target it was started on.
  const targetLocked = rollbackBusy !== null;

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
      : `Deploy ${selectionRange}${selectionCount > 1 ? ` (${selectionCount})` : ""}`;
  const dryRunLabel = selectionCount === 0 ? "Dry run" : `Dry run ${selectionRange}`;
  // The version the selection ends at, for "Deploy to" and the summary.
  const selectionLastLabel =
    selectionCount > 0
      ? vLabel(selectionVersions[selectionCount - 1])
      : pendingScripts.length === 0
        ? "Up to date"
        : "Nothing selected";

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
  // The pending rows in the selection, marked in the list by the script
  // itself rather than by comparing versions, so the list cannot mark a row
  // the run would leave out.
  const inRunKeys = new Set(scriptsUpToTarget.map((s) => scriptKey(s)));

  // ── Data loaders ─────────────────────────────────────────────────────────
  async function handlePull() {
    setPullLoading(true);
    setPullError(null);
    setGithubMissing(false);
    setPullWarnings([]);
    try {
      const res = await apiFetch("/api/github/pull");
      const data = (await res.json()) as {
        scripts?: GitHubScript[];
        warnings?: unknown;
        error?: string;
        code?: string;
      };
      if (!res.ok || !data.scripts) {
        setPullError(data.error ?? "Could not fetch scripts from GitHub.");
        setGithubMissing(data.code === "github_unconfigured");
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
    schemasFor.current = id;
    setSchemasLoading(true);
    setSchemasError(null);
    setSchemas([]);
    try {
      const res = await apiFetch(`/api/scripts/schemas?connectionId=${id}`);
      const data = (await res.json()) as { schemas?: string[]; error?: string };
      if (schemasFor.current !== id) return;
      if (!res.ok || !data.schemas) {
        setSchemasError(data.error ?? "Could not load schemas from this connection.");
      } else {
        const list = data.schemas;
        setSchemas(list);
        // One schema leaves nothing to choose, so it is picked, as Compare
        // and Performance do.
        if (list.length === 1) setSchema((current) => (current === "" ? list[0] : current));
        const wanted = linked.current.schema;
        if (wanted && list.includes(wanted)) setSchema(wanted);
      }
    } catch {
      if (schemasFor.current === id) setSchemasError("Network error loading schemas.");
    } finally {
      if (schemasFor.current === id) setSchemasLoading(false);
    }
  }

  // Bare pre-flight call, also used to refresh the ledger after a run.
  // Resolves true when the ledger was read, so a caller can say whether the
  // page now shows the target as it is.
  async function runPreflightCheck(id: string, sch: string, group: string): Promise<boolean> {
    const ticket = ++preflightSeq.current;
    const current = () => ticket === preflightSeq.current;
    setPreflightLoading(true);
    setPreflightError(null);
    try {
      const res = await apiFetch("/api/scripts/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId: Number(id),
          schemaName: sch || "public",
          scriptName: group || undefined,
        }),
      });
      const data = (await res.json()) as PreflightResult & { error?: string };
      // The target changed, or a newer read started, while this one was out.
      if (!current()) return false;
      if (!res.ok) {
        setPreflightError(data.error ?? "Pre-flight check failed.");
        setPreflightResult(null);
        return false;
      }
      setPreflightResult(data);
      // The audit trail refreshes with the ledger, which is also what makes a
      // run that just FAILED show up: the failure path refreshes the ledger
      // too, and that is the one case the ledger itself has nothing to say
      // about. Not awaited, a slow or unreachable metadata read must not hold
      // up the pre-flight answer the buttons depend on.
      void loadAttempts(id, sch, ticket);
      return true;
    } catch {
      if (!current()) return false;
      setPreflightError("Network error during pre-flight check.");
      setPreflightResult(null);
      return false;
    } finally {
      // Whoever took the newer ticket owns the spinner now.
      if (current()) setPreflightLoading(false);
    }
  }

  // Drop the pre-flight answer when the target changes. The new ticket also
  // makes a read still on its way for the old target land nowhere: it would
  // fill in the old target's ledger under the new target's name, and its
  // spinner would keep "Check database" disabled until it came back.
  function forgetPreflight() {
    preflightSeq.current += 1;
    setPreflightLoading(false);
    setPreflightResult(null);
    setPreflightError(null);
  }

  // The deploy audit trail for the chosen schema. Failures are swallowed on
  // purpose: this is a panel beside the controls, and a metadata database that
  // is briefly unreachable must not put an error banner over a deploy screen
  // that is otherwise working. An empty list reads as "nothing recorded", which
  // is what the reader would conclude from an error anyway.
  // `ticket` is the read it came with, so a list for an old target is dropped.
  async function loadAttempts(id: string, sch: string, ticket: number): Promise<void> {
    try {
      const res = await apiFetch(
        `/api/scripts/attempts?connectionId=${Number(id)}&schema=${encodeURIComponent(sch || "public")}`,
        { cache: "no-store" }
      );
      const data = (await res.json()) as { attempts?: DeployAttemptRow[] };
      if (ticket !== preflightSeq.current) return;
      setAttempts(res.ok && Array.isArray(data.attempts) ? data.attempts : []);
    } catch {
      if (ticket !== preflightSeq.current) return;
      setAttempts([]);
    }
  }

  // ── Stop ─────────────────────────────────────────────────────────────────
  // Ask the server to stop the deploy or rollback that is running. The run
  // rolls back, so nothing it did is kept, and its own answer then says it
  // was stopped. Once the run is saving its changes it is too late, and the
  // server says so.
  async function stopActiveRun() {
    const run = activeRunRef.current;
    if (!run || stopBusy) return;
    setStopBusy(true);
    // The run may end while this request is out; then its own answer has
    // already said how it went, and the button has gone.
    const stillThisRun = () => activeRunRef.current?.runId === run.runId;
    try {
      const res = await apiFetch("/api/scripts/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(run),
      });
      let data: { status?: string; error?: string } | null = null;
      try {
        data = JSON.parse(await res.text()) as { status?: string; error?: string };
      } catch {
        data = null;
      }
      if (res.ok && data?.status === "stopping") {
        if (stillThisRun()) showToast("Stopping the run…");
        return;
      }
      if (!stillThisRun()) return;
      setStopBusy(false);
      showToast(data?.error ?? `Could not stop the run (HTTP ${res.status}).`, "bad");
    } catch {
      if (!stillThisRun()) return;
      setStopBusy(false);
      showToast("Could not reach the server to stop the run.", "bad");
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
    // not a rule; this is the rule.
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

    // The run's id, made here so Stop can name the run before it answers.
    const runId = newRunId();
    activeRunRef.current = { runId, connectionId: Number(connectionId) };
    setStopBusy(false);
    setRollbackBusy(dryRun ? "dry" : "real");
    setRollbackError(null);
    setRollbackDone(null);
    try {
      const res = await apiFetch("/api/scripts/revert", {
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
          runId,
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
          showToast("Rollback outcome unknown. Check the ledger", "bad");
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
        if (data.code === "run_stopped") {
          // Stopped by Stop or by a time limit: it rolled back, so the
          // ledger this page read still holds.
          showToast(dryRun ? "Dry run stopped, nothing changed" : "Rollback stopped, nothing changed", "bad");
        } else if (data.outcomeUnknown) {
          showToast("Rollback outcome unknown. Check the ledger", "bad");
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
        showToast("Dry run passed, nothing changed");
        return;
      }

      setRollbackDone({ message: data.message ?? `${doneLabel}.` });
      showToast(doneLabel);
      // The next plan starts from the smallest rollback again, closed, so a
      // second rollback is always a new decision. The run panel still
      // describes the deploy that put these versions on the target, so clear
      // it too, leaving it up would contradict the ledger.
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
      activeRunRef.current = null;
      setStopBusy(false);
      setRollbackBusy(null);
    }
  }

  // After a rollback, one whose outcome is unknown, or a refusal caused by an
  // out-of-date ledger: read the ledger and the live schema again, so the
  // page shows the target as it now is, and read the approvals again (a
  // rollback somebody asked to run spends one). Resolves true when the ledger
  // was read.
  async function refreshAfterRollback(): Promise<boolean> {
    setApprovalReloadKey((reload) => reload + 1);
    // Both checks start now, while this is still the target on screen, so a
    // target picked during the read drops both answers (see preflightSeq).
    void runDriftCheck(connectionId, schema);
    return runPreflightCheck(connectionId, schema, scriptGroup);
  }

  // ── Approvals ────────────────────────────────────────────────────────────
  // Ask an Admin to approve exactly the batch on screen. The
  // server hashes the SQL again from this request body rather than trusting a
  // fingerprint the browser sends, so a tampered request cannot approve one set
  // of migrations and run another.
  async function handleRequestApproval() {
    if (!connectionId || !schema || !scriptGroup || !targetVersion) return;
    if (scriptsUpToTarget.length === 0 || approvalBusy) return;

    setApprovalBusy(true);
    setApprovalError(null);
    try {
      const res = await apiFetch("/api/deploy/approvals", {
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
      showToast(APPROVAL_REQUESTED_TOAST);
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
      const res = await apiFetch("/api/deploy/approvals", {
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
      showToast(APPROVAL_REQUESTED_TOAST);
    } catch {
      setRollbackApprovalError("Network error requesting the approval.");
    } finally {
      setApprovalBusy(false);
      setApprovalReloadKey((key) => key + 1);
    }
  }

  // The approver's half. A 409 here means someone decided it first; their
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
      const res = await apiFetch(`/api/deploy/approvals/${id}`, {
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
    // As forgetPreflight does for the ledger: a check still on its way for the
    // old target must not report on the new one.
    driftSeq.current += 1;
    setDriftPhase("idle");
    setDriftResult(null);
    setDriftError(null);
    setStoredDriftStatus(null);
  }

  // Phase 6 drift pre-check. If the chosen target (connection + schema) is
  // tracked, compare its live structure against its expected snapshot via the
  // real lineage APIs. When it isn't tracked we say so honestly, never a fake
  // diff. The drift POST also records a drift_events row, which feeds the audit
  // log. Used both as a stage-1 pre-check and a stage-3 post-deploy verify.
  async function runDriftCheck(id: string, sch: string) {
    if (!id || !sch) {
      resetDrift();
      return;
    }
    // A ticket, as runPreflightCheck takes one. After every wait, an answer
    // for a target no longer on screen, or older than a newer check, stops.
    const ticket = ++driftSeq.current;
    const current = () => ticket === driftSeq.current;
    setDriftPhase("loading");
    setDriftError(null);
    setDriftResult(null);
    setStoredDriftStatus(null);
    try {
      const lookupRes = await apiFetch(
        `/api/lineage/lookup?connectionId=${encodeURIComponent(id)}&schemaName=${encodeURIComponent(sch)}`,
        { cache: "no-store" }
      );
      if (!current()) return;
      // A failed lookup must not read as "not tracked", that answer skips the
      // drift pre-check, so a dead metadata database would quietly remove the
      // warning.
      if (!lookupRes.ok) {
        setDriftPhase("error");
        return;
      }
      const lookup = (await lookupRes.json()) as {
        tracked?: boolean;
        trackedSchemaId?: number;
        /** The last drift result on record, which the apply route holds a run to. */
        driftStatus?: DriftResult["status"] | null;
      };
      // Above all here: the old target's label must not land on the new one.
      if (!current()) return;
      // Kept for the same reason: if the drift check below fails, this record
      // is what the apply route will hold the run to.
      setStoredDriftStatus(lookup.driftStatus ?? null);
      if (!lookup.tracked || !lookup.trackedSchemaId) {
        setDriftPhase("untracked");
        return;
      }
      const driftRes = await apiFetch("/api/lineage/drift", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackedSchemaId: lookup.trackedSchemaId }),
      });
      const data = (await driftRes.json()) as DriftResult & { error?: string };
      if (!current()) return;
      if (!driftRes.ok || !data.status) {
        setDriftError(data.error ?? "Drift check failed.");
        setDriftPhase("error");
        return;
      }
      setDriftResult(data);
      setDriftPhase("ready");
    } catch {
      if (!current()) return;
      setDriftError("Network error during the drift check.");
      setDriftPhase("error");
    }
  }

  // "Check database" button, resets the run and re-reads the ledger.
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
    // The drift check starts first, while this is still the target on screen:
    // started after the await, it would read whatever target was clicked when
    // the button was, and take a ticket newer than any change since.
    void runDriftCheck(connectionId, schema);
    await runPreflightCheck(connectionId, schema, scriptGroup);
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
    setRunFailure(null);
    setRunLimited(false);
    setRunIsDryRun(false);
    setRehearsedBody(null);
    setElapsedMs(0);
  }

  // ── Retiring a version ───────────────────────────────────────────────────
  // A version that should never run is retired in GitHub, so Deploy stops
  // offering it to every database and the versions after it can run. Only a
  // role with scripts:delete (Admin, out of the box) sees the buttons, and the
  // route checks the same permission. Undo is deleting the note in GitHub.
  const mayRetire = can("scripts:delete");

  function openRetire(script: GitHubScript) {
    setRetireError(null);
    setRetireScript(script);
  }

  async function handleRetire(reason: string) {
    const script = retireScript;
    if (!script || retireBusy) return;
    const label = vLabel(script.version);
    // Retrying is always safe: the route answers "already retired" when the
    // note is there, and never writes a second one.
    const unknown = `so it is not known whether ${label} was retired. Try again: if it was, you will be told so.`;
    setRetireBusy(true);
    setRetireError(null);
    try {
      const res = await apiFetch("/api/github/retire", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          database_name: script.database_name,
          schema_name: script.schema_name,
          script_name: script.script_name,
          version: script.version,
          reason: reason || undefined,
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; already?: boolean; error?: unknown }
        | null;
      if (!res.ok || !data?.ok) {
        setRetireError(
          typeof data?.error === "string" && data.error !== ""
            ? data.error
            : `The server answered with status ${res.status}, ${unknown}`
        );
        return;
      }
      setRetireScript(null);
      showToast(data.already ? `${label} was already retired.` : `Retired ${label}. Deploy no longer offers it.`);
      // The pending list, the timeline and the run's default target all come
      // from the registry and the ledger already read. The database did not
      // change, so reading the registry again is enough.
      setStage(1);
      await handlePull();
    } catch {
      setRetireError(`The connection dropped, ${unknown}`);
    } finally {
      setRetireBusy(false);
    }
  }

  // ── Picking the run ──────────────────────────────────────────────────────
  // The pending list's "Run …" buttons select rather than run: the run
  // becomes every pending version up to that row (pendingPrefixThrough), the
  // rows outside it read "not in this run", and focus moves on to what is
  // left to do. Nothing runs until Deploy or Dry run is pressed.
  // The last version in the run. "" selects nothing, which is what unticking
  // the first pending row means, there is no earlier row to end at.
  function selectRun(version: string) {
    setTargetVersion(version);
    // After React has drawn the new selection's gates.
    window.requestAnimationFrame(focusNextStep);
  }

  // The run panel's Deploy button when it can be pressed, else the panel
  // itself.
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
  // does (preview, approval); nothing runs from the timeline.
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
  // is no state where some of these are applied and the rest are not. By the
  // time a failure is visible here, the database has already put itself back.
  // Stop (stopActiveRun) ends a run partway in the same way: the transaction
  // rolls back, so a stopped run applied nothing.
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
    // hint, not a rule; this is the rule. A rehearsal is held to everything
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
    // already the new one, the arrow has to remember where the run started.
    setRunFromVersion(currentLabel);
    setRunIsDryRun(dryRun);
    setRunInitialised(targetStage === "needs-init");
    setRunError(null);
    setRunFailure(null);
    setRunLimited(false);
    setRunRegistry(null);
    // Every migration goes to "running" at once because they really do run
    // together. Ticking them off one at a time would be a story about a loop
    // that no longer exists.
    setRunStatus(
      Object.fromEntries(batch.map((s) => [scriptKey(s), { status: "running" } as RunCell]))
    );
    setRunComplete(false);
    // The run's id, made here so Stop can name the run before it answers.
    const runId = newRunId();
    activeRunRef.current = { runId, connectionId: Number(connectionId) };
    setStopBusy(false);
    setIsDeploying(true);
    setStage(2);

    runStartRef.current = performance.now();
    setElapsedMs(0);
    timerRef.current = window.setInterval(() => {
      setElapsedMs(performance.now() - runStartRef.current);
    }, 100);

    let outcomes: ApplyOutcome[] | null = null;
    let failure: string | null = null;
    // How the run failed, if it did: lib/deploy/apply-failure's reading of the answer,
    // so the rows, the toast, the header and the recovery bar tell one story.
    // Stays null on a success.
    let failureKind: ApplyFailure | null = null;
    // Whether the server says the run was stopped partway (Stop, or a time
    // limit). It rolled back like any failure; only the toast says "stopped".
    let stopped = false;
    // The dry run stopped on a limit of the rehearsal (dryRunLimitation).
    let limited = false;

    try {
      const res = await apiFetch("/api/scripts/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId: Number(connectionId),
          schemaName: schema || "public",
          dryRun,
          runId,
          scripts: batch.map((script) => ({
            script_name: script.script_name,
            sql_content: script.sql_content,
            version: script.version,
            title: script.script_name,
            // The change log the author wrote when they published this
            // version (spec 07, "change logs with user notes"). It rides in
            // the file's own "-- Note:" header, so it survives the round trip
            // through GitHub, and this is where it reaches the ledger: before
            // this, script_patch.description was NULL on every version
            // deployed the ordinary way, because this screen never sent one.
            description: readChangeNote(script.sql_content) ?? undefined,
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
      // a request that reached it, and, before the run became one transaction,
      // may well have committed something.
      const raw = await res.text();
      let data: ApplyResponse | null = null;
      try {
        data = JSON.parse(raw) as ApplyResponse;
      } catch {
        data = null;
      }

      if (data?.results) outcomes = data.results;
      // Spec 07's automatic push, as it landed. The route sends this only when
      // a version was added to the registry or could not be, and on a dry run
      // it never writes at all, so there is nothing to read.
      if (!dryRun && data?.success) {
        const note = describeRegistry(readArchivedVersions(data.registry));
        setRunRegistry(note.saved || note.problem ? note : null);
      }
      if (!res.ok || !data?.success) {
        failure =
          data?.error ??
          `The apply API answered ${res.status} with a response this page could ` +
          `not read. Re-check the target before retrying.`;
        // Unknown when the body could not be read or the server says its
        // COMMIT did not report back; refused on any 4xx but 422 (a dry run
        // whose SQL did run); not started on a 5xx marked nothingRan; rolled
        // back otherwise.
        failureKind = readApplyFailure(res.status, data);
        stopped = data?.code === "run_stopped";
        limited = dryRun && data?.dryRunLimitation === true;
      }
    } catch {
      // A genuine transport failure: the request may or may not have reached the
      // server, so this must not claim nothing happened.
      // The route path is an implementation detail; the reader needs the button
      // that answers the question instead.
      failure =
        "The request to the server never completed, so this page cannot say " +
        "whether the migrations ran. Go back to Pre-flight and press Check " +
        "database to read what the target actually has before you retry.";
      failureKind = readApplyFailure(null, null);
    }

    // Whether this page cannot say how the run ended: the request never
    // completed, the answer could not be read, or the server says its COMMIT
    // did not report back. Any other answer is the server's own account.
    const outcomeUnknown = failureKind === "unknown";

    // Map the server's verdict onto the rows.
    //
    // A row the server said nothing about is "not known" only when the whole
    // outcome is (outcomeUnknown above): then the server reporting nothing is
    // not the server reporting that nothing happened, because the request may
    // have run every migration. Any other answer says the run did not commit,
    // so a row it leaves out was skipped. One answer, because three surfaces
    // need it: the rows, the toast, and the recovery bar.
    const unreported: RunStatus = outcomeUnknown ? "unknown" : "skipped";
    // The server's answer for one script of this batch, if it gave one.
    const outcomeOf = (script: GitHubScript) =>
      outcomes?.find((o) => o.script_name === script.script_name && o.version === script.version);
    setRunStatus(() => {
      const next: Record<string, RunCell> = {};
      for (const script of batch) {
        const outcome = outcomeOf(script);
        if (!outcome) {
          next[scriptKey(script)] = { status: unreported };
          continue;
        }
        const { warnings, moreWarnings } = readRunWarnings(outcome);
        next[scriptKey(script)] = {
          status: outcome.status,
          error: outcome.error,
          statements: outcome.statements,
          ...(warnings.length > 0 ? { warnings, moreWarnings } : {}),
          // Only a dry run tries the rollbacks, so only it has an answer.
          ...(dryRun ? readRollbackCheck(outcome) : {}),
        };
      }
      return next;
    });
    setRunError(failure);
    setRunFailure(failureKind);
    setRunLimited(limited);
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
    activeRunRef.current = null;
    setStopBusy(false);
    setIsDeploying(false);
    setRunComplete(true);

    // Always re-read the ledger so the current version reflects what is really
    // applied, a dry run should leave it exactly where it was, and this is what
    // proves that on screen rather than asserting it. The drift check is re-run
    // so the Verify step reflects the post-deploy state, and starts first for
    // the reason handlePreflight gives.
    void runDriftCheck(connectionId, schema);
    await runPreflightCheck(connectionId, schema, scriptGroup);
    // A real run spends its approval. Re-read them so the panel says so rather
    // than still offering a green light that the server would now refuse.
    setApprovalReloadKey((key) => key + 1);

    // Warnings mean the run worked but PostgreSQL left something undone, such
    // as an owner change the login may not make. Each version lists its own
    // (the run rows after a rehearsal, What was applied after a deploy); the
    // toast only says there are some and where, so nobody reads "clean" and
    // stops there.
    const warningTotal = batch.reduce((sum, script) => {
      const { warnings, moreWarnings } = readRunWarnings(outcomeOf(script));
      return sum + warnings.length + moreWarnings;
    }, 0);
    const warned = (where: string) =>
      warningTotal > 0 ? ` · ${countOf(warningTotal, "warning")} from PostgreSQL, see ${where}` : "";

    // A rollback that failed when the dry run tried it. A warning: the dry
    // run is still clean, but the toast must not read as "all good".
    const rollbackBroken = dryRun && batch.some((script) => readRollbackCheck(outcomeOf(script)).rollbackCheck === "failed");

    if (failure && limited) {
      showToast("A dry run can't rehearse this run. Nothing was written", "bad");
    } else if (failure) {
      showToast(
        outcomeUnknown
          ? "Deploy outcome not known. Check the target before retrying"
          : stopped
            ? dryRun
              ? "Dry run stopped, nothing was written"
              : "Deploy stopped, nothing was applied"
            : failureKind === "refused"
              ? dryRun
                ? "Dry run refused, nothing was run"
                : "Deploy refused, nothing was applied"
              : failureKind === "not-started"
                ? dryRun
                  ? "Dry run did not start, nothing was run"
                  : "Deploy did not start, nothing was applied"
                : dryRun
                  ? "Dry run failed, nothing was written"
                  : "Deploy failed, nothing was applied",
        "bad"
      );
    } else if (dryRun) {
      showToast(
        `Dry run clean · ${batch.length} migration${batch.length === 1 ? "" : "s"} rehearsed${warned("the rows")}` +
          (rollbackBroken ? " · a rollback failed, see the rows" : "")
      );
    } else {
      setStage(3);
      // The batch's own last version: the selection can move after this.
      showToast(`Deploy complete · up to ${vLabel(batch[batch.length - 1].version)}${warned("What was applied")}`);
    }
  }

  // ── Stepper helpers ──────────────────────────────────────────────────────
  const appliedScripts = runScripts.filter(
    (s) => runStatus[scriptKey(s)]?.status === "applied"
  );
  // A clean run: every migration came back applied, or, for a rehearsal,
  // every one came back rehearsed. Only the first unlocks Verify, because only
  // the first left anything behind to verify.
  const allApplied =
    runScripts.length > 0 &&
    runScripts.every((s) => runStatus[scriptKey(s)]?.status === "applied");
  const allRehearsed =
    runScripts.length > 0 &&
    runScripts.every((s) => runStatus[scriptKey(s)]?.status === "rehearsed");
  // What PostgreSQL warned about during the last run, counted over its rows.
  const runWarningTotal = runScripts.reduce((sum, s) => sum + warningCount(runStatus[scriptKey(s)]), 0);

  // Spec feature 11: "After initialization, prompt whether to run
  // /scripts_patch." pendingScripts is read AFTER the run, from the re-read
  // ledger, so it is what is genuinely left rather than what was left before.
  // patchPrompt answers null for an ordinary patch run, a rehearsal, or a run
  // that did not finish clean; see lib/deploy/init.ts for why each of those is
  // a case where offering the next run would be the wrong thing to say.
  const afterInitPrompt = patchPrompt({
    initialised: runInitialised,
    runSucceeded: allApplied,
    dryRun: runIsDryRun,
    remainingVersions: pendingScripts.map((script) => vLabel(script.version)),
  });
  const runProgress = runScripts.filter((s) => {
    const status = runStatus[scriptKey(s)]?.status;
    return status === "applied" || status === "rehearsed";
  }).length;
  // "0 of 3 applied" is itself a claim, and on an unknown outcome it is the
  // wrong one, it reads as "nothing happened", which is the half of the
  // possibilities the reader must not assume.
  const runOutcomeUnknown = runScripts.some(
    (s) => runStatus[scriptKey(s)]?.status === "unknown"
  );
  // The version a failed run stopped at, while the registry still offers it:
  // the recovery bar offers to retire it.
  const failedRunScript =
    runScripts.find((s) => runStatus[scriptKey(s)]?.status === "failed") ?? null;
  // The first version (newest first, the order the dry run tries them) whose
  // rollback failed in the rehearsal. The clean rehearsal card warns about it.
  const brokenRollbackScript =
    [...runScripts].reverse().find((s) => runStatus[scriptKey(s)]?.rollbackCheck === "failed") ?? null;
  const brokenRollback = brokenRollbackScript
    ? {
        versionLabel: vLabel(brokenRollbackScript.version),
        error: runStatus[scriptKey(brokenRollbackScript)]?.rollbackError,
      }
    : null;
  const failedStillOffered =
    !runLimited &&
    failedRunScript !== null &&
    (githubScripts ?? []).some(
      (s) => scriptKey(s) === scriptKey(failedRunScript) && !s.retired
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
    if (n === stage) return "dp-step dp-on";
    return n < stage ? "dp-step dp-done" : "dp-step";
  }

  // Somebody who only looks gets the run history of the target they pick,
  // without the pre-flight read that normally brings it.
  useEffect(() => {
    if (!historyOnly || !connectionId || !schema) return;
    void loadAttempts(connectionId, schema, preflightSeq.current);
  }, [historyOnly, connectionId, schema]);

  // The target picker changed. Picking another connection clears the schema
  // (the new list picks one when it has only one). Either way everything
  // read for the old target is dropped.
  function changeTarget(next: TargetChoice) {
    forgetLink();
    if (next.connectionId !== connectionId) {
      setConnectionId(next.connectionId);
      setSchema("");
      // The new list is asked for right after this render. Saying so now
      // keeps the picker from showing "no schemas" for a moment.
      setSchemas([]);
      setSchemasError(null);
      setSchemasLoading(next.connectionId !== "");
    } else {
      setSchema(next.schema);
    }
    setScriptGroup("");
    forgetPreflight();
    setAttempts([]);
    setTargetVersion("");
    resetRun();
    resetDrift();
  }

  // A quick run committed. What the page shows for that target is now old, so
  // it is read again: the GitHub list (the run saved a file there) and, when
  // the page is on the same target and not in the middle of something, the
  // ledger and drift, the way a run from this page refreshes them.
  function quickRunRan(target: QuickRunTarget) {
    void handlePull();
    if (target.connectionId !== connectionId || target.schema !== schema) return;
    if (isDeploying || rollbackBusy !== null || stage !== 1) return;
    void runDriftCheck(connectionId, schema);
    if (scriptGroup) void runPreflightCheck(connectionId, schema, scriptGroup);
  }

  // After asking an Admin from Quick run: point the page at that target and
  // group, through the same path a link from the Requests page takes, so the
  // reader sees the version waiting for its yes.
  function quickRunShow(target: QuickRunTarget) {
    changeTarget({ connectionId: target.connectionId, schema: target.schema });
    linked.current = { connection: null, schema: target.schema, script: target.group, version: null };
    setStage(1);
    void handlePull();
  }

  // The one picker for the connection and the schema. Deploy has no status
  // for each schema, so the list shows names only.
  const targetPicker = (
    <TargetPicker
      label="Target"
      hint="the database and schema to deploy to"
      connections={connections.map((c) => ({ id: c.id, name: c.name, detail: c.database_name }))}
      connectionId={connectionId}
      schema={schema}
      schemas={schemas}
      loading={schemasLoading}
      error={schemasError}
      onRetry={() => void fetchSchemas(connectionId)}
      disabled={targetLocked}
      onChange={changeTarget}
    />
  );

  // The setup checklist's three steps. Each line says what is missing, who
  // can fix it, and what to press.
  const firstConnection = connections[0]?.name ?? "";
  const setupSteps: SetupStep[] = [
    {
      key: "connection",
      label: "Connect a database",
      done: hasConnection,
      detail: hasConnection
        ? connections.length === 1
          ? `Done. ${firstConnection} is connected.`
          : `Done. ${connections.length} databases are connected.`
        : connectionsFailed
          ? "Your saved connections could not be read. Reload the page to try again."
          : can("connections:create")
            ? "Deploy runs migrations on a database you have connected."
            : "Deploy runs migrations on a connected database. An Admin can add one.",
      action:
        !connectionsFailed && can("connections:create")
          ? { label: "Open Connections", href: orgPath("/connections") }
          : undefined,
    },
    {
      key: "github",
      label: "Set up GitHub",
      done: !githubMissing,
      detail: !githubMissing
        ? "Done. Every deploy saves its script there first."
        : githubTokenUnreadable
          ? "The saved GitHub token can't be read on this server. An Admin adds it again under Admin › GitHub."
          : maySetUpGitHub
            ? "GitHub is not set up for this organization yet. Set it up once and every deploy saves its script there first."
            : "Deploys need GitHub, which an Admin sets up. Your ask lands in Requests, where any Admin can act on it.",
      action: maySetUpGitHub
        ? {
            label: githubTokenUnreadable ? "Add the token again" : "Set up GitHub",
            href: orgPath("/admin?tab=github"),
          }
        : // While viewing the app as another role there is nobody to ask:
          // the answer is to change "View as" back.
          viewingAs
          ? undefined
          : { label: "Ask an Admin", href: orgPath("/requests") },
    },
    {
      key: "migration",
      label: "Save a migration in Script Editor",
      done: savedMigrationCount > 0,
      detail:
        savedMigrationCount > 0
          ? `Done. ${savedMigrationCount} saved ${savedMigrationCount === 1 ? "version" : "versions"}.`
          : githubMissing
            ? "Deploy ships a script you have saved. Saving one needs GitHub first."
            : "Deploy ships a script you have saved.",
      action: { label: "Open Script Editor", href: orgPath("/script-editor") },
    },
  ];

  const STEPS: { n: 1 | 2 | 3; name: string; sub: string }[] = [
    { n: 1, name: "Pre-flight", sub: "checks · pending list" },
    { n: 2, name: "Run", sub: "one transaction · all or nothing" },
    { n: 3, name: "Verify", sub: "ledger re-read" },
  ];

  // The colour of the bar under the run's title on stage 2.
  const runTone = isDeploying
    ? "dp-busy"
    : runOutcomeUnknown || runLimited
      ? "dp-mid"
      : allApplied || allRehearsed
        ? "dp-good"
        : "dp-bad";

  return (
    <div className="dp-page">
      {/* Page header, with the three steps on its right */}
      <div className="dp-head">
        {/* The title and its one line come from lib/help/deploy.ts. How the
            page works is in Help, not here. */}
        <PageHeader
          page="/deploy"
          actions={
            <div className="dp-head-actions">
            {!historyOnly && connections.length > 0 && (
              <QuickRunButton
                onClick={() => setQuickOpen(true)}
                disabled={isDeploying || rollbackBusy !== null}
              />
            )}
            <div className="dp-steps" role="group" aria-label="Deploy steps">
              {STEPS.map((s) => (
                <button
                  key={s.n}
                  type="button"
                  className={stepClass(s.n)}
                  disabled={!canGoStage(s.n)}
                  title={s.sub}
                  aria-current={s.n === stage ? "step" : undefined}
                  onClick={() => canGoStage(s.n) && setStage(s.n)}
                >
                  <span className="dp-step-n">
                    {s.n === 2 && isDeploying ? <span className="spin" /> : s.n}
                  </span>
                  {s.name}
                </button>
              ))}
            </div>
            </div>
          }
        />
        <QuickRun
          open={quickOpen}
          onClose={() => setQuickOpen(false)}
          connections={connections}
          initialConnectionId={connectionId || (connections[0] ? String(connections[0].id) : "")}
          initialSchema={schema}
          githubMissing={githubMissing}
          isAdmin={isAdmin}
          mayDeploy={can("deploy:run")}
          maySaveScripts={can("scripts:create")}
          sessionLoading={sessionLoading}
          settingsHref={orgPath("/admin?tab=github")}
          historyHref={orgPath("/history")}
          showToast={showToast}
          onRan={quickRunRan}
          onShowGroup={quickRunShow}
        />
        <HeadNotes
          historyOnly={historyOnly}
          role={role}
          roleLabel={roleLabel}
          runRefusal={runRefusal}
          pullError={pullError}
          githubMissing={githubMissing}
          pullWarnings={pullWarnings}
        />
      </div>

      {/* ═══════════════════ STAGE 1: PRE-FLIGHT ═══════════════════ */}
      {/* Not set up yet: a short checklist in place of controls that could
          not be used, with the three steps it opens up shown underneath. */}
      {stage === 1 && needsSetup && !historyOnly && (
        <section className="dp-stage">
          <div data-tour="deploy-checklist">
            <SetupChecklist
              title="Deploy needs a few things first"
              lead="Finish these and the deploy steps below open up."
              steps={setupSteps}
            >
              <div className="setup__locked">
                <p className="setup__locked-title">Unlocks after setup</p>
                <ol>
                  {STEPS.map((s) => (
                    <li key={s.n}>
                      <span>{`0${s.n}`}</span>
                      {s.name}
                    </li>
                  ))}
                </ol>
              </div>
            </SetupChecklist>
          </div>
        </section>
      )}

      {/* Not set up, and this person can only look: what has run before. */}
      {stage === 1 && historyOnly && hasConnection && (
        <section className="dp-stage">
          <div className="card dp-card">
            <h2 className="dp-h-sm">Run history</h2>
            <div className="dp-fields dp-fields--one" data-tour="deploy-target">
              {targetPicker}
            </div>
          </div>
          {connectionId && schema && <RunTimeline attempts={attempts} schema={schema} nextLabel={null} />}
        </section>
      )}

      {stage === 1 && !needsSetup && (
        <section className="dp-stage">
          <TargetCard
            targetPicker={targetPicker}
            connectionsLoaded={connectionsLoaded}
            connections={connections}
            connectionsFailed={connectionsFailed}
            activeConn={activeConn}
            targetExecuteRole={targetExecuteRole}
            targetIsReadOnly={targetIsReadOnly}
            mayExecuteOnTarget={mayExecuteOnTarget}
            roleLabel={roleLabel}
            scriptGroup={scriptGroup}
            schema={schema}
            targetLocked={targetLocked}
            schemaScriptNames={schemaScriptNames}
            forgetLink={forgetLink}
            setScriptGroup={setScriptGroup}
            forgetPreflight={forgetPreflight}
            setTargetVersion={setTargetVersion}
            resetRun={resetRun}
            resetDrift={resetDrift}
            githubScripts={githubScripts}
            orgPath={orgPath}
            connectionId={connectionId}
            preflightLoading={preflightLoading}
            pullLoading={pullLoading}
            handlePreflight={handlePreflight}
          />

          {/* A read that failed says what to press: enter the password
              again, or try again. The server's words go under Technical details. */}
          <ErrorNotice
            error={preflightError}
            connectionName={activeConn?.name}
            connectionId={connectionId}
            onRetry={handlePreflight}
          />

          {/* Target context card + pending grid, once pre-flight has run */}
          {preflightResult && activeConn && (
            <>
              {/* Everything run on this schema from here, by date. Built from
                  the attempt rows only, so failed and refused runs show too. */}
              <RunTimeline
                attempts={attempts}
                schema={preflightResult.schema}
                nextLabel={selectionCount > 0 ? `up to ${selectionLastLabel}` : null}
              />

              <ShipsCard
                preflightResult={preflightResult}
                activeConn={activeConn}
                currentLabel={currentLabel}
                selectionLastLabel={selectionLastLabel}
              />

              <VersionTimelineCard
                versionLedger={versionLedger}
                scriptGroup={scriptGroup}
                appliedCount={appliedCount}
                pendingCount={pendingCount}
                skippedVersions={skippedVersions}
                currentLabel={currentLabel}
                timeline={timeline}
                revertableVersions={revertableVersions}
                rollbackBusy={rollbackBusy}
                rollBackTo={rollBackTo}
              />

              <RollbackCard
                appliedNewestFirst={appliedNewestFirst}
                rollbackDone={rollbackDone}
                revertedHistory={revertedHistory}
                rollbackCardRef={rollbackCardRef}
                scriptGroup={scriptGroup}
                rollbackBusy={rollbackBusy}
                setRollbackOpen={setRollbackOpen}
                rollbackOpen={rollbackOpen}
                preflightResult={preflightResult}
                driftPhase={driftPhase}
                driftResult={driftResult}
                driftError={driftError}
                rollbackPlannerShown={rollbackPlannerShown}
                rollbackErrorShown={rollbackErrorShown}
                rollbackPick={rollbackPick}
                rollbackOptions={rollbackOptions}
                setRollbackChoice={setRollbackChoice}
                rollbackListCapped={rollbackListCapped}
                rollbackSteps={rollbackSteps}
                rollbackProblems={rollbackProblems}
                rollbackDataLoss={rollbackDataLoss}
                orgPath={orgPath}
                rollbackLossSure={rollbackLossSure}
                rollbackOthers={rollbackOthers}
                rollbackOldest={rollbackOldest}
                rollbackOtherScripts={rollbackOtherScripts}
                rollbackKey={rollbackKey}
                connectionId={connectionId}
                rollbackReady={rollbackReady}
                schema={schema}
                rollbackReviewScripts={rollbackReviewScripts}
                askToRun={askToRun}
                approvedRollback={approvedRollback}
                pendingRollback={pendingRollback}
                latestRollback={latestRollback}
                rollbackAsk={rollbackAsk}
                rollbackHash={rollbackHash}
                rollbackHashError={rollbackHashError}
                approvalsLoading={approvalsLoading}
                rollbackApprovalError={rollbackApprovalError}
                approvalsReadError={approvalsReadError}
                approvals={approvals}
                approvalBusy={approvalBusy}
                user={user}
                roleLabel={roleLabel}
                mayApprove={mayApprove}
                bypass={bypass}
                rollbackApprovalNote={rollbackApprovalNote}
                setRollbackApprovalNote={setRollbackApprovalNote}
                handleRequestRollbackApproval={handleRequestRollbackApproval}
                handleDecideApproval={handleDecideApproval}
                rollbackDryRun={rollbackDryRun}
                rollbackBlocked={rollbackBlocked}
                handleRollback={handleRollback}
                rollbackRunBlocked={rollbackRunBlocked}
                rollbackTarget={rollbackTarget}
                stopBusy={stopBusy}
                stopActiveRun={stopActiveRun}
                rollbackHint={rollbackHint}
              />

              {/* Spec feature 11: the prompt for a target that has nothing on
                  it yet, or has tables this app has never deployed to. Above
                  the pending list rather than inside it, because it is true
                  whether or not a version is waiting: an empty schema with no
                  scripts in the registry still needs saying out loud. */}
              {targetPrompt && (
                <div className="warn-inline">
                  <AlertTriangleIcon size={15} className="ico" />
                  <div>
                    <div className="title">{targetPrompt.title}</div>
                    <div className="body">{targetPrompt.body}</div>
                  </div>
                </div>
              )}

              {pendingScripts.length === 0 ? (
                <div className="card dp-card dp-center">
                  <div className="dp-big-check">
                    <CheckIcon size={26} />
                  </div>
                  <h2 className="dp-h">You’re up-to-date!</h2>
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
                  {retiredAhead.length > 0 && (
                    <p className="help mt-1">{retiredNote(retiredAhead)}</p>
                  )}
                </div>
              ) : (
                <div className="dp-grid">
                  {/* Left: pending list + drift pre-check */}
                  <div className="dp-col">
                    <PendingCard
                      pendingScripts={pendingScripts}
                      scriptsUpToTarget={scriptsUpToTarget}
                      addressedElsewhere={addressedElsewhere}
                      preflightResult={preflightResult}
                      skippedVersions={skippedVersions}
                      currentLabel={currentLabel}
                      isDeploying={isDeploying}
                      selectRun={selectRun}
                      inRunKeys={inRunKeys}
                      retiredVersions={retiredAhead}
                      onRetire={mayRetire ? openRetire : undefined}
                    />

                    {/* Drift pre-check, real lineage compare when the target is tracked */}
                    <div className="card dp-card">
                    <DriftPanel
                      phase={driftPhase}
                      result={driftResult}
                      error={driftError}
                      context="precheck"
                      targetVersion={targetVersion}
                    />
                    </div>

                    <ShipChecklist
                      activeConn={activeConn}
                      targetIsReadOnly={targetIsReadOnly}
                      askToRun={askToRun}
                      approvedRun={approvedRun}
                      roleLabel={roleLabel}
                      mayExecuteOnTarget={mayExecuteOnTarget}
                      targetExecuteRole={targetExecuteRole}
                      preflightResult={preflightResult}
                      blockedByApplication={blockedByApplication}
                      addressedElsewhere={addressedElsewhere}
                      hasTxnViolation={hasTxnViolation}
                      txnViolationScripts={txnViolationScripts}
                      breakingCount={breakingCount}
                      louderCount={louderCount}
                      dataLossScripts={dataLossScripts}
                      dataLossSure={dataLossSure}
                      dataLossKinds={dataLossKinds}
                      dataLoss={dataLoss}
                      mightFailScripts={mightFailScripts}
                      mightFailKinds={mightFailKinds}
                      enumAdditions={enumAdditions}
                      approvalsReadError={approvalsReadError}
                      pendingRun={pendingRun}
                      driftPhase={driftPhase}
                      driftGateFromRecord={driftGateFromRecord}
                      driftGateStatus={driftGateStatus}
                      driftResult={driftResult}
                    />
                  </div>

                  {/* Right: the run */}
                  <aside className="dp-col">
                    <RunPanel
                      runPanelRef={runPanelRef}
                      currentLabel={currentLabel}
                      selectionLastLabel={selectionLastLabel}
                      schema={schema}
                      activeConn={activeConn}
                      scriptsUpToTarget={scriptsUpToTarget}
                      bumps={bumps}
                      breakingCount={breakingCount}
                      dataLossScripts={dataLossScripts}
                      dataLossSure={dataLossSure}
                      linesOfSql={linesOfSql}
                      louderCount={louderCount}
                      dataLossKinds={dataLossKinds}
                      dataLoss={dataLoss}
                      unflaggedDataLossKinds={unflaggedDataLossKinds}
                      mightFailScripts={mightFailScripts}
                      mightFailKinds={mightFailKinds}
                      enumAdditions={enumAdditions}
                      driftGateStatus={driftGateStatus}
                      driftGateFromRecord={driftGateFromRecord}
                      connectionId={connectionId}
                      reviewScripts={reviewScripts}
                      selectionBody={selectionBody}
                      askToRun={askToRun}
                      approvedRun={approvedRun}
                      pendingRun={pendingRun}
                      latestRun={latestRun}
                      runAsk={runAsk}
                      targetVersion={targetVersion}
                      runHash={runHash}
                      hashError={hashError}
                      approvalsLoading={approvalsLoading}
                      approvalError={approvalError}
                      approvalsReadError={approvalsReadError}
                      approvals={approvals}
                      approvalBusy={approvalBusy}
                      user={user}
                      roleLabel={roleLabel}
                      mayApprove={mayApprove}
                      bypass={bypass}
                      approvalNote={approvalNote}
                      setApprovalNote={setApprovalNote}
                      handleRequestApproval={handleRequestApproval}
                      handleDecideApproval={handleDecideApproval}
                      otherApproval={otherApproval}
                      otherApprovalVersion={otherApprovalVersion}
                      selectRun={selectRun}
                      deployLabel={deployLabel}
                      dryRunBlocked={dryRunBlocked}
                      handleRun={handleRun}
                      dryRunLabel={dryRunLabel}
                      deployBlocked={deployBlocked}
                      deployButtonRef={deployButtonRef}
                      targetIsReadOnly={targetIsReadOnly}
                      mayExecuteOnTarget={mayExecuteOnTarget}
                      executeBlockedWhy={executeBlockedWhy}
                      blockedByApplication={blockedByApplication}
                      hasTxnViolation={hasTxnViolation}
                      driftChecking={driftChecking}
                    />

                  </aside>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {/* ═══════════════════ STAGE 2: RUN ═══════════════════ */}
      {stage === 2 && (
        <section className="dp-stage">
          <RunHead
            isDeploying={isDeploying}
            runIsDryRun={runIsDryRun}
            runOutcomeUnknown={runOutcomeUnknown}
            allApplied={allApplied}
            allRehearsed={allRehearsed}
            runRefused={runRefused}
            runNotStarted={runNotStarted}
            runLimited={runLimited}
            enumAdditions={enumAdditions}
            elapsedMs={elapsedMs}
            stopBusy={stopBusy}
            stopActiveRun={stopActiveRun}
            runTone={runTone}
          />

          {/* A failure that belongs to the run, not to any one migration. */}
          {/* A saved password the server can't open gets the notice with
              its "Enter the password again" button. Every other failure keeps
              the server's own words, because they say what the run did. */}
          {runError &&
            (describeError(runError).kind === "password" ? (
              <ErrorNotice error={runError} connectionName={activeConn?.name} connectionId={connectionId} />
            ) : (
              <div className={runLimited ? "dp-result dp-mid" : "dp-result dp-bad"}>
                <div className="dp-result-body">{runError}</div>
              </div>
            ))}

          <RunList
            runScripts={runScripts}
            runStatus={runStatus}
            runRefused={runRefused}
            runNotStarted={runNotStarted}
            runLimited={runLimited}
            runOutcomeUnknown={runOutcomeUnknown}
            runProgress={runProgress}
            runIsDryRun={runIsDryRun}
            totalStatements={totalStatements}
            schema={schema}
            activeConn={activeConn}
          />

          <RunResults
            runComplete={runComplete}
            runRegistry={runRegistry}
            allRehearsed={allRehearsed}
            ledgerReread={ledgerReread}
            preflightResult={preflightResult}
            ledgerRereadFailed={ledgerRereadFailed}
            askToRun={askToRun}
            approvedRun={approvedRun}
            rehearsalChange={rehearsalChange}
            ranName={ranName}
            nowName={nowName}
            runRange={runRange}
            deployBlocked={deployBlocked}
            handleRun={handleRun}
            driftChecking={driftChecking}
            setStage={setStage}
            allApplied={allApplied}
            runOutcomeUnknown={runOutcomeUnknown}
            runRefused={runRefused}
            runNotStarted={runNotStarted}
            runIsDryRun={runIsDryRun}
            repeatChange={repeatChange}
            dryRunBlocked={dryRunBlocked}
            failedScript={failedStillOffered ? failedRunScript : null}
            onRetire={mayRetire ? openRetire : undefined}
            warningTotal={runWarningTotal}
            runLimited={runLimited}
            brokenRollback={brokenRollback}
          />
        </section>
      )}

      {/* ═══════════════════ STAGE 3: VERIFY ═══════════════════ */}
      {stage === 3 && (
        <section className="dp-stage">
          {/* The ledger re-read is the only thing that knows what the target
              reports now. When it failed, its error belongs on this stage too,
              until now it only ever rendered on Pre-flight. */}
          <ErrorNotice
            error={preflightError}
            connectionName={activeConn?.name}
            connectionId={connectionId}
          />
          <VerifyCards
            preflightResult={preflightResult}
            schema={schema}
            activeConn={activeConn}
            runFromVersion={runFromVersion}
            runLastVersion={runLastVersion}
            elapsedMs={elapsedMs}
            appliedScripts={appliedScripts}
            handlePreflight={handlePreflight}
            setStage={setStage}
            orgPath={orgPath}
            afterInitPrompt={afterInitPrompt}
            selectRun={selectRun}
            pendingScripts={pendingScripts}
            runStatus={runStatus}
            driftPhase={driftPhase}
            driftResult={driftResult}
            driftError={driftError}
          />
        </section>
      )}

      <RetireVersionDialog
        script={retireScript}
        busy={retireBusy}
        error={retireError}
        onClose={() => setRetireScript(null)}
        onConfirm={handleRetire}
      />

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

// useSearchParams needs a Suspense boundary above it for the build to succeed.
export default function DeployPage() {
  return (
    <Suspense fallback={null}>
      <DeployBody />
    </Suspense>
  );
}
