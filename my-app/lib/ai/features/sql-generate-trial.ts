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
// When there is a rollback, the schema's structure is read before the script
// and again after the rollback: the tables, views, indexes, sequences and
// constraints by name, and each column with its type. Something that was there
// before and is gone after, or a column whose type is not what it was, fails
// the rollback. A script that does nothing (ADD COLUMN IF NOT EXISTS on a
// column already there) with a rollback that drops that column would otherwise
// pass the try, and running the rollback would delete a column the script
// never added, with its data.
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

/** Each object in the schema by name, with a column's type as its shape. */
export const STRUCTURE_SQL = `
SELECT CASE WHEN c.relkind IN ('v', 'm') THEN 'view'
            WHEN c.relkind IN ('i', 'I') THEN 'index'
            WHEN c.relkind = 'S' THEN 'sequence'
            ELSE 'table' END || ' ' || c.relname AS item,
       NULL::text AS shape
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'i', 'I', 'S')
UNION ALL
SELECT 'column ' || c.relname || '.' || a.attname,
       pg_catalog.format_type(a.atttypid, a.atttypmod)
  FROM pg_catalog.pg_attribute a
  JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND a.attnum > 0 AND NOT a.attisdropped
UNION ALL
SELECT 'constraint ' || c.relname || '.' || k.conname, NULL::text
  FROM pg_catalog.pg_constraint k
  JOIN pg_catalog.pg_class c ON c.oid = k.conrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = $1`;

type Structure = Map<string, string | null>;

async function readStructure(client: PoolClient, schemaName: string): Promise<Structure> {
  const result = await client.query<{ item: string; shape: string | null }>(STRUCTURE_SQL, [schemaName]);
  return new Map(result.rows.map((row) => [row.item, row.shape]));
}

const MAX_NAMED = 8;

function nameSome(items: string[]): string {
  const shown = items.slice(0, MAX_NAMED).join(", ");
  return items.length > MAX_NAMED ? `${shown} and ${items.length - MAX_NAMED} more` : shown;
}

/**
 * What a rollback did not put back, in words for the AI, or null when the
 * structure after is the structure before (new things are fine: only what was
 * there before is checked). A gone table is named once, not with its columns.
 */
export function notPutBack(before: Structure, after: Structure): string | null {
  const gone = [...before.keys()].filter((item) => !after.has(item));
  const goneTables = new Set(gone.filter((item) => item.startsWith("table ")).map((item) => item.slice("table ".length)));
  const shown = gone.filter((item) => {
    const m = /^(?:column|constraint) ([^.]+)\./.exec(item);
    return !(m && goneTables.has(m[1]));
  });
  const changed = [...before.entries()]
    .filter(([item, shape]) => shape !== null && after.has(item) && after.get(item) !== shape)
    .map(([item, shape]) => `${item} was ${shape}, is ${after.get(item)}`);
  if (shown.length === 0 && changed.length === 0) return null;
  const parts: string[] = [];
  if (shown.length > 0) parts.push(`things that were there before the script are gone: ${nameSome(shown)}.`);
  if (changed.length > 0) parts.push(`columns that were there before the script have another type: ${nameSome(changed)}.`);
  return (
    `After the script and then the rollback, ${parts.join(" And ")} ` +
    "A rollback must put back exactly what was there before the script, and never remove or change anything the script did not add or change."
  );
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
      const before = rollbackSql ? await readStructure(client, schemaName) : null;
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
        if (before) {
          let after: Structure;
          try {
            after = await readStructure(client, schemaName);
          } catch {
            return { status: "not-tried", reason: "The app could not read the schema back after the rollback." };
          }
          const missing = notPutBack(before, after);
          if (missing) return { status: "failed", step, message: missing };
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
