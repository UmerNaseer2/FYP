"use client";

import { Pill, type PillTone } from "@/components/ui";
import { BAND_MEANING, type ScoreBand, type QueryScore } from "@/lib/query-score";

/**
 * The score badge, and the panel that explains it.
 *
 * Both live here rather than in QueryAnalyzer because the history screen shows
 * the same badge against a stored row, and a score that looked one way when it
 * was measured and another way when it was read back would be worse than no
 * score at all.
 */

/**
 * Band to pill colour.
 *
 * "drift" for fair rather than "pending": pending is a state that is going to
 * resolve on its own, and a fair query is not going to improve by being left
 * alone.
 */
const BAND_TONE: Record<ScoreBand, PillTone> = {
  good: "sync",
  fair: "drift",
  poor: "break",
};

export function ScoreBadge({ score, band }: { score: number; band: ScoreBand }) {
  return (
    <Pill tone={BAND_TONE[band]}>
      {score} / 100
    </Pill>
  );
}

/**
 * The score with its reasons underneath.
 *
 * Every deduction is listed with the points it cost, and they add up to the
 * gap between the score and 100. That is the whole point of showing them: a
 * number on its own is a judgement, and a number with its arithmetic attached
 * is something the reader can disagree with.
 */
export function ScorePanel({ score }: { score: QueryScore }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <ScoreBadge score={score.score} band={score.band} />
        <span className="text-[13px]" style={{ color: "var(--text)" }}>
          {BAND_MEANING[score.band]}
        </span>
      </div>

      <div className="text-[11.5px]" style={{ color: "var(--text-3)" }}>
        {score.measured
          ? "Worked out from a timed run, so the shares below are real."
          : "Worked out from the planner's estimate. No timing was taken, so a " +
            "step's share is its share of the guessed cost, not of the time."}
      </div>

      {score.reasons.length === 0 ? (
        <div className="text-[12.5px]" style={{ color: "var(--text-2)" }}>
          Nothing was taken off. Every rule this app checks came back clean —
          which is not the same as the query being fast, only that its plan has
          no obvious waste in it.
        </div>
      ) : (
        <ul className="space-y-1">
          {score.reasons.map((reason) => (
            <li
              key={reason.id}
              className="flex items-start gap-2 text-[12.5px]"
              style={{ color: "var(--text-2)" }}
            >
              <span
                className="shrink-0 tabular-nums font-medium"
                style={{ color: "var(--text-3)", minWidth: "2.6em" }}
              >
                −{reason.penalty}
              </span>
              <span>{reason.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
