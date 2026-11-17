// Query analysis: turning the nested EXPLAIN JSON into a flat list of steps.
//
// Holds what each node type means in plain words, the safe readers for a raw
// plan node, and flattenPlan, which builds the PlanStep list.

import type { PlanStep, RawPlanNode } from "./plan-types";
import { estimateRuns } from "./plan-runs";
import { plannerShareDivisor } from "./plan-helpers";
import type { TableRows } from "./catalog";

/**
 * What each kind of plan node does, in one sentence.
 *
 * The point of this screen is that somebody who has never read a query plan can
 * still act on one, and "Bitmap Heap Scan" tells them nothing. Anything not in
 * this map simply shows no sentence — an invented explanation would be worse
 * than none.
 */
const NODE_MEANINGS: Record<string, string> = {
  "Seq Scan": "Reads every row in the table and throws away the ones that do not match.",
  "Index Scan":
    "Walks an index to find the matching rows, then fetches each one from the table.",
  "Index Only Scan":
    "Answers straight from the index — the table itself is never opened.",
  "Bitmap Index Scan":
    "Collects the locations of matching rows from an index, without reading them yet.",
  "Bitmap Heap Scan":
    "Reads the rows the index pointed at, in physical order so the disk is not seeking about.",
  "Tid Scan": "Fetches rows by their physical position, given directly.",
  "Nested Loop":
    "For every row on one side, searches the other side. Fast when one side is tiny.",
  "Hash Join": "Builds a lookup table out of one side, then probes it once per row of the other.",
  Hash: "Builds the lookup table the join above it will probe.",
  "Merge Join": "Walks both sides in sorted order at once, matching as it goes.",
  Sort: "Puts rows in order. Nothing above it can start until every row has arrived.",
  "Incremental Sort": "Sorts within groups that are already partly in order, so it can start early.",
  Aggregate: "Reduces the rows to a single result — a count, a sum, an average.",
  HashAggregate: "Groups rows using a lookup table, so they do not need sorting first.",
  GroupAggregate: "Groups rows that are already in order.",
  Limit: "Stops once it has enough rows.",
  Unique: "Drops neighbouring duplicates from already-sorted rows.",
  Materialize: "Keeps a copy of its rows in memory so they can be replayed cheaply.",
  Memoize: "Remembers answers it has already looked up, in case the same key comes round again.",
  Gather: "Collects rows from parallel worker processes.",
  "Gather Merge": "Collects rows from parallel workers, keeping them in order.",
  Append: "Runs several sources one after another and returns all their rows.",
  "Merge Append": "Runs several sorted sources at once and keeps the combined output sorted.",
  "Subquery Scan": "Reads the rows of a subquery.",
  "CTE Scan": "Reads a WITH block that was computed separately and stored.",
  "Function Scan": "Reads the rows a function returned.",
  "Values Scan": "Reads a literal list of rows written into the query.",
  Result: "Produces rows without reading a table — a constant, or a computed value.",
  WindowAgg: "Computes window functions over rows that are already in the right order.",
  SetOp: "Applies INTERSECT or EXCEPT to two sorted inputs.",
  LockRows: "Takes row locks for SELECT … FOR UPDATE.",
  "ModifyTable": "Writes the rows — the INSERT, UPDATE or DELETE itself.",
};

/** Plan keys worth showing verbatim, in the order they read best. */
const DETAIL_KEYS: string[] = [
  "Index Cond",
  "Recheck Cond",
  "Filter",
  // A window function's condition, e.g. (row_number() OVER (?) <= 10), that
  // PostgreSQL 15 and later check as the rows go by instead of afterwards:
  // once it fails, no more rows of that window come out, and without
  // PARTITION BY the step stops reading. Read by the estimate-off rule,
  // because the planner does not count the rows it holds back.
  "Run Condition",
  "One-Time Filter",
  "Hash Cond",
  "Merge Cond",
  "Join Filter",
  // The call a Function Scan makes, e.g. generate_series(1, 10). Shown so the
  // reader sees the arguments, and read by planMentionsDenied, because a
  // function called in FROM appears nowhere else in the plan.
  "Function Call",
  "Sort Key",
  "Group Key",
  "Sort Method",
  "Rows Removed by Filter",
  "Rows Removed by Index Recheck",
  // Pages a bitmap stopped tracking row by row because it ran out of memory.
  // Shown only when above zero (see the details list below); read by the
  // lossy-bitmap rule to tell "out of memory" from an index type that always
  // needs rows rechecked.
  "Lossy Heap Blocks",
  "Rows Removed by Join Filter",
  "Heap Fetches",
  // Partitions an Append or Merge Append ruled out as the run started, once
  // values the plan could not use were known (a prepared statement's
  // parameter, or now()). Shown only when above zero, like Lossy Heap
  // Blocks; read by the estimate-off rule, because Plan Rows still count
  // the partitions left out.
  "Subplans Removed",
];

function str(node: RawPlanNode, key: string): string | null {
  const value = node[key];
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map((v) => String(v)).join(", ");
  return null;
}

export function numOrNull(node: RawPlanNode, key: string): number | null {
  const value = node[key];
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function num(node: RawPlanNode, key: string): number {
  return numOrNull(node, key) ?? 0;
}

/**
 * "external merge  Disk: 4096kB": a sort's method and the space it used, on
 * one line, the way the text form of EXPLAIN prints it.
 *
 * The JSON form splits this over three keys (Sort Method, Sort Space Used in
 * kB, Sort Space Type). Put back together, the reader sees in one line how
 * much a sort needed, and the sort-on-disk rule can size its advice from the
 * disk figure. A method that already carries its size is left as it is.
 */
function sortMethodText(node: RawPlanNode): string | null {
  const method = str(node, "Sort Method");
  if (method === null) return null;
  const used = numOrNull(node, "Sort Space Used");
  const type = str(node, "Sort Space Type");
  if (used === null || type === null || /\d\s*kB/i.test(method)) return method;
  return `${method}  ${type}: ${used}kB`;
}

/** The children of a node. `Plans` is what PostgreSQL calls the array. */
function childrenOf(node: RawPlanNode): RawPlanNode[] {
  const plans = node["Plans"];
  if (!Array.isArray(plans)) return [];
  return plans.filter((p): p is RawPlanNode => typeof p === "object" && p !== null);
}

/** "Seq Scan on orders o" / "Index Scan using orders_pkey on orders". */
function labelOf(node: RawPlanNode): string {
  const type = str(node, "Node Type") ?? "Step";
  const relation = str(node, "Relation Name");
  const index = str(node, "Index Name");
  const cte = str(node, "CTE Name");
  const fn = str(node, "Function Name");
  const alias = str(node, "Alias");

  // ModifyTable reports itself as "ModifyTable" with the verb — Insert, Update,
  // Delete — in a separate key, which reads as gibberish unless the two are put
  // back together.
  const operation = str(node, "Operation");
  let label = type === "ModifyTable" && operation ? operation : type;

  if (index) label += ` using ${index}`;
  const target = relation ?? cte ?? fn;
  if (target) {
    label += ` on ${target}`;
    // The alias only earns its place when it is not just the table name again.
    if (alias && alias !== target) label += ` ${alias}`;
  }
  return label;
}

/**
 * Flatten the plan tree into a list, computing each step's own time.
 *
 * PostgreSQL reports `Actual Total Time` per loop and INCLUSIVE of everything
 * below the node, which is why a plan's top line always shows the whole
 * duration. Subtracting the children gives the time the step spent on its own
 * work — the number that actually points at what to fix.
 *
 * It is an approximation for plans containing InitPlan / SubPlan nodes, whose
 * time is counted in their parent as well. Better an approximate answer to the
 * right question than an exact answer to the wrong one.
 *
 * `tableRows` is the catalog's table sizes, "schema.table" → rows. They go
 * on each step that reads a table before estimateRuns, which needs them to
 * count how often a subquery a filter tests runs.
 */
export function flattenPlan(root: RawPlanNode, tableRows: TableRows = {}): PlanStep[] {
  const steps: PlanStep[] = [];

  // `inParallel` is passed down rather than looked up later: everything below
  // a Gather runs in the helper processes, and a step only knows that by
  // having been told on the way down. `plannedWorkers` travels the same way:
  // the Gather's planned helpers, which set how the rows below were split.
  function walk(
    node: RawPlanNode,
    depth: number,
    parentId: number | null,
    inParallel: boolean,
    plannedWorkers: number | null
  ): void {
    const id = steps.length;
    const nodeType = str(node, "Node Type") ?? "Step";
    const loops = numOrNull(node, "Actual Loops");
    const perLoopMs = numOrNull(node, "Actual Total Time");
    const inclusiveMs = perLoopMs === null ? null : perLoopMs * (loops ?? 1);

    const details = DETAIL_KEYS.map((key) => {
      const value = key === "Sort Method" ? sortMethodText(node) : str(node, key);
      // A measured bitmap scan reports "Lossy Heap Blocks" even when it is 0,
      // and every Append in a JSON plan reports "Subplans Removed"; at 0 they
      // say nothing, and printing them on every such step would be noise.
      if ((key === "Lossy Heap Blocks" || key === "Subplans Removed") && value === "0") {
        return null;
      }
      return value === null ? null : `${key}: ${value}`;
    }).filter((line): line is string => line !== null);

    const step: PlanStep = {
      id,
      depth,
      parentId,
      parentRelationship: parentId === null ? null : str(node, "Parent Relationship"),
      nodeType,
      label: labelOf(node),
      relation: str(node, "Relation Name"),
      relationSchema: str(node, "Schema"),
      alias: str(node, "Alias"),
      filter: str(node, "Filter"),
      // A step has at most one of these in practice; the order only decides
      // which one wins on the rare node that carries two.
      joinCond:
        str(node, "Hash Cond") ??
        str(node, "Merge Cond") ??
        str(node, "Join Filter") ??
        str(node, "Index Cond"),
      output: str(node, "Output") ?? "",
      meaning: NODE_MEANINGS[nodeType] ?? "",
      details,
      estimatedRows: num(node, "Plan Rows"),
      estimatedCost: num(node, "Total Cost"),
      actualRows: numOrNull(node, "Actual Rows"),
      selfMs: inclusiveMs,
      loops,
      // The next seven are worked out once the whole tree is known: runs,
      // repeats, whether the runs are known or may stop short, whether the
      // rows may, and own cost by estimateRuns (plan-runs.ts), share by
      // weighSteps in readPlan.
      estimatedRuns: 1,
      repeated: false,
      runsKnown: true,
      runsMayStop: false,
      rowsMayStop: false,
      selfCost: 0,
      share: 0,
      // Filled in after the walk, from the catalog's table sizes.
      tableRows: null,
      inParallel,
      parallelAware: node["Parallel Aware"] === true,
      shareDivisor:
        node["Parallel Aware"] === true && plannedWorkers !== null
          ? plannerShareDivisor(plannedWorkers)
          : null,
      indexName: str(node, "Index Name"),
      joinType: str(node, "Join Type"),
      subplanName: str(node, "Subplan Name"),
      cteName: str(node, "CTE Name"),
      partialMode: str(node, "Partial Mode"),
      strategy: str(node, "Strategy"),
      // Launched is what really happened; Planned is all an estimate has.
      workers: numOrNull(node, "Workers Launched") ?? numOrNull(node, "Workers Planned"),
      // Needs the parent's expressions, so estimateRuns sets it.
      hashedSubplan: false,
      innerUnique: node["Inner Unique"] === true,
    };
    steps.push(step);

    const startsParallel = nodeType === "Gather" || nodeType === "Gather Merge";
    // Planned, not Launched, even in a measured plan: Plan Rows were split by
    // the helpers the planner counted on, whatever then really started.
    const childWorkers = startsParallel ? numOrNull(node, "Workers Planned") : plannedWorkers;
    let childInclusive = 0;
    for (const child of childrenOf(node)) {
      walk(child, depth + 1, id, inParallel || startsParallel, childWorkers);
      const childLoops = numOrNull(child, "Actual Loops");
      const childPerLoop = numOrNull(child, "Actual Total Time");
      if (childPerLoop !== null) childInclusive += childPerLoop * (childLoops ?? 1);
    }

    if (step.selfMs !== null) {
      // Clamped at zero: rounding in the reported milliseconds can otherwise
      // hand back a step that took negative time, which reads as a bug.
      step.selfMs = Math.max(0, step.selfMs - childInclusive);
    }
  }

  walk(root, 0, null, false, null);

  // The table's real size rides on the step, so the plain-words walk-through
  // can say "reads the whole of public.orders (1.2 million rows)" without
  // being handed the catalog as well. Before estimateRuns, which needs it to
  // count how often a subquery a filter tests runs.
  for (const step of steps) {
    if (step.relation === null || step.relationSchema === null) continue;
    const known: number | undefined = tableRows[`${step.relationSchema}.${step.relation}`];
    if (typeof known === "number") step.tableRows = known;
  }
  estimateRuns(steps);
  return steps;
}
