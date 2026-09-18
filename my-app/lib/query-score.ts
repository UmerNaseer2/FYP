import type { PlanSummary, PlanStep, QueryFinding } from "./query-analysis";
import { LARGE_TABLE_ROWS } from "./perf-sql";

/**
 * One number for "how healthy is this query", from the plan the analyser
 * already has.
 *
 * Spec feature 10 — query performance scoring.
 *
 * The hard part of a score is not the arithmetic, it is not lying. A single
 * number invites the reader to stop thinking, so three rules shape everything
 * below:
 *
 *   • Every deduction says what it was for, in a sentence, and the screen shows
 *     that list. A score with no reasons is a horoscope.
 *   • Nothing is deduced from a fact the plan did not actually record. An
 *     estimate has no timings, so the rules that need timings are skipped
 *     rather than guessed at, and `basis` says which kind of plan this was.
 *   • The score is about THIS query on THIS data. It is not comparable between
 *     two different queries in any meaningful way — a 70 on a report that scans
 *     a fact table may be fine, and a 70 on a primary-key lookup is alarming.
 *     What it IS comparable with is the same query scored again later, which is
 *     why history stores it (lib/query-history.ts).
 *
 * No database is opened here, and nothing is fetched: the caller has already
 * paid for the plan, and this is arithmetic over it. That keeps it testable.
 */

/** Best possible. Every rule below takes points off this. */
const PERFECT = 100;

/**
 * How the bands are drawn.
 *
 * Deliberately three, not five. The extra precision of five would be invented:
 * the difference between 61 and 68 is one medium finding, and no reader should
 * act differently on those two.
 */
export type ScoreBand = "good" | "fair" | "poor";

export const BAND_FLOOR: Record<Exclude<ScoreBand, "poor">, number> = {
  good: 85,
  fair: 60,
};

export function bandFor(score: number): ScoreBand {
  if (score >= BAND_FLOOR.good) return "good";
  if (score >= BAND_FLOOR.fair) return "fair";
  return "poor";
}

/** What a band means, for the screen. One sentence, no jargon. */
export const BAND_MEANING: Record<ScoreBand, string> = {
  good: "Nothing in the plan stands out as wasteful.",
  fair: "It works, but the plan is doing avoidable work.",
  poor: "The plan is doing a lot of work that a change could remove.",
};

/** One deduction, with the evidence that earned it. */
export type ScoreReason = {
  /** Stable id, so a test can name a rule and the UI can key a list. */
  id: string;
  /** What was found, as a sentence the reader can check against the plan. */
  label: string;
  /** Points taken off. Always positive; the score subtracts it. */
  penalty: number;
};

export type QueryScore = {
  /** 0–100, higher is better. */
  score: number;
  band: ScoreBand;
  /**
   * What the score was worked out from. "cost" is the planner's guess and the
   * screen must say so — a cost is not a timing, and a query can be cheap to
   * plan and slow to run.
   */
  basis: PlanSummary["basis"];
  /** True when the plan came from a real, timed run (EXPLAIN ANALYZE). */
  measured: boolean;
  /** Every deduction, worst first. Empty means a clean 100. */
  reasons: ScoreReason[];
};

/**
 * The most the findings list alone may take off.
 *
 * Without a cap, a query with fourteen low-severity notes scores below one that
 * reads a hundred-million-row table twice — which is exactly backwards. The
 * findings are advice about the text; the plan rules below are about the work.
 */
const FINDINGS_CAP = 45;

const SEVERITY_PENALTY = { high: 12, medium: 5, low: 2 } as const;

/**
 * How far out the planner's row estimate has to be before it counts against the
 * query.
 *
 * Ten times, not two. The planner is routinely out by a factor of two and picks
 * a fine plan anyway; an order of magnitude is the point where it starts
 * choosing the wrong join strategy, and that is the thing worth reporting. Only
 * ever applied to a measured plan, because an estimate has nothing to compare.
 */
const ESTIMATE_DRIFT = 10;

/**
 * The share of the query a step has to hold before its shape is worth a
 * deduction.
 *
 * A sequential scan over a big table that accounts for 2% of the work is not
 * this query's problem, and saying so would drown the one that accounts for
 * 80%.
 */
const MATERIAL_SHARE = 0.15;

/** Rounded for display and stored as an integer — a fractional score is noise. */
function clamp(value: number): number {
  return Math.max(0, Math.min(PERFECT, Math.round(value)));
}

/** "82%" from 0.8234, for a reason line. */
function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** Whole-number thousands separators, so 1200000 reads as 1,200,000. */
function count(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/**
 * Rows this step really handed on, across every run of it.
 *
 * PostgreSQL reports actual rows PER LOOP, so a step that ran 5,000 times and
 * reports 1 row produced 5,000. Getting this wrong makes a nested loop look
 * cheap, which is the exact case the rule below exists to catch.
 */
function totalActualRows(step: PlanStep): number | null {
  if (step.actualRows === null) return null;
  return step.actualRows * (step.loops ?? 1);
}

/**
 * Score one analysed query.
 *
 * `findings` is passed separately rather than read from `plan.findings` because
 * the route merges the plan's findings with the ones read from the query text,
 * and the merged list is what the reader sees — scoring the shorter one would
 * make the score disagree with the screen beside it.
 */
export function scoreQuery(plan: PlanSummary, findings: QueryFinding[]): QueryScore {
  const reasons: ScoreReason[] = [];

  // ── 1. What the analyser already found ──
  // Summarised into one line per severity rather than one per finding: the
  // findings have their own list on screen, and repeating fourteen of them here
  // would bury the plan-shape reasons that only this function produces.
  const bySeverity = { high: 0, medium: 0, low: 0 };
  for (const finding of findings) bySeverity[finding.severity] += 1;

  const rawFindingPenalty =
    bySeverity.high * SEVERITY_PENALTY.high +
    bySeverity.medium * SEVERITY_PENALTY.medium +
    bySeverity.low * SEVERITY_PENALTY.low;

  if (rawFindingPenalty > 0) {
    const parts: string[] = [];
    if (bySeverity.high) parts.push(`${bySeverity.high} high`);
    if (bySeverity.medium) parts.push(`${bySeverity.medium} medium`);
    if (bySeverity.low) parts.push(`${bySeverity.low} low`);
    const capped = Math.min(rawFindingPenalty, FINDINGS_CAP);
    reasons.push({
      id: "findings",
      label:
        `The analyser raised ${parts.join(", ")}` +
        (rawFindingPenalty > FINDINGS_CAP
          ? ` (capped — the findings list cannot take off more than ${FINDINGS_CAP})`
          : ""),
      penalty: capped,
    });
  }

  // ── 2. Reading a whole big table ──
  // The classic one, and the reason `tableRows` is carried on the step: a
  // sequential scan is only a problem relative to the size of what it reads.
  // Anything the catalog could not size is skipped rather than assumed large.
  for (const step of plan.steps) {
    if (step.nodeType !== "Seq Scan") continue;
    if (step.tableRows === null || step.tableRows < LARGE_TABLE_ROWS) continue;
    if (step.share < MATERIAL_SHARE) continue;
    // Scaled by share so the deduction matches how much of the query it is.
    // 25 points at 100% of the work, proportionally less below that.
    reasons.push({
      id: `seq-scan:${step.id}`,
      label:
        `Step ${step.id} reads all ${count(step.tableRows)} rows of ` +
        `${step.relation ?? "a table"} and that is ${pct(step.share)} of the query`,
      penalty: Math.round(25 * step.share),
    });
  }

  // ── 3. Work done over and over ──
  // The repeated side of a nested loop. `repeated` is set by the plan reader
  // from the shape of the tree, and `runsKnown` is false when it could not work
  // out how often — in which case there is no number to judge, so it is skipped.
  for (const step of plan.steps) {
    if (!step.repeated || !step.runsKnown) continue;
    if (step.estimatedRuns < 1_000) continue;
    if (step.share < MATERIAL_SHARE) continue;
    reasons.push({
      id: `repeated:${step.id}`,
      label:
        `Step ${step.id} runs about ${count(step.estimatedRuns)} times, once per row ` +
        `of the step above it, and that is ${pct(step.share)} of the query`,
      penalty: Math.round(20 * step.share),
    });
  }

  // ── 4. A plan chosen on bad information ──
  // Measured only. If the top step returned ten times more or fewer rows than
  // the planner expected, the planner was choosing join strategies from a
  // number that was wrong, and the fix is usually ANALYZE rather than the query.
  if (plan.measured) {
    const top = plan.steps[0];
    const actual = top ? totalActualRows(top) : null;
    if (top && actual !== null && top.estimatedRows > 0 && actual > 0) {
      const ratio = actual > top.estimatedRows
        ? actual / top.estimatedRows
        : top.estimatedRows / actual;
      if (ratio >= ESTIMATE_DRIFT) {
        reasons.push({
          id: "estimate-drift",
          label:
            `The planner expected ${count(top.estimatedRows)} rows and got ` +
            `${count(actual)} — ${Math.round(ratio)}× out, so it was choosing a plan ` +
            `from a bad estimate`,
          penalty: 15,
        });
      }
    }
  }

  // ── 5. A sort or a hash that ran out of memory ──
  // PostgreSQL writes this into the step's own detail lines, and it means the
  // step spilled to disk: real, measured, and fixable with work_mem. Text match
  // because that is the only place EXPLAIN puts it.
  for (const step of plan.steps) {
    const spilled = step.details.some(
      (line) => /Sort Method:\s*external/i.test(line) || /Disk:\s*\d/i.test(line)
    );
    if (!spilled) continue;
    reasons.push({
      id: `spilled:${step.id}`,
      label: `Step ${step.id} ran out of memory and used the disk to ${
        step.nodeType.toLowerCase().includes("sort") ? "sort" : "finish"
      }`,
      penalty: 10,
    });
  }

  const total = reasons.reduce((sum, reason) => sum + reason.penalty, 0);
  const score = clamp(PERFECT - total);

  return {
    score,
    band: bandFor(score),
    basis: plan.basis,
    measured: plan.measured,
    // Worst first: the reader should meet the biggest deduction before the
    // 2-point ones. Ties keep their discovery order, which is plan order.
    reasons: [...reasons].sort((a, b) => b.penalty - a.penalty),
  };
}

/**
 * The one-line verdict, for a list where the reasons do not fit.
 *
 * Says the basis every time. "72 / 100" beside a row in a history table, with
 * no hint that it came from an estimate rather than a run, is the kind of number
 * that gets quoted in a meeting.
 */
export function describeScore(score: QueryScore): string {
  const basis = score.measured ? "from a timed run" : "from the planner's estimate";
  return `${score.score} / 100 — ${BAND_MEANING[score.band]} (${basis})`;
}
