/**
 * SQL with the characters that do not show on screen found and marked, for
 * the signed-in phone app. The same rules as the phone link's copy in
 * relay/src/phone/format.ts (a separate package), so keep the two alike.
 */

/**
 * Characters that do not show on screen, or show as something they are not,
 * in SQL someone reads before deciding on it. A carriage return with no line
 * feed straight after it ends a `--` comment for PostgreSQL, while a browser
 * shows it as a space, so `-- adds an index` + CR + `DROP TABLE accounts;`
 * looks like one comment and drops the table. The others are the other
 * control characters, zero-width and invisible ones, the marks that turn text
 * the other way round, the line and paragraph separators and the byte order
 * mark. Tabs, line feeds and CRLF line endings are SQL as people write it.
 */
const HIDDEN = /\r(?!\n)|[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/gu;

/** Whether `text` holds any character that does not show on screen (HIDDEN). */
export function hasHiddenCharacters(text: string): boolean {
  return text.search(HIDDEN) !== -1;
}

/**
 * `text` with each character that does not show on screen (HIDDEN) put in
 * sight: a lone carriage return as ␍ and the line break PostgreSQL reads it
 * as, and any other as its code, as in ⟦U+200B⟧. It is only for showing: a
 * decision still names the SQL exactly as it was kept, by its fingerprint.
 */
export function showHiddenCharacters(text: string): string {
  return text.replace(HIDDEN, (found) =>
    found === "\r" ? "\u{240D}\n" : `\u{27E6}U+${found.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}\u{27E7}`,
  );
}

/** Said where a request's SQL holds such characters, in place of letting it be approved. */
export const HIDDEN_SQL_TEXT =
  "This SQL contains characters that do not show on screen, marked in it as \u{240D} or as a code in \u{27E6} \u{27E7}. "
  + "They can make it run something other than what it seems to, so it cannot be approved here. Reject it and ask for the SQL without them.";
