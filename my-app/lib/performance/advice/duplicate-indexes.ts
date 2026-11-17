// Performance advice: indexes that do the same job.
//
// Holds the helpers that group duplicate and overlapping indexes, choose
// which copy to keep, and write the fix that drops the others.

import type { TableSnapshot } from "../../postgres";
import { qualifiedName, quoteIdent } from "../sql";
import type { PerfAdvice } from "./types";
import {
  comment,
  constraintKeys,
  indexDefinitionSql,
  type ParsedIndex,
  parseIndexDefinition,
} from "./pg-text";
import { listInWords, sortedByName } from "./table-facts";

/**
 * The name REINDEX CONCURRENTLY gives the copy it builds (_ccnew) and the
 * index it replaces (_ccold), with a number added when that name is taken. A
 * rebuild that stops part-way leaves one of them behind, marked invalid.
 */
export const REINDEX_LEFTOVER = /_cc(new|old)\d*$/;

/**
 * One copy in a group of indexes that do the same job: an index from the
 * snapshot, or the index behind a primary key or unique constraint.
 */
type IndexCopy = {
  name: string;
  /** Set when a constraint owns this index; such a copy is never dropped. */
  constraint: "primary key" | "unique constraint" | null;
  /** The parsed definition; null for a constraint's index, never printed. */
  parsed: ParsedIndex | null;
};

/**
 * The table's indexes that the rules (schema-rules.ts) may keep, take over or compare,
 * parsed.
 *
 * An invalid index is left out. Queries never use it, so it copies nothing,
 * and counted as a copy it could be the one kept while the valid one is
 * dropped; PostgreSQL also refuses to make it a primary key. Its own finding
 * (invalid-index) says what to do with it. A copy that REINDEX CONCURRENTLY
 * left behind is known by its name too, for when the statistics pass could
 * not say which indexes are invalid.
 */
export function usableIndexes(table: TableSnapshot, invalidIndexes: ReadonlySet<string>): ParsedIndex[] {
  return (table.indexes ?? [])
    .filter((index) => !invalidIndexes.has(index.name) && !REINDEX_LEFTOVER.test(index.name))
    .map((index) => parseIndexDefinition(index.definition))
    .filter((p): p is ParsedIndex => p !== null);
}

/**
 * The table's indexes in groups that do the same job. A group of one is an
 * index, or a constraint's index, with no copy.
 *
 * A unique btree over plain columns is compared by its columns, so the index
 * behind a primary key or unique constraint (which the snapshot does not list
 * as an index) is caught copying it too. Anything else is compared by its
 * definition without the name: PostgreSQL prints two genuinely identical
 * indexes identically, expressions included.
 */
export function duplicateGroups(table: TableSnapshot, indexes: ParsedIndex[]): IndexCopy[][] {
  const groups = new Map<string, IndexCopy[]>();
  const addCopy = (key: string, copy: IndexCopy) =>
    groups.set(key, [...(groups.get(key) ?? []), copy]);
  const sameColumns = (keys: string[]) => `plain-unique:${JSON.stringify(keys)}`;
  // The primary key first, then unique constraints by name: the order in
  // which the copy to keep is chosen (see keptCopy).
  const owners = [
    ...(table.primaryKey ? [{ constraint: table.primaryKey, kind: "primary key" as const }] : []),
    ...sortedByName(table.uniqueConstraints).map((u) => ({
      constraint: u,
      kind: "unique constraint" as const,
    })),
  ];
  for (const { constraint, kind } of owners) {
    const keys = constraintKeys(constraint);
    if (keys) addCopy(sameColumns(keys), { name: constraint.name, constraint: kind, parsed: null });
  }
  for (const parsed of indexes) {
    const key =
      parsed.unique && parsed.method === "btree" && parsed.keys !== null
        ? sameColumns(parsed.keys)
        : `definition:${parsed.unique ? "UNIQUE " : ""}${parsed.method} ${parsed.tail}`;
    addCopy(key, { name: parsed.name, constraint: null, parsed });
  }
  return [...groups.values()];
}

/**
 * The copy a group keeps: the primary key's index, else a unique
 * constraint's (neither can be dropped without its constraint), else the
 * first in the snapshot's order. The duplicate-index fix drops the others,
 * and the fix for a missing primary key takes over only a copy kept here, so
 * the two never touch the same index.
 */
export function keptCopy(copies: IndexCopy[]): IndexCopy {
  return (
    copies.find((c) => c.constraint === "primary key") ??
    copies.find((c) => c.constraint !== null) ??
    copies[0]
  );
}

/** A non-unique index over plain columns: the only kind one index can cover for another. */
export type PlainIndex = ParsedIndex & { keys: string[] };

/**
 * An index that serves every lookup `narrow` serves, and more: the same
 * method, and `narrow`'s columns are the first columns of its own. Undefined
 * when there is none.
 *
 * Plain columns on both sides only (see plainKeys), compared exactly: an
 * operator class, a collation, an expression or a WHERE changes which lookups
 * an index serves. And never a unique index, which enforces a rule a wider
 * index does not.
 */
export function widerPlainIndex(narrow: ParsedIndex, plain: PlainIndex[]): PlainIndex | undefined {
  if (narrow.unique || narrow.keys === null) return undefined;
  const keys = narrow.keys;
  return plain.find(
    (other) =>
      other.method === narrow.method &&
      other.keys.length > keys.length &&
      keys.every((column, i) => other.keys[i] === column)
  );
}

/**
 * The fix for a group of indexes that do the same job.
 *
 * One copy is kept (see keptCopy): the constraint's index when a constraint
 * owns one (it cannot be dropped without the constraint), otherwise the first
 * in the snapshot's order. When two constraints own copies, dropping one means
 * dropping a constraint that code may name, so that is left to a person.
 * The copy kept goes in `keeps` (see withoutRepeatedDrops).
 *
 * `plainIndexes` is the table's non-unique indexes over plain columns, to
 * check whether the copy kept is itself covered by a wider one.
 */
export function duplicateFix(
  schema: string,
  table: TableSnapshot,
  copies: IndexCopy[],
  plainIndexes: PlainIndex[]
): Pick<PerfAdvice, "fix" | "fixKind" | "undo" | "keeps"> {
  const target = qualifiedName(schema, table.name);
  const owned = copies.filter((c) => c.constraint !== null);
  const plain = copies.filter((c) => c.constraint === null);
  const keep = keptCopy(copies);

  if (owned.length >= 2) {
    const lines = [
      comment`-- ${listInWords(owned.map((c) => quoteIdent(c.name)))} enforce the same rule on the same ` +
        `columns, so every write checks it more than once.`,
      comment`-- Keep ${keep.constraint === "primary key" ? "the primary key" : quoteIdent(keep.name)}. ` +
        `If nothing refers to the others by name (ON CONFLICT ON CONSTRAINT, say), drop them:`,
      ...owned
        .filter((c) => c !== keep)
        .map((c) => comment`-- ALTER TABLE ${target} DROP CONSTRAINT ${quoteIdent(c.name)};`),
      ...plain.map((c) => comment`-- DROP INDEX ${qualifiedName(schema, c.name)};`),
      `-- If a foreign key in another table uses one of these, its DROP stops with an error naming that key.`,
    ];
    return { fixKind: "decision", fix: lines.join("\n") };
  }

  const dropped = plain.filter((c) => c !== keep);
  const lines = [
    keep.constraint
      ? comment`-- Keeps ${quoteIdent(keep.name)}, the index behind the ${keep.constraint}; the others only repeat it.`
      : comment`-- Keeps ${quoteIdent(keep.name)}; the others only repeat it.`,
  ];
  // The copy kept can itself be the front of a wider index. Then the
  // redundant-index finding drops it too, and without this line the two
  // suggestions would read as if they disagreed. Each is safe alone, and run
  // together they leave the wider index, which serves every lookup these did.
  const wider = keep.parsed ? widerPlainIndex(keep.parsed, plainIndexes) : undefined;
  if (wider) {
    lines.push(
      comment`-- ${quoteIdent(keep.name)} is itself covered by the wider ${quoteIdent(wider.name)}, so another ` +
        comment`suggestion drops it too; together they leave ${quoteIdent(wider.name)} to serve these lookups.`
    );
  }
  for (const copy of dropped) {
    if (copy.parsed?.unique) {
      lines.push(
        comment`-- If a foreign key in another table relies on ${quoteIdent(copy.name)}, this DROP stops ` +
          `with an error naming that key, and the index stays.`
      );
    }
    lines.push(`DROP INDEX ${qualifiedName(schema, copy.name)};`);
  }
  return {
    fixKind: "change",
    fix: lines.join("\n"),
    keeps: qualifiedName(schema, keep.name),
    undo: dropped
      .map((c) => (c.parsed ? indexDefinitionSql(c.parsed, schema, table.name, true) : ""))
      .filter((sql) => sql !== "")
      .join("\n"),
  };
}
