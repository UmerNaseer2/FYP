/**
 * Plain questions about a captured snapshot — no database, no `pg`.
 *
 * These live apart from lib/postgres.ts because the screens ask them too. The
 * moment a UI component imports a value from lib/postgres, the whole node-only
 * PostgreSQL client is dragged into the browser bundle and the build fails on
 * `Can't resolve 'dns'`. Types are safe there (an `import type` is erased);
 * functions are not, so the ones the UI needs live here.
 */

import type { TypeSnapshot } from "./postgres";

/**
 * Whether a range type can be written out as a real CREATE TYPE statement.
 *
 * Read by the compare engine, so the report can say "has to be created by
 * hand", and by the migration generator, so it knows what to write. One
 * function rather than the same test in both places: the sentence on screen
 * and the SQL underneath cannot disagree if they ask the same question.
 *
 * A snapshot captured before range types were recorded in this detail has no
 * rangeDetails at all, and the answer for it is the same one: not from here.
 */
export function rangeTypeIsCreatable(type: TypeSnapshot): boolean {
  if (type.kind !== "RANGE") return false;
  if (type.rangeDetails === undefined) return false;
  return !type.rangeDetails.needsManualCreate;
}

/**
 * The names in a dotted SQL name:
 *
 *   shop.orders      →  ["shop", "orders"]
 *   "Order Lines"    →  ["Order Lines"]
 *   "a""b".c         →  ['a"b', "c"]
 *
 * A quoted part keeps its exact spelling, with "" read as one quote. An
 * unquoted part is taken as written: PostgreSQL only prints a name without
 * quotes when it is already lower case. Null for anything else — a space, a
 * bracket, an unfinished quote — which is how `name DESC` or `lower(email)` is
 * told apart from a plain column.
 */
export function identifierParts(text: string): string[] | null {
  const parts: string[] = [];
  let i = 0;
  for (;;) {
    let part = "";
    if (text[i] === '"') {
      i += 1;
      for (;;) {
        if (i >= text.length) return null; // the quote never closes
        if (text[i] === '"') {
          if (text[i + 1] !== '"') break; // the closing quote
          i += 1; // "" stands for one quote inside the name
        }
        part += text[i];
        i += 1;
      }
      i += 1; // past the closing quote
    } else {
      while (i < text.length && /[^\s".(),]/.test(text[i])) {
        part += text[i];
        i += 1;
      }
    }
    if (part === "") return null;
    parts.push(part);
    if (i === text.length) return parts;
    if (text[i] !== ".") return null;
    i += 1;
  }
}

/**
 * The table that owns a sequence, by the bare name the snapshot's tables use.
 *
 * `ownedByTable` is the owner as PostgreSQL's regclass prints it, with the
 * snapshot's own schema taken off: `orders` for a plain name, but `"AuditLog"`
 * with its quotes for a name that needs them (capital letters, a space, or a
 * reserved word such as `"order"`). The tables carry bare names, so comparing
 * the two strings straight missed every quoted owner. A migration for a new
 * table like that then wrote `DEFAULT nextval(...)` with no sequence behind it,
 * and failed on "relation does not exist".
 *
 * `schema` covers an older stored snapshot that kept the qualifier
 * (`public."AuditLog"`). Null when no table owns the sequence, or when the
 * owner sits in another schema, since no table in this snapshot can be it.
 */
export function sequenceOwnerTable(
  sequence: { ownedByTable: string | null },
  schema?: string
): string | null {
  if (sequence.ownedByTable === null) return null;
  const parts = identifierParts(sequence.ownedByTable);
  if (parts === null) return null;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2 && schema !== undefined && parts[0] === schema) return parts[1];
  return null;
}
