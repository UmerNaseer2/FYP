// Query analysis: what the plan tells the text rules.
//
// Holds the SqlContext types and sqlContextFromPlan, which gathers the facts
// from a plan that readSql needs to judge the query text.

import { maskNonCode } from "../../sql/guard";
import type { PlanStep, PlanSummary } from "./plan-types";
import { detailValue, rowsHandedOn, totalActualRows } from "./plan-helpers";
import type { PlanCatalog, PlannerSettings } from "./catalog";
import { childrenOfStep } from "./plan-walk";
import { type Token, tokenize } from "./tokens";
import { columnTypesFor, readsManyKeepsFew } from "./conditions";

// ── What the plan tells the text rules ───────────────────────────────────────

/** One table the plan reads, as the text rules need it. */
export type SqlContextTable = {
  /** Null when the plan was taken without VERBOSE and gave no schema. */
  schema: string | null;
  name: string;
  /** The name the query gave it ("o" in `FROM orders o`), or null. */
  alias: string | null;
  /**
   * Roughly how many rows the table holds: the catalog's count, or what a
   * whole-table read of it handed on, whichever is larger (the fresher one).
   */
  rows: number;
  /** The step's Filter, verbatim, or null. */
  filter: string | null;
  /**
   * True when the step reads every row of the table: a sequential or index
   * scan with no Filter and no index condition to narrow it.
   */
  readsAll: boolean;
  /**
   * True when every row this step hands on goes straight into one total with
   * no GROUP BY and no HAVING, as in `SELECT count(*) FROM orders`. False
   * when something between the two caps, groups, joins or filters the rows:
   * a count over `(SELECT * FROM orders LIMIT 10)` is of ten rows.
   */
  feedsPlainAggregate: boolean;
  /**
   * True when the plan reads this table in full to keep a small share of it,
   * judged as the seq-scan rule judges it: where an index on what the Filter
   * compares would pay.
   */
  selectiveScan: boolean;
  /**
   * The condition an index answers for this step, verbatim: an index scan's
   * Index Cond, or a bitmap heap scan's Recheck Cond. Null when no index
   * narrows the read.
   */
  indexCond: string | null;
  /** Column name → type, from the catalog. Empty when unknown. */
  columnTypes: Record<string, string>;
};

/**
 * What the plan and the catalog say about a query that its text cannot:
 * how many rows come back, how big each table is, which columns are primary
 * keys, and how hard the planner tries with many joins.
 *
 * The route builds it with sqlContextFromPlan and hands it to readSql, so a
 * text rule can judge the query by its real size rather than its shape alone.
 * Every rule works without one, taking its quietest reading.
 */
export type SqlContext = {
  /** Rows the query returns: counted when it ran, else the planner's estimate. */
  expectedRows: number;
  /** True when the query actually ran, so expectedRows was counted. */
  measured: boolean;
  /** Every table the plan reads, once per name it is read under. */
  tables: SqlContextTable[];
  /**
   * The most tables one level of the query joins together (see
   * mostTablesInOneLevel). The planner orders the joins of one level at a
   * time, so a subquery it runs on its own and each branch of a UNION,
   * INTERSECT or EXCEPT are counted apart, and a partitioned table counts
   * once.
   */
  joinedTables: number;
  /** What the top step hands back, one entry per column, as the plan writes it. */
  outputColumns: string[];
  /** Primary-key columns per table, keyed "schema.table". */
  primaryKeys: Record<string, string[]>;
  /** The planner's join settings, or null when they could not be read. */
  settings: PlannerSettings | null;
  /** The top step's type, below any Limit or Sort: "Aggregate", "Unique", … */
  topNodeType: string | null;
  /**
   * Rows into and out of a DISTINCT at the top of the plan, when the query
   * ran and no LIMIT above it cut the run short.
   */
  distinctRows: { input: number; output: number } | null;
  /**
   * True when a step can hand on one row of a table more than once: any join
   * (a join to generate_series or a VALUES list reads no table, so the table
   * count misses it), or a set-returning function in the select list
   * (`unnest(tags)`), which the plan shows as a ProjectSet step.
   */
  repeatsRows: boolean;
  /** Every relation name in each schema, for naming a new index. */
  relationNames: Record<string, string[]>;
};

/** Steps that only reorder or cut the result, and say nothing about its shape. */
const RESULT_ORDER_NODES: ReadonlySet<string> = new Set(["Limit", "Sort", "Incremental Sort"]);

/**
 * Scans that read every row of a table when nothing narrows them. A Sample
 * Scan (TABLESAMPLE) reads only part of one, and a bitmap scan always has a
 * condition.
 */
const WHOLE_TABLE_SCANS: ReadonlySet<string> = new Set(["Seq Scan", "Index Scan", "Index Only Scan"]);

/** Steps that can hand on one input row more than once. */
const REPEATING_STEPS: ReadonlySet<string> = new Set([
  "Nested Loop",
  "Hash Join",
  "Merge Join",
  "ProjectSet",
]);

/** The step feeding this one: its Outer input, or its only one. */
function mainInput(steps: PlanStep[], step: PlanStep): PlanStep | undefined {
  const children = childrenOfStep(steps, step);
  return children.find((c) => c.parentRelationship === "Outer") ?? children[0];
}

/**
 * Steps that hand on every row they get, once each: a Gather collects the
 * parallel helpers' rows, a Sort or a Materialize reorders or keeps them, and
 * a Subquery Scan or a Result passes them up. Only with no filter of their
 * own, which feedsPlainAggregate checks.
 */
const ROW_KEEPING_STEPS: ReadonlySet<string> = new Set([
  "Gather",
  "Gather Merge",
  "Sort",
  "Incremental Sort",
  "Materialize",
  "Subquery Scan",
  "Result",
]);

/**
 * True when every row this step hands on reaches one total over all of them:
 * an Aggregate with no GROUP BY and no HAVING, with only row-keeping steps
 * between the two.
 *
 * `SELECT count(*) FROM (SELECT * FROM orders LIMIT 10) s` reads orders with
 * no filter, but a Limit sits between the scan and the count, so the count is
 * ten, not the table's size. A GROUP BY, a DISTINCT or a join in between
 * changes what is counted the same way. In a parallel plan each helper adds
 * up its own share first (a "Partial" aggregate) and the step above the
 * Gather finishes the total, so the walk goes on up to that one.
 */
function feedsPlainAggregate(steps: PlanStep[], step: PlanStep): boolean {
  let current = step;
  while (current.parentId !== null) {
    // A subquery's rows go to the step that asked for them, not up the tree:
    // a WITH query's LIMIT, say, above a scan that a CTE Scan then reads.
    if (current.parentRelationship === "InitPlan" || current.parentRelationship === "SubPlan") {
      return false;
    }
    const parent = steps[current.parentId];
    if (parent.nodeType === "Aggregate") {
      // A HAVING is the Filter of the step that finishes the total.
      if (parent.strategy !== "Plain" || parent.filter !== null) return false;
      if (parent.partialMode !== "Partial") return true;
    } else if (
      !ROW_KEEPING_STEPS.has(parent.nodeType) ||
      parent.filter !== null ||
      detailValue(parent, "One-Time Filter") !== null
    ) {
      return false;
    }
    current = parent;
  }
  return false;
}

/**
 * "o.id, lower((o.email)::text), 'a, b'::text" → its three entries.
 * Splits at commas outside brackets and quotes.
 */
export function splitOutputList(output: string): string[] {
  const entries: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < output.length; i += 1) {
    const ch = output[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "(" || ch === "[") {
      depth += 1;
    } else if (ch === ")" || ch === "]") {
      depth -= 1;
    } else if (ch === "," && depth === 0) {
      entries.push(output.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = output.slice(start).trim();
  if (last !== "") entries.push(last);
  return entries;
}

/**
 * The columns the select-star fix lists, or [] to ask for them in words.
 *
 * The plan's Output says what the top of the query hands back. When the
 * query reads its tables directly, each entry is a column as the query can
 * write it: id, or o.id in a join. Through a view or a subquery in FROM it is
 * what the column is worked out from instead: a column of a table the query
 * never names, or an expression such as pg_cancel_backend(0). The name the
 * view or subquery gives the column is not in the plan at all, and putting
 * those entries in place of the * would not run. So the list is offered only
 * when every entry is a plain column, of a table the query itself names
 * outside any brackets.
 */
export function starColumns(sql: string, context: SqlContext | undefined): string[] {
  const columns = context?.outputColumns ?? [];
  if (context === undefined || columns.length === 0) return [];

  // Every name the query writes outside brackets, as the server knows it:
  // an unquoted name folds to lower case, a quoted one keeps its own.
  const topNames = new Set<string>();
  let depth = 0;
  for (const token of tokenize(maskNonCode(sql, { keepQuotedNames: true }))) {
    if (token.text === "(") depth += 1;
    else if (token.text === ")") depth -= 1;
    else if (depth === 0 && token.kind === "ident") topNames.add(token.text.toLowerCase());
    else if (depth === 0 && token.kind === "qident") topNames.add(token.text);
  }

  const tablesNamed = context.tables.every(
    (table) => topNames.has(table.name) || (table.alias !== null && topNames.has(table.alias))
  );
  const isName = (token: Token) => token.kind === "ident" || token.kind === "qident";
  const allPlain = columns.every((entry) => {
    const t = tokenize(entry);
    if (t.length === 1) return isName(t[0]);
    return (
      t.length === 3 && isName(t[0]) && t[1].text === "." && isName(t[2]) && topNames.has(t[0].text)
    );
  });
  return tablesNamed && allPlain ? columns : [];
}

/**
 * How a step can start a query level of its own, by its Parent Relationship:
 * a subquery run on its own (InitPlan, SubPlan; a CTE is one too), one input
 * of an Append (a branch of a UNION, or one partition of a table), and the
 * subquery a Subquery Scan reads.
 */
const OWN_LEVEL_EDGES: ReadonlySet<string> = new Set(["InitPlan", "SubPlan", "Member", "Subquery"]);

/**
 * Steps whose every input is a query level of its own: a SetOp's (INTERSECT
 * or EXCEPT), and the two parts of a WITH RECURSIVE.
 */
const OWN_LEVEL_INPUTS: ReadonlySet<string> = new Set(["SetOp", "Recursive Union"]);

/**
 * Steps PostgreSQL puts only at the top of a query level. Under a join, one
 * is a subquery in FROM whose Subquery Scan the planner dropped as doing
 * nothing, so what it reads is a level of its own too.
 */
const LEVEL_TOPS: ReadonlySet<string> = new Set(["Limit", "WindowAgg", "ProjectSet"]);

/**
 * Steps a join reads like one table, whatever is behind them: an Append (a
 * partitioned table, or a UNION ALL), a subquery, a CTE, a function, a
 * VALUES list, or the rows so far of a WITH RECURSIVE.
 */
const TABLE_LIKE_STEPS: ReadonlySet<string> = new Set([
  "Append",
  "Merge Append",
  "Subquery Scan",
  "CTE Scan",
  "Function Scan",
  "Table Function Scan",
  "Values Scan",
  "WorkTable Scan",
]);

/**
 * The most tables one query level of the plan joins together.
 *
 * The planner orders the joins of one level at a time. A level starts at
 * the top of the plan, at a step whose Parent Relationship is in
 * OWN_LEVEL_EDGES, and under a step in OWN_LEVEL_INPUTS or LEVEL_TOPS. In a
 * level each table read counts once, and so does each step in
 * TABLE_LIKE_STEPS or LEVEL_TOPS, which the level reads like one table.
 *
 * A grouped or DISTINCT subquery in FROM whose Subquery Scan was dropped is
 * counted with the level around it. PostgreSQL plans an IN (SELECT …) whose
 * rows it first makes unique in the same shape, and there the subquery's
 * tables do belong to the level around it.
 */
function mostTablesInOneLevel(steps: PlanStep[]): number {
  // A level is known by the id of the step it starts at. Steps come parent
  // first, so a step's parent always has its level already.
  const levelOf: number[] = [];
  const tablesIn = new Map<number, Set<string>>();
  for (const step of steps) {
    const parent = step.parentId === null ? undefined : steps[step.parentId];
    const level =
      parent === undefined ||
      OWN_LEVEL_EDGES.has(step.parentRelationship ?? "") ||
      OWN_LEVEL_INPUTS.has(parent.nodeType) ||
      LEVEL_TOPS.has(parent.nodeType)
        ? step.id
        : levelOf[parent.id];
    levelOf[step.id] = level;
    const table =
      step.relation !== null
        ? JSON.stringify([step.relationSchema, step.relation, step.alias])
        : TABLE_LIKE_STEPS.has(step.nodeType) || LEVEL_TOPS.has(step.nodeType)
          ? `step ${step.id}`
          : null;
    if (table === null) continue;
    const tables = tablesIn.get(level) ?? new Set<string>();
    tables.add(table);
    tablesIn.set(level, tables);
  }
  return Math.max(0, ...Array.from(tablesIn.values(), (tables) => tables.size));
}

/**
 * Gather what the text rules can use from a plan the route has already read.
 *
 * Pure: everything comes from `plan` and `catalog`, so it runs in a test the
 * same way it runs in the route, and adds no query against the server.
 */
export function sqlContextFromPlan(
  plan: PlanSummary,
  catalog: Partial<PlanCatalog> = {}
): SqlContext {
  const steps = plan.steps;
  const head = steps[0];
  const tableRows = catalog.tableRows ?? {};

  const tables: SqlContextTable[] = [];
  const seen = new Set<string>();
  for (const step of steps) {
    if (step.relation === null) continue;
    const key = JSON.stringify([step.relationSchema, step.relation, step.alias]);
    if (seen.has(key)) continue;
    seen.add(key);
    const known =
      step.relationSchema === null ? undefined : tableRows[`${step.relationSchema}.${step.relation}`];
    // A whole-table read with no filter hands on every row it reads, so
    // what it handed on is the table's size, and fresher than the catalog.
    const wholeTable = step.nodeType === "Seq Scan" && step.filter === null;
    const handedOn = rowsHandedOn(step) ?? step.estimatedRows;
    tables.push({
      schema: step.relationSchema,
      name: step.relation,
      alias: step.alias,
      rows: wholeTable ? Math.max(known ?? 0, handedOn) : (known ?? step.estimatedRows),
      filter: step.filter,
      // joinCond holds an index scan's Index Cond, which narrows it too.
      readsAll: WHOLE_TABLE_SCANS.has(step.nodeType) && step.filter === null && step.joinCond === null,
      feedsPlainAggregate: feedsPlainAggregate(steps, step),
      selectiveScan: readsManyKeepsFew(step, tableRows),
      // A bitmap heap scan keeps its index's condition as the Recheck Cond.
      indexCond: step.joinCond ?? detailValue(step, "Recheck Cond"),
      columnTypes: columnTypesFor(catalog, step.relationSchema, step.relation),
    });
  }

  const primaryKeys: Record<string, string[]> = {};
  for (const [key, indexes] of Object.entries(catalog.indexes ?? {})) {
    const primary = indexes.find((index) => index.primary);
    if (!primary) continue;
    const columns = primary.columns.filter((c): c is string => c !== null);
    if (columns.length > 0 && columns.length === primary.columns.length) primaryKeys[key] = columns;
  }

  let top: PlanStep | undefined = head;
  let limited = false;
  while (top !== undefined && RESULT_ORDER_NODES.has(top.nodeType)) {
    if (top.nodeType === "Limit") limited = true;
    top = mainInput(steps, top);
  }

  // Rows in and out of a top-level DISTINCT, which PostgreSQL runs as a
  // Unique step or as a grouping Aggregate. Not across a Gather: the
  // parallel workers below it may already have dropped duplicates, and the
  // two counts would then match even though DISTINCT did real work.
  let distinctRows: SqlContext["distinctRows"] = null;
  const groups =
    top !== undefined &&
    (top.nodeType === "Unique" ||
      (top.nodeType === "Aggregate" && detailValue(top, "Group Key") !== null));
  // Nor under a LIMIT, which stops the DISTINCT once it has enough rows: its
  // counts then cover only the rows read up to that point.
  if (plan.measured && !limited && top !== undefined && groups) {
    const input = mainInput(steps, top);
    const inRows = input === undefined ? null : totalActualRows(input);
    const outRows = totalActualRows(top);
    const gathered = input !== undefined && input.nodeType.startsWith("Gather");
    if (inRows !== null && outRows !== null && !gathered) {
      distinctRows = { input: inRows, output: outRows };
    }
  }

  return {
    expectedRows: plan.measured ? (head ? totalActualRows(head) ?? 0 : 0) : plan.estimatedRows,
    measured: plan.measured,
    tables,
    joinedTables: mostTablesInOneLevel(steps),
    outputColumns: head ? splitOutputList(head.output) : [],
    primaryKeys,
    settings: catalog.settings ?? null,
    topNodeType: top?.nodeType ?? null,
    distinctRows,
    repeatsRows: steps.some((step) => REPEATING_STEPS.has(step.nodeType)),
    relationNames: catalog.relationNames ?? {},
  };
}
