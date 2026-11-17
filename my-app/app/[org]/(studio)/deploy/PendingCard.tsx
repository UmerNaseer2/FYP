"use client";

// ---------------------------------------------------------------------------
// The pending migrations card of the Deploy page's Pre-flight stage: the
// list of versions waiting to run, with the pick-a-range controls. The state
// and the handlers stay in page.tsx and arrive here as props.
// ---------------------------------------------------------------------------

import { pendingPrefixThrough } from "@/lib/versions/script-status";
import { describeChangeType } from "@/lib/versions/change-type";
import { countOf } from "@/lib/ui/plural";
import { listVersions, versionRange, vLabel } from "@/lib/deploy/rollback-plan";
import { HelpHint } from "@/components/ui/HelpHint";
import type { GitHubScript, PreflightResult } from "./types";
import { scriptKey, getSqlLineCount } from "./helpers";
import { pendingRowNotes } from "./row-notes";
import { MigRow } from "./MigRow";

// The pending migrations card.
export function PendingCard({
  pendingScripts,
  scriptsUpToTarget,
  addressedElsewhere,
  preflightResult,
  skippedVersions,
  currentLabel,
  isDeploying,
  selectRun,
  inRunKeys,
}: {
  pendingScripts: GitHubScript[];
  scriptsUpToTarget: GitHubScript[];
  addressedElsewhere: GitHubScript[];
  preflightResult: PreflightResult;
  skippedVersions: string[];
  currentLabel: string;
  isDeploying: boolean;
  selectRun: (version: string) => void;
  inRunKeys: Set<string>;
}) {
  return (
    <div className="card dp-card">
    <div className="dp-card-top">
      <div>
        <div className="section-title">
          Pending migrations
          {/* Said once, here, rather than on every row: the boxes
              do not behave like a shopping list and a reader who
              unticks the middle one should know why the ones
              below it went with it. */}
          {pendingScripts.length > 1 && (
            <HelpHint label="Pending migrations">
              Tick a version to run everything up to it, or untick one to
              stop before it. A run is always an unbroken sequence from the
              first pending version, because a later migration changes what
              an earlier one creates.
            </HelpHint>
          )}
        </div>
        <h2 className="dp-h mt-1">
          {pendingScripts.length} pending · {scriptsUpToTarget.length} in this run
        </h2>
        {/* Taken out of the run by their own "Applies-to"
            header. They are not in the list below, and a
            version that is simply absent reads as one that
            does not exist. */}
        {addressedElsewhere.length > 0 && (
          <p className="help mt-1">
            {`Not in this run: ${listVersions(
                              addressedElsewhere.map((script) => script.version)
                            )} ${addressedElsewhere.length === 1 ? "is" : "are"} for ${
                              addressedElsewhere.length === 1 ? "an application" : "applications"
                            } this database does not host, by ${
                              addressedElsewhere.length === 1 ? "its" : "their"
                            } Applies-to header. ${
                              preflightResult?.applications.source ?? "The application table"
                            } says this database hosts ${
                              preflightResult?.applications.names.join(", ") || "nothing by name"
                            }. Later versions still run.`}
          </p>
        )}
        {/* Skipped versions are not in the list below, so say
            why rather than leave them missing without a word. */}
        {skippedVersions.length > 0 && (
          <p className="help mt-1">
            {`Not in this run: ${listVersions(skippedVersions)} ${
                              skippedVersions.length === 1 ? "was" : "were"
                            } skipped: never applied and below ${currentLabel}, the version applied to the target. See Skipped in the version timeline above.`}
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

    <div className="dp-mig-list" data-tour="deploy-pending">
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
            toggle={{
              checked: inRun,
              disabled: isDeploying,
              label: inRun
                ? `Take ${vLabel(script.version)} out of the run. Every version after it comes out too.`
                : `Run every pending version up to and including ${vLabel(script.version)}.`,
              // Ticking a row runs everything up to it; unticking
              // one runs everything up to the row BEFORE it. Both
              // are the same rule: a run is a prefix. v5.0.3 alters
              // what v5.0.2 created, so a list with a hole in it is
              // not a shorter run, it is a broken one.
              onChange: (checked) =>
                selectRun(
                  checked
                    ? script.version
                    : i === 0
                      ? ""
                      : pendingScripts[i - 1].version
                ),
            }}
            name={script.script_name}
            kind={kind}
            sub={`${from} → ${vLabel(script.version)} · ${countOf(getSqlLineCount(script.sql_content), "line")}`}
            // The version it lands, as in the run list below. A
            // bare "major" here sat beside "v1.1.0 → v1.2.0" and
            // contradicted it; the level pill already says what
            // kind of change this is, and the note explains a
            // number that disagrees with it.
            rightPill={vLabel(script.version)}
            cell={{ status: inRun ? "queued" : "not-in-run" }}
            selected={inRun}
            sql={script.sql_content}
            sqlOpen={inRun && reading.countsAsBreaking}
            notes={pendingRowNotes(script, reading, previous, preflightResult.applications)}
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
    </div>
  );
}
