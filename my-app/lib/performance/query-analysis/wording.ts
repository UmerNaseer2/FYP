// Query analysis: small wording helpers.
//
// Holds the functions that format a number, a duration, a list of names or a
// block of comment lines the same way everywhere.

/** "1,204" — thousands separators, because plan numbers get long. */
export function fmtRows(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** "1 row" / "2 rows", formatted. */
export function rowsWord(n: number): string {
  return `${fmtRows(n)} row${Math.round(n) === 1 ? "" : "s"}`;
}

/** Round to at most two decimals without printing "12.00". */
export function fmtMs(n: number): string {
  return `${Math.round(n * 100) / 100} ms`;
}

/**
 * The text on one line. A name or condition printed inside a `--` comment
 * must not carry a line break: the rest of it would land outside the comment
 * and run as SQL.
 */
export function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ");
}

/** A plan condition on one comment line, however it was written. */
export function asCommentLine(text: string): string {
  return `--   ${oneLine(text)}`;
}

/** "a", "a and b", "a, b and c". */
export function andList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** "the column status", "the columns status and created_at". */
export function columnsPhrase(columns: string[]): string {
  return columns.length === 1 ? `the column ${columns[0]}` : `the columns ${andList(columns)}`;
}

/** "1.2 million", "48,000": a row count the way a person says it. */
export function countInWords(n: number): string {
  const oneDecimal = (x: number) => String(Math.round(x * 10) / 10);
  if (n >= 1e9) return `${oneDecimal(n / 1e9)} billion`;
  if (n >= 1e6) return `${oneDecimal(n / 1e6)} million`;
  return fmtRows(n);
}

/** A list as `--` comment lines of about 72 characters, broken after commas. */
export function commentLines(items: string[]): string {
  const lines: string[] = [];
  let line = "";
  for (const item of items.map(oneLine)) {
    const next = line === "" ? item : `${line}, ${item}`;
    if (line !== "" && next.length > 68) {
      lines.push(`${line},`);
      line = item;
    } else {
      line = next;
    }
  }
  if (line !== "") lines.push(line);
  return lines.map((l) => `--   ${l}`).join("\n");
}
