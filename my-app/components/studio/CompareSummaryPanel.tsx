"use client";

import { Pill, type PillTone } from "@/components/ui/Pill";
import { apiFetch } from "@/lib/api-fetch";
import {
  isCitedChanges,
  isCompareSummaryAnswer,
  type CitedChange,
  type CompareSummaryAnswer,
  type SummaryItem,
  type SummaryLevel,
} from "@/lib/ai/features/compare-summary-view";
import { AiPanel } from "./AiPanel";
import { withNames } from "./ai-names";

/** How an engine grade looks, on the Compare summary and the drift explanation alike. */
export const LEVEL_TONE: Record<SummaryLevel, PillTone> = { breaking: "break", safe: "sync", info: "neutral" };
export const LEVEL_LABEL: Record<SummaryLevel, string> = { breaking: "Breaking", safe: "Safe", info: "Info" };

export function ChangeRefs({ ids, cited }: { ids: string[]; cited: Record<string, CitedChange> }) {
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

/** One graded item: the grade, the title, why, what uses it and the changes it cites. */
export function RiskRow({ item, cited }: { item: SummaryItem; cited: Record<string, CitedChange> }) {
  // The shape check lets any text through as the level, so an unknown one still draws.
  const tone = LEVEL_TONE[item.level] ?? "neutral";
  const label = LEVEL_LABEL[item.level] ?? item.level;
  return (
    <li>
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={tone}>{label}</Pill>
        <span className="font-medium">{withNames(item.title)}</span>
      </div>
      <p className="mt-1" style={{ color: "var(--text-2)" }}>
        {withNames(item.why)}
      </p>
      {item.affects.length > 0 && (
        <p className="mt-1 text-[12.5px]" style={{ color: "var(--text-2)" }}>
          Used by:{" "}
          {item.affects.map((name, j) => (
            <span key={name}>
              {j > 0 && ", "}
              <code className="mono">{name}</code>
            </span>
          ))}
        </p>
      )}
      <ChangeRefs ids={item.changes} cited={cited} />
    </li>
  );
}

const SECTIONS = [
  { key: "added", label: "Added", empty: "Nothing new." },
  { key: "dropped", label: "Dropped", empty: "Nothing removed." },
  { key: "changed", label: "Changed", empty: "Nothing altered." },
] as const;

function SummaryView({ answer, cited }: { answer: CompareSummaryAnswer; cited: Record<string, CitedChange> }) {
  return (
    <div className="space-y-3 text-[13.5px]">
      <p style={{ color: "var(--text-1)" }}>{withNames(answer.headline)}</p>
      {SECTIONS.map(({ key, label, empty }) => {
        const lines = answer[key];
        if (lines.length === 0 && key !== "dropped") return null;
        return (
          <div key={key}>
            <h4 className="text-[12px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-3)" }}>
              {label}
            </h4>
            {lines.length === 0 ? (
              <p className="mt-1" style={{ color: "var(--text-2)" }}>
                {empty}
              </p>
            ) : (
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {lines.map((line, i) => (
                  <li key={i} title={line.changes.map((id) => cited[id]?.label ?? id).join("\n")}>
                    {withNames(line.text)}
                    {line.breaking && (
                      <>
                        {" "}
                        <Pill tone="break">Breaking</Pill>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
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
      blurb="A short read of this comparison: what gets added, dropped and changed. Only the schema structure is sent to the AI, never your data."
      askLabel="Summarize with AI"
      resetKey={resetKey}
      isAnswer={isCompareSummaryAnswer}
      ask={(signal, refresh) =>
        apiFetch("/api/compare/summary", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query, target, refresh }),
          signal,
        })
      }
    >
      {(answer, extra) => <SummaryView answer={answer} cited={isCitedChanges(extra.changes) ? extra.changes : {}} />}
    </AiPanel>
  );
}
