// Query analysis, part three: the query text. This file holds the scanners.
//
// Holds the helpers that find keywords, clauses, brackets and tables in the
// masked text of a query.

import { maskNonCode } from "../../sql/guard";

// ── Part three: the query text ───────────────────────────────────────────────

/**
 * Find every place a keyword appears as real code.
 *
 * Scanning happens on the masked copy — comments, string literals and quoted
 * identifiers are blanked there — while the positions it returns are equally
 * valid in the original, because maskNonCode preserves length. That is what
 * lets a rule in read-sql.ts look at what a literal actually CONTAINS (the wildcard
 * rule needs to) without ever mistaking a commented-out line for live SQL.
 */
export function codeMatches(mask: string, pattern: RegExp): CodeMatch[] {
  const flags = pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g";
  const re = new RegExp(pattern.source, flags);
  const out: CodeMatch[] = [];
  let match = re.exec(mask);
  while (match !== null) {
    out.push({ index: match.index, end: match.index + match[0].length });
    // A zero-width match would otherwise spin here forever.
    if (match.index === re.lastIndex) re.lastIndex += 1;
    match = re.exec(mask);
  }
  return out;
}

/** Where a keyword sits, and where it stops — both valid in the original too. */
type CodeMatch = { index: number; end: number };

/** True when the keyword appears anywhere outside a comment or a literal. */
export function inCode(mask: string, pattern: RegExp): boolean {
  return codeMatches(mask, pattern).length > 0;
}

/**
 * How deep in parentheses a position is, counting from the start of the mask.
 *
 * The mask has already blanked string literals and comments, so every bracket
 * left is real syntax.
 */
export function parenDepthAt(mask: string, index: number): number {
  let depth = 0;
  for (let i = 0; i < index && i < mask.length; i += 1) {
    if (mask[i] === "(") depth += 1;
    else if (mask[i] === ")") depth = Math.max(0, depth - 1);
  }
  return depth;
}

/** Where a WHERE clause stops. Anything past one of these is a different clause. */
const CLAUSE_END = /\b(?:GROUP\s+BY|HAVING|WINDOW|ORDER\s+BY|LIMIT|OFFSET|FETCH|UNION|INTERSECT|EXCEPT|RETURNING)\b/i;

/**
 * Where each WHERE clause in the statement starts and stops.
 *
 * A clause runs from the keyword to whichever comes first: the next clause
 * keyword, a semicolon, or the end. Rules that ask "is this condition shaped
 * badly" have to read one clause, not the whole statement. Positions, not
 * text, so a rule can quote the original words back.
 */
export function whereClauses(mask: string): { start: number; end: number }[] {
  return codeMatches(mask, /\bWHERE\b/i).map((m) => {
    const rest = mask.slice(m.end);
    const stop = CLAUSE_END.exec(rest);
    const semi = rest.indexOf(";");
    const length = Math.min(stop ? stop.index : rest.length, semi === -1 ? rest.length : semi);
    return { start: m.end, end: m.end + length };
  });
}

/** Matches outside every bracket: the main statement's own clauses. */
function topLevelMatches(mask: string, pattern: RegExp): CodeMatch[] {
  return codeMatches(mask, pattern).filter((m) => parenDepthAt(mask, m.index) === 0);
}

/** True when the keyword appears outside every bracket. */
export function atTopLevel(mask: string, pattern: RegExp): boolean {
  return topLevelMatches(mask, pattern).length > 0;
}

/**
 * Where the bracket around a position opens: the index just after its "(",
 * or 0 when the position is inside no bracket at all.
 */
function groupStart(mask: string, index: number): number {
  let depth = 0;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (mask[i] === ")") depth += 1;
    else if (mask[i] === "(") {
      if (depth === 0) return i + 1;
      depth -= 1;
    }
  }
  return 0;
}

/**
 * The word written just before the bracket around a position, in capitals:
 * "EXISTS" for the SELECT in `EXISTS (SELECT …)`. Null outside brackets.
 */
export function wordBeforeGroup(mask: string, index: number): string | null {
  const start = groupStart(mask, index);
  if (start === 0) return null;
  const word = /([A-Za-z_]+)\s*$/.exec(mask.slice(0, start - 1));
  return word ? word[1].toUpperCase() : null;
}

/**
 * True when a position sits in the SELECT of a bracketed branch of the main
 * statement: either side of `(SELECT * FROM a) UNION (SELECT * FROM b)`, or a
 * whole statement written in brackets. Such a branch's select list is what
 * comes back, just as if the brackets were not there.
 *
 * A bracket after FROM, IN, EXISTS, AS, JOIN and so on is a subquery instead,
 * and does not count; nor does a branch of a UNION that is itself inside one.
 */
export function inSetOperationBranch(mask: string, index: number): boolean {
  let start = groupStart(mask, index);
  // The bracket right around the position has to open the SELECT itself.
  if (start === 0 || !/^\s*SELECT\b/i.test(mask.slice(start))) return false;
  // Then every bracket out to the top has to stand where a branch can: first
  // in the statement (or in an outer branch), straight after UNION,
  // INTERSECT or EXCEPT (with ALL or DISTINCT), or after a WITH list, as in
  // `WITH x AS (…) (SELECT * FROM x)`.
  while (start > 0) {
    const open = start - 1; // the "(" itself
    const outer = groupStart(mask, open);
    const before = mask.slice(outer, open);
    const first = /^\s*$/.test(before);
    const afterSetOperation = /(?:^|[^\w$])(?:UNION|INTERSECT|EXCEPT)(?:\s+(?:ALL|DISTINCT))?\s*$/i.test(
      before
    );
    const afterWithList = /^\s*WITH\b/i.test(before) && /\)\s*$/.test(before);
    if (!first && !afterSetOperation && !afterWithList) return false;
    start = outer;
  }
  return true;
}

/** Where one FROM list stops: the next clause, tried at one position. */
const FROM_LIST_END =
  /(?:WHERE|GROUP\s+BY|HAVING|WINDOW|ORDER\s+BY|LIMIT|OFFSET|FETCH|UNION|INTERSECT|EXCEPT|FOR)\b/iy;

/** True when the text at `from` opens a subquery: `(SELECT …)` or `LATERAL (…)`. */
function startsSubquery(mask: string, from: number): boolean {
  return /^\s*(?:LATERAL\s*)?\(/i.test(mask.slice(from, from + 200));
}

/**
 * How many items the FROM list starting at `start` names. Subqueries are
 * left out unless `countSubqueries` is set.
 */
function fromItems(mask: string, start: number, countSubqueries = false): number {
  let items = 0;
  let itemStart = start;
  let depth = 0;
  for (let i = start; i < mask.length; i += 1) {
    const ch = mask[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      // A bracket closing the group the FROM list sits in ends the list.
      if (depth === 0) break;
      depth -= 1;
    } else if (depth === 0) {
      if (ch === ";") break;
      if (ch === ",") {
        if (countSubqueries || !startsSubquery(mask, itemStart)) items += 1;
        itemStart = i + 1;
        continue;
      }
      FROM_LIST_END.lastIndex = i;
      if (!/\w/.test(mask[i - 1] ?? "") && FROM_LIST_END.test(mask)) break;
    }
  }
  if (countSubqueries || !startsSubquery(mask, itemStart)) items += 1;
  return items;
}

/**
 * How many tables the text names in its FROM lists and JOINs.
 *
 * A heuristic, used beside the plan's own count: each FROM that belongs to a
 * SELECT adds one per comma-separated item, and each JOIN adds one. An item
 * or JOIN that opens a subquery is not counted, because the subquery's own
 * FROM counts its tables. The FROM in `EXTRACT(YEAR FROM d)` or
 * `IS DISTINCT FROM` is not a table list at all, and is skipped.
 */
export function tablesInText(mask: string): number {
  let count = 0;
  for (const join of codeMatches(mask, /\bJOIN\b/i)) {
    if (!startsSubquery(mask, join.end)) count += 1;
  }
  for (const from of codeMatches(mask, /\bFROM\b/i)) {
    if (/\bDISTINCT\s*$/i.test(mask.slice(Math.max(0, from.index - 40), from.index))) continue;
    // Only a FROM with a SELECT of its own, inside the same brackets.
    const before = mask.slice(groupStart(mask, from.index), from.index);
    const ownSelect = codeMatches(before, /\bSELECT\b/i).some(
      (m) => parenDepthAt(before, m.index) === 0
    );
    if (ownSelect) count += fromItems(mask, from.end);
  }
  return count;
}

/**
 * The most tables one SELECT of the text joins: the items of its FROM list
 * and each JOIN, a subquery there counting as one. Each branch of a UNION,
 * INTERSECT or EXCEPT, and each subquery, is a SELECT of its own, as the
 * planner orders the joins of one at a time.
 *
 * A heuristic, used beside the plan's count. It cannot tell when the planner
 * merges a simple subquery into the query around it, and then counts low;
 * the plan's count sees that.
 */
export function mostTablesInOneSelect(mask: string): number {
  const perSelect = new Map<number, number>();
  const add = (select: number, count: number) =>
    perSelect.set(select, (perSelect.get(select) ?? 0) + count);
  for (const join of codeMatches(mask, /\bJOIN\b/i)) {
    // Brackets with no SELECT of their own hold a join written in brackets,
    // `a JOIN (b JOIN c ON …) ON …`, whose JOINs belong to the SELECT
    // outside. A JOIN with no SELECT anywhere around it (in an UPDATE's
    // FROM, say) still counts, under -1.
    let at = join.index;
    let select = selectAround(mask, at);
    while (select === null && groupStart(mask, at) > 0) {
      at = groupStart(mask, at) - 1;
      select = selectAround(mask, at);
    }
    add(select ?? -1, 1);
  }
  for (const from of codeMatches(mask, /\bFROM\b/i)) {
    if (/\bDISTINCT\s*$/i.test(mask.slice(Math.max(0, from.index - 40), from.index))) continue;
    // Only a FROM with a SELECT of its own, inside the same brackets.
    const select = selectAround(mask, from.index);
    if (select !== null) add(select, fromItems(mask, from.end, true));
  }
  return Math.max(0, ...Array.from(perSelect.values()));
}

/**
 * Where the SELECT that the text at `index` belongs to starts: the last one
 * before it inside the same brackets, and outside any bracket of its own.
 * Null when those brackets hold none, as around `EXTRACT(YEAR FROM d)`.
 */
function selectAround(mask: string, index: number): number | null {
  const start = groupStart(mask, index);
  const before = mask.slice(start, index);
  const selects = codeMatches(before, /\bSELECT\b/i).filter((m) => parenDepthAt(before, m.index) === 0);
  return selects.length === 0 ? null : start + selects[selects.length - 1].index;
}

/**
 * True when the main statement's FROM list joins one thing to another: a
 * JOIN outside every bracket, or a comma between two items of a top-level
 * FROM list. Here a subquery, a function or VALUES counts as an item, since
 * each can repeat the rows it is joined to. The FROM of `IS DISTINCT FROM`
 * is not a FROM list, and is skipped.
 */
export function joinsAtTopLevel(mask: string): boolean {
  if (atTopLevel(mask, /\bJOIN\b/i)) return true;
  return topLevelMatches(mask, /\bFROM\b/i).some(
    (m) =>
      !/\bDISTINCT\s*$/i.test(mask.slice(Math.max(0, m.index - 40), m.index)) &&
      fromItems(mask, m.end, true) > 1
  );
}

/**
 * The statement ready to paste, ending in one semicolon, with `clause`
 * ("LIMIT 100", say) added on a line of its own when one is given.
 *
 * Null when something other than comments follows the first semicolon: that
 * is a second statement, and an added clause would land in the wrong one.
 */
export function finishedStatement(sql: string, clause: string | null = null): string | null {
  const mask = maskNonCode(sql);
  const semi = mask.indexOf(";");
  if (semi !== -1 && mask.slice(semi + 1).trim() !== "") return null;
  const body = (semi === -1 ? sql : sql.slice(0, semi)).trimEnd();
  // Anything added goes on a new line when the last line might end in a
  // `--` comment, which would otherwise swallow it.
  if (clause !== null) return `${body}\n${clause};`;
  return /--[^\n]*$/.test(body) ? `${body}\n;` : `${body};`;
}

/** The statement with the DISTINCT keyword that ends at `end` taken out. */
export function withoutDistinct(sql: string, end: number): string {
  const start = end - "DISTINCT".length;
  return sql.slice(0, start) + sql.slice(end).replace(/^[ \t]+/, "");
}
