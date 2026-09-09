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

/** One table's data comparison. */
export type TableDataCompare = {
  /** How the table is labelled in the report — "old → new" when renamed. */
  table: string;
  status:
    | "identical"
    | "different"
    /** Only the source has the table, so only its row count is known. */
    | "sourceOnly"
    /** Only the target has the table. */
    | "targetOnly"
    /** Could not be compared — `note` says why. */
    | "skipped";
  leftRows: number | null;
  rightRows: number | null;
  leftChecksum: string | null;
  rightChecksum: string | null;
  /** The columns that were hashed, named as the source calls them. */
  columns: string[];
  /** Why it was skipped, or what was left out of an otherwise-good compare. */
  note: string | null;
  /**
   * True when a full sync drops this table — whether or not its rows were read.
   *
   * `status` alone cannot answer this. A table only the target has is dropped,
   * but if the run hit its table cap or its time budget before reaching it the
   * status is "skipped" and the drop disappears from every total. That is the
   * one fact this module exists to report, so it is recorded separately from
   * whether the read succeeded.
   */
  droppedBySync: boolean;
};

export type DataCompareReport = {
  tables: TableDataCompare[];
  /** A failure that stopped the whole run — no table result is meaningful. */
  error: string | null;
  /** Per-statement timeout actually used, so the UI can say what it was. */
  timeoutMs: number;
};

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

/** How many tables one run will look at, most-interesting-first. */
const DEFAULT_MAX_TABLES = 60;

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
async function readSide(
  client: PoolClient,
  sql: string,
  timeoutMs: number,
): Promise<SideResult> {
  try {
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${Math.round(timeoutMs)}`);
    await client.query(SETTINGS_THE_CHECKSUM_DEPENDS_ON);
    const result = await client.query<{ row_count: string; checksum: string | null }>(
      sql,
    );
    await client.query("COMMIT");
    const row = result.rows[0];
    return {
      ok: true,
      rows: Number(row.row_count),
      checksum: row.checksum,
    };
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
    plans.push({
      label:
        match.left.name === match.right.name
          ? match.left.name
          : `${match.left.name} → ${match.right.name}`,
      leftTable: match.left.name,
      rightTable: match.right.name,
      leftColumns: pairs.map((pair) => pair.left.name),
      rightColumns: pairs.map((pair) => pair.right.name),
      ignoredColumns: ignored,
      foldedChildren: [],
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
  options: { timeoutMs?: number; maxTables?: number; budgetMs?: number } = {},
): Promise<DataCompareReport> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTables = options.maxTables ?? DEFAULT_MAX_TABLES;
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;

  const plans = planTables(report);
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
    for (const [index, plan] of plans.entries()) {
      const overBudget = Date.now() >= deadline;
      const overCount = index >= maxTables;
      if (overBudget || overCount) {
        tables.push({
          table: plan.label,
          status: "skipped",
          leftRows: null,
          rightRows: null,
          leftChecksum: null,
          rightChecksum: null,
          columns: [],
          note:
            (overCount
              ? `Not read: only the first ${maxTables} tables are compared in one run.`
              : "Not read: the data compare ran out of its time budget.") +
            // Said even here: the children were folded into a table that then
            // went unread, so nothing in this report counts their rows and the
            // reader needs to know which tables those were.
            foldedChildrenNote(plan),
          // Recorded even though nothing was read: a drop the run never reached
          // is still a drop, and this is the flag the banner counts.
          droppedBySync: plan.leftTable === null && plan.rightTable !== null,
        });
        continue;
      }

      tables.push(
        await compareOnePlan(plan, leftClient, rightClient, source, target, timeoutMs),
      );
    }
  } finally {
    leftClient.release();
    rightClient.release();
  }

  return { tables, error: null, timeoutMs };
}

/** Read one table on whichever sides have it and decide the verdict. */
async function compareOnePlan(
  plan: TablePlan,
  leftClient: PoolClient,
  rightClient: PoolClient,
  source: { config: ClientConfig; schema: string },
  target: { config: ClientConfig; schema: string },
  timeoutMs: number,
): Promise<TableDataCompare> {
  const base = {
    table: plan.label,
    columns: plan.leftColumns,
    leftRows: null as number | null,
    rightRows: null as number | null,
    leftChecksum: null as string | null,
    rightChecksum: null as string | null,
    // Decided from the plan rather than the outcome, so a read that fails does
    // not quietly stop the table counting as one a sync drops.
    droppedBySync: plan.leftTable === null && plan.rightTable !== null,
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

  const notes: string[] = [];
  if (countsOnly) {
    notes.push("No columns in common, so only the row counts were compared.");
  } else if (plan.ignoredColumns.length > 0) {
    notes.push(
      `Not included in the checksum (present on one side only): ${plan.ignoredColumns.join(", ")}.`,
    );
  }

  const same = countsOnly
    ? left.rows === right.rows
    : left.rows === right.rows && left.checksum === right.checksum;

  return {
    ...base,
    status: same ? "identical" : "different",
    leftRows: left.rows,
    rightRows: right.rows,
    leftChecksum: left.checksum,
    rightChecksum: right.checksum,
    note: notes.length > 0 ? notes.join(" ") : null,
  };
}

/** Headline counts for the summary line above the table. */
export function summarizeDataCompare(result: DataCompareReport): {
  identical: number;
  different: number;
  sourceOnly: number;
  targetOnly: number;
  skipped: number;
  /**
   * Rows a full sync would destroy.
   *
   * A table only the TARGET has is the one the migration drops — the source is
   * the desired state, so anything the target has and the source does not is
   * removed. These rows are the ones no down script can bring back.
   *
   * It counts only tables that were actually read. See unreadDrops for the ones
   * the run never got to, whose rows are destroyed just the same.
   */
  rowsAtRiskOfDrop: number;
  /**
   * Tables a full sync drops whose rows were never counted — the run hit its
   * table cap, its time budget, or could not read them.
   *
   * Kept apart from rowsAtRiskOfDrop because there is no number to add: the
   * honest statement is "and N more, count unknown", not a larger total.
   */
  unreadDrops: number;
} {
  let identical = 0;
  let different = 0;
  let sourceOnly = 0;
  let targetOnly = 0;
  let skipped = 0;
  let rowsAtRiskOfDrop = 0;
  let unreadDrops = 0;

  for (const table of result.tables) {
    if (table.status === "identical") identical += 1;
    else if (table.status === "different") different += 1;
    else if (table.status === "sourceOnly") sourceOnly += 1;
    else if (table.status === "targetOnly") {
      targetOnly += 1;
      rowsAtRiskOfDrop += table.rightRows ?? 0;
    } else {
      skipped += 1;
      if (table.droppedBySync) unreadDrops += 1;
    }
  }

  return {
    identical,
    different,
    sourceOnly,
    targetOnly,
    skipped,
    rowsAtRiskOfDrop,
    unreadDrops,
  };
}
