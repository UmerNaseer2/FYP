// Index statements: CREATE INDEX, DROP INDEX, and putting drops ahead of creates.

import type { CompareReport } from "../../compare/types";
import type { IndexSnapshot } from "../../postgres";
import { q } from "./basics";
import { nonFkConstraints } from "./column-changes";
import { objectStatement, onlyIfMissing, onlyIfPresent, tableIndexQuery } from "./statement-helpers";
import type { SqlStatement } from "./types";

// ── Indexes ────────────────────────────────────────────────────────────────

// pg_get_indexdef returns a complete CREATE INDEX with the schema qualifier
// already stripped at snapshot time, so it replays under search_path as-is.
//
// It is wrapped in onlyIfMissing rather than given a plain IF NOT EXISTS. Both
// let a re-run skip an index that is already there, but they ask different
// questions. Index names are unique across the whole schema, not per table, so
// "does this name exist anywhere" and "does this exact index already exist on
// THIS table" are not the same check. IF NOT EXISTS asks the first: a name that
// has moved to another table, or already belongs to an unrelated one, reads as
// "already there" and the create is silently skipped — and with the matching
// DROP still to come, the index can end up on neither table. The onlyIfMissing
// lookup asks the second, so it skips only a genuine re-run and lets a real name
// clash fail loudly instead of vanishing. Drops are also drained before creates
// (see dropIndexesFirst, where objects.indexes is emitted) so the common
// moved-name case clears the old name first and never has to fail at all.
function indexCreateSql(index: IndexSnapshot, tableName: string): string {
  const definition = index.definition.trim();
  return onlyIfMissing(tableIndexQuery(tableName, index.name), `${definition};`);
}

/**
 * @param afterHeldBackDrop set for an index on a view whose drop safe mode
 * comments out. The old view is then still sitting there with this index
 * already on it, and a plain CREATE INDEX fails on the duplicate name — inside
 * the one transaction the apply route uses, which takes the whole migration
 * down with it. Held back beside the view instead.
 */
export function createIndexStatement(
  index: IndexSnapshot,
  tableName: string,
  afterHeldBackDrop = false
): SqlStatement {
  return objectStatement({
    sql: indexCreateSql(index, tableName),
    needsArmedDrop: afterHeldBackDrop,
    // A unique index is built against the rows already in the table and refused
    // if two of them collide, so it can abort the migration on real data — the
    // same reason every ADD CONSTRAINT is breaking. A plain index cannot fail
    // that way, so it stays informational.
    description: index.isUnique
      ? `Create unique index "${index.name}" on "${tableName}" — WARNING: fails if any two rows already collide`
      : `Create index "${index.name}" on "${tableName}"`,
    kind: "CREATE_INDEX",
    severity: index.isUnique ? "breaking" : "info",
    tableName,
  });
}

/**
 * The names of the PRIMARY KEY, UNIQUE and EXCLUDE constraints this script
 * adds, on changed tables and on new ones.
 *
 * PostgreSQL backs each of them with an index of the same name, and an index
 * name is used once per schema. So when the target has a plain index called
 * "users_email_key" and the source has a UNIQUE constraint of that name, the
 * ADD CONSTRAINT fails with "relation already exists" unless the plain index
 * is dropped first. Index drops normally come after the table changes, so the
 * ones in this set are moved to the front.
 */
export function keyNamesTheScriptAdds(report: CompareReport): Set<string> {
  const names = new Set<string>();
  for (const match of report.matchedTables) {
    for (const diff of match.constraintDiffs) {
      if (diff.status === "onlyB" || !diff.leftName) continue;
      if (diff.kind === "FOREIGN KEY" || diff.kind === "CHECK") continue;
      names.add(diff.leftName);
    }
  }
  for (const table of report.tablesOnlyInA) {
    for (const { kind, constraint } of nonFkConstraints(table)) {
      if (kind !== "CHECK") names.add(constraint.name);
    }
  }
  return names;
}

export function dropIndexStatement(index: IndexSnapshot, tableName: string): SqlStatement {
  return objectStatement({
    sql: `DROP INDEX IF EXISTS ${q(index.name)};`,
    // A unique index is the only kind whose removal changes what the data is
    // allowed to be, rather than only how fast it is read.
    description: index.isUnique
      ? `Drop unique index "${index.name}" from "${tableName}" — WARNING: stops enforcing uniqueness`
      : `Drop index "${index.name}" from "${tableName}"`,
    kind: "DROP_INDEX",
    severity: index.isUnique ? "breaking" : "safe",
    tableName,
  });
}

/**
 * The same drop for an index whose name a new key takes (see
 * keyNamesTheScriptAdds). On a second run of the same script that name already
 * belongs to the new key's own index, and a plain DROP INDEX IF EXISTS would
 * hit that one and be refused. So this drops an index of that name only while
 * it sits on this table and backs no key.
 */
export function dropIndexMakingRoomStatement(index: IndexSnapshot, tableName: string): SqlStatement {
  return {
    ...dropIndexStatement(index, tableName),
    sql: onlyIfPresent(
      `${tableIndexQuery(tableName, index.name)} AND NOT EXISTS ` +
        `(SELECT 1 FROM pg_constraint con WHERE con.conindid = i.indexrelid AND con.contype IN ('p', 'u', 'x'))`,
      `DROP INDEX ${q(index.name)};`
    ),
  };
}

/**
 * Reorder one phase so every index DROP comes before every other statement in
 * it, keeping the order within each group.
 *
 * Index names are unique per schema, not per table, so an index that moves from
 * one table to another appears as a DROP on the old table and a CREATE on the
 * new one. Emitted in table order those two can land create-first, and the
 * create then collides with the name still in place. Draining the drops first
 * frees the name before any create needs it. Only DROP_INDEX moves: a
 * DROP_TRIGGER can be half of a replace pair that must stay next to its CREATE
 * (see createTriggerStatements), and an index drop is never paired that way.
 */
export function dropIndexesFirst(statements: SqlStatement[]): SqlStatement[] {
  const drops = statements.filter((s) => s.kind === "DROP_INDEX");
  const rest = statements.filter((s) => s.kind !== "DROP_INDEX");
  return [...drops, ...rest];
}
