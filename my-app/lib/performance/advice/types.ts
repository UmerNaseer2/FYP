// Performance advice: what a piece of advice is.
//
// Holds the PerfAdvice types, the functions that sort and count a list of
// advice, and the time limits the two passes run under.

import type { FixKind } from "../sql";

export type AdviceSeverity = "high" | "medium" | "low";

export type PerfAdvice = {
  /** Stable rule id — used for grouping, filtering and tests. */
  id: string;
  severity: AdviceSeverity;
  /** One line naming what is wrong. */
  title: string;
  /** What it is wrong about: "orders" or "orders.customer_id". */
  object: string;
  /** Why it costs something. */
  detail: string;
  /** What to do instead: SQL, comments, or both, as `fixKind` says. */
  fix: string;
  /** What kind of thing `fix` is, so the screen can say before anyone copies it. */
  fixKind: FixKind;
  /**
   * The statements that take a change back out, when there are any. Shown under
   * the fix; comment lines only when undoing depends on something the fix may
   * already have removed.
   */
  undo?: string;
  /**
   * The table a foreign-key finding is on. attachForeignKeyIndexes uses it to
   * find the whole-table-read finding for the same table.
   */
  table?: string;
  /**
   * The index a duplicate-index or redundant-index finding keeps, written the
   * way its DROP INDEX would name it ("public"."orders_a"). withoutRepeatedDrops
   * uses it to leave out an unused-index finding for that same index: run
   * together, the two fixes would drop every index the lookups could use.
   */
  keeps?: string;
  /** A link to the place in the app where the next step is taken. */
  action?: { label: string; href: string };
  /**
   * Why this fix starts unticked, as one sentence for the reader, or absent
   * when it starts ticked like everything else.
   *
   * There is one reason so far: the app could not read which indexes
   * PostgreSQL has marked invalid, so a suggestion to drop an index cannot
   * promise it is dropping the spare one rather than the working one.
   * Unticking rather than hiding is deliberate — the finding is probably still
   * right, and the person reading it can see the index for themselves.
   */
  startUnticked?: string;
};

/**
 * A finding plus which of the two passes produced it.
 *
 * Defined here rather than in the advice route so the route and the screen
 * (components/studio/PerfAdviceList.tsx) share one definition. The screen
 * imports it with `import type`, which is erased at build time, so no server
 * code reaches the browser bundle.
 */
export type AdviceItem = PerfAdvice & {
  /**
   * Where the finding came from, so the screen can say. "structure" is read
   * from the schema alone, "statistics" from the server's own counters, and
   * "queries" from what has actually been analysed against this schema — the
   * last of those is the only one that can be right about a table whose
   * structure has nothing wrong with it.
   */
  origin: "structure" | "statistics" | "queries";
};

/** The whole response of GET /api/performance/advice. */
export type AdviceView = {
  connectionName: string;
  database: string;
  schema: string;
  advice: AdviceItem[];
  counts: { high: number; medium: number; low: number; total: number };
  /** How many tables the structural pass looked at. */
  tablesAnalyzed: number;
  /**
   * Why the statistics pass produced nothing, as sentences for the screen
   * (see describeStatsError), or null when it ran. Not an error: the
   * structural advice still comes back. When the pass failed before it read
   * which indexes are invalid, a last sentence says so, because the
   * structural rules then cannot tell an invalid index from a usable one.
   */
  statsUnavailable: string | null;
  /**
   * Why the query-pattern pass produced nothing, or null when it ran. Separate
   * from statsUnavailable because it is a different database that failed: this
   * one is the app's own, and the reader can do nothing about it from here.
   */
  patternsUnavailable: string | null;
};

/** Severity order for sorting — high first, and stable within a severity. */
const SEVERITY_RANK: Record<AdviceSeverity, number> = { high: 0, medium: 1, low: 2 };

/**
 * Sort advice the way a reader wants to read it: worst first, then by object.
 *
 * Generic so a caller that has added a field of its own — which half of the
 * screen a finding came from, say — gets its own type back rather than having
 * that field erased on the way through.
 */
export function sortAdvice<T extends PerfAdvice>(advice: T[]): T[] {
  return [...advice].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.object.localeCompare(b.object) ||
      a.id.localeCompare(b.id)
  );
}

/** How many of each severity, for a header that has to fit on one line. */
export function summarizeAdvice(advice: PerfAdvice[]): {
  high: number;
  medium: number;
  low: number;
  total: number;
} {
  return {
    high: advice.filter((a) => a.severity === "high").length,
    medium: advice.filter((a) => a.severity === "medium").length,
    low: advice.filter((a) => a.severity === "low").length,
    total: advice.length,
  };
}

/**
 * How long the statistics pass may run, and wait for a lock, before it gives
 * up. Kept here rather than in the route so describeStatsError, which explains
 * a timeout to the reader, quotes the same numbers the route sets.
 */
export const STATS_STATEMENT_TIMEOUT_MS = 5_000;
export const STATS_LOCK_TIMEOUT_MS = 2_000;

/**
 * How long the structure pass may wait for a lock another session holds.
 * Longer than the statistics pass gets, because without the structure there
 * are no suggestions at all; short enough that a table held by a running
 * ALTER TABLE gets a sentence saying so within seconds, instead of the tab
 * waiting out the snapshot's own 30-second limit and then blaming the
 * connection. describeStructureError quotes it.
 */
export const STRUCTURE_LOCK_TIMEOUT_MS = 5_000;
