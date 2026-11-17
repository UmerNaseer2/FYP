// Spec feature 08 — query execution analysis.
//
// Dependency-free on purpose, like lib/sql/guard.ts and lib/performance/advice/:
// nothing here opens a connection, so the whole module runs in a test, in a
// route handler, and in the browser. The route next door is the only thing
// that talks to a database; it hands the EXPLAIN output in here as plain JSON
// and gets a summary back.
//
// Three parts, kept apart because they answer different questions:
//
//   • The gate     checkAnalysable(), checkPlanIsReadOnly() and friends decide
//                  whether a query may be analysed at all. Only queries that
//                  read data get through, and the route asks these BEFORE it
//                  runs anything for real.
//   • readPlan()   reads what THIS server would actually do with THIS query
//                  against the data it has right now. Correct, and perishable.
//   • readSql()    reads the query text alone. Weaker, but it holds regardless
//                  of what is in the tables, and it still says something when
//                  the database cannot be reached at all.
//
// This file is only the public face of the folder: it re-exports the names
// the rest of the app imports from "@/lib/performance/query-analysis". The code
// lives in the files next to it, and README.md lists what each one holds.
// Files in this folder import each other directly, never through this file.

// FixKind is defined once, in lib/performance/sql.ts, because the Suggestions tab
// uses it too. Re-exported so existing imports from this file keep working.
export type { FixKind } from "../sql";

export { sortFindings, summarizeFindings } from "./findings";
export type { Severity, QueryFinding } from "./findings";
export {
  MAX_QUERY_LENGTH,
  QUERY_TIMEOUT_SECONDS,
  serverActingCallIn,
  checkAnalysable,
  checkPlanIsReadOnly,
  planMentionsDenied,
  explainPrefix,
  buildExplainSql,
} from "./gate";
export { toQueryError, describeQueryError } from "./query-errors";
export type { QueryError } from "./query-errors";
export type { RawPlanNode, PlanStep, PlanSummary, AnalyzeMode, AnalyzeView } from "./plan-types";
export { catalogFromRows, planRelations } from "./catalog";
export type {
  TableRows,
  CatalogColumn,
  CatalogIndex,
  PlannerSettings,
  PlanCatalog,
  CatalogRows,
} from "./catalog";
export {
  SELECTIVE_SHARE,
  JOIN_SMALL_SIDE_SHARE,
  JOIN_OUTPUT_SHARE,
  filterColumns,
} from "./conditions";
export { planSteps, readPlan, describePlan } from "./read-plan";
export { shareBand, shareText, heaviestStepLabel, shareLegend } from "./share";
export type { ShareBand } from "./share";
export { explainInWords, stepFigures, subqueryCaption } from "./explain-in-words";
export type { StepFigures } from "./explain-in-words";
export { sqlContextFromPlan } from "./sql-context";
export type { SqlContextTable, SqlContext } from "./sql-context";
export { SMALL_RESULT_ROWS, MANY_JOINS, DEFAULT_PLANNER_SETTINGS } from "./sql-rule-parts";
export { readSql } from "./read-sql";
