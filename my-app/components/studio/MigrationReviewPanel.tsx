"use client";

import { Pill, type PillTone } from "@/components/ui/Pill";
import { apiFetch } from "@/lib/api-fetch";
import {
  isMigrationReviewAnswer,
  isReviewedStatements,
  type MigrationReviewAnswer,
  type ReviewedStatement,
  type ReviewSeverity,
} from "@/lib/ai/features/migration-review-view";
import { AiPanel } from "./AiPanel";
import { withNames } from "./ai-names";

const SEVERITY_TONE: Record<ReviewSeverity, PillTone> = { high: "break", medium: "drift", low: "neutral" };
const SEVERITY_LABEL: Record<ReviewSeverity, string> = { high: "High", medium: "Medium", low: "Low" };

/**
 * One script of the run. `changeType` is the change type the Deploy screen
 * read for it, when it has one; the review then rates the script at least as
 * high as Deploy does.
 */
export type ReviewRunScript = { scriptName: string; version: string; sqlContent: string; changeType?: string };

function StatementRefs({ ids, statements }: { ids: string[]; statements: Record<string, ReviewedStatement> }) {
  return (
    <ul className="mt-1.5 flex min-w-0 flex-wrap gap-1.5 text-[12px]" style={{ color: "var(--text-2)" }}>
      {ids.map((id) => {
        const s = statements[id];
        return (
          <li key={id} className="pill pill-outline min-w-0 max-w-full overflow-hidden" title={s ? `${s.preview}${s.flags.length ? `\n\nThe app's checks: ${s.flags.join("; ")}` : ""}` : id}>
            <span className="mono flex-none" style={{ color: "var(--text-3)" }}>
              {id}
            </span>
            {s && <span className="ml-1 min-w-0 truncate">{s.label}</span>}
          </li>
        );
      })}
    </ul>
  );
}

function ReviewView({
  answer,
  statements,
}: {
  answer: MigrationReviewAnswer;
  statements: Record<string, ReviewedStatement>;
}) {
  return (
    <div className="min-w-0 space-y-4 text-[13.5px]">
      <p style={{ color: "var(--text-1)" }}>{withNames(answer.verdict)}</p>

      <div>
        <h4 className="text-[12px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-3)" }}>
          Findings
        </h4>
        {answer.findings.length === 0 ? (
          <p className="mt-1" style={{ color: "var(--text-2)" }}>
            Nothing in this run was flagged, by the AI or by the app&apos;s own checks.
          </p>
        ) : (
          <ol className="mt-2 space-y-3">
            {answer.findings.map((finding, i) => (
              <li key={i} className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Pill tone={SEVERITY_TONE[finding.severity]}>{SEVERITY_LABEL[finding.severity]}</Pill>
                  <span className="font-medium">{withNames(finding.title)}</span>
                  {finding.fromApp && (
                    <span className="pill pill-outline text-[11.5px]" title="The app wrote this finding: its own checks flagged these statements and the AI's answer left them out.">
                      From the app&apos;s checks
                    </span>
                  )}
                  {!finding.fromApp && finding.modelSeverity && finding.modelSeverity !== finding.severity && (
                    <span
                      className="pill pill-outline text-[11.5px]"
                      title="The app's own checks flag these statements, so the app raised the grade the AI gave."
                    >
                      AI said {SEVERITY_LABEL[finding.modelSeverity]}, raised by the app
                    </span>
                  )}
                </div>
                <p className="mt-1" style={{ color: "var(--text-2)" }}>
                  {withNames(finding.why)}
                </p>
                {finding.saferWay && (
                  <p className="mt-1" style={{ color: "var(--text-2)" }}>
                    <span className="font-semibold" style={{ color: "var(--text-1)" }}>
                      Instead:{" "}
                    </span>
                    {withNames(finding.saferWay)}
                  </p>
                )}
                <StatementRefs ids={finding.statements} statements={statements} />
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

/**
 * The AI review of a run on the Deploy screen, before it is started or sent
 * for approval. `scripts` are the ones the run would apply, in order.
 */
export function MigrationReviewPanel({
  connectionId,
  schemaName,
  action,
  scripts,
  resetKey,
}: {
  connectionId: number;
  schemaName: string;
  action: "deploy" | "revert";
  scripts: ReviewRunScript[];
  resetKey: string;
}) {
  return (
    <AiPanel
      feature="migration-review"
      title={action === "deploy" ? "Review this run" : "Review this rollback"}
      blurb="An AI read of what this run can break on this target: lost data, statements that fail on existing rows, long locks. The run's SQL (with the values written in it shown as ?), the schema structure and rough table sizes are sent to the AI, never your rows."
      askLabel="Review with AI"
      resetKey={resetKey}
      isAnswer={isMigrationReviewAnswer}
      ask={(signal, refresh) =>
        apiFetch("/api/scripts/review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ connectionId, schemaName, action, scripts, refresh }),
          signal,
        })
      }
    >
      {(answer, extra) => (
        <ReviewView answer={answer} statements={isReviewedStatements(extra.statements) ? extra.statements : {}} />
      )}
    </AiPanel>
  );
}
