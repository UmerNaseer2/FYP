import type { ConstraintSnapshot, IndexSnapshot, SchemaSnapshot, TableSnapshot } from "./postgres";
import {
  LARGE_TABLE_ROWS,
  constraintName,
  createIndexSql,
  indexName,
  qualifiedName,
  quoteIdent,
  type FixKind,
} from "./perf-sql";
import { countOf } from "./plural";

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
 * Every fix also says what kind of thing it is (FixKind, in lib/perf-sql.ts):
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
 */

export type AdviceSeverity = "high" | "medium" | "low";

export type PerfAdvice = {
  /** Stable rule id — used for grouping, filtering and tests. */
  id: string;
  severity: AdviceSeverity;
  /** One line naming what is wrong. */
  title: string;
  /** What it is wrong about: "orders" or "orders.customer_id". */
  object: string;
  /** Why it costs something. */
  detail: string;
  /** What to do instead: SQL, comments, or both, as `fixKind` says. */
  fix: string;
  /** What kind of thing `fix` is, so the screen can say before anyone copies it. */
  fixKind: FixKind;
  /**
   * The statements that take a change back out, when there are any. Shown under
   * the fix; comment lines only when undoing depends on something the fix may
   * already have removed.
   */
  undo?: string;
  /**
   * The table a foreign-key finding is on. attachForeignKeyIndexes uses it to
   * find the whole-table-read finding for the same table.
   */
  table?: string;
  /**
   * The index a duplicate-index or redundant-index finding keeps, written the
   * way its DROP INDEX would name it ("public"."orders_a"). withoutRepeatedDrops
   * uses it to leave out an unused-index finding for that same index: run
   * together, the two fixes would drop every index the lookups could use.
   */
  keeps?: string;
  /** A link to the place in the app where the next step is taken. */
  action?: { label: string; href: string };
  /**
   * Why this fix starts unticked, as one sentence for the reader, or absent
   * when it starts ticked like everything else.
   *
   * There is one reason so far: the app could not read which indexes
   * PostgreSQL has marked invalid, so a suggestion to drop an index cannot
   * promise it is dropping the spare one rather than the working one.
   * Unticking rather than hiding is deliberate — the finding is probably still
   * right, and the person reading it can see the index for themselves.
   */
  startUnticked?: string;
};

/**
 * A finding plus which of the two passes produced it.
 *
 * Defined here rather than in the advice route so the route and the screen
 * (components/studio/PerfAdviceList.tsx) share one definition. The screen
 * imports it with `import type`, which is erased at build time, so no server
 * code reaches the browser bundle.
 */
export type AdviceItem = PerfAdvice & {
  origin: "structure" | "statistics";
};

/** The whole response of GET /api/performance/advice. */
export type AdviceView = {
  connectionName: string;
  database: string;
  schema: string;
  advice: AdviceItem[];
  counts: { high: number; medium: number; low: number; total: number };
  /** How many tables the structural pass looked at. */
  tablesAnalyzed: number;
  /**
   * Why the statistics pass produced nothing, as sentences for the screen
   * (see describeStatsError), or null when it ran. Not an error: the
   * structural advice still comes back. When the pass failed before it read
   * which indexes are invalid, a last sentence says so, because the
   * structural rules then cannot tell an invalid index from a usable one.
   */
  statsUnavailable: string | null;
};

/** Severity order for sorting — high first, and stable within a severity. */
const SEVERITY_RANK: Record<AdviceSeverity, number> = { high: 0, medium: 1, low: 2 };

/**
 * Sort advice the way a reader wants to read it: worst first, then by object.
 *
 * Generic so a caller that has added a field of its own — which half of the
 * screen a finding came from, say — gets its own type back rather than having
 * that field erased on the way through.
 */
export function sortAdvice<T extends PerfAdvice>(advice: T[]): T[] {
  return [...advice].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.object.localeCompare(b.object) ||
      a.id.localeCompare(b.id)
  );
}

/** How many of each severity, for a header that has to fit on one line. */
export function summarizeAdvice(advice: PerfAdvice[]): {
  high: number;
  medium: number;
  low: number;
  total: number;
} {
  return {
    high: advice.filter((a) => a.severity === "high").length,
    medium: advice.filter((a) => a.severity === "medium").length,
    low: advice.filter((a) => a.severity === "low").length,
    total: advice.length,
  };
}

/**
 * How long the statistics pass may run, and wait for a lock, before it gives
 * up. Kept here rather than in the route so describeStatsError, which explains
 * a timeout to the reader, quotes the same numbers the route sets.
 */
export const STATS_STATEMENT_TIMEOUT_MS = 5_000;
export const STATS_LOCK_TIMEOUT_MS = 2_000;

/**
 * How long the structure pass may wait for a lock another session holds.
 * Longer than the statistics pass gets, because without the structure there
 * are no suggestions at all; short enough that a table held by a running
 * ALTER TABLE gets a sentence saying so within seconds, instead of the tab
 * waiting out the snapshot's own 30-second limit and then blaming the
 * connection. describeStructureError quotes it.
 */
export const STRUCTURE_LOCK_TIMEOUT_MS = 5_000;

// ── Reading PostgreSQL's own text ────────────────────────────────────────────
// The snapshot and the statistics views hand back SQL text: index definitions,
// column defaults, partition keys. The helpers below read just enough of it to
// print correct SQL back, and return null for anything they do not recognise,
// so the rule that asked skips (or explains in words) rather than guessing.

/**
 * The names in a dotted SQL name:
 *
 *   shop.orders      →  ["shop", "orders"]
 *   "Order Lines"    →  ["Order Lines"]
 *   "a""b".c         →  ['a"b', "c"]
 *
 * A quoted part keeps its exact spelling, with "" read as one quote. An
 * unquoted part is taken as written: PostgreSQL only prints a name without
 * quotes when it is already lower case. Null for anything else — a space, a
 * bracket, an unfinished quote — which is how `name DESC` or `lower(email)` is
 * told apart from a plain column.
 */
function identifierParts(text: string): string[] | null {
  const parts: string[] = [];
  let i = 0;
  for (;;) {
    let part = "";
    if (text[i] === '"') {
      i += 1;
      for (;;) {
        if (i >= text.length) return null; // the quote never closes
        if (text[i] === '"') {
          if (text[i + 1] !== '"') break; // the closing quote
          i += 1; // "" stands for one quote inside the name
        }
        part += text[i];
        i += 1;
      }
      i += 1; // past the closing quote
    } else {
      while (i < text.length && /[^\s".(),]/.test(text[i])) {
        part += text[i];
        i += 1;
      }
    }
    if (part === "") return null;
    parts.push(part);
    if (i === text.length) return parts;
    if (text[i] !== ".") return null;
    i += 1;
  }
}

/** The one name in `text`, or null when it is anything but a single name. */
function singleName(text: string): string | null {
  const parts = identifierParts(text.trim());
  return parts !== null && parts.length === 1 ? parts[0] : null;
}

/**
 * Split on the commas that separate list items, not the ones inside quotes or
 * brackets: `a, "b,c", lower(d, e)` → ["a", '"b,c"', "lower(d, e)"].
 */
function splitList(text: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== null) {
      // A doubled quote closes and at once reopens, which comes to the same.
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
    } else if (ch === "," && depth === 0) {
      items.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  items.push(text.slice(start).trim());
  return items;
}

/**
 * The column names in a key list when every item is a plain column — no
 * expression, no DESC, no COLLATE, no operator class — or null.
 *
 * Only a list like that can be compared name for name with another one, or
 * turned into a primary key; everything else is compared as text or skipped.
 */
function plainKeys(list: string): string[] | null {
  const names = splitList(list).map(singleName);
  return names.every((n): n is string => n !== null) ? names : null;
}

/** One index definition, as PostgreSQL prints it, taken apart. */
type ParsedIndex = {
  unique: boolean;
  name: string;
  /**
   * "ON ONLY": how PostgreSQL prints the index of a partitioned table. Run as
   * written it would build the parent's index alone and leave it invalid.
   */
  only: boolean;
  /** btree, hash, gin, … */
  method: string;
  /** Everything after the method: "(customer_id)", "(lower(email)) WHERE …". */
  tail: string;
  /** The key columns when the tail is nothing but plain columns, else null. */
  keys: string[] | null;
};

/** A name as PostgreSQL prints one: quoted with "" inside, or bare. */
const NAME = String.raw`(?:"(?:[^"]|"")*"|[^\s".(),]+)`;
const INDEX_DEFINITION = new RegExp(
  String.raw`^CREATE (UNIQUE )?INDEX (${NAME}) ON (ONLY )?${NAME}(?:\.${NAME})? USING (\w+) ([\s\S]+)$`
);

/**
 * `CREATE [UNIQUE] INDEX name ON [ONLY] [schema.]table USING method (…)…`,
 * the shape pg_get_indexdef always prints, taken apart — or null, and the
 * caller leaves that index alone.
 */
function parseIndexDefinition(definition: string): ParsedIndex | null {
  const match = INDEX_DEFINITION.exec(definition.trim());
  if (!match) return null;
  const name = singleName(match[2]);
  if (name === null) return null;
  const tail = match[5].trim();
  const bracketed = /^\(([^()]*)\)$/.exec(tail);
  return {
    unique: Boolean(match[1]),
    name,
    only: Boolean(match[3]),
    method: match[4],
    tail,
    keys: bracketed ? plainKeys(bracketed[1]) : null,
  };
}

/**
 * An index definition as SQL to paste back: its name and table quoted and
 * schema-qualified, then the rest exactly as PostgreSQL printed it.
 *
 * The table is the caller's, not the one parsed out of the text: the snapshot
 * prints it without its schema, and the caller knows both halves for certain.
 *
 * ONLY is left out, so the index is built on every partition again as it was
 * before, and a comment says so.
 *
 * `stripped` is true for definitions from the snapshot, which have their own
 * schema's name taken out of them (see stripSchemaFromExpr in lib/postgres.ts).
 * Plain key columns name nothing from the schema, but an expression or a WHERE
 * can — a function, a type — and those only mean the same thing again with
 * that schema on the search_path. Definitions from the statistics pass are
 * read with nothing on the search_path, so they arrive fully qualified.
 */
function indexDefinitionSql(
  parsed: ParsedIndex,
  schema: string,
  table: string,
  stripped: boolean
): string {
  const lines: string[] = [];
  if (parsed.only) {
    lines.push(
      "-- On a partitioned table this also rebuilds each partition's index, under names PostgreSQL picks."
    );
  }
  if (stripped && parsed.keys === null) {
    lines.push(
      comment`-- Any name from ${quoteIdent(schema)} inside this definition is written without ` +
        comment`the schema, so run it with ${quoteIdent(schema)} on the search_path.`
    );
  }
  lines.push(
    `CREATE ${parsed.unique ? "UNIQUE " : ""}INDEX ${quoteIdent(parsed.name)} ` +
      `ON ${qualifiedName(schema, table)} USING ${parsed.method} ${parsed.tail};`
  );
  return lines.join("\n");
}

/**
 * The columns of a PRIMARY KEY or UNIQUE constraint whose index is a plain
 * btree over plain columns — `PRIMARY KEY (id)`, `UNIQUE (email)` — or null.
 *
 * Anything more (NULLS NOT DISTINCT, INCLUDE, DEFERRABLE) makes its index
 * behave differently from a plain unique index on the same columns, so it is
 * not treated as a copy of one.
 */
function constraintKeys(constraint: ConstraintSnapshot): string[] | null {
  const match = /^(?:PRIMARY KEY|UNIQUE) \(([^()]*)\)$/.exec(constraint.definition.trim());
  return match ? plainKeys(match[1]) : null;
}

/**
 * The sequence named in a serial column's default, `nextval('…'::regclass)`,
 * as schema and name — or null when the default is written some other way.
 *
 * The quoted middle is read as a string literal ('' is one quote) and then as
 * a dotted name. One part means the snapshot's own schema: the snapshot takes
 * that schema's name out of every default (see stripSchemaFromExpr in
 * lib/postgres.ts), and nothing else is on its search_path, so a sequence in
 * any other schema keeps its schema in the text.
 */
function serialSequence(
  columnDefault: string,
  schema: string
): { schema: string; name: string } | null {
  const opening = "nextval('";
  if (!columnDefault.toLowerCase().startsWith(opening)) return null;
  let literal: string | null = null;
  let text = "";
  for (let i = opening.length; i < columnDefault.length; i += 1) {
    if (columnDefault[i] === "'") {
      if (columnDefault[i + 1] !== "'") {
        literal = text;
        break;
      }
      i += 1; // '' stands for one quote inside the literal
    }
    text += columnDefault[i];
  }
  const parts = literal === null ? null : identifierParts(literal);
  if (parts === null) return null;
  if (parts.length === 1) return { schema, name: parts[0] };
  if (parts.length === 2) return { schema: parts[0], name: parts[1] };
  return null;
}


/**
 * A tag for template strings that hold comment lines:
 *
 *   comment`-- DROP INDEX ${name};`
 *
 * Every value put into the text has its line breaks turned into spaces; the
 * text around the values keeps its own. PostgreSQL allows any character in a
 * quoted name, a line break included, and inside a comment line that break
 * would start a new line that is not a comment: pasting a fix that is meant to
 * run nothing would run whatever the name went on to say. The commented-out
 * statement then names the object with a space instead, which fails loudly if
 * someone runs it rather than doing something else.
 *
 * Only for comment text. A statement meant to run keeps its names exactly.
 */
function comment(strings: TemplateStringsArray, ...values: unknown[]): string {
  let text = strings[0];
  values.forEach((value, i) => {
    text += String(value).replace(/[\r\n]+/g, " ") + strings[i + 1];
  });
  return text;
}
/** A SQL string literal: quoted, with any quote inside doubled. */
function literal(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/**
 * Lower-cased type name with any length/precision stripped: "varchar(30)" →
 * "varchar", "numeric(10,2)" → "numeric".
 *
 * Deliberately removes the parenthetical rather than truncating at it. Postgres
 * renders a precision in the MIDDLE of a two-word type name — format_type gives
 * "timestamp(3) with time zone" — so truncating turned a timestamptz column
 * into the bare string "timestamp" and the rule below then offered to convert
 * an already-zoned column to timestamptz.
 */
function baseType(typeDisplay: string): string {
  return typeDisplay
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Column lists that can serve as the leading edge of a lookup.
 *
 * A foreign key on (a, b) is supported by any index whose FIRST columns are
 * a then b — the index does not have to stop there. Both the primary key and
 * every unique constraint have an index behind them that the snapshot does not
 * list separately (see the note on IndexSnapshot in lib/postgres.ts), so they
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
function indexPrefixes(
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
function broughtBackByReindex(
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
function isCoveredBy(columns: string[], prefixes: string[][]): boolean {
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
 * last one serving a key: the foreign-key rule above would only ask for it back.
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
function relationNames(snapshot: SchemaSnapshot): Set<string> {
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
function constraintNames(table: TableSnapshot): string[] {
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
function sortedByName<T extends { name: string }>(list: T[]): T[] {
  return [...list].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
}

/** "id", or "row_id", "row_id_2", … when the table already has that column. */
function freeColumnName(table: TableSnapshot): string {
  const used = new Set(table.columns.map((c) => c.name));
  if (!used.has("id")) return "id";
  if (!used.has("row_id")) return "row_id";
  let n = 2;
  while (used.has(`row_id_${n}`)) n += 1;
  return `row_id_${n}`;
}

/** "a", "a and b", "a, b and c" — for column lists inside a sentence. */
function listInWords(names: string[]): string {
  return names.length <= 1
    ? names.join("")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The columns of a partition key, `RANGE (created_at)`, and whether they are
 * plain columns. "expression" when any part of the key is computed; "options"
 * when a column carries a COLLATE or an operator class.
 */
function partitionKeyColumns(
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
function primaryKeyFix(
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

/**
 * The name REINDEX CONCURRENTLY gives the copy it builds (_ccnew) and the
 * index it replaces (_ccold), with a number added when that name is taken. A
 * rebuild that stops part-way leaves one of them behind, marked invalid.
 */
const REINDEX_LEFTOVER = /_cc(new|old)\d*$/;

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
 * The table's indexes that the rules below may keep, take over or compare,
 * parsed.
 *
 * An invalid index is left out. Queries never use it, so it copies nothing,
 * and counted as a copy it could be the one kept while the valid one is
 * dropped; PostgreSQL also refuses to make it a primary key. Its own finding
 * (invalid-index) says what to do with it. A copy that REINDEX CONCURRENTLY
 * left behind is known by its name too, for when the statistics pass could
 * not say which indexes are invalid.
 */
function usableIndexes(table: TableSnapshot, invalidIndexes: ReadonlySet<string>): ParsedIndex[] {
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
function duplicateGroups(table: TableSnapshot, indexes: ParsedIndex[]): IndexCopy[][] {
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
function keptCopy(copies: IndexCopy[]): IndexCopy {
  return (
    copies.find((c) => c.constraint === "primary key") ??
    copies.find((c) => c.constraint !== null) ??
    copies[0]
  );
}

/** A non-unique index over plain columns: the only kind one index can cover for another. */
type PlainIndex = ParsedIndex & { keys: string[] };

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
function widerPlainIndex(narrow: ParsedIndex, plain: PlainIndex[]): PlainIndex | undefined {
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
function duplicateFix(
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

/**
 * Every schema-structure rule, run over one snapshot.
 *
 * The rules are inline rather than a registry of rule objects: there are a
 * dozen of them, each needs different parts of the table, and a table of
 * predicates would make every one of them harder to read than it is here.
 *
 * `invalidIndexes` names the indexes PostgreSQL has marked invalid, which the
 * snapshot does not record; the route takes them from the statistics pass,
 * and passes none when that pass could not run.
 */
export function analyzeSchemaPerformance(
  snapshot: SchemaSnapshot,
  invalidIndexes: ReadonlySet<string> = new Set()
): PerfAdvice[] {
  const advice: PerfAdvice[] = [];
  const schema = snapshot.schema;
  // Grows as indexes are suggested, so no two suggestions share a name.
  const relations = relationNames(snapshot);

  for (const table of snapshot.tables) {
    const object = table.name;
    const target = qualifiedName(schema, table.name);
    const isPartition = Boolean(table.partitioning?.partitionOf);
    const prefixes = indexPrefixes(table, invalidIndexes);
    const columnTypes = new Map(
      table.columns.map((c) => [c.name.toLowerCase(), baseType(c.typeDisplay)])
    );
    // Worked out once, so the rules that keep, take over or compare indexes
    // agree on which index each group keeps.
    const parsedIndexes = usableIndexes(table, invalidIndexes);
    const groups = duplicateGroups(table, parsedIndexes);

    // ── No primary key ───────────────────────────────────────────────────
    // A partition inherits its parent's key, so a missing one there is the
    // parent's problem and reporting it on every partition would bury the one
    // row that matters.
    if (!table.primaryKey && !isPartition) {
      advice.push({
        id: "no-primary-key",
        severity: "high",
        title: "Table has no primary key",
        object,
        detail:
          "Without a primary key there is no cheap way to address a single row: " +
          "every UPDATE and DELETE by identity has to be written against some " +
          "other column and may match more rows than intended. Logical " +
          "replication also refuses to publish updates to a table with no " +
          "replica identity.",
        ...primaryKeyFix(
          schema,
          table,
          relations,
          groups.map(keptCopy).flatMap((copy) => (copy.parsed ? [copy.parsed] : []))
        ),
      });
    }

    // ── Foreign key with nothing to look it up by ────────────────────────
    // Skipped entirely when the snapshot has no index record, because "no
    // index" and "no record of indexes" are not the same claim.
    if (prefixes) {
      for (const fk of table.foreignKeys) {
        if (isCoveredBy(fk.columns, prefixes)) continue;
        const cascades = fk.onDelete.toUpperCase().includes("CASCADE");
        const cost =
          `PostgreSQL indexes the side a foreign key POINTS AT, never the side ` +
          `that holds it. So a join through ${fk.name} scans ${table.name} in ` +
          `full, and so does every delete or key update on ` +
          `${fk.referencedTable ?? "the parent table"} — the server has to prove no ` +
          `child row still references the row being removed.` +
          (cascades
            ? " This key is ON DELETE CASCADE, so that full scan happens on every parent delete."
            : "");
        // The index that WOULD have served this key, if it were not invalid.
        // The list is only ever non-empty when the statistics pass ran, and
        // that pass is what raises the invalid-index finding, so naming it
        // here is a pointer at a finding the same screen is already showing.
        const broken = broughtBackByReindex(table, fk.columns, invalidIndexes);
        if (broken) {
          // Deliberately a decision and not a change: rebuilding the index
          // that is already there is cheaper than a second one on the same
          // columns, and the invalid-index finding carries that REINDEX. A
          // change here would put both statements in the fix script, and a
          // user who ticked the lot would end up with two identical indexes.
          advice.push({
            id: "foreign-key-not-indexed",
            severity: cascades ? "high" : "medium",
            title: "Foreign key's only index is invalid",
            object: `${table.name}.${fk.columns.join(", ")}`,
            detail:
              `${cost} The index that would cover it, ${quoteIdent(broken)}, is one PostgreSQL has ` +
              `marked invalid, and the planner never uses one of those — so this key is ` +
              `unindexed in practice. Its own suggestion on this screen rebuilds it.`,
            fix:
              comment`-- Nothing to run here. Rebuilding ${quoteIdent(broken)} is what fixes\n` +
              `-- this, and the suggestion about that index has the statement for it.\n` +
              `-- Adding a second index on the same columns would work too, and would\n` +
              `-- leave you with two once the rebuild finishes.`,
            fixKind: "decision",
            table: table.name,
          });
          continue;
        }
        const index = createIndexSql(schema, table.name, fk.columns, relations, {
          partitioned: Boolean(table.partitioning?.strategy),
        });
        relations.add(index.name);
        advice.push({
          id: "foreign-key-not-indexed",
          severity: cascades ? "high" : "medium",
          title: "Foreign key has no index on this side",
          object: `${table.name}.${fk.columns.join(", ")}`,
          detail: cost,
          fix: index.sql,
          fixKind: "change",
          undo: index.undo,
          table: table.name,
        });
      }
    }

    if (table.indexes) {
      // The ones a wider index can cover: the redundant-index rule compares
      // them, and the duplicate-index fix checks the copy it keeps against them.
      const plain = parsedIndexes.filter((p): p is PlainIndex => !p.unique && p.keys !== null);

      // ── Indexes that do the same job ───────────────────────────────────
      // The groups come from duplicateGroups, worked out before the
      // primary-key rule so that rule takes over only a copy kept here.
      for (const copies of groups) {
        if (copies.length < 2) continue;
        advice.push({
          id: "duplicate-index",
          severity: "medium",
          title:
            copies.length === 2
              ? "Two indexes with the same definition"
              : `${copies.length} indexes with the same definition`,
          object: `${table.name} (${copies.map((c) => c.name).join(", ")})`,
          detail:
            "Identical indexes cost the disk and the write work of every copy — " +
            "each INSERT, UPDATE and DELETE maintains all of them — and the " +
            "planner can only ever use one.",
          ...duplicateFix(schema, table, copies, plain),
        });
      }

      // ── An index whose columns are the front of another index ──────────
      // Only plain columns on both sides, compared exactly (widerPlainIndex):
      // an index with an operator class or a collation serves different
      // lookups than one without, even over the same column.
      for (const [i, narrow] of plain.entries()) {
        const sameAsNarrow = (o: PlainIndex) => o.method === narrow.method && o.tail === narrow.tail;
        // A second copy of an identical index is already dropped by the
        // duplicate finding above; two findings dropping one index is one too many.
        if (plain.slice(0, i).some(sameAsNarrow)) continue;
        const wider = widerPlainIndex(narrow, plain);
        if (!wider) continue;
        // Its identical copies, which the duplicate finding drops while it
        // keeps this one. Named here so the two findings read as two halves
        // of one clean-up, not as a disagreement.
        const copies = plain.filter((o) => o !== narrow && sameAsNarrow(o)).map((o) => o.name);
        advice.push({
          id: "redundant-index",
          severity: "low",
          title: "Index is already covered by a wider one",
          object: `${table.name}.${narrow.name}`,
          detail:
            `Any lookup ${narrow.name} can serve, ${wider.name} can serve too — ` +
            `an index on (${wider.keys.join(", ")}) is usable for a query that ` +
            `only constrains (${narrow.keys.join(", ")}). Keeping both pays the ` +
            `write cost twice for one capability.` +
            (copies.length === 0
              ? ""
              : copies.length === 1
                ? ` ${copies[0]} is an identical copy of ${narrow.name}; the suggestion for identical indexes drops it.`
                : ` ${listInWords(copies)} are identical copies of ${narrow.name}; the suggestion for identical indexes drops them.`),
          fix: `DROP INDEX ${qualifiedName(schema, narrow.name)};`,
          fixKind: "change",
          keeps: qualifiedName(schema, wider.name),
          undo: indexDefinitionSql(narrow, schema, table.name, true),
        });
      }

      // ── An index over a single boolean ─────────────────────────────────
      for (const index of table.indexes) {
        if (index.columns.length !== 1 || index.predicate || index.isUnique) continue;
        if (columnTypes.get(index.columns[0].toLowerCase()) !== "boolean") continue;
        const flag = quoteIdent(index.columns[0]);
        // The example key: a column the rare rows might be fetched or sorted
        // by. Not the primary key if anything else will do — that already
        // has an index, so it makes the example look pointless.
        const pk = new Set(table.primaryKey?.columns ?? []);
        const nonFlag = table.columns.filter((c) => baseType(c.typeDisplay) !== "boolean");
        const example =
          nonFlag.find((c) => !pk.has(c.name))?.name ?? table.primaryKey?.columns[0];
        advice.push({
          id: "boolean-index",
          severity: "low",
          title: "Index over a single boolean column",
          object: `${table.name}.${index.name}`,
          detail:
            "A boolean splits the table roughly in half, and the planner will " +
            "read the table directly rather than use an index that eliminates so " +
            "little. The index is maintained on every write and rarely chosen.",
          fixKind: "decision",
          fix:
            `-- Worth keeping only if one of the two values is rare. Then index just the\n` +
            `-- rare rows: the column the query fetches or sorts them by as the key, and\n` +
            `-- the boolean in the WHERE.` +
            (example
              ? comment` For example, if they are fetched by ${example}:\n` +
                comment`-- CREATE INDEX ON ${target} (${quoteIdent(example)}) WHERE ${flag};\n`
              : `\n`) +
            comment`-- Use WHERE NOT ${flag} instead if false is the rare value.\n` +
            `-- If neither value is rare, the index is not worth keeping:\n` +
            comment`-- DROP INDEX ${qualifiedName(schema, index.name)};`,
        });
      }

      // ── Enough indexes that writes are paying for them ─────────────────
      const indexCount =
        table.indexes.length + table.uniqueConstraints.length + (table.primaryKey ? 1 : 0);
      if (indexCount > 6) {
        advice.push({
          id: "many-indexes",
          severity: "low",
          title: `${indexCount} indexes on one table`,
          object,
          detail:
            "Every index is maintained inside every INSERT, UPDATE and DELETE on " +
            "this table, so writes slow down roughly in proportion to the count. " +
            "Past about half a dozen it is worth checking which ones the planner " +
            "actually chooses.",
          fixKind: "decision",
          // The unused-index rule cannot help on a partitioned table: the
          // server keeps its counters per partition, under each partition's
          // own index names, and not for the table's index as a whole.
          fix: table.partitioning?.strategy
            ? "-- The server counts index use per partition, not for this table as a whole,\n" +
              "-- so look this table's partitions up in pg_stat_user_indexes: an index whose\n" +
              "-- idx_scan is 0 on every partition has not been used by any query. Keep\n" +
              "-- unique indexes and the ones behind a primary key or unique constraint:\n" +
              "-- they enforce a rule even when no query reads them."
            : "-- Each index no query has used gets its own \"Index has not been used since\n" +
              "-- the counters started\" suggestion on this screen, when the server's usage\n" +
              "-- statistics could be read. Unique indexes and the ones behind a primary key\n" +
              "-- or unique constraint are left out of those: they enforce a rule even when\n" +
              "-- no query reads them.",
        });
      }
    }

    // ── Column-level rules ───────────────────────────────────────────────
    // Not on a partition: its columns are the parent's, PostgreSQL refuses to
    // change their type or make them identity columns on one partition alone,
    // and the parent's own finding already covers them.
    if (!isPartition) {
      for (const column of table.columns) {
        const type = baseType(column.typeDisplay);
        const col = quoteIdent(column.name);

        if (type === "timestamp without time zone" || type === "timestamp") {
          advice.push({
            id: "timestamp-without-timezone",
            severity: "medium",
            title: "Timestamp column carries no time zone",
            object: `${table.name}.${column.name}`,
            detail:
              "`timestamp without time zone` stores a wall clock and throws the " +
              "offset away, so the same value means different instants depending on " +
              "who reads it. Comparisons across zones, and any index used to serve " +
              "them, are then answering the wrong question.",
            // A decision, not a change: which zone the stored values were
            // written in is something only the people who wrote them know.
            fixKind: "decision",
            fix:
              // ALTER COLUMN ... TYPE writes the whole table out again under
              // ACCESS EXCLUSIVE (checked on PostgreSQL 17), so reads wait too.
              `-- Converting rewrites the whole table, and the table is blocked, reads included,\n` +
              `-- until that finishes. Each stored value has to be read as a time in some zone;\n` +
              `-- replace 'UTC' below with the zone the values were written in:\n` +
              comment`-- ALTER TABLE ${target} ALTER COLUMN ${col} TYPE ${zonedType(column.typeDisplay)} ` +
              comment`USING ${col} AT TIME ZONE 'UTC';\n` +
              `-- If a view reads this column, the ALTER stops with an error naming it.`,
          });
        }

        if (type === "character" || type === "bpchar") {
          advice.push({
            id: "blank-padded-char",
            severity: "low",
            title: "Column is character(n)",
            object: `${table.name}.${column.name}`,
            detail:
              "character(n) pads every value out to n with spaces and strips them " +
              "again on the way out, which costs storage on short values and makes " +
              "comparisons subtly different from text. PostgreSQL's own " +
              "documentation recommends against it; there is no performance " +
              "advantage over text.",
            fixKind: "change",
            fix:
              // Checked on PostgreSQL 17: the table is written out again under
              // ACCESS EXCLUSIVE, and 'ab' stored in character(10) comes out
              // as text of length 2.
              `-- This rewrites the table, and the table is blocked, reads included, until that\n` +
              `-- finishes. Trailing spaces are dropped from the stored values, which is how\n` +
              `-- they already compare.\n` +
              `-- If a view reads this column, the ALTER stops with an error naming it; nothing changes.\n` +
              `ALTER TABLE ${target} ALTER COLUMN ${col} TYPE text;`,
            undo: `ALTER TABLE ${target} ALTER COLUMN ${col} TYPE ${column.typeDisplay};`,
          });
        }

        // A `serial` column is an integer with a nextval default. Only an
        // integer one: a nextval default on a text column (a formatted code,
        // say) is not a serial, and an identity column has to be an integer.
        if (
          INTEGER_TYPES.has(type) &&
          column.columnDefault?.toLowerCase().startsWith("nextval(")
        ) {
          const sequence = serialSequence(column.columnDefault, schema);
          const base = {
            id: "serial-not-identity",
            severity: "low" as const,
            title: "Column uses serial rather than an identity",
            object: `${table.name}.${column.name}`,
            detail:
              "A serial column's sequence is a separate object with its own " +
              "permissions and its own way of being left behind by a dump, and " +
              "nothing stops a client writing straight past it. GENERATED AS " +
              "IDENTITY is the standard spelling and ties the sequence to the column.",
          };
          if (sequence === null) {
            advice.push({
              ...base,
              fixKind: "decision",
              fix:
                "-- This default does not name its sequence the usual way, so the steps are\n" +
                "-- set out here rather than written out:\n" +
                "--   1. make the column NOT NULL, if it is not already;\n" +
                "--   2. drop its default;\n" +
                "--   3. detach the old sequence from it with ALTER SEQUENCE and OWNED BY NONE;\n" +
                "--   4. add GENERATED BY DEFAULT AS IDENTITY to the column;\n" +
                "--   5. with setval, start the identity's new sequence where the old one would\n" +
                "--      go next, or above the column's highest value if that is higher.",
            });
          } else if (
            // A sequence in another schema, or one this column does not own,
            // may be shared: moving this column off it is fine, but advice to
            // drop it could break whatever else draws numbers from it.
            sequence.schema === schema &&
            sequenceBelongsTo(snapshot, sequence.name, table.name, column.name)
          ) {
            advice.push({ ...base, ...serialFix(schema, table.name, column, sequence.name) });
          }
        }
      }
    }

    // ── A wide, variable-length primary key ──────────────────────────────
    if (table.primaryKey) {
      const wide = table.primaryKey.columns.filter((c) => {
        const type = columnTypes.get(c.toLowerCase());
        return type === "text" || type === "character varying" || type === "varchar";
      });
      if (wide.length > 0) {
        advice.push({
          id: "text-primary-key",
          severity: "low",
          title: "Primary key is a text column",
          object: `${table.name}.${wide.join(", ")}`,
          detail:
            "Every foreign key pointing at this table stores a full copy of the " +
            "key, and so does every index entry on both sides. A long text key " +
            "makes all of them larger, which means fewer entries per page and more " +
            "pages read per lookup.",
          fixKind: "decision",
          fix:
            "-- If the text is genuinely the identity, leave it. If it is a code that\n" +
            "-- happens to be unique, consider an identity column as the key and a\n" +
            "-- UNIQUE constraint on the code.",
        });
      }
    }
  }

  return sortAdvice(advice);
}

/** The integer types an identity column can have. */
const INTEGER_TYPES = new Set(["smallint", "integer", "bigint"]);

/**
 * The same timestamp type with a time zone, keeping any precision:
 * "timestamp(3) without time zone" → "timestamp(3) with time zone".
 */
function zonedType(typeDisplay: string): string {
  return /without time zone$/i.test(typeDisplay)
    ? typeDisplay.replace(/without time zone$/i, "with time zone")
    : `${typeDisplay} with time zone`;
}

/**
 * True when the snapshot says `sequenceName` is owned by exactly this column
 * — the one thing that makes it this serial's own sequence and nobody else's.
 *
 * No record at all (an older snapshot, or one taken without sequences) counts
 * as yes: the default is then the only evidence, and it says serial.
 * `ownedByTable` is the table as regclass prints it, without the snapshot's
 * own schema: `orders`, `"Order Lines"`, or `other.t` for another schema.
 */
function sequenceBelongsTo(
  snapshot: SchemaSnapshot,
  sequenceName: string,
  tableName: string,
  columnName: string
): boolean {
  const record = snapshot.sequences?.find((s) => s.name === sequenceName);
  if (!record) return true;
  if (record.ownedByTable === null || record.ownedByColumn !== columnName) return false;
  const owner = identifierParts(record.ownedByTable);
  if (owner === null) return false;
  if (owner.length === 1) return owner[0] === tableName;
  return owner.length === 2 && owner[0] === snapshot.schema && owner[1] === tableName;
}

/**
 * Turning a serial column into an identity, with its own sequence named.
 *
 * What the obvious two-line version (DROP DEFAULT, then ADD GENERATED) gets
 * wrong on a table with rows in it, each checked on PostgreSQL 17:
 *   • an identity column has to be NOT NULL, or ADD GENERATED stops with an
 *     error;
 *   • the old sequence has to be detached first (OWNED BY NONE), or
 *     pg_get_serial_sequence goes on finding it instead of the identity's
 *     own, and the setval moves the wrong sequence;
 *   • a new identity starts at 1, so the next INSERT collides with a row
 *     already there. Starting it just above max(id) is not enough either:
 *     after the newest rows are deleted, that hands their numbers out again,
 *     which the serial never would. So the new sequence carries on from the
 *     old one's next value, or from above the highest id when a row was given
 *     a higher number by hand;
 *   • the old sequence is left behind, unused.
 *
 * The undo is comments only: it needs the old sequence, which the last step
 * invites the reader to drop.
 */
function serialFix(
  schema: string,
  tableName: string,
  column: TableSnapshot["columns"][number],
  sequenceName: string
): Pick<PerfAdvice, "fix" | "fixKind" | "undo"> {
  const target = qualifiedName(schema, tableName);
  const col = quoteIdent(column.name);
  const sequence = qualifiedName(schema, sequenceName);
  // pg_get_serial_sequence reads its first argument as a SQL name, so the
  // quoted, qualified name goes inside the string; the column is taken as
  // written.
  const identitySequence = `pg_get_serial_sequence(${literal(target)}, ${literal(column.name)})`;
  const fix: string[] = [];
  if (column.nullable) {
    // First, so that when a NULL stops it nothing else has run yet.
    fix.push("-- An identity column cannot be NULL, so make this one NOT NULL first. If a row");
    fix.push("-- holds NULL here, this stops with an error before anything has changed.");
    fix.push(`ALTER TABLE ${target} ALTER COLUMN ${col} SET NOT NULL;`);
  }
  fix.push(`ALTER TABLE ${target} ALTER COLUMN ${col} DROP DEFAULT;`);
  fix.push("-- Detach the old sequence, or the setval below would reach it instead of the new one.");
  fix.push(`ALTER SEQUENCE ${sequence} OWNED BY NONE;`);
  fix.push(`ALTER TABLE ${target} ALTER COLUMN ${col} ADD GENERATED BY DEFAULT AS IDENTITY;`);
  // GREATEST skips a NULL, so on an empty table max() + 1 drops out and the
  // old sequence's next value is used. The final false means "this is the
  // next value to hand out", not "this one is already used".
  fix.push("-- Carry on from the number the old sequence would have handed out next, or from");
  fix.push("-- above the highest value if a row holds a higher one, so no number comes twice.");
  fix.push(
    `SELECT setval(${identitySequence}, ` +
      `GREATEST(nextval(${literal(sequence)}), (SELECT max(${col}) + 1 FROM ${target})), false);`
  );
  fix.push("-- The serial's own sequence is now unused. Check nothing else names it, then:");
  fix.push(comment`-- DROP SEQUENCE ${sequence};`);

  // The same move the other way round: the old sequence first carries on past
  // every number the identity handed out, while the identity still exists to
  // say where it got to (DROP IDENTITY drops its sequence).
  const undo = [
    "-- To go back, while the old sequence still exists (not after DROP SEQUENCE).",
    "-- First move the old sequence past every number the identity handed out:",
    comment`-- SELECT setval(${literal(sequence)}, GREATEST(nextval(${identitySequence}), ` +
      comment`(SELECT max(${col}) + 1 FROM ${target})), false);`,
    comment`-- ALTER TABLE ${target} ALTER COLUMN ${col} DROP IDENTITY;`,
    comment`-- ALTER TABLE ${target} ALTER COLUMN ${col} SET DEFAULT nextval(${literal(sequence)});`,
    comment`-- ALTER SEQUENCE ${sequence} OWNED BY ${target}.${col};`,
  ];
  if (column.nullable) undo.push(comment`-- ALTER TABLE ${target} ALTER COLUMN ${col} DROP NOT NULL;`);

  return { fixKind: "change", fix: fix.join("\n"), undo: undo.join("\n") };
}

/**
 * One row of PostgreSQL's own per-table statistics.
 *
 * Field names follow pg_stat_user_tables rather than this project's camelCase,
 * because the whole point of these numbers is that they came from the server —
 * renaming them would make the rule harder to check against the catalog.
 */
export type TableStats = {
  table_name: string;
  seq_scan: number;
  /** Rows read by all those sequential scans together. */
  seq_tup_read: number;
  idx_scan: number;
  n_live_tup: number;
  n_dead_tup: number;
  /**
   * When ANALYZE last ran on it, by hand or by autovacuum. Null when the
   * counters hold no record of one: never run, or not since they last started.
   */
  last_analyzed: string | null;
  /**
   * Whether pg_stats holds anything for this table's columns: what ANALYZE
   * collects, and what a statistics reset or a crash leaves in place.
   */
  has_statistics: boolean;
  /** Heap pages served from cache and read from disk, for the hit ratio. */
  heap_blks_hit: number;
  heap_blks_read: number;
};

/**
 * A partition that a partitioned table's index is still waiting for: no
 * finished copy of the index is attached for it.
 */
export type WaitingPartition = {
  schema: string;
  table: string;
  /** Partitioned itself, so CREATE INDEX CONCURRENTLY is refused on it. */
  partitioned: boolean;
  /** A foreign table, which PostgreSQL cannot build an index on at all. */
  foreign: boolean;
  /**
   * Partitioned, with a foreign table somewhere among its own partitions. A
   * unique index cannot cover a foreign table, so that one has to go first.
   */
  foreign_below: boolean;
  /** The copy attached for it that is not finished (in its schema), or null. */
  attached: string | null;
};

/**
 * One index for the statistics rules: a row of pg_stat_user_indexes, joined
 * to what the index is for. A partitioned table's own index is never in that
 * view, so the route reads an unfinished one from pg_index and adds it here.
 */
export type IndexStats = {
  table_name: string;
  index_name: string;
  idx_scan: number;
  /** Unique indexes are enforcing something, so an unused one is not waste. */
  is_unique: boolean;
  is_primary: boolean;
  /**
   * False after a CREATE INDEX CONCURRENTLY or REINDEX CONCURRENTLY failed
   * part-way, and for a partitioned table's index until every partition has a
   * finished copy attached.
   */
  is_valid: boolean;
  /** A constraint (primary key, unique, exclusion) owns this index. */
  backs_constraint: boolean;
  /**
   * One partition's piece of a partitioned table's index. The index of a
   * partition that is partitioned itself is this and is_partitioned both.
   */
  is_partition_child: boolean;
  /**
   * The index of a partitioned table. It holds no rows itself: each partition
   * has its own copy, attached to it.
   */
  is_partitioned: boolean;
  size_bytes: number;
  /** pg_get_indexdef, read with nothing on the search_path, so fully qualified. */
  definition: string;
  /**
   * For an unfinished partitioned index: the partitions one level down that
   * have no finished copy attached, in name order.
   */
  waiting_on?: WaitingPartition[];
  /** For an unfinished partitioned index: one of its attached copies, or null when it has none. */
  attached_example?: { schema: string; name: string } | null;
  /** For a partitioned index that is a partition's copy: the index at the top of its tree. */
  top_index?: { schema: string; table: string; name: string } | null;
  /** pg_get_constraintdef of the constraint that owns the index, or null when none does. */
  constraint_definition?: string | null;
};

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
  foreignKeys: ForeignKeyIndexes[] = []
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

    if (t.n_live_tup >= 1_000 && t.n_dead_tup > t.n_live_tup * 0.2) {
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
function invalidIndexAdvice(index: IndexStats, name: string): PerfAdvice {
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
 * inside the comment (see the comment tag above).
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
function unfinishedPartitionedIndexAdvice(
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

/**
 * Point each whole-table-read finding at an unindexed foreign key on the same
 * table, when there is one.
 *
 * The statistics can say that a table is read in full; only the structure can
 * say a likely reason. An unindexed foreign key is a common one — every join
 * through the key, and every delete from the table it points at, reads the
 * whole table — and its index is the cheapest thing to try, so the finding
 * gets that CREATE INDEX (and its undo) instead of only a pointer to the
 * analyser. The foreign-key finding keeps the same statement; the text says
 * to run it once.
 *
 * Pure: returns new findings and leaves the ones passed in alone.
 */
export function attachForeignKeyIndexes<T extends PerfAdvice>(advice: T[]): T[] {
  const firstForeignKey = new Map<string, T>();
  for (const item of advice) {
    if (item.id !== "foreign-key-not-indexed" || item.table === undefined) continue;
    if (!firstForeignKey.has(item.table)) firstForeignKey.set(item.table, item);
  }
  return advice.map((item) => {
    if (item.id !== "sequential-scan-heavy") return item;
    const foreignKey = firstForeignKey.get(item.object);
    if (!foreignKey) return item;
    const changed: T = {
      ...item,
      fixKind: "change",
      fix:
        comment`-- This table also has a foreign key with no index (${foreignKey.object}). That is\n` +
        `-- a common cause of whole-table reads, and the cheapest thing to try first.\n` +
        `-- It is the same statement as on that suggestion, so run it once.\n` +
        foreignKey.fix,
      undo: foreignKey.undo,
    };
    return changed;
  });
}

/**
 * Leave out an unused-index finding when another finding already drops the
 * same index, or keeps it.
 *
 * Two identical indexes, or one that a wider index covers, are often unused
 * as well, and then the same DROP INDEX would sit on two findings. Saved as
 * two migrations, the second would fail, because the index is already gone.
 * The duplicate-index or redundant-index finding is the one kept: its reason
 * holds whatever the counters say, and it comes with an undo of its own.
 *
 * The index such a finding keeps (its `keeps`) is left alone too: the copy
 * the duplicate-index finding keeps, or the wider index the redundant-index
 * finding leaves in place. Neither is chosen by use (the copy is the first
 * one listed, the wider index is picked by its columns), so the one kept can
 * be the unused one while the one dropped is the one the queries use: run
 * together, the two DROPs would leave those queries no index at all. Once the
 * other is gone the queries move to the one kept, and the next check shows
 * whether they did.
 *
 * Findings are matched on the exact statement. An unused-index fix ends with
 * its DROP INDEX (behind "-- " when it is only a decision); the other findings
 * run theirs as a line of its own. A name with a line break in it matches
 * nothing, so both findings stay, which repeats itself but breaks nothing.
 *
 * Pure: returns a new list and leaves the one passed in alone.
 */
export function withoutRepeatedDrops<T extends PerfAdvice>(advice: T[]): T[] {
  // The DROP INDEX statements no unused-index finding may offer: the ones
  // another change already runs, and the ones that would remove what it keeps.
  const leaveAlone = new Set<string>();
  for (const item of advice) {
    if (item.id === "unused-index" || item.fixKind !== "change") continue;
    for (const line of item.fix.split("\n")) {
      if (line.startsWith("DROP INDEX ")) leaveAlone.add(line);
    }
    if (item.keeps !== undefined) leaveAlone.add(`DROP INDEX ${item.keeps};`);
  }
  return advice.filter((item) => {
    if (item.id !== "unused-index") return true;
    const lastLine = item.fix.split("\n").pop() ?? "";
    const drop = lastLine.startsWith("-- ") ? lastLine.slice(3) : lastLine;
    return !leaveAlone.has(drop);
  });
}

/**
 * Why the statistics pass failed, as a sentence for the screen.
 *
 * A timeout and a lock wait each get their own sentence, because each has a
 * cause the reader can do something about. Anything else from PostgreSQL is
 * quoted, since its own message is the most specific thing there is; an error
 * from anywhere else (a dropped connection, say) is quoted differently, so it
 * is not mistaken for something the server said.
 */
export function describeStatsError(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code: unknown }).code
      : undefined;
  // A SQLSTATE is five digits or capital letters. Node's own error codes can
  // look the same (EPIPE, when the connection drops), but no SQLSTATE class
  // starts with E, so that tells the two apart.
  const fromPostgres = typeof code === "string" && /^[0-9A-DF-Z][0-9A-Z]{4}$/.test(code);
  const message = error instanceof Error ? error.message : String(error);
  const missing = "suggestions based on how the tables are used are missing";

  if (fromPostgres && code === "57014") {
    return (
      `Reading the usage statistics took longer than ${STATS_STATEMENT_TIMEOUT_MS / 1000} ` +
      `seconds, so it was stopped; ${missing}. Try again when the server is quieter.`
    );
  }
  if (fromPostgres && code === "55P03") {
    return (
      `Another session holds a lock on a table or index in this schema (a running ` +
      `ALTER TABLE, for example), so the statistics could not be read within ` +
      `${STATS_LOCK_TIMEOUT_MS / 1000} seconds; ${missing}. Try again once it has finished.`
    );
  }
  // PostgreSQL's words go in brackets, so the sentence still ends with a full
  // stop and whatever the screen adds after it reads as a sentence of its own.
  if (fromPostgres) {
    return `The server's usage statistics could not be read (PostgreSQL said: ${message}), so ${missing}.`;
  }
  return `The server's usage statistics could not be read (${message}), so ${missing}.`;
}

/**
 * Why reading the schema's structure failed, as a sentence for the screen.
 *
 * Without the structure there are no suggestions at all, so this is the
 * whole answer. A lock wait and a timeout get sentences of their own: the
 * connection worked and the server answered, so "check the connection
 * details" would send the reader to the wrong place. `code` is the SQLSTATE
 * that fetchSchemaSnapshot passes on when PostgreSQL sent one.
 */
export function describeStructureError(
  schema: string,
  connectionName: string,
  failure: { error: string; code?: string }
): string {
  const where = `"${schema}" on "${connectionName}"`;
  if (failure.code === "55P03") {
    return (
      `Another session holds a lock on a table or view in ${where} (a running ALTER ` +
      `TABLE, for example), so its structure could not be read within ` +
      `${STRUCTURE_LOCK_TIMEOUT_MS / 1000} seconds. Try again once that has finished.`
    );
  }
  if (failure.code === "57014") {
    return (
      `Reading the structure of ${where} took too long, so it was stopped. ` +
      `The server may be busy; try again when it is quieter.`
    );
  }
  return `Could not read ${where}. Check the connection details. Details: ${failure.error}`;
}
