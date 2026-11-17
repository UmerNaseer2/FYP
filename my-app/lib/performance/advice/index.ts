/**
 * Performance advice read out of a schema's structure, and out of PostgreSQL's
 * own statistics when the database is reachable.
 *
 * Two halves, kept apart on purpose:
 *
 *   • `analyzeSchemaPerformance` looks only at a snapshot. It therefore works
 *     against a STORED baseline, which means the Performance screen still has
 *     something to say about a database that is down, and means every rule here
 *     is a pure function that a unit test can pin down exactly.
 *
 *   • `analyzeTableStats` looks at pg_stat_user_tables / pg_stat_user_indexes,
 *     which describe what has actually happened on the server rather than what
 *     the schema allows. Those rules cannot be derived from structure at all —
 *     no snapshot can tell you an index has never been used.
 *
 * Every rule states a cost and a fix. A finding a reader cannot act on is not
 * advice, it is a complaint, so nothing here reports a fact ("this table has 9
 * indexes") without saying what it costs and what to do instead.
 *
 * Every fix also says what kind of thing it is (FixKind, in lib/performance/sql.ts):
 * a schema change comes with the statements that undo it, maintenance is run
 * by hand, and a choice only a person can make is set out as comments, so
 * pasting it runs nothing. SQL that is meant to run names every object quoted
 * and schema-qualified, so it means the same thing whatever the search_path of
 * the person pasting it, and never contains a placeholder to fill in.
 *
 * Deliberately conservative about missing information: an optional collection
 * that a snapshot never recorded means the rule that needs it is SKIPPED for
 * that table, not answered with a guess. Reporting "no index supports this
 * foreign key" because the snapshot predates index capture would be worse than
 * saying nothing.
 *
 * This file is only the public face of the folder: it re-exports the names the
 * rest of the app imports from "@/lib/performance/advice". The code lives in the
 * files next to it, and README.md lists what each one holds. Files in this
 * folder import each other directly, never through this file.
 */

export {
  sortAdvice,
  summarizeAdvice,
  STATS_STATEMENT_TIMEOUT_MS,
  STATS_LOCK_TIMEOUT_MS,
  STRUCTURE_LOCK_TIMEOUT_MS,
} from "./types";
export type { AdviceSeverity, PerfAdvice, AdviceItem, AdviceView } from "./types";
export { foreignKeyIndexes, relationNames } from "./table-facts";
export type { ForeignKeyIndexes } from "./table-facts";
export { analyzeSchemaPerformance } from "./schema-rules";
export type { TableStats, WaitingPartition, IndexStats } from "./stats-types";
export { analyzeTableStats } from "./table-stats";
export { attachForeignKeyIndexes, withoutRepeatedDrops } from "./combine";
export { describeStatsError, describeStructureError } from "./errors";
export {
  PARTITION_CANDIDATE_ROWS,
  DEAD_ROW_RATIO_DEFAULT,
  analyzePartitioning,
} from "./partitioning";
