// SERVER-ONLY: how big the tables a migration touches are, for the migration
// review. The numbers are the database's own statistics (pg_class), not a
// count: reading them is a catalogue lookup that never scans a table.
//
// The review only uses them to say "this table is big, so this lock is long".
// Anything that goes wrong here leaves the sizes unknown and the review goes on
// without them: a missing size must never be the reason a review fails.

import type { PoolConfig } from "pg";
import { getPoolForConfig } from "../postgres";

/** How long the catalogue read may take, and wait for a lock. */
const SIZE_STATEMENT_TIMEOUT_MS = 3_000;
const SIZE_LOCK_TIMEOUT_MS = 1_000;
/** No run touches more tables than this that the review would list. */
const MAX_TABLES = 200;

export type TableSize = {
  /** The planner's estimate. null when the table has never been analysed and is not empty. */
  rows: number | null;
  /** Table, indexes and TOAST together. */
  bytes: number;
};

export async function readTableSizes(
  cfg: PoolConfig,
  schema: string,
  tables: readonly string[]
): Promise<Map<string, TableSize>> {
  const sizes = new Map<string, TableSize>();
  const names = [...new Set(tables)].slice(0, MAX_TABLES);
  if (names.length === 0) return sizes;

  let client;
  try {
    client = await getPoolForConfig(cfg).connect();
  } catch {
    return sizes;
  }
  // Set when the connection can no longer be trusted, so release() closes it
  // instead of handing it back to the pool Deploy borrows from.
  let broken = false;
  try {
    // SET LOCAL inside a transaction, never a plain SET: this client goes back
    // to a pool that Deploy uses too, and a plain SET would stay on it.
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${SIZE_STATEMENT_TIMEOUT_MS}`);
    await client.query(`SET LOCAL lock_timeout = ${SIZE_LOCK_TIMEOUT_MS}`);
    // reltuples is -1 on a table that was never analysed. With no pages on disk
    // the table is empty; with pages, nobody knows how many rows it holds.
    const result = await client.query<{ relname: string; rows: string | null; bytes: string }>(
      `SELECT c.relname,
              CASE WHEN c.reltuples < 0 AND pg_relation_size(c.oid) > 0 THEN NULL
                   ELSE GREATEST(c.reltuples, 0)::bigint
              END                                 AS rows,
              pg_total_relation_size(c.oid)::bigint AS bytes
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1
          AND c.relname = ANY($2::text[])
          AND c.relkind IN ('r', 'm')`,
      [schema, names]
    );
    await client.query("COMMIT");
    // bigint comes back as a string.
    for (const row of result.rows) {
      sizes.set(row.relname, { rows: row.rows === null ? null : Number(row.rows), bytes: Number(row.bytes) });
    }
  } catch {
    try {
      await client.query("ROLLBACK");
    } catch {
      broken = true;
    }
    sizes.clear();
  } finally {
    client.release(broken);
  }
  return sizes;
}

/** A number to one significant figure: 12,345 is "10,000", 0.0 stays "0". */
function oneFigure(value: number): number {
  if (value <= 0) return 0;
  const step = 10 ** Math.floor(Math.log10(value));
  return Math.round(value / step) * step;
}

/** "about 10,000 rows", "no rows", "an unknown number of rows (never analysed)". */
export function roughRows(rows: number | null): string {
  if (rows === null) return "an unknown number of rows (never analysed)";
  if (rows === 0) return "no rows";
  if (rows < 10) return rows === 1 ? "1 row" : `${rows} rows`;
  return `about ${oneFigure(rows).toLocaleString("en-US")} rows`;
}

const BYTE_UNITS = ["bytes", "kB", "MB", "GB", "TB"];

/** "about 3 MB". */
export function roughBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `about ${oneFigure(value).toLocaleString("en-US")} ${BYTE_UNITS[unit]}`;
}
