// Spec feature 08 — query execution analysis.
//
// Dependency-free on purpose, like lib/sql-guard.ts and lib/perf-advice.ts:
// nothing here opens a connection, so the whole module runs in a test, in a
// route handler, and (if it were ever wanted) in the browser. The route next
// door is the only thing that talks to a database; it hands the EXPLAIN output
// in here as plain JSON and gets a summary back.
//
// Two independent halves, kept apart for the same reason feature 09 keeps its
// two passes apart — they are true in different ways:
//
//   • readPlan()   reads what THIS server would actually do with THIS query
//                  against the data it has right now. Correct, and perishable.
//   • readSql()    reads the query text alone. Weaker, but it holds regardless
//                  of what is in the tables, and it still says something when
//                  the database cannot be reached at all.

import { maskNonCode } from "./sql-guard";

export type Severity = "high" | "medium" | "low";

/** One finding, whichever half produced it. Same shape as PerfAdvice by design. */
export type QueryFinding = {
  id: string;
  severity: Severity;
  title: string;
  /** What it is about — a table, a plan step, or the statement itself. */
  object: string;
  detail: string;
  /** What to do, in words or SQL. Empty when there is nothing to paste. */
  fix: string;
};

// ── Half one: the plan ───────────────────────────────────────────────────────

/**
 * A node of `EXPLAIN (FORMAT JSON)` output.
 *
 * Typed as an open record rather than an exhaustive list of PostgreSQL's plan
 * keys: the set changes between major versions and between node types, and a
 * missing key here would be a crash rather than a shrug. Every read goes
 * through the accessors below, which treat "absent" and "wrong type" the same.
 */
export type RawPlanNode = { [key: string]: unknown };

/** One line of the plan, already flattened out of the nested JSON. */
export type PlanStep = {
  /** Position in the flattened list — parents before children. */
  id: number;
  /** How deep this node sits, so the UI can indent without walking a tree. */
  depth: number;
  /** "Seq Scan", "Hash Join", … verbatim from PostgreSQL. */
  nodeType: string;
  /** "Seq Scan on orders" — the line as a person reads it. */
  label: string;
  /**
   * The table this step reads, when it reads one — separate from `label`,
   * which has the alias and the index name folded into it. Kept apart because
   * it is the key a caller looks a table's real size up by.
   */
  relation: string | null;
  /** One plain sentence saying what this step does. Empty if we have no words. */
  meaning: string;
  /** "Filter: (status = 'paid')" and friends, already flattened to strings. */
  details: string[];
  estimatedRows: number;
  estimatedCost: number;
  /** Measured values. Null unless the plan came from EXPLAIN ANALYZE. */
  actualRows: number | null;
  /** Milliseconds spent in this step ALONE, children excluded. */
  selfMs: number | null;
  loops: number | null;
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
  /** The step with the largest selfMs. Null when nothing was measured. */
  slowestStepId: number | null;
  findings: QueryFinding[];
};

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
  "One-Time Filter",
  "Hash Cond",
  "Merge Cond",
  "Join Filter",
  "Sort Key",
  "Group Key",
  "Sort Method",
  "Rows Removed by Filter",
  "Rows Removed by Index Recheck",
  "Rows Removed by Join Filter",
  "Heap Fetches",
];

function str(node: RawPlanNode, key: string): string | null {
  const value = node[key];
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map((v) => String(v)).join(", ");
  return null;
}

function numOrNull(node: RawPlanNode, key: string): number | null {
  const value = node[key];
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function num(node: RawPlanNode, key: string): number {
  return numOrNull(node, key) ?? 0;
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
 */
function flattenPlan(root: RawPlanNode): PlanStep[] {
  const steps: PlanStep[] = [];

  function walk(node: RawPlanNode, depth: number): void {
    const id = steps.length;
    const nodeType = str(node, "Node Type") ?? "Step";
    const loops = numOrNull(node, "Actual Loops");
    const perLoopMs = numOrNull(node, "Actual Total Time");
    const inclusiveMs = perLoopMs === null ? null : perLoopMs * (loops ?? 1);

    const details = DETAIL_KEYS.map((key) => {
      const value = str(node, key);
      return value === null ? null : `${key}: ${value}`;
    }).filter((line): line is string => line !== null);

    const step: PlanStep = {
      id,
      depth,
      nodeType,
      label: labelOf(node),
      relation: str(node, "Relation Name"),
      meaning: NODE_MEANINGS[nodeType] ?? "",
      details,
      estimatedRows: num(node, "Plan Rows"),
      estimatedCost: num(node, "Total Cost"),
      actualRows: numOrNull(node, "Actual Rows"),
      selfMs: inclusiveMs,
      loops,
    };
    steps.push(step);

    let childInclusive = 0;
    for (const child of childrenOf(node)) {
      const before = steps.length;
      walk(child, depth + 1);
      const childStep = steps[before];
      const childLoops = numOrNull(child, "Actual Loops");
      const childPerLoop = numOrNull(child, "Actual Total Time");
      if (childStep && childPerLoop !== null) {
        childInclusive += childPerLoop * (childLoops ?? 1);
      }
    }

    if (step.selfMs !== null) {
      // Clamped at zero: rounding in the reported milliseconds can otherwise
      // hand back a step that took negative time, which reads as a bug.
      step.selfMs = Math.max(0, step.selfMs - childInclusive);
    }
  }

  walk(root, 0);
  return steps;
}

/** How many rows a step really produced, across all of its loops. */
function totalActualRows(step: PlanStep): number | null {
  if (step.actualRows === null) return null;
  return step.actualRows * (step.loops ?? 1);
}

/** "1,204" — thousands separators, because plan numbers get long. */
function fmtRows(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** Round to at most two decimals without printing "12.00". */
function fmtMs(n: number): string {
  return `${Math.round(n * 100) / 100} ms`;
}

/**
 * Rows a plan has to touch before a rule counts the table as "big".
 *
 * A sequential scan of forty rows is the right plan and always will be — the
 * server would spend more time opening an index than reading the table. The
 * threshold is what stops this screen from telling people to index a lookup
 * table of currency codes.
 */
const BIG_TABLE_ROWS = 5000;

/**
 * Node types that read rows out of a table.
 *
 * "Function Scan" and "Values Scan" also end in the word Scan, and neither has
 * an index it could have used — counting them would make the "no index
 * anywhere" rule fire on `SELECT * FROM generate_series(1, 10000)`.
 */
const TABLE_SCANS: ReadonlySet<string> = new Set([
  "Seq Scan",
  "Index Scan",
  "Index Only Scan",
  "Bitmap Heap Scan",
  "Tid Scan",
]);

/** The count off a "Rows Removed by Filter: 39999" plan line, when there is one. */
function rowsRemovedByFilter(step: PlanStep): number | null {
  const prefix = "Rows Removed by Filter: ";
  const line = step.details.find((d) => d.startsWith(prefix));
  if (line === undefined) return null;
  const removed = Number(line.slice(prefix.length));
  return Number.isFinite(removed) ? removed : null;
}

/**
 * How many rows this step actually reads.
 *
 * For a scan of a known table that is the table's size; for everything else it
 * is whatever the plan said, which is the best answer available.
 */
function rowsScanned(step: PlanStep, tableRows: TableRows, planRows: number): number {
  if (step.relation === null || !TABLE_SCANS.has(step.nodeType)) return planRows;
  const known = tableRows[step.relation];
  return typeof known === "number" && known > planRows ? known : planRows;
}

/**
 * How many rows each table in the schema actually holds, keyed by table name.
 *
 * Optional, and for one reason: a plan says how many rows a step will HAND ON,
 * not how many it will READ. `SELECT * FROM orders WHERE id = 7` shows a
 * sequential scan expecting one row — which is exactly the query the whole-table
 * rule below exists to catch, and exactly the one it would miss reading the plan
 * alone. Nothing in EXPLAIN carries the table's size, so a caller that can ask
 * the server passes the answer in; a caller that cannot gets the weaker reading
 * rather than an invented one.
 */
export type TableRows = Record<string, number>;

/** Rules that read the plan. Ordered as they are written, sorted on the way out. */
/**
 * The direct children of one flattened plan step.
 *
 * flattenPlan walks depth-first, so a step's subtree is the contiguous run of
 * ids after it, ending at the first step back at its own depth or shallower.
 * Matching on `depth === step.depth + 1` alone — which this used to do — picked
 * up any node one level down anywhere in the plan, so a busy inner side under a
 * completely different join was reported as this loop's.
 */
function childrenOfStep(steps: PlanStep[], step: PlanStep): PlanStep[] {
  const children: PlanStep[] = [];
  for (let i = step.id + 1; i < steps.length; i += 1) {
    if (steps[i].depth <= step.depth) break;
    if (steps[i].depth === step.depth + 1) children.push(steps[i]);
  }
  return children;
}

function planFindings(
  steps: PlanStep[],
  measured: boolean,
  tableRows: TableRows
): QueryFinding[] {
  const out: QueryFinding[] = [];

  for (const step of steps) {
    const actual = totalActualRows(step);
    const rows = actual ?? step.estimatedRows;

    if (step.nodeType === "Seq Scan") {
      const table = step.relation ?? step.label.replace(/^Seq Scan on /, "");
      // A sequential scan reads the table; `rows` is only what survives the
      // filter afterwards. Use the real size when the caller supplied it, and
      // fall back to the plan's number when it did not.
      const scanned = rowsScanned(step, tableRows, rows);
      const discarded = scanned - rows;
      const removed = rowsRemovedByFilter(step);

      if (scanned >= BIG_TABLE_ROWS) {
        out.push({
          id: `seq-scan:${step.id}`,
          severity: "high",
          title: "Whole table read to answer this",
          object: table,
          detail:
            `Step ${step.id + 1} reads ${fmtRows(scanned)} rows out of ${table} one ` +
            `after another, with no index involved. ` +
            (removed !== null
              ? `${fmtRows(removed)} of them are thrown away again immediately, ` +
                `having been read only to fail the filter. `
              : discarded >= rows && discarded > 0
                ? `Only about ${fmtRows(rows)} row${rows === 1 ? " is" : "s are"} ` +
                  `expected to match, so most of the reading is thrown away. `
                : "") +
            `Below roughly ${fmtRows(BIG_TABLE_ROWS)} rows this is the right plan; ` +
            `above it, the read grows with the table.`,
          fix:
            `-- Index the columns this step filters on, then EXPLAIN again.\n` +
            `-- The filter for this step is shown on the plan line above.\n` +
            `CREATE INDEX CONCURRENTLY ON ${table} (/* filtered column(s) */);`,
        });
      }
    }

    // A filter that throws away far more than it keeps is the clearest signal
    // in a plan that an index is missing — the rows were read only to be
    // discarded.
    const discarded = rowsRemovedByFilter(step);
    if (
      measured &&
      discarded !== null &&
      actual !== null &&
      discarded >= 1000 &&
      discarded > actual * 10
    ) {
      out.push({
        id: `wasteful-filter:${step.id}`,
        severity: "high",
        title: "Nearly everything read here was thrown away",
        object: step.label,
        detail:
          `Step ${step.id + 1} read ${fmtRows(discarded + actual)} rows and kept ` +
          `${fmtRows(actual)}. The other ${fmtRows(discarded)} were fetched only to ` +
          `fail the filter. An index matching that filter would let the server skip ` +
          `them without ever reading them.`,
        fix: "",
      });
    }

    // The planner chooses a plan from its estimates. When an estimate is out by
    // an order of magnitude the plan was chosen for a query that does not
    // exist, and no amount of indexing fixes that — the statistics do.
    if (measured && actual !== null && actual >= 100 && step.estimatedRows > 0) {
      const ratio =
        actual > step.estimatedRows
          ? actual / step.estimatedRows
          : step.estimatedRows / actual;
      if (ratio >= 10) {
        out.push({
          id: `estimate-off:${step.id}`,
          severity: "medium",
          title: "The planner's row estimate is far off",
          object: step.label,
          detail:
            `Step ${step.id + 1} was planned for ${fmtRows(step.estimatedRows)} rows ` +
            `and produced ${fmtRows(actual)} — out by about ${Math.round(ratio)}×. ` +
            `Everything above this step was planned around the wrong number, so the ` +
            `join order and join methods may be wrong too. Usually this means the ` +
            `table's statistics are stale.`,
          fix: `ANALYZE /* the table this step reads */;`,
        });
      }
    }

    const sortMethod = step.details.find((d) => d.startsWith("Sort Method: "));
    if (sortMethod && /external/i.test(sortMethod)) {
      out.push({
        id: `sort-on-disk:${step.id}`,
        severity: "medium",
        title: "The sort ran out of memory and used the disk",
        object: step.label,
        detail:
          `Step ${step.id + 1} reports "${sortMethod.slice("Sort Method: ".length)}", ` +
          `which means the rows would not fit in this session's working memory and ` +
          `were written to temporary files. Sorting on disk is far slower than ` +
          `sorting in memory.`,
        fix:
          `-- Either give the sort more room for this session…\n` +
          `SET work_mem = '64MB';\n\n` +
          `-- …or remove the sort, by indexing the columns it orders on.`,
      });
    }

    // A nested loop is the right choice when the inner side is tiny. Run
    // thousands of times, it is the classic accidental O(n·m).
    const inner =
      step.nodeType === "Nested Loop" && measured
        ? childrenOfStep(steps, step).find((s) => (s.loops ?? 1) >= 1000)
        : undefined;
    if (inner) {
      out.push({
        id: `nested-loop:${step.id}`,
        severity: "medium",
        title: "One side of this join is searched thousands of times",
        object: step.label,
        detail:
          `Step ${step.id + 1} looks up the other side of the join once per row, and ` +
          `it did so ${fmtRows(inner?.loops ?? 0)} times. That is fine when each lookup ` +
          `hits an index and costs nothing; when it does not, the cost multiplies.`,
        fix:
          `-- Make each lookup an index hit by indexing the join column on the\n` +
          `-- inner side, or let the planner pick a hash join instead.`,
      });
    }

    const recheck = step.details.find((d) => d.startsWith("Rows Removed by Index Recheck: "));
    if (recheck) {
      const lost = Number(recheck.slice("Rows Removed by Index Recheck: ".length));
      if (Number.isFinite(lost) && lost > 0) {
        out.push({
          id: `lossy-bitmap:${step.id}`,
          severity: "low",
          title: "The index lookup overflowed and had to be rechecked",
          object: step.label,
          detail:
            `The bitmap of matching rows grew too large to track them individually, ` +
            `so whole pages were read and re-tested — ${fmtRows(lost)} rows were ` +
            `dropped on the second look. More working memory would keep the bitmap exact.`,
          fix: `SET work_mem = '64MB';`,
        });
      }
    }

    const heap = step.details.find((d) => d.startsWith("Heap Fetches: "));
    if (heap && step.nodeType === "Index Only Scan") {
      const fetches = Number(heap.slice("Heap Fetches: ".length));
      if (Number.isFinite(fetches) && fetches >= 1000) {
        const table = step.label.replace(/^.* on /, "");
        out.push({
          id: `heap-fetches:${step.id}`,
          severity: "low",
          title: "An index-only scan kept having to open the table anyway",
          object: table,
          detail:
            `This step should have been answered by the index alone, but it went to ` +
            `the table ${fmtRows(fetches)} times because the rows had been changed too ` +
            `recently for the visibility map to vouch for them. Vacuuming refreshes it.`,
          fix: `VACUUM (ANALYZE) ${table};`,
        });
      }
    }
  }

  // Whole-plan rules ─────────────────────────────────────────────────────────

  const touchesData = steps.some((s) => TABLE_SCANS.has(s.nodeType));
  const usesIndex = steps.some((s) => s.nodeType.includes("Index"));
  const biggest = steps.reduce((max, s) => {
    const rows = totalActualRows(s) ?? s.estimatedRows;
    return Math.max(max, rowsScanned(s, tableRows, rows));
  }, 0);
  if (touchesData && !usesIndex && biggest >= BIG_TABLE_ROWS) {
    out.push({
      id: "no-index-anywhere",
      severity: "medium",
      title: "No index is used anywhere in this plan",
      object: "the whole query",
      detail:
        `Every step of this plan reads its rows in bulk. On ${fmtRows(biggest)} rows ` +
        `that is survivable; it stops being survivable as the tables grow, because ` +
        `there is nothing here whose cost does not grow with them.`,
      fix: "",
    });
  }

  return out;
}

/** Highest severity first, then in plan order, so the list reads top-down. */
const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

export function sortFindings(findings: QueryFinding[]): QueryFinding[] {
  return [...findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

/**
 * Turn one `EXPLAIN (FORMAT JSON)` result into something readable.
 *
 * Returns null rather than throwing when the shape is not a plan at all: the
 * caller has just handed over whatever a database replied with, and a driver
 * that returns the JSON as a string, or a version that nests it differently,
 * should show "could not read the plan" rather than a stack trace.
 *
 * `tableRows` is optional and sharpens the rules that care how much a step
 * reads rather than how much it returns — see the type's own note.
 */
export function readPlan(raw: unknown, tableRows: TableRows = {}): PlanSummary | null {
  // node-pg hands EXPLAIN (FORMAT JSON) back already parsed, as a one-element
  // array. Accept the bare object too, since that is what a test writes.
  const envelope: unknown = Array.isArray(raw) ? raw[0] : raw;
  if (typeof envelope !== "object" || envelope === null) return null;

  const record = envelope as RawPlanNode;
  const rootValue = record["Plan"];
  const root =
    typeof rootValue === "object" && rootValue !== null
      ? (rootValue as RawPlanNode)
      : null;
  if (!root || typeof root["Node Type"] !== "string") return null;

  const steps = flattenPlan(root);
  const measured = steps.some((s) => s.actualRows !== null);

  let slowestStepId: number | null = null;
  if (measured) {
    let best = -1;
    for (const step of steps) {
      if (step.selfMs !== null && step.selfMs > best) {
        best = step.selfMs;
        slowestStepId = step.id;
      }
    }
  }

  return {
    steps,
    totalCost: steps[0]?.estimatedCost ?? 0,
    estimatedRows: steps[0]?.estimatedRows ?? 0,
    planningMs: numOrNull(record, "Planning Time"),
    executionMs: numOrNull(record, "Execution Time"),
    measured,
    slowestStepId,
    findings: sortFindings(planFindings(steps, measured, tableRows)),
  };
}

/** A one-line verdict for the top of the screen. */
export function describePlan(summary: PlanSummary): string {
  const head = summary.steps[0];
  if (!head) return "The server returned an empty plan.";
  if (summary.measured && summary.executionMs !== null) {
    const rows = totalActualRows(head);
    return (
      `Ran in ${fmtMs(summary.executionMs)} and returned ` +
      `${fmtRows(rows ?? 0)} row${rows === 1 ? "" : "s"}, in ${summary.steps.length} ` +
      `step${summary.steps.length === 1 ? "" : "s"}.`
    );
  }
  return (
    `Planned in ${summary.steps.length} step${summary.steps.length === 1 ? "" : "s"}, ` +
    `expecting ${fmtRows(summary.estimatedRows)} ` +
    `row${summary.estimatedRows === 1 ? "" : "s"} back. Not run, so these are ` +
    `estimates.`
  );
}

// ── Half two: the query text ─────────────────────────────────────────────────

/**
 * Find every place a keyword appears as real code.
 *
 * Scanning happens on the masked copy — comments, string literals and quoted
 * identifiers are blanked there — while the positions it returns are equally
 * valid in the original, because maskNonCode preserves length. That is what
 * lets a rule below look at what a literal actually CONTAINS (the wildcard
 * rule needs to) without ever mistaking a commented-out line for live SQL.
 */
function codeMatches(mask: string, pattern: RegExp): CodeMatch[] {
  const flags = pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g";
  const re = new RegExp(pattern.source, flags);
  const out: CodeMatch[] = [];
  let match = re.exec(mask);
  while (match !== null) {
    out.push({ index: match.index, end: match.index + match[0].length });
    // A zero-width match would otherwise spin here forever.
    if (match.index === re.lastIndex) re.lastIndex += 1;
    match = re.exec(mask);
  }
  return out;
}

/** Where a keyword sits, and where it stops — both valid in the original too. */
type CodeMatch = { index: number; end: number };

/** True when the keyword appears anywhere outside a comment or a literal. */
function inCode(mask: string, pattern: RegExp): boolean {
  return codeMatches(mask, pattern).length > 0;
}

/**
 * How deep in parentheses a position is, counting from the start of the mask.
 *
 * The mask has already blanked string literals and comments, so every bracket
 * left is real syntax.
 */
function parenDepthAt(mask: string, index: number): number {
  let depth = 0;
  for (let i = 0; i < index && i < mask.length; i += 1) {
    if (mask[i] === "(") depth += 1;
    else if (mask[i] === ")") depth = Math.max(0, depth - 1);
  }
  return depth;
}

/** Where a WHERE clause stops. Anything past one of these is a different clause. */
const CLAUSE_END = /\b(?:GROUP\s+BY|HAVING|WINDOW|ORDER\s+BY|LIMIT|OFFSET|FETCH|UNION|INTERSECT|EXCEPT|RETURNING)\b/i;

/**
 * Each WHERE clause in the statement, as text.
 *
 * A clause runs from the keyword to whichever comes first: the next clause
 * keyword, a semicolon, or the end. Rules that ask "is this condition shaped
 * badly" have to read one clause, not the whole statement.
 */
function whereClauses(mask: string): string[] {
  return codeMatches(mask, /\bWHERE\b/i).map((m) => {
    const rest = mask.slice(m.end);
    const stop = CLAUSE_END.exec(rest);
    const semi = rest.indexOf(";");
    const ends = [stop ? stop.index : rest.length, semi === -1 ? rest.length : semi];
    return rest.slice(0, Math.min(...ends));
  });
}

/**
 * Rules that read only the query text.
 *
 * Every one of these is a heuristic and is written to be wrong in the safe
 * direction: it says "this shape usually costs you X", never "your query is
 * broken". The plan above is the authority on what this server will actually
 * do; these hold when there is no server to ask.
 */
export function readSql(sql: string): QueryFinding[] {
  const mask = maskNonCode(sql);
  const out: QueryFinding[] = [];

  if (inCode(mask, /\bSELECT\s+\*/i)) {
    out.push({
      id: "select-star",
      severity: "low",
      title: "SELECT * asks for every column",
      object: "the select list",
      detail:
        "Every column is fetched and sent back, including ones this query never " +
        "looks at, and an index that covers the columns you do use cannot be used " +
        "on its own. It also means adding a column to the table silently changes " +
        "what this query returns.",
      fix: "-- Name the columns you actually use:\nSELECT id, name, created_at FROM …",
    });
  }

  // The wildcard lives inside a string literal, which the mask blanks — so the
  // keyword is located in code and the pattern is then read from the original.
  const likeAt = codeMatches(mask, /\b(?:I?LIKE|SIMILAR\s+TO)\b/i);
  if (likeAt.some((m) => /^\s*'\s*%/.test(sql.slice(m.end, m.end + 40)))) {
    out.push({
      id: "leading-wildcard",
      severity: "medium",
      title: "A pattern starting with % cannot use an ordinary index",
      object: "the LIKE condition",
      detail:
        "A B-tree index is sorted by the start of the value, so it can find " +
        "everything beginning with \"smith\" but nothing about what ends with it. " +
        "A leading % forces the server to test every row.",
      fix:
        "-- For prefix search, drop the leading %.\n" +
        "-- For search anywhere in the text, use a trigram index:\n" +
        "CREATE EXTENSION IF NOT EXISTS pg_trgm;\n" +
        "CREATE INDEX ON your_table USING gin (your_column gin_trgm_ops);",
    });
  }

  // LOWER(email) = … and friends: the index is on the column, the condition is
  // on the result of a function, and those are two different things.
  //
  // Searched inside each WHERE clause rather than across the whole statement:
  // a single regex with `[\s\S]*` between WHERE and the call was satisfied by a
  // function call anywhere later — a SELECT list, an ORDER BY, a following
  // subquery — so the finding fired on statements that wrap nothing.
  const functionOnColumn = whereClauses(mask).some((clause) =>
    /\b(?:LOWER|UPPER|DATE|CAST|COALESCE|SUBSTRING)\s*\(\s*[A-Za-z_][\w.]*\s*\)\s*(?:=|<|>|LIKE)/i.test(
      clause
    )
  );
  if (functionOnColumn) {
    out.push({
      id: "function-on-column",
      severity: "medium",
      title: "A function is applied to the column being filtered",
      object: "the WHERE clause",
      detail:
        "An index stores the column's values, not the function's results, so a " +
        "condition like LOWER(email) = … cannot use an index on email. The server " +
        "has to compute the function for every row before it can compare anything.",
      fix:
        "-- Either index the expression itself…\n" +
        "CREATE INDEX ON your_table (LOWER(your_column));\n\n" +
        "-- …or rewrite the condition so the bare column is on the left.",
    });
  }

  if (inCode(mask, /\bNOT\s+IN\s*\(\s*SELECT\b/i)) {
    out.push({
      id: "not-in-subquery",
      severity: "medium",
      title: "NOT IN (SELECT …) returns nothing if the subquery has a NULL",
      object: "the NOT IN condition",
      detail:
        "This is a correctness trap before it is a speed one: if a single row of " +
        "the subquery is NULL, the comparison is never true for anything and the " +
        "whole query returns no rows at all. NOT EXISTS does not have that rule, " +
        "and usually plans better as well.",
      fix:
        "-- Same intent, without the NULL trap:\n" +
        "SELECT … FROM a\n" +
        " WHERE NOT EXISTS (SELECT 1 FROM b WHERE b.a_id = a.id);",
    });
  }

  // FROM a, b — a join whose condition, if it exists at all, is buried in the
  // WHERE clause. Deliberately narrow: only a comma directly between two
  // table-ish names right after FROM.
  if (inCode(mask, /\bFROM\s+[A-Za-z_][\w.]*(?:\s+(?!WHERE|JOIN|GROUP|ORDER|LIMIT|UNION|ON)[A-Za-z_]\w*)?\s*,\s*[A-Za-z_][\w.]*/i)) {
    out.push({
      id: "comma-join",
      severity: "low",
      title: "Tables are joined with a comma",
      object: "the FROM clause",
      detail:
        "The join condition, if there is one, is somewhere in the WHERE clause " +
        "mixed in with the filters. Forget it and this becomes every row of one " +
        "table paired with every row of the other. An explicit JOIN … ON puts the " +
        "condition where it cannot be lost.",
      fix: "SELECT … FROM a JOIN b ON b.a_id = a.id WHERE …",
    });
  }

  // Only an ORDER BY that orders the result set. A window function's
  // `OVER (ORDER BY …)` and a subquery's own ordering both sit inside
  // parentheses, and neither has anything to do with how many rows come back.
  const topLevelOrderBy = codeMatches(mask, /\bORDER\s+BY\b/i).some(
    (m) => parenDepthAt(mask, m.index) === 0
  );
  if (topLevelOrderBy && !inCode(mask, /\bLIMIT\b|\bFETCH\s+FIRST\b/i)) {
    out.push({
      id: "order-by-no-limit",
      severity: "low",
      title: "Everything is sorted, and all of it is returned",
      object: "the ORDER BY clause",
      detail:
        "Without a LIMIT the server has to sort every matching row before it can " +
        "return the first one, and then send all of them. If this is feeding a " +
        "screen that shows twenty rows, it is doing far more work than the screen needs.",
      fix: "SELECT … ORDER BY created_at DESC LIMIT 20;",
    });
  }

  const bigOffset = codeMatches(mask, /\bOFFSET\s+\d+/i).some((m) => {
    const digits = /(\d+)/.exec(mask.slice(m.index, m.end));
    return digits ? Number(digits[1]) >= 1000 : false;
  });
  if (bigOffset) {
    out.push({
      id: "deep-offset",
      severity: "medium",
      title: "A large OFFSET still reads everything it skips",
      object: "the OFFSET clause",
      detail:
        "OFFSET does not jump — the server produces the skipped rows and then " +
        "discards them. Page 1 is instant and page 500 is slow, on the same query. " +
        "Remembering where the last page ended avoids the whole problem.",
      fix:
        "-- Keyset pagination: carry the last row's sort key forward.\n" +
        "SELECT … FROM t WHERE (created_at, id) < ($1, $2)\n" +
        " ORDER BY created_at DESC, id DESC LIMIT 20;",
    });
  }

  if (inCode(mask, /\bSELECT\s+DISTINCT\b/i)) {
    out.push({
      id: "select-distinct",
      severity: "low",
      title: "DISTINCT has to sort or hash the whole result",
      object: "the select list",
      detail:
        "It is worth checking whether the duplicates are real or whether a join is " +
        "multiplying rows. When it is the join, DISTINCT hides the cause and pays " +
        "for it on every run; EXISTS keeps the filter without the extra rows.",
      fix:
        "-- If the duplicates come from a join used only as a filter:\n" +
        "SELECT … FROM a WHERE EXISTS (SELECT 1 FROM b WHERE b.a_id = a.id);",
    });
  }

  if (inCode(mask, /\bCOUNT\s*\(\s*\*\s*\)/i) && !inCode(mask, /\bWHERE\b/i)) {
    out.push({
      id: "unfiltered-count",
      severity: "low",
      title: "Counting every row means reading every row",
      object: "the COUNT(*)",
      detail:
        "PostgreSQL has no stored row count, because two sessions can legitimately " +
        "disagree about how many rows exist. An unfiltered COUNT(*) therefore walks " +
        "the whole table every time it is asked.",
      fix:
        "-- Good enough for \"about how many\", and instant:\n" +
        "SELECT reltuples::bigint AS approx_rows\n" +
        "  FROM pg_class WHERE oid = 'your_table'::regclass;",
    });
  }

  if (inCode(mask, /^\s*(?:UPDATE|DELETE)\b/i) && !inCode(mask, /\bWHERE\b/i)) {
    out.push({
      id: "write-without-where",
      severity: "high",
      title: "This statement has no WHERE clause",
      object: "the statement",
      detail:
        "As written it applies to every row in the table. Analysing it here is " +
        "safe — the plan is taken inside a read-only transaction that is rolled " +
        "back — but running it anywhere else would not be.",
      fix: "",
    });
  }

  return sortFindings(out);
}

/** {high, medium, low, total} across any list of findings. */
export function summarizeFindings(findings: QueryFinding[]): {
  high: number;
  medium: number;
  low: number;
  total: number;
} {
  return {
    high: findings.filter((f) => f.severity === "high").length,
    medium: findings.filter((f) => f.severity === "medium").length,
    low: findings.filter((f) => f.severity === "low").length,
    total: findings.length,
  };
}
