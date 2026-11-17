// The smallest shared helpers: quoting an identifier, normalising a type name,
// and two lookups by name. Every other file in this folder may import from here.

import { normalizeSimilarityText } from "../../compare/utils";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// Safely double-quote a PostgreSQL identifier, escaping any embedded quotes.
export function q(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

export function normalizeType(t: string): string {
  return normalizeSimilarityText(t);
}

export function findByName<T extends { name: string }>(items: T[] | undefined, name: string): T | null {
  return items?.find((item) => item.name === name) ?? null;
}

/**
 * Does `text` name `name` as a whole identifier?
 *
 * The same kind of text search as expressionCallsRoutine, and wrong in the same
 * safe direction: a string literal holding the word counts as a use, which only
 * ever holds one more drop back.
 */
export function mentionsName(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_$])${escaped}($|[^A-Za-z0-9_$])`, "i").test(text);
}
