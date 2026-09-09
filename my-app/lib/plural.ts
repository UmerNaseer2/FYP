// ---------------------------------------------------------------------------
// plural.ts
// Counted nouns for the interface.
//
// A screen that reads "1 tables" or "1 scripts" looks unfinished, and the rule
// was being written out by hand — an inline `=== 1` ternary next to every
// number, easy to forget on the next one. These two helpers keep it in one
// place. English plurals are irregular often enough that guessing from the
// singular is a losing game, so anything that is not a bare +s passes its own
// plural in.
// ---------------------------------------------------------------------------

/**
 * "table" / "tables" — the word only, for callers that print the number
 * themselves or need the two parts apart in JSX.
 */
export function plural(count: number, one: string, many?: string): string {
  return count === 1 ? one : (many ?? `${one}s`);
}

/** "1 table", "4 tables" — the number and the word together. */
export function countOf(count: number, one: string, many?: string): string {
  return `${count} ${plural(count, one, many)}`;
}
