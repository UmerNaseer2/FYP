// Query analysis: the rules that read the query text.
//
// Holds readSql, one long function with a rule per problem the text of a
// query can show.

import { maskNonCode } from "../../sql/guard";
import {
  createExpressionIndexSql,
  indexName,
  type IndexStatement,
  LARGE_TABLE_ROWS,
  qualifiedName,
  quoteIdent,
} from "../sql";
import { type QueryFinding, type Severity, sortFindings } from "./findings";
import { andList, commentLines, countInWords, fmtRows, oneLine } from "./wording";
import { conditionAtoms } from "./tokens";
import { columnOf, INDEXABLE_OPERATORS, qualifiersFor, valueIsFixed } from "./conditions";
import { type SqlContext, type SqlContextTable, starColumns } from "./sql-context";
import {
  atTopLevel,
  codeMatches,
  finishedStatement,
  inCode,
  inSetOperationBranch,
  joinsAtTopLevel,
  mostTablesInOneSelect,
  parenDepthAt,
  tablesInText,
  whereClauses,
  withoutDistinct,
  wordBeforeGroup,
} from "./sql-text";
import {
  AGGREGATE_CALL,
  andedConditions,
  answeredByIndex,
  filterAtoms,
  FUNCTION_ON_COLUMN,
  MANY_JOINS,
  manyJoinsFinding,
  ownValue,
  rewriteAdvice,
  SMALL_RESULT_ROWS,
  topDistinctFinding,
  type WrappedCall,
  wrappedColumn,
} from "./sql-rule-parts";

/**
 * Rules that read only the query text.
 *
 * Every one of these is a heuristic and is written to be wrong in the safe
 * direction: it says "this shape usually costs you X", never "your query is
 * broken". The plan (see read-plan.ts) is the authority on what this server will actually
 * do; these hold when there is no server to ask.
 *
 * `context` is what the plan and the catalog said about the same query
 * (sqlContextFromPlan). With it a rule judges the query by its real size and
 * names the real tables and columns: returning every row of a 40-row table is
 * fine, of a 4-million-row one it is not. Without it every rule takes its
 * quietest reading, and names nothing it cannot see.
 *
 * Only read queries reach this far (checkAnalysable), so there is no rule for
 * an UPDATE or DELETE without a WHERE: such a statement is refused before it
 * is analysed.
 */
export function readSql(sql: string, context?: SqlContext): QueryFinding[] {
  const mask = maskNonCode(sql);
  const out: QueryFinding[] = [];
  const hasWhere = inCode(mask, /\bWHERE\b/i);
  const groupedAtTop = atTopLevel(mask, /\bGROUP\s+BY\b/i);
  const textTables = tablesInText(mask);
  // Index names suggested in this report, so two suggestions never share one.
  const suggested: string[] = [];
  const takenIn = (schema: string) => [
    ...(ownValue(context?.relationNames, schema) ?? []),
    ...suggested,
  ];

  // SELECT *, SELECT DISTINCT * and alias.*: each asks for every column. The
  // mask has blanked a quoted alias ("o".*), so the name in front of the dot
  // is checked in the original text.
  //
  // Only a star in the main select list is what the query sends back: one
  // outside every bracket, or one in a bracketed branch of the statement's
  // own UNION, INTERSECT or EXCEPT. Inside EXISTS (…) the star is never
  // fetched: EXISTS only asks whether a row is there. Inside a derived table
  // or a WITH query, the outer select list decides what comes back, and
  // PostgreSQL usually fetches only the columns that list uses. Inside a
  // function call (count(o.*), to_jsonb(o.*)) the whole row is what the
  // call is for.
  const stars = [
    ...codeMatches(mask, /\bSELECT\s+(?:DISTINCT\s+|ALL\s+)?\*/i),
    ...codeMatches(mask, /\.\s*\*/).filter((m) =>
      /(?:^|[^\w$"])(?:[A-Za-z_][\w$]*|"(?:[^"]|"")+")\s*$/.test(
        sql.slice(Math.max(0, m.index - 200), m.index)
      )
    ),
  ].filter((m) => parenDepthAt(mask, m.index) === 0 || inSetOperationBranch(mask, m.index));
  if (stars.length > 0) {
    // The plan's Output is what the top of the query really returns, so it
    // is offered as the list to choose from, and nothing is made up.
    const columns = starColumns(sql, context);
    out.push({
      id: "select-star",
      stepId: null,
      severity: "low",
      title: "SELECT * asks for every column",
      object: "the select list",
      detail:
        "Every column is fetched and sent back, including ones this query never " +
        "looks at, and an index that covers the columns you do use cannot be used " +
        "on its own. It also means adding a column to the table silently changes " +
        "what this query returns.",
      fix:
        columns.length > 0
          ? "-- Put the columns the code reading this result uses in place of the *.\n" +
            "-- Today the query returns these:\n" +
            commentLines(columns)
          : "-- Put the columns the code reading this result uses in place of the *,\n" +
            "-- so the query asks only for those.",
      fixKind: "query",
    });
  }

  // The wildcard lives inside a string literal, which the mask blanks — so the
  // keyword is located in code and the pattern is then read from the original.
  // E'…' is the escape-string form of the same literal.
  const leading = codeMatches(mask, /\b(?:I?LIKE|SIMILAR\s+TO)\b/i).filter((m) =>
    /^\s*[Ee]?'%/.test(sql.slice(m.end, m.end + 40))
  );
  if (leading.length > 0) {
    // ILIKE ignores case, and an index built with text_pattern_ops does not.
    const ilike = leading.some((m) => /^ILIKE$/i.test(mask.slice(m.index, m.end)));
    // The plan prints LIKE as ~~ and ILIKE as ~~*, with the real column and
    // table, so the advice can name what the pattern is matched against.
    const searched = new Map<string, { table: SqlContextTable; column: string }>();
    for (const atom of filterAtoms(context, conditionAtoms)) {
      if (atom.op !== "~~" && atom.op !== "~~*") continue;
      const pattern = atom.right[0];
      if (pattern?.kind !== "str" || !/^[Ee]?'%/.test(pattern.text)) continue;
      const quals = qualifiersFor(atom.table.alias, atom.table.name);
      const column = columnOf(atom.left, quals, atom.table.columnTypes);
      if (column === null) continue;
      const key = JSON.stringify([atom.table.schema, atom.table.name, column]);
      searched.set(key, { table: atom.table, column });
    }
    const named = [...searched.values()];

    // Commented out on purpose: pg_trgm is an extension for the whole server,
    // and a trigram index is large to keep up to date, so building one is a
    // choice for whoever runs the server, not a statement to paste.
    const statements: string[] = [];
    for (const { table, column } of named) {
      if (table.schema === null) continue;
      const name = indexName(table.name, `${column}_trgm`, takenIn(table.schema));
      suggested.push(name);
      const target = qualifiedName(table.schema, table.name);
      statements.push(
        "-- " +
          oneLine(`CREATE INDEX ${quoteIdent(name)} ON ${target} USING gin (${quoteIdent(column)} gin_trgm_ops);`)
      );
    }
    out.push({
      id: "leading-wildcard",
      stepId: null,
      severity: "medium",
      title: "A pattern starting with % cannot use an ordinary index",
      object:
        named.length > 0
          ? andList(named.map(({ table, column }) => `${table.name}.${column}`))
          : "the LIKE condition",
      detail:
        "A B-tree index is sorted by the start of the value, so it can find " +
        "everything beginning with \"smith\" but nothing about what ends with it. " +
        "A leading % forces the server to test every row.",
      fix:
        "-- Two ways out; which one fits depends on what people search for.\n" +
        (ilike
          ? "-- 1. Values that START with the text: drop the leading %. As ILIKE\n" +
            "--    ignores case, write lower(column) LIKE 'text%', with the text in\n" +
            "--    lower case: an index on lower(column) built with text_pattern_ops\n" +
            "--    can then find them.\n"
          : "-- 1. Values that START with the text: drop the leading %. An index on\n" +
            "--    the column built with text_pattern_ops can then find them.\n") +
        "-- 2. The text ANYWHERE in the value: a trigram index can serve that.\n" +
        "--    It needs the pg_trgm extension, a change to the whole server, and\n" +
        "--    it is a large index to keep up to date, so agree it with whoever\n" +
        (statements.length > 0
          ? "--    runs the server:\n-- CREATE EXTENSION IF NOT EXISTS pg_trgm;\n" + statements.join("\n")
          : "--    runs the server, and build it on the column the pattern is\n" +
            "--    matched against."),
      fixKind: "decision",
    });
  }

  // LOWER(email) = … and friends: the index is on the column, the condition is
  // on the result of a function, and those are two different things.
  //
  // Searched inside each WHERE clause rather than across the whole statement:
  // a single regex with `[\s\S]*` between WHERE and the call was satisfied by a
  // function call anywhere later — a SELECT list, an ORDER BY, a following
  // subquery — so the finding fired on statements that wrap nothing.
  const calls: WrappedCall[] = [];
  for (const clause of whereClauses(mask)) {
    for (const m of mask.slice(clause.start, clause.end).matchAll(FUNCTION_ON_COLUMN)) {
      const call = m[0].slice(0, m[0].lastIndexOf(")") + 1).replace(/\s+/g, " ");
      calls.push({ fn: m[1].toUpperCase(), column: m[2], call, op: m[3].toUpperCase() });
    }
  }
  // A call an index on the expression already answers needs no advice: the
  // plan looks the value up instead of working it out for every row.
  const open = calls.filter((call) => !answeredByIndex(call, context));
  if (open.length > 0) {
    // With the plan: lower() or upper() round a column in the Filter of a
    // step that reads a big table to keep few of its rows is exactly what
    // an index on that expression serves. Only for conditions ANDed
    // together (no one index answers an OR) that compare with a value fixed
    // for the whole scan, and only for a call the text wrote too, so the
    // finding's words and its fix are about the same condition. The text's
    // column may carry a qualifier ("c.email"); unquoted, it folds to lower
    // case, as the plan prints it.
    const indexes: IndexStatement[] = [];
    const indexedCalls: WrappedCall[] = [];
    // The schemas those indexes go in, each once (QueryFinding.schemas).
    const indexSchemas: string[] = [];
    const seen: string[] = [];
    for (const atom of filterAtoms(context, andedConditions)) {
      const { table } = atom;
      if (!INDEXABLE_OPERATORS.has(atom.op)) continue;
      if (table.schema === null || !table.selectiveScan) continue;
      const quals = qualifiersFor(table.alias, table.name);
      const left = wrappedColumn(atom.left, quals, table.columnTypes);
      const right = wrappedColumn(atom.right, quals, table.columnTypes);
      let found: { fn: "lower" | "upper"; column: string } | null = null;
      if (left !== null && valueIsFixed(atom.right, quals)) found = left;
      else if (right !== null && valueIsFixed(atom.left, quals)) found = right;
      if (found === null) continue;
      const { fn, column } = found;
      const written = open.find(
        (c) =>
          c.fn === fn.toUpperCase() &&
          c.op !== "LIKE" &&
          c.column.slice(c.column.lastIndexOf(".") + 1).toLowerCase() === column
      );
      if (written === undefined) continue;
      const key = JSON.stringify([table.schema, table.name, fn, column]);
      if (seen.includes(key)) continue;
      seen.push(key);
      const index = createExpressionIndexSql(table.schema, table.name, fn, column, takenIn(table.schema));
      suggested.push(index.name);
      indexes.push(index);
      indexedCalls.push(written);
      if (!indexSchemas.includes(table.schema)) indexSchemas.push(table.schema);
    }

    // The call the finding is about: one the plan let us index, else the
    // first one written.
    const wrapped = indexedCalls[0] ?? open[0];
    const finding: QueryFinding = {
      id: "function-on-column",
      stepId: null,
      severity: "medium",
      title: "A function is applied to the column being filtered",
      object: wrapped.call,
      detail:
        `An index stores the column's values, not the results of ${wrapped.call}, ` +
        `so this condition cannot use an index on ${wrapped.column}. The server has ` +
        `to work out ${wrapped.fn}() for every row before it can compare anything.`,
      fix: rewriteAdvice(wrapped),
      fixKind: "query",
    };
    if (indexes.length > 0) {
      finding.fix =
        "-- An index on the expression itself lets the server look the value up\n" +
        "-- instead of working it out for every row. Build it, then analyse again.\n" +
        indexes.map((index) => index.sql).join("\n\n");
      finding.fixKind = "change";
      finding.undo = indexes.map((index) => index.undo).join("\n");
      finding.schemas = indexSchemas;
    }
    out.push(finding);
  }

  if (inCode(mask, /\bNOT\s+IN\s*\(\s*SELECT\b/i)) {
    out.push({
      id: "not-in-subquery",
      stepId: null,
      severity: "medium",
      title: "NOT IN (SELECT …) returns nothing if the subquery has a NULL",
      object: "the NOT IN condition",
      detail:
        "This is a correctness trap before it is a speed one: if a single row of " +
        "the subquery is NULL, the comparison is never true for anything and the " +
        "whole query returns no rows at all. NOT EXISTS does not have that rule, " +
        "and usually plans better as well.",
      fix:
        "-- The same intent without the NULL trap. The shape, with a the table\n" +
        "-- the rows come from and b the one the subquery reads:\n" +
        "--   SELECT … FROM a WHERE a.b_id NOT IN (SELECT b.id FROM b)\n" +
        "-- becomes\n" +
        "--   SELECT … FROM a WHERE NOT EXISTS (SELECT 1 FROM b WHERE b.id = a.b_id)\n" +
        "-- Unlike NOT IN, it also keeps the rows of a whose a.b_id is NULL.",
      fixKind: "query",
    });
  }

  // FROM a, b — a join whose condition, if it exists at all, is buried in the
  // WHERE clause. Deliberately narrow: only a comma directly between two
  // table-ish names right after FROM.
  if (inCode(mask, /\bFROM\s+[A-Za-z_][\w.]*(?:\s+(?!WHERE|JOIN|GROUP|ORDER|LIMIT|UNION|ON)[A-Za-z_]\w*)?\s*,\s*[A-Za-z_][\w.]*/i)) {
    out.push({
      id: "comma-join",
      stepId: null,
      severity: "low",
      title: "Tables are joined with a comma",
      object: "the FROM clause",
      detail:
        "The join condition, if there is one, is somewhere in the WHERE clause " +
        "mixed in with the filters. Forget it and this becomes every row of one " +
        "table paired with every row of the other. An explicit JOIN … ON puts the " +
        "condition where it cannot be lost.",
      fix:
        "-- Move each join condition out of the WHERE clause, next to its table.\n" +
        "-- The shape, with a and b two of the tables:\n" +
        "--   SELECT … FROM a, b WHERE b.a_id = a.id AND …\n" +
        "-- becomes\n" +
        "--   SELECT … FROM a JOIN b ON b.a_id = a.id WHERE …",
      fixKind: "query",
    });
  }

  // Only an ORDER BY that orders the result set. A window function's
  // `OVER (ORDER BY …)` and a subquery's own ordering both sit inside
  // parentheses, and neither has anything to do with how many rows come back.
  // Not after a GROUP BY either, whose result is one row per group and
  // usually short, and not when the plan expects a small result: sorting a
  // few hundred rows costs nothing worth a finding.
  const topLevelOrderBy = atTopLevel(mask, /\bORDER\s+BY\b/i);
  const smallResult = context !== undefined && context.expectedRows < SMALL_RESULT_ROWS;
  // A LIMIT inside a subquery limits that subquery, not the result.
  const limitedAlready = atTopLevel(mask, /\bLIMIT\b|\bFETCH\s+(?:FIRST|NEXT)\b/i);
  if (topLevelOrderBy && !limitedAlready && !groupedAtTop && !smallResult) {
    const limited = finishedStatement(sql, "LIMIT 20");
    out.push({
      id: "order-by-no-limit",
      stepId: null,
      severity: "low",
      title: "Everything is sorted, and all of it is returned",
      object: "the ORDER BY clause",
      detail:
        "Without a LIMIT the server has to sort every matching row before it can " +
        "return the first one, and then send all of them. If this is feeding a " +
        "screen that shows twenty rows, it is doing far more work than the screen needs.",
      fix:
        "-- If a screen shows these a page at a time, fetch one page:\n" +
        (limited ?? "-- Add LIMIT 20 at the end of the statement."),
      fixKind: "query",
    });
  }

  const bigOffset = codeMatches(mask, /\bOFFSET\s+\d+/i).some((m) => {
    const digits = /(\d+)/.exec(mask.slice(m.index, m.end));
    return digits ? Number(digits[1]) >= 1000 : false;
  });
  if (bigOffset) {
    out.push({
      id: "deep-offset",
      stepId: null,
      severity: "medium",
      title: "A large OFFSET still reads everything it skips",
      object: "the OFFSET clause",
      detail:
        "OFFSET does not jump — the server produces the skipped rows and then " +
        "discards them. Page 1 is instant and page 500 is slow, on the same query. " +
        "Remembering where the last page ended avoids the whole problem.",
      fix:
        "-- Keyset pagination: remember the sort key of the last row on a page,\n" +
        "-- and start the next page after it. The shape, for a list sorted\n" +
        "-- newest first, with the last row's values in place of the ? marks:\n" +
        "--   SELECT … FROM t\n" +
        "--    WHERE (created_at, id) < (?, ?)\n" +
        "--    ORDER BY created_at DESC, id DESC\n" +
        "--    LIMIT 20;\n" +
        "-- An index on (created_at, id) lets each page start straight at its row.",
      fixKind: "query",
    });
  }

  // DISTINCT, judged rather than flagged on sight. DISTINCT ON is a different
  // feature (one row per group) and is left alone. At most one finding: the
  // DISTINCT on the whole result if there is one, else one inside IN or
  // EXISTS.
  const distincts = codeMatches(mask, /\bSELECT\s+DISTINCT\b(?!\s+ON\b)/i);
  // Not beside UNION, INTERSECT or EXCEPT: the plan's top step then removes
  // the set operation's duplicates rather than this DISTINCT's, so its counts
  // and the primary-key reading would be about something else.
  const setOperation = atTopLevel(mask, /\b(?:UNION|INTERSECT|EXCEPT)\b/i);
  const topDistinct = setOperation
    ? undefined
    : distincts.find((m) => parenDepthAt(mask, m.index) === 0);
  let distinct =
    topDistinct === undefined
      ? null
      : topDistinctFinding(sql, topDistinct.end, textTables, joinsAtTopLevel(mask), context);
  const innerDistinct = distincts.find((m) => {
    const word = wordBeforeGroup(mask, m.index);
    return word === "IN" || word === "EXISTS";
  });
  if (distinct === null && innerDistinct !== undefined) {
    const word = wordBeforeGroup(mask, innerDistinct.index);
    const without = finishedStatement(withoutDistinct(sql, innerDistinct.end));
    distinct = {
      id: "unnecessary-distinct",
      stepId: null,
      severity: "low",
      title: `DISTINCT inside ${word} (…) changes nothing`,
      object: `the ${word} subquery`,
      detail:
        "IN (…) and EXISTS (…) only ask whether a matching row is there, so " +
        "repeated rows in the subquery never change the result. Under IN, " +
        "DISTINCT can still make the server sort or hash the subquery's rows " +
        "first; under EXISTS the server ignores it, and it only misleads the reader.",
      fix:
        "-- The same result, without the DISTINCT:\n" +
        (without ?? "-- Take DISTINCT out of the subquery."),
      fixKind: "query",
    };
  }
  if (distinct !== null) out.push(distinct);

  // COUNT(*) over one big table with no WHERE: PostgreSQL keeps no stored
  // row count, so it reads the whole table. Only with the plan to say how
  // big the table is, and only for one table: across a join the count is of
  // joined rows, which no statistic holds. And only when the plan reads all
  // of it straight into the count: a view with its own WHERE counts fewer
  // rows than the table's statistic holds, and so does a count over
  // `(SELECT * FROM orders LIMIT 10)` or over a GROUP BY's groups.
  const counted = context !== undefined && context.tables.length === 1 ? context.tables[0] : null;
  const countsAll = inCode(mask, /\bCOUNT\s*\(\s*\*\s*\)/i) && !hasWhere && !groupedAtTop;
  if (
    counted !== null &&
    counted.readsAll &&
    counted.feedsPlainAggregate &&
    counted.rows >= LARGE_TABLE_ROWS &&
    countsAll
  ) {
    // Single quotes doubled: the name sits inside a string literal.
    const literal =
      counted.schema === null ? null : qualifiedName(counted.schema, counted.name).replace(/'/g, "''");
    out.push({
      id: "unfiltered-count",
      stepId: null,
      severity: "low",
      title: "Counting every row means reading every row",
      object: "the COUNT(*)",
      detail:
        `${counted.name} holds about ${countInWords(counted.rows)} rows. PostgreSQL ` +
        "keeps no stored row count, because two sessions can rightly disagree about " +
        "how many rows exist, so an unfiltered COUNT(*) reads the whole table every " +
        "time it is asked.",
      fix:
        "-- Good enough for \"about how many\", and instant: the count the server's\n" +
        "-- statistics hold, as fresh as the table's last ANALYZE. A result of -1\n" +
        "-- means the table has never been analysed.\n" +
        (literal === null
          ? "-- Ask pg_class.reltuples for this table."
          : "SELECT reltuples::bigint AS approx_rows\n" +
            `  FROM pg_class WHERE oid = '${literal}'::regclass;`),
      fixKind: "query",
    });
  }

  // A SELECT with no WHERE anywhere returns every row it reads. Not when
  // something already caps or shrinks the result (LIMIT, GROUP BY, HAVING,
  // DISTINCT, an aggregate), and not when the result is small anyway.
  // `TABLE orders` is shorthand for SELECT * FROM orders, so it counts.
  //
  // A WHERE at any depth, even one inside a subquery, keeps the rule quiet on
  // purpose: from the text alone it cannot tell whether that WHERE shrinks
  // the result. So it speaks only when there is no WHERE at all, which is
  // the one thing its title says.
  const readsTable = textTables > 0 || atTopLevel(mask, /\bTABLE\b/i);
  const capped = atTopLevel(mask, /\b(?:LIMIT|FETCH|HAVING|DISTINCT)\b|\bGROUP\s+BY\b/i);
  // With a plan, its top step says whether rows are really added up:
  // count(*) OVER () looks like an aggregate in the text, but returns every row.
  const aggregated =
    context !== undefined ? context.topNodeType === "Aggregate" : atTopLevel(mask, AGGREGATE_CALL);
  if (!hasWhere && readsTable && !capped && !aggregated) {
    const rows = context === undefined ? null : context.expectedRows;
    let severity: Severity | null = "low";
    if (rows !== null && rows < SMALL_RESULT_ROWS) severity = null;
    else if (rows !== null && rows >= LARGE_TABLE_ROWS) severity = "medium";

    if (severity !== null) {
      let title = "No WHERE clause: every row comes back";
      let size = "";
      if (rows !== null) {
        title = `No WHERE clause: all ${countInWords(rows)} rows come back`;
        size = context?.measured
          ? ` It returned ${fmtRows(rows)} rows when it ran.`
          : ` The planner expects about ${fmtRows(rows)}.`;
      }
      const limited = finishedStatement(sql, "LIMIT 100");
      out.push({
        id: "missing-where",
        stepId: null,
        severity,
        title,
        object: "the whole query",
        detail:
          "With no WHERE clause the server reads and sends back every row, and " +
          "whatever reads the result has to hold all of them. On a big table that " +
          "is slow long before anyone looks past the first screen." +
          size,
        fix:
          "-- Ask only for the rows you need: a WHERE clause goes after the FROM\n" +
          "-- list, before any GROUP BY or ORDER BY. While you look at the data,\n" +
          "-- cap how much comes back:\n" +
          (limited ?? "-- Add LIMIT 100 at the end of the statement."),
        fixKind: "query",
      });
    }
  }

  // Many tables in one query: the planner's search for a join order gets
  // harder, and past two server settings it changes how it searches. It
  // orders the joins of one SELECT at a time, so both counts are of the one
  // that joins the most, never adding in a UNION's other branches or a
  // subquery run on its own. The plan's count sees through views; the
  // text's sees tables the planner removed as unused. The larger of the two
  // is used.
  const tableCount = Math.max(context?.joinedTables ?? 0, mostTablesInOneSelect(mask));
  if (tableCount >= MANY_JOINS) {
    const explicitJoins = inCode(mask, /\bJOIN\b/i);
    out.push(manyJoinsFinding(tableCount, context?.settings ?? null, explicitJoins));
  }

  return sortFindings(out);
}
