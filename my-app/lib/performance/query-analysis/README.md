# Query analysis

Reads a PostgreSQL `EXPLAIN` plan, and the text of the query, and says what is
wrong with them. Every function here is pure: nothing opens a connection, so
the same code runs in a test, in a route and in the browser.

Import it from outside as `@/lib/performance/query-analysis`. That resolves to
`index.ts`, which only re-exports the public names. Files inside this folder
import each other directly and never through `index.ts`.

## The three parts

1. **The gate** decides whether a query may be analysed at all.
2. **The plan** is read by `readPlan()`: what this server would really do.
3. **The query text** is read by `readSql()`: what holds whatever the data is.

## Files

| File | What it holds |
| --- | --- |
| `index.ts` | The public face. Re-exports only. |
| `findings.ts` | The `QueryFinding` type, `sortFindings`, `summarizeFindings`. |
| `wording.ts` | Small helpers that format numbers, lists and comment lines. |

### Part one: the gate

| File | What it holds |
| --- | --- |
| `gate.ts` | `checkAnalysable`, `checkPlanIsReadOnly`, `planMentionsDenied`, `buildExplainSql`. |
| `query-errors.ts` | `toQueryError`, `describeQueryError`: a database error in plain words. |

### Part two: the plan

| File | What it holds |
| --- | --- |
| `plan-types.ts` | `RawPlanNode`, `PlanStep`, `PlanSummary`, `AnalyzeView`. |
| `plan-flatten.ts` | `flattenPlan`: the nested JSON as a flat list of steps. |
| `plan-runs.ts` | `estimateRuns`: how many times each step of an estimated plan runs. |
| `plan-helpers.ts` | Small questions about steps: children, join sides, row totals. |
| `plan-walk.ts` | Walking the step list: rows scanned, subtrees, `readStop`. |
| `catalog.ts` | `PlanCatalog` types, `catalogFromRows`, `planRelations`. |
| `tokens.ts` | The tokenizer for plan conditions. |
| `conditions.ts` | Index thresholds and `filterColumns`: which columns a filter compares. |
| `plan-findings.ts` | `planFindings`: every rule that reads the plan. |
| `memory-fixes.ts` | Fixes for a sort that spilled to disk and a lossy bitmap. |
| `estimate-findings.ts` | Helpers for the wrong row estimate rule. |
| `read-plan.ts` | `planSteps`, `readPlan`, `describePlan`: the way in for a plan. |
| `share.ts` | How heavy a step is, for the tint on the plan tree. |

### The plan in plain words

| File | What it holds |
| --- | --- |
| `plain-condition.ts` | `plainCondition`: a plan condition as readable SQL. |
| `narration-counting.ts` | What a step's row count means, and how to say it. |
| `narration-scans.ts` | Sentences for sequential, index and bitmap scans. |
| `narration-steps.ts` | Sentences for joins, aggregates, sorts and the rest. |
| `explain-in-words.ts` | `explainInWords`, `stepFigures`, `subqueryCaption`. |

### Part three: the query text

| File | What it holds |
| --- | --- |
| `sql-context.ts` | `SqlContext` and `sqlContextFromPlan`: what the plan tells the text rules. |
| `sql-text.ts` | Scanners that find keywords, clauses and tables in the masked text. |
| `sql-rule-parts.ts` | Thresholds and the larger pieces the text rules use. |
| `read-sql.ts` | `readSql`: every rule that reads the query text. |

## Where to start

To add a rule about a plan, read `plan-findings.ts`. To add a rule about the
query text, read `read-sql.ts`. The tests are in `tests/query-analysis.test.ts`.
