import { createHash } from "node:crypto";
import type { CompareReport } from "./compare-types";

/**
 * A short, stable identifier for WHICH differences a drift check found.
 *
 * The scheduler records a drift event only when the check says something the
 * last recorded one did not. That used to be decided on the status alone —
 * "in_sync", "drifted", "unreachable" — which quietly means a schema that has
 * already drifted can never report anything again. Somebody drops a column on
 * Monday and the event is written; somebody drops a table on Tuesday and the
 * status is still "drifted", so nothing is written, and the audit feed says the
 * last thing that happened to this schema was Monday's column.
 *
 * The counts already stored alongside the event are not enough to tell those
 * apart either. A different column changing inside a table that was already
 * changed leaves `tablesChanged` at 1.
 *
 * So the differences themselves are named, sorted and hashed. Two checks that
 * found the same set of differences produce the same string; a check that found
 * one more, one fewer, or a different one produces a different string, and the
 * event is written.
 *
 * Deliberately NOT a hash of the whole report: the report carries both full
 * snapshots, and the fingerprint has to answer "is this the same drift?", not
 * "is this the same schema?". A table that is identical on both sides is not a
 * difference and must not change the answer.
 */

/**
 * One line per difference, in a fixed shape: what kind, what it is called, what
 * happened to it.
 *
 * "onlyA" means the expected snapshot has it and the live database does not;
 * "onlyB" is the other way round. The words are the comparison engine's own,
 * and keeping them means this file has no second opinion to drift out of step.
 */
export function driftDifferences(report: CompareReport): string[] {
  const lines: string[] = [];

  // A table the live database no longer has, and one it has gained. The
  // comparison is always (expected, live), so A is expected and B is live.
  for (const t of report.tablesOnlyInA) lines.push(`table:${t.name}:onlyA`);
  for (const t of report.tablesOnlyInB) lines.push(`table:${t.name}:onlyB`);

  for (const match of report.matchedTables) {
    if (!match.hasChanges) continue;
    // The pair's own name on each side. They are the same for every matched
    // table that was not renamed, and the renamed case wants both.
    const table = match.left.name === match.right.name
      ? match.left.name
      : `${match.left.name}->${match.right.name}`;

    for (const c of match.columnsOnlyInA) lines.push(`column:${table}.${c.name}:onlyA`);
    for (const c of match.columnsOnlyInB) lines.push(`column:${table}.${c.name}:onlyB`);
    for (const pair of match.columnMatches) {
      // The KINDS of change, not their messages: a message can be reworded in
      // a later release, and every stored fingerprint would then look new.
      for (const change of pair.changes) {
        lines.push(`column:${table}.${pair.left.name}:${change.kind}`);
      }
    }
    for (const c of match.constraintDiffs) {
      // A constraint can be unnamed on the side it is missing from, so fall
      // back to the other side's name and then to the kind.
      const name = c.leftName ?? c.rightName ?? c.kind;
      lines.push(`constraint:${table}.${name}:${c.status}`);
    }
    for (const o of match.objectDiffs) {
      lines.push(`${o.kind}:${o.table ?? table}.${o.name}:${o.status}`);
    }
  }

  // Views, sequences, types, routines, extensions and grants.
  for (const o of report.objectDiffs) lines.push(`${o.kind}:${o.name}:${o.status}`);

  // Sorted so the same set of differences hashes the same however the engine
  // happened to order them — matched tables come back in snapshot order, and
  // that order is not something a drift check should depend on.
  return lines.sort();
}

/**
 * The differences above, as one short string to store and compare.
 *
 * SHA-1 because this is an identity check on data the app produced itself, not
 * a defence against anybody: two checks are the same drift when they hash the
 * same, and nothing is trusted on the strength of it. A hash rather than the
 * text so the column stays one small value whether the schema drifted by one
 * column or by two hundred.
 */
export function driftFingerprint(report: CompareReport): string {
  return createHash("sha1").update(driftDifferences(report).join("\n")).digest("hex");
}
