// Small SQL helpers shared by the two performance tabs (lib/query-analysis.ts
// and lib/perf-advice.ts).
//
// Dependency-free, like the modules that use it: nothing here opens a
// connection, so it runs in a test, in a route handler and in the browser.
//
// Why a separate file: both tabs print SQL a person will paste into a server,
// and both decide when a table is "large". If each kept its own copy, the two
// tabs could quote the same table differently or disagree about whether it is
// big, and the reader would have no way to tell which one was right.

// Both dependency-free as well, so this file still opens nothing: the SQL
// scanner every screen shares, and the counted nouns.
import { hasExecutableSql, maskNonCode } from "./sql-guard";
import { countOf, plural } from "./plural";
import { utcStamp } from "./format-date";

/**
 * How many rows a table needs before a whole-table read of it is worth a
 * finding.
 *
 * Below this, reading the table from start to finish is usually the right
 * plan: the server would spend longer opening an index than reading the rows.
 * The threshold is what stops the screens from telling people to index a
 * lookup table of forty currency codes.
 *
 * One number for both tabs. The Suggestions tab already used 10,000; the
 * Analyse tab used 5,000, so the same table could be "large" on one tab and
 * fine on the other. 10,000 keeps the Suggestions tab unchanged and makes the
 * Analyse tab slightly quieter on small tables.
 */
export const LARGE_TABLE_ROWS = 10_000;

/**
 * What kind of thing a finding's fix is, so the screen can say what running
 * it would do before anybody runs it. Both tabs use it, which is why it lives
 * here: one definition, so a "change" means the same thing on either tab.
 *
 *   change       changes the database's structure (a new index, a dropped
 *                index, a new primary key). Belongs in a migration, like any
 *                other schema change. Comes with `undo` whenever there is a
 *                statement that takes it back out.
 *   maintenance  changes nothing about the structure, only what the server
 *                knows or keeps tidy: ANALYZE, VACUUM, REINDEX, and dropping
 *                the copy of an index that a REINDEX CONCURRENTLY left behind
 *                (only this server has that copy, so a migration dropping it
 *                would fail on every other database). Run by hand; VACUUM
 *                cannot run inside a migration's transaction at all.
 *   query        a different way to write the query itself. Nothing on the
 *                server changes.
 *   decision     a choice only a person can make. Every line of the fix is a
 *                comment setting out the options, so pasting it runs nothing.
 */
export type FixKind = "change" | "maintenance" | "query" | "decision";

/**
 * Quote one SQL identifier (a schema, table, column or index name).
 *
 * Always quotes, rather than only "when needed": deciding when quotes are
 * needed means knowing every reserved word and the case rules, and getting
 * that wrong prints SQL that fails or, worse, names a different object. A
 * quoted name means exactly what it says. A double quote inside the name is
 * doubled, which is how PostgreSQL escapes it.
 *
 *   quoteIdent("orders")    →  "orders"
 *   quoteIdent("Order")     →  "Order"      (keeps the capital letter)
 *   quoteIdent('a"b')       →  "a""b"
 */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * A schema-qualified, quoted name: "public"."orders".
 *
 * Qualified so the statement means the same thing whatever search_path the
 * person pasting it happens to have. Two schemas on one server holding a table
 * called orders is the normal case for this app.
 */
export function qualifiedName(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

/**
 * The longest name PostgreSQL keeps, in bytes (NAMEDATALEN - 1).
 *
 * A longer name is cut short without an error, so a suggested index name
 * longer than this would not be the name the index really gets, and the DROP
 * INDEX that undoes it would name something that does not exist.
 */
export const MAX_NAME_BYTES = 63;

/** How many bytes the text takes in UTF-8, the encoding the limit counts in. */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * The text minus its last character.
 *
 * Array.from splits by whole characters, not by bytes or by UTF-16 halves, so
 * a name like "commandes_été" or one ending in an emoji is never cut through
 * the middle of a character.
 */
function dropLastChar(text: string): string {
  const chars = Array.from(text);
  chars.pop();
  return chars.join("");
}

/**
 * "first_second_label", shortened to fit MAX_NAME_BYTES.
 *
 * Shortened the way PostgreSQL shortens the names it picks itself: one
 * character at a time off whichever of the two halves is longer, so both stay
 * recognisable, and never off the label, so an index name always ends in
 * "_idx". `second` may be empty, and then there is no middle part.
 */
function objectName(first: string, second: string, label: string): string {
  const overhead = byteLength(label) + 1 + (second === "" ? 0 : 1);
  const budget = MAX_NAME_BYTES - overhead;
  let a = first;
  let b = second;
  while (byteLength(a) + byteLength(b) > budget && (a !== "" || b !== "")) {
    if (byteLength(a) > byteLength(b)) a = dropLastChar(a);
    else b = dropLastChar(b);
  }
  return second === "" ? `${a}_${label}` : `${a}_${b}_${label}`;
}

/**
 * A name for a new index that nothing in its schema already uses.
 *
 * `${table}_${detail}_idx`, the name PostgreSQL would pick itself, then
 * `_idx1`, `_idx2`, … until the name is free. `takenNames` is every relation
 * name in the schema (tables, indexes, views, sequences all share one
 * namespace there), plus any names already suggested in the same report.
 *
 *   indexName("orders", "customer_id", [])                         →  orders_customer_id_idx
 *   indexName("orders", "customer_id", ["orders_customer_id_idx"]) →  orders_customer_id_idx1
 */
export function indexName(table: string, detail: string, takenNames: Iterable<string>): string {
  const taken = new Set(takenNames);
  let name = objectName(table, detail, "idx");
  for (let n = 1; taken.has(name); n += 1) {
    name = objectName(table, detail, `idx${n}`);
  }
  return name;
}

/** A CREATE INDEX to paste, the name it uses, and the statement that takes it out again. */
export type IndexStatement = {
  /** A comment on building it without blocking writes, then the CREATE INDEX. */
  sql: string;
  /** The new index's name, checked free in its schema. */
  name: string;
  /** DROP INDEX for exactly that name, schema-qualified. */
  undo: string;
};

/** What the caller knows about the table a suggested index is for. */
export type IndexOptions = {
  /**
   * The table is partitioned (the parent itself, not one of its partitions).
   * PostgreSQL refuses CREATE INDEX CONCURRENTLY on one, so the comment above
   * the statement has to say something else.
   */
  partitioned?: boolean;
};

/** Printed above an index on an ordinary table. */
const CONCURRENTLY_NOTE =
  "-- On a busy table, run this by hand as CREATE INDEX CONCURRENTLY, outside\n" +
  "-- a transaction, so writes to the table are not blocked while it builds.\n";

/**
 * Printed above an index on a partitioned table, where CONCURRENTLY is
 * refused. The way round it is PostgreSQL's own: when every partition already
 * has a matching index, creating the parent's index only links them together,
 * so writes are blocked for a moment rather than for the whole build.
 *
 * Worded so that no line starts with SQL and a semicolon: a line reading
 * "-- CREATE INDEX CONCURRENTLY; ..." looks like a statement to uncomment.
 */
const PARTITIONED_NOTE =
  "-- This table is partitioned, so this builds the index on every partition and\n" +
  "-- blocks writes to them until it finishes (CONCURRENTLY is refused here). On a\n" +
  "-- busy table, first run CREATE INDEX CONCURRENTLY by hand on each partition,\n" +
  "-- on the same columns. This statement then only links those indexes together.\n";

/**
 * The shared shape of every suggested index.
 *
 * A plain CREATE INDEX with an explicit name, on purpose:
 *   • not CONCURRENTLY, because that cannot run inside a transaction and the
 *     app applies every migration in one, so it could never become a
 *     migration. The comment tells a person how to use it by hand instead;
 *   • not IF NOT EXISTS, because that silently does nothing when ANY relation
 *     already has the name, even an unrelated one. A named statement fails
 *     loudly on a re-run instead, and can be undone by that name.
 */
function indexStatement(
  schema: string,
  table: string,
  nameDetail: string,
  keys: string,
  takenNames: Iterable<string>,
  options: IndexOptions = {}
): IndexStatement {
  const name = indexName(table, nameDetail, takenNames);
  return {
    name,
    sql:
      (options.partitioned ? PARTITIONED_NOTE : CONCURRENTLY_NOTE) +
      `CREATE INDEX ${quoteIdent(name)} ON ${qualifiedName(schema, table)} (${keys});`,
    undo: `DROP INDEX ${qualifiedName(schema, name)};`,
  };
}

/**
 * An index on one or more plain columns, in the order given.
 *
 *   createIndexSql("public", "orders", ["customer_id"], [])
 *     sql   →  CREATE INDEX "orders_customer_id_idx" ON "public"."orders" ("customer_id");
 *              (after two comment lines)
 *     undo  →  DROP INDEX "public"."orders_customer_id_idx";
 *
 * Pass { partitioned: true } for a partitioned table, so the comment above it
 * says what to do instead of CONCURRENTLY, which PostgreSQL refuses there.
 */
export function createIndexSql(
  schema: string,
  table: string,
  columns: string[],
  takenNames: Iterable<string>,
  options: IndexOptions = {}
): IndexStatement {
  return indexStatement(
    schema,
    table,
    columns.join("_"),
    columns.map(quoteIdent).join(", "),
    takenNames,
    options
  );
}

/**
 * A name for a new constraint that brings an index with it (a primary key),
 * the way PostgreSQL would pick it: `${table}_${label}`, then
 * `${label}1`, `${label}2`, … until the name is free.
 *
 * Free in two places at once, because the constraint's index takes the same
 * name: `takenNames` is every constraint name on the table plus every
 * relation name in the schema.
 *
 *   constraintName("orders", "pkey", [])               →  orders_pkey
 *   constraintName("orders", "pkey", ["orders_pkey"])  →  orders_pkey1
 */
export function constraintName(
  table: string,
  label: string,
  takenNames: Iterable<string>
): string {
  const taken = new Set(takenNames);
  let name = objectName(table, "", label);
  for (let n = 1; taken.has(name); n += 1) {
    name = objectName(table, "", `${label}${n}`);
  }
  return name;
}

/**
 * An index on lower(column) or upper(column), for a filter that compares
 * the function's result rather than the column itself.
 *
 *   createExpressionIndexSql("public", "customers", "lower", "email", [])
 *     →  CREATE INDEX "customers_lower_email_idx" ON "public"."customers" (lower("email"));
 */
export function createExpressionIndexSql(
  schema: string,
  table: string,
  fn: "lower" | "upper",
  column: string,
  takenNames: Iterable<string>
): IndexStatement {
  return indexStatement(schema, table, `${fn}_${column}`, `${fn}(${quoteIdent(column)})`, takenNames);
}

// ---------------------------------------------------------------------------
// One script from many fixes (the "Take these fixes away" box on both tabs).
//
// A report of twelve findings used to mean twelve copies, twelve pastes and
// twelve chances to miss one. buildFixScript puts the ticked ones into one
// file, in the order the screen listed them, with each fix's own comments
// kept, and works out the rollback that goes with the schema changes.
//
// Pure: no clock, no storage, no browser. The screen passes the date in, so a
// test can fix it, and decides what to do with the text.
// ---------------------------------------------------------------------------

/**
 * What the builder needs from a finding. Both tabs' findings have these fields
 * (AdviceItem in lib/perf-advice.ts, QueryFinding in lib/query-analysis.ts), so
 * either list is passed straight in.
 */
export type FixScriptItem = {
  title: string;
  object: string;
  fix: string;
  fixKind: FixKind;
  undo?: string;
};

/** Where the fixes are for, printed at the top, and the fixes themselves. */
export type FixScriptInput = {
  connectionName: string;
  database: string;
  schema: string;
  /** When the script was made. Passed in rather than read here, so a test can fix it. */
  date: Date;
  /** In the order the screen lists them. Query rewrites and decisions are left out. */
  items: FixScriptItem[];
};

/** The ticked fixes as text to copy, download or save as a migration. */
export type FixScript = {
  /**
   * Everything, for Copy and Download: the header, the schema changes, then
   * the maintenance in a section of its own. "" when none of the items is a
   * change or maintenance.
   */
  script: string;
  /**
   * The header and the schema changes only, which is what a migration may
   * hold. "" when there are no changes.
   */
  changes: string;
  /**
   * The statements that take the schema changes back out, last change first.
   * null when there are no changes, or when any change has no undo that runs:
   * a rollback that quietly skipped one change would leave the database half
   * put back while saying it was done.
   */
  rollback: string | null;
  /** "title (object)" for each change with no undo, so the screen can name them. */
  withoutUndo: string[];
  /** One line for the migration's description. "" when there are no changes. */
  description: string;
};

/**
 * The longest description a saved migration may have: the same number as
 * MAX_DESCRIPTION_LENGTH in app/api/github/push/route.ts and the Script
 * Editor's box, counted the same way (String.length, in UTF-16 units).
 */
export const MAX_MIGRATION_DESCRIPTION = 1000;

/**
 * The text on one line. A `--` comment ends at a line break (a carriage return
 * counts too), so a name holding one would end the comment early and the rest
 * of the name would be read as SQL.
 */
function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, " ");
}

/** "Foreign key has no index (orders.customer_id)", on one line. */
function itemLabel(item: FixScriptItem): string {
  return `${oneLine(item.title)} (${oneLine(item.object)})`;
}

/**
 * The fix cut after every semicolon that ends a statement. Each piece keeps
 * its semicolon and the comment lines in front of it, and the pieces joined
 * back together are the fix exactly.
 *
 * The semicolons are found on maskNonCode's copy (lib/sql-guard.ts), the
 * scanner every other screen uses, so one inside a comment, a string or a
 * "quoted name" never cuts anything.
 */
function statementPieces(sql: string): string[] {
  const mask = maskNonCode(sql);
  const pieces: string[] = [];
  let start = 0;
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] === ";") {
      pieces.push(sql.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < sql.length) pieces.push(sql.slice(start));
  return pieces;
}

/** The comment lines and blank space at the start of a piece, which the server skips. */
const LEADING_COMMENTS = /^(?:\s*--[^\r\n]*)*\s*/;

/**
 * What a piece runs, for spotting the same statement twice: the piece minus
 * the comment lines in front of it, trimmed. Everything else has to match
 * exactly, so two statements that differ in any way are both kept. That is
 * the safe way round: a copy that is kept fails loudly when it runs ("already
 * exists"), while a statement dropped by mistake would just never run.
 */
function statementKey(piece: string): string {
  return piece.replace(LEADING_COMMENTS, "").trim();
}

/**
 * The fix with every statement already in `seen` taken out, and the keys of
 * the statements it keeps added to `seen`.
 *
 * Why this is needed at all: two findings can carry the very same statement.
 * A foreign key with no index that is also read in full gets the same CREATE
 * INDEX under both findings, and the Analyse tab suggests the same index for
 * every step that reads the same columns. Both are ticked by default, and the
 * second CREATE INDEX would stop the migration with "relation already exists".
 *
 * Pieces holding only comments stay, so a fix's notes stay with it.
 */
function withoutRepeats(sql: string, seen: Set<string>): { sql: string; leftOut: number } {
  let kept = "";
  let leftOut = 0;
  for (const piece of statementPieces(sql)) {
    if (!hasExecutableSql(piece)) {
      kept += piece;
      continue;
    }
    const key = statementKey(piece);
    if (seen.has(key)) {
      leftOut += 1;
      continue;
    }
    seen.add(key);
    kept += piece;
    // A last statement with no semicolon would run on into the next fix's
    // first statement, and the two would fail as one. Every fix ends with one
    // (tests/helpers/fix-invariants.ts checks it); this is for the day one
    // does not. On a line of its own, so a comment at the end cannot swallow it.
    if (!maskNonCode(piece).trimEnd().endsWith(";")) kept += "\n;";
  }
  return { sql: kept, leftOut };
}

/** One fix as it goes into the script, after anything already above is taken out. */
type Placed = {
  item: FixScriptItem;
  /** The title line, then the fix, or a note saying what was left out and why. */
  text: string;
  /** Whether anything in it runs, or all of it was already above. */
  runs: boolean;
};

function place(item: FixScriptItem, seen: Set<string>): Placed {
  const title = `-- ${itemLabel(item)}`;
  const { sql, leftOut } = withoutRepeats(item.fix, seen);
  const runs = hasExecutableSql(sql);
  let body = sql.trim();
  if (leftOut > 0 && !runs) {
    body = "-- Nothing more to run: the same SQL is already above.";
  } else if (leftOut > 0) {
    body =
      `-- Left out ${countOf(leftOut, "statement")} that ${plural(leftOut, "is", "are")} ` +
      `already above.\n${body}`;
  }
  return { item, text: `${title}\n${body}`, runs };
}

/**
 * Everything the script and the screen's notes are built from, worked out in
 * one place so the two can never disagree: the changes, then the maintenance,
 * each with repeats taken out, and each change's own undo.
 */
function arrange(items: FixScriptItem[]) {
  // One set across both sections, filled in the order the script prints them,
  // so "already above" is true of the script exactly as printed.
  const seen = new Set<string>();
  const changes = items.filter((item) => item.fixKind === "change").map((item) => place(item, seen));
  const maintenance = items
    .filter((item) => item.fixKind === "maintenance")
    .map((item) => place(item, seen));

  // The undo side, earliest change first, with repeats taken out the same way:
  // the same CREATE INDEX under two findings comes with the same DROP INDEX,
  // and dropping it twice would stop the rollback half way.
  const seenUndo = new Set<string>();
  const undos: { item: FixScriptItem; sql: string }[] = [];
  const withoutUndo: string[] = [];
  for (const placed of changes) {
    // A change whose statements were all already above adds nothing of its
    // own, so it has nothing of its own to undo either.
    if (!placed.runs) continue;
    const undo = placed.item.undo ?? "";
    // An undo of nothing but comments does not put anything back.
    if (!hasExecutableSql(undo)) {
      withoutUndo.push(itemLabel(placed.item));
      continue;
    }
    const own = withoutRepeats(undo, seenUndo).sql;
    if (hasExecutableSql(own)) undos.push({ item: placed.item, sql: own.trim() });
  }
  return { changes, maintenance, undos, withoutUndo };
}

/** The comment lines every script and rollback opens with. */
function header(input: FixScriptInput): string {
  // The stamp every screen prints, e.g. "2026-09-08 01:43 UTC".
  const when = utcStamp(input.date.toISOString());
  return [
    "-- Generated by Schema Studio. Review before running.",
    `-- Connection: ${oneLine(input.connectionName)}`,
    `-- Database:   ${oneLine(input.database)}`,
    `-- Schema:     ${oneLine(input.schema)}`,
    `-- Date:       ${when}`,
  ].join("\n");
}

const RULE = `-- ${"=".repeat(74)}`;

/** Text cut to `max` UTF-16 units, ending "…" when cut, never through a character. */
function capLength(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 1);
  // The first half of a character outside the BMP (an emoji, say) on its own
  // is not a character at all.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/**
 * The ticked fixes as one script, the schema changes on their own for a
 * migration, and the rollback that goes with them.
 *
 *   • Only "change" and "maintenance" fixes go in. A query rewrite is a
 *     different way to write the query, and a decision is only comments; both
 *     stay on their cards.
 *   • Changes first, then maintenance under its own heading. The two are run
 *     differently: a migration runs its changes in one transaction, and VACUUM
 *     refuses to run inside one.
 *   • Every fix keeps its comments and is headed by its title and object, so
 *     the file still says why each statement is there.
 *   • A statement that an earlier fix already runs is left out, with a note.
 */
export function buildFixScript(input: FixScriptInput): FixScript {
  const { changes, maintenance, undos, withoutUndo } = arrange(input.items);
  const top = header(input);

  const changeSection = [
    RULE,
    "-- Schema changes: save them as a migration",
    RULE,
    "",
    changes.map((placed) => placed.text).join("\n\n"),
  ].join("\n");
  const maintenanceSection = [
    RULE,
    "-- Maintenance: run by hand, outside a transaction (VACUUM refuses to run inside one)",
    RULE,
    "-- Run each statement on its own, as psql -f does. A tool that sends the",
    "-- whole script as one query runs it as one transaction, and VACUUM then",
    "-- fails. None of this goes in a migration: it tidies this one server only.",
    "",
    maintenance.map((placed) => placed.text).join("\n\n"),
  ].join("\n");

  const sections: string[] = [];
  if (changes.length > 0) sections.push(changeSection);
  if (maintenance.length > 0) sections.push(maintenanceSection);
  const script = sections.length === 0 ? "" : `${top}\n\n${sections.join("\n\n")}\n`;

  // The migration gets no section heading: all of it is schema changes, and
  // "save them as a migration" would read oddly inside the migration itself.
  const changesOnly =
    changes.length === 0 ? "" : `${top}\n\n${changes.map((placed) => placed.text).join("\n\n")}\n`;

  const runningChanges = changes.filter((placed) => placed.runs);
  const rollback =
    runningChanges.length === 0 || withoutUndo.length > 0
      ? null
      : `${top}\n-- Rollback: takes the schema changes back out, last change first.\n\n` +
        undos
          .slice()
          .reverse()
          .map((undo) => `-- Undo: ${itemLabel(undo.item)}\n${undo.sql}`)
          .join("\n\n") +
        "\n";

  const description =
    changes.length === 0
      ? ""
      : capLength(
          `Performance fixes for ${oneLine(input.schema)}: ` +
            changes.map((placed) => itemLabel(placed.item)).join("; "),
          MAX_MIGRATION_DESCRIPTION
        );

  return { script, changes: changesOnly, rollback, withoutUndo, description };
}

/**
 * The changes among `items` that have no undo, as "title (object)", worked
 * out exactly as buildFixScript does. For the screen's note while the ticks
 * change, where there is no date to hand yet (a render must not read the clock).
 */
export function changesWithoutUndo(items: FixScriptItem[]): string[] {
  return arrange(items).withoutUndo;
}

/** A name for one part of a file name: letters, digits, _ and - only. */
function fileNamePart(name: string, fallback: string): string {
  const safe = name.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return safe === "" ? fallback : safe;
}

/**
 * "performance-fixes-shop-public-2026-09-14.sql". A database or schema name
 * may hold anything, a slash included, and a file name may not, so each is cut
 * down to letters, digits, _ and -. The day is the UTC one, like the header's.
 */
export function fixScriptFileName(database: string, schema: string, date: Date): string {
  const day = date.toISOString().slice(0, 10);
  return (
    `performance-fixes-${fileNamePart(database, "database")}-` +
    `${fileNamePart(schema, "schema")}-${day}.sql`
  );
}
