"use client";

// ---------------------------------------------------------------------------
// The Roll back card of the Deploy page's Pre-flight stage: the planner, its
// preview, its warnings, the buttons and the list of earlier rollbacks. The
// state and the handlers stay in page.tsx and arrive here as props.
// ---------------------------------------------------------------------------

import type { Dispatch, RefObject, SetStateAction } from "react";
import Link from "next/link";
import { CheckIcon, XIcon, ChevronDownIcon, EyeIcon } from "@/components/ui/icons";
import { countOf } from "@/lib/ui/plural";
import { Select } from "@/components/ui/Select";
import { listVersions, MAX_ROLLBACK_VERSIONS, vLabel } from "@/lib/deploy/rollback-plan";
import { ApprovalPanel, type ApprovalRow } from "@/components/studio/ApprovalPanel";
import { MigrationReviewPanel } from "@/components/studio/MigrationReviewPanel";
import { RiskGate } from "@/components/studio/RiskGate";
import { HelpHint } from "@/components/ui/HelpHint";
import type {
  GitHubScript,
  PreflightResult,
  OtherScriptEntry,
  DriftResult,
  DriftPhase,
} from "./types";
import { getSqlLineCount, fmtDate } from "./helpers";
import { rollbackLossSentence } from "./row-notes";
import { DriftPanel } from "./DriftPanel";
import type { RollbackStep } from "@/lib/deploy/rollback-plan";
import type { CurrentUser } from "@/hooks/useUser";
import type { RevertedEntry } from "./types";

// The Roll back card.
export function RollbackCard({
  appliedNewestFirst,
  rollbackDone,
  revertedHistory,
  rollbackCardRef,
  scriptGroup,
  rollbackBusy,
  setRollbackOpen,
  rollbackOpen,
  preflightResult,
  driftPhase,
  driftResult,
  driftError,
  rollbackPlannerShown,
  rollbackErrorShown,
  rollbackPick,
  rollbackOptions,
  setRollbackChoice,
  rollbackListCapped,
  rollbackSteps,
  rollbackProblems,
  rollbackDataLoss,
  orgPath,
  rollbackLossSure,
  rollbackOthers,
  rollbackOldest,
  rollbackOtherScripts,
  rollbackKey,
  connectionId,
  rollbackReady,
  schema,
  rollbackReviewScripts,
  askToRun,
  approvedRollback,
  pendingRollback,
  latestRollback,
  rollbackAsk,
  rollbackHash,
  rollbackHashError,
  approvalsLoading,
  rollbackApprovalError,
  approvalsReadError,
  approvals,
  approvalBusy,
  user,
  roleLabel,
  mayApprove,
  bypass,
  rollbackApprovalNote,
  setRollbackApprovalNote,
  handleRequestRollbackApproval,
  handleDecideApproval,
  rollbackDryRun,
  rollbackBlocked,
  handleRollback,
  rollbackRunBlocked,
  rollbackTarget,
  stopBusy,
  stopActiveRun,
  rollbackHint,
}: {
  appliedNewestFirst: string[];
  rollbackDone: { message: string; } | null;
  revertedHistory: RevertedEntry[];
  rollbackCardRef: RefObject<HTMLDivElement | null>;
  scriptGroup: string;
  rollbackBusy: "dry" | "real" | null;
  setRollbackOpen: Dispatch<SetStateAction<boolean>>;
  rollbackOpen: boolean;
  preflightResult: PreflightResult;
  driftPhase: DriftPhase;
  driftResult: DriftResult | null;
  driftError: string | null;
  rollbackPlannerShown: boolean;
  rollbackErrorShown: string | null;
  rollbackPick: string;
  rollbackOptions: { value: string; label: string; }[];
  setRollbackChoice: Dispatch<SetStateAction<string | null>>;
  rollbackListCapped: boolean;
  rollbackSteps: RollbackStep<GitHubScript>[];
  rollbackProblems: { text: string; editor: boolean; version: string; }[];
  rollbackDataLoss: { version: string; kinds: string[]; }[];
  orgPath: (path: string) => string;
  rollbackLossSure: boolean;
  rollbackOthers: OtherScriptEntry[];
  rollbackOldest: string | null;
  rollbackOtherScripts: { key: string; list: OtherScriptEntry[]; } | null;
  rollbackKey: string;
  connectionId: string;
  rollbackReady: boolean;
  schema: string;
  rollbackReviewScripts: { scriptName: string; version: string; sqlContent: string; }[];
  askToRun: boolean;
  approvedRollback: ApprovalRow | null;
  pendingRollback: ApprovalRow | null;
  latestRollback: ApprovalRow;
  rollbackAsk: ApprovalRow | null;
  rollbackHash: string | null;
  rollbackHashError: string | null;
  approvalsLoading: boolean;
  rollbackApprovalError: string | null;
  approvalsReadError: string | null;
  approvals: ApprovalRow[];
  approvalBusy: boolean;
  user: CurrentUser | null;
  roleLabel: string;
  mayApprove: boolean;
  bypass: boolean;
  rollbackApprovalNote: string;
  setRollbackApprovalNote: Dispatch<SetStateAction<string>>;
  handleRequestRollbackApproval: () => Promise<void>;
  handleDecideApproval: (id: number, decision: "approve" | "reject", action: "deploy" | "revert") => Promise<void>;
  rollbackDryRun: { key: string; message: string; } | null;
  rollbackBlocked: boolean;
  handleRollback: (dryRun: boolean) => Promise<void>;
  rollbackRunBlocked: boolean;
  rollbackTarget: string | null;
  stopBusy: boolean;
  stopActiveRun: () => Promise<void>;
  rollbackHint: string;
}) {
  return (
    <>
      {/* Roll back: undo the newest applied versions of this family,
          newest first, in one transaction. The preview is what the
          revert route will run (planRollback shares its rule), and
          the panel warns about rollbacks that delete rows and about
          other scripts applied since. Somebody whose role may not
          roll back here asks an Admin to approve this exact rollback
          SQL. */}
      {/* The list of every attempt, failed and refused ones too, now
          sits in the timeline card at the top, which always shows. */}
      {(appliedNewestFirst.length > 0 ||
        rollbackDone ||
        revertedHistory.length > 0) && (
        <div className="card dp-card" ref={rollbackCardRef} tabIndex={-1}>
          <div className="dp-card-top">
            <h2 className="dp-h-sm">
              Roll back · <span className="mono">{scriptGroup}</span>
              <HelpHint label="Roll back">
                Pick a version to go back to. Every applied version above it is
                undone, newest first, in one transaction: all of them or none.
                It runs as soon as you press the button, when your role may run it.
              </HelpHint>
            </h2>
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
              : // The one line that stays: it is about losing data.
                "A rollback restores structure, not rows."}
          </p>

          {rollbackDone && (
            <div className="mt-3 space-y-3">
              <div className="flex items-start gap-2 text-[12.5px]" style={{ color: "var(--ink-2)" }}>
                <span className="flex-none mt-0.5" style={{ color: "var(--add)" }}>
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
            <pre className="dp-err mt-3">{rollbackErrorShown}</pre>
          )}

          {rollbackPlannerShown && (
            <div className="mt-3 space-y-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[12px]" style={{ color: "var(--ink-3)" }}>Roll back to</span>
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
                <p className="text-[12px]" style={{ color: "var(--ink-3)" }}>
                  This list stops at {vLabel(appliedNewestFirst[MAX_ROLLBACK_VERSIONS])}: a
                  rollback undoes at most {MAX_ROLLBACK_VERSIONS} versions at a time. To go
                  further back, run this one, then roll back again.
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
                    <div key={step.version} className="dp-hist">
                      <div className="flex items-center justify-between gap-3">
                        <span className="mono text-[13px]">{`${index + 1}. Undo ${v}`}</span>
                        {step.appliedAt && (
                          <span className="text-[11px]" style={{ color: "var(--ink-3)" }}>
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
                            <div className="help mt-0.5 dp-warn-text">
                              {`The registry's ${v}.down.sql differs from the copy saved when ${v} was applied. The saved copy is the one that runs.`}
                            </div>
                          )}
                          <details className="dp-sql" open={deletesRows}>
                            <summary>
                              <ChevronDownIcon size={12} />
                              <span>Rollback SQL</span>
                              <span className="mono">
                                {countOf(getSqlLineCount(step.resolved.sql), "line")}
                              </span>
                            </summary>
                            <pre>{step.resolved.sql.trim()}</pre>
                          </details>
                        </>
                      ) : problem ? (
                        <div className="help mt-0.5 dp-bad-text">
                          {problem.text}
                          {problem.editor && (
                            <>
                              {" "}
                              <Link href={orgPath("/script-editor")} className="underline">
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

              {rollbackDataLoss.length > 0 && (
                <RiskGate
                  tone="break"
                  title={
                    rollbackLossSure
                      ? `${countOf(rollbackDataLoss.length, "rollback")} ${rollbackDataLoss.length === 1 ? "deletes" : "delete"} rows`
                      : `${countOf(rollbackDataLoss.length, "rollback")} may delete rows`
                  }
                  body={
                    rollbackDataLoss
                      .map((loss) => rollbackLossSentence(loss.version, loss.kinds))
                      .join(" ") +
                    (rollbackLossSure
                      ? " Those take rows out of a live table, and deploying the " +
                        "version again does not bring them back: it rebuilds " +
                        "structure, not data. Have a backup you can restore from " +
                        "before running this."
                      : " Deploying the version again does not bring deleted rows " +
                        "back: it rebuilds structure, not data. Have a backup you " +
                        "can restore from before running this.")
                  }
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
              {connectionId && rollbackReady && (
                <MigrationReviewPanel
                  connectionId={Number(connectionId)}
                  schemaName={schema}
                  action="revert"
                  scripts={rollbackReviewScripts}
                  resetKey={rollbackKey}
                />
              )}
              {/* The asker's own panel, and the answer panel for
                  somebody else's ask of this exact rollback. */}
              {[
                askToRun
                  ? { key: "own", own: true, approved: approvedRollback, pending: pendingRollback, latest: latestRollback }
                  : null,
                rollbackAsk
                  ? { key: "ask", own: false, approved: null, pending: rollbackAsk, latest: rollbackAsk }
                  : null,
              ].map(
                (panel) =>
                  panel && (
                    <ApprovalPanel
                      key={panel.key}
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
                      approved={panel.approved}
                      pending={panel.pending}
                      latest={panel.latest}
                      viewerEmail={user?.email ?? ""}
                      roleLabel={roleLabel}
                      askToRun={panel.own}
                      mayApprove={mayApprove}
                      bypass={bypass}
                      note={rollbackApprovalNote}
                      onNoteChange={setRollbackApprovalNote}
                      onRequest={handleRequestRollbackApproval}
                      onDecide={(id, decision) => void handleDecideApproval(id, decision, "revert")}
                    />
                  )
              )}

              {rollbackErrorShown && <pre className="dp-err">{rollbackErrorShown}</pre>}
              {rollbackDryRun && rollbackDryRun.key === rollbackKey && (
                <div className="flex items-start gap-2 text-[12.5px]" style={{ color: "var(--ink-2)" }}>
                  <span className="flex-none mt-0.5" style={{ color: "var(--add)" }}>
                    <CheckIcon size={14} />
                  </span>
                  <span>{rollbackDryRun.message}</span>
                </div>
              )}

              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={rollbackBlocked || askToRun}
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
                {/* Stop rolls the rollback back on the server, so
                    every version in it stays applied. */}
                {rollbackBusy !== null && (
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
              <div className="text-[11px]" style={{ color: "var(--ink-3)" }}>
                {rollbackHint}
              </div>
            </div>
          )}

          {revertedHistory.length > 0 && (
            <div className="mt-4">
              <div className="section-title mb-1">Rollback history</div>
              {revertedHistory.slice(0, 10).map((row) => (
                <div
                  key={`${row.version}@${row.reverted_at}`}
                  className="dp-hist dp-hist-top"
                >
                  <span className="mono text-[13px]">{vLabel(row.version)}</span>
                  <span className="text-[11px]" style={{ color: "var(--ink-3)" }}>
                    {`${
                              row.applied_at
                                ? `applied ${fmtDate(row.applied_at)}${
                                    row.applied_by ? ` by ${row.applied_by}` : ""
                                  } · `
                                : ""
                            }rolled back ${fmtDate(row.reverted_at)}${
                              row.reverted_by ? ` by ${row.reverted_by}` : ""
                            }`}
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
    </>
  );
}
