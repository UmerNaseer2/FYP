"use client";

// The drift check panel (used before a deploy, after one, and after a
// rollback) and the single line of the "Before you ship" checklist.

import {
  CheckIcon,
  AlertCircleIcon,
  AlertTriangleIcon,
  DriftIcon,
  InfoIcon,
} from "@/components/ui/icons";
import { vLabel } from "@/lib/deploy/rollback-plan";
import { displayVersion } from "@/lib/versions/timeline";
import type { DriftResult, DriftPhase } from "./types";

// Drift pre-check panel (Phase 6). Renders the real lineage drift state for the
// chosen target, or an honest "not tracked" message, in place of the old stub.
// Shared by the stage-1 pre-check, the stage-3 post-deploy verify and the check
// after a rollback; the copy shifts slightly via `context`.
export function DriftPanel({
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
  let icon = <span className="spin" />;
  // The colour of the round icon: plain, good (dp-good) or a warning (dp-warn).
  let tone = "";
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
      "Track this schema on the Dashboard to capture a baseline snapshot. Drift checks then compare the live structure against it. Until then Deploy assumes the target matches its migration ledger.";
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
      tone = "dp-warn";
      title = "Target unreachable";
      body = result.summary;
      pillText = "unreachable";
    } else if (result.status === "in_sync") {
      icon = <CheckIcon size={16} />;
      tone = "dp-good";
      title =
        context === "precheck"
          ? `No drift: target matches ${v}`
          : `Verified: live schema matches ${v}`;
      body = result.summary;
      pillClass = "pill pill-sync";
      pillText = "in sync";
    } else {
      // drifted
      icon = <DriftIcon size={16} />;
      tone = "dp-warn";
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
            "Review before deploying: the live structure differs from its tracked snapshot."
          )}
        </>
      );
      pillClass = "pill pill-pending";
      pillText = "drift";
    }
  }

  return (
    <div className="dp-drift">
      <div className={`dp-drift-i ${tone}`}>{icon}</div>
      <div className="dp-drift-text">
        <b>{title}</b>
        <div>{body}</div>
      </div>
      <span className={pillClass}>{pillText}</span>
    </div>
  );
}

// Small checklist line: green check (ok), warn (ok=false), info, or stub.
export function ChecklistItem({
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
  let iconClass = "dp-ic dp-ok-i";
  let icon: React.ReactNode = <CheckIcon size={12} />;
  if (stub) {
    iconClass = "dp-ic dp-stub-i";
    icon = null;
  } else if (info) {
    iconClass = "dp-ic dp-wait-i";
    icon = <InfoIcon size={12} />;
  } else if (ok === false) {
    iconClass = "dp-ic dp-bad-i";
    icon = <AlertTriangleIcon size={12} />;
  }
  return (
    <li className={stub ? "dp-stub" : undefined}>
      <span className={iconClass}>{icon}</span>
      <span>{children}</span>
    </li>
  );
}
