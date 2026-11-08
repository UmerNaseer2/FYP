// SERVER-ONLY: tries a generated script, then its rollback, on the target
// database, inside one transaction that is always rolled back.
//
// The route only builds this hook when the caller may run scripts on the
// target and it is labelled Dev or Staging (see app/api/scripts/generate). The
// session is set up the way a deploy sets it up: a lock wait cap, the target
// schema alone on the search path, strings read the standard way. A statement
// time cap is added, so a slow script cannot hold its locks for long. The
// transaction id is read before and after each part: a script that ended the
// transaction itself would otherwise have committed on its own.
//
// What a failure says goes back to the AI to fix the script, so it is cut
// down to structure: the message of a data error (a value that cannot be cast,
// a duplicate key) can quote a row, so for those only the kind of error and
// the names of the column and constraint are kept. The error's detail, which
// is where PostgreSQL puts row values, is never read.

import type { ClientConfig, PoolClient } from "pg";
import { getPoolForConfig } from "../../postgres";
import { currentTransactionId, readStringsTheStandardWay } from "../../script-transaction";
import type { TrialHook, TrialOutcome } from "./sql-generate";

export const TRIAL_LOCK_TIMEOUT_MS = 2_000;
export const TRIAL_STATEMENT_TIMEOUT_MS = 10_000;

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

type PgError = { code?: unknown; message?: unknown; column?: unknown; constraint?: unknown; table?: unknown; hint?: unknown };

/** Codes that say "could not try", not "the script is wrong". */
const NOT_TRIED: Record<string, string> = {
  "55P03": "A table the script touches is locked by someone else right now, so the app could not try it.",
  "57014": `The script took longer than ${TRIAL_STATEMENT_TIMEOUT_MS / 1000} seconds, so the app stopped trying it. It may be slow on this database.`,
  "42501": "The app's database user may not make these changes here, so the script could not be tried.",
  "55P04": "The script adds an enum value and then uses it. That only works when the value is committed first, as a deploy does, so the app could not try it.",
  "25P02": "The database ended the trial transaction early, so the app could not finish trying the script.",
};

/** What a failure says, cut down to structure. */
export function describeTrialError(error: unknown): { notTried: string } | { message: string } {
  const e = (typeof error === "object" && error !== null ? error : {}) as PgError;
  const code = typeof e.code === "string" ? e.code : "";
  if (NOT_TRIED[code]) return { notTried: NOT_TRIED[code] };
  // No SQLSTATE: the connection itself failed. The driver's message can name
  // the host, so it is not passed on.
  if (!/^[0-9A-Z]{5}$/.test(code)) {
    return { notTried: "The app could not reach the database to try the script." };
  }
  const names = [
    typeof e.table === "string" ? `table ${e.table}` : null,
    typeof e.column === "string" ? `column ${e.column}` : null,
    typeof e.constraint === "string" ? `constraint ${e.constraint}` : null,
  ].filter(Boolean);
  const where = names.length > 0 ? ` (${names.join(", ")})` : "";
  // Class 22 (data exception) and 23 (integrity) messages can quote a value.
  if (code.startsWith("22")) return { message: `A value already in the table does not fit the change, SQLSTATE ${code}${where}.` };
  if (code.startsWith("23")) {
    return { message: `Rows already in the table break the change, SQLSTATE ${code}${where}. Say what to do with them, or add a DEFAULT.` };
  }
  const message = typeof e.message === "string" ? e.message : "The database refused it.";
  const hint = typeof e.hint === "string" && e.hint ? ` Hint: ${e.hint}` : "";
  return { message: `${message} (SQLSTATE ${code}).${hint}` };
}

/**
 * The hook for one target. `connect` is there for the tests; the route leaves
 * it out and gets a client of the target's own pool.
 */
export function makeTrial(
  cfg: ClientConfig,
  schemaName: string,
  connect: () => Promise<PoolClient> = () => getPoolForConfig(cfg).connect()
): TrialHook {
  return async (sql, rollbackSql): Promise<TrialOutcome> => {
    let client: PoolClient;
    try {
      client = await connect();
    } catch {
      return { status: "not-tried", reason: "The app could not reach the database to try the script." };
    }
    let step: "setup" | "script" | "rollback" = "setup";
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL lock_timeout = ${TRIAL_LOCK_TIMEOUT_MS}`);
      await client.query(`SET LOCAL statement_timeout = ${TRIAL_STATEMENT_TIMEOUT_MS}`);
      await client.query(`SET LOCAL search_path TO ${quoteIdent(schemaName)}`);
      await readStringsTheStandardWay(client);
      const exists = await client.query("SELECT 1 FROM information_schema.schemata WHERE schema_name = $1", [schemaName]);
      if (exists.rows.length === 0) {
        return { status: "not-tried", reason: `The schema ${schemaName} is not on this database any more.` };
      }
      const txid = await currentTransactionId(client);

      step = "script";
      await client.query(sql);
      if ((await currentTransactionId(client)) !== txid) {
        return { status: "failed", step, message: "The script ended the transaction itself. Leave out COMMIT, END and ROLLBACK." };
      }
      if (rollbackSql) {
        step = "rollback";
        await client.query(rollbackSql);
        if ((await currentTransactionId(client)) !== txid) {
          return { status: "failed", step, message: "The rollback ended the transaction itself. Leave out COMMIT, END and ROLLBACK." };
        }
      }
      return { status: "passed" };
    } catch (error) {
      const read = describeTrialError(error);
      if ("notTried" in read) return { status: "not-tried", reason: read.notTried };
      if (step === "setup") return { status: "not-tried", reason: "The app could not set up the trial on this database." };
      return { status: "failed", step, message: read.message };
    } finally {
      // Always rolled back, whatever happened. release(true) closes the
      // connection rather than handing a used session back to the pool.
      try {
        await client.query("ROLLBACK");
      } catch {
        // The connection may already be gone. Closing it below is enough.
      }
      client.release(true);
    }
  };
}
