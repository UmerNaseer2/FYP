// Performance advice: the fix for a table with no primary key.
//
// Holds primaryKeyFix, which picks the safest way to give a table a key.

import type { TableSnapshot } from "../../postgres";
import { constraintName, qualifiedName, quoteIdent } from "../sql";
import type { PerfAdvice } from "./types";
import { comment, constraintKeys, indexDefinitionSql, type ParsedIndex } from "./pg-text";
import {
  constraintNames,
  freeColumnName,
  listInWords,
  partitionKeyColumns,
  sortedByName,
} from "./table-facts";

/**
 * The fix for a table with no primary key, from the most direct to the least:
 *
 *   a. a unique index over NOT NULL columns becomes the key as it is — nothing
 *      is built, PostgreSQL only renames the index;
 *   b. a unique constraint over NOT NULL columns: the same columns become the
 *      key, and the constraint can go afterwards;
 *   c. otherwise the key has to be chosen, so the fix sets out the choice.
 *
 * A partitioned table always gets (c), worded for partitioning: its key has
 * to include the partition key's columns, PostgreSQL cannot enforce one at all
 * over a computed partition key, and ADD ... USING INDEX is refused there.
 *
 * `indexes` are the ones (a) may take over: the valid indexes the
 * duplicate-index finding keeps (see keptCopy). The two findings start ticked
 * and go into one script, and PostgreSQL renames the index it makes the key,
 * so a DROP INDEX of a copy taken over here would fail in that script. A copy
 * of a unique constraint is never among them: the duplicate-index finding
 * keeps the constraint's own index, and (b) makes the key from its columns.
 */
export function primaryKeyFix(
  schema: string,
  table: TableSnapshot,
  relations: Set<string>,
  indexes: ParsedIndex[]
): Pick<PerfAdvice, "fix" | "fixKind" | "undo"> {
  const target = qualifiedName(schema, table.name);
  const notNull = new Set(table.columns.filter((c) => !c.nullable).map((c) => c.name));
  const allNotNull = (columns: string[]) =>
    columns.length > 0 && columns.every((c) => notNull.has(c));
  const taken = [...relations, ...constraintNames(table)];

  if (!table.partitioning?.strategy) {
    for (const parsed of sortedByName(indexes)) {
      if (!parsed.unique || parsed.method !== "btree") continue;
      if (parsed.keys === null || !allNotNull(parsed.keys)) continue;
      // The index is renamed to the key's name, so its own name is free here.
      const name = constraintName(table.name, "pkey", taken.filter((n) => n !== parsed.name));
      relations.add(name);
      return {
        fixKind: "change",
        fix:
          comment`-- The unique index ${quoteIdent(parsed.name)} already allows only one row per ` +
          comment`(${parsed.keys.join(", ")}),\n` +
          comment`-- and ${listInWords(parsed.keys)} ${parsed.keys.length === 1 ? "is" : "are"} ` +
          `declared NOT NULL, so it can become the key without building anything.\n` +
          (name === parsed.name
            ? ""
            : comment`-- PostgreSQL renames the index to ${quoteIdent(name)} when it does.\n`) +
          `ALTER TABLE ${target} ADD CONSTRAINT ${quoteIdent(name)} ` +
          `PRIMARY KEY USING INDEX ${quoteIdent(parsed.name)};`,
        // Dropping the key drops the index it took over, so the undo builds
        // the index again under its old name.
        undo:
          `ALTER TABLE ${target} DROP CONSTRAINT ${quoteIdent(name)};\n` +
          indexDefinitionSql(parsed, schema, table.name, true),
      };
    }

    for (const unique of sortedByName(table.uniqueConstraints)) {
      // Only a plain UNIQUE (a, b). A DEFERRABLE one lets a statement break the
      // rule until it ends, which a primary key on the same columns would not,
      // so code relying on that could start failing.
      const keys = constraintKeys(unique);
      if (keys === null || !allNotNull(keys)) continue;
      const name = constraintName(table.name, "pkey", taken);
      relations.add(name);
      return {
        fixKind: "change",
        fix:
          comment`-- The unique constraint ${quoteIdent(unique.name)} already allows only one row per ` +
          comment`(${keys.join(", ")}),\n` +
          comment`-- and ${listInWords(keys)} ${keys.length === 1 ? "is" : "are"} ` +
          `declared NOT NULL, so the same columns can be the key. Adding it builds a\n` +
          // ADD PRIMARY KEY holds the strongest lock (ACCESS EXCLUSIVE) for the
          // whole build, so reads wait as well as writes.
          `-- new index, and the table is blocked, reads included, until that finishes.\n` +
          `ALTER TABLE ${target} ADD CONSTRAINT ${quoteIdent(name)} ` +
          `PRIMARY KEY (${keys.map(quoteIdent).join(", ")});\n` +
          comment`-- The key builds its own index, so ${quoteIdent(unique.name)} then checks the same\n` +
          `-- thing twice. Drop it afterwards, unless a foreign key in another table uses\n` +
          `-- its index (the DROP then stops with an error naming that key):\n` +
          comment`-- ALTER TABLE ${target} DROP CONSTRAINT ${quoteIdent(unique.name)};`,
        // The fix offers to drop the unique constraint, so the undo says how to
        // put it back for whoever did. Commented, because it fails while the
        // constraint is still there.
        undo:
          `ALTER TABLE ${target} DROP CONSTRAINT ${quoteIdent(name)};\n` +
          comment`-- If you dropped ${quoteIdent(unique.name)} as well, add it back:\n` +
          comment`-- ALTER TABLE ${target} ADD CONSTRAINT ${quoteIdent(unique.name)} ${unique.definition};`,
      };
    }
  }

  const column = freeColumnName(table);
  const check =
    "checking that no two rows share a value and none of them is NULL";

  if (!table.partitioning?.strategy) {
    return {
      fixKind: "decision",
      fix:
        `-- No unique index or constraint here can become the key as it is, so the key\n` +
        `-- has to be chosen. If some columns already identify a row, make them the key,\n` +
        comment`-- after ${check}.\n` +
        // Checked on PostgreSQL 17: adding an identity column writes the whole
        // table out again (unlike a plain ADD COLUMN) to give each row its
        // number, and holds ACCESS EXCLUSIVE, which stops reads too.
        `-- Or add a new column for it. That rewrites the table to number the rows already\n` +
        `-- there, and the table is blocked, reads included, until that finishes:\n` +
        comment`-- ALTER TABLE ${target} ADD COLUMN ${quoteIdent(column)} bigint ` +
        `GENERATED ALWAYS AS IDENTITY PRIMARY KEY;`,
    };
  }

  const partitionKey = partitionKeyColumns(table.partitioning.key);
  if (partitionKey.kind === "expression") {
    return {
      fixKind: "decision",
      fix:
        comment`-- This table is partitioned by ${table.partitioning.key ?? "a computed key"}, and PostgreSQL\n` +
        `-- cannot enforce a primary key on a table partitioned by an expression.\n` +
        `-- Give each partition its own key instead, over the columns that identify a row\n` +
        `-- in it. That keeps rows unique within each partition, not across them.`,
    };
  }
  const keyWords = listInWords(partitionKey.columns);
  if (partitionKey.kind === "options") {
    return {
      fixKind: "decision",
      fix:
        comment`-- This table is partitioned by ${table.partitioning.key}, so its primary key has to\n` +
        comment`-- include ${keyWords}. PostgreSQL may refuse that key because of the partition\n` +
        `-- key's collation or operator class; if it does, give each partition its own key,\n` +
        `-- which keeps rows unique within each partition, not across them.\n` +
        comment`-- Otherwise make the key the columns that identify a row together with ${keyWords},\n` +
        comment`-- after ${check}.`,
    };
  }
  return {
    fixKind: "decision",
    fix:
      comment`-- This table is partitioned by ${table.partitioning.key}, so its primary key has to\n` +
      comment`-- include ${keyWords}. If some columns identify a row together with ${keyWords},\n` +
      comment`-- make them the key, after ${check}.\n` +
      // Two statements, because PostgreSQL refuses identity and primary key
      // together in one ADD COLUMN on a partitioned table. Checked on 17: the
      // first rewrites every partition, and each holds ACCESS EXCLUSIVE on the
      // table and all its partitions while it runs.
      `-- Or add a new column for it (an identity column on a partitioned table needs\n` +
      `-- PostgreSQL 17 or later). The first statement rewrites every partition to number\n` +
      `-- the rows already there, and the table is blocked, reads included, while each\n` +
      `-- statement runs:\n` +
      comment`-- ALTER TABLE ${target} ADD COLUMN ${quoteIdent(column)} bigint GENERATED ALWAYS AS IDENTITY;\n` +
      comment`-- ALTER TABLE ${target} ADD PRIMARY KEY ` +
      comment`(${[column, ...partitionKey.columns].map(quoteIdent).join(", ")});`,
  };
}
