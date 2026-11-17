// Query analysis: the pieces the text rules are built from.
//
// Holds the thresholds for the text rules, the helpers that spot a function
// wrapped round a column, and the two larger rules kept out of readSql
// (DISTINCT at the top, and many joins).

import type { QueryFinding } from "./findings";
import { andList, countInWords, fmtRows } from "./wording";
import type { PlannerSettings } from "./catalog";
import {
  andParts,
  closingIndex,
  comparisonOf,
  splitTop,
  stripOuterParens,
  type Token,
  tokenize,
} from "./tokens";
import { columnOf, qualifiersFor } from "./conditions";
import type { SqlContext, SqlContextTable } from "./sql-context";
import { finishedStatement, withoutDistinct } from "./sql-text";

/**
 * A result this small comes back in one go. Returning all of it, or sorting
 * all of it, costs too little to be worth a finding, so the missing-WHERE and
 * ORDER BY rules stay quiet below it.
 */
export const SMALL_RESULT_ROWS = 1_000;

/**
 * Tables in one query from which the join order is worth a look. Six tables
 * can be joined in hundreds of orders, and a wrong row estimate for an early
 * join is carried through every join after it.
 */
export const MANY_JOINS = 6;

/**
 * PostgreSQL's own defaults for the settings that decide how hard the planner
 * works on many joins. Used, and named as the defaults, when the server's
 * values could not be read.
 */
export const DEFAULT_PLANNER_SETTINGS: PlannerSettings = {
  joinCollapseLimit: 8,
  geqoThreshold: 12,
  geqo: true,
};

/** One comparison in a Filter the plan applies, and the table it filters. */
type FilterAtom = { table: SqlContextTable; left: Token[]; op: string; right: Token[] };

/**
 * Every comparison in every Filter the plan applies, as `split` cuts each
 * Filter into conditions. None without a context.
 */
export function filterAtoms(
  context: SqlContext | undefined,
  split: (tokens: Token[]) => Token[][]
): FilterAtom[] {
  const atoms: FilterAtom[] = [];
  for (const table of context?.tables ?? []) {
    if (table.filter === null) continue;
    for (const condition of split(tokenize(table.filter))) {
      const cmp = comparisonOf(condition);
      if (cmp !== null) atoms.push({ table, ...cmp });
    }
  }
  return atoms;
}

/** The ANDed conditions, or none when an OR joins them: no one index answers an OR. */
export function andedConditions(tokens: Token[]): Token[][] {
  const top = stripOuterParens(tokens);
  return splitTop(top, "OR").length > 1 ? [] : andParts(top);
}

/**
 * `lower(o.email)` or `upper((o.code)::text)` → the function and the column,
 * when one side of a comparison is exactly that, or null.
 */
export function wrappedColumn(
  side: Token[],
  quals: string[],
  columnTypes: Record<string, string>
): { fn: "lower" | "upper"; column: string } | null {
  const t = stripOuterParens(side);
  if (t.length < 4 || t[0].kind !== "ident" || t[1].text !== "(") return null;
  if (closingIndex(t, 1) !== t.length - 1) return null;
  const name = t[0].text.toLowerCase();
  const fn = name === "lower" || name === "upper" ? name : null;
  if (fn === null) return null;
  const column = columnOf(t.slice(2, -1), quals, columnTypes);
  return column === null ? null : { fn, column };
}

/** record[key], but only a key the record holds itself, never a built-in such as "constructor". */
export function ownValue<T>(record: Record<string, T> | undefined, key: string): T | undefined {
  if (record === undefined || !Object.prototype.hasOwnProperty.call(record, key)) return undefined;
  return record[key];
}

/** The aggregate functions people use most, as they appear in a select list. */
export const AGGREGATE_CALL =
  /\b(?:COUNT|SUM|AVG|MIN|MAX|ARRAY_AGG|STRING_AGG|JSON_AGG|JSONB_AGG|BOOL_AND|BOOL_OR|EVERY)\s*\(/i;

/**
 * A function wrapped round a bare column and then compared: LOWER(email) = ….
 * The function, the column and the comparison are captured so the advice can
 * name them. Global, because a WHERE clause can hold more than one.
 */
export const FUNCTION_ON_COLUMN =
  /\b(LOWER|UPPER|DATE|CAST|COALESCE|SUBSTRING)\s*\(\s*([A-Za-z_][\w.]*)\s*\)\s*(=|<|>|LIKE\b)/gi;

/** A function wrapped round a column in a WHERE clause, as the query wrote it. */
export type WrappedCall = {
  /** The function's name in capitals: "LOWER", "DATE", … */
  fn: string;
  /** The column as written inside the call: "email", "o.created_at". */
  column: string;
  /** The whole call, for quoting back: "LOWER(email)". */
  call: string;
  /** How the call is compared: "=", "<", ">" or "LIKE". */
  op: string;
};

/**
 * True when the plan shows an index answering this very call: a table's
 * index condition applies the same function to the same column, so an index
 * on the expression exists and the plan looks the value up with it. The
 * plan prints the call its own way ("lower((c.email)::text)",
 * "date(events.at)"), so it is matched token by token: the function's name,
 * its bracket, and the column somewhere inside that bracket.
 */
export function answeredByIndex(call: WrappedCall, context: SqlContext | undefined): boolean {
  // "LOWER(c.email)" gives qualifier "c" and column "email". Unquoted names
  // fold to lower case, which is how the plan prints them.
  const parts = call.column.toLowerCase().split(".");
  const column = parts[parts.length - 1];
  const qualifier = parts.length > 1 ? parts[parts.length - 2] : null;
  return (context?.tables ?? []).some((table) => {
    if (table.indexCond === null) return false;
    const names = [table.name, table.alias];
    // "c.email" is about the table the query calls c, not any table with an email.
    if (qualifier !== null && !names.includes(qualifier)) return false;
    const tokens = tokenize(table.indexCond);
    return tokens.some((token, i) => {
      if (token.kind !== "ident" || token.text.toUpperCase() !== call.fn) return false;
      if (tokens[i + 1]?.text !== "(") return false;
      const close = closingIndex(tokens, i + 1);
      for (let j = i + 2; j < (close === -1 ? tokens.length : close); j += 1) {
        if (tokens[j].kind !== "ident" || tokens[j].text !== column) continue;
        // "::text" names a type, not a column.
        if (tokens[j - 1].text === "::") continue;
        // A qualified name must be this table's: the other side of a join's
        // condition can wrap another table's column in the same function.
        if (tokens[j - 1].text === "." && !names.includes(tokens[j - 2]?.text ?? null)) continue;
        return true;
      }
      return false;
    });
  });
}

/**
 * Comment-only advice for a function round a filtered column, for when the
 * plan does not show which table to index. In the query's own words, so the
 * reader sees their own condition rather than an example.
 */
export function rewriteAdvice({ fn, column, call, op }: WrappedCall): string {
  const intro = `-- The condition compares ${call}, so an index on ${column} is no use here.\n`;
  if (fn === "DATE") {
    // A day starts at midnight, so each comparison of the day becomes a
    // comparison of the bare column with a midnight: d + 1 is the next day.
    const pairs = [
      [`${call} = d`, `${column} >= d AND ${column} < d + 1`],
      [`${call} >= d`, `${column} >= d`],
      [`${call} > d`, `${column} >= d + 1`],
      [`${call} < d`, `${column} < d`],
      [`${call} <= d`, `${column} < d + 1`],
    ];
    const width = Math.max(...pairs.map(([from]) => from.length));
    return (
      intro +
      "-- Compare the bare column with the start of a day instead, d being the\n" +
      "-- day you want, as a date:\n" +
      pairs.map(([from, to]) => `--   ${from.padEnd(width)}  becomes  ${to}`).join("\n")
    );
  }
  if ((fn === "LOWER" || fn === "UPPER") && op === "LIKE") {
    // A plain B-tree index only serves LIKE under the "C" collation;
    // text_pattern_ops makes it serve a pattern with a fixed start in any.
    return (
      intro +
      `-- For a pattern with a fixed start ('abc%'), an index on ${fn}(${column})\n` +
      `-- built with text_pattern_ops, on the table that holds ${column}, can serve\n` +
      "-- it. A pattern that starts with % cannot use an ordinary index at all."
    );
  }
  if (fn === "LOWER" || fn === "UPPER") {
    return (
      intro +
      `-- When it picks out a few rows of a big table, an index on ${fn}(${column})\n` +
      `-- itself, on the table that holds ${column}, lets the server look them up.\n` +
      "-- Or store the value in one case already, and compare the bare column."
    );
  }
  return (
    intro +
    "-- Rewrite the condition so the bare column is compared, doing the work\n" +
    "-- on the value's side of the comparison instead."
  );
}

/**
 * Whether the DISTINCT at the top of the query does any work, when that can
 * be told. Null when it cannot, or when DISTINCT may well be needed.
 *
 * `distinctEnd` is where the DISTINCT keyword ends in `sql`; `textTables` is
 * how many tables the text names; `joins` is whether the main FROM list joins
 * one thing to another (joinsAtTopLevel).
 */
export function topDistinctFinding(
  sql: string,
  distinctEnd: number,
  textTables: number,
  joins: boolean,
  context: SqlContext | undefined
): QueryFinding | null {
  const without = finishedStatement(withoutDistinct(sql, distinctEnd));
  const withoutFix = (lead: string) =>
    lead + (without ?? "-- Take DISTINCT out of the select list.");

  // One table, and the result includes its whole primary key: every row is
  // different already, so DISTINCT can never remove one. Only when nothing
  // can repeat a row of that table: no join or second FROM item in the text,
  // no join in the plan (one to generate_series reads no table, yet repeats
  // rows), and no set-returning function in the select list (unnest(tags)
  // gives one row per array element).
  if (
    context !== undefined &&
    context.tables.length === 1 &&
    textTables <= 1 &&
    !joins &&
    !context.repeatsRows
  ) {
    const only = context.tables[0];
    const primaryKey =
      only.schema === null ? [] : (ownValue(context.primaryKeys, `${only.schema}.${only.name}`) ?? []);
    // The plan writes each returned column as the query knows it
    // ("customers.id"); columnOf turns that back into the bare name.
    const quals = qualifiersFor(only.alias, only.name);
    const returned = context.outputColumns.map((entry) =>
      columnOf(tokenize(entry), quals, only.columnTypes)
    );
    if (primaryKey.length > 0 && primaryKey.every((column) => returned.includes(column))) {
      const verb = primaryKey.length === 1 ? "is" : "make up";
      return {
        id: "unnecessary-distinct",
        stepId: null,
        severity: "medium",
        title: `DISTINCT does nothing here: ${andList(primaryKey)} ${verb} the primary key`,
        object: "the select list",
        detail:
          `Every row of ${only.name} has its own primary key, and the result includes ` +
          "it, so no two rows can be the same. DISTINCT still makes the server look " +
          "for copies across the whole result, by sorting it, hashing it or comparing " +
          "each row with the one before.",
        fix: withoutFix("-- The same rows, without the check:\n"),
        fixKind: "query",
      };
    }
  }

  // It ran, and DISTINCT took nothing out.
  const counts = context?.distinctRows ?? null;
  if (counts !== null && counts.input >= 2 && counts.input === counts.output) {
    return {
      id: "unnecessary-distinct",
      stepId: null,
      severity: "medium",
      title: `DISTINCT removed no rows: all ${countInWords(counts.input)} were already different`,
      object: "the select list",
      detail:
        `When the query ran, DISTINCT checked ${fmtRows(counts.input)} rows and ` +
        "removed none. If the rows can never repeat, for example because a key is " +
        "among the columns, that check is wasted work on every run. If they can, " +
        "keep it.",
      fix: withoutFix("-- Only if the rows can never repeat, drop DISTINCT:\n"),
      fixKind: "query",
    };
  }

  // A join repeating rows is the usual reason a DISTINCT gets added. Only a
  // join the query writes itself: one inside a view is not the reader's to
  // rewrite, and a subquery under IN or EXISTS never repeats a row.
  if (joins) {
    return {
      id: "unnecessary-distinct",
      stepId: null,
      severity: "low",
      title: "DISTINCT may be hiding rows a join repeats",
      object: "the select list",
      detail:
        "When one row matches several rows of a joined table, the join repeats it, " +
        "and DISTINCT then has to look through the whole result to take the copies " +
        "out again. If the joined table is only there as a filter, EXISTS keeps the " +
        "filter without making the copies.",
      fix:
        "-- If a joined table is only there to filter the rows, test it with EXISTS\n" +
        "-- instead of joining it, and drop DISTINCT. The shape, with a the table\n" +
        "-- the rows come from and b the one that filters them:\n" +
        "--   SELECT … FROM a WHERE EXISTS (SELECT 1 FROM b WHERE b.a_id = a.id);",
      fixKind: "query",
    };
  }
  return null;
}

/**
 * The finding for a query that joins `count` tables.
 *
 * `serverSettings` are the server's own join settings, or null when they could
 * not be read; PostgreSQL's defaults stand in then, and the text says so.
 * `explicitJoins` is whether the query writes JOIN: join_collapse_limit only
 * fixes the order of JOINs, never of a comma-separated FROM list.
 */
export function manyJoinsFinding(
  count: number,
  serverSettings: PlannerSettings | null,
  explicitJoins: boolean
): QueryFinding {
  const s = serverSettings ?? DEFAULT_PLANNER_SETTINGS;
  const setting = (value: number) =>
    serverSettings === null ? `${value}, PostgreSQL's default` : `${value} on this server`;
  const fixedOrder = explicitJoins && count > s.joinCollapseLimit;
  // The planner orders one list of tables at a time. Past the limit, JOINs
  // come in lists of at most join_collapse_limit tables, so the randomised
  // search only starts when a list that long reaches geqo_threshold.
  const longestList = fixedOrder ? s.joinCollapseLimit : count;
  const randomSearch = s.geqo && longestList >= s.geqoThreshold;
  // Lifting join_collapse_limit to `count` puts every table in one list,
  // which the randomised search takes over from geqo_threshold on.
  const randomOnceLifted = s.geqo && count >= s.geqoThreshold;

  let detail =
    `This query joins ${count} tables. Each one added multiplies the join orders ` +
    "the planner can choose between, and a wrong row estimate for an early join " +
    "is carried through every join after it.";
  if (fixedOrder) {
    detail +=
      ` Past join_collapse_limit (${setting(s.joinCollapseLimit)}) the planner no ` +
      "longer considers every join order: it splits the JOINs into groups of at " +
      "most that many, following the order the query writes them, so the " +
      "written order limits the plans it can pick.";
  }
  if (randomSearch) {
    detail +=
      ` From geqo_threshold (${setting(s.geqoThreshold)}) tables in one list ` +
      "on, it also switches to a randomised search, so the same query can get " +
      "a different plan from one run to the next.";
  }

  const checks = [
    "-- 1. Each join column on the bigger side of its join has an index.",
    "-- 2. Tick Run it and measure, and look for a join whose row estimate is\n" +
      "--    far off: that is where the plan starts to go wrong.",
  ];
  if (fixedOrder) {
    checks.push(
      "-- 3. The joins that cut the rows down most are written first: past\n" +
        "--    join_collapse_limit the written order limits the plans it can pick."
    );
  }
  // For this session only, and commented out: searching every join order of
  // a many-table query makes planning slower, a trade made query by query.
  // Lowering a setting never helps, so a line appears only past its value.
  const sets: string[] = [];
  if (fixedOrder) sets.push(`-- SET join_collapse_limit = ${count};`);
  if (randomOnceLifted && (fixedOrder || randomSearch)) {
    sets.push(`-- SET geqo_threshold = ${count + 1};`);
  }
  if (sets.length > 0) {
    checks.push(
      `-- ${checks.length + 1}. For this session only, let the planner search every join\n` +
        "--    order. Planning then takes longer, so compare the plans before\n" +
        "--    and after:\n" +
        sets.join("\n")
    );
  }

  return {
    id: "many-joins",
    stepId: null,
    severity: fixedOrder || randomSearch ? "medium" : "low",
    title: fixedOrder
      ? `${count} tables joined: the written JOIN order now matters`
      : randomSearch
        ? `${count} tables joined: the join order is picked by a randomised search`
        : `${count} tables joined in one query`,
    object: "the FROM clause",
    detail,
    fix: "-- Worth checking, from least to most effort:\n" + checks.join("\n"),
    fixKind: "decision",
  };
}
