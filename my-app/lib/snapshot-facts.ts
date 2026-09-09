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
