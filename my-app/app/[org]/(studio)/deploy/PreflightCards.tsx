"use client";

// ---------------------------------------------------------------------------
// The smaller Pre-flight pieces of the Deploy page: the notes under the page
// header, the Deploy to card, the card that says where the run ships to, the
// version timeline card. Each one only draws what the page hands it; the
// state and the handlers stay in page.tsx.
// ---------------------------------------------------------------------------

import type { Dispatch, JSX, SetStateAction } from "react";
import Link from "next/link";
import { AskAdmin } from "@/components/studio/AskAdmin";
import {
  RefreshIcon,
  AlertCircleIcon,
  InfoIcon,
  ChevronRightIcon,
  LogoIcon,
} from "@/components/ui/icons";
import type { LedgerEntry } from "@/lib/versions/script-status";
import { Select } from "@/components/ui/Select";
import { ExecuteRolePill } from "@/components/ui/ExecuteRolePill";
import { executeRefusal } from "@/lib/connections/access";
import { DEFAULT_ROLE } from "@/lib/roles/permissions";
import type { TimelineRow } from "@/lib/versions/timeline";
import { VersionTimeline } from "@/components/studio/VersionTimeline";
import { HelpHint } from "@/components/ui/HelpHint";
import type { GitHubScript, Connection, PreflightResult } from "./types";
import { skippedNote } from "./helpers";

// The notes under the page header: the looking-only line, a refused run,
// and what went wrong or was skipped while reading the registry.
export function HeadNotes({
  historyOnly,
  role,
  roleLabel,
  runRefusal,
  pullError,
  githubMissing,
  pullWarnings,
}: {
  historyOnly: boolean;
  role: string;
  roleLabel: string;
  runRefusal: string | null;
  pullError: string | null;
  githubMissing: boolean;
  pullWarnings: string[];
}) {
  return (
    <>
      {/* Somebody who only looks, on a Deploy that is not set up: one plain
          line. Nothing to set up and nothing to ask for, so no button. */}
      {historyOnly && (
        <div className="role-note dp-note">
          <InfoIcon size={15} className="ico" />
          <div className="body">
            <p>
              You can see deploys once they run.{" "}
              {role === DEFAULT_ROLE
                ? "Viewers can't start deploys, so there is nothing to set up here."
                : `Your role (${roleLabel}) can't start deploys, so there is nothing to set up here.`}
            </p>
          </div>
        </div>
      )}
      {runRefusal && !historyOnly && (
        <div className="role-note dp-note">
          <InfoIcon size={15} className="ico" />
          <div className="body space-y-0.5">
            <p>
              {runRefusal}
              <AskAdmin permission="deploy:run" />
            </p>
            <p>
              You can still see what is pending on each target and what has run before.
              {" To run one anyway, pick the target and the versions, check the database, and " +
                "press Ask for approval. Once an Admin says yes, you can run that exact run once."}
            </p>
          </div>
        </div>
      )}
      {/* GitHub not being set up is a step on the checklist below, not an error. */}
      {pullError && !githubMissing && (
        <div className="banner">
          <span className="ico">
            <AlertCircleIcon size={16} />
          </span>
          <span>{pullError}</span>
        </div>
      )}
      {/* The pull lists what it could and names what it could not, so a
          version missing below is never a silent gap. */}
      {pullWarnings.length > 0 && (
        <div className="help dp-note dp-warn-text">
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
    </>
  );
}

// The Deploy to card: the target, the schema and the script group.
export function TargetCard({
  targetPicker,
  connectionsLoaded,
  connections,
  connectionsFailed,
  activeConn,
  targetExecuteRole,
  targetIsReadOnly,
  mayExecuteOnTarget,
  roleLabel,
  scriptGroup,
  schema,
  targetLocked,
  schemaScriptNames,
  forgetLink,
  setScriptGroup,
  forgetPreflight,
  setTargetVersion,
  resetRun,
  resetDrift,
  githubScripts,
  orgPath,
  connectionId,
  preflightLoading,
  pullLoading,
  handlePreflight,
}: {
  targetPicker: JSX.Element;
  connectionsLoaded: boolean;
  connections: Connection[];
  connectionsFailed: boolean;
  activeConn: Connection | null;
  targetExecuteRole: "editor" | "admin" | "none";
  targetIsReadOnly: boolean;
  mayExecuteOnTarget: boolean;
  roleLabel: string;
  scriptGroup: string;
  schema: string;
  targetLocked: boolean;
  schemaScriptNames: string[];
  forgetLink: () => void;
  setScriptGroup: Dispatch<SetStateAction<string>>;
  forgetPreflight: () => void;
  setTargetVersion: Dispatch<SetStateAction<string>>;
  resetRun: () => void;
  resetDrift: () => void;
  githubScripts: GitHubScript[] | null;
  orgPath: (path: string) => string;
  connectionId: string;
  preflightLoading: boolean;
  pullLoading: boolean;
  handlePreflight: () => Promise<void>;
}) {
  return (
    <>
      {/* Selection */}
      <div className="card dp-card">
        <h2 className="dp-h-sm">Deploy to</h2>
        <div className="dp-fields" data-tour="deploy-target">
          <div className="dp-field">
            {targetPicker}
            {connectionsLoaded && connections.length === 0 && connectionsFailed && (
              <p className="help mt-1">
                Could not read your saved connections. Reload the page to try again.
              </p>
            )}
            {activeConn && (
              <div className="dp-field-notes">
                <ExecuteRolePill role={targetExecuteRole} />
                {targetIsReadOnly && (
                  <span className="help dp-bad-text">
                    Marked read-only on Connections, so this app will not run migrations
                    against it. Everything else on this page still works.
                  </span>
                )}
                {/* A missing "Deploy: Run" is already said at the top of the page,
                    so only the rule this connection adds is said here. */}
                {targetExecuteRole === "admin" && !mayExecuteOnTarget && (
                  <span className="help dp-bad-text">
                    {/* The apply route's own words, so this line and the
                        refusal a press would get read the same. */}
                    {executeRefusal(activeConn.name, roleLabel, targetExecuteRole)}
                  </span>
                )}
                {targetExecuteRole === "admin" && mayExecuteOnTarget && (
                  <span className="help">Restricted to admins, which includes you.</span>
                )}
              </div>
            )}
          </div>

          <div className="dp-field">
            <label className="label" htmlFor="dep-group">Script group</label>
            <HelpHint label="Script group">
              One named set of migrations that carries a schema forward, one version
              at a time. A group shows up here once a script is saved for this schema.
            </HelpHint>
            <Select
              variant="input"
              id="dep-group"
              className="mt-1"
              ariaLabel="Script group"
              value={scriptGroup}
              disabled={!schema || targetLocked}
              placeholder={!schema ? "Select a schema first" : "Select a script group…"}
              options={schemaScriptNames.map((name) => ({ value: name, label: name }))}
              onChange={(value) => {
                forgetLink();
                setScriptGroup(value);
                forgetPreflight();
                setTargetVersion("");
                resetRun();
                resetDrift();
              }}
            />
            {/*
              This used to be a note beside the Check button, and it required
              scriptGroup to be set, which it can never be when the list is
              empty, because an empty list is exactly what leaves the picker
              on its placeholder. So the one case it was written for was the
              one case it never appeared in: the reader opened the picker,
              read "No options", and got no word on where a script group
              comes from. What a script group is sits in the "?" beside
              the label, and in Help.
            */}
            {githubScripts && schema && schemaScriptNames.length === 0 && (
              <p className="help mt-1">
                No scripts saved for <span className="mono">{schema}</span>{" "}
                yet. Make one on{" "}
                <Link href={orgPath("/compare")} className="underline">
                  Compare &amp; Author
                </Link>
                , or write one by hand in the{" "}
                <Link href={orgPath("/script-editor")} className="underline">
                  Script Editor
                </Link>
                .
              </p>
            )}
          </div>
        </div>

        <div className="dp-check">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!connectionId || !schema || !scriptGroup || preflightLoading || pullLoading}
            onClick={handlePreflight}
          >
            {preflightLoading ? <span className="spin" /> : <RefreshIcon size={13} />}
            {preflightLoading ? "Checking…" : "Check database"}
          </button>
        </div>
      </div>
    </>
  );
}

// Where this run ships to, shown once pre-flight has run.
export function ShipsCard({
  preflightResult,
  activeConn,
  currentLabel,
  selectionLastLabel,
}: {
  preflightResult: PreflightResult;
  activeConn: Connection;
  currentLabel: string;
  selectionLastLabel: string;
}) {
  return (
    <div className="card dp-card dp-ships">
      <div className="dp-db">
        <LogoIcon size={20} />
      </div>
      <div className="dp-where">
        <div className="dp-where-name">
          <span className="dp-clip" title={preflightResult.schema}>{preflightResult.schema}</span>
          <span className="dp-at">@</span>
          <span className="dp-conn dp-clip" title={activeConn.name}>{activeConn.name}</span>
          <span className="pill pill-sync"><span className="dot" />reachable</span>
        </div>
        <div className="dp-where-host">
          {activeConn.host}:{activeConn.port}/{activeConn.database_name}
        </div>
      </div>
      <div className="dp-route">
        <div className="dp-route-end">
          {/* "Applied": the highest script version recorded in the
              target's script_patch, the same word Compare and the
              Script Editor use. Not the lineage number. */}
          <small>Applied to target</small>
          <span className="dp-chip">{currentLabel}</span>
        </div>
        <ChevronRightIcon size={20} />
        <div className="dp-route-end">
          <small>Deploy to</small>
          <span className="dp-chip dp-next">{selectionLastLabel}</span>
        </div>
      </div>
    </div>
  );
}

// The version timeline card.
export function VersionTimelineCard({
  versionLedger,
  scriptGroup,
  appliedCount,
  pendingCount,
  skippedVersions,
  currentLabel,
  timeline,
  revertableVersions,
  rollbackBusy,
  rollBackTo,
}: {
  versionLedger: LedgerEntry[];
  scriptGroup: string;
  appliedCount: number;
  pendingCount: number;
  skippedVersions: string[];
  currentLabel: string;
  timeline: { rows: TimelineRow[]; outdatedSide: "left" | "right" | null; };
  revertableVersions: string[];
  rollbackBusy: "dry" | "real" | null;
  rollBackTo: (row: TimelineRow) => void;
}) {
  return (
    <>
      {/* The version timeline: every version of this family, the
          registry's file on the left and the target's ledger row on
          the right, newest first. The right-hand status is the version
          ledger's Applied / Pending / Skipped, the same one the pending
          list below runs from. Always shown once pre-flight has run.
          "Roll back to here…" only picks that version in the Roll back
          card below, which does the undoing. */}
      {versionLedger.length > 0 && (
        <div className="card dp-card">
          <div className="dp-card-top mb-3">
            <h2 className="dp-h-sm">
              Version timeline · <span className="mono dp-clip" title={scriptGroup}>{scriptGroup}</span>
            </h2>
            <div className="dp-pills">
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
            showHeadVersions
            revertableVersions={revertableVersions}
            revertableFamily={scriptGroup}
            onRevert={rollbackBusy === null ? rollBackTo : undefined}
            leftNoScript="The registry file for this version is empty."
            rightNoScript="The ledger row for this version did not store its SQL (rows written before the ledger kept a copy have none)."
          />
        </div>
      )}
    </>
  );
}
