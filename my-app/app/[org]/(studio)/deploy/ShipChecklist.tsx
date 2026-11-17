"use client";

// ---------------------------------------------------------------------------
// The Before you ship card of the Deploy page's Pre-flight stage: one line
// per thing checked before a run. The page works the answers out and hands
// them over as props.
// ---------------------------------------------------------------------------

import { countOf } from "@/lib/ui/plural";
import { permissionLabel } from "@/lib/roles/permissions";
import { vLabel } from "@/lib/deploy/rollback-plan";
import type { ApprovalRow } from "@/components/studio/ApprovalPanel";
import type { GitHubScript, Connection, PreflightResult, DriftResult, DriftPhase } from "./types";
import { ChecklistItem } from "./DriftPanel";
import type { RiskEntry } from "@/lib/deploy/risk";

// The Before you ship card.
export function ShipChecklist({
  activeConn,
  targetIsReadOnly,
  askToRun,
  approvedRun,
  roleLabel,
  mayExecuteOnTarget,
  targetExecuteRole,
  preflightResult,
  blockedByApplication,
  addressedElsewhere,
  hasTxnViolation,
  txnViolationScripts,
  breakingCount,
  louderCount,
  dataLossScripts,
  dataLossSure,
  dataLossKinds,
  dataLoss,
  mightFailScripts,
  mightFailKinds,
  enumAdditions,
  approvalsReadError,
  pendingRun,
  driftPhase,
  driftGateFromRecord,
  driftGateStatus,
  driftResult,
}: {
  activeConn: Connection;
  targetIsReadOnly: boolean;
  askToRun: boolean;
  approvedRun: ApprovalRow | null;
  roleLabel: string;
  mayExecuteOnTarget: boolean;
  targetExecuteRole: "editor" | "admin" | "none";
  preflightResult: PreflightResult;
  blockedByApplication: GitHubScript[];
  addressedElsewhere: GitHubScript[];
  hasTxnViolation: boolean;
  txnViolationScripts: GitHubScript[];
  breakingCount: number;
  louderCount: number;
  dataLossScripts: (RiskEntry & { kinds: string[]; })[];
  dataLossSure: boolean;
  dataLossKinds: string;
  dataLoss: { named: string[]; unread: boolean; };
  mightFailScripts: (RiskEntry & { kinds: string[]; })[];
  mightFailKinds: string;
  enumAdditions: string[];
  approvalsReadError: string | null;
  pendingRun: ApprovalRow | null;
  driftPhase: DriftPhase;
  driftGateFromRecord: boolean;
  driftGateStatus: "drifted" | "unreachable" | null;
  driftResult: DriftResult | null;
}) {
  return (
    <div className="card dp-card">
      <h2 className="dp-h">Before you ship</h2>
      <ul className="dp-pre">
        <ChecklistItem ok>Target reachable · {activeConn.host}</ChecklistItem>
        {/* Only the settings that stop or narrow a run get a
            row. The default one is what a checklist reader
            assumes, and a line confirming the assumption is a
            line they learn to skip. */}
        {targetIsReadOnly ? (
          <ChecklistItem ok={false}>
            Execution · read-only: this app will not write to this database
          </ChecklistItem>
        ) : askToRun ? (
          <ChecklistItem ok={Boolean(approvedRun)}>
            {approvedRun
              ? "Execution · approved for you, for this one run"
              : `Execution · ${roleLabel} may run this only with an Admin's approval`}
          </ChecklistItem>
        ) : !mayExecuteOnTarget ? (
          <ChecklistItem ok={false}>
            {targetExecuteRole === "admin"
              ? `Execution · admins only · your role is ${roleLabel}`
              : `Execution · needs "${permissionLabel("deploy:run")}" · ${roleLabel} does not have it`}
          </ChecklistItem>
        ) : targetExecuteRole === "admin" ? (
          <ChecklistItem ok>Execution · admins only · you qualify</ChecklistItem>
        ) : null}
        <ChecklistItem ok>
          Applied state read · {preflightResult.currentVersion ? <>at <span className="mono">{vLabel(preflightResult.currentVersion)}</span></> : "fresh, no versions yet"}
        </ChecklistItem>
        <ChecklistItem ok={blockedByApplication.length === 0}>
          {/* Silent when nothing is restricted, which is every
              run until somebody writes the header, but a tick
              rather than nothing, so a reader who has used the
              feature can see it was checked. */}
          {blockedByApplication.length > 0
            ? `Restriction could not be checked · ${blockedByApplication
                                .map((script) => vLabel(script.version))
                                .join(", ")} (see the note on the row)`
            : addressedElsewhere.length > 0
              ? `Applications · ${addressedElsewhere.length} pending ${
                                  addressedElsewhere.length === 1 ? "version is" : "versions are"
                                } for other applications and ${
                                  addressedElsewhere.length === 1 ? "is" : "are"
                                } not in this run`
            : preflightResult.applications.known
              ? `Applications · this database hosts ${
                                  preflightResult.applications.names.length > 0
                                    ? preflightResult.applications.names.join(", ")
                                    : "none by name"
                                }`
              : "No script in this run is restricted to an application"}
        </ChecklistItem>
        <ChecklistItem ok={!hasTxnViolation}>
          {/* A count leaves the reader to open every script and
              hunt. The versions are already in scope, name them,
              and state the rule the apply route enforces. */}
          {hasTxnViolation
            ? `COMMIT or ROLLBACK found in ${txnViolationScripts
                                .map((s) => vLabel(s.version))
                                .join(", ")}. The run is already one transaction, so ` +
              "remove them from the SQL"
            : "No transaction-control in SQL"}
        </ChecklistItem>
        {breakingCount > 0 ? (
          // `info`: a warning to read, which stops nothing.
          <ChecklistItem info>
            {/* Counted as describeChangeType counts: marked
                breaking, or containing SQL that is always
                breaking whatever the mark says. */}
            Breaking changes · {breakingCount}
            {louderCount > 0
              ? `, including ${louderCount} marked less than breaking whose SQL is always breaking`
              : ""}
          </ChecklistItem>
        ) : (
          <ChecklistItem ok>
            Nothing in this run drops or rewrites structure
          </ChecklistItem>
        )}
        {dataLossScripts.length > 0 ? (
          <ChecklistItem info>
            {dataLossSure
              ? `Deletes rows · ${dataLossKinds}${dataLoss.unread ? ", and part of the SQL could not be read" : ""}`
              : "May delete rows · part of the SQL could not be read"}{" "}
            in{" "}
            {countOf(dataLossScripts.length, "script")}
          </ChecklistItem>
        ) : (
          <ChecklistItem ok>No statement found that deletes rows</ChecklistItem>
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
        {askToRun &&
          (approvalsReadError && !approvedRun ? (
            // "not requested yet" would be a reading of a list
            // this page never managed to read.
            <ChecklistItem info>Approval · could not be read</ChecklistItem>
          ) : (
            <ChecklistItem ok={Boolean(approvedRun)}>
              {approvedRun
                ? `Approved by ${approvedRun.decided_by ?? "an Admin"}`
                : pendingRun
                  ? "Approval requested · waiting for an Admin"
                  : "Approval · not requested yet"}
            </ChecklistItem>
          ))}
        {preflightResult.needsInit ? (
          <ChecklistItem info>
            {/* The apply route creates it before BEGIN, so it is
                not covered by the run's rollback either. */}
            Ledger table will be created on first deploy. It is
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
            <ChecklistItem ok={false}>
              Drift check · check failed, and the last check on record found
              the target {driftGateStatus === "drifted" ? "drifted" : "unreachable"}
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
            <ChecklistItem ok={false}>Drift check · live schema has drifted</ChecklistItem>
          ) : (
            <ChecklistItem ok={false}>Drift check · target unreachable</ChecklistItem>
          )
        )}
        {driftPhase === "idle" && (
          <ChecklistItem stub>Drift check · run a check to see status</ChecklistItem>
        )}
      </ul>
    </div>
  );
}
