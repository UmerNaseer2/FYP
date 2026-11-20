"use client";

// ---------------------------------------------------------------------------
// The Run stage of the Deploy page in three parts: the head card, the list
// of migrations as they run, and what the page says once the run is over.
// The state and the handlers stay in page.tsx and arrive here as props.
// ---------------------------------------------------------------------------

import type { Dispatch, SetStateAction } from "react";
import {
  DeployIcon,
  CheckIcon,
  XIcon,
  AlertCircleIcon,
  AlertTriangleIcon,
} from "@/components/ui/icons";
import type { RegistryNote } from "@/lib/github/registry-report";
import { describeChangeType } from "@/lib/versions/change-type";
import { countOf } from "@/lib/ui/plural";
import { vLabel } from "@/lib/deploy/rollback-plan";
import type { ApprovalRow } from "@/components/studio/ApprovalPanel";
import type { GitHubScript, Connection, PreflightResult, RunStatus, RunCell } from "./types";
import { scriptKey, fmtStatements, fmtSecs, warningNotes, rollbackCheckNotes, rollbackFailedText } from "./helpers";
import { MigRow } from "./MigRow";
import type { SelectionChange } from "./helpers";

// A run row's notes: the louder reading of its SQL, if any, then the warnings
// PostgreSQL sent while it ran, then how the dry run's try of its rollback
// went. None at all leaves the row without a notes box.
function rowNotes(louderNote: string | null | undefined, cell: RunCell, versionLabel: string) {
  const notes = [
    ...(louderNote ? [{ text: louderNote, warn: true }] : []),
    ...warningNotes(cell),
    ...rollbackCheckNotes(cell, versionLabel),
  ];
  return notes.length > 0 ? notes : undefined;
}

// The head card of the Run stage: what is happening, and the counts.
export function RunHead({
  isDeploying,
  runIsDryRun,
  runOutcomeUnknown,
  allApplied,
  allRehearsed,
  runRefused,
  runNotStarted,
  runLimited = false,
  enumAdditions,
  elapsedMs,
  stopBusy,
  stopActiveRun,
  runTone,
}: {
  isDeploying: boolean;
  runIsDryRun: boolean;
  runOutcomeUnknown: boolean;
  allApplied: boolean;
  allRehearsed: boolean;
  runRefused: boolean;
  runNotStarted: boolean;
  /** The dry run stopped on a limit of the rehearsal, not on a fault. */
  runLimited?: boolean;
  enumAdditions: string[];
  elapsedMs: number;
  stopBusy: boolean;
  stopActiveRun: () => Promise<void>;
  runTone: "dp-busy" | "dp-mid" | "dp-good" | "dp-bad";
}) {
  return (
    <div className="card dp-card">
      <div className="dp-run-head">
        <div>
          <h2 className="dp-h">
          {/* "nothing was applied" is a verdict, and on an unknown outcome
              it is the wrong one, it used to sit directly above an error
              saying the run may still have landed. */}
          {isDeploying
            ? runIsDryRun
              ? "Rehearsing migrations…"
              : "Applying migrations…"
            : runOutcomeUnknown
              ? "Run outcome not known. Check the target before retrying"
              : allApplied
                ? "Run finished"
                : allRehearsed
                  ? "Dry run finished, nothing was written"
                  : runRefused
                    ? runIsDryRun
                      ? "Dry run refused, nothing was run"
                      : "Run refused, nothing was applied"
                    : runNotStarted
                      ? runIsDryRun
                        ? "Dry run did not start, nothing was run"
                        : "Run did not start, nothing was applied"
                      : runLimited
                        ? "A dry run can't rehearse this run. Nothing was written"
                        : runIsDryRun
                          ? "Dry run halted, nothing was written"
                          : "Run halted, nothing was applied"}
          </h2>
          <p className="dp-sub">
          {/* The enum values are lifted out and committed before the
              transaction opens, so the unqualified promise is false for
              exactly this run, the same exception the gate above states.
              A refused run or one that did not start stopped before that
              step (the only refusal after it names its enum values in its
              own card below), so the exception would claim a commit that
              never happened. */}
          {runIsDryRun
            ? "Every migration really runs against the target, inside one transaction that always ends in ROLLBACK."
            : enumAdditions.length > 0 && !runRefused && !runNotStarted
              ? "Every migration runs inside one transaction. A failure rolls " +
                "the whole run back: all of them or none, apart from the enum " +
                "values that were committed first."
              : "Every migration runs inside one transaction. A failure rolls the whole run back: all of them or none."}
          </p>
        </div>
        <div className="dp-pills">
          {runIsDryRun && (
            <span className="pill pill-neutral">
              <span className="dot" />
              dry run
            </span>
          )}
          <span className="dp-elapsed">elapsed {fmtSecs(elapsedMs)}</span>
          {/* Stop rolls the run back on the server, as a failure would. */}
          {isDeploying && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={stopBusy}
              onClick={() => void stopActiveRun()}
            >
              <XIcon size={13} />
              {stopBusy ? "Stopping…" : "Stop"}
            </button>
          )}
        </div>
      </div>
      {/* The app is not told about each statement as it runs, so while a
          run is going the bar only shows that it is going. */}
      <div className={`dp-prog ${runTone}`} aria-hidden="true">
        <i />
      </div>
    </div>
  );
}

// The migrations of this run, one row each.
export function RunList({
  runScripts,
  runStatus,
  runRefused,
  runNotStarted,
  runLimited = false,
  runOutcomeUnknown,
  runProgress,
  runIsDryRun,
  totalStatements,
  schema,
  activeConn,
}: {
  runScripts: GitHubScript[];
  runStatus: Record<string, RunCell>;
  runRefused: boolean;
  runNotStarted: boolean;
  runLimited?: boolean;
  runOutcomeUnknown: boolean;
  runProgress: number;
  runIsDryRun: boolean;
  totalStatements: number;
  schema: string;
  activeConn: Connection | null;
}) {
  return (
    <div className="card dp-card">
    <div className="dp-mig-list">
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
          // The row says what happened; the dp-err below says what
          // Postgres said, one each, not both twice.
          // A refused run, or one that never started, never got going,
          // so there is nothing to have rolled back; the row names what
          // happened instead.
          failed: runRefused
            ? "refused · the server's reason is below"
            : runNotStarted
              ? "not run · the server's reason is below"
              : runLimited
                ? "not rehearsed · a limit of the dry run, not a fault in this script"
                : "failed · the whole run was rolled back",
          skipped: runRefused
            ? "skipped · the server refused the run, and nothing in it was applied"
            : runNotStarted
              ? "skipped · the run never started, so nothing in it ran"
              : "skipped · the run rolled back before this one could commit",
          unknown: "not known · the commit never reported back, read script_patch",
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
            notes={rowNotes(reading.louderNote, cell, vLabel(script.version))}
            limited={runLimited}
          />
        );
      })}
    </div>

    <div className="dp-foot">
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
    </div>
  );
}

// After the run: registry notes, a clean rehearsal, or how to recover.
export function RunResults({
  runComplete,
  runRegistry,
  allRehearsed,
  ledgerReread,
  preflightResult,
  ledgerRereadFailed,
  askToRun,
  approvedRun,
  rehearsalChange,
  ranName,
  nowName,
  runRange,
  deployBlocked,
  handleRun,
  driftChecking,
  setStage,
  allApplied,
  runOutcomeUnknown,
  runRefused,
  runNotStarted,
  runIsDryRun,
  repeatChange,
  dryRunBlocked,
  failedScript = null,
  onRetire,
  warningTotal = 0,
  runLimited = false,
  brokenRollback = null,
}: {
  runComplete: boolean;
  runRegistry: RegistryNote | null;
  allRehearsed: boolean;
  ledgerReread: "read" | "failed" | "reading";
  preflightResult: PreflightResult | null;
  ledgerRereadFailed: string;
  askToRun: boolean;
  approvedRun: ApprovalRow | null;
  rehearsalChange: SelectionChange | null;
  ranName: string;
  nowName: string;
  runRange: string;
  deployBlocked: boolean;
  handleRun: (dryRun: boolean) => Promise<void>;
  driftChecking: boolean;
  setStage: Dispatch<SetStateAction<2 | 3 | 1>>;
  allApplied: boolean;
  runOutcomeUnknown: boolean;
  runRefused: boolean;
  runNotStarted: boolean;
  runIsDryRun: boolean;
  repeatChange: SelectionChange | null;
  dryRunBlocked: boolean;
  /** The version the run stopped at, while Deploy still offers it. */
  failedScript?: GitHubScript | null;
  /** Opens the Retire dialog; absent when the role may not retire. */
  onRetire?: (script: GitHubScript) => void;
  /** Warnings PostgreSQL sent during the run, over all its versions. */
  warningTotal?: number;
  /** The dry run stopped on a limit of the rehearsal, not on a fault. */
  runLimited?: boolean;
  /** The version whose rollback failed when a clean dry run tried it. */
  brokenRollback?: { versionLabel: string; error?: string } | null;
}) {
  return (
    <>
      {/* The GitHub registry, when the run changed it or failed to (spec 07).
          Normally silent: Deploy's scripts came out of the registry, so it
          already lists them and there is nothing to record. */}
      {runComplete && runRegistry?.saved && (
        <div className="warn-inline">
          <CheckIcon size={16} className="ico dp-good-text" />
          <div className="body">
            <div className="title">Recorded in GitHub</div>
            <div>{runRegistry.saved}</div>
          </div>
        </div>
      )}
      {runComplete && runRegistry?.problem && (
        <div className="warn-inline">
          <AlertTriangleIcon size={16} className="ico" />
          <div className="body">
            {/* Not an error: the migrations applied. What is wrong is that
                GitHub does not list them, so the next reader of the
                registry would not know this database has them. */}
            <div className="title">Applied, but not recorded in GitHub</div>
            <div>{runRegistry.problem}</div>
          </div>
        </div>
      )}

      {/* Clean rehearsal, say what it proved, and offer the real thing. */}
      {runComplete && allRehearsed && (
        <div className="dp-result dp-good">
          <h3>
            <CheckIcon size={20} />
              Rehearsal clean: the target accepted every migration.
          </h3>
          <p>
              Then it was rolled back: no ledger rows, no lineage advance, no schema
              change.{" "}
              {ledgerReread === "read" ? (
                <>
                  The ledger has been re-read and still reads{" "}
                  <span className="mono">
                    {preflightResult?.currentVersion ? vLabel(preflightResult.currentVersion) : "no versions yet"}
                  </span>.
                </>
              ) : ledgerReread === "reading" ? (
                "Reading the ledger again…"
              ) : (
                ledgerRereadFailed
              )}
          </p>
            {/* Accepted is not the same as done: an owner change the login
                may not make is skipped with a warning, and Deploy runs the
                same SQL, so it would be skipped then too. */}
            {warningTotal > 0 && (
              <div className="dp-warn-text">
                {`PostgreSQL sent ${countOf(warningTotal, "warning")} during the rehearsal, shown under ` +
                  `${warningTotal === 1 ? "its version" : "the versions"} above. Deploy runs the same SQL, ` +
                  `so expect ${warningTotal === 1 ? "it" : "them"} again.`}
              </div>
            )}
            {/* A warning only: the migrations themselves rehearsed cleanly,
                so Deploy for real stays open. It matters now because the
                real run saves the rollback as it is. */}
            {brokenRollback && (
              <div className="dp-warn-text" role="status">
                {rollbackFailedText(brokenRollback.versionLabel, brokenRollback.error)}
              </div>
            )}
            {askToRun && !approvedRun && (
              <div className="dp-warn-text">
                A clean rehearsal is not an approval. Go back to Pre-flight to
                ask for approval of the real run.
              </div>
            )}
            {/* Deploy for real deploys the selection, not the batch above,
                so it waits while the two differ: another range picked, the
                SQL re-pulled, or the re-read ledger moved what is pending. */}
            {rehearsalChange !== null && (
              <div className="dp-warn-text">
                {rehearsalChange === "range"
                  ? `You rehearsed ${ranName}; the selection is now ${nowName}. Rehearse this selection, or pick the rehearsed range again.`
                  : rehearsalChange === "scripts"
                    ? `The registry’s copy of ${runRange} has changed since you rehearsed it, so this rehearsal no longer covers what would run. Go back to Pre-flight and rehearse it again.`
                    : `You rehearsed ${runRange}, but nothing is selected to deploy now. Go back to Pre-flight to see what is pending.`}
              </div>
            )}
          <div className="dp-row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={deployBlocked || rehearsalChange !== null}
            onClick={() => handleRun(false)}
          >
            <DeployIcon size={13} />
            {/* The drift check re-runs after every run (see driftChecking). */}
            {driftChecking ? "Checking the target for drift…" : "Deploy for real"}
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setStage(1)}>
            Back to Pre-flight
          </button>
          </div>
        </div>
      )}

      {/* A dry run that hit the one thing a rehearsal cannot do. Not a
          failure: the script may be fine, so there is no "Rehearse again"
          (it would stop the same way) and no offer to retire the version. */}
      {runComplete && runLimited && !allRehearsed && (
        <div className="dp-result dp-mid" role="status">
          <h3>
            <AlertTriangleIcon size={20} />
            A dry run can&apos;t rehearse this run.
          </h3>
          <p>
            This is a limit of the dry run, not a fault in your script. The run adds an enum
            value and then uses it. A real deploy adds the value first, on its own, so the
            same SQL can still work there. The dry run was rolled back and nothing was written.
          </p>
          <div className="dp-warn-text">
            A real deploy of this run goes ahead without a rehearsal. Read the SQL on
            Pre-flight first.
          </div>
          <div className="dp-row">
            <button type="button" className="btn btn-primary" onClick={() => setStage(1)}>
              Back to Pre-flight
            </button>
          </div>
        </div>
      )}

      {/* Recovery bar, only after a failed run */}
      {runComplete && !allApplied && !allRehearsed && !runLimited && (
        <div className={runOutcomeUnknown ? "dp-result dp-mid" : "dp-result dp-bad"}>
          <h3>
            <AlertCircleIcon size={20} />
              {runOutcomeUnknown
                ? "Run outcome not known."
                : runRefused
                  ? "Run refused."
                  : runNotStarted
                    ? "Run did not start."
                    : "Run did not complete."}
          </h3>
          <p>
              {/* Only a response we actually read licenses the claim that
                  nothing changed. "Fix the script" is gone too, a lock
                  timeout and a duplicate version have no script to fix, and
                  the server's own instruction is already in the card above. */}
              {runOutcomeUnknown
                ? "This page never saw the run finish, so it cannot say what the " +
                  "target has now. Press Check database on Pre-flight and read the " +
                  "ledger before you run this again."
                : runRefused || runNotStarted
                ? (runRefused
                    ? "The server refused this run, so none of the migrations above " +
                      "are applied. Its reason is in the card above."
                    : "The server stopped before the run started, so nothing was " +
                      "written to the target. Its reason is in the card above.") +
                  // Nothing ran, so the re-read is only news when it failed:
                  // then Pre-flight has nothing pending, and this says why.
                  (ledgerReread === "failed" ? ` ${ledgerRereadFailed}` : "")
                : (runIsDryRun
                    ? "The dry run rolled back, so nothing was written to the target."
                    : "The run rolled back, so none of the migrations above are " +
                      "applied. Anything that had to commit before the transaction " +
                      "opened is still there: the ledger table on a first deploy, and " +
                      "any enum value listed on Pre-flight.") +
                  (ledgerReread === "read"
                    ? " The ledger has been re-read."
                    : ledgerReread === "reading"
                      ? " Reading the ledger again…"
                      : ` ${ledgerRereadFailed}`)}
          </p>
            {/* Run again starts the selection, not the batch above, so it
                waits while the two differ. That also keeps a run whose
                commit may have landed from going out twice: the re-read
                ledger moves what is pending, and with it the selection. */}
            {/* After a failed re-read nothing is pending because the ledger
                could not be read, and the line above already says to press
                Check database. "Nothing is selected" would hide that. */}
            {repeatChange !== null && !(repeatChange === "nothing" && ledgerReread === "failed") && (
              <div className="dp-warn-text">
                {repeatChange === "range"
                  ? `Pre-flight now selects ${nowName}, and this ${runIsDryRun ? "rehearsal" : "run"} was ${ranName}, so it cannot be repeated from here. Go back to Pre-flight to start the one you want.`
                  : repeatChange === "scripts"
                    ? `The registry’s copy of ${runRange} has changed since this ${runIsDryRun ? "rehearsal" : "run"}, so it cannot be repeated from here. Go back to Pre-flight to read the new SQL and start it from there.`
                    : `Nothing is selected to run now, so this ${runIsDryRun ? "rehearsal" : "run"} cannot be repeated from here. Go back to Pre-flight to see what is pending.`}
              </div>
            )}
            {repeatChange === null && !driftChecking && !runIsDryRun && askToRun && !approvedRun && (
              <div className="dp-warn-text">
                This deploy needs an Admin&apos;s approval first. Go back to Pre-flight to ask for one.
              </div>
            )}
            {/* A version that should never run blocks every version after
                it. Retiring it in GitHub is the way past. */}
            {failedScript && !runOutcomeUnknown && (
              <div className="dp-warn-text">
                {`If ${failedScript.script_name} ${vLabel(failedScript.version)} should never run, ${
                  onRetire ? "you" : "an Admin"
                } can retire it. Deploy then stops offering it, and the versions after it can run.`}
              </div>
            )}
          <div className="dp-row">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={(runIsDryRun ? dryRunBlocked : deployBlocked) || repeatChange !== null}
            onClick={() => handleRun(runIsDryRun)}
          >
            {driftChecking
              ? "Checking the target for drift…"
              : runIsDryRun
                ? "Rehearse again"
                : "Run again"}
          </button>
          {failedScript && !runOutcomeUnknown && onRetire && (
            <button type="button" className="btn btn-secondary" onClick={() => onRetire(failedScript)}>
              {`Retire ${vLabel(failedScript.version)}…`}
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={() => setStage(1)}>
            Back to Pre-flight
          </button>
          </div>
        </div>
      )}
    </>
  );
}
