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

export type ReviewRunScript = { scriptName: string; version: string; sqlContent: string };

function StatementRefs({ ids, statements }: { ids: string[]; statements: Record<string, ReviewedStatement> }) {
  return (
    <ul className="mt-1.5 flex flex-wrap gap-1.5 text-[12px]" style={{ color: "var(--text-2)" }}>
      {ids.map((id) => {
        const s = statements[id];
        return (
          <li key={id} className="pill pill-outline" title={s ? `${s.preview}${s.flags.length ? `\n\nThe app's checks: ${s.flags.join("; ")}` : ""}` : id}>
            <span className="mono" style={{ color: "var(--text-3)" }}>
              {id}
            </span>
            {s && <span className="ml-1">{s.label}</span>}
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
    <div className="space-y-4 text-[13.5px]">
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
              <li key={i}>
                <div className="flex flex-wrap items-center gap-2">
                  <Pill tone={SEVERITY_TONE[finding.severity]}>{SEVERITY_LABEL[finding.severity]}</Pill>
                  <span className="font-medium">{withNames(finding.title)}</span>
                  {finding.fromApp && (
                    <span className="pill pill-outline text-[11.5px]" title="The app wrote this finding: its own checks flagged these statements and the AI's answer left them out.">
                      From the app&apos;s checks
                    </span>
                  )}
                </div>
                <p className="mt-1" style={{ color: "var(--text-2)" }}>
                  {withNames(finding.why)}
                </p>
                {finding.saferWay && (
                  <div className="mt-1.5">
                    <span className="text-[12px] font-semibold" style={{ color: "var(--text-3)" }}>
                      Safer way:{" "}
                    </span>
                    <span style={{ color: "var(--text-2)" }}>{withNames(finding.saferWay)}</span>
                  </div>
                )}
                <StatementRefs ids={finding.statements} statements={statements} />
              </li>
            ))}
          </ol>
        )}
      </div>
      <p className="text-[12px]" style={{ color: "var(--text-3)" }}>
        A finding is never graded below what the app&apos;s own checks say about its statements. The review does not
        change or approve the run.
      </p>
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
      blurb="An AI read of what this run can break on this target: lost data, statements that fail on existing rows, long locks. The run's SQL, the schema structure and rough table sizes are sent to the AI, never your rows."
      askLabel="Review with AI"
      resetKey={resetKey}
      isAnswer={isMigrationReviewAnswer}
      ask={() =>
        apiFetch("/api/scripts/review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ connectionId, schemaName, action, scripts }),
        })
      }
    >
      {(answer, extra) => (
        <ReviewView answer={answer} statements={isReviewedStatements(extra.statements) ? extra.statements : {}} />
      )}
    </AiPanel>
  );
}
