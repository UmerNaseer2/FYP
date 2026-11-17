// Performance advice: a partitioned index that was never finished.
//
// Holds unfinishedPartitionedIndexAdvice, one long function that writes the
// steps to finish such an index, and the helpers that read its key list.

import { constraintName, indexName, qualifiedName, quoteIdent } from "../sql";
import { countOf } from "../../ui/plural";
import type { PerfAdvice } from "./types";
import { comment, literal, NAME, parseIndexDefinition, singleName, splitList } from "./pg-text";
import { listInWords } from "./table-facts";
import type { IndexStats, WaitingPartition } from "./stats-types";

/**
 * How many partitions the finding about an unfinished partitioned index
 * writes steps out for. Past that the fix would run to pages, so it says how
 * many more there are and gives the query that lists every one.
 */
const MAX_PARTITION_STEPS = 10;

/**
 * The bracketed list an index definition's tail starts with, without its
 * brackets: "(a, lower(b)) INCLUDE (c)" → "a, lower(b)". Null when the tail
 * does not start with one, or its bracket never closes.
 */
function leadingKeyList(tail: string): string | null {
  if (!tail.startsWith("(")) return null;
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < tail.length; i += 1) {
    const ch = tail[i];
    if (quote !== null) {
      // A doubled quote closes and at once reopens, which comes to the same.
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return tail.slice(1, i);
    }
  }
  return null;
}

/**
 * What one key adds to the name PostgreSQL gives a new index: a column's name
 * (with or without DESC, COLLATE or an operator class after it), a function's
 * name for a call to one, and "expr" for any other expression, which
 * pg_get_indexdef prints in brackets.
 *
 *   created DESC  →  created
 *   lower(email)  →  lower
 *   ((a + b))     →  expr
 */
function keyNamePart(item: string): string {
  const text = item.trim();
  const plain = singleName(text);
  if (plain !== null) return plain;
  const withOptions = new RegExp(String.raw`^(${NAME})\s`).exec(text);
  if (withOptions) return singleName(withOptions[1]) ?? "expr";
  const call = new RegExp(String.raw`^(?:${NAME}\.)*(${NAME})\(`).exec(text);
  if (call) return singleName(call[1]) ?? "expr";
  return "expr";
}

/**
 * A sentence or two as comment lines of at most 80 characters.
 *
 * Every run of white space, line breaks included, becomes one space before
 * the text is broken into lines, so a name with a line break in it stays
 * inside the comment (see the comment tag in pg-text.ts).
 */
function commentLines(text: string): string[] {
  const lines: string[] = [];
  let line = "--";
  for (const word of text.split(/\s+/)) {
    if (word === "") continue;
    if (line !== "--" && line.length + 1 + word.length > 80) {
      lines.push(line);
      line = "--";
    }
    line += ` ${word}`;
  }
  if (line !== "--") lines.push(line);
  return lines;
}

/**
 * The index of a partitioned table that PostgreSQL has not marked finished.
 *
 * Such an index holds no rows itself: each partition has a copy of its own,
 * and the partitioned one counts as finished only once every partition has a
 * finished copy attached. It starts out unfinished when it is built on the
 * partitioned table alone (CREATE INDEX … ON ONLY, ALTER TABLE ONLY … ADD
 * CONSTRAINT), which is how pg_dump writes it before attaching the copies one
 * by one; a restore or migration that stopped part-way leaves it like that.
 * Until it is finished a unique one guarantees nothing where a copy is
 * missing, and PostgreSQL refuses a foreign key or an INSERT … ON CONFLICT
 * that would rely on it.
 *
 * The fix goes partition by partition. Each way of finishing one was checked
 * on PostgreSQL 17:
 *
 * - A partition: CREATE INDEX CONCURRENTLY, then ALTER INDEX … ATTACH
 *   PARTITION. A unique or primary key constraint's copy has to belong to a
 *   matching constraint, which ADD CONSTRAINT … USING INDEX makes it. An
 *   exclusion constraint has no USING INDEX, so ADD CONSTRAINT builds it,
 *   blocking reads and writes to that partition.
 * - A partition whose attached copy is not finished: REINDEX INDEX
 *   CONCURRENTLY (an exclusion constraint's index refuses CONCURRENTLY), then
 *   attach it again, which is when PostgreSQL checks the index above.
 * - A partition that is partitioned itself refuses CONCURRENTLY. Matching
 *   indexes built on its partitions first are taken over by the plain CREATE
 *   INDEX or ADD CONSTRAINT there, rather than built by it.
 * - A foreign table cannot hold an index at all. Built without ONLY, an index
 *   leaves foreign partitions out, so building it again that way finishes it;
 *   a unique one cannot cover a foreign table, so those have to be detached.
 * - Every partition covered but the index still unfinished: the last missing
 *   copy went away without an ATTACH, and attaching any copy again makes
 *   PostgreSQL check.
 *
 * All of it is comments, a decision: how busy the table is decides which way
 * to build, and a restore that is still running looks the same as one that
 * stopped.
 */
export function unfinishedPartitionedIndexAdvice(
  index: IndexStats,
  schema: string,
  takenNames: Set<string>
): PerfAdvice {
  const tableName = index.table_name;
  const parent = qualifiedName(schema, index.index_name);
  const table = qualifiedName(schema, tableName);
  const parsed = parseIndexDefinition(index.definition);
  const constraintDefinition = index.constraint_definition ?? null;
  // What owns the index, which decides how each partition's copy is made:
  // nothing, or a primary key, unique or exclusion constraint.
  const kind =
    constraintDefinition === null
      ? index.is_primary || index.backs_constraint
        ? null
        : "index"
      : /^PRIMARY KEY\b/.test(constraintDefinition)
        ? "primary"
        : /^UNIQUE\b/.test(constraintDefinition)
          ? "unique"
          : /^EXCLUDE\b/.test(constraintDefinition)
            ? "exclusion"
            : null;
  const base = {
    id: "unfinished-partitioned-index",
    title: "Index on a partitioned table is not finished",
    object: `${tableName}.${index.index_name}`,
    fixKind: "decision" as const,
  };
  const origin =
    "An index built with CREATE INDEX ON ONLY, or a constraint added with ALTER TABLE ONLY, " +
    "starts out on the partitioned table alone; pg_dump writes both that way, then attaches " +
    "each partition's copy. PostgreSQL marks the index finished only once every partition " +
    "has a finished copy attached.";
  // A restore adds the copies one at a time after the index itself, so one
  // that is still running looks exactly like one that stopped.
  const stillRunning = [
    "-- A restore or a migration may still be adding copies to this index. If one is",
    "-- running, let it finish first; an index build in progress shows up in the",
    "-- list this prints:",
    "-- SELECT relid::regclass AS table_name, command, phase",
    "-- FROM pg_stat_progress_create_index WHERE datname = current_database();",
  ];
  // The partitions of the index's table with no finished copy attached. It
  // reads the catalog afresh, so it can be run again between the steps.
  const listing = [
    "-- SELECT p.inhrelid::regclass AS partition",
    "--   FROM pg_index ix JOIN pg_inherits p ON p.inhparent = ix.indrelid",
    comment`--  WHERE ix.indexrelid = ${literal(parent)}::regclass`,
    "--    AND NOT EXISTS (SELECT 1 FROM pg_inherits i JOIN pg_index x ON x.indexrelid = i.inhrelid",
    "--                     WHERE i.inhparent = ix.indexrelid AND x.indrelid = p.inhrelid AND x.indisvalid);",
  ];

  const waiting = index.waiting_on;
  if (waiting === undefined || parsed === null || kind === null) {
    // Too little to go on for steps: say what to look for, and how to finish.
    const fix = [
      ...stillRunning,
      "-- Find which partitions have no finished copy attached:",
      ...listing,
      ...commentLines(
        `Give each of them an index matching this one, and attach each with the statement ` +
          `ALTER INDEX ${parent} ATTACH PARTITION followed by that index's name.` +
          (constraintDefinition !== null || index.backs_constraint
            ? " The index belongs to a constraint, so each partition's index has to belong " +
              "to a matching constraint of its own before it can be attached."
            : "")
      ),
      "-- For reference, PostgreSQL prints the index as:",
      comment`-- ${index.definition}`,
    ];
    if (constraintDefinition !== null) {
      fix.push("-- and its constraint as:", comment`-- ${constraintDefinition}`);
    }
    return {
      ...base,
      severity: "medium",
      detail:
        `PostgreSQL has not marked this index on the partitioned table ${tableName} finished, ` +
        `so a partition without a finished copy of it may have no index like it to use` +
        `${index.is_unique ? ", and its values are not guaranteed to be unique" : ""}. ${origin}`,
      fix: fix.join("\n"),
    };
  }

  const unique = parsed.unique;
  // Never empty for a constraint: `kind` is only a constraint's when there is one.
  const constraint = constraintDefinition ?? "";
  const using = `USING ${parsed.method} ${parsed.tail}`;
  // Each partition's constraint repeats the parent's DEFERRABLE, so it behaves the same.
  const deferrable = / DEFERRABLE(?: INITIALLY DEFERRED)?$/.exec(constraint)?.[0] ?? "";
  const foreign = waiting.filter((w) => w.foreign);
  const indexed = waiting.filter((w) => !w.foreign);
  const thing = kind === "index" ? "index" : "constraint";

  // A table's name in a sentence: bare in this schema, with its schema in another.
  const label = (w: { schema: string; table: string }): string =>
    w.schema === schema ? w.table : `${w.schema}.${w.table}`;
  // The first MAX_PARTITION_STEPS names in a sentence, then how many more.
  const inWords = (list: WaitingPartition[]): string => {
    const shown = list.slice(0, MAX_PARTITION_STEPS).map(label);
    const more = list.length - shown.length;
    return more > 0 ? `${shown.join(", ")} and ${more} more` : listInWords(shown);
  };
  // A name for a new copy on one partition, the way PostgreSQL would pick
  // it, kept out of every later suggestion in the same report.
  const keyList = leadingKeyList(parsed.tail);
  const nameDetail = keyList === null ? "expr" : splitList(keyList).map(keyNamePart).join("_");
  const freshName = (partition: string): string => {
    const name =
      kind === "primary"
        ? constraintName(partition, "pkey", takenNames)
        : indexName(
            partition,
            nameDetail,
            takenNames,
            kind === "unique" ? "key" : kind === "exclusion" ? "excl" : "idx"
          );
    takenNames.add(name);
    return name;
  };

  const sentences: string[] = [];
  if (waiting.length > 0) {
    sentences.push(
      `${countOf(waiting.length, "partition")} of ${tableName} ${waiting.length === 1 ? "has" : "have"} ` +
        `no finished copy of this index attached: ${inWords(waiting)}.`
    );
  } else if (index.attached_example) {
    sentences.push(
      `Every partition of ${tableName} now has a finished copy of this index attached, but ` +
        `PostgreSQL checks for that only when a copy is attached. The last one missing went ` +
        `away some other way (its partition was dropped or detached, or its copy was rebuilt ` +
        `in place), so the index is still marked unfinished.`
    );
  } else {
    sentences.push(
      `${tableName} has no partitions at the moment. PostgreSQL checks whether this index is ` +
        `finished only when a copy of it is attached, and with no partitions there is nothing ` +
        `to attach, so it stays marked unfinished.`
    );
  }
  if (indexed.length > 0) {
    sentences.push(
      "Where a partition has no finished copy, queries reading it may have no index like this one to use."
    );
  }
  if (unique) {
    if (waiting.length > 0) {
      sentences.push("In a partition without a finished copy, values are not guaranteed to be unique.");
    }
    // A partial index was never one a foreign key could point at.
    sentences.push(
      / WHERE /.test(parsed.tail)
        ? "PostgreSQL refuses an INSERT with ON CONFLICT on these columns until the index is finished."
        : "PostgreSQL refuses a new foreign key pointing at these columns, and an INSERT with " +
            "ON CONFLICT on them, until the index is finished."
    );
  } else if (kind === "exclusion" && waiting.length > 0) {
    sentences.push("In a partition without a finished copy, the constraint is not guaranteed to hold.");
  }
  if (foreign.length > 0) {
    sentences.push(
      `${inWords(foreign)} ${foreign.length === 1 ? "is a foreign table" : "are foreign tables"}, ` +
        `which PostgreSQL cannot build an index on, so attaching copies can never finish this index. ` +
        (unique
          ? "A unique index cannot cover a foreign table at all."
          : kind === "exclusion"
            ? "Added without ONLY, an exclusion constraint leaves foreign partitions out and is " +
              "finished as soon as it is built."
            : "Built without ONLY, an index leaves foreign partitions out and is finished as " +
              "soon as it is built.")
    );
  }
  sentences.push(origin);
  if (index.is_partition_child) {
    const top = index.top_index;
    sentences.push(
      `${tableName} is itself a partition, and this index is part of ` +
        (top ? `the index ${top.name} on ${label(top)}` : "an index on the table above it") +
        `, which cannot be finished until this one is.`
    );
  }

  const fix = [...stillRunning];
  // Set once the fix offers the DROP, so it is not offered twice.
  let dropOffered = false;
  if (foreign.length > 0 && !unique) {
    // Built again without ONLY, the index leaves foreign partitions out. A
    // partition's copy cannot be dropped on its own, so for one of those it
    // is the index at the top that is built again.
    const top = index.is_partition_child
      ? (index.top_index ?? null)
      : { schema, table: tableName, name: index.index_name };
    const exclusion = kind === "exclusion";
    const again = exclusion
      ? "Add the constraint again without ONLY: added that way, it leaves foreign partitions " +
        "out and is finished as soon as it is built."
      : "Build the index again without ONLY: built that way, it leaves foreign partitions out " +
        "and is finished as soon as it is built.";
    const redo = exclusion ? "added" : "built";
    if (top === null) {
      fix.push(
        ...commentLines(
          `${again} PostgreSQL will not drop a partition's copy of an index on its own, so it ` +
            `is the ${thing} at the top of this one's tree that has to be ${redo} again.`
        )
      );
    } else {
      const topTable = qualifiedName(top.schema, top.table);
      fix.push(
        ...commentLines(
          again +
            (index.is_partition_child
              ? ` PostgreSQL will not drop a partition's copy of an index on its own, so it is ` +
                `the ${thing} at the top, ${top.name} on ${label(top)}, that is ${redo} again, ` +
                `with every copy of it.`
              : "")
        )
      );
      if (exclusion) {
        // Partitions that had no finished copy were never checked, so the ADD
        // CONSTRAINT can fail after the DROP; in one transaction the DROP is
        // undone with it.
        fix.push(
          ...commentLines(
            `Adding it builds the constraint on every partition that can hold one, blocking ` +
              `reads and writes to ${label(top)} until it finishes. If two rows conflict it ` +
              `stops with an error naming them, so run both statements in one transaction: ` +
              `the DROP is then undone as well.`
          ),
          "-- BEGIN;",
          comment`-- ALTER TABLE ${topTable} DROP CONSTRAINT ${quoteIdent(top.name)};`,
          comment`-- ALTER TABLE ${topTable} ADD CONSTRAINT ${quoteIdent(top.name)} ${constraint};`,
          "-- COMMIT;"
        );
      } else {
        fix.push(
          ...commentLines(
            "On a busy table, first give each partition that can hold an index a matching one " +
              "with CREATE INDEX CONCURRENTLY, outside a transaction, and leave it unattached; " +
              "the CREATE INDEX below then takes those over and blocks writes only for a moment. " +
              "This lists the partitions that can hold one:"
          ),
          comment`-- SELECT t.relid AS partition FROM pg_partition_tree(${literal(topTable)}) t JOIN pg_class c ON c.oid = t.relid WHERE t.isleaf AND c.relkind = 'r';`,
          ...commentLines(
            `The DROP also drops every copy attached to the index. Without matching indexes ` +
              `built beforehand, the CREATE INDEX builds them all again, blocking writes to ` +
              `${label(top)} until it finishes.`
          ),
          comment`-- DROP INDEX ${qualifiedName(top.schema, top.name)};`,
          comment`-- CREATE INDEX ${quoteIdent(top.name)} ON ${topTable} ${using};`
        );
      }
      fix.push(`-- If nothing needs the ${thing}, the DROP alone is enough.`);
    }
    dropOffered = true;
  } else {
    // Whether steps come before the last one, which then starts "After that,".
    let before = false;
    if (foreign.length > 0) {
      // Only a unique index gets here; any other one is built again above.
      fix.push(
        ...commentLines(
          `A unique index cannot cover a foreign table, so take the foreign ` +
            `${foreign.length === 1 ? "table" : "tables"} out of ${tableName} first. Detaching ` +
            `one takes its rows out of ${tableName} as well:`
        )
      );
      for (const w of foreign.slice(0, MAX_PARTITION_STEPS)) {
        fix.push(comment`-- ALTER TABLE ${table} DETACH PARTITION ${qualifiedName(w.schema, w.table)};`);
      }
      const more = foreign.length - MAX_PARTITION_STEPS;
      if (more > 0) {
        fix.push(
          ...commentLines(
            `${more} more foreign ${more === 1 ? "table is a partition" : "tables are partitions"} ` +
              `of ${tableName} as well; this lists every one:`
          ),
          comment`-- SELECT c.oid::regclass AS foreign_table FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = ${literal(table)}::regclass AND c.relkind = 'f';`
        );
      }
      before = true;
    }

    if (indexed.length > 0) {
      const shown = indexed.slice(0, MAX_PARTITION_STEPS);
      const leafNew = shown.some((w) => !w.partitioned && w.attached === null);
      const leafAgain = shown.some((w) => !w.partitioned && w.attached !== null);
      const midNew = shown.filter((w) => w.partitioned && w.attached === null);
      const concurrently = kind !== "exclusion" && (leafNew || leafAgain);

      // Notes for the kinds of step below, each said once.
      if (leafNew || leafAgain || midNew.length > 0) {
        if (unique) {
          fix.push(
            ...commentLines(
              "A unique index cannot be built while two rows share a value: the statement stops " +
                "with an error naming it, so fix those rows and run it again. A CONCURRENTLY build " +
                "that stops that way leaves an unfinished index behind, under the name it was " +
                "building or one ending in _ccnew; drop that before running it again."
            )
          );
        } else if (kind === "exclusion") {
          fix.push(
            ...commentLines(
              "An exclusion constraint cannot be built while two rows conflict: the statement " +
                "stops with an error naming them, so fix those rows and run it again."
            )
          );
        }
      }
      if (concurrently) {
        fix.push(
          "-- Run each statement on its own, outside a transaction: CONCURRENTLY is refused",
          "-- inside one."
        );
      }
      if (leafNew && (kind === "unique" || kind === "primary")) {
        fix.push(
          ...commentLines(
            "The index belongs to a constraint, so each partition's copy has to belong to a " +
              "matching constraint of its own. ADD CONSTRAINT with USING INDEX makes a finished " +
              "index that constraint, holding a lock on the partition only for a moment."
          )
        );
      }
      if (leafNew && kind === "exclusion") {
        fix.push(
          ...commentLines(
            "An exclusion constraint's index cannot be built beforehand, so ADD CONSTRAINT " +
              "builds it, blocking reads and writes to that partition until it finishes."
          )
        );
      }
      if (leafAgain) {
        fix.push(
          ...commentLines(
            (kind === "exclusion"
              ? "REINDEX INDEX CONCURRENTLY is refused for an exclusion constraint's index, so " +
                "the rebuild is a plain REINDEX, which blocks writes to that partition and nearly " +
                "all reads until it finishes. "
              : "") +
              "A copy that is already attached is attached again once it is rebuilt: that is " +
              "when PostgreSQL checks whether the whole index is finished."
          )
        );
      }
      if (midNew.length > 0) {
        if (kind === "index") {
          fix.push(
            ...commentLines(
              "CREATE INDEX CONCURRENTLY is refused on a partition that is partitioned itself, " +
                "and a plain CREATE INDEX there blocks writes to it until it finishes. On a busy " +
                `table, first build a matching ${unique ? "unique " : ""}index on each of its ` +
                `partitions with CREATE ${unique ? "UNIQUE " : ""}INDEX CONCURRENTLY, outside a ` +
                "transaction; the CREATE INDEX then takes those over and blocks writes only for " +
                "a moment." +
                (!unique && midNew.some((w) => w.foreign_below)
                  ? " Foreign tables among its partitions cannot hold an index, and the CREATE " +
                    "INDEX leaves them out."
                  : "")
            )
          );
        } else if (kind === "exclusion") {
          fix.push(
            ...commentLines(
              "On a partition that is partitioned itself, ADD CONSTRAINT builds the constraint " +
                "on each of its partitions, blocking reads and writes to all of them until it " +
                "finishes." +
                (midNew.some((w) => w.foreign_below) ? " Foreign tables among them are left out." : "")
            )
          );
        } else {
          fix.push(
            ...commentLines(
              "On a partition that is partitioned itself, ADD CONSTRAINT builds the constraint " +
                "on each of its partitions, blocking reads and writes to it until it finishes. " +
                "On a busy table, first build a unique index on each of its partitions with " +
                "CREATE UNIQUE INDEX CONCURRENTLY, outside a transaction, and make each one that " +
                "partition's constraint with ADD CONSTRAINT and USING INDEX; the ADD CONSTRAINT " +
                "then takes those over and holds its lock only for a moment."
            )
          );
        }
        if (unique) {
          fix.push(
            ...commentLines(
              "A unique index on a partitioned table has to include every column that table is " +
                "partitioned by. If PostgreSQL refuses one below for that reason, this index " +
                "cannot be finished as it is, and dropping it is the way out."
            )
          );
        }
      }

      for (const w of shown) {
        const part = qualifiedName(w.schema, w.table);
        fix.push(comment`-- For ${part}:`);
        if (w.attached !== null) {
          const copy = qualifiedName(w.schema, w.attached);
          if (w.partitioned) {
            // Finishing that copy is the other finding's job; once it is
            // finished, PostgreSQL checks this index too.
            fix.push(
              ...commentLines(
                `Its copy ${label({ schema: w.schema, table: w.attached })} is not finished ` +
                  `either, and has a finding of its own ` +
                  (w.schema === schema ? "in this list." : `when schema ${w.schema} is analysed.`) +
                  " Once that copy is finished, it counts for this partition too."
              )
            );
            continue;
          }
          fix.push(
            kind === "exclusion"
              ? comment`-- REINDEX INDEX ${copy};`
              : comment`-- REINDEX INDEX CONCURRENTLY ${copy};`,
            comment`-- ALTER INDEX ${parent} ATTACH PARTITION ${copy};`
          );
          continue;
        }
        const name = freshName(w.table);
        if (w.partitioned) {
          if (unique && w.foreign_below) {
            fix.push(
              ...commentLines(
                "Foreign tables below it cannot be covered by a unique index, so first detach " +
                  "each one from the table it is a partition of. This lists them, each with that table:"
              ),
              comment`-- SELECT t.relid AS foreign_table, t.parentrelid AS parent FROM pg_partition_tree(${literal(part)}) t JOIN pg_class c ON c.oid = t.relid WHERE c.relkind = 'f';`
            );
          }
          fix.push(
            kind === "index"
              ? comment`-- CREATE ${unique ? "UNIQUE " : ""}INDEX ${quoteIdent(name)} ON ${part} ${using};`
              : comment`-- ALTER TABLE ${part} ADD CONSTRAINT ${quoteIdent(name)} ${constraint};`
          );
        } else if (kind === "exclusion") {
          fix.push(comment`-- ALTER TABLE ${part} ADD CONSTRAINT ${quoteIdent(name)} ${constraint};`);
        } else {
          fix.push(
            comment`-- CREATE ${unique ? "UNIQUE " : ""}INDEX CONCURRENTLY ${quoteIdent(name)} ON ${part} ${using};`
          );
          if (kind !== "index") {
            fix.push(
              comment`-- ALTER TABLE ${part} ADD CONSTRAINT ${quoteIdent(name)} ` +
                `${kind === "primary" ? "PRIMARY KEY" : "UNIQUE"} USING INDEX ` +
                comment`${quoteIdent(name)}${deferrable};`
            );
          }
        }
        fix.push(comment`-- ALTER INDEX ${parent} ATTACH PARTITION ${qualifiedName(w.schema, name)};`);
      }

      const more = indexed.length - shown.length;
      fix.push(
        more > 0
          ? `-- ${more} more ${more === 1 ? "partition is" : "partitions are"} waiting as well; this lists every one still waiting:`
          : "-- To list the partitions still waiting at any point:",
        ...listing
      );
      if (leafNew || midNew.length > 0) {
        fix.push(
          ...commentLines(
            "If PostgreSQL says a name above is already taken, pick another and use it in each " +
              "statement that names it. " +
              (kind === "index"
                ? "If a partition already has a matching index of its own, attach that instead " +
                  "of building another."
                : "If a partition already has a matching constraint of its own, attach its index " +
                  "instead of building another.")
          )
        );
      }
    } else if (index.attached_example) {
      const example = qualifiedName(index.attached_example.schema, index.attached_example.name);
      fix.push(
        ...commentLines(
          `${before ? "After that, " : ""}PostgreSQL checks whether every partition has a ` +
            `finished copy only when one is attached, so attach one of the copies again:`
        ),
        comment`-- ALTER INDEX ${parent} ATTACH PARTITION ${example};`
      );
    } else if (!index.is_partition_child) {
      // No partitions: built again without ONLY, the index is finished at once.
      fix.push(
        ...commentLines(
          `${before ? "After that, " : ""}${tableName} has no partitions, so drop the ${thing} and ` +
            `${kind === "index" ? "build" : "add"} it again: with no partitions there are no copies ` +
            `to build, so both statements take only a moment.`
        ),
        ...(kind === "index"
          ? [
              comment`-- DROP INDEX ${parent};`,
              comment`-- CREATE ${unique ? "UNIQUE " : ""}INDEX ${quoteIdent(index.index_name)} ON ${table} ${using};`,
            ]
          : [
              comment`-- ALTER TABLE ${table} DROP CONSTRAINT ${quoteIdent(index.index_name)};`,
              comment`-- ALTER TABLE ${table} ADD CONSTRAINT ${quoteIdent(index.index_name)} ${constraint};`,
            ]),
        `-- If nothing needs the ${thing}, the DROP alone is enough.`
      );
      dropOffered = true;
    } else {
      // A partition's copy cannot be dropped on its own. A new partition gets
      // a copy of it straight away, but PostgreSQL only checks it on ATTACH.
      fix.push(
        ...commentLines(
          `${before ? "After that, " : ""}${tableName} has no partitions, and PostgreSQL will not ` +
            `drop a partition's copy of an index on its own. Once ${tableName} has a partition ` +
            `again, that partition gets a copy of this index straight away; this prints it:`
        ),
        comment`-- SELECT inhrelid::regclass AS copy FROM pg_inherits WHERE inhparent = ${literal(parent)}::regclass;`,
        ...commentLines(
          `PostgreSQL checks whether every partition has a finished copy only when one is ` +
            `attached, so then attach that copy again, by the name it prints, with ALTER INDEX ` +
            `${parent} ATTACH PARTITION.`
        )
      );
    }
  }

  if (!dropOffered) {
    if (!index.is_partition_child) {
      fix.push(
        `-- If nothing needs the ${thing}, drop it instead:`,
        kind === "index"
          ? comment`-- DROP INDEX ${parent};`
          : comment`-- ALTER TABLE ${table} DROP CONSTRAINT ${quoteIdent(index.index_name)};`
      );
    } else if (index.top_index) {
      const top = index.top_index;
      fix.push(
        `-- If nothing needs the ${thing}, drop the one at the top instead, which drops this`,
        "-- copy with it:",
        kind === "index"
          ? comment`-- DROP INDEX ${qualifiedName(top.schema, top.name)};`
          : comment`-- ALTER TABLE ${qualifiedName(top.schema, top.table)} DROP CONSTRAINT ${quoteIdent(top.name)};`
      );
    }
  }

  return {
    ...base,
    severity: unique || indexed.length > 0 ? "medium" : "low",
    detail: sentences.join(" "),
    fix: fix.join("\n"),
  };
}
