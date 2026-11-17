// Query analysis, part two: the plan. This file holds its types.
//
// RawPlanNode is the JSON as PostgreSQL gives it, PlanStep is one flattened
// line of it, PlanSummary is what readPlan returns, and AnalyzeView is the
// whole answer of the analyse route.

import type { QueryScore } from "../query-score";
import type { ThresholdBreach } from "../thresholds";
import type { QueryFinding } from "./findings";

// ── Part two: the plan ───────────────────────────────────────────────────────

/**
 * A node of `EXPLAIN (FORMAT JSON)` output.
 *
 * Typed as an open record rather than an exhaustive list of PostgreSQL's plan
 * keys: the set changes between major versions and between node types, and a
 * missing key here would be a crash rather than a shrug. Every read goes
 * through the accessors in plan-flatten.ts, which treat "absent" and "wrong type" the same.
 */
export type RawPlanNode = { [key: string]: unknown };

/** One line of the plan, already flattened out of the nested JSON. */
export type PlanStep = {
  /** Position in the flattened list — parents before children. */
  id: number;
  /** How deep this node sits, so the UI can indent without walking a tree. */
  depth: number;
  /**
   * The id of the step directly above this one, or null for the top step.
   * Lets a rule walk up the tree ("is there a LIMIT above me?") without
   * searching the flattened list.
   */
  parentId: number | null;
  /**
   * How the step above uses this one, verbatim from PostgreSQL: "Outer" and
   * "Inner" for the two sides of a join (Inner is the side a nested loop
   * repeats), "InitPlan" and "SubPlan" for a subquery, "Member" for one input
   * of an Append, "Subquery" for a subquery scan. Null for the top step.
   */
  parentRelationship: string | null;
  /** "Seq Scan", "Hash Join", … verbatim from PostgreSQL. */
  nodeType: string;
  /** "Seq Scan on orders o" — the line as a person reads it. */
  label: string;
  /**
   * The table this step reads, when it reads one — separate from `label`,
   * which has the alias and the index name folded into it. Kept apart because
   * it is the key a caller looks a table's real size up by.
   */
  relation: string | null;
  /**
   * The schema `relation` lives in, as the plan reported it. Kept beside the
   * table name because the name alone is not a key — two schemas on one server
   * routinely hold a table called `orders`.
   */
  relationSchema: string | null;
  /** The name the query gave the table ("o" in `FROM orders o`), or null. */
  alias: string | null;
  /**
   * The step's Filter, verbatim, or null. With VERBOSE, PostgreSQL writes each
   * column with the name the query knows its table by, even in a query over a
   * single table: the alias when there is one ("(o.customer_id = 42)"),
   * otherwise the table's own name ("(orders.customer_id = 42)"). A varchar
   * column compared with text gets a cast: "((o.status)::text = 'paid'::text)".
   * Only a plan taken without VERBOSE writes columns bare ("(status = 'paid')").
   */
  filter: string | null;
  /**
   * The condition this step matches rows on: Hash Cond, Merge Cond or Join
   * Filter for a join, Index Cond for an index lookup. Null when there is none.
   */
  joinCond: string | null;
  /** What this step hands up, e.g. "o.id, o.total". Empty without VERBOSE. */
  output: string;
  /** One plain sentence saying what this step does. Empty if we have no words. */
  meaning: string;
  /** "Filter: (status = 'paid')" and friends, already flattened to strings. */
  details: string[];
  /** The planner's guess at rows handed on, PER LOOP. */
  estimatedRows: number;
  estimatedCost: number;
  /**
   * Measured rows handed on, PER LOOP, as PostgreSQL reports them. Null unless
   * the plan came from EXPLAIN ANALYZE. Multiply by `loops` for the total.
   */
  actualRows: number | null;
  /** Milliseconds spent in this step ALONE, children excluded. */
  selfMs: number | null;
  loops: number | null;
  /**
   * How many times the planner expects this step to run, worked out from the
   * shape of the plan (see estimateRuns). 1 for most steps; the repeated side
   * of a nested loop runs once per row of the other side. Needed because Total
   * Cost is the cost of ONE run, so a cheap step run 5,000 times can be the
   * most expensive thing in the query.
   */
  estimatedRuns: number;
  /**
   * True when the plan's shape runs this step again for each row of a step
   * above it: the repeated side of a nested loop (a Memoize or Materialize
   * there included), a subquery PostgreSQL runs for each row, and the steps
   * below them. Set by estimateRuns. Below a Gather this is what tells a
   * repeat from one of the processes, since measured loops count both.
   */
  repeated: boolean;
  /**
   * False when an estimate cannot say how often this step really runs, so no
   * count is shown for it. A subquery a filter tests runs once for each row
   * the filter reads, which the plan gives only for some steps (see
   * rowsFilterReads); a filter or output with AND, OR, CASE or COALESCE in
   * it may skip the subquery; and an aggregate runs a subquery in its
   * output for each row it reads when it sits inside sum(…), but once for
   * each group otherwise. estimatedRuns then counts the rows read where they
   * are known, as the planner's cost does, and the rows handed on where they
   * are not. Also false for a subquery used somewhere other than a filter or
   * the output, and for every step below one of these, down to any InitPlan,
   * whose runs are counted afresh. Set by estimateRuns.
   */
  runsKnown: boolean;
  /**
   * True when estimatedRuns is only the most this step may run: it runs
   * again for each row of a step above it, and that step may be stopped
   * early (a nested loop under a LIMIT, say), so fewer rows may ask for it.
   * See runsMayStop. Set by estimateRuns.
   */
  runsMayStop: boolean;
  /**
   * True when an estimate's estimatedRows is only the most this step may
   * hand on: the run may stop it early (readStop), and it does not make its
   * whole result first (readsAllFirst). A hash join under a LIMIT, say, is
   * planned for every row it would give, but hands on only what the LIMIT
   * asks for. Set by estimateRuns.
   */
  rowsMayStop: boolean;
  /**
   * The planner's cost for this step alone, over all its runs, with its
   * children's cost taken off. An approximation: see estimateRuns.
   */
  selfCost: number;
  /**
   * This step's part of the whole query, 0 to 1: its selfMs over the total of
   * every step's selfMs when the query was run, otherwise its selfCost over
   * the total of every selfCost. Filled in by readPlan; 0 until then.
   */
  share: number;
  /**
   * How many rows the table `relation` holds, from the catalog, or null when
   * the step reads no table or the catalog was not given. Filled in by
   * flattenPlan, from the catalog handed to readPlan.
   */
  tableRows: number | null;
  /**
   * True when this step runs inside a parallel section (below a Gather). Its
   * row counts are then per helper process, not for the whole query.
   */
  inParallel: boolean;
  /**
   * True when the helper processes share this step's work between them, e.g.
   * a parallel scan where each process reads part of the table. Its measured
   * loops are then the processes, not repeats. False for a step every process
   * runs in full, such as the lookup side of a join.
   */
  parallelAware: boolean;
  /**
   * For a step the helper processes share (parallelAware): what the planner
   * divided its estimated rows by to give one process's share, e.g. 2.4 for
   * two helpers and the main process. Null for every other step, and when
   * the Gather above gave no planned count. See plannerShareDivisor.
   */
  shareDivisor: number | null;
  /** The index an index or bitmap scan reads, e.g. "orders_customer_idx". */
  indexName: string | null;
  /** For a join: "Inner", "Left", "Semi", "Anti", … verbatim. Null otherwise. */
  joinType: string | null;
  /**
   * For a subquery step: its name as the rest of the plan refers to it, e.g.
   * "InitPlan 1", "SubPlan 2", or "CTE recent" for a WITH query.
   */
  subplanName: string | null;
  /** For a CTE Scan: the WITH query it reads, e.g. "recent". */
  cteName: string | null;
  /**
   * For an aggregate split across parallel helpers: "Partial" (each helper
   * counts its own share) or "Finalize" (the shares are added up). Null or
   * "Simple" for an ordinary aggregate.
   */
  partialMode: string | null;
  /**
   * How an Aggregate adds rows up: "Plain" for one total over all of them,
   * "Sorted" or "Hashed" for one per group (GROUP BY, DISTINCT), "Mixed" for
   * grouping sets such as ROLLUP. A SetOp gives one too. Null for other steps.
   */
  strategy: string | null;
  /**
   * For a Gather: the helper processes launched (measured) or planned
   * (estimate). Null for every other step.
   */
  workers: number | null;
  /**
   * True for a subquery PostgreSQL runs once and keeps in an in-memory lookup
   * table ("hashed SubPlan 1"), rather than once per row of the step above.
   */
  hashedSubplan: boolean;
  /**
   * For a join: true when PostgreSQL proved that each row of the first side
   * matches at most one row of the second ("Inner Unique", which EXPLAIN
   * prints with VERBOSE, and the analyser always asks for VERBOSE). The join
   * then moves on at the first match instead of reading the second side on.
   */
  innerUnique: boolean;
};

export type PlanSummary = {
  steps: PlanStep[];
  /** The planner's own cost for the whole plan, in its arbitrary units. */
  totalCost: number;
  /** How many rows the planner expects the query to return. */
  estimatedRows: number;
  planningMs: number | null;
  executionMs: number | null;
  /** True when the query was actually run, so the actuals above are measured. */
  measured: boolean;
  /**
   * The step with the largest share: the slowest step when the query was run,
   * the most expensive by the planner's estimate otherwise. Null only when
   * every share is 0 (nothing timed, nothing costed).
   */
  heaviestStepId: number | null;
  /**
   * What every step's `share` is a share of: "time" when the query was run and
   * timed, "cost" when it is the planner's estimate. The screen words its
   * legend from this, because a cost is a guess and must not read as a timing.
   */
  basis: "time" | "cost";
  findings: QueryFinding[];
};

/** What the plan is worth: the planner's estimates, or a real, measured run. */
export type AnalyzeMode = "estimate" | "measured";

/**
 * The whole response of POST /api/performance/analyze.
 *
 * Defined here, not in the route, so the route and the screen
 * (components/studio/QueryAnalyzer.tsx) share one definition. The screen
 * imports it with `import type`, which is erased at build time.
 */
export type AnalyzeView = {
  connectionName: string;
  database: string;
  schema: string;
  mode: AnalyzeMode;
  /** The one-line verdict, e.g. "Ran in 3.1 ms and returned 42 rows…". */
  headline: string;
  plan: PlanSummary;
  /** Findings from the plan and from the query text, merged and ranked. */
  findings: QueryFinding[];
  counts: { high: number; medium: number; low: number; total: number };
  /** The 0–100 verdict and the reasons behind it. See lib/performance/query-score.ts. */
  score: QueryScore;
  /**
   * The row this analysis was filed as, for the "see every run of this query"
   * link. Null when the history table could not be written — filing is
   * best-effort, and a null here is what tells the screen there is no row to
   * link to rather than linking to an id that does not exist.
   */
  historyId: number | null;
  /** The grouping key for this query's other runs. See lib/performance/query-history.ts. */
  fingerprint: string;
  /** Alert thresholds this run broke. Empty unless some are switched on. */
  breaches: ThresholdBreach[];
};
