// Performance advice: the rules that read PostgreSQL's statistics.
//
// Holds analyzeTableStats, one long function with a rule per problem the
// live counters can show, and the small wording helpers it uses.

import { LARGE_TABLE_ROWS, qualifiedName } from "../sql";
import { type PerfAdvice, sortAdvice } from "./types";
import { comment, indexDefinitionSql, parseIndexDefinition } from "./pg-text";
import type { ForeignKeyIndexes } from "./table-facts";
import type { IndexStats, TableStats } from "./stats-types";
import { invalidIndexAdvice } from "./invalid-index";
import { unfinishedPartitionedIndexAdvice } from "./partitioned-index";
import { DEAD_ROW_RATIO_DEFAULT } from "./partitioning";

/** Render a byte count the way a person would say it. */
function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * "3 Aug 2026", in UTC with fixed month names: the same text on every server
 * and in every test, whatever locale or time zone the process runs in.
 */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatDay(date: Date): string {
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** "1 day", "12 days"; "less than a day" for zero. */
function dayCount(days: number): string {
  if (days < 1) return "less than a day";
  return days === 1 ? "1 day" : `${days.toLocaleString()} days`;
}

/** "Less than a day" from "less than a day": for a sentence that starts with it. */
function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** How many days a server's counters have to cover before "unused" is worth acting on. */
const UNUSED_INDEX_MIN_DAYS = 30;

/**
 * Examples of jobs that run less often than every `days` days, to put in
 * brackets after that phrase; "" once no common one does. Only jobs rarer
 * than the span can have been missed by the counters: after 200 days a
 * quarterly report has run at least twice and would have used the index.
 */
function rarerJobs(days: number): string {
  if (days < 90) return " (a quarterly report, a yearly job)";
  if (days < 365) return " (a yearly job, say)";
  return "";
}

/**
 * Rules that need the server's counters rather than the schema.
 *
 * Every threshold below has a floor on table size as well as a ratio, because
 * a ratio over a nearly empty table says nothing: a hundred sequential scans of
 * a twelve-row lookup table is the correct plan, not a problem.
 *
 * `countersSince` is a moment the counters are known to have been counting
 * from (the route takes the latest of every timestamp that marks them
 * starting again), or null when the server does not say. They may reach
 * further back, never less far, so "not used in the N days since then" stays
 * true. It decides how far "this index has not been used" can be trusted.
 * `now` is passed in, not read, so a test can pin every sentence.
 * `foreignKeys` comes from the snapshot (see foreignKeyIndexes): an unused
 * index that is the last one a foreign key can be checked through gets a
 * decision to keep it, never a DROP.
 */
export function analyzeTableStats(
  schema: string,
  tables: TableStats[],
  indexes: IndexStats[],
  countersSince: string | null,
  now: Date,
  foreignKeys: ForeignKeyIndexes[] = [],
  deadRowRatio: number = DEAD_ROW_RATIO_DEFAULT
): PerfAdvice[] {
  const advice: PerfAdvice[] = [];

  for (const t of tables) {
    const reads = t.seq_scan + t.idx_scan;
    const target = qualifiedName(schema, t.table_name);
    // Rows per sequential scan. A scan that stops early (a LIMIT, an EXISTS)
    // is counted as a sequential scan too, so without this the title below
    // could be claimed of a table whose scans each read a handful of rows.
    const rowsPerScan = t.seq_scan > 0 ? t.seq_tup_read / t.seq_scan : 0;

    // LARGE_TABLE_ROWS is shared with the Analyse tab, so the two tabs agree on
    // which tables are big enough for a whole-table read to matter.
    if (
      t.n_live_tup >= LARGE_TABLE_ROWS &&
      t.seq_scan > 100 &&
      t.seq_scan > t.idx_scan * 10 &&
      rowsPerScan >= LARGE_TABLE_ROWS
    ) {
      advice.push({
        id: "sequential-scan-heavy",
        severity: "high",
        title: "Almost every read of this table is a sequential scan",
        object: t.table_name,
        detail:
          `${t.seq_scan.toLocaleString()} reads went through the table row by row ` +
          `(sequential scans), each covering about ` +
          `${Math.round(rowsPerScan).toLocaleString()} rows, against ` +
          `${t.idx_scan.toLocaleString()} that used an index; the table holds about ` +
          `${t.n_live_tup.toLocaleString()} rows. At that size, a query that wants only ` +
          `a few of the rows would use an index if one matched its WHERE clause. So ` +
          `unless these reads really need most of the table (a report, an export), ` +
          `some query is filtering on something no index matches.`,
        fixKind: "decision",
        fix:
          "-- Which index would help depends on the queries, and the counters do not\n" +
          "-- record those. Run the ones that read this table through \"Analyse a\n" +
          "-- query\" on this screen: its plan names the filter no index could serve.",
        action: {
          label: "Analyse a query on this table",
          href: `/performance?tab=analyse&table=${encodeURIComponent(`${schema}.${t.table_name}`)}`,
        },
      });
    }

    if (t.n_live_tup >= 1_000 && t.n_dead_tup > t.n_live_tup * deadRowRatio) {
      advice.push({
        id: "dead-tuples",
        severity: "medium",
        title: "Many dead rows are waiting to be cleaned up",
        object: t.table_name,
        detail:
          `${t.n_dead_tup.toLocaleString()} dead row versions against ` +
          `${t.n_live_tup.toLocaleString()} live ones. A dead row version is what an ` +
          `UPDATE or DELETE leaves behind until VACUUM clears it. Until then it still ` +
          `takes up space, so every whole-table read goes through it and throws it away.`,
        fixKind: "maintenance",
        fix:
          `-- Frees the dead rows' space for reuse without blocking reads or writes. Run\n` +
          `-- it by hand: VACUUM cannot run inside a transaction.\n` +
          `VACUUM (ANALYZE) ${target};\n` +
          `-- If it comes back, autovacuum is not keeping up with the writes to this\n` +
          `-- table. By default it waits until the dead rows number a fifth of the live\n` +
          `-- ones; to make it start sooner on this table, save this as a migration:\n` +
          comment`-- ALTER TABLE ${target} SET (autovacuum_vacuum_scale_factor = 0.05);`,
      });
    }

    // Both checks, because either alone can be wrong: a statistics reset or a
    // crash forgets when ANALYZE last ran but keeps what it collected, and an
    // ANALYZE of a table that was empty at the time collects nothing.
    if (t.last_analyzed === null && !t.has_statistics && t.n_live_tup >= 1_000) {
      advice.push({
        id: "never-analyzed",
        severity: "medium",
        title: "The planner has no statistics for this table",
        object: t.table_name,
        detail:
          "The server holds no statistics on this table's columns and no record of " +
          "ANALYZE running on it, by hand or by autovacuum. The planner is " +
          "estimating how many rows each filter keeps from built-in defaults, so " +
          "every plan over this table is a guess, and joins are where that goes worst.",
        fixKind: "maintenance",
        // "Nothing" would overclaim: ANALYZE waits for, and holds up, a
        // CREATE INDEX or ALTER TABLE on the same table. Reads and writes are
        // what the reader cares about, and those carry on.
        fix: "-- Reads a sample of the table, without blocking reads or writes.\n" + `ANALYZE ${target};`,
      });
    }

    const blocks = t.heap_blks_hit + t.heap_blks_read;
    if (blocks >= 10_000 && t.heap_blks_hit / blocks < 0.9 && reads > 0) {
      advice.push({
        id: "low-cache-hit",
        severity: "low",
        title: "Many reads of this table miss the buffer cache",
        object: t.table_name,
        detail:
          // Rounded down, so 89.9% never prints as the 90% it falls short of.
          `Only ${Math.floor((t.heap_blks_hit / blocks) * 100)}% of this table's page ` +
          `reads found the page already in PostgreSQL's buffer cache. Each of the rest ` +
          `was fetched from the operating system, and from disk whenever the system's ` +
          `own cache did not have it either. Below about 90% that usually means the ` +
          `table does not fit in shared_buffers, or the queries reading it touch more ` +
          `of it than they need.`,
        fixKind: "decision",
        fix:
          "-- Narrow what the queries select, or index them so they touch fewer\n" +
          "-- pages. Raising shared_buffers only helps if the working set would then fit.",
      });
    }
  }

  const started = countersSince === null ? null : new Date(countersSince);
  const since = started !== null && !Number.isNaN(started.getTime()) ? started : null;
  const days =
    since === null ? null : Math.floor((now.getTime() - since.getTime()) / 86_400_000);

  // Whether an index is sure to outlast the loop below: one in use, or a
  // unique one, is never offered for DROP by it.
  const byName = new Map(indexes.map((i) => [i.index_name, i]));
  const staysAnyway = (name: string): boolean => {
    const other = byName.get(name);
    return other !== undefined && other.is_valid && (other.idx_scan > 0 || other.is_unique);
  };
  // Names a new index could collide with. Each name suggested below is added,
  // so two findings never suggest the same one.
  const takenNames = new Set([
    ...tables.map((t) => t.table_name),
    ...indexes.map((i) => i.index_name),
  ]);

  for (const index of indexes) {
    // A partitioned table's index is only here when it is not finished (see
    // the route). Checked before the next line, because the index of a
    // partition that is partitioned itself is also a partition's piece.
    if (index.is_partitioned) {
      if (!index.is_valid) {
        advice.push(unfinishedPartitionedIndexAdvice(index, schema, takenNames));
      }
      continue;
    }
    // A partition's piece of a partitioned index cannot be dropped on its own.
    // When it is not finished, neither is the partitioned index it belongs to,
    // and that finding says what to do about this piece.
    if (index.is_partition_child) continue;
    const name = qualifiedName(schema, index.index_name);
    if (!index.is_valid) {
      advice.push(invalidIndexAdvice(index, name));
      continue;
    }
    if (index.idx_scan > 0 || index.is_unique || index.is_primary || index.backs_constraint) {
      continue;
    }

    const size = humanBytes(index.size_bytes);
    const parsed = parseIndexDefinition(index.definition);
    const undo = parsed
      ? indexDefinitionSql(parsed, schema, index.table_name, false)
      : `${index.definition};`;
    const base = {
      id: "unused-index",
      title: "Index has not been used since the counters started",
      object: `${index.table_name}.${index.index_name}`,
    };
    // What the counters cannot vouch for, said on every one of these: "unused"
    // only ever means "unused by anything this server saw".
    const limits =
      ` It takes up ${size}, and writes to ${index.table_name} still have to keep it up to date.` +
      ` These are this server's own counters, so an index used only on a read replica` +
      ` looks unused here.` +
      (since !== null
        ? ` If the index was created after ${formatDay(since)}, it has had less time than that to be used.`
        : "");

    // What the counters say about this index: the first sentence of every
    // version of this finding below.
    const counted =
      since === null || days === null
        ? "No query has used this index since the server's usage counters last " +
          "started, and this server does not say when that was."
        : // "At least since": the route takes the latest moment the counters
          // could have started again, so they may have been running longer,
          // never less.
          `This server's usage counters have been running at least since ${formatDay(since)}, ` +
          `${days < 1 ? "less than a day ago" : `${dayCount(days)} ago`}, ` +
          `and no query has used this index in that time.`;

    // The last index a foreign key can be checked through is kept, at any
    // age. Dropped, it would make every delete from the table the key points
    // at read this whole table, and the foreign-key rule would ask for it back.
    const key = foreignKeys.find(
      (fk) =>
        fk.table === index.table_name &&
        fk.indexes.includes(index.index_name) &&
        !fk.indexes.some((other) => other !== index.index_name && staysAnyway(other))
    );
    if (key) {
      const target = key.referencedTable ?? "the parent table";
      const theKey = `foreign key ${key.name} (on ${key.columns.join(", ")})`;
      // How many other indexes the key could use instead, none of them in use.
      const others = key.indexes.length - 1;
      const which =
        others === 0
          ? `It is also the only index that ${theKey} can be checked through. Without it,`
          : `It is also one of ${key.indexes.length} indexes that ${theKey} can be checked through, ` +
            `and ${others === 1 ? "the other one is not" : "none of the others is"} in use either. ` +
            `Without any of them,`;
      advice.push({
        ...base,
        severity: "low",
        detail:
          `${counted}${limits} ${which} every delete or key update on ${target} has to read ` +
          `all of ${index.table_name}, to check that no row still refers to the row being changed.`,
        fixKind: "decision",
        // With one index it has to stay; with several, any one of them will
        // do, so this one is not needed as long as another stays. The DROP
        // stays last either way: withoutRepeatedDrops reads it there.
        fix:
          others === 0
            ? comment`-- Keep it while rows of ${target} can be deleted or have their key changed.\n` +
              `-- If neither ever happens it can go, though this screen will then suggest\n` +
              `-- an index for the foreign key again:\n` +
              comment`-- DROP INDEX ${name};`
            : `-- Keep at least one of the ${key.indexes.length} indexes the key can be checked through while\n` +
              comment`-- rows of ${target} can be deleted or have their key changed. This one can\n` +
              `-- go as long as another of them stays:\n` +
              comment`-- DROP INDEX ${name};`,
      });
      continue;
    }

    if (since === null || days === null) {
      advice.push({
        ...base,
        severity: "low",
        detail: counted + limits,
        fixKind: "decision",
        fix:
          "-- A statistics reset or a crash starts the counters again, so find out how\n" +
          "-- long they have been running before trusting this. Look again once they\n" +
          "-- cover a full business cycle (a month end, a quarterly report). If it is\n" +
          "-- still unused then:\n" +
          comment`-- DROP INDEX ${name};`,
      });
      continue;
    }

    const long = days >= UNUSED_INDEX_MIN_DAYS;
    const detail = counted + limits;

    advice.push(
      long
        ? {
            ...base,
            severity: "medium",
            detail,
            fixKind: "change",
            fix:
              comment`-- Only if nothing that runs less often than every ${dayCount(days)}` +
              `${rarerJobs(days)} needs it.\n` +
              `DROP INDEX ${name};`,
            undo,
          }
        : {
            ...base,
            severity: "low",
            detail,
            fixKind: "decision",
            fix:
              comment`-- ${capitalized(dayCount(days))} of counting is too short to be sure nothing needs it.\n` +
              `-- Look again once the counters cover a full business cycle (a month end, a\n` +
              `-- quarterly report). If it is still unused then:\n` +
              comment`-- DROP INDEX ${name};`,
          }
    );
  }

  return sortAdvice(advice);
}
