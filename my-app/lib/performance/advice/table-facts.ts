// Performance advice: facts about a table that several rules need.
//
// Holds which column lists an index already covers, which foreign keys have
// an index (foreignKeyIndexes), the names already taken in a schema, and
// the columns of a partition key.

import type { IndexSnapshot, SchemaSnapshot, TableSnapshot } from "../../postgres";
import { NAME, singleName, splitList } from "./pg-text";

/**
 * Column lists that can serve as the leading edge of a lookup.
 *
 * A foreign key on (a, b) is supported by any index whose FIRST columns are
 * a then b — the index does not have to stop there. Both the primary key and
 * every unique constraint have an index behind them that the snapshot does not
 * list separately (see the note on IndexSnapshot in lib/postgres/), so they
 * have to be added by hand or every primary key column would look unindexed.
 *
 * An index PostgreSQL has marked invalid is left out. The planner will not use
 * one, so it covers nothing: a foreign key whose only index is a leftover from
 * a CREATE INDEX CONCURRENTLY that failed still makes every delete from the
 * parent table read this whole table, and the rule that would have said so was
 * counting the broken index as the answer. The list comes from the statistics
 * pass and is empty when that pass could not run, which puts the rule back
 * where it was rather than making it guess.
 *
 * The primary key and unique constraints are added without that check, because
 * the snapshot records their columns and not the name of the index behind them.
 * A constraint whose index is invalid is close to impossible to produce — the
 * constraint cannot be created from one — so the gap is theoretical.
 *
 * Returns null when this table's snapshot predates index capture, which is the
 * caller's signal to skip rather than guess.
 */
export function indexPrefixes(
  table: TableSnapshot,
  invalidIndexes: ReadonlySet<string>
): string[][] | null {
  if (!table.indexes) return null;
  const prefixes: string[][] = [];
  if (table.primaryKey) prefixes.push(table.primaryKey.columns);
  for (const unique of table.uniqueConstraints) prefixes.push(unique.columns);
  for (const index of table.indexes) {
    if (servesLookups(index) && !invalidIndexes.has(index.name)) prefixes.push(index.columns);
  }
  return prefixes;
}

/**
 * Whether an index can serve a lookup by its leading columns. An expression
 * index has no column entries, and a partial index only covers the rows its
 * WHERE matches — neither can be relied on to support an arbitrary lookup, so
 * neither counts.
 */
function servesLookups(index: IndexSnapshot): boolean {
  return index.columns.length > 0 && !index.predicate;
}

/**
 * The invalid index that would have covered these columns, or null.
 *
 * Only ever asked about a key the rules have already decided is uncovered, so
 * finding one means the index is there and broken rather than missing. The
 * first is enough: they are all the same answer, "rebuild what is already
 * here", and naming one of them is what points the reader at its finding.
 */
export function broughtBackByReindex(
  table: TableSnapshot,
  columns: string[],
  invalidIndexes: ReadonlySet<string>
): string | null {
  const found = table.indexes?.find(
    (index) =>
      invalidIndexes.has(index.name) &&
      servesLookups(index) &&
      isCoveredBy(columns, [index.columns])
  );
  return found?.name ?? null;
}

/** True when `columns` are the leading columns of one of the given prefixes. */
export function isCoveredBy(columns: string[], prefixes: string[][]): boolean {
  const wanted = columns.map((c) => c.toLowerCase());
  return prefixes.some((prefix) => {
    if (prefix.length < wanted.length) return false;
    return wanted.every((c, i) => prefix[i]?.toLowerCase() === c);
  });
}

/**
 * A foreign key, and the indexes on its table it can be checked through.
 *
 * PostgreSQL checks a foreign key from the other end too: deleting a row, or
 * changing its key, looks for rows that still refer to it. That look-up needs
 * an index whose first columns are the key's columns, or it reads the whole
 * table. The route reads these from the snapshot and hands them to
 * analyzeTableStats, so an unused index is not offered for DROP when it is the
 * last one serving a key: the foreign-key rule (schema-rules.ts) would only ask for it back.
 */
export type ForeignKeyIndexes = {
  /** The table the key is on. */
  table: string;
  /** The foreign key's own name. */
  name: string;
  columns: string[];
  /** The table it points at; null when the snapshot does not say. */
  referencedTable: string | null;
  /** Every index on `table` whose first columns are the key's columns. */
  indexes: string[];
};

/**
 * Every foreign key in the snapshot that only plain indexes serve, with those
 * indexes. A key that the primary key or a unique constraint also serves is
 * left out: a constraint's index is never offered for DROP, so the key keeps
 * it. Indexes count exactly as they do for the foreign-key rule (servesLookups,
 * isCoveredBy, and not invalid), so "no index left" here means that rule would
 * fire — the two have to agree or this list would protect an index from DROP
 * on the strength of a key the other rule says is unindexed anyway.
 */
export function foreignKeyIndexes(
  snapshot: SchemaSnapshot,
  invalidIndexes: ReadonlySet<string> = new Set()
): ForeignKeyIndexes[] {
  const found: ForeignKeyIndexes[] = [];
  for (const table of snapshot.tables) {
    // No record of indexes: nothing to protect, and nothing to guess.
    if (!table.indexes) continue;
    const byConstraint = [
      ...(table.primaryKey ? [table.primaryKey.columns] : []),
      ...table.uniqueConstraints.map((u) => u.columns),
    ];
    for (const fk of table.foreignKeys) {
      if (isCoveredBy(fk.columns, byConstraint)) continue;
      const indexes = table.indexes
        .filter(
          (index) =>
            servesLookups(index) &&
            !invalidIndexes.has(index.name) &&
            isCoveredBy(fk.columns, [index.columns])
        )
        .map((index) => index.name);
      if (indexes.length === 0) continue;
      found.push({
        table: table.name,
        name: fk.name,
        columns: fk.columns,
        referencedTable: fk.referencedTable,
        indexes,
      });
    }
  }
  return found;
}

/**
 * Every name in the schema that a new index could collide with.
 *
 * Tables, indexes, views and sequences share one namespace in a schema, and
 * the index behind a primary key, unique or exclusion constraint takes the
 * constraint's name, so all of those count. Types are added too: cheap, and a
 * name that clashes with nothing is all that is wanted. The caller adds each
 * name it suggests, so two suggestions in one report never pick the same one.
 */
export function relationNames(snapshot: SchemaSnapshot): Set<string> {
  const names = new Set<string>();
  for (const table of snapshot.tables) {
    names.add(table.name);
    for (const index of table.indexes ?? []) names.add(index.name);
    if (table.primaryKey) names.add(table.primaryKey.name);
    for (const c of [...table.uniqueConstraints, ...table.excludeConstraints]) names.add(c.name);
  }
  for (const view of snapshot.views ?? []) names.add(view.name);
  for (const sequence of snapshot.sequences ?? []) names.add(sequence.name);
  for (const type of snapshot.types ?? []) names.add(type.name);
  return names;
}

/** Every constraint name on one table: a new constraint must not reuse one. */
export function constraintNames(table: TableSnapshot): string[] {
  const constraints = [
    ...table.uniqueConstraints,
    ...table.checkConstraints,
    ...table.excludeConstraints,
    ...table.foreignKeys,
  ];
  return [...(table.primaryKey ? [table.primaryKey.name] : []), ...constraints.map((c) => c.name)];
}

/**
 * A copy of the list in name order, compared character by character rather
 * than by locale, so the same schema always leads to the same choice.
 */
export function sortedByName<T extends { name: string }>(list: T[]): T[] {
  return [...list].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
}

/** "id", or "row_id", "row_id_2", … when the table already has that column. */
export function freeColumnName(table: TableSnapshot): string {
  const used = new Set(table.columns.map((c) => c.name));
  if (!used.has("id")) return "id";
  if (!used.has("row_id")) return "row_id";
  let n = 2;
  while (used.has(`row_id_${n}`)) n += 1;
  return `row_id_${n}`;
}

/** "a", "a and b", "a, b and c" — for column lists inside a sentence. */
export function listInWords(names: string[]): string {
  return names.length <= 1
    ? names.join("")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The columns of a partition key, `RANGE (created_at)`, and whether they are
 * plain columns. "expression" when any part of the key is computed; "options"
 * when a column carries a COLLATE or an operator class.
 */
export function partitionKeyColumns(
  key: string | null
): { kind: "columns" | "options"; columns: string[] } | { kind: "expression" } {
  const match = key ? /^\w+ \(([\s\S]*)\)$/.exec(key.trim()) : null;
  if (!match) return { kind: "expression" };
  const columns: string[] = [];
  let kind: "columns" | "options" = "columns";
  for (const item of splitList(match[1])) {
    if (item.includes("(")) return { kind: "expression" };
    const plain = singleName(item);
    const leading = new RegExp(String.raw`^(${NAME})\s`).exec(item);
    const name = plain ?? (leading ? singleName(leading[1]) : null);
    if (name === null) return { kind: "expression" };
    if (plain === null) kind = "options";
    columns.push(name);
  }
  return { kind, columns };
}
