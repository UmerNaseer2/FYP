// Query analysis: how heavy a step is, for the screen.
//
// Holds the bands and labels the plan tree uses to tint a step by its share
// of the query.

import type { PlanSummary } from "./plan-types";

// ── How heavy a step is, for the screen ──────────────────────────────────────

/** How strongly the screen tints a step for its share of the query. */
export type ShareBand = "hot" | "warm" | "none";

/**
 * The tint for a step's share: "hot" at half the query or more, "warm" at a
 * fifth or more, "none" below that.
 *
 * Two bands rather than a colour scale: "this step is most of the query" and
 * "this step is a big part of it" are the two things worth seeing at a
 * glance, and a finer scale would claim a precision the planner's cost does
 * not have.
 */
export function shareBand(share: number): ShareBand {
  if (share >= 0.5) return "hot";
  if (share >= 0.2) return "warm";
  return "none";
}

/**
 * A share as the screen prints it: "63%". A step with a sliver of the query
 * reads "<1%" rather than "0%", which would say it did nothing at all.
 */
export function shareText(share: number): string {
  if (share <= 0) return "0%";
  if (share < 0.005) return "<1%";
  return `${Math.round(share * 100)}%`;
}

/**
 * The name of the heaviest step's badge. A cost is the planner's guess, so
 * the badge must not call it "slowest": nothing was timed.
 */
export function heaviestStepLabel(basis: PlanSummary["basis"]): string {
  return basis === "time" ? "Slowest step" : "Most expensive step (estimate)";
}

/** What the percentages on the plan are a share of, for the line above it. */
export function shareLegend(basis: PlanSummary["basis"]): string {
  return basis === "time"
    ? "Share of the query's total time (measured)"
    : "Share of the planner's estimated cost; an estimate, not a timing";
}
