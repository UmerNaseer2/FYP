// Performance advice: when to partition a large table.
//
// Holds analyzePartitioning and the helpers that pick a partition key and
// list what partitioning would cost.

import type { ColumnSnapshot, TableSnapshot } from "../../postgres";
import { countOf } from "../../ui/plural";
import { qualifiedName, quoteIdent } from "../sql";
import type { PerfAdvice } from "./types";
import { literal } from "./pg-text";

// ── Spec feature 9 — "Recommend partitioning strategies for large tables" ────

/**
 * How many rows a table needs before partitioning it is worth suggesting.
 *
 * Deliberately far above LARGE_TABLE_ROWS, which is the point at which a
 * whole-table read starts to hurt. Partitioning is not a bigger version of
 * adding an index: it rewrites the table, constrains every unique key it can
 * ever have, and makes any query that does not filter on the partition key
 * touch every partition. At a few hundred thousand rows an index wins on
 * every axis, so suggesting partitioning there would be advice that costs
 * more than the problem.
 */
export const PARTITION_CANDIDATE_ROWS = 10_000_000;

/**
 * When dead rows are worth reporting, as a share of the live ones.
 *
 * 0.2 because that is autovacuum's own default trigger point
 * (autovacuum_vacuum_scale_factor), so reporting above it means reporting
 * tables autovacuum should already have dealt with and has not — which is the
 * fact worth knowing. It is a DEFAULT and not a constant in the rule because
 * the settings screen offers "Dead rows above" as an alert threshold; a user
 * who sets that to 40% has said what they consider a problem, and a rule that
 * kept using its own number would leave that setting doing nothing.
 */
export const DEAD_ROW_RATIO_DEFAULT = 0.2;

/** Types a RANGE partition key can be built from, matched against typeDisplay. */
const TIME_TYPES = /^(timestamp|date)/i;

/**
 * Column names that usually mean "when this row happened" rather than "when
 * somebody last touched it". A range partition wants the first kind: rows
 * arrive in its order and never move between partitions afterwards. An
 * updated_at moves, which would mean rewriting a row into another partition
 * on every update.
 */
const EVENT_TIME_NAMES =
  /^(created|inserted|recorded|logged|occurred|captured|received|sent|ordered|placed|event|happened)(_?at|_?on|_?date|_?time)?$/i;

/**
 * Pick the column a RANGE partition key would be built from, or null.
 *
 * Preference order, and the reason for each:
 *   1. a NOT NULL column whose name says it is when the row happened — the
 *      only kind that never has to move partitions later;
 *   2. any NOT NULL date or timestamp — a partition key cannot be null, so
 *      this is the cheapest one to adopt;
 *   3. a nullable one of either, reported with the extra work it needs.
 *
 * Generated and identity columns are not excluded: a generated date column is
 * a perfectly good partition key, and the fix is comments anyway.
 */
function partitionTimeColumn(
  table: TableSnapshot
): { column: ColumnSnapshot; eventLike: boolean } | null {
  const times = table.columns.filter((c) => TIME_TYPES.test(c.typeDisplay));
  if (times.length === 0) return null;

  const named = times.filter((c) => EVENT_TIME_NAMES.test(c.name));
  const pick =
    named.find((c) => !c.nullable) ??
    times.find((c) => !c.nullable) ??
    named[0] ??
    times[0];
  return { column: pick, eventLike: EVENT_TIME_NAMES.test(pick.name) };
}

/**
 * The rule every partitioning suggestion turns on, written once because it is
 * the thing that most often makes the answer "no".
 *
 * PostgreSQL cannot enforce a unique constraint across partitions unless the
 * partition key is part of it. So partitioning `orders` by `created_at` when
 * its primary key is `id` alone means the key has to become `(id, created_at)`
 * — and that is a different promise: two rows with the same id in different
 * months stop being a conflict.
 */
function uniqueKeysNote(table: TableSnapshot, key: string): string {
  const keys = [
    ...(table.primaryKey ? [table.primaryKey] : []),
    ...table.uniqueConstraints,
  ].filter((c) => !c.columns.includes(key));
  if (keys.length === 0) {
    return (
      `-- Every unique key on this table already contains ${key}, so none of\n` +
      `-- them has to change. That is the usual blocker and it does not apply here.`
    );
  }
  const names = keys.map((c) => c.name).join(", ");
  return (
    `-- THE BLOCKER: ${countOf(keys.length, "unique key", "unique keys")} on this table\n` +
    `-- (${oneLineText(names)}) ${keys.length === 1 ? "does" : "do"} not contain ${key}.\n` +
    `-- PostgreSQL cannot enforce uniqueness across partitions unless the\n` +
    `-- partition key is part of the key, so each would have to become\n` +
    `-- (its columns, ${key}) — which is a WEAKER promise than it makes today:\n` +
    `-- two rows that clash now would stop clashing once they land in different\n` +
    `-- partitions. Decide whether that is acceptable before anything else.`
  );
}

/** A name or list flattened onto one line, so it cannot break a comment. */
function oneLineText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The second blocker, and the one no unique key names: the foreign keys
 * pointing AT this table.
 *
 * There is no ALTER TABLE that partitions a table in place, so every way of
 * doing it ends the same way — build the partitioned table beside the old one,
 * copy the rows, then rename the old one out of the way and the new one into
 * its place. A foreign key follows the TABLE, not the name. After the swap,
 * every child still references the table now called `<name>_old`, which is the
 * husk that is about to be dropped. Nothing errors and nothing warns; the
 * constraint simply guards the wrong table from that moment on.
 *
 * Re-pointing one means dropping it and adding it again, which re-checks every
 * row of the child table — and on a server older than PostgreSQL 12 it cannot
 * be re-pointed at all, because a foreign key could not reference a
 * partitioned table before then.
 *
 * `tables` is the whole schema, because the keys that matter are on the OTHER
 * tables. Only this schema is searched: a snapshot holds one schema, so a
 * reference from another database or another schema is not visible here, and
 * the note says so rather than promising a count it cannot make.
 */
function referencingKeysNote(tables: TableSnapshot[], schema: string, tableName: string): string {
  const referencing = tables.flatMap((other) =>
    other.foreignKeys
      .filter(
        (fk) =>
          fk.referencedTable === tableName &&
          // null means "the same schema as the table the key is on", which is
          // this schema, since every table here came from it.
          (fk.referencedSchema === null || fk.referencedSchema === schema)
      )
      .map((fk) => `${other.name}.${fk.name}`)
  );

  if (referencing.length === 0) {
    return (
      `-- No foreign key in ${oneLineText(schema)} points at this table, so the rename at\n` +
      `-- the end of the swap leaves nothing referencing the old copy. Check any\n` +
      `-- other schema or database that reads it — this app can only see one schema.`
    );
  }
  return (
    `-- THE OTHER BLOCKER: ${countOf(referencing.length, "foreign key", "foreign keys")} ` +
    `${referencing.length === 1 ? "points" : "point"} at this table\n` +
    `-- (${oneLineText(referencing.join(", "))}).\n` +
    `-- A foreign key follows the table, not its name, so the rename at the end\n` +
    `-- of the swap leaves ${referencing.length === 1 ? "it" : "them"} guarding the OLD copy — the empty one\n` +
    `-- about to be dropped. Nothing errors; the check is simply pointed at the\n` +
    `-- wrong table from then on. Each one has to be dropped and added again\n` +
    `-- against the new table, which re-checks every row of the child, and on\n` +
    `-- PostgreSQL older than 12 cannot be done at all: a foreign key could not\n` +
    `-- reference a partitioned table before then.`
  );
}

/**
 * Spec feature 9 — partitioning advice for tables big enough to justify it.
 *
 * Separate from analyzeSchemaPerformance because it needs one number that no
 * snapshot holds — how many rows are actually in the table — and separate from
 * analyzeTableStats because everything else it needs (the columns, the keys,
 * whether it is already partitioned) is structure. `rowCounts` is table name →
 * live rows, from pg_stat_user_tables.
 *
 * Every finding here is fixKind "decision": partitioning cannot be done in
 * place, cannot be undone by a DROP, and depends on facts about the workload
 * that this app cannot see. What it can do is name the key that would suit the
 * table's own columns, and state the two things that decide whether it is
 * possible at all — the unique keys, and whether the common queries filter on
 * the key. Pasting the fix runs nothing.
 *
 * A table whose snapshot predates partitioning capture (`partitioning` is
 * undefined) is SKIPPED rather than treated as unpartitioned: suggesting that
 * somebody partition a table that is already partitioned would read as advice
 * from an app that had not looked.
 */
export function analyzePartitioning(
  schema: string,
  tables: TableSnapshot[],
  rowCounts: Record<string, number>
): PerfAdvice[] {
  const advice: PerfAdvice[] = [];

  for (const table of tables) {
    const rows = rowCounts[table.name];
    if (rows === undefined || rows < PARTITION_CANDIDATE_ROWS) continue;
    if (table.partitioning === undefined) continue;
    if (table.partitioning.strategy !== null) continue;
    if (table.partitioning.partitionOf !== null) continue;
    if (table.partitioning.inherits.length > 0) continue;

    const target = qualifiedName(schema, table.name);
    const rowsText = rows.toLocaleString("en-US");
    const time = partitionTimeColumn(table);

    if (time) {
      const key = quoteIdent(time.column.name);
      // Built beside the table and renamed into place at the end, so the name
      // it is created under has to be one that is free today.
      const newBare = `${table.name}_partitioned`;
      const newName = qualifiedName(schema, newBare);
      // The loop below builds each partition's name as a string and hands it to
      // format(), so these three go in as SQL string literals, not as quoted
      // identifiers — quoteIdent's double quotes would be part of the name.
      const schemaText = oneLineText(literal(schema));
      const newBareText = oneLineText(literal(newBare));
      const prefixText = oneLineText(literal(`${table.name}_p`));
      advice.push({
        id: "partitioning-candidate",
        severity: "low",
        title: "Large enough that partitioning by date is worth considering",
        object: table.name,
        detail:
          `${target} holds about ${rowsText} rows and is one table. It has a ` +
          `${time.eventLike ? "date column that records when each row happened" : "date column"}, ` +
          `${oneLineText(time.column.name)}, so PostgreSQL could hold it as one partition per ` +
          `month instead. The win is rarely the reads — an index already narrows those — it is ` +
          `that deleting a month becomes DROP TABLE on one partition instead of a DELETE of ` +
          `millions of rows followed by a vacuum that has to catch up.`,
        fix:
          `-- Nothing here runs. Partitioning is a decision, and this is what it\n` +
          `-- depends on for ${target}.\n` +
          `--\n` +
          `${uniqueKeysNote(table, oneLineText(time.column.name))}\n` +
          `--\n` +
          `${referencingKeysNote(tables, schema, table.name)}\n` +
          `--\n` +
          (time.column.nullable
            ? `-- ${oneLineText(time.column.name)} is nullable, and a partition key cannot be\n` +
              `-- null. It would need SET NOT NULL first, which means finding and filling\n` +
              `-- every existing null.\n--\n`
            : "") +
          (time.eventLike
            ? ""
            : `-- ${oneLineText(time.column.name)} does not read like a column that records when a\n` +
              `-- row happened. If it is ever UPDATEd, every such update moves the row to\n` +
              `-- another partition, which is a delete and an insert. Range partitioning\n` +
              `-- wants a column that is written once.\n--\n`) +
          `-- It only pays if the queries that matter filter on ${key}. One that\n` +
          `-- does not has to read every partition, which is slower than the single\n` +
          `-- table is today. The Analyse tab will tell you which ones do.\n` +
          `--\n` +
          `-- There is no ALTER TABLE that partitions a table in place. The shape is\n` +
          `-- below. It is left commented on purpose: it renames a live table, and\n` +
          `-- which month a partition should start at is a fact about your data, not\n` +
          `-- about the schema this app read.\n` +
          `--\n` +
          `--   BEGIN;\n` +
          `--   LOCK TABLE ${target} IN ACCESS EXCLUSIVE MODE;\n` +
          `--   CREATE TABLE ${newName} (LIKE ${target} INCLUDING ALL)\n` +
          `--     PARTITION BY RANGE (${key});\n` +
          `--   -- One partition per month, from the oldest row to the newest, so no\n` +
          `--   -- row has nowhere to land. Hard-coded dates would miss whichever\n` +
          `--   -- months fall outside them and the INSERT would fail on those rows.\n` +
          `--   DO $$\n` +
          `--   DECLARE start_of_month date;\n` +
          `--   BEGIN\n` +
          `--     FOR start_of_month IN\n` +
          `--       SELECT generate_series(date_trunc('month', min(${key}))::date,\n` +
          `--                              date_trunc('month', max(${key}))::date,\n` +
          `--                              interval '1 month')::date\n` +
          `--       FROM ${target}\n` +
          `--     LOOP\n` +
          `--       -- format's %I quotes each name, so a name needing quotes, or one\n` +
          `--       -- holding a quote, survives being pasted together here.\n` +
          `--       EXECUTE format(\n` +
          `--         'CREATE TABLE %I.%I PARTITION OF %I.%I FOR VALUES FROM (%L) TO (%L)',\n` +
          `--         ${schemaText}, ${prefixText} || to_char(start_of_month, 'YYYYMM'),\n` +
          `--         ${schemaText}, ${newBareText},\n` +
          `--         start_of_month, start_of_month + interval '1 month');\n` +
          `--     END LOOP;\n` +
          `--   END $$;\n` +
          `--   INSERT INTO ${newName} SELECT * FROM ${target};\n` +
          `--   ALTER TABLE ${target} RENAME TO ${oneLineText(quoteIdent(`${table.name}_old`))};\n` +
          `--   ALTER TABLE ${newName} RENAME TO ${oneLineText(quoteIdent(table.name))};\n` +
          `--   COMMIT;\n` +
          `--\n` +
          `-- LIKE ... INCLUDING ALL does NOT copy foreign keys — not the ones this\n` +
          `-- table has, and not the ones pointing at it. Any this table declares have\n` +
          `-- to be added to the new one by hand before the swap.\n` +
          `--\n` +
          `-- Copying ${rowsText} rows takes time and takes disk for both copies at once.\n` +
          `-- Plan it as an outage or use a tool built for it; do not run the INSERT\n` +
          `-- above on a live table and hope.`,
        fixKind: "decision",
        table: table.name,
      });
      continue;
    }

    // No date column. HASH partitioning spreads the rows evenly and is the
    // only strategy that needs nothing of the data, but it buys much less:
    // there is no "drop last year" and no partition pruning unless a query
    // filters on the key by equality.
    const pk = table.primaryKey;
    const hashKey = pk && pk.columns.length === 1 ? pk.columns[0] : null;
    advice.push({
      id: "partitioning-candidate",
      severity: "low",
      title: "Large enough to consider partitioning, but nothing here looks like a date key",
      object: table.name,
      detail:
        `${target} holds about ${rowsText} rows and has no date or timestamp column to ` +
        `partition by range on, which is the form that pays for itself. Whether anything ` +
        `else is worth it depends on how the table is read, and that is a judgement call.`,
      fix:
        `-- Nothing here runs.\n` +
        `--\n` +
        `-- Range partitioning is the one that usually pays, and it needs a column\n` +
        `-- that says when a row happened. ${target} has none, so the honest\n` +
        `-- answer is that partitioning may not be the right tool for this table.\n` +
        `--\n` +
        (hashKey
          ? `-- HASH partitioning on ${quoteIdent(hashKey)} is possible and needs nothing of\n` +
            `-- the data — it just spreads the rows across N tables. It gives you\n` +
            `-- smaller indexes and parallel maintenance, and nothing else: there is\n` +
            `-- no "drop last year", and a query is only narrowed to one partition if\n` +
            `-- it compares ${quoteIdent(hashKey)} with =.\n` +
            `--   PARTITION BY HASH (${quoteIdent(hashKey)})\n` +
            `--\n` +
            `${uniqueKeysNote(table, hashKey)}\n`
          : `-- There is no single-column primary key to hash on either.\n`) +
        `--\n` +
        `${referencingKeysNote(tables, schema, table.name)}\n` +
        `--\n` +
        `-- Before partitioning, check the cheaper answers: an index that suits the\n` +
        `-- common queries, and whether old rows could be archived out of the table\n` +
        `-- altogether. Both are reversible; partitioning is not.`,
      fixKind: "decision",
      table: table.name,
    });
  }

  return advice;
}
