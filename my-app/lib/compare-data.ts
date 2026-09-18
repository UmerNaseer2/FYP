// ---------------------------------------------------------------------------
// compare-data.ts
// Row-level comparison: how many rows each table holds on each side, and
// whether the rows themselves are identical.
//
// Everything else in this app compares *structure* — the shape of a table, not
// what is in it. That leaves a real hole: the migration generator will happily
// emit `DROP TABLE orders` because the target does not have it, and the report
// can only say "the table is missing", never "the table you are about to drop
// has 1.2 million rows in it". This module answers that second question.
//
// It is deliberately OPT-IN and deliberately SEPARATE:
//   - it reads table data, which schema comparison never does, so it must be a
//     thing the user asks for rather than something a page render does silently;
//   - its result never feeds `hasChanges`, the drift record or the version
//     picker. A row that changed is not a schema change, and folding it in
//     would make every comparison of a live database report "drift" forever.
// ---------------------------------------------------------------------------

import type { ClientConfig, PoolClient } from "pg";
import { getPoolForConfig } from "./postgres";
import type { TableSnapshot } from "./postgres";
import type { CompareReport } from "./compare";
import type { DataCompareReport, TableDataCompare } from "./compare-data-summary";
import { MAX_SAVED_DATA_TABLES } from "./comparison-set-rules";
import {
  differingColumns,
  findMismatchedRows,
  pickSampleKey,
  SAMPLE_ROW_LIMIT,
  SAMPLE_SCAN_ROWS,
  type KeyedDigest,
  type RowSample,
  type SampleRow,
} from "./compare-sample";

// The result shape and its counts live in a module with no database imports so
// the UI can read them. Re-exported here so every existing caller of this
// module keeps working unchanged.
export type { DataCompareReport, TableDataCompare };
export { summarizeDataCompare } from "./compare-data-summary";

/**
 * Per-statement ceiling. A checksum reads every row of a table, so on a big
 * table it is a sequential scan and nothing else. Five seconds is long enough
 * for the tables a schema-diff tool is normally pointed at and short enough
 * that a runaway one is reported rather than hanging the page.
 */
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Ceiling for the whole run. The per-statement timeout alone does not bound a
 * schema with sixty slow tables in it, so once this much wall-clock has gone
 * the remaining tables are marked skipped instead of being started.
 */
const DEFAULT_BUDGET_MS = 25000;

/**
 * How many tables one run will look at, most-interesting-first.
 *
 * Imported rather than stated here so a saved set cannot remember more tables
 * than a run would ever read: lib/comparison-set-rules.ts validates against
 * the same constant, and it lives there because that module opens no database
 * and the browser needs the number too.
 */
const DEFAULT_MAX_TABLES = MAX_SAVED_DATA_TABLES;

/** Double-quote an identifier for interpolation into SQL. */
function q(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * The checksum query for one table.
 *
 * Two properties matter and both come from the ORDER BY:
 *   - it needs no primary key. Rows are hashed individually and the hashes are
 *     sorted, so the table's physical order — which differs between two copies
 *     of the same data after a restore — cannot change the result.
 *   - it is a set comparison, not a sequence comparison. Two tables holding the
 *     same rows in a different order are correctly reported as identical.
 *
 * `ROW(a::text, b::text)::text` rather than a plain concatenation because the
 * row-to-text encoding is unambiguous: NULL renders as nothing, an empty string
 * renders as `""`, and any value containing a comma or a quote is quoted. A
 * concatenation would hash `('a', 'b,c')` and `('a,b', 'c')` to the same thing.
 */
function checksumSql(schema: string, table: string, columns: string[]): string {
  const projection = columns.map((col) => `${q(col)}::text`).join(", ");
  return `
    SELECT count(*)::text AS row_count,
           md5(coalesce(string_agg(row_md5, '' ORDER BY row_md5), '')) AS checksum
      FROM (
        SELECT md5(ROW(${projection})::text) AS row_md5
          FROM ${q(schema)}.${q(table)}
      ) hashed
  `;
}

/**
 * One side's rows, as (key, digest of the compared columns), in a stable order.
 *
 * ORDER BY the key's TEXT rendering under the C collation, rather than by the
 * key itself. Both sides read only the first SAMPLE_SCAN_ROWS rows, so the two
 * reads are only comparable if they agree on which rows those are — and sort
 * order for text is a per-database collation setting that two servers routinely
 * disagree about. C is byte order, which is the same everywhere. The cost is
 * that the cut-off falls in a place a person would not pick (id 100 before id
 * 20); the benefit is that it falls in the SAME place on both sides, which is
 * the only property that matters here.
 *
 * The digest is over the same paired columns the checksum uses, in the same
 * order, so a row flagged here is a row the checksum also disagreed about.
 */
function digestSql(
  schema: string,
  table: string,
  keyColumns: string[],
  columns: string[],
  limit: number,
): string {
  const keys = keyColumns.map((col, i) => `${q(col)}::text AS k${i}`).join(", ");
  const digest =
    columns.length === 0
      ? `'' AS digest`
      : `md5(ROW(${columns.map((col) => `${q(col)}::text`).join(", ")})::text) AS digest`;
  const order = keyColumns.map((col) => `${q(col)}::text COLLATE "C"`).join(", ");
  return `SELECT ${keys}, ${digest}
            FROM ${q(schema)}.${q(table)}
           ORDER BY ${order}
           LIMIT ${Math.round(limit)}`;
}

/**
 * The full values of a named handful of rows, found by key.
 *
 * The keys arrive as text — that is how the digest read returned them — so the
 * match is made on the text rendering of the key rather than on its real type.
 * That rules out an index, which would matter if this ran over a whole table;
 * it runs over at most SAMPLE_ROW_LIMIT rows of a table the checksum has
 * already read twice, under the same statement timeout as everything else.
 */
function sampleRowsSql(
  schema: string,
  table: string,
  keyColumns: string[],
  columns: string[],
  keyCount: number,
): string {
  const keys = keyColumns.map((col, i) => `${q(col)}::text AS k${i}`).join(", ");
  const values = columns.map((col, i) => `${q(col)}::text AS c${i}`).join(", ");
  const expr = `ROW(${keyColumns.map((col) => `${q(col)}::text`).join(", ")})`;
  let placeholder = 0;
  const wanted = Array.from(
    { length: keyCount },
    () => `ROW(${keyColumns.map(() => `$${++placeholder}::text`).join(", ")})`,
  ).join(", ");
  return `SELECT ${keys}, ${values}
            FROM ${q(schema)}.${q(table)}
           WHERE ${expr} IN (${wanted})`;
}

/**
 * A k0/k1/... row from either query, read back as the key it stands for.
 *
 * The NULL stand-in is unreachable by construction — pickSampleKey only ever
 * returns columns that cannot hold one — and is a control character rather than
 * a word so that, if a key column ever did come back null, it could not collide
 * with a real value that happened to read "NULL".
 */
function keyOf(row: Record<string, string | null>, width: number): string[] {
  return Array.from({ length: width }, (_, i) => row[`k${i}`] ?? "\u0000");
}

/**
 * Which rows differ between two copies of one table.
 *
 * Runs only for a table the checksum already called different, so its cost is
 * paid on the tables a reader is actually going to look at. Never throws and
 * never fails the comparison: every outcome is a RowSample the screen can
 * render, including the ones that say why there is nothing to show.
 */
async function sampleDifferences(
  plan: TablePlan,
  leftClient: PoolClient,
  rightClient: PoolClient,
  source: { schema: string },
  target: { schema: string },
  timeoutMs: number,
): Promise<RowSample> {
  const blank = { keyColumns: plan.keyColumns, rows: [], more: false, scanned: 0, partial: false };
  if (plan.keyColumns.length === 0) {
    return { ...blank, status: "no-key", note: null };
  }

  const leftTable = plan.leftTable as string;
  const rightTable = plan.rightTable as string;
  const width = plan.keyColumns.length;

  const [left, right] = await Promise.all([
    readQuery<Record<string, string | null>>(
      leftClient,
      digestSql(source.schema, leftTable, plan.keyColumns, plan.leftColumns, SAMPLE_SCAN_ROWS),
      [],
      timeoutMs,
    ),
    readQuery<Record<string, string | null>>(
      rightClient,
      digestSql(target.schema, rightTable, plan.rightKeyColumns, plan.rightColumns, SAMPLE_SCAN_ROWS),
      [],
      timeoutMs,
    ),
  ]);

  if (!left.ok || !right.ok) {
    const reasons = [
      left.ok ? null : `source: ${left.error}`,
      right.ok ? null : `target: ${right.error}`,
    ].filter((reason): reason is string => reason !== null);
    return {
      ...blank,
      status: "unavailable",
      note: `The rows that differ could not be read — ${reasons.join(", ")}.`,
    };
  }

  const toDigests = (rows: Record<string, string | null>[]): KeyedDigest[] =>
    rows.map((row) => ({ key: keyOf(row, width), digest: row.digest ?? "" }));

  const found = findMismatchedRows(
    toDigests(left.rows),
    toDigests(right.rows),
    SAMPLE_ROW_LIMIT,
  );
  const scanned = SAMPLE_SCAN_ROWS;
  // Exactly the limit means the read stopped at the cut-off, so there is very
  // likely more past it. Fewer means the whole table was covered.
  const partial =
    left.rows.length >= SAMPLE_SCAN_ROWS || right.rows.length >= SAMPLE_SCAN_ROWS;

  // Only a row present on BOTH sides has two versions to put side by side. A
  // one-sided row is fully described by its key plus which side it is on.
  const changed = found.rows.filter((row) => row.kind === "changed");
  const values = changed.length > 0
    ? await Promise.all([
        readQuery<Record<string, string | null>>(
          leftClient,
          sampleRowsSql(source.schema, leftTable, plan.keyColumns, plan.leftColumns, changed.length),
          changed.flatMap((row) => row.key),
          timeoutMs,
        ),
        readQuery<Record<string, string | null>>(
          rightClient,
          sampleRowsSql(target.schema, rightTable, plan.rightKeyColumns, plan.rightColumns, changed.length),
          changed.flatMap((row) => row.key),
          timeoutMs,
        ),
      ])
    : null;

  // Both sides projected their paired columns as c0..cN in the SAME order, so
  // reading them back under the source's column names is all the translation a
  // renamed column needs — and everything below works in one set of names.
  const named = (row: Record<string, string | null>): Record<string, string | null> => {
    const out: Record<string, string | null> = {};
    plan.leftColumns.forEach((name, i) => {
      out[name] = row[`c${i}`] ?? null;
    });
    return out;
  };
  // A failure here loses the per-column detail, not the finding: the keys are
  // already known, so the rows are still listed as differing and only the
  // "which column" half is missing.
  const byKey = (
    result: { ok: true; rows: Record<string, string | null>[] } | { ok: false; error: string },
  ): Map<string, Record<string, string | null>> =>
    result.ok
      ? new Map(result.rows.map((row) => [JSON.stringify(keyOf(row, width)), named(row)]))
      : new Map();
  const leftRows = values ? byKey(values[0]) : new Map();
  const rightRows = values ? byKey(values[1]) : new Map();
  const pairs = plan.leftColumns.map((name) => ({ left: name, right: name }));

  const rows: SampleRow[] = found.rows.map((row) => {
    if (row.kind !== "changed") return { key: row.key, kind: row.kind, differences: [] };
    const id = JSON.stringify(row.key);
    const leftRow = leftRows.get(id);
    const rightRow = rightRows.get(id);
    if (!leftRow || !rightRow) return { key: row.key, kind: row.kind, differences: [] };
    return {
      key: row.key,
      kind: row.kind,
      differences: differingColumns(leftRow, rightRow, pairs),
    };
  });

  return { keyColumns: plan.keyColumns, rows, more: found.more, scanned, partial, status: "sampled", note: null };
}

/** The row count alone, for a table only one side has. */
function countSql(schema: string, table: string): string {
  return `SELECT count(*)::text AS row_count, NULL::text AS checksum
            FROM ${q(schema)}.${q(table)}`;
}

type SideResult =
  | { ok: true; rows: number; checksum: string | null }
  | { ok: false; error: string };

/**
 * The settings that decide how a value renders as text, pinned to the same
 * thing on both sides.
 *
 * The checksum hashes `ROW(a::text, b::text)::text`, so anything that changes
 * the text of a value changes the hash. Every one of these has a server default
 * that differs between a local box and a hosted one, and none of them means the
 * data differs:
 *
 *   TimeZone           a timestamptz renders in the session zone, so the same
 *                      instant reads "2024-01-01 12:00:00+00" on one side and
 *                      "2024-01-01 07:00:00-05" on the other. This is the one
 *                      that fires in practice, because almost every table has a
 *                      created_at.
 *   DateStyle          "2024-01-31" vs "01/31/2024" for date and timestamp.
 *   extra_float_digits float8 rounds to 6 significant digits at 0 and round
 *                      trips at 3, which Postgres 12+ defaults to but an older
 *                      server or an explicit ALTER DATABASE SET does not.
 *   IntervalStyle      "1 day 02:00:00" vs "@ 1 day 2 hours".
 *   bytea_output       "\\x4142" vs the escape form.
 *
 * SET LOCAL, so it lasts exactly as long as the read's own transaction and no
 * later query on this pooled connection inherits it.
 */
const SETTINGS_THE_CHECKSUM_DEPENDS_ON = [
  "SET LOCAL TimeZone = 'UTC'",
  "SET LOCAL DateStyle = 'ISO, MDY'",
  "SET LOCAL extra_float_digits = 3",
  "SET LOCAL IntervalStyle = 'postgres'",
  "SET LOCAL bytea_output = 'hex'",
].join("; ");

/**
 * Run one read against one side inside its own short, read-only transaction.
 *
 * Its own transaction because a statement timeout aborts the transaction it
 * fires in: if every table shared one, the first slow table would poison the
 * rest with "current transaction is aborted". READ ONLY because this module has
 * no business writing anything, and saying so means a mistake here is refused
 * by the server rather than caught by review.
 */
async function readQuery<T extends Record<string, unknown>>(
  client: PoolClient,
  sql: string,
  values: unknown[],
  timeoutMs: number,
): Promise<{ ok: true; rows: T[] } | { ok: false; error: string }> {
  try {
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${Math.round(timeoutMs)}`);
    await client.query(SETTINGS_THE_CHECKSUM_DEPENDS_ON);
    const result = await client.query<T>(sql, values);
    await client.query("COMMIT");
    return { ok: true, rows: result.rows };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The connection is already unusable; the original error is the one to
      // report, so a failing rollback must not replace it.
    }
    return { ok: false, error: describeReadError(error) };
  }
}

/** The checksum read, in the shape the verdict wants it. */
async function readSide(
  client: PoolClient,
  sql: string,
  timeoutMs: number,
): Promise<SideResult> {
  const result = await readQuery<{ row_count: string; checksum: string | null }>(
    client,
    sql,
    [],
    timeoutMs,
  );
  if (!result.ok) return result;
  const row = result.rows[0];
  return { ok: true, rows: Number(row.row_count), checksum: row.checksum };
}

/** Turn a driver error into something a person reading the report can act on. */
function describeReadError(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  if (code === "57014") return "timed out";
  if (code === "42501") return "no permission to read this table";
  if (code === "42P01") return "table no longer exists";
  return error instanceof Error ? error.message : String(error);
}

/** What one table needs before it can be read, on both sides. */
type TablePlan = {
  label: string;
  leftTable: string | null;
  rightTable: string | null;
  leftColumns: string[];
  rightColumns: string[];
  /** Columns present on one side only, named as the source calls them. */
  ignoredColumns: string[];
  /**
   * Child tables whose rows this table's own count already includes, so they
   * are not read separately. See foldChildrenIntoParents. Empty for a table
   * that has no children, which is nearly all of them.
   */
  foldedChildren: string[];
  /**
   * The columns rows are paired by when sampling which ones differ, source-side
   * names. Empty when the table has no key both sides share — see
   * pickSampleKey — and on a table only one side has, where there is nothing to
   * pair against.
   */
  keyColumns: string[];
  /** The same key, named as the TARGET calls those columns. Same order. */
  rightKeyColumns: string[];
};

/**
 * The tables one level up whose rows include this table's rows.
 *
 * A partition has exactly one parent, and old-style INHERITS can name several.
 * The capture keeps them in separate fields because PostgreSQL does: a
 * partition never appears in `inherits`.
 *
 * These are bare table names, which is what the snapshot stores. A partition is
 * allowed to live in a different schema from its parent, and then this name is
 * not in this snapshot at all — which is the right answer here, because a
 * parent in another schema is not a table this run reads either.
 */
function parentNames(table: TableSnapshot): string[] {
  const part = table.partitioning;
  // undefined means the snapshot predates partitioning being recorded. Treating
  // that as "standalone" is the safe reading: the table is read on its own, as
  // it always was.
  if (!part) return [];
  return part.partitionOf !== null ? [part.partitionOf] : part.inherits;
}

/**
 * Take the child tables out of a group and hand their rows to the parent.
 *
 * `SELECT count(*) FROM parent` reads the parent AND every partition and
 * INHERITS child under it — that is what a partitioned table IS, and short of
 * `ONLY` there is no way to ask for the parent alone. So planning a parent and
 * its four partitions as five tables counts the same rows five times: a
 * partitioned table only the target has reported five times its real size as
 * "rows a sync destroys", and spent five of the sixty slots a run has to do it.
 *
 * Only one-sided groups are folded. A matched parent and its matched partitions
 * are read separately on purpose: each checksum is a true statement about that
 * table, and knowing WHICH partition differs is the useful half of the answer.
 *
 * Returns the tables still worth reading, each with the children it now speaks
 * for. Those names end up in the note, because a table that silently disappears
 * from a data compare is the exact failure this module exists to prevent.
 */
function foldChildrenIntoParents(
  group: TableSnapshot[],
  everyTableOnThatSide: TableSnapshot[],
): { table: TableSnapshot; folded: string[] }[] {
  const inGroup = new Set(group.map((table) => table.name));
  const byName = new Map(everyTableOnThatSide.map((table) => [table.name, table]));

  // The HIGHEST ancestor of this table that the run is already reading, or null
  // when there is none. Highest rather than nearest: a partition can itself be
  // partitioned, and if the middle table is folded away too then attributing
  // the rows to it would name a table that never appears in the report.
  //
  // `seen` guards against a cycle. PostgreSQL cannot build one, but a snapshot
  // is data from somewhere else and a bad one must not hang the page.
  function readingAncestorOf(table: TableSnapshot): string | null {
    const seen = new Set([table.name]);
    let queue = parentNames(table);
    let highest: string | null = null;
    while (queue.length > 0) {
      const next: string[] = [];
      for (const name of queue) {
        if (seen.has(name)) continue;
        seen.add(name);
        if (inGroup.has(name)) highest = name;
        const parent = byName.get(name);
        if (parent) next.push(...parentNames(parent));
      }
      queue = next;
    }
    return highest;
  }

  const foldedInto = new Map<string, string[]>();
  const kept: TableSnapshot[] = [];
  for (const table of group) {
    const ancestor = readingAncestorOf(table);
    if (ancestor === null) {
      kept.push(table);
      continue;
    }
    foldedInto.set(ancestor, [...(foldedInto.get(ancestor) ?? []), table.name]);
  }

  return kept.map((table) => ({
    table,
    folded: [...(foldedInto.get(table.name) ?? [])].sort(),
  }));
}

/** A sentence naming the children a table's own count already covers. */
function foldedChildrenNote(plan: TablePlan): string {
  if (plan.foldedChildren.length === 0) return "";
  const many = plan.foldedChildren.length > 1;
  return (
    ` Its child ${many ? "tables" : "table"} ${plan.foldedChildren.join(", ")} ` +
    `${many ? "are" : "is"} counted here rather than separately — a count of ` +
    `this table already includes ${many ? "their" : "its"} rows.`
  );
}

/**
 * Work out what to read, from the structural comparison that already ran.
 *
 * Only columns matched on BOTH sides are hashed, because a column the target
 * does not have yet cannot contribute to a comparable checksum. The pairs come
 * from the column matcher, so a renamed column is still compared against its
 * counterpart — the data did not change just because the label did.
 *
 * The ORDER matters, because a run stops at a table cap and a time budget and
 * marks everything after that as skipped. Tables only the TARGET has go first:
 * they are the ones a sync drops, they are the reason this module exists, and
 * they cost one count(*) each rather than a checksum over every row. With
 * matched tables first, a schema with more than sixty of them pushed every drop
 * past the cap — so nothing was ever counted as at risk, the "rows would be
 * destroyed" banner never appeared, and the panel written to prevent exactly
 * that said nothing. Source-only tables go last: they are created empty, so a
 * missed one costs the reader a row count and no more.
 *
 * Partitions and INHERITS children of a table already in the same group are
 * folded into it rather than planned separately — see foldChildrenIntoParents
 * for why counting them twice is not merely wasteful but wrong.
 */
function planTables(report: CompareReport): TablePlan[] {
  const plans: TablePlan[] = [];

  for (const { table, folded } of foldChildrenIntoParents(
    report.tablesOnlyInB,
    report.right.tables,
  )) {
    plans.push({
      label: table.name,
      leftTable: null,
      rightTable: table.name,
      leftColumns: [],
      rightColumns: [],
      ignoredColumns: [],
      foldedChildren: folded,
      // Nothing to pair against: the other side does not have this table.
      keyColumns: [],
      rightKeyColumns: [],
    });
  }

  for (const match of report.matchedTables) {
    // Sorted by the source's column name so both sides project their columns in
    // the same order — the checksum is over a positional ROW(), so a different
    // order on one side would hash the same data differently.
    const pairs = [...match.columnMatches].sort((a, b) =>
      a.left.name.localeCompare(b.left.name),
    );
    const ignored = [
      ...match.columnsOnlyInA.map((col) => col.name),
      ...match.columnsOnlyInB.map((col) => col.name),
    ].sort();
    // The key is chosen from the SOURCE's constraints and then translated into
    // the target's column names through the same pairing the checksum uses, so
    // a column renamed between the two sides still finds its counterpart.
    const leftColumns = pairs.map((pair) => pair.left.name);
    const rightByLeft = new Map(pairs.map((pair) => [pair.left.name, pair.right.name]));
    const keyColumns = pickSampleKey(match.left, new Set(leftColumns)) ?? [];

    plans.push({
      label:
        match.left.name === match.right.name
          ? match.left.name
          : `${match.left.name} → ${match.right.name}`,
      leftTable: match.left.name,
      rightTable: match.right.name,
      leftColumns,
      rightColumns: pairs.map((pair) => pair.right.name),
      ignoredColumns: ignored,
      foldedChildren: [],
      keyColumns,
      // Every key column is in `pairs` — pickSampleKey only returns columns the
      // comparison matched — so the lookup cannot miss.
      rightKeyColumns: keyColumns.map((name) => rightByLeft.get(name) as string),
    });
  }

  for (const { table, folded } of foldChildrenIntoParents(
    report.tablesOnlyInA,
    report.left.tables,
  )) {
    plans.push({
      label: table.name,
      leftTable: table.name,
      rightTable: null,
      leftColumns: [],
      rightColumns: [],
      ignoredColumns: [],
      foldedChildren: folded,
      // Nothing to pair against: the other side does not have this table.
      keyColumns: [],
      rightKeyColumns: [],
    });
  }

  return plans;
}

/**
 * Compare the rows of every table the two schemas share, plus the row counts of
 * the tables only one of them has.
 *
 * Caveat worth knowing when reading a "different" verdict: the checksum is over
 * each value's TEXT rendering, so two servers that render the same value
 * differently — a different major version's `json` spacing, a different
 * `DateStyle` — will disagree even though the data matches. The row counts are
 * exact either way, which is why they are reported separately rather than being
 * folded into one verdict.
 */
export async function compareRowData(
  report: CompareReport,
  source: { config: ClientConfig; schema: string },
  target: { config: ClientConfig; schema: string },
  options: {
    timeoutMs?: number;
    maxTables?: number;
    budgetMs?: number;
    /**
     * Read only these tables, named by the label the report gives them — which
     * is what the screen showed the user and sent back. Undefined, the default,
     * reads all of them.
     *
     * Spec feature 04 asks for "all OR SELECTED table data", and the selection
     * is worth more than convenience on a large schema: a run is capped at
     * DEFAULT_MAX_TABLES and DEFAULT_BUDGET_MS, so on a schema past either
     * bound the only way to get a verdict on a particular table is to ask for
     * that table.
     *
     * The tables left out are still reported, as "skipped" with a note saying
     * why. A selection narrows what is READ, not what the report covers.
     */
    only?: ReadonlyArray<string>;
    /** Find out WHICH rows differ, not just that some do. On by default. */
    sample?: boolean;
  } = {},
): Promise<DataCompareReport> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTables = options.maxTables ?? DEFAULT_MAX_TABLES;
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const sample = options.sample ?? true;

  // A selection that matches nothing is treated as no selection. It means the
  // screen sent table names this comparison does not have — the schema changed
  // under a saved set, most likely — and reporting "no tables to compare" for
  // a schema that plainly has some reads as a broken page rather than a stale
  // selection.
  const wanted = options.only && options.only.length > 0 ? new Set(options.only) : null;
  const plans = planTables(report);
  const matched = wanted ? plans.filter((plan) => wanted.has(plan.label)) : plans;
  // The tables to read, or null for all of them. Every plan is still walked
  // below and the ones left out are reported as not read, rather than being
  // dropped from the report: a narrowed run whose report listed only the two
  // tables it read would shrink the picker to those two, and the reader would
  // have no way back to the rest.
  const chosen = matched.length > 0 ? new Set(matched.map((plan) => plan.label)) : null;
  const deadline = Date.now() + budgetMs;

  // One connection per side held for the whole run: sixty tables means sixty
  // reads, and taking a fresh connection for each of them is the slowest part
  // of the job by a wide margin.
  //
  // allSettled, not all. Promise.all rejects the moment either side fails and
  // never hands back the one that succeeded — so the earlier version's
  // `leftClient?.release()` in the catch could not fire (both variables were
  // still null, the destructuring having never run) and the good connection
  // stayed checked out for the life of the process. The pool is max 4 and is
  // the same pool plain schema introspection uses, so four transient failures
  // — a sleeping compute, "too many clients already", a TLS reset — were
  // enough to wedge every later connection to that database until a restart.
  const [leftSettled, rightSettled] = await Promise.allSettled([
    getPoolForConfig(source.config).connect(),
    getPoolForConfig(target.config).connect(),
  ]);
  if (leftSettled.status === "rejected" || rightSettled.status === "rejected") {
    if (leftSettled.status === "fulfilled") leftSettled.value.release();
    if (rightSettled.status === "fulfilled") rightSettled.value.release();
    // Whichever side actually failed. Both may have; the first is enough to
    // put in front of the reader.
    const error =
      leftSettled.status === "rejected"
        ? leftSettled.reason
        : (rightSettled as PromiseRejectedResult).reason;
    return {
      tables: [],
      error: `Could not open a connection for the data compare: ${describeReadError(error)}`,
      timeoutMs,
    };
  }
  const leftClient: PoolClient = leftSettled.value;
  const rightClient: PoolClient = rightSettled.value;

  const tables: TableDataCompare[] = [];
  try {
    // Counts the tables this run took on, not the plans it walked past: the
    // point of selecting tables is to get a verdict on one that sits past the
    // cap, which counting the skipped ones against it would defeat.
    let attempted = 0;
    for (const plan of plans) {
      if (chosen !== null && !chosen.has(plan.label)) {
        tables.push(notRead(plan, "Not read: it is not one of the selected tables."));
        continue;
      }
      const overBudget = Date.now() >= deadline;
      const overCount = attempted >= maxTables;
      attempted += 1;
      if (overBudget || overCount) {
        tables.push(
          notRead(
            plan,
            overCount
              ? `Not read: only the first ${maxTables} tables are compared in one run.`
              : "Not read: the data compare ran out of its time budget.",
          ),
        );
        continue;
      }

      tables.push(
        await compareOnePlan(
          plan,
          leftClient,
          rightClient,
          source,
          target,
          timeoutMs,
          sample ? deadline : null,
        ),
      );
    }
  } finally {
    leftClient.release();
    rightClient.release();
  }

  return { tables, error: null, timeoutMs };
}

/**
 * A table this run did not read, with the reason in its own words.
 *
 * Three things skip a table — a selection that left it out, the per-run cap,
 * and the time budget — and all three produce the same row. Only the sentence
 * differs, so only the sentence is passed in.
 */
function notRead(plan: TablePlan, note: string): TableDataCompare {
  return {
    table: plan.label,
    status: "skipped",
    leftRows: null,
    rightRows: null,
    leftChecksum: null,
    rightChecksum: null,
    columns: [],
    // Nothing was hashed, so nothing was left out of a hash: an empty list here
    // is the truth, not a claim that the columns all pair up.
    ignoredColumns: [],
    // Said even here: the children were folded into a table that then went
    // unread, so nothing in this report counts their rows and the reader needs
    // to know which tables those were.
    note: note + foldedChildrenNote(plan),
    // Recorded even though nothing was read: a drop the run never reached is
    // still a drop, and this is the flag the banner counts.
    droppedBySync: plan.leftTable === null && plan.rightTable !== null,
    sample: null,
  };
}

/** Read one table on whichever sides have it and decide the verdict. */
async function compareOnePlan(
  plan: TablePlan,
  leftClient: PoolClient,
  rightClient: PoolClient,
  source: { config: ClientConfig; schema: string },
  target: { config: ClientConfig; schema: string },
  timeoutMs: number,
  /**
   * When the run's time budget expires, or null when sampling is off entirely.
   *
   * Checked here rather than by the caller because it is checked LATE: the
   * verdict's two reads happen first, and whether there is time left to also
   * find out which rows differ is not knowable until they are done.
   */
  sampleDeadline: number | null,
): Promise<TableDataCompare> {
  const base = {
    table: plan.label,
    columns: plan.leftColumns,
    // Carried onto every outcome, not just the ones that got as far as a
    // checksum. A reader looking at a skipped table still wants to know the
    // compare would have been a partial one.
    ignoredColumns: plan.ignoredColumns,
    leftRows: null as number | null,
    rightRows: null as number | null,
    leftChecksum: null as string | null,
    rightChecksum: null as string | null,
    // Decided from the plan rather than the outcome, so a read that fails does
    // not quietly stop the table counting as one a sync drops.
    droppedBySync: plan.leftTable === null && plan.rightTable !== null,
    // Only a table that comes back "different" ends up with one; every return
    // below this point that is not that verdict keeps the null.
    sample: null as RowSample | null,
  };

  // A table only one side has: the row count is the whole answer, and it is the
  // number that says how much a DROP TABLE would actually destroy.
  if (plan.leftTable === null || plan.rightTable === null) {
    const onSource = plan.leftTable !== null;
    const client = onSource ? leftClient : rightClient;
    const side = onSource ? source : target;
    const table = (onSource ? plan.leftTable : plan.rightTable) as string;
    const result = await readSide(client, countSql(side.schema, table), timeoutMs);
    // The count that just ran covers this table's children too, so the sentence
    // naming them belongs on both outcomes — including the failure, where it is
    // the only record that those tables were looked at at all.
    const alsoCovers = foldedChildrenNote(plan);
    if (!result.ok) {
      return {
        ...base,
        status: "skipped",
        note: `Could not read: ${result.error}.${alsoCovers}`,
      };
    }
    return {
      ...base,
      status: onSource ? "sourceOnly" : "targetOnly",
      leftRows: onSource ? result.rows : null,
      rightRows: onSource ? null : result.rows,
      note:
        (onSource
          ? "Only the source has this table — the migration creates it, empty."
          : "Only the target has this table — a full sync drops it, and these rows with it.") +
        alsoCovers,
    };
  }

  // No shared column means nothing can be hashed, but the counts still are
  // worth having — an empty table and a full one is a difference either way.
  const countsOnly = plan.leftColumns.length === 0;
  const leftSql = countsOnly
    ? countSql(source.schema, plan.leftTable)
    : checksumSql(source.schema, plan.leftTable, plan.leftColumns);
  const rightSql = countsOnly
    ? countSql(target.schema, plan.rightTable)
    : checksumSql(target.schema, plan.rightTable, plan.rightColumns);

  const [left, right] = await Promise.all([
    readSide(leftClient, leftSql, timeoutMs),
    readSide(rightClient, rightSql, timeoutMs),
  ]);

  if (!left.ok || !right.ok) {
    const reasons = [
      left.ok ? null : `source: ${left.error}`,
      right.ok ? null : `target: ${right.error}`,
    ].filter((reason): reason is string => reason !== null);
    return {
      ...base,
      leftRows: left.ok ? left.rows : null,
      rightRows: right.ok ? right.rows : null,
      status: "skipped",
      note: `Could not read — ${reasons.join(", ")}.`,
    };
  }

  const same = countsOnly
    ? left.rows === right.rows
    : left.rows === right.rows && left.checksum === right.checksum;

  const notes: string[] = [];
  if (countsOnly) {
    notes.push("No columns in common, so only the row counts were compared.");
  } else if (plan.ignoredColumns.length > 0) {
    // The same fact, worded for the verdict it sits under.
    //
    // On a table that came back DIFFERENT the list is a caveat: the difference
    // is real and these columns were not part of finding it. On one that came
    // back IDENTICAL it is the opposite — it is the reason the verdict is
    // narrower than it looks. The checksum covers only the columns both sides
    // have, so a row whose every difference lives in an unpaired column hashes
    // the same on both sides and the table reads as a clean match. Saying
    // "identical" there and leaving the list as a footnote invites exactly the
    // wrong conclusion, so the sentence itself is bounded first and the
    // columns that were left out follow it.
    notes.push(
      same
        ? `Identical on the ${plan.leftColumns.length} ` +
            `${plan.leftColumns.length === 1 ? "column" : "columns"} both sides share. ` +
            `Not compared (present on one side only): ${plan.ignoredColumns.join(", ")}.`
        : `Not included in the checksum (present on one side only): ${plan.ignoredColumns.join(", ")}.`,
    );
  }

  // Which rows differ (spec 04 — sample mismatched rows). Only on a table that
  // came back different, because on an identical one there is nothing to find
  // and the scan would be two more full reads for an empty list.
  // A null deadline means sampling is switched off for the whole run, which is
  // not the same as running out of time: the first has nothing to report, the
  // second has something it could not get to. Folding the two together put "ran
  // out of its time budget" under every differing table of a run that was never
  // going to sample one.
  const sample =
    same || countsOnly || sampleDeadline === null
      ? null
      : Date.now() < sampleDeadline
        ? await sampleDifferences(plan, leftClient, rightClient, source, target, timeoutMs)
        : {
            status: "unavailable" as const,
            keyColumns: plan.keyColumns,
            rows: [],
            more: false,
            scanned: 0,
            partial: false,
            note: "The data compare ran out of its time budget before it could read which rows differ.",
          };

  return {
    ...base,
    status: same ? "identical" : "different",
    leftRows: left.rows,
    rightRows: right.rows,
    leftChecksum: left.checksum,
    rightChecksum: right.checksum,
    note: notes.length > 0 ? notes.join(" ") : null,
    sample,
  };
}
