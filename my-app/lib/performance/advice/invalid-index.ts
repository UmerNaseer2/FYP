// Performance advice: an index PostgreSQL has marked invalid.
//
// Holds invalidIndexAdvice, the finding and fix for an index whose build
// stopped part of the way through.

import type { PerfAdvice } from "./types";
import { comment } from "./pg-text";
import { REINDEX_LEFTOVER } from "./duplicate-indexes";
import type { IndexStats } from "./stats-types";

/**
 * An index PostgreSQL has marked invalid: queries never use it, and writes
 * can still be paying to keep it up to date.
 *
 * A name ending _ccnew or _ccold is a copy made by REINDEX CONCURRENTLY, left
 * behind when it did not finish; PostgreSQL's own advice for those is to drop
 * them. Any other invalid index is a build that failed or is still running,
 * and rebuilding it is maintenance.
 *
 * The DROP of a leftover copy is maintenance too, not a change: the copy
 * exists only on this server, so saved as a migration the same DROP would
 * fail on every other database the migration ran on.
 *
 * Either way the index may belong to a build that is still running right
 * now, which looks exactly the same in the catalog. So every fix starts with
 * the query that tells the two apart, before any statement that would break
 * into the running build. Only a CONCURRENTLY build shows up that way: a plain
 * CREATE INDEX is not visible to anyone else until it has finished.
 */
export function invalidIndexAdvice(index: IndexStats, name: string): PerfAdvice {
  const base = {
    id: "invalid-index",
    severity: "medium" as const,
    title: "Index is invalid, so queries never use it",
    object: `${index.table_name}.${index.index_name}`,
  };
  const cost =
    `The planner never uses an invalid index, but writes to ${index.table_name} ` +
    `can still be paying to keep it up to date.`;
  // relid::regclass prints the table's name, where SELECT * would print only
  // numbers. The WHERE keeps out builds in other databases on the server,
  // whose numbers mean nothing here.
  const stillRunning =
    `-- An index is also marked invalid while CREATE INDEX CONCURRENTLY or REINDEX\n` +
    `-- CONCURRENTLY is still building it. Check first that its table is not in the\n` +
    `-- list this prints:\n` +
    `-- SELECT relid::regclass AS table_name, command, phase\n` +
    `-- FROM pg_stat_progress_create_index WHERE datname = current_database();\n`;
  const leftover = REINDEX_LEFTOVER.exec(index.index_name);
  if (leftover) {
    return {
      ...base,
      detail:
        `This is a copy that REINDEX CONCURRENTLY makes while it rebuilds an index, ` +
        `left behind because the rebuild stopped part-way. ${cost}`,
      // Run by hand on this server only; see the note above.
      fixKind: "maintenance",
      fix:
        stillRunning +
        (leftover[1] === "new"
          ? `-- If it is not, the rebuild stopped before this copy was ready, and the\n` +
            `-- original index is still in place under its own name. Drop the copy, then\n` +
            `-- run the REINDEX again if needed.\n`
          : `-- If it is not, the rebuild finished but could not remove the old copy,\n` +
            `-- which this is. The rebuilt index is in place under the original name, so\n` +
            `-- this can go.\n`) +
        `DROP INDEX ${name};`,
    };
  }
  return {
    ...base,
    detail:
      `PostgreSQL has marked this index invalid, which usually means a CREATE INDEX ` +
      `CONCURRENTLY or REINDEX CONCURRENTLY stopped part-way: cancelled, or failed on ` +
      `a duplicate value. ${cost}`,
    fixKind: "maintenance",
    fix:
      stillRunning +
      `-- If it is not, rebuild it.\n` +
      (index.is_unique
        ? // Checked on PostgreSQL 17: the REINDEX fails with "could not
          // create unique index", naming the duplicated key and its value.
          `-- It is a unique index, so if two rows share a value the rebuild stops with an\n` +
          `-- error naming that value. Fix those rows first.\n`
        : "") +
      `REINDEX INDEX ${name};\n` +
      `-- On a busy table, run REINDEX INDEX CONCURRENTLY instead, outside a transaction.\n` +
      `-- If nothing needs the index, drop it instead:\n` +
      comment`-- DROP INDEX ${name};`,
  };
}
