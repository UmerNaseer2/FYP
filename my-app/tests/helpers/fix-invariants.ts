import type { FixKind } from "@/lib/perf-sql";

/**
 * The promises every fix on the two performance tabs makes, checked in one
 * place, so the Suggestions tab's rules (lib/perf-advice.ts) and the Analyse
 * tab's (lib/query-analysis.ts) are held to the same ones.
 *
 * A fix is SQL a person pastes into their own server, so what matters is what
 * pasting it would do. Each kind (see FixKind in lib/perf-sql.ts) promises:
 *
 *   change       runs, and every statement changes the structure: CREATE,
 *                ALTER, DROP, or the setval that goes with a new identity.
 *                None builds CONCURRENTLY, which a migration's transaction
 *                refuses.
 *   maintenance  runs, and every statement is ANALYZE, VACUUM or REINDEX, or
 *                the DROP INDEX of a copy that a REINDEX CONCURRENTLY left
 *                behind. A VACUUM stands alone: sent together with anything
 *                else, the statements share a transaction, and VACUUM
 *                refuses one.
 *   query        a rewritten query, finished like the two above, with
 *                nothing in it that changes the structure.
 *   decision     runs nothing: every line is a comment.
 *
 * For the three that run, nothing is left for the reader to fill in: no
 * <placeholder>, no your_table, no "...", no block comment. An undo belongs
 * to a change only, and is held to the same rules, except that it may be all
 * comments (when putting things back needs something the fix removed).
 *
 * Returns a list of problems rather than failing on the first, so one test
 * over every finding shows them all at once.
 */

/** What the checks need from a finding on either tab. */
export type FixItem = {
  id: string;
  fix: string;
  fixKind: FixKind;
  undo?: string;
};

/** A <placeholder> of the kind a person would have to replace by hand. */
const PLACEHOLDER = /<[A-Za-z][\w ,-]*>/;

/** Other signs of SQL that is not finished: a block comment, your_table, an ellipsis. */
const UNFINISHED = [/\/\*/, /\byour_/i, /\.\.\./, /…/];

/** How a structure change starts. */
const CHANGE_START = /^(?:CREATE|ALTER|DROP)\b|^SELECT setval\(/;

/**
 * How maintenance starts. One DROP counts as maintenance too, and only that
 * one: dropping the copy a REINDEX CONCURRENTLY left behind, whose name ends
 * _ccnew or _ccold (with a number after it when there were several). The copy
 * exists only on the server it was left on, so it is tidied by hand, never
 * saved as a migration that would fail on every other database.
 *
 * The DROP must be the whole statement, with both names quoted: a quoted name
 * may hold anything except a lone double quote, which is written "".
 */
const MAINTENANCE_START =
  /^(?:ANALYZE|VACUUM|REINDEX)\b|^DROP INDEX "(?:[^"]|"")+"\."(?:[^"]|"")*_cc(?:new|old)\d*"$/;

/**
 * What a rewritten query must never start with: a change to the structure,
 * a write to the data, or maintenance. The Analyse tab only takes reads, so a
 * rewrite of one is a read too.
 */
const NOT_A_QUERY =
  /^(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE|VACUUM|ANALYZE|REINDEX)\b/i;

/**
 * A line break as PostgreSQL's lexer sees one: a `--` comment ends at a
 * carriage return as well as at a newline, so a lone \r counts too.
 */
const LINE_BREAK = /\r\n?|\n/;

/** The lines that are not `--` comments, blank ones left out. */
function codeLines(sql: string): string[] {
  return sql
    .split(LINE_BREAK)
    .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("--"));
}

/** One statement, and whether a semicolon ended it. */
type Statement = { text: string; ended: boolean };

/**
 * The statements in the code lines, split on the semicolons outside quotes.
 * A name or a string can hold a semicolon ("a;b", 'x;y') without ending
 * anything. A doubled quote inside one closes it and at once opens it again,
 * which comes to the same thing, so it needs no case of its own.
 */
function statements(sql: string): Statement[] {
  const code = codeLines(sql).join("\n");
  const found: Statement[] = [];
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === ";") {
      found.push({ text: code.slice(start, i).trim(), ended: true });
      start = i + 1;
    }
  }
  const rest = code.slice(start).trim();
  if (rest !== "") found.push({ text: rest, ended: false });
  return found;
}

/**
 * Problems with SQL meant to run: anything left to fill in, a statement with
 * no semicolon, a statement that is not what the kind promises, and
 * CONCURRENTLY (which only a statement run by hand may use).
 */
function runnableProblems(label: string, sql: string, start: RegExp, what: string): string[] {
  const problems: string[] = [];
  for (const line of codeLines(sql)) {
    if (PLACEHOLDER.test(line)) problems.push(`${label} has a placeholder: ${line}`);
    if (UNFINISHED.some((sign) => sign.test(line))) {
      problems.push(`${label} is not finished SQL: ${line}`);
    }
  }
  for (const statement of statements(sql)) {
    if (!statement.ended) problems.push(`${label} has a statement with no semicolon: ${statement.text}`);
    if (!start.test(statement.text)) {
      problems.push(`${label} has a statement that is not ${what}: ${statement.text}`);
    }
  }
  return problems;
}

/** Everything wrong with one finding's fix and undo; empty when nothing is. */
export function fixProblems(item: FixItem): string[] {
  const label = `${item.id} (${item.fixKind})`;
  if (item.fix.trim() === "") return [`${label}: the fix is empty`];
  const problems: string[] = [];
  const fixStatements = statements(item.fix);

  switch (item.fixKind) {
    case "change":
      problems.push(...runnableProblems(`${label} fix`, item.fix, CHANGE_START, "a structure change"));
      if (fixStatements.length === 0) problems.push(`${label}: the fix has nothing to run`);
      for (const statement of fixStatements) {
        if (/\bCONCURRENTLY\b/i.test(statement.text)) {
          problems.push(`${label}: a migration cannot run CONCURRENTLY: ${statement.text}`);
        }
      }
      break;
    case "maintenance":
      problems.push(...runnableProblems(`${label} fix`, item.fix, MAINTENANCE_START, "maintenance"));
      if (fixStatements.length === 0) problems.push(`${label}: the fix has nothing to run`);
      if (fixStatements.length > 1 && fixStatements.some((s) => /^VACUUM\b/.test(s.text))) {
        problems.push(`${label}: VACUUM has to be the only statement, or it refuses to run`);
      }
      break;
    case "query":
      // Pasted and run like the change and maintenance kinds, so it has to be
      // finished too; it may start however a query starts.
      for (const line of codeLines(item.fix)) {
        if (PLACEHOLDER.test(line)) problems.push(`${label} fix has a placeholder: ${line}`);
        if (UNFINISHED.some((sign) => sign.test(line))) {
          problems.push(`${label} fix is not finished SQL: ${line}`);
        }
      }
      for (const statement of fixStatements) {
        if (NOT_A_QUERY.test(statement.text)) {
          problems.push(`${label}: a rewritten query changes the server: ${statement.text}`);
        }
      }
      break;
    case "decision":
      for (const line of item.fix.split(LINE_BREAK)) {
        if (line.trim() !== "" && !line.trimStart().startsWith("--")) {
          problems.push(`${label}: a decision runs nothing, but this line would: ${line}`);
        }
      }
      break;
  }

  if (item.undo !== undefined) {
    if (item.fixKind !== "change") problems.push(`${label}: only a change has an undo`);
    if (item.undo.trim() === "") problems.push(`${label}: the undo is empty`);
    problems.push(...runnableProblems(`${label} undo`, item.undo, CHANGE_START, "a structure change"));
    for (const statement of statements(item.undo)) {
      if (/\bCONCURRENTLY\b/i.test(statement.text)) {
        problems.push(`${label}: a migration cannot run CONCURRENTLY: ${statement.text}`);
      }
    }
  }
  return problems;
}

/** Every problem across a list of findings. */
export function allFixProblems(items: FixItem[]): string[] {
  return items.flatMap(fixProblems);
}
