"use client";

// ---------------------------------------------------------------------------
// The Verify stage of the Deploy page: the result, what to do next, what was
// applied and the drift check after the run. The state and the handlers
// stay in page.tsx and arrive here as props.
// ---------------------------------------------------------------------------

import type { Dispatch, SetStateAction } from "react";
import Link from "next/link";
import { CheckIcon, ChevronRightIcon } from "@/components/ui/icons";
import { vLabel } from "@/lib/deploy/rollback-plan";
import type {
  GitHubScript,
  Connection,
  PreflightResult,
  RunCell,
  DriftResult,
  DriftPhase,
} from "./types";
import { scriptKey, fmtStatements, fmtSecs } from "./helpers";
import { DriftPanel } from "./DriftPanel";
import type { PatchPrompt } from "@/lib/deploy/init";

// Everything on the Verify stage below the error notice.
export function VerifyCards({
  preflightResult,
  schema,
  activeConn,
  runFromVersion,
  runLastVersion,
  elapsedMs,
  appliedScripts,
  handlePreflight,
  setStage,
  orgPath,
  afterInitPrompt,
  selectRun,
  pendingScripts,
  runStatus,
  driftPhase,
  driftResult,
  driftError,
}: {
  preflightResult: PreflightResult | null;
  schema: string;
  activeConn: Connection | null;
  runFromVersion: string;
  runLastVersion: string;
  elapsedMs: number;
  appliedScripts: GitHubScript[];
  handlePreflight: () => Promise<void>;
  setStage: Dispatch<SetStateAction<2 | 3 | 1>>;
  orgPath: (path: string) => string;
  afterInitPrompt: PatchPrompt | null;
  selectRun: (version: string) => void;
  pendingScripts: GitHubScript[];
  runStatus: Record<string, RunCell>;
  driftPhase: DriftPhase;
  driftResult: DriftResult | null;
  driftError: string | null;
}) {
  return (
    <>
      <div className="dp-result dp-good dp-hero">
          <div className="dp-big-check">
            <CheckIcon size={28} />
          </div>
          <div >
            <div className="section-title">
              Deployed
            </div>
            <h2>
              Migrations applied to the target.
            </h2>
            {preflightResult ? (
              <p>
                <span className="mono" style={{ color: "var(--ink)" }}>{schema}</span> on{" "}
                <span className="mono" style={{ color: "var(--ink)" }}>{activeConn?.name}</span>{" "}
                now reports{" "}
                <span className="mono" style={{ color: "var(--ink)" }}>
                  {preflightResult.currentVersion
                    ? vLabel(preflightResult.currentVersion)
                    : "no versions yet"}
                </span>{" "}
                in its migration ledger.
              </p>
            ) : (
              <p>
                The deploy committed, but the ledger could not be read back
                afterwards. This page cannot confirm what the target now
                reports.
              </p>
            )}
            <div className="dp-pills mt-4">
              <span className="dp-chip">{runFromVersion}</span>
              <ChevronRightIcon size={16} />
              {/* The batch that ran, not the selection: Pre-flight can move
                  the selection after a deploy. */}
              <span className="dp-chip dp-ok"><b>{runLastVersion ? vLabel(runLastVersion) : "None"}</b></span>
              <span className="dp-quiet text-[12px]">
                {fmtSecs(elapsedMs)} · {appliedScripts.length} migration{appliedScripts.length === 1 ? "" : "s"} in one transaction · 0 errors
              </span>
            </div>
            <div className="dp-row">
              <button type="button" className="btn btn-primary" onClick={handlePreflight}>
                Re-check target
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setStage(1)}>
                Back to Pre-flight
              </button>
              {/* Both buttons above lead back into this same screen, which
                  left a finished deploy with no way onward except the
                  sidebar. These are the two things that actually happen
                  next: record the version against the schema, and start
                  watching the database that just changed, the moment it is
                  most likely to drift is right after somebody changed it.

                  Links and not primary buttons: the deploy is finished, so
                  neither of these is owed. */}
              <Link href={orgPath("/versionsync")} className="btn btn-ghost">
                Record it on Version Sync
              </Link>
              <Link href={orgPath("/drift")} className="btn btn-ghost">
                Watch it on Drift
              </Link>
            </div>
          </div>
      </div>

      {/* Spec feature 11: the patches, offered rather than started. The
          button only takes the reader back to Pre-flight with the rest
          selected: running them is a deploy like any other, with the same
          preview and the same approval, and chaining straight on would
          turn one confirmed run into two. */}
      {afterInitPrompt && (
        <div className="card dp-card">
          <div className="section-title mb-1">Next</div>
          <div className="dp-h-sm">{afterInitPrompt.title}</div>
          <p className="help mt-1">{afterInitPrompt.body}</p>
          <div className="dp-row">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => {
                selectRun(pendingScripts[pendingScripts.length - 1].version);
                setStage(1);
              }}
            >
              {`Review ${afterInitPrompt.remaining === 1 ? "it" : `all ${afterInitPrompt.remaining}`} on Pre-flight`}
            </button>
          </div>
        </div>
      )}

      <div className="dp-two">
        <div className="card dp-card">
          <h2 className="dp-h-sm">What was applied</h2>
          <div className="mt-2">
            {appliedScripts.map((s, i) => (
              <div key={scriptKey(s)} className="dp-applied">
                <span className="mono">
                  <span style={{ color: "var(--ink-3)" }}>{String(i + 1).padStart(2, "0")}</span>{" "}
                  {s.script_name} <span style={{ color: "var(--ink-3)" }}>{vLabel(s.version)}</span>
                </span>
                <span className="pill pill-sync">
                  <span className="dot" />
                  applied · {fmtStatements(runStatus[scriptKey(s)]?.statements ?? 0)}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Verify re-diff, real lineage compare when the target is tracked */}
        <div className="card dp-card">
          <h2 className="dp-h-sm mb-3">Verify diff</h2>
          <DriftPanel
            phase={driftPhase}
            result={driftResult}
            error={driftError}
            context="verify"
            targetVersion={runLastVersion}
          />
        </div>
      </div>
    </>
  );
}
