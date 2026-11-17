# Performance advice

Reads a schema's structure, and PostgreSQL's own statistics when the database
can be reached, and says what would make it faster. Every finding states a cost
and a fix.

Import it from outside as `@/lib/performance/advice`. That resolves to
`index.ts`, which only re-exports the public names. Files inside this folder
import each other directly and never through `index.ts`.

## The two halves

1. `analyzeSchemaPerformance` looks only at a snapshot, so it works on a stored
   baseline when the database is down.
2. `analyzeTableStats` looks at the live counters, which say what has really
   happened on the server.

## Files

| File | What it holds |
| --- | --- |
| `index.ts` | The public face. Re-exports only. |
| `types.ts` | `PerfAdvice`, `AdviceItem`, `AdviceView`, `sortAdvice`, `summarizeAdvice`, the time limits. |
| `pg-text.ts` | Reading index definitions, defaults and type names as PostgreSQL prints them. |
| `table-facts.ts` | Facts several rules share: covered columns, `foreignKeyIndexes`, `relationNames`. |

### Rules that read the structure

| File | What it holds |
| --- | --- |
| `schema-rules.ts` | `analyzeSchemaPerformance`: every rule that reads a snapshot. |
| `primary-key-fix.ts` | The fix for a table with no primary key. |
| `duplicate-indexes.ts` | Grouping duplicate indexes and writing the fix that drops the copies. |
| `serial-fix.ts` | The fix that turns a serial column into an identity column. |
| `partitioning.ts` | `analyzePartitioning`: when a large table is worth partitioning. |

### Rules that read the statistics

| File | What it holds |
| --- | --- |
| `stats-types.ts` | `TableStats`, `WaitingPartition`, `IndexStats`: rows from the statistics views. |
| `table-stats.ts` | `analyzeTableStats`: every rule that reads the live counters. |
| `invalid-index.ts` | The finding for an index PostgreSQL has marked invalid. |
| `partitioned-index.ts` | The finding for a partitioned index that was never finished. |

### After the rules

| File | What it holds |
| --- | --- |
| `combine.ts` | `attachForeignKeyIndexes`, `withoutRepeatedDrops`: tidy both passes together. |
| `errors.ts` | `describeStatsError`, `describeStructureError`: why a pass failed, in words. |

## Where to start

To add a rule about structure, read `schema-rules.ts`. To add a rule about the
statistics, read `table-stats.ts`. The tests are in `tests/perf-advice.test.ts`.
