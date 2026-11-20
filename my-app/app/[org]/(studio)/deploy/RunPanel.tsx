"use client";

// ---------------------------------------------------------------------------
// The Run it card on the right of the Deploy page's Pre-flight stage: the
// summary, the risk gates, the approval panels, the rehearse and ship
// buttons, and the line that says why a button is off. The state and the
// handlers stay in page.tsx and arrive here as props.
// ---------------------------------------------------------------------------

import type { Dispatch, RefObject, SetStateAction } from "react";
import { DeployIcon, AlertTriangleIcon, ChevronRightIcon, EyeIcon } from "@/components/ui/icons";
import { countOf } from "@/lib/ui/plural";
import { versionRange } from "@/lib/deploy/rollback-plan";
import { ApprovalPanel, type ApprovalRow } from "@/components/studio/ApprovalPanel";
import { MigrationReviewPanel } from "@/components/studio/MigrationReviewPanel";
import { RiskGate } from "@/components/studio/RiskGate";
import type { GitHubScript, Connection } from "./types";
import { UNREAD_SQL_SENTENCE } from "./row-notes";
import type { RiskEntry } from "@/lib/deploy/risk";
import type { CurrentUser } from "@/hooks/useUser";

// The Run it card.
export function RunPanel({
  runPanelRef,
  currentLabel,
  selectionLastLabel,
  schema,
  activeConn,
  scriptsUpToTarget,
  bumps,
  breakingCount,
  dataLossScripts,
  dataLossSure,
  linesOfSql,
  louderCount,
  dataLossKinds,
  dataLoss,
  unflaggedDataLossKinds,
  mightFailScripts,
  mightFailKinds,
  enumAdditions,
  driftGateStatus,
  driftGateFromRecord,
  connectionId,
  reviewScripts,
  selectionBody,
  askToRun,
  approvedRun,
  pendingRun,
  latestRun,
  runAsk,
  targetVersion,
  runHash,
  hashError,
  approvalsLoading,
  approvalError,
  approvalsReadError,
  approvals,
  approvalBusy,
  user,
  roleLabel,
  mayApprove,
  bypass,
  approvalNote,
  setApprovalNote,
  handleRequestApproval,
  handleDecideApproval,
  otherApproval,
  otherApprovalVersion,
  selectRun,
  deployLabel,
  dryRunBlocked,
  handleRun,
  dryRunLabel,
  deployBlocked,
  deployButtonRef,
  targetIsReadOnly,
  mayExecuteOnTarget,
  executeBlockedWhy,
  blockedByApplication,
  hasTxnViolation,
  driftChecking,
}: {
  runPanelRef: RefObject<HTMLDivElement | null>;
  currentLabel: string;
  selectionLastLabel: string;
  schema: string;
  activeConn: Connection;
  scriptsUpToTarget: GitHubScript[];
  bumps: string;
  breakingCount: number;
  dataLossScripts: (RiskEntry & { kinds: string[]; })[];
  dataLossSure: boolean;
  linesOfSql: number;
  louderCount: number;
  dataLossKinds: string;
  dataLoss: { named: string[]; unread: boolean; };
  unflaggedDataLossKinds: string[];
  mightFailScripts: (RiskEntry & { kinds: string[]; })[];
  mightFailKinds: string;
  enumAdditions: string[];
  driftGateStatus: "drifted" | "unreachable" | null;
  driftGateFromRecord: boolean;
  connectionId: string;
  reviewScripts: { scriptName: string; version: string; sqlContent: string; }[];
  selectionBody: string;
  askToRun: boolean;
  approvedRun: ApprovalRow | null;
  pendingRun: ApprovalRow | null;
  latestRun: ApprovalRow;
  runAsk: ApprovalRow | null;
  targetVersion: string;
  runHash: string | null;
  hashError: string | null;
  approvalsLoading: boolean;
  approvalError: string | null;
  approvalsReadError: string | null;
  approvals: ApprovalRow[];
  approvalBusy: boolean;
  user: CurrentUser | null;
  roleLabel: string;
  mayApprove: boolean;
  bypass: boolean;
  approvalNote: string;
  setApprovalNote: Dispatch<SetStateAction<string>>;
  handleRequestApproval: () => Promise<void>;
  handleDecideApproval: (id: number, decision: "approve" | "reject", action: "deploy" | "revert") => Promise<void>;
  otherApproval: ApprovalRow | null;
  otherApprovalVersion: string | null;
  selectRun: (version: string) => void;
  deployLabel: string;
  dryRunBlocked: boolean;
  handleRun: (dryRun: boolean) => Promise<void>;
  dryRunLabel: string;
  deployBlocked: boolean;
  deployButtonRef: RefObject<HTMLButtonElement | null>;
  targetIsReadOnly: boolean;
  mayExecuteOnTarget: boolean;
  executeBlockedWhy: string;
  blockedByApplication: GitHubScript[];
  hasTxnViolation: boolean;
  driftChecking: boolean;
}) {
  return (
    <div className="card dp-card dp-run" ref={runPanelRef} tabIndex={-1}>
      <div className="dp-card-top">
        <h2 className="dp-h">Run it</h2>
      </div>
      <div className="dp-route mt-3">
        <span className="dp-chip">{currentLabel}</span>
        <ChevronRightIcon size={16} />
        <span className="dp-chip dp-next"><b>{selectionLastLabel}</b></span>
      </div>
      <dl className="dp-kv">
        {/* The target is named at the top of the page, which is
            not where the button is. */}
        <dt>Target</dt>
        <dd className="mono">{schema} @ {activeConn.name}</dd>
        <dt>Database</dt>
        <dd className="mono">
          {activeConn.host}:{activeConn.port}/{activeConn.database_name}
        </dd>
        <dt>Migrations</dt>
        <dd className="mono">{scriptsUpToTarget.length}</dd>
        <dt title="What the migrations' change types call for: major = breaking, minor = additive, patch = small change. A version number that says otherwise is noted on its row.">
          Bump
        </dt>
        <dd>{bumps}</dd>
        {/* Two rows, because they are two questions. Breaking
            is what stops working after this succeeds; deletes
            rows is what you need a backup for. A rename is the
            first and not the second. */}
        <dt title="Migrations marked breaking, or containing SQL that is always breaking">
          Breaking
        </dt>
        <dd className="mono">{breakingCount}</dd>
        <dt>
          {dataLossScripts.length > 0 && !dataLossSure ? "May delete rows" : "Deletes rows"}
        </dt>
        <dd className="mono">{dataLossScripts.length}</dd>
        <dt>Lines of SQL</dt>
        <dd className="mono">{linesOfSql}</dd>
        <dt>Strategy</dt>
        <dd>one transaction</dd>
      </dl>

      <div className="dp-gates" data-tour="deploy-checklist">
        {breakingCount > 0 && (
          <RiskGate
            tone="break"
            title={`${breakingCount} breaking migration${breakingCount === 1 ? "" : "s"}`}
            body={
              // "Breaking" grades a contract break, not data loss,
              // a rename is breaking and loses nothing. The rows
              // question belongs to the deletes-rows warning below,
              // which names its own backup.
              "A breaking migration drops or rewrites structure that is " +
              "already there. Anything reading the old shape (an app, a " +
              "view, a report) stops working the moment this commits. The " +
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
          />
        )}
        {dataLossScripts.length > 0 && (
          <RiskGate
            tone="break"
            title={
              dataLossSure
                ? `${dataLossScripts.length} ${dataLossScripts.length === 1 ? "migration deletes" : "migrations delete"} rows`
                : `${countOf(dataLossScripts.length, "migration")} may delete rows`
            }
            body={
              (dataLossSure
                ? `This run contains ${dataLossKinds}. Those take rows out of ` +
                  "a live table, and no rollback puts them back: a down " +
                  "script rebuilds structure, not data. "
                : "") +
              (dataLoss.unread ? UNREAD_SQL_SENTENCE : "") +
              (dataLossSure
                ? ""
                : "No rollback puts deleted rows back: a down script " +
                  "rebuilds structure, not data. ") +
              (unflaggedDataLossKinds.length === 0
                ? ""
                : unflaggedDataLossKinds.length === 1
                  ? `A ${unflaggedDataLossKinds[0]} changes no structure, so it is never ` +
                    "graded breaking and gets no breaking pill, so this box is the only " +
                    "warning it gets. "
                  : `${unflaggedDataLossKinds.join(" and ")} change no structure, so they ` +
                    "are never graded breaking and get no breaking pill, so this box is " +
                    "the only warning they get. ") +
              "Have a backup you can restore from before running this."
            }
          />
        )}
        {mightFailScripts.length > 0 && (
          // A quieter line. See the mightFailScripts comment above:
          // the whole run is one transaction, so this is the risk
          // that costs nothing when it happens.
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
              that PostgreSQL checks against every existing row, one
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
              ": there is no statement in PostgreSQL that removes an enum " +
              "value, so it cannot be undone by hand either. A label " +
              "nothing uses does no harm; it is simply the one part of the " +
              "run that is not all-or-nothing. A dry run cannot lift them " +
              "out without leaving them behind, so it runs them inside the " +
              "transaction instead, which is why rehearsing a script that " +
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
                  "Press Check database to run the drift check again before you run this."
                : driftGateStatus === "drifted"
                  ? "The live schema no longer matches the snapshot these " +
                    "migrations were written against, so a migration may hit " +
                    "an object that is not the one it expects. Read the drift " +
                    "report on the left before running this."
                  : "The drift check could not reach the target, so nothing " +
                    "here has confirmed what state it is in. The run will " +
                    "still connect. This only means it starts unverified."
            }
          />
        )}
        {connectionId && scriptsUpToTarget.length > 0 && (
          <MigrationReviewPanel
            connectionId={Number(connectionId)}
            schemaName={schema}
            action="deploy"
            scripts={reviewScripts}
            resetKey={`${connectionId}|${schema}|${selectionBody}`}
          />
        )}
        {/* The asker's own panel, and the answer panel for
            somebody else's ask of this exact run. */}
        {[
          askToRun
            ? { key: "own", own: true, approved: approvedRun, pending: pendingRun, latest: latestRun }
            : null,
          runAsk ? { key: "ask", own: false, approved: null, pending: runAsk, latest: runAsk } : null,
        ].map(
          (panel) =>
            panel && (
              <ApprovalPanel
                key={panel.key}
                migrationCount={scriptsUpToTarget.length}
                targetVersion={targetVersion}
                hashReady={runHash !== null}
                hashError={hashError}
                loading={approvalsLoading}
                error={approvalError ?? approvalsReadError}
                unreadable={approvalsReadError !== null && approvals.length === 0}
                busy={approvalBusy}
                approved={panel.approved}
                pending={panel.pending}
                latest={panel.latest}
                viewerEmail={user?.email ?? ""}
                roleLabel={roleLabel}
                askToRun={panel.own}
                mayApprove={mayApprove}
                bypass={bypass}
                note={approvalNote}
                onNoteChange={setApprovalNote}
                onRequest={handleRequestApproval}
                onDecide={(id, decision) => void handleDecideApproval(id, decision, "deploy")}
                otherApproval={panel.own ? otherApproval : null}
                onSelectOther={
                  otherApprovalVersion ? () => selectRun(otherApprovalVersion) : undefined
                }
                runButton={deployLabel}
              />
            )
        )}
      </div>

      <div className="dp-zone" data-tour="deploy-run">
        <h3 className="dp-h-sm">Rehearse</h3>
        <p>
          Runs this SQL on the target inside one transaction, then rolls it
          back. Nothing is written.
        </p>
        {/* A rehearsal writes nothing, but it really runs the SQL,
            including any statement that takes a heavy lock, so it
            needs the same permission as a real run. */}
        <button
          type="button"
          className="btn btn-secondary"
          disabled={dryRunBlocked}
          onClick={() => handleRun(true)}
        >
          <EyeIcon size={14} />
          {dryRunLabel}
        </button>
      </div>
      <div className="dp-or">then</div>
      <div className={deployBlocked ? "dp-zone dp-live" : "dp-zone dp-live dp-armed"}>
        <h3 className="dp-h-sm">Ship for real</h3>
        <p>
          Writes to {activeConn.name} (<span className="mono">{activeConn.database_name}.{schema}</span>). This is the real run.
        </p>
        <button
          type="button"
          className="btn btn-lg btn-primary"
          disabled={deployBlocked}
          onClick={() => handleRun(false)}
          ref={deployButtonRef}
        >
          <DeployIcon size={14} />
          {/* Names the range it deploys, as the "Run …" button that
              picked it did: "Deploy v5.0.1 → v5.0.2 (2)". */}
          {deployLabel}
        </button>
      </div>
      {/* Why the buttons are off, or what pressing them does. */}
      <p className="dp-why">
        {targetIsReadOnly
          ? "This connection is marked read-only on Connections, so nothing " +
            "here will run against it, not a deploy and not a dry run"
          : !mayExecuteOnTarget && !askToRun
          ? `Running migrations on this connection ${executeBlockedWhy}`
          : blockedByApplication.length > 0
          ? `${versionRange(
                              blockedByApplication.map((script) => script.version)
                            )} is restricted, and nothing here can confirm this database is ` +
            "one of the applications named. Name this database's application " +
            "table on its connection, or take the restriction out of the script"
          : hasTxnViolation
          ? "Remove the COMMIT or ROLLBACK from the versions named in " +
            "the checklist, then pull again"
          : driftChecking
            ? "Checking the target for drift first. These unlock when the check finishes"
            : askToRun && !approvedRun
              ? "Your role may not run migrations here by itself, so the deploy waits " +
                "for an Admin to approve it. A dry run runs the same SQL on the live database, " +
                "so your role can't start one here either"
              : enumAdditions.length > 0
              ? "All migrations run in one transaction: all of them or " +
                "none, apart from the enum values noted above"
              : "All migrations run in one transaction: all of them or none"}
      </p>
    </div>
  );
}
