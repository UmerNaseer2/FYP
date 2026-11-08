"use client";

import { Pill, type PillTone } from "@/components/ui/Pill";
import { apiFetch } from "@/lib/api-fetch";
import {
  isCitedChanges,
  isCompareSummaryAnswer,
  type CitedChange,
  type CompareSummaryAnswer,
  type SummaryLevel,
} from "@/lib/ai/features/compare-summary-view";
import { AiPanel } from "./AiPanel";
import { withNames } from "./ai-names";

const LEVEL_TONE: Record<SummaryLevel, PillTone> = { breaking: "break", safe: "sync", info: "neutral" };
const LEVEL_LABEL: Record<SummaryLevel, string> = { breaking: "Breaking", safe: "Safe", info: "Info" };

function ChangeRefs({ ids, cited }: { ids: string[]; cited: Record<string, CitedChange> }) {
  return (
    <ul className="mt-1.5 flex flex-wrap gap-1.5 text-[12px]" style={{ color: "var(--text-2)" }}>
      {ids.map((id) => (
        <li key={id} className="pill pill-outline" title={cited[id]?.label ?? id}>
          <span className="mono" style={{ color: "var(--text-3)" }}>
            {id}
          </span>
          {cited[id] && <span className="ml-1">{cited[id].label}</span>}
        </li>
      ))}
    </ul>
  );
}

function SummaryView({ answer, cited }: { answer: CompareSummaryAnswer; cited: Record<string, CitedChange> }) {
  return (
    <div className="space-y-4 text-[13.5px]">
      <p style={{ color: "var(--text-1)" }}>{withNames(answer.headline)}</p>

      <div>
        <h4 className="text-[12px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-3)" }}>
          What can hurt
        </h4>
        {answer.risks.length === 0 ? (
          <p className="mt-1" style={{ color: "var(--text-2)" }}>
            Nothing here can lose data or break what uses the target.
          </p>
        ) : (
          <ol className="mt-2 space-y-3">
            {answer.risks.map((risk, i) => (
              <li key={i}>
                <div className="flex flex-wrap items-center gap-2">
                  <Pill tone={LEVEL_TONE[risk.level]}>{LEVEL_LABEL[risk.level]}</Pill>
                  <span className="font-medium">{withNames(risk.title)}</span>
                </div>
                <p className="mt-1" style={{ color: "var(--text-2)" }}>
                  {withNames(risk.why)}
                </p>
                {risk.affects.length > 0 && (
                  <p className="mt-1 text-[12.5px]" style={{ color: "var(--text-2)" }}>
                    Used by:{" "}
                    {risk.affects.map((name, j) => (
                      <span key={name}>
                        {j > 0 && ", "}
                        <code className="mono">{name}</code>
                      </span>
                    ))}
                  </p>
                )}
                <ChangeRefs ids={risk.changes} cited={cited} />
              </li>
            ))}
          </ol>
        )}
      </div>

      {answer.order.length > 0 && (
        <div>
          <h4 className="text-[12px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-3)" }}>
            A safe order
          </h4>
          <ol className="mt-2 space-y-2 list-decimal pl-5">
            {answer.order.map((step, i) => (
              <li key={i}>
                <span>{withNames(step.step)}</span>
                <ChangeRefs ids={step.changes} cited={cited} />
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

/**
 * The AI change summary on the Compare screen, under "Critical differences".
 * The grades it shows are the engine's: the route writes them over the model's.
 */
export function CompareSummaryPanel({ query, target, resetKey }: { query: string; target: number; resetKey: string }) {
  return (
    <AiPanel
      feature="compare-summary"
      title="Change summary"
      blurb="A short read of this comparison: what the migration does, what can hurt and in what order to apply it. Only the schema structure is sent to the AI, never your data."
      askLabel="Summarise with AI"
      resetKey={resetKey}
      isAnswer={isCompareSummaryAnswer}
      ask={() =>
        apiFetch("/api/compare/summary", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query, target }),
        })
      }
    >
      {(answer, extra) => <SummaryView answer={answer} cited={isCitedChanges(extra.changes) ? extra.changes : {}} />}
    </AiPanel>
  );
}
