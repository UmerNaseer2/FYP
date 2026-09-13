/**
 * Advisory locks for script families, in one place so every route that
 * changes a family's rows in script_patch takes them the same way.
 *
 * Who takes them: the apply route (deploy) and the revert route (rollback).
 * Any later route that writes script_patch for a family, such as a Version
 * Sync replay, should call lockScriptFamilies too, or it can interleave with
 * a deploy or rollback of the same family.
 *
 * Why a lock per family, on top of the per-version lock the apply route has
 * always taken: a per-version lock only stops two runs of the SAME version
 * racing. A rollback of v3 and a deploy of v4 name different versions, so
 * per-version locks let them run side by side, and both change which version
 * of the family is current. The one that finishes second would be working
 * from a ledger that is already out of date. With every such run taking the
 * family lock first, they queue behind each other instead.
 *
 * The order rule, for every route: family locks first, sorted by name, then
 * the per-version locks. Two runs that take the same two locks in opposite
 * orders deadlock (each holds one and waits for the other), and one agreed
 * order makes that impossible.
 *
 * The locks are transaction-scoped (pg_advisory_xact_lock), so COMMIT or
 * ROLLBACK releases them and no error path can forget an unlock. Call these
 * inside BEGIN and after `SET LOCAL lock_timeout`, so a run stuck behind
 * another ends with SQLSTATE 55P03 (a readable "try again") instead of a hang.
 *
 * The key is two hashtext() values: the schema, then the family or version
 * text. Two different keys can hash alike; that only makes two unrelated runs
 * wait for each other, it never lets two related runs through together.
 */
import type { PoolClient } from "pg";

/** The one client method these helpers use: a real PoolClient, or a test fake. */
type Queryable = Pick<PoolClient, "query">;

const ADVISORY_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))";

/**
 * The second half of a family's lock key. The "family:" prefix keeps it apart
 * from the per-version keys, which are "<name>|<version>".
 */
export function familyLockKey(scriptName: string): string {
  return `family:${scriptName}`;
}

/**
 * The second half of one version's lock key. This is the spelling the apply
 * route has always used, so a rollback and a deploy of the same version wait
 * for each other even while an older build of the app is still serving.
 */
export function versionLockKey(scriptName: string, version: string): string {
  return `${scriptName}|${version}`;
}

/** The families to lock, each once, in the one order every route uses (sorted by name). */
export function familiesInLockOrder(scriptNames: Iterable<string>): string[] {
  return [...new Set(scriptNames)].sort();
}

/**
 * Take the family lock of every family in a run, sorted, inside the caller's
 * transaction. Returns the families in the order they were locked.
 *
 * Call it once, before any per-version lock. It blocks until every family is
 * free, or throws 55P03 when `lock_timeout` runs out first.
 */
export async function lockScriptFamilies(
  client: Queryable,
  schemaName: string,
  scriptNames: Iterable<string>
): Promise<string[]> {
  const order = familiesInLockOrder(scriptNames);
  for (const name of order) {
    await client.query(ADVISORY_LOCK_SQL, [schemaName, familyLockKey(name)]);
  }
  return order;
}

/**
 * Take the lock for one (schema, script, version). Call it only after
 * lockScriptFamilies has locked that script's family.
 */
export async function lockScriptVersion(
  client: Queryable,
  schemaName: string,
  scriptName: string,
  version: string
): Promise<void> {
  await client.query(ADVISORY_LOCK_SQL, [schemaName, versionLockKey(scriptName, version)]);
}
