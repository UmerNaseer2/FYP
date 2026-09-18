import { filterColumns, type PlanCatalog, type PlanStep } from "./query-analysis";
import { createIndexSql, quoteIdent } from "./perf-sql";
import { countOf } from "./plural";
import type { PerfAdvice } from "./perf-advice";

/**
 * Spec feature 9 — "Suggest composite indexes based on query and table usage
 * patterns."
 *
 * The Analyse tab already suggests a multi-column index for ONE query: it has
 * that query's plan in front of it, so it can read the columns straight off
 * the conditions (see indexAdvice in lib/query-analysis.ts). What no single
 * analysis can see is the pattern — that four different queries all search
 * `orders` on customer_id and status, and that one index would serve all four.
 * That is what this file is for, and it is the reason query_history stores
 * more than a score.
 *
 * Three steps, kept apart so each can be tested on its own:
 *
 *   1. planSearches   one plan  →  the (table, columns) it searched on. Run
 *                     once, when the query is analysed, because the plan is
 *                     the only honest source and it exists only then.
 *   2. aggregate      many stored searches  →  patterns, with how many
 *                     distinct queries and how many runs are behind each.
 *   3. compositeIndexAdvice  patterns + the indexes that exist  →  advice.
 *
 * Nothing here parses SQL text. A query's text says `WHERE status = $1 AND
 * customer_id = $2`; the plan says which of those the server could actually
 * search by, after the planner has finished rewriting it. Only the second one
 * is worth building an index on.
 */

/**
 * The columns of one table that one query searched on, ordered as an index on
 * them should list them.
 *
 * `equality` are the columns compared with `=`, and their order among
 * themselves does not matter to the planner — so they are stored SORTED, which
 * makes `WHERE a = 1 AND b = 2` and `WHERE b = 2 AND a = 1` the same pattern
 * rather than two. `range` is the one column compared with <, >, <= or >=,
 * which has to come last in the index because everything after it in the key
 * stops narrowing the search. See filterColumns for why there is only one.
 *
 * The schema is not stored: only searches on the schema being analysed are
 * kept, so it is always that one.
 */
export type ColumnSearch = {
  table: string;
  equality: string[];
  range: string | null;
};

/** A pattern across queries: one search, and how much of the history made it. */
export type SearchPattern = ColumnSearch & {
  /** Distinct queries (by fingerprint) that searched this way. */
  queries: number;
  /** Analyses in total — the same query run five times counts five. */
  runs: number;
};

/**
 * How many distinct queries have to share a pattern before it is worth an
 * index. Two, because one query already gets this advice on the Analyse tab
 * with its own plan in front of it, and repeating it here would just be the
 * same suggestion in a second place.
 */
export const COMPOSITE_MIN_QUERIES = 2;

/**
 * …or how many times a single query has to have been analysed. A query
 * somebody has come back to three times is a query that matters, even if it is
 * the only one shaped that way.
 */
export const COMPOSITE_MIN_RUNS = 3;

/** Below this many columns it is not a composite index and not this rule's job. */
const MIN_COLUMNS = 2;

/**
 * The most composite indexes this will suggest at once.
 *
 * Not a display limit — the rule genuinely stops looking. Every index slows
 * every INSERT and UPDATE on its table, so a screen offering fifteen new ones
 * is not helping; the top few by how many queries want them are the ones worth
 * arguing about, and the rest can be found again once those are in.
 */
export const MAX_COMPOSITE_SUGGESTIONS = 5;

/**
 * The searches one plan made against one schema.
 *
 * Both the Filter and the condition an index was matched on are read: a query
 * that already uses an index on `customer_id` and then filters the results on
 * `status` is exactly the case a composite index fixes, and looking only at
 * Filters would miss it.
 *
 * A step whose table is in another schema is skipped rather than recorded
 * against this one — `orders` in two schemas is two tables, and merging their
 * patterns would suggest an index on columns one of them does not have.
 */
export function planSearches(
  steps: PlanStep[],
  catalog: Partial<PlanCatalog>,
  schema: string
): ColumnSearch[] {
  /** table → the search so far, merged across that table's steps. */
  const byTable = new Map<string, { equality: Set<string>; range: string | null }>();

  for (const step of steps) {
    const table = step.relation;
    if (table === null) continue;
    // A plan taken without VERBOSE gives no schema. Rather than assume it is
    // this one, such a step is skipped: a wrong table is worse than no row.
    if (step.relationSchema !== schema) continue;

    const types: Record<string, string> = {};
    for (const column of catalog.columns?.[`${schema}.${table}`] ?? []) {
      types[column.name] = column.type;
    }

    for (const condition of [step.filter, step.joinCond]) {
      if (condition === null) continue;
      const found = filterColumns(condition, step.alias, table, types);
      if (found === null) continue;
      const entry = byTable.get(table) ?? { equality: new Set<string>(), range: null };
      for (const column of found.equality) entry.equality.add(column);
      entry.range ??= found.range;
      byTable.set(table, entry);
    }
  }

  const searches: ColumnSearch[] = [];
  for (const [table, entry] of byTable) {
    // A column compared both ways in the same query — `id = $1` in one step and
    // `id > $2` in another — is an equality column; that is the stronger of the
    // two and listing it twice would be a broken CREATE INDEX.
    const range = entry.range !== null && !entry.equality.has(entry.range) ? entry.range : null;
    const equality = [...entry.equality].sort();
    if (equality.length + (range === null ? 0 : 1) < MIN_COLUMNS) continue;
    searches.push({ table, equality, range });
  }
  return searches;
}

/** The columns an index for this search would be built on, in order. */
export function searchColumns(search: ColumnSearch): string[] {
  return search.range === null ? search.equality : [...search.equality, search.range];
}

/** Identity of a search, so two queries searching the same way group together. */
export function searchKey(search: ColumnSearch): string {
  return JSON.stringify([search.table, search.equality, search.range]);
}

/**
 * Stored searches into patterns, commonest first.
 *
 * `runs` is the list as it comes out of the database: one entry per analysis,
 * each carrying the fingerprint of the query it came from. A run whose searches
 * were never recorded (an older row, so `searches` is null) is left out
 * entirely rather than counted as a run that searched on nothing.
 */
export function aggregateSearches(
  runs: { fingerprint: string; searches: ColumnSearch[] | null }[]
): SearchPattern[] {
  const found = new Map<string, { search: ColumnSearch; fingerprints: Set<string>; runs: number }>();

  for (const run of runs) {
    if (run.searches === null) continue;
    // The same table can only be searched one way per query — planSearches
    // merges a query's steps per table — so there is nothing to de-duplicate
    // within a run.
    for (const search of run.searches) {
      const key = searchKey(search);
      const entry = found.get(key) ?? { search, fingerprints: new Set<string>(), runs: 0 };
      entry.fingerprints.add(run.fingerprint);
      entry.runs += 1;
      found.set(key, entry);
    }
  }

  return [...found.values()]
    .map(({ search, fingerprints, runs: count }) => ({
      ...search,
      queries: fingerprints.size,
      runs: count,
    }))
    .sort((a, b) => b.queries - a.queries || b.runs - a.runs || a.table.localeCompare(b.table));
}

/**
 * True when an index that already exists answers this search.
 *
 * The rule is the one PostgreSQL actually follows: an index helps a search if
 * its leading columns are the equality columns — in any order among themselves,
 * which is why this compares sets — and, when there is a range column, the next
 * column after them is that one. Anything after that is irrelevant here: a
 * wider index still serves a narrower search.
 *
 * Extra columns in the WRONG place are not: an index on (status, created_at,
 * customer_id) does not serve a search on (customer_id, status), because the
 * server cannot skip past created_at.
 */
export function indexServesSearch(index: { columns: string[] }, search: ColumnSearch): boolean {
  const lead = index.columns.slice(0, search.equality.length);
  if (lead.length < search.equality.length) return false;
  const wanted = new Set(search.equality);
  if (lead.length !== wanted.size || !lead.every((c) => wanted.has(c))) return false;
  if (search.range === null) return true;
  return index.columns[search.equality.length] === search.range;
}

/**
 * Advice for the patterns no existing index serves.
 *
 * `indexes` is table name → the indexes on it, and only the ones PostgreSQL
 * will actually use should be passed: an invalid index serves nothing, and
 * counting it would silence a suggestion that is still needed.
 *
 * A PARTIAL index (one with a WHERE) never counts as serving a pattern, because
 * whether it does depends on whether each query's own WHERE implies its
 * predicate, and that is not something this can work out. Rather than guess
 * either way, the suggestion is still made and the partial index is named in
 * it, so the reader can see the thing this rule could not decide.
 *
 * `takenNames` is every relation name already in the schema, so a suggested
 * index cannot be given a name something else holds. createIndexSql appends to
 * it, which is what stops two suggestions in one run colliding with each other.
 *
 * Severity is "medium" at most. A missing composite index makes queries slower
 * than they need to be; it does not make anything wrong, and it is not in the
 * same class as a table with no primary key.
 */
export function compositeIndexAdvice(
  schema: string,
  patterns: SearchPattern[],
  indexes: Record<string, { name: string; columns: string[]; predicate: string | null }[]>,
  takenNames: string[],
  windowDays: number
): PerfAdvice[] {
  const advice: PerfAdvice[] = [];
  const taken = [...takenNames];

  for (const pattern of patterns) {
    if (pattern.queries < COMPOSITE_MIN_QUERIES && pattern.runs < COMPOSITE_MIN_RUNS) continue;

    const columns = searchColumns(pattern);
    if (columns.length < MIN_COLUMNS) continue;

    const onTable = indexes[pattern.table] ?? [];
    const covering = onTable.filter((index) => indexServesSearch(index, pattern));
    if (covering.some((index) => index.predicate === null)) continue;

    const statement = createIndexSql(schema, pattern.table, columns, taken);
    taken.push(statement.name);

    // What the reader is most likely to have instead: single-column indexes on
    // some of these. Naming them is the difference between "add this index"
    // and advice that explains why the ones already there are not enough.
    const singles = onTable
      .filter((index) => index.columns.length === 1 && columns.includes(index.columns[0]))
      .map((index) => index.name);

    const howOften =
      pattern.queries >= COMPOSITE_MIN_QUERIES
        ? `${countOf(pattern.queries, "different query", "different queries")} analysed here ` +
          `searched it this way`
        : `the same query has been analysed ${pattern.runs} times and searches it this way ` +
          `every time`;

    advice.push({
      id: "composite-index-pattern",
      severity: pattern.queries >= 3 ? "medium" : "low",
      title: "Several queries search this table on the same columns together",
      object: `${pattern.table} (${columns.join(", ")})`,
      detail:
        `In the last ${windowDays} days, ${howOften}: ` +
        `${columns.map((c) => `${pattern.table}.${c}`).join(" and ")}. ` +
        (covering.length > 0
          ? `There is a partial index on these columns (${covering
              .map((index) => index.name)
              .join(", ")}), which only helps a query whose own WHERE matches its ` +
            `condition — this cannot tell whether these queries do, so it is still listed. `
          : "") +
        (singles.length > 0
          ? `There are single-column indexes on some of them (${singles.join(", ")}), and the ` +
            `server can only lead with one of those per scan — the rest of the columns are ` +
            `checked row by row afterwards. `
          : `No index leads with these columns, so the server narrows by none of them. `) +
        `One index across all ${columns.length} lets it find the matching rows directly.`,
      fix:
        `-- ${howOften.charAt(0).toUpperCase()}${howOften.slice(1)}.\n` +
        `-- Equality columns first, ` +
        (pattern.range === null
          ? `in alphabetical order because their order among themselves\n-- does not change what the index can answer.\n`
          : `then ${quoteIdent(pattern.range)} last: it is compared with a\n` +
            `-- range, and nothing after a range column in an index narrows anything.\n`) +
        statement.sql,
      fixKind: "change",
      undo: statement.undo,
      table: pattern.table,
      action: {
        label: "See these queries",
        href: `/performance?tab=history&schema=${encodeURIComponent(schema)}`,
      },
    });

    // Adding an index costs every write to the table and takes disk. Two or
    // three of these are advice; twenty is a second problem, so the rule stops.
    if (advice.length >= MAX_COMPOSITE_SUGGESTIONS) break;
  }

  return advice;
}
