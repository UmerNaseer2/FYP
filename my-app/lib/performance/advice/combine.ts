// Performance advice: tidying the findings of both passes together.
//
// Holds attachForeignKeyIndexes and withoutRepeatedDrops, which the route
// runs after the structure rules and the statistics rules.

import type { PerfAdvice } from "./types";
import { comment } from "./pg-text";

/**
 * Point each whole-table-read finding at an unindexed foreign key on the same
 * table, when there is one.
 *
 * The statistics can say that a table is read in full; only the structure can
 * say a likely reason. An unindexed foreign key is a common one — every join
 * through the key, and every delete from the table it points at, reads the
 * whole table — and its index is the cheapest thing to try, so the finding
 * gets that CREATE INDEX (and its undo) instead of only a pointer to the
 * analyser. The foreign-key finding keeps the same statement; the text says
 * to run it once.
 *
 * Pure: returns new findings and leaves the ones passed in alone.
 */
export function attachForeignKeyIndexes<T extends PerfAdvice>(advice: T[]): T[] {
  const firstForeignKey = new Map<string, T>();
  for (const item of advice) {
    if (item.id !== "foreign-key-not-indexed" || item.table === undefined) continue;
    if (!firstForeignKey.has(item.table)) firstForeignKey.set(item.table, item);
  }
  return advice.map((item) => {
    if (item.id !== "sequential-scan-heavy") return item;
    const foreignKey = firstForeignKey.get(item.object);
    if (!foreignKey) return item;
    const changed: T = {
      ...item,
      fixKind: "change",
      fix:
        comment`-- This table also has a foreign key with no index (${foreignKey.object}). That is\n` +
        `-- a common cause of whole-table reads, and the cheapest thing to try first.\n` +
        `-- It is the same statement as on that suggestion, so run it once.\n` +
        foreignKey.fix,
      undo: foreignKey.undo,
    };
    return changed;
  });
}

/**
 * Leave out an unused-index finding when another finding already drops the
 * same index, or keeps it.
 *
 * Two identical indexes, or one that a wider index covers, are often unused
 * as well, and then the same DROP INDEX would sit on two findings. Saved as
 * two migrations, the second would fail, because the index is already gone.
 * The duplicate-index or redundant-index finding is the one kept: its reason
 * holds whatever the counters say, and it comes with an undo of its own.
 *
 * The index such a finding keeps (its `keeps`) is left alone too: the copy
 * the duplicate-index finding keeps, or the wider index the redundant-index
 * finding leaves in place. Neither is chosen by use (the copy is the first
 * one listed, the wider index is picked by its columns), so the one kept can
 * be the unused one while the one dropped is the one the queries use: run
 * together, the two DROPs would leave those queries no index at all. Once the
 * other is gone the queries move to the one kept, and the next check shows
 * whether they did.
 *
 * Findings are matched on the exact statement. An unused-index fix ends with
 * its DROP INDEX (behind "-- " when it is only a decision); the other findings
 * run theirs as a line of its own. A name with a line break in it matches
 * nothing, so both findings stay, which repeats itself but breaks nothing.
 *
 * Pure: returns a new list and leaves the one passed in alone.
 */
export function withoutRepeatedDrops<T extends PerfAdvice>(advice: T[]): T[] {
  // The DROP INDEX statements no unused-index finding may offer: the ones
  // another change already runs, and the ones that would remove what it keeps.
  const leaveAlone = new Set<string>();
  for (const item of advice) {
    if (item.id === "unused-index" || item.fixKind !== "change") continue;
    for (const line of item.fix.split("\n")) {
      if (line.startsWith("DROP INDEX ")) leaveAlone.add(line);
    }
    if (item.keeps !== undefined) leaveAlone.add(`DROP INDEX ${item.keeps};`);
  }
  return advice.filter((item) => {
    if (item.id !== "unused-index") return true;
    const lastLine = item.fix.split("\n").pop() ?? "";
    const drop = lastLine.startsWith("-- ") ? lastLine.slice(3) : lastLine;
    return !leaveAlone.has(drop);
  });
}
