// Checks the deploy and rollback routes run around a script someone wrote.
//
// Both routes open one transaction, run the script inside it, and only then
// write the ledger row and COMMIT. That is what makes a failed run a non-event:
// the ROLLBACK takes everything back. A script that ends the transaction itself
// (COMMIT, END, ROLLBACK) breaks that promise. Whatever ran before its COMMIT
// is committed on the spot, and the rest runs outside any transaction at all.
//
// lib/sql-guard refuses those words before a script is run. This file is the
// second line, for whatever that reading misses: it asks PostgreSQL which
// transaction the connection is in before and after the script, and a
// different answer means the script ended the route's transaction.
import type { PoolClient } from "pg";

/**
 * Thrown when a script ended the transaction the route opened around it.
 * The routes treat it as "outcome unknown": part of the script may already be
 * committed, so the screen must not say "nothing was applied".
 */
export class ScriptEndedTransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptEndedTransactionError";
  }
}

/**
 * The id of the transaction this connection is in, as text.
 *
 * txid_current() gives the transaction an id if it does not have one yet,
 * which costs nothing here because the script is about to write anyway. It is
 * used rather than pg_current_xact_id() because it also works on PostgreSQL
 * 12 and older. Null only if the driver handed back no row, which a real
 * server never does.
 */
export async function currentTransactionId(client: PoolClient): Promise<string | null> {
  const result = await client.query<{ xid: string }>("SELECT txid_current()::text AS xid");
  return result?.rows?.[0]?.xid ?? null;
}

/**
 * Fix how the server reads strings for the rest of this transaction.
 *
 * lib/sql-guard reads '' strings the standard way, where a backslash is an
 * ordinary character. A server, role or database whose default is
 * standard_conforming_strings = off reads them the old way, and then a script
 * can hide a COMMIT inside what the guard takes for a string. SET LOCAL, so it
 * lasts only as long as the transaction. It is sent on its own, before the
 * script, because PostgreSQL reads a whole multi-statement script before it
 * runs any of it: a SET inside the script cannot change how that same script
 * was read.
 */
export async function readStringsTheStandardWay(client: PoolClient): Promise<void> {
  await client.query("SET LOCAL standard_conforming_strings = on");
}
