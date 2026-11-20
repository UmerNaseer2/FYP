// The shape of the object phases (statements bucketed by when they must run)
// and the small lookups objectPhases needs.

import type { CompareReport } from "../../compare/types";
import type { PrivilegeSnapshot } from "../../postgres";
import { serialSides } from "../../compare/diff";
import { nextvalSequenceName } from "./sequences";
import type { SqlStatement } from "./types";

// ---------------------------------------------------------------------------
// Turning object differences into ordered phases
// ---------------------------------------------------------------------------

/**
 * Object statements bucketed by when they have to run.
 *
 * Ordering is not cosmetic here. A type has to exist before a column uses it, a
 * function before the trigger that calls it, a column before the index over it,
 * and every table before a view that selects from them.
 */
export type ObjectPhases = {
  /**
   * Extensions — before everything, including the collations below.
   *
   * An extension installs types, operators, functions and sometimes collations
   * of its own, and the snapshot deliberately records none of them (they are
   * installed, not authored). So the extension is the only thing that puts them
   * there, and nothing that might name one can be written until it exists.
   */
  extensions: SqlStatement[];
  /**
   * Collations — before everything else, including the types below.
   *
   * A column, a domain and an index can all name a collation, so nothing that
   * might name one can be written until it exists.
   */
  collations: SqlStatement[];
  /**
   * Types and standalone sequences — before CREATE TABLE.
   *
   * Also the `-- MANUAL:` notes for work the generator cannot express, so the
   * reader meets them before the statements that assume the work was done.
   */
  beforeTables: SqlStatement[];
  /**
   * The few functions that have to exist BEFORE the tables, not after.
   *
   * `routines` below runs after CREATE TABLE on purpose, so a function whose
   * body reads a new table finds it. That order breaks down for the opposite
   * dependency: a new table with `id text DEFAULT gen_ulid()` or a CHECK that
   * calls a new function is refused outright with "function does not exist",
   * because PostgreSQL resolves both at CREATE TABLE time. Triggers never hit
   * this — they are created later still.
   *
   * Only the functions a new table actually names are moved here; everything
   * else stays in `routines` where the body-reads-a-table order protects it.
   * See routinesNeededByNewTables.
   */
  hoistedRoutines: SqlStatement[];
  /** Functions and procedures — after tables exist, before triggers need them. */
  routines: SqlStatement[];
  /** Indexes — after every ADD COLUMN has run. */
  indexes: SqlStatement[];
  /**
   * Index drops that cannot wait for `indexes`: the index's name is one a new
   * key constraint in this script takes. Emitted before any table is created
   * or altered. See keyNamesTheScriptAdds.
   */
  indexDropsFirst: SqlStatement[];
  /** Triggers — after their functions and after the columns they read. */
  triggers: SqlStatement[];
  /**
   * Policies and the row-security switches — last of the table-scoped work.
   *
   * A policy expression reads the table's own columns and can call a function,
   * so it needs every ADD COLUMN and every CREATE FUNCTION above it to have
   * run. Nothing else depends on a policy, so nothing has to come after.
   */
  policies: SqlStatement[];
  /** Views — after foreign keys, so every table is complete. */
  views: SqlStatement[];
  /**
   * Indexes and triggers that hang off a VIEW — after the views above.
   *
   * They cannot ride in `indexes` and `triggers`, which run long before any
   * view exists: a CREATE INDEX on a materialized view the script has not
   * built yet fails on a relation that is not there. So they get a bucket of
   * their own, emitted immediately after the view they belong to is created.
   */
  afterViews: SqlStatement[];
  /** View drops — before DROP TABLE, so CASCADE has less to reach. */
  viewDrops: SqlStatement[];
  /**
   * Trigger and policy drops that have to run before the ALTER TABLE
   * statements: PostgreSQL refuses to change the type of a column that a
   * trigger or a policy on the table names. The matching creates stay in
   * `triggers` and `policies`, which run after the alters.
   */
  beforeAlters: SqlStatement[];
  /**
   * Routine drops — after the tables, before the type drops below.
   *
   * Their own bucket rather than the back of afterTables: object diffs arrive
   * sorted alphabetically by kind, so "ENUM" came before "FUNCTION" and a
   * rollback that removed an enum and a function taking that enum emitted the
   * DROP TYPE first. DROP TYPE carries no CASCADE on purpose, so it failed and
   * took the whole transaction with it.
   */
  routineDrops: SqlStatement[];
  /** Type and sequence drops — after the tables and routines that used them. */
  afterTables: SqlStatement[];
  /**
   * Collation drops — the very last thing.
   *
   * DROP COLLATION carries no CASCADE here and fails while any column, domain
   * or index still uses it, so it has to come after every one of those has
   * gone: after the table drops, and after the type drops above.
   */
  collationDrops: SqlStatement[];
  /**
   * Extension drops — after even the collation drops.
   *
   * DROP EXTENSION carries no CASCADE here, and an extension holds everything
   * it installed: a column on one of its types, an index on one of its
   * operator classes, a collation it shipped. All of those have to be gone
   * first, and the collation drops above are the last of them.
   */
  extensionDrops: SqlStatement[];
  /**
   * Ownership and grants — after everything the script creates, and before
   * anything it drops.
   *
   * After the creations because there is nothing to grant on until the object
   * is there; before the drops because a REVOKE on an object that has just been
   * dropped fails, and because leaving them to the very end would put a GRANT
   * after a DROP TYPE that a safe-mode run has commented out.
   */
  privileges: SqlStatement[];
  /**
   * Tables whose ALTER COLUMN ... TYPE cannot run while safe mode holds a
   * materialized view's drop back, keyed by the table's name in the SOURCE and
   * listing the views in the way.
   *
   * The generator marks those ALTERs `needsArmedDrop` so the renderer comments
   * them out with the drop rather than leaving them to fail mid-transaction.
   */
  retypeBlockedBy: Map<string, string[]>;
  warnings: string[];
};

/**
 * Find a privilege entry by the display name the compare engine gave it —
 * "table orders", "function f(integer)".
 *
 * Rebuilt here rather than carried on the diff because ObjectDiff has one name
 * field and every other kind puts its own name in it. Both sides must spell it
 * the same way; the compare engine's privilegeObjects is the other half.
 */
export function findPrivilege(
  items: PrivilegeSnapshot[] | undefined,
  name: string
): PrivilegeSnapshot | null {
  // The schema entry goes by its kind alone, the way the compare engine keys it
  // (privilegeObjects in lib/compare/diff.ts): each snapshot has one, and it is
  // the schema being compared, whatever each side is called. Looking it up by
  // the source's name found nothing in a target with another name, so copying
  // shop_v2 into shop_v1 lost the target's owner and grants: no previous owner
  // in the description, and no REVOKE for a schema grant the source lacks, in
  // the script or in its rollback.
  if (name.startsWith("schema ")) {
    return items?.find((item) => item.objectKind === "SCHEMA") ?? null;
  }
  return (
    items?.find((item) => {
      const args =
        item.identityArguments === undefined ? "" : `(${item.identityArguments})`;
      return `${item.objectKind.toLowerCase()} ${item.objectName}${args}` === name;
    }) ?? null
  );
}

/**
 * Build every object statement the migration needs, in dependency order.
 *
 * Reads the object differences the comparator produced, plus the objects that
 * hang off tables being created outright — a brand-new table has no match, so
 * its indexes and triggers appear in no diff and would otherwise be dropped on
 * the floor exactly the way its foreign keys once were.
 */
/**
 * The sequences the table step ties to a column with ALTER SEQUENCE … OWNED BY.
 *
 * That happens where the source column is a serial and the target column is
 * not. When the target already has a standalone sequence under the same name,
 * the script keeps it and hands it to the column. The compare lists that
 * sequence as "only in target" (it skips the source's, which is owned), and
 * dropping it would stop the script: the column's default reads it.
 */
export function sequencesTiedToColumns(report: CompareReport): Set<string> {
  const tied = new Set<string>();
  for (const match of report.matchedTables) {
    for (const col of match.columnMatches) {
      if (col.left.identity || col.right.identity) continue;
      const serial = serialSides(col.left, col.right);
      if (!serial.left || serial.right) continue;
      const name = nextvalSequenceName(col.left.columnDefault);
      if (name !== null) tied.add(name);
    }
  }
  return tied;
}
